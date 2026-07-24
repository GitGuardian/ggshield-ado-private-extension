import { build, context } from "esbuild";
import { readFileSync, writeFileSync, copyFileSync } from "fs";

const production = process.argv.includes("--production");
const watchMode = process.argv.includes("--watch");

// ggshield_version version info regex
const GGSHIELD_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/
// package.json version info regex
const PACKAGE_VERSION_RE = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/
// task.json version info regex
const TASK_VERSION_RE =
  /("version"\s{0,8}:\s{0,8}\{[^}]{0,40}?"Major"\s{0,8}:\s{0,8})\d{1,6}([^}]{0,40}?"Minor"\s{0,8}:\s{0,8})\d{1,6}([^}]{0,40}?"Patch"\s{0,8}:\s{0,8})\d{1,6}/;
// vss-extension.json version info regex
const EXTENSION_VERSION_RE = /("version"\s{0,8}:\s{0,8}")\d{1,6}\.\d{1,6}\.\d{1,6}(")/;

function checkVersionString(regex, versionString) {
  if (!regex.test(versionString)) {
    throw new Error(
      `Failed to match version regex: ${regex}`
    );
  }
}

const ggshieldVersion = readFileSync("ggshield_version", "utf8").trim();
checkVersionString(GGSHIELD_VERSION_RE, ggshieldVersion)

// Parse package.json version as the single source of truth
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
checkVersionString(PACKAGE_VERSION_RE, version)
const { major, minor, patch } = PACKAGE_VERSION_RE.exec(version).groups;

// Replace version in file with regex
function patchFile(path, regex, replacement) {
  const before = readFileSync(path, "utf8");
  checkVersionString(regex, before)
  const after = before.replace(regex, replacement);
  if (after !== before) {
    writeFileSync(path, after);
  }
}
// esbuild plugin: propagate the canonical version into the ADO manifests as
// part of the build lifecycle (runs for both one-shot builds and watch).
const syncVersionPlugin = {
  name: "sync-version",
  setup(build) {
    build.onStart(() => {
      patchFile("task.json", TASK_VERSION_RE, `$1${major}$2${minor}$3${patch}`);
      patchFile("vss-extension.json", EXTENSION_VERSION_RE, `$1${version}$2`);
    });
    // dist/ is the packaged ADO task folder. Drop the version-synced task.json
    // beside the bundle so the task deploys as one self-contained unit and its
    // execution target ("index.js") resolves within dist/.
    build.onEnd((result) => {
      if (result.errors.length === 0) {
        copyFileSync("task.json", "dist/task.json");
      }
    });
  },
};

const options = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  outfile: "dist/index.js",
  platform: "node",
  define: {
    __GGSHIELD_VERSION__: JSON.stringify(ggshieldVersion),
    __PRODUCTION__: JSON.stringify(production),
  },
  plugins: [syncVersionPlugin],
};

if (watchMode) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options).catch(() => process.exit(1));
}
