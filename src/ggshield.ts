import * as tl from "azure-pipelines-task-lib/task";
import * as toolLib from "azure-pipelines-tool-lib/tool";
import { verify as sigstoreVerify } from "sigstore";
import { spawnSync, SpawnSyncOptions } from "child_process";
import * as crypto from "crypto";
import * as path from "path";
import * as fs from "fs";

import type {
  Attestation,
  AttestationResponse,
  AttestationStatement,
  BinaryTarget,
  ProcessReport,
} from "./types";
import { GGSHIELD_ARGS } from "./constants";

// The bundled ggshield version declared in the project root's `ggshield_version`
// This is auto-filled at compile time
declare const __GGSHIELD_VERSION__: string;

function ggshieldVersion(): string {
  return __GGSHIELD_VERSION__;
}

/**
 * Map Node's process.platform/process.arch to a published ggshield release
 * archive.
 */
function binaryTargetFor(platform: string, arch: string): BinaryTarget | null {
  if (platform === "win32" && arch === "x64") {
    return { triple: "x86_64-pc-windows-msvc", ext: "zip" };
  }
  if (platform === "darwin" && arch === "arm64") {
    return { triple: "arm64-apple-darwin", ext: "tar.gz" };
  }
  if (platform === "darwin" && arch === "x64") {
    return { triple: "x86_64-apple-darwin", ext: "tar.gz" };
  }
  if (platform === "linux" && arch === "x64" && !isMuslLinux()) {
    return { triple: "x86_64-unknown-linux-gnu", ext: "tar.gz" };
  }
  return null;
}

/**
 * Best-effort musl (Alpine) detection.
 */
function isMuslLinux(): boolean {
  try {
    const report: ProcessReport = process.report?.getReport();
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

/**
 * Verify the GitHub Artifact Attestation of a downloaded ggshield release
 * archive.
 */
async function verifyAttestation(
  archivePath: string,
  version: string,
): Promise<void> {
  const sha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(archivePath))
    .digest("hex");

  const res = await fetch(
    `https://api.github.com/repos/GitGuardian/ggshield/attestations/sha256:${sha256}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "ggshield-ado-extension",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`attestation fetch failed: HTTP ${res.status}`);
  }
  const attestations: Attestation[] =
    ((await res.json()) as AttestationResponse)?.attestations ?? [];
  if (attestations.length === 0) {
    throw new Error("no attestation found for the artifact digest");
  }
  const identityURI =
    `https://github.com/GitGuardian/ggshield/.github/workflows/tag.yml` +
    `@refs/tags/v${version}`;

  const failures: string[] = [];
  for (const att of attestations) {
    try {
      await sigstoreVerify(att.bundle, {
        certificateIssuer: "https://token.actions.githubusercontent.com",
        certificateIdentityURI: identityURI,
      });
      if (att.bundle.dsseEnvelope === undefined) {
        throw Error(
          "Attestation signature verification failed: incomplete DSSE envelope.",
        );
      }
      const stmt: AttestationStatement = JSON.parse(
        Buffer.from(att.bundle.dsseEnvelope.payload, "base64").toString("utf8"),
      );
      const subjects = stmt?.subject ?? [];
      if (!subjects.some((s) => s.digest?.sha256 === sha256)) {
        throw new Error(
          "attestation subject digest does not match the archive",
        );
      }
      console.log(
        "ggshield provenance verified (GitHub artifact attestation, " +
          `built by ${identityURI}).`,
      );
      return;
    } catch (err) {
      failures.push(String(err));
    }
  }
  throw new Error(`attestation verification failed: ${failures.join("; ")}`);
}

/**
 * Download (once, then agent-cached) the pinned standalone ggshield binary
 * for this OS/arch and return an absolute path to the executable. Returns
 * null when there is no prebuilt binary for the platform, when the download
 * fails (e.g. no route to github.com), or when the downloaded binary fails
 * to run.
 */
async function resolveBinaryGgshield(): Promise<string | null> {
  const target = binaryTargetFor(process.platform, process.arch);
  if (!target) {
    return null;
  }

  let toolRoot: string;
  const exeName = process.platform === "win32" ? "ggshield.exe" : "ggshield";
  try {
    const version = ggshieldVersion();
    const stem = `ggshield-${version}-${target.triple}`;

    toolRoot = toolLib.findLocalTool("ggshield", version);
    if (!toolRoot) {
      const url =
        `https://github.com/GitGuardian/ggshield/releases/download/` +
        `v${version}/${stem}.${target.ext}`;
      console.log(`Downloading ggshield ${version} (${target.triple})...`);
      const archive = await toolLib.downloadTool(url);
      await verifyAttestation(archive, version);
      const extracted =
        target.ext === "zip"
          ? await toolLib.extractZip(archive)
          : await toolLib.extractTar(archive);
      const payload = path.join(extracted, stem);
      toolRoot = await toolLib.cacheDir(payload, "ggshield", version);
    }
  } catch (err) {
    console.log(
      `Could not download and verify the ggshield binary ` +
        `(${err}); falling back to a pip/python install.`,
    );
    return null;
  }

  const binPath = path.join(toolRoot, exeName);
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(binPath, 0o755);
    } catch {
      // do not report
    }
  }

  if (spawnSync(binPath, ["--version"], { stdio: "ignore" }).status !== 0) {
    console.log(
      "Downloaded ggshield binary is not runnable on this agent; " +
        "falling back to a pip/python install.",
    );
    return null;
  }
  return binPath;
}

