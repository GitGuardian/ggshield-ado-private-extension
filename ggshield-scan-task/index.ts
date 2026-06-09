import tl = require('azure-pipelines-task-lib/task');
import toolLib = require('azure-pipelines-tool-lib/tool');
import { verify as sigstoreVerify } from 'sigstore';
import { spawnSync, SpawnSyncOptions } from 'child_process';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Pinned ggshield version, read from the ggshield_version file shipped next
 * to this script (same convention as gitguardian-vscode). ggshield ships
 * standalone (PyInstaller) binaries per OS/arch, so we download and run those
 * directly rather than relying on Python being present on the agent — it
 * frequently is not. Bump the file to roll the extension forward.
 */
function pinnedGgshieldVersion(): string {
  const raw = fs
    .readFileSync(path.join(__dirname, 'ggshield_version'), 'utf8')
    .trim();
  if (!/^\d+\.\d+\.\d+$/.test(raw)) {
    throw new Error(
      `Invalid ggshield version "${raw}" in ggshield_version file (expected X.Y.Z).`
    );
  }
  return raw;
}

interface BinaryTarget {
  triple: string;
  ext: 'zip' | 'tar.gz';
}

/**
 * Map Node's process.platform/process.arch to a published ggshield release
 * archive. Returns null for platforms with no prebuilt binary — Linux arm64,
 * Windows arm64, and musl/Alpine (the published Linux build is glibc-linked
 * and will not run on musl) — which fall back to a pip/python install.
 */
function binaryTargetFor(platform: string, arch: string): BinaryTarget | null {
  if (platform === 'win32' && arch === 'x64') {
    return { triple: 'x86_64-pc-windows-msvc', ext: 'zip' };
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return { triple: 'arm64-apple-darwin', ext: 'tar.gz' };
  }
  if (platform === 'darwin' && arch === 'x64') {
    return { triple: 'x86_64-apple-darwin', ext: 'tar.gz' };
  }
  if (platform === 'linux' && arch === 'x64' && !isMuslLinux()) {
    return { triple: 'x86_64-unknown-linux-gnu', ext: 'tar.gz' };
  }
  return null;
}

/**
 * Best-effort musl (Alpine) detection. Node's process report exposes
 * glibcVersionRuntime only on glibc builds; its absence implies a musl
 * runtime, where the glibc-linked ggshield binary would fail to load.
 * A false positive merely routes us to the slower pip fallback, not to a
 * broken state.
 */
