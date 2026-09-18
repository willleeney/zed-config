#!/bin/bash
# Nuclear reset for pi UI — removes all custom extensions.
# Usage: bash ~/.pi/agent-dev/extensions/reset-pi.sh  (set PI_CODING_AGENT_DIR to target another instance)
set -e

EXT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions"

echo "Resetting pi extensions..."

if [ -d "$EXT_DIR" ]; then
	# Remove everything except this reset script itself
	find "$EXT_DIR" -maxdepth 1 -type f ! -name 'reset-pi.sh' -delete 2>/dev/null
	echo "  ✓ cleared $EXT_DIR (kept reset-pi.sh)"
fi

echo "Done. Restart pi."
