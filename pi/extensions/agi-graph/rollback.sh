#!/bin/bash
# agi-graph step rollback — walk back the extension without touching anything else.
#
#   bash rollback.sh backup <step>     # snapshot current state (run BEFORE editing)
#   bash rollback.sh restore <step>    # restore a snapshot
#   bash rollback.sh list              # show snapshots
#   bash rollback.sh remove             # delete the whole extension (pi fully back to normal)
#
# The extension lives ONLY in ~/.pi/agent/extensions/agi-graph/. Nothing here
# touches rounded-frames.ts or any other extension. If pi fails to launch for
# ANY reason, `remove` is always a clean exit (pi has no other dependency on it).

set -e
DIR="$HOME/.pi/agent/extensions/agi-graph"
SNAP="$DIR/.snapshots"
mkdir -p "$SNAP"

snap_path() { echo "$SNAP/$1.ts"; }

case "$1" in
  backup)
    step="${2:?usage: backup <step>}"
    cp "$DIR/index.ts" "$(snap_path "$step")"
    echo "backed up $step -> $(snap_path "$step")"
    ;;
  restore)
    step="${2:?usage: restore <step>}"
    p="$(snap_path "$step")"
    [ -f "$p" ] || { echo "no snapshot for step: $step"; exit 1; }
    cp "$p" "$DIR/index.ts"
    echo "restored $step. Run /reload (or restart pi) to apply."
    ;;
  list)
    echo "snapshots in $SNAP:"
    ls -1t "$SNAP" 2>/dev/null || echo "  (none)"
    ;;
  remove)
    rm -rf "$DIR"
    echo "removed $DIR — pi is back to normal. Restart pi to be sure."
    ;;
  *)
    echo "usage: bash $0 {backup|restore|list|remove} [step]"
    exit 1
    ;;
esac
