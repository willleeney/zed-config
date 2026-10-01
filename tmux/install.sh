#!/usr/bin/env bash
# Persistent iTerm2 tabs backed by tmux (control mode) + resurrect/continuum.
# Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

command -v tmux >/dev/null || brew install tmux

mkdir -p ~/.tmux/plugins
for p in tpm tmux-resurrect tmux-continuum; do
  [ -d ~/.tmux/plugins/$p ] || git clone -q https://github.com/tmux-plugins/$p ~/.tmux/plugins/$p
done

if [ -f ~/.tmux.conf ] && ! cmp -s tmux.conf ~/.tmux.conf; then
  cp ~/.tmux.conf ~/.tmux.conf.bak
  echo "backed up existing ~/.tmux.conf to ~/.tmux.conf.bak"
fi
cp tmux.conf ~/.tmux.conf

mkdir -p ~/.config/zsh
cp tm.zsh ~/.config/zsh/tm.zsh
line='source ~/.config/zsh/tm.zsh'
grep -qxF "$line" ~/.zshrc 2>/dev/null || printf '\n%s\n' "$line" >> ~/.zshrc

echo "done. open a new iTerm window (or run: source ~/.zshrc)"
