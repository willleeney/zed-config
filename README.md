# Editor Themes

Custom dark themes with pastelated syntax colors and neutral grey surfaces.

- **Dusk** — evolved from OneDark Deeper with warmer message backgrounds and refined diff colors.
- **OneDark Deeper** — a darker take on OneDark, influenced by [StackOne](https://stackone.com) dark-mode palette.
- **Dawn** — light companion theme.

## Installation

### Zed

Copy the theme file to your Zed themes directory:

```sh
cp themes/dusk-mode.json ~/.config/zed/themes/dusk-mode.json
```

Then set it in `~/.config/zed/settings.json`:

```json
"theme": {
  "mode": "dark",
  "dark": "Dusk Mode"
}
```

### Claude Code

Copy the theme file to your Claude Code themes directory:

```sh
cp claude-code-theme.json ~/.claude/themes/dusk.json
```

Then activate with `/theme` and select "Dusk".

### iTerm2

Copy the dynamic profile — iTerm2 auto-loads it, no manual import:

```sh
cp iterm2/dusk-mode.json "$HOME/Library/Application Support/iTerm2/DynamicProfiles/dusk-mode.json"
```

Then set "Dusk Mode" as your default profile (Settings → Profiles → Other
Actions → Set as Default). The profile also carries macOS-style shell editing keys:

| Shortcut | Action |
|----------|--------|
| ⌥← / ⌥→ | move by word |
| ⌘← / ⌘→ | jump to line start / end |
| ⌥⌫ | delete word backward |
| ⌘⌫ | delete to line start |
| ⌥⌦ / ⌘⌦ | delete word forward / to line end |

Font is IBM Plex Mono (the font behind Zed's old "Zed Plex Mono" name). To match
Zed's *current* default instead, change `Normal Font` to `Lilex-Regular 14`.

## File locations

| File | Install path |
|------|-------------|
| `themes/dusk-mode.json` | `~/.config/zed/themes/dusk-mode.json` |
| `themes/onedark-deeper.json` | `~/.config/zed/themes/onedark-deeper.json` |
| `themes/dawn.json` | `~/.config/zed/themes/dawn.json` |
| `zed/keymap.json` | `~/.config/zed/keymap.json` |
| `claude-code-theme.json` | `~/.claude/themes/dusk.json` |
| `iterm2/dusk-mode.json` | `~/Library/Application Support/iTerm2/DynamicProfiles/dusk-mode.json` |
| `iterm2/onedark-deeper.json` | `~/Library/Application Support/iTerm2/DynamicProfiles/onedark-deeper.json` |
