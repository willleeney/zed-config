#!/bin/bash
# Install OneDark Deeper theme and config for Ghostty
# Usage: ./install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GHOSTTY_CONFIG="$HOME/.config/ghostty"

echo "Installing OneDark Deeper for Ghostty..."

mkdir -p "$GHOSTTY_CONFIG/themes"

# Symlink theme
ln -sf "$SCRIPT_DIR/onedark-deeper" "$GHOSTTY_CONFIG/themes/onedark-deeper"
echo "Linked theme → $GHOSTTY_CONFIG/themes/onedark-deeper"

# Symlink config
ln -sf "$SCRIPT_DIR/config" "$GHOSTTY_CONFIG/config"
echo "Linked config → $GHOSTTY_CONFIG/config"

# Remove iTerm2 tab-color snippet from zshrc if present
SHELL_RC="$HOME/.zshrc"
MARKER="# iTerm2 OneDark Deeper tab colors"
if grep -q "$MARKER" "$SHELL_RC" 2>/dev/null; then
    echo "Removing old iTerm2 tab-color snippet from $SHELL_RC..."
    sed -i '' "/$MARKER/d" "$SHELL_RC"
    sed -i '' '\|source.*tab-colors.sh|d' "$SHELL_RC"
fi

echo ""
echo "Done! Open Ghostty to use it."
echo "Cmd+1-9 switches tabs. Right-click a tab to set its color."
