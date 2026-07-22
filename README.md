# OneDark Deeper

A darker, pastelated take on OneDark with neutral grey surfaces. Syntax colors influenced by [StackOne](https://stackone.com) dark-mode palette.

## Installation

### Zed

Copy the theme file to your Zed themes directory:

```sh
cp themes/onedark-deeper.json ~/.config/zed/themes/onedark-deeper.json
```

Then set it in `~/.config/zed/settings.json`:

```json
"theme": {
  "mode": "dark",
  "dark": "OneDark Deeper"
}
```

### Claude Code

Copy the theme file to your Claude Code themes directory:

```sh
cp claude-code-theme.json ~/.claude/themes/onedark-deeper.json
```

Then activate with `/theme` and select "OneDark Deeper".

### OpenCode

Copy the theme and config files:

```sh
cp opencode/onedark-deeper.json ~/.config/opencode/themes/onedark-deeper.json
cp opencode/tui.json ~/.config/opencode/tui.json
```

The theme will be active on your next OpenCode session.

### iTerm2

Copy the dynamic profile — iTerm2 auto-loads it, no manual import:

```sh
cp iterm2/onedark-deeper.json "$HOME/Library/Application Support/iTerm2/DynamicProfiles/onedark-deeper.json"
```

Then set "OneDark Deeper" as your default profile (Settings → Profiles → Other
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
| `themes/onedark-deeper.json` | `~/.config/zed/themes/onedark-deeper.json` |
| `claude-code-theme.json` | `~/.claude/themes/onedark-deeper.json` |
| `opencode/onedark-deeper.json` | `~/.config/opencode/themes/onedark-deeper.json` |
| `opencode/tui.json` | `~/.config/opencode/tui.json` |
| `iterm2/onedark-deeper.json` | `~/Library/Application Support/iTerm2/DynamicProfiles/onedark-deeper.json` |
