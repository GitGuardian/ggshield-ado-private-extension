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
tfx extension create \
  --manifest-globs vss-extension.json

echo ""
echo "Done. Upload the generated .vsix to:"
echo "  https://marketplace.visualstudio.com/manage"
echo ""
echo "Then share it privately with your ADO organization, and install it from"
echo "  Organization Settings > Extensions > Shared."
