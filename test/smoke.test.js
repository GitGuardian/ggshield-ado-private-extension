const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const { ggshieldSmokeTest } = require(
  path.join(__dirname, "..", "dist", "index.js"),
);

test(
  "compiled task resolves a runnable `secret scan ci` command",
  { timeout: 120_000 },
  async () => {
    assert.equal(
      typeof ggshieldSmokeTest,
      "function",
      "dist/index.js does not export ggshieldSmokeTest",
    );

    const [cmd, args] = await ggshieldSmokeTest();

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
