#!/usr/bin/env bash
set -euo pipefail

# Package the extension for Chrome and Firefox
# Expects pre-built dist-chrome/ and dist-firefox/ directories.
# Outputs: release/hwc-chrome.zip and release/hwc-firefox.zip

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_CHROME="$REPO_ROOT/packages/extension/dist-chrome"
DIST_FIREFOX="$REPO_ROOT/packages/extension/dist-firefox"
RELEASE_DIR="$REPO_ROOT/release"

if [ ! -d "$DIST_CHROME" ]; then
  echo "Error: $DIST_CHROME does not exist. Run 'npm run build:extension' first."
  exit 1
fi

if [ ! -d "$DIST_FIREFOX" ]; then
  echo "Error: $DIST_FIREFOX does not exist. Run 'npm run build:extension' first."
  exit 1
fi

rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

# Chrome: zip dist-chrome as-is
echo "Packaging Chrome extension..."
(cd "$DIST_CHROME" && zip -r "$RELEASE_DIR/hwc-chrome.zip" .)

# Firefox: zip dist-firefox as-is
echo "Packaging Firefox extension..."
(cd "$DIST_FIREFOX" && zip -r "$RELEASE_DIR/hwc-firefox.zip" .)

echo "Done. Artifacts in $RELEASE_DIR/:"
ls -lh "$RELEASE_DIR"/*.zip
