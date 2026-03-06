#!/usr/bin/env bash
set -euo pipefail

# Package the extension for Chrome and Firefox
# Outputs: release/hwc-chrome.zip and release/hwc-firefox.zip

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$REPO_ROOT/packages/extension/dist"
RELEASE_DIR="$REPO_ROOT/release"

if [ ! -d "$DIST" ]; then
  echo "Error: $DIST does not exist. Run 'npm run build:extension' first."
  exit 1
fi

rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

# Chrome: zip dist as-is
echo "Packaging Chrome extension..."
(cd "$DIST" && zip -r "$RELEASE_DIR/hwc-chrome.zip" .)

# Firefox: copy dist, patch manifest, zip
echo "Packaging Firefox extension..."
FIREFOX_DIR="$RELEASE_DIR/firefox-staging"
cp -r "$DIST" "$FIREFOX_DIR"

node -e "
const fs = require('fs');
const path = '$FIREFOX_DIR/manifest.json';
const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));

manifest.browser_specific_settings = {
  gecko: { id: 'holochain@holo.host' }
};

if (manifest.background) {
  delete manifest.background.type;
}

fs.writeFileSync(path, JSON.stringify(manifest, null, 2));
"

(cd "$FIREFOX_DIR" && zip -r "$RELEASE_DIR/hwc-firefox.zip" .)
rm -rf "$FIREFOX_DIR"

echo "Done. Artifacts in $RELEASE_DIR/:"
ls -lh "$RELEASE_DIR"/*.zip
