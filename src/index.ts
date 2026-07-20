import * as tl from "azure-pipelines-task-lib/task";
import { spawnSync, SpawnSyncOptions } from "child_process";
import { GGSHIELD_SCAN_TIMEOUT_MS } from "./constants";
import { resolveBinaryGgshield } from "./ggshield";

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
    // ENOENT shows up as r.error; non-zero exit means the command ran but failed.
    // Either way, fall through to the next attempt.
  }
  return null;
}

async function run(): Promise<void> {
  try {
    const connectionName = tl.getInput("gitguardianConnection", true)!;

    const apiKey = tl.getEndpointAuthorizationParameter(
      connectionName,
      "password",
      false,
    );
    // Second arg is `optional`, not `required`: true here means "don't throw
    // if the URL is missing". Instance URL is genuinely optional (defaults to
    // ggshield SaaS US when unset).
    const instanceUrl = tl.getEndpointUrl(connectionName, true);

    if (!apiKey) {
      tl.setResult(
        tl.TaskResult.Failed,
        `No API key found on service connection "${connectionName}". ` +
          `Make sure the Password field of the Generic connection holds your ggshield API key.`,
      );
      return;
    }

    // Scrub from logs even though ADO should mask endpoint secrets already.
    tl.setSecret(apiKey);

    const env = { ...process.env };
    env["GITGUARDIAN_API_KEY"] = apiKey;
    if (instanceUrl && instanceUrl.trim() !== "") {
      env["GITGUARDIAN_INSTANCE"] = instanceUrl;
    }

    // Resolve a working ggshield invocation, in order of preference:
    //   1. A ggshield already on PATH (pre-installed / air-gapped / custom).
    //   2. The pinned standalone binary downloaded for this OS/arch — the
    //      primary path, requiring no Python on the agent.
    //   3. A pip/pipx install + `python -m ggshield`, reached only on
    //      platforms with no prebuilt binary or when the download fails.
    let ggshieldCmd: string = "ggshield";
    let ggshieldPrefix: string[] = [];
    let resolved = false;

    // 1. Pre-installed on PATH.
    if (
      spawnSync("ggshield", ["--version"], { stdio: "ignore" }).status === 0
    ) {
      resolved = true;
    }

    // 2. Pinned standalone binary.
    if (!resolved) {
      const binPath = await resolveBinaryGgshield();
      if (binPath) {
        ggshieldCmd = binPath;
        resolved = true;
      }
    }

    // 3. pip/python fallback.
    if (!resolved) {
      console.log(
        "No prebuilt ggshield binary for this agent; attempting pip install...",
      );
      // pipx is preferred (isolated env, binary on PATH); fall back to plain pip.
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
        return;
      }

      // After install, ggshield may not be on PATH (user-site installs, Windows).
      // Re-check, and fall back to `python -m ggshield` if needed.
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
          return;
        }
        ggshieldCmd = moduleResolved[0];
        ggshieldPrefix = ["-m", "ggshield"];
      }
    }

    const args = [...ggshieldPrefix, "secret", "scan", "ci"];

    console.log(`Running: ${ggshieldCmd} ${args.join(" ")}`);
    const result = spawnSync(ggshieldCmd, args, {
      stdio: "inherit",
      env,
      timeout: GGSHIELD_SCAN_TIMEOUT_MS,
    });

    // Timeout: pygitguardian retries 429 rate-limits indefinitely, so a scan
    // that runs past the timeout is almost always stuck on rate-limit backoff.
    // Fail-open here — a transient GitGuardian-side event must not take down
    // every pipeline in the org.
    if (result.signal === "SIGTERM") {
      tl.setResult(
        tl.TaskResult.SucceededWithIssues,
        `ggshield exceeded the ${GGSHIELD_SCAN_TIMEOUT_MS}ms scan timeout and was terminated. ` +
          `This usually indicates GitGuardian API rate-limiting; the scan was skipped to avoid blocking the build.`,
      );
      return;
    }

    if (result.status === 0) {
      tl.setResult(tl.TaskResult.Succeeded, "No secrets detected.");
    } else if (result.status === 1) {
      tl.setResult(
        tl.TaskResult.Failed,
        "ggshield detected secrets. See output above.",
      );
    } else {
      tl.setResult(
        tl.TaskResult.SucceededWithIssues,
        `ggshield exited with code ${result.status} (infrastructure error, not a secret finding). See output above.`,
      );
    }
  } catch (err) {
    tl.setResult(tl.TaskResult.Failed, String(err));
  }
}

run().catch(console.error);
