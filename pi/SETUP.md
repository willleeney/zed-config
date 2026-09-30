# My pi setup (Claude via meridian, with a custom UI)

pi is a terminal coding agent (https://pi.dev). I run it against my Claude
subscription through **meridian**, a small local proxy, and I've added a UI
extension (alt-ui) with background bash tasks and subagents.

## 1. Install pi and meridian

Needs Node 22+.

```sh
npm install -g @earendil-works/pi-coding-agent @rynfar/meridian
```

## 2. Set up meridian (Claude subscription → local API)

```sh
meridian setup      # one-time client setup
meridian profile    # add/log in a Claude account (see `meridian profile --help`)
meridian            # start the proxy; leave it running (http://127.0.0.1:3456)
```

Optional plugin I use, which tidies pi's requests before they reach Claude:

```sh
cd ~/.config/meridian && npm install @rynfar/meridian-plugin-pi-scrub
```

Then enable it in `~/.config/meridian/plugins.json`:

```json
{ "plugins": [ { "path": "~/.config/meridian/node_modules/@rynfar/meridian-plugin-pi-scrub/dist/index.js", "enabled": true } ] }
```

Use the full absolute path in `"path"`.

## 3. Point pi at meridian

Create `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "http://127.0.0.1:3456",
      "apiKey": "x",
      "headers": {
        "x-meridian-agent": "pi",
        "x-opencode-thinking": "{\"type\":\"adaptive\",\"display\":\"summarized\"}"
      },
      "compat": {
        "sendSessionAffinityHeaders": true,
        "supportsLongCacheRetention": true
      },
      "models": [
        {
          "id": "claude-opus-5-5",
          "name": "Claude Opus 5.5",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 15, "output": 75, "cacheRead": 1.5, "cacheWrite": 18.75 },
          "contextWindow": 2000000,
          "maxTokens": 128000,
          "thinkingLevelMap": { "xhigh": "xhigh", "max": "max" },
          "compat": { "forceAdaptiveThinking": true }
        }
      ]
    }
  }
}
```

`apiKey` is just a placeholder, because meridian handles auth.

## 4. Settings, look and feel

```sh
git clone https://github.com/willleeney/zed-config.git
cd zed-config/pi
mkdir -p ~/.pi/agent/themes ~/.pi/agent/extensions
cp settings.json zentui.json ~/.pi/agent/
cp themes/*.json ~/.pi/agent/themes/
cp extensions/alt-ui.ts ~/.pi/agent/extensions/
cp -R extensions/lib ~/.pi/agent/extensions/
```

`settings.json` installs these packages on first start: pi-zentui (editor,
footer, thinking display), pi-cc-header (startup banner) and pi-mcp-adapter
(MCP support). It also makes Claude Opus 5.5 the default model.

Don't also install the `pi-bg-tasks` or `pi-subagents-lite` npm packages.
alt-ui already bundles both, and a second copy stops pi from starting.

## 5. Run it

With `meridian` running in another terminal:

```sh
pi
```

## What you get

- **Rounded tool frames:** every tool call is in a rounded box, and edits and
  writes show a diff. Press ctrl+o to expand output.
- **Background bash:** long commands move to the background automatically after
  120s, or when you press ctrl+shift+b. The model can also start them in the
  background itself.
- **Subagents:** the model can hand work off to agents that always run in the
  background.
- **Dock under the footer:** two lines, `▶ background tasks` and `▶ subagents`,
  with a spinner while something runs.
  - Press ↓ to select a line and Enter to open its list.
  - Enter on a task shows its live output. Enter on a subagent opens it in the
    main window, where you can type to steer it.
  - `x` stops a subagent, and Esc goes back.