/**
 * Try a list of (cmd, args) tuples and return the first that exits 0.
 * Returns null if nothing worked.
 */
function tryCommands(
  attempts: Array<[string, string[]]>,
  options: SpawnSyncOptions,
): [string, string[]] | null {
  for (const [cmd, args] of attempts) {
    const r = spawnSync(cmd, args, options);
    if (r.status === 0) {
      return [cmd, args];
    }
  }
  return null;
}

/**
 * Resolves the command and args to call ggshield. It checks in this order
 * - if ggshield is installed and on the PATH
 * - if ggshield can be installed from its GitHub releases
 * - if ggshield can be installed as a Python module
 * If any of these succeed, the resolved command and args are returned as a [string, string[]] tuple.
 */
export async function resolveGgshieldCommand(): Promise<[string, string[]]> {
  if (spawnSync("ggshield", ["--version"], { stdio: "ignore" }).status === 0) {
    return ["ggshield", GGSHIELD_ARGS];
  }

  const binPath = await resolveBinaryGgshield();
  if (binPath) {
    return [binPath, GGSHIELD_ARGS];
  }

  console.log(
    "No prebuilt ggshield binary for this agent; attempting pip install...",
  );
  const installed = tryCommands(
    [
      ["pipx", ["install", "ggshield"]],
      ["python3", ["-m", "pip", "install", "--quiet", "ggshield"]],
      ["python", ["-m", "pip", "install", "--quiet", "ggshield"]],
      ["pip3", ["install", "--quiet", "ggshield"]],
      ["pip", ["install", "--quiet", "ggshield"]],
    ],
    { stdio: "inherit" },
  );
  if (installed === null) {
    tl.setResult(
      tl.TaskResult.Failed,
      "Failed to install ggshield: no prebuilt binary for this agent " +
        `(${process.platform}/${process.arch}) and no working pipx/pip ` +
        "(Python 3.8+). Pre-install ggshield in the agent image, or use a " +
        "supported agent (Windows x64, Linux x64 glibc, macOS x64/arm64).",
    );
    throw Error("Failed to install ggshield.");
  }

  const recheck = spawnSync("ggshield", ["--version"], { stdio: "ignore" });
  if (recheck.status !== 0) {
    const moduleAttempts: Array<[string, string[]]> = [
      ["python3", ["-m", "ggshield", "--version"]],
      ["python", ["-m", "ggshield", "--version"]],
    ];
    const moduleResolved = tryCommands(moduleAttempts, { stdio: "ignore" });
    if (moduleResolved === null) {
      tl.setResult(
        tl.TaskResult.Failed,
        "ggshield was installed but is not callable. Add the pip user-bin directory to PATH, or pre-install ggshield in the agent image.",
      );
      throw Error("Failed to invoke python module ggshield.");
    }
    return [moduleResolved[0], ["-m", "ggshield", ...GGSHIELD_ARGS]];
  } else {
    return ["ggshield", GGSHIELD_ARGS];
  }
}