function isMuslLinux(): boolean {
  try {
    const report: any = (process as any).report?.getReport();
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

/**
 * Verify the GitHub Artifact Attestation of a downloaded ggshield release
 * archive. Throws on any failure (no attestation, bad signature, identity or
 * digest mismatch); the caller treats that like a failed download and falls
 * back to pip.
 *
 * The attestation is a Sigstore bundle served by the (unauthenticated)
 * GitHub attestations API. sigstore's verify() checks the DSSE signature,
 * the Fulcio certificate chain (trust root fetched via TUF from
 * tuf-repo-cdn.sigstore.dev), Rekor transparency-log inclusion, and the
 * signer identity. It does NOT check that the attested statement is about
 * *our* bytes, so we compare the in-toto subject digest ourselves.
 */
async function verifyAttestation(
  archivePath: string,
  version: string
): Promise<void> {
  const sha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(archivePath))
    .digest('hex');

  const res = await fetch(
    `https://api.github.com/repos/GitGuardian/ggshield/attestations/sha256:${sha256}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        // GitHub rejects requests without a User-Agent.
        'user-agent': 'ggshield-ado-extension',
      },
    }
  );
  if (!res.ok) {
    throw new Error(`attestation fetch failed: HTTP ${res.status}`);
  }
  const attestations: any[] = ((await res.json()) as any)?.attestations ?? [];
  if (attestations.length === 0) {
    throw new Error('no attestation found for the artifact digest');
  }

  // Exact signer identity (SAN URI of the Fulcio certificate) of ggshield's
  // release workflow. Coupled to the workflow filename in GitGuardian/
  // ggshield: a rename there makes verification fail, which logs and falls
  // back to pip — check the task logs when bumping ggshield_version.
  const identityURI =
    `https://github.com/GitGuardian/ggshield/.github/workflows/tag.yml` +
    `@refs/tags/v${version}`;

  // An artifact can carry several attestations (e.g. workflow re-runs);
  // accept the first that fully verifies.
  const failures: string[] = [];
  for (const att of attestations) {
    try {
      await sigstoreVerify(att.bundle, {
        certificateIssuer: 'https://token.actions.githubusercontent.com',
        certificateIdentityURI: identityURI,
      });
      const stmt = JSON.parse(
        Buffer.from(att.bundle.dsseEnvelope.payload, 'base64').toString('utf8')
      );
      const subjects: any[] = stmt?.subject ?? [];
      if (!subjects.some((s) => s?.digest?.sha256 === sha256)) {
        throw new Error('attestation subject digest does not match the archive');
      }
      console.log(
        'ggshield provenance verified (GitHub artifact attestation, ' +
        `built by ${identityURI}).`
      );
      return;
    } catch (err: any) {
      failures.push(err.message || String(err));
    }
  }
  throw new Error(`attestation verification failed: ${failures.join('; ')}`);
}

/**
 * Download (once, then agent-cached) the pinned standalone ggshield binary
 * for this OS/arch and return an absolute path to the executable. Returns
 * null when there is no prebuilt binary for the platform, when the download
 * fails (e.g. no route to github.com), or when the downloaded binary fails
 * to run — all signalling the pip/python fallback. Never throws: this task
 * is decorator-injected into every pipeline, so a GitHub blip must degrade
 * to the fallback, not fail builds org-wide.
 */
async function resolveBinaryGgshield(): Promise<string | null> {
  const target = binaryTargetFor(process.platform, process.arch);
  if (!target) {
    return null;
  }

  let toolRoot: string;
  const exeName = process.platform === 'win32' ? 'ggshield.exe' : 'ggshield';
  try {
    const version = pinnedGgshieldVersion();
    const stem = `ggshield-${version}-${target.triple}`;

    // Agent-level tool cache: download once, reuse across runs and pipelines.
    toolRoot = toolLib.findLocalTool('ggshield', version);
    if (!toolRoot) {
      const url =
        `https://github.com/GitGuardian/ggshield/releases/download/` +
        `v${version}/${stem}.${target.ext}`;
      console.log(`Downloading ggshield ${version} (${target.triple})...`);
      const archive = await toolLib.downloadTool(url);
      // Provenance check before anything from the archive is executed or
      // cached. Throws (→ pip fallback) if it cannot positively verify.
      await verifyAttestation(archive, version);
      const extracted =
        target.ext === 'zip'
          ? await toolLib.extractZip(archive)
          : await toolLib.extractTar(archive);
      // Each archive holds a single top-level <stem>/ directory containing the
      // executable alongside its PyInstaller _internal/ payload. The binary
      // cannot be separated from that payload, so we cache the whole directory.
      const payload = path.join(extracted, stem);
      toolRoot = await toolLib.cacheDir(payload, 'ggshield', version);
    }
  } catch (err: any) {
    console.log(
      `Could not download and verify the ggshield binary ` +
      `(${err.message || err}); falling back to a pip/python install.`
    );
    return null;
  }

  const binPath = path.join(toolRoot, exeName);
  if (process.platform !== 'win32') {
    // extractTar generally preserves the executable bit; ensure it regardless.
    try {
      fs.chmodSync(binPath, 0o755);
    } catch {
      /* best-effort */
    }
  }

  // Confirm the binary actually runs here (guards against arch mismatch,
  // musl, or a corrupt download) before committing to it. spawnSync does
  // not throw on a missing/broken binary; it reports via status/error.
  if (spawnSync(binPath, ['--version'], { stdio: 'ignore' }).status !== 0) {
    console.log(
      'Downloaded ggshield binary is not runnable on this agent; ' +
      'falling back to a pip/python install.'
    );
    return null;
  }
  return binPath;
}

/**
 * The whole reason this extension exists: a custom task can declare a
 * Generic service connection as a typed `connectedService:Generic` input.
 * In that case, and only in that case, tl.getEndpointUrl() and
 * tl.getEndpointAuthorizationParameter() resolve the stored values.
 *
 * The `$(endpoint.url.<name>)` / `$(endpoint.password.<name>)` macros
 * used in free-form YAML variables DO NOT resolve — that's the root cause
 * of the "invalid API key" error seen by pipelines trying to share a
 * Generic connection through `variables:` or `env:` blocks.
 */

/**
 * Minimal POSIX-shell-style argv splitter. Handles single quotes, double
 * quotes, and backslash escapes well enough for the additionalArguments
 * input. Avoids pulling in a dependency just for this.
 */
function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let hasContent = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) {
      cur += ch;
      escaped = false;
      hasContent = true;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      hasContent = true;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      hasContent = true;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (hasContent) {
        out.push(cur);
        cur = '';
        hasContent = false;
      }
      continue;
    }
    cur += ch;
    hasContent = true;
  }
  if (hasContent) {
    out.push(cur);
  }
  return out;
}

