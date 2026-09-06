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

Three profiles are included: **Dusk** (dark, default), **Dawn** (dark variant),
and **Default** (light, Lilex font). Copy the dynamic profiles — iTerm2
auto-loads them, no manual import:

```sh
cp iterm2/dusk.json iterm2/dawn.json iterm2/default.json \
   "$HOME/Library/Application Support/iTerm2/DynamicProfiles/"
```

Then set "Dusk" as your default profile (Settings → Profiles → Other Actions →
Set as Default). Dusk/Dawn carry macOS-style shell editing keys:

| Shortcut | Action |
|----------|--------|
| ⌥← / ⌥→ | move by word |
| ⌘← / ⌘→ | jump to line start / end |
| ⌥⌫ | delete word backward |
| ⌘⌫ | delete to line start |
| ⌥⌦ / ⌘⌦ | delete word forward / to line end |

#### Global settings

`global-settings.json` captures app-wide iTerm2 preferences (global key
mappings, color presets, tab style, margins, pane dimming, etc.). To apply:

```sh
defaults import com.googlecode.iterm2 iterm2/global-settings.json
```

Or import selectively via Settings → General → Preferences → "Load preferences
from a custom folder".

### Pi (coding agent)

One-line install (everything, including themes and extensions):

```sh
bash <(curl -sL https://raw.githubusercontent.com/willleeney/zed-config/master/pi/install.sh)
```

Or copy files manually to `~/.pi/agent/`:

```sh
cp pi/settings.json pi/models.json pi/mcp.json pi/zentui.json ~/.pi/agent/
```

This sets **qwen3.8-27b** (direct Modal serve, no proxy) as the default model.
Skip `models.json` if you only want the defaults without the custom local providers.

#### Themes

Custom pi themes (Dusk + Dawn):

```sh
mkdir -p ~/.pi/agent/themes
cp pi/themes/*.json ~/.pi/agent/themes/
```

#### ZenTUI config

`zentui.json` configures the pi-zentui package — editor style (minimalist),
footer (starship with git branch + cost), working-line spinner messages, and
the purple accent color scheme.

#### MCP servers

`mcp.json` wires up the `agi` (local agi-mcp command) and `discode` (remote
StackOne endpoint) MCP servers.

#### Rounded tool-call frames (optional)

A pi extension that restyles the built-in tool-call boxes (`read`, `bash`,
`edit`, `write`, `find`, `grep`, `ls`) into a single rounded frame:

- **blue border** while the tool is running → **grey border** when complete
- sits on the normal terminal background (no dark fill)
- `edit` / `write` show a colorized diff + a `+added / -removed` tally
- `bash` shows the command + an output slice (expand with **ctrl+o**)

```sh
mkdir -p ~/.pi/agent/extensions
cp pi/extensions/rounded-frames.ts ~/.pi/agent/extensions/
```

Then restart pi (or run `/reload`). To remove it, delete that file and restart —
or run `bash ~/.pi/agent/extensions/reset-pi.sh` to clear all custom extensions.

#### AGI Graph panel (optional)

A right-side overlay panel showing live agent roles, working state, and a
permissions matrix (`/agi` to toggle, `/agi m` for matrix, `/agi c` for live):

```sh
mkdir -p ~/.pi/agent/extensions/agi-graph
cp pi/extensions/agi-graph/index.ts pi/extensions/agi-graph/rollback.sh ~/.pi/agent/extensions/agi-graph/
```

## File locations

| File | Install path |
|------|-------------|
| `themes/dusk-mode.json` | `~/.config/zed/themes/dusk-mode.json` |
| `themes/onedark-deeper.json` | `~/.config/zed/themes/onedark-deeper.json` |
| `themes/dawn.json` | `~/.config/zed/themes/dawn.json` |
| `zed/keymap.json` | `~/.config/zed/keymap.json` |
| `claude-code-theme.json` | `~/.claude/themes/dusk.json` |
| `iterm2/dusk.json` | `~/Library/Application Support/iTerm2/DynamicProfiles/dusk.json` |
| `iterm2/dawn.json` | `~/Library/Application Support/iTerm2/DynamicProfiles/dawn.json` |
| `iterm2/default.json` | `~/Library/Application Support/iTerm2/DynamicProfiles/default.json` |
| `iterm2/global-settings.json` | `defaults import com.googlecode.iterm2` |
| `pi/settings.json` | `~/.pi/agent/settings.json` |
| `pi/models.json` | `~/.pi/agent/models.json` |
| `pi/mcp.json` | `~/.pi/agent/mcp.json` |
| `pi/zentui.json` | `~/.pi/agent/zentui.json` |
| `pi/themes/dusk.json` | `~/.pi/agent/themes/dusk.json` |
| `pi/themes/dawn.json` | `~/.pi/agent/themes/dawn.json` |
| `pi/extensions/rounded-frames.ts` | `~/.pi/agent/extensions/rounded-frames.ts` |
| `pi/extensions/reset-pi.sh` | `~/.pi/agent/extensions/reset-pi.sh` |
| `pi/extensions/agi-graph/index.ts` | `~/.pi/agent/extensions/agi-graph/index.ts` |
| `pi/extensions/agi-graph/rollback.sh` | `~/.pi/agent/extensions/agi-graph/rollback.sh` |
