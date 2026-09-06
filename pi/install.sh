#!/bin/bash
# One-line Pi harness install:
#   bash <(curl -sL https://raw.githubusercontent.com/willleeney/zed-config/master/pi/install.sh)
set -e

DEST="$HOME/.pi/agent"
REPO="https://raw.githubusercontent.com/willleeney/zed-config/master/pi"

mkdir -p "$DEST/themes" "$DEST/extensions/agi-graph"

for f in settings.json models.json mcp.json zentui.json; do
  curl -sfL "$REPO/$f" -o "$DEST/$f"
done

for f in dusk.json dawn.json; do
  curl -sfL "$REPO/themes/$f" -o "$DEST/themes/$f"
done

curl -sfL "$REPO/extensions/rounded-frames.ts" -o "$DEST/extensions/rounded-frames.ts"
curl -sfL "$REPO/extensions/reset-pi.sh" -o "$DEST/extensions/reset-pi.sh"
curl -sfL "$REPO/extensions/agi-graph/index.ts" -o "$DEST/extensions/agi-graph/index.ts"
curl -sfL "$REPO/extensions/agi-graph/rollback.sh" -o "$DEST/extensions/agi-graph/rollback.sh"

chmod +x "$DEST/extensions/reset-pi.sh" "$DEST/extensions/agi-graph/rollback.sh"

echo "Pi harness installed to $DEST — restart pi (or /reload) to apply."
