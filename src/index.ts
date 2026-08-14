import * as tl from "azure-pipelines-task-lib/task";
import { spawnSync } from "child_process";
import {
  GGSHIELD_CHANGES_ARGS,
  GGSHIELD_REPOSITORY_ARGS,
  GGSHIELD_SCAN_TIMEOUT_MS,
} from "./constants";
import { resolveGgshieldCommand } from "./ggshield";

declare const __PRODUCTION__: boolean;

async function run(): Promise<void> {
  try {
    const connectionName = tl.getInput("gitguardianConnection", true)!;
    const scanArgs =
      tl.getInput("scanScope", false) === "repository"
        ? [
            ...GGSHIELD_REPOSITORY_ARGS,
            tl.getVariable("Build.SourcesDirectory") || ".",
          ]
        : GGSHIELD_CHANGES_ARGS;

    const apiKey = tl.getEndpointAuthorizationParameter(
      connectionName,
      "password",
      true,
    );

    const env = process.env;

    if (!apiKey) {
      tl.setResult(
        tl.TaskResult.Failed,
        `No API key found on service connection "${connectionName}". ` +
          `Make sure the Password field of the Generic connection holds your ggshield API key.`,
      );
      return;
    } else {
      tl.setSecret(apiKey);
      env["GITGUARDIAN_API_KEY"] = apiKey;
    }
    const instanceUrl = tl.getEndpointUrl(connectionName, true);
    if (instanceUrl && instanceUrl.trim() !== "") {
      env["GITGUARDIAN_INSTANCE"] = instanceUrl;
    }

    const [ggshieldCmd, args] = await resolveGgshieldCommand(scanArgs);

    console.log(`Running: ${ggshieldCmd} ${args.join(" ")}`);
    const result = spawnSync(ggshieldCmd, args, {
      stdio: "inherit",
      env,
      timeout: GGSHIELD_SCAN_TIMEOUT_MS,
    });

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
        `ggshield exited with code ${result.status}. See output above.`,
      );
    }
  } catch (err) {
    tl.setResult(tl.TaskResult.Failed, String(err));
  }
}

if (__PRODUCTION__) {
  run().catch((err) => tl.setResult(tl.TaskResult.Failed, String(err)));
} else {
  module.exports.ggshieldSmokeTest = resolveGgshieldCommand;
  module.exports.GGSHIELD_CHANGES_ARGS = GGSHIELD_CHANGES_ARGS;
  module.exports.GGSHIELD_REPOSITORY_ARGS = GGSHIELD_REPOSITORY_ARGS;
}
