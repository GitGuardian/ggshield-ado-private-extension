const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const {
  ggshieldSmokeTest,
  GGSHIELD_CHANGES_ARGS,
  GGSHIELD_REPOSITORY_ARGS,
} = require(path.join(__dirname, "..", "dist", "index.js"));

for (const [scope, scanArgs] of [
  ["changes", GGSHIELD_CHANGES_ARGS],
  ["repository", GGSHIELD_REPOSITORY_ARGS],
]) {
  test(
    `compiled task resolves a runnable command for the \`${scope}\` scope`,
    { timeout: 120_000 },
    async () => {
      assert.equal(
        typeof ggshieldSmokeTest,
        "function",
        "dist/index.js does not export ggshieldSmokeTest",
      );

      const [cmd, args] = await ggshieldSmokeTest(scanArgs);

      assert.deepEqual(
        args.slice(-scanArgs.length),
        scanArgs,
        `resolved command dropped the ${scope} scan arguments`,
      );

      const result = spawnSync(cmd, [...args, "--help"], { encoding: "utf8" });

      assert.equal(
        result.status,
        0,
        `\`${cmd} ${[...args, "--help"].join(" ")}\` exited with ` +
          `${result.status ?? `signal ${result.signal}`}.\n` +
          `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    },
  );
}