/**
 * Drop any `--show-secrets` token from the forwarded arguments.
 *
 * That flag makes ggshield print every detected secret in plaintext, which then
 * lands in the pipeline logs — readable by anyone with access to the run. This
 * task is injected org-wide by a decorator, so a single pipeline enabling it
 * leaks real credentials into broadly-visible logs. ggshield otherwise censors
 * secrets by default (e.g. `Xy9$k***...23XYZ`), which is what we keep.
 *
 * This is the one deliberate exception to forwarding additionalArguments
 * verbatim: a secret scanner must never be the thing that prints the secret.
 */
function stripShowSecrets(parsedArgs: string[]): string[] {
  const kept = parsedArgs.filter((arg) => arg !== '--show-secrets');
  if (kept.length !== parsedArgs.length) {
    tl.warning(
      'Ignoring --show-secrets: it would print detected secrets in plaintext ' +
      'to the pipeline logs. ggshield keeps secret values masked in its output.'
    );
  }
  return kept;
}

/**
 * Try a list of (cmd, args) tuples and return the first that exits 0.
 * Returns null if nothing worked.
 */
function tryCommands(
  attempts: Array<[string, string[]]>,
  options: SpawnSyncOptions
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
    const connectionName = tl.getInput('gitguardianConnection', true)!;
    const scanMode = tl.getInput('scanMode', true)!;
    const scanTarget = tl.getInput('scanTarget', false) || '.';
    const additionalArgs = tl.getInput('additionalArguments', false) || '';
    const failOnIssues = tl.getBoolInput('failOnIssues', false);

    const rawTimeout = tl.getInput('scanTimeoutSeconds', false) || '80';
    const parsedTimeout = Number.parseInt(rawTimeout, 10);
    if (!Number.isFinite(parsedTimeout) || parsedTimeout < 10) {
      tl.setResult(
        tl.TaskResult.Failed,
        `scanTimeoutSeconds must be an integer >= 10 (got "${rawTimeout}").`
      );
      return;
    }
    const scanTimeoutMs = parsedTimeout * 1000;

    const apiKey = tl.getEndpointAuthorizationParameter(
      connectionName,
      'password',
      false
    );
    // Second arg is `optional`, not `required`: true here means "don't throw
    // if the URL is missing". Instance URL is genuinely optional (defaults to
    // ggshield SaaS US when unset).
    const instanceUrl = tl.getEndpointUrl(connectionName, true);

    if (!apiKey) {
      tl.setResult(
        tl.TaskResult.Failed,
        `No API key found on service connection "${connectionName}". ` +
        `Make sure the Password field of the Generic connection holds your ggshield API key.`
      );
      return;
    }

    // Scrub from logs even though ADO should mask endpoint secrets already.
    tl.setSecret(apiKey);

    const env = { ...process.env };
    env['GITGUARDIAN_API_KEY'] = apiKey;
    if (instanceUrl && instanceUrl.trim() !== '') {
      env['GITGUARDIAN_INSTANCE'] = instanceUrl;
    }

    // Resolve a working ggshield invocation, in order of preference:
    //   1. A ggshield already on PATH (pre-installed / air-gapped / custom).
    //   2. The pinned standalone binary downloaded for this OS/arch — the
    //      primary path, requiring no Python on the agent.
    //   3. A pip/pipx install + `python -m ggshield`, reached only on
    //      platforms with no prebuilt binary or when the download fails.
    let ggshieldCmd: string = 'ggshield';
    let ggshieldPrefix: string[] = [];
    let resolved = false;

    // 1. Pre-installed on PATH.
    if (spawnSync('ggshield', ['--version'], { stdio: 'ignore' }).status === 0) {
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
        'No prebuilt ggshield binary for this agent; attempting pip install...'
      );
      // pipx is preferred (isolated env, binary on PATH); fall back to plain pip.
      const installed = tryCommands(
        [
          ['pipx', ['install', 'ggshield']],
          ['python3', ['-m', 'pip', 'install', '--quiet', 'ggshield']],
          ['python', ['-m', 'pip', 'install', '--quiet', 'ggshield']],
          ['pip3', ['install', '--quiet', 'ggshield']],
          ['pip', ['install', '--quiet', 'ggshield']],
        ],
        { stdio: 'inherit' }
      );
      if (installed === null) {
        tl.setResult(
          tl.TaskResult.Failed,
          'Failed to install ggshield: no prebuilt binary for this agent ' +
          `(${process.platform}/${process.arch}) and no working pipx/pip ` +
          '(Python 3.8+). Pre-install ggshield in the agent image, or use a ' +
          'supported agent (Windows x64, Linux x64 glibc, macOS x64/arm64).'
        );
        return;
      }

      // After install, ggshield may not be on PATH (user-site installs, Windows).
      // Re-check, and fall back to `python -m ggshield` if needed.
      const recheck = spawnSync('ggshield', ['--version'], { stdio: 'ignore' });
      if (recheck.status !== 0) {
        const moduleAttempts: Array<[string, string[]]> = [
          ['python3', ['-m', 'ggshield', '--version']],
          ['python', ['-m', 'ggshield', '--version']],
        ];
        const moduleResolved = tryCommands(moduleAttempts, { stdio: 'ignore' });
        if (moduleResolved === null) {
          tl.setResult(
            tl.TaskResult.Failed,
            'ggshield was installed but is not callable. Add the pip user-bin directory to PATH, or pre-install ggshield in the agent image.'
          );
          return;
        }
        ggshieldCmd = moduleResolved[0];
        ggshieldPrefix = ['-m', 'ggshield'];
      }
    }

    const args = [...ggshieldPrefix, 'secret', 'scan', scanMode];
    if (scanMode === 'path') {
      // CI agents have no stdin, so ggshield's >50-file confirmation
      // prompt would otherwise hang the step until scanTimeoutSeconds.
      args.push('--yes', '--recursive', scanTarget);
    } else if (scanMode === 'docker') {
      args.push(scanTarget);
    }
    if (additionalArgs.trim() !== '') {
      args.push(...stripShowSecrets(splitArgs(additionalArgs)));
    }

    console.log(`Running: ${ggshieldCmd} ${args.join(' ')}`);
    const result = spawnSync(ggshieldCmd, args, {
      stdio: 'inherit',
      env,
      timeout: scanTimeoutMs
    });

    // Timeout: pygitguardian retries 429 rate-limits indefinitely, so a scan
    // that runs past the timeout is almost always stuck on rate-limit backoff.
    // Fail-open here — a transient GitGuardian-side event must not take down
    // every pipeline in the org.
    if (result.signal === 'SIGTERM') {
      tl.setResult(
        tl.TaskResult.SucceededWithIssues,
        `ggshield exceeded the ${parsedTimeout}s scan timeout and was terminated. ` +
        `This usually indicates GitGuardian API rate-limiting; the scan was skipped to avoid blocking the build.`
      );
      return;
    }

    if (result.status === 0) {
      tl.setResult(tl.TaskResult.Succeeded, 'No secrets detected.');
    } else if (result.status === 1) {
      // Policy violation (secrets found). This is the only case failOnIssues governs.
      if (failOnIssues) {
        tl.setResult(tl.TaskResult.Failed, 'ggshield detected secrets. See output above.');
      } else {
        tl.setResult(
          tl.TaskResult.SucceededWithIssues,
          'ggshield detected secrets (not failing build: failOnIssues=false).'
        );
      }
    } else {
      // Non-1 non-zero: infrastructure error (auth, network, crash). Warn but
      // do not block the build.
      tl.setResult(
        tl.TaskResult.SucceededWithIssues,
        `ggshield exited with code ${result.status} (infrastructure error, not a secret finding). See output above.`
      );
    }
  } catch (err: any) {
    tl.setResult(tl.TaskResult.Failed, err.message || String(err));
  }
}

run();
