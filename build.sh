#!/usr/bin/env bash
set -euo pipefail

# Build and package the extension into a .vsix ready to upload.
#
# Prereqs:
#   - Node.js 18+ and npm
#   - tfx-cli installed globally:  npm install -g tfx-cli
#   - Publisher ID set in vss-extension.json
#   - images/extension-icon.png present (128x128 PNG)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Sync ggshield-scan-task/task.json's { Major, Minor, Patch } from
# vss-extension.json's top-level "version" so there's only one number to
# bump per release. Both versions MUST agree: the extension version drives
# Marketplace upgrade detection, and the task version drives whether agents
# pull new task bits — ship them out of sync and you'll get either silent
# stale-task-on-old-agents or rejected uploads.
echo "==> Syncing task.json version from vss-extension.json"
node -e '
  const fs = require("fs");
  const ext = JSON.parse(fs.readFileSync("vss-extension.json", "utf8"));
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(ext.version || "");
  if (!m) {
    console.error(`Unexpected version "${ext.version}" in vss-extension.json (expected X.Y.Z).`);
    process.exit(1);
  }
  const [, Major, Minor, Patch] = m.map(Number);
  const taskPath = "ggshield-scan-task/task.json";
  const task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
  task.version = task.version || {};
  task.version.Major = Major;
  task.version.Minor = Minor;
  task.version.Patch = Patch;
  fs.writeFileSync(taskPath, JSON.stringify(task, null, 2) + "\n");
  console.log(`    task.json version -> ${Major}.${Minor}.${Patch}`);
'

echo "==> Installing task dependencies"
pushd ggshield-scan-task > /dev/null
npm install
echo "==> Compiling TypeScript"
npm run build
echo "==> Pruning dev dependencies"
npm prune --production
popd > /dev/null

echo "==> Packaging extension"
# Note: no --rev-version. Bump the "version" field in vss-extension.json
# manually before each release so versions stay deterministic and reviewable.
# The sync step above propagates that single bump into task.json.
tfx extension create \
  --manifest-globs vss-extension.json

echo ""
echo "Done. Upload the generated .vsix to:"
echo "  https://marketplace.visualstudio.com/manage"
echo ""
echo "Then share it privately with your ADO organization, and install it from"
echo "  Organization Settings > Extensions > Shared."
