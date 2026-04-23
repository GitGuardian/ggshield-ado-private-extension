import tl = require('azure-pipelines-task-lib/task');
import { spawnSync, SpawnSyncOptions } from 'child_process';

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

    // Resolve a working ggshield invocation. We try the bare binary first
    // (fast path on agents where ggshield is pre-installed or pipx-shimmed),
    // then fall back to `python -m ggshield` after attempting an install.
    let ggshieldCmd: string = 'ggshield';
    let ggshieldPrefix: string[] = [];

    const present = spawnSync('ggshield', ['--version'], { stdio: 'ignore' });
    if (present.status !== 0) {
      console.log('ggshield not found on agent; attempting install...');
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
          'Failed to install ggshield. Ensure pipx or pip (Python 3.8+) is available on the agent, or pre-install ggshield in the agent image.'
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
      args.push('--recursive', scanTarget);
    } else if (scanMode === 'docker') {
      args.push(scanTarget);
    }
    if (additionalArgs.trim() !== '') {
      args.push(...splitArgs(additionalArgs));
    }

    console.log(`Running: ${ggshieldCmd} ${args.join(' ')}`);
    const result = spawnSync(ggshieldCmd, args, {
      stdio: 'inherit',
      env
    });

    if (result.status === 0) {
      tl.setResult(tl.TaskResult.Succeeded, 'No secrets detected.');
    } else if (failOnIssues) {
      tl.setResult(
        tl.TaskResult.Failed,
        `ggshield exited with code ${result.status}. See output above for details.`
      );
    } else {
      tl.setResult(
        tl.TaskResult.SucceededWithIssues,
        `ggshield exited with code ${result.status} (not failing build: failOnIssues=false).`
      );
    }
  } catch (err: any) {
    tl.setResult(tl.TaskResult.Failed, err.message || String(err));
  }
}

run();
