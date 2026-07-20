import { build, context } from "esbuild";
import { readFileSync } from "fs";

const ggshieldVersion = readFileSync("ggshield_version", "utf8").trim();
if (!/^\d+\.\d+\.\d+$/.test(ggshieldVersion)) {
  throw new Error(
    `Invalid ggshield version "${ggshieldVersion}" in ggshield_version file (expected X.Y.Z).`,
  );
}

const production = process.argv.includes("--production");
const watchMode = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  outfile: "dist/index.js",
  platform: "node",
  define: {
    __GGSHIELD_VERSION__: JSON.stringify(ggshieldVersion), // -> "1.52.0" (a string literal)
  },
};

if (watchMode) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options).catch(() => process.exit(1));
}
