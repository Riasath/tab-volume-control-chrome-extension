#!/usr/bin/env bash
# Renders docs/preview.html to docs/screenshot.png with headless Chrome.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || CHROME="$(command -v google-chrome || command -v chromium)"

"$CHROME" \
  --headless=new \
  --disable-gpu \
  --hide-scrollbars \
  --force-device-scale-factor=2 \
  --window-size=340,492 \
  --default-background-color=00000000 \
  --screenshot="$ROOT/docs/screenshot.png" \
  "file://$ROOT/docs/preview.html" >/dev/null 2>&1

echo "wrote docs/screenshot.png"
