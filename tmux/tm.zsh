# tmux + iTerm2 control mode: reattach (or restore) persistent session
tm() {
  if [ -n "$TMUX" ]; then echo "already inside tmux"; return 1; fi
  # unhide any windows iTerm marked hidden so every window reopens
  tmux has-session -t main 2>/dev/null && tmux set-option -t main -u @hidden
  tmux -CC new-session -A -D -s main
}

# auto-attach tmux in iTerm when no client is attached yet (skip with NO_TM=1)
if [[ -o interactive && "$TERM_PROGRAM" == "iTerm.app" && -z "$TMUX" && -z "$NO_TM" ]] \
   && [[ -z "$(tmux list-clients -t main 2>/dev/null)" ]]; then
  tm
fi
