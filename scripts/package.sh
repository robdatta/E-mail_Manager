#!/usr/bin/env bash
# Builds the Chrome Web Store upload: dist/email-manager-<version>.zip
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./manifest.json').version")
if grep -q "REPLACE_WITH_YOUR_CLIENT_ID" lib/config.js; then
  echo "Warning: lib/config.js still has no OAuth client ID (see docs/PUBLISHING.md step 3)." >&2
fi
mkdir -p dist
OUT="dist/email-manager-$VERSION.zip"
rm -f "$OUT"
zip -qr "$OUT" manifest.json background.js app.html app.js app.css popup.html popup.js popup.css ui.css lib icons
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
