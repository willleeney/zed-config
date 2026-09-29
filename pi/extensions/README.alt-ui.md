# alt-ui

Pi extension that restyles the built-in tool-call boxes (bash, edit, read, write,
find, grep, ls) with a one-line rounded border:

```
╭ write ─────────────────────────────────────────────╮
│ /tmp/demo.txt                                      │
│                                                    │
│  1 line one                                        │
│ -2 line two                                        │
│ +2 LINE TWO (modified)                             │
│ +3 / -1 lines                                      │
╰────────────────────────────────────────────────────╯
```

## How it works

Each built-in tool is **re-registered under the same name** via `pi.registerTool`:

- `execute()` delegates to the original tool (built with `create*Tool(CWD)`)
  so behaviour is unchanged — except `write`, which is wrapped to add a diff
  (see "write diff" below).
- `renderShell: "self"` — pi drops its default box; `renderCall` /
  `renderResult` return our own `RoundedFrame` component (or an empty
  `Container` while the result is pending, so exactly one box is visible).
- `RoundedFrame.paint(width)` builds every line padded to the **full** width
  and truncates with `truncateToWidth` — lines can never overflow the
  terminal. (An older monkey-patch version wrapped pi's already-full-width
  lines and crashed with "rendered line exceeds terminal width".)

## Gotchas a future editor must respect

1. **`theme.fg` / `theme.bg` THROW on unknown color names.** Every render
   function wraps them in a local `fg()` try/catch fallback. Never call
   `theme.fg` bare inside a render path — a throw makes pi silently drop the
   whole box (the historical "box disappeared" bug).

2. **No background override on the complete box.** With `renderShell: "self"`
   pi's shell already fills the tool region with the message surface. The old
   code painted a hardcoded `#202123` (bgHex) over it, which looked darker
   than the in-progress box. `RoundedFrame` still *supports* `bgHex` (the
   constructor param), but it is not passed — leave it that way unless you
   know why.

3. **`write` has no native diff.** Pi's stock write tool returns
   `details: undefined`; only edit returns `details.diff`. The extension
   compensates in the `execute` override: it reads the file's pre-write
   content (empty string for new files), delegates to the original execute,
   then attaches `generateDiffString(old, new)` (the same function pi's edit
   tool uses, exported from `@earendil-works/pi-coding-agent`) as
   `result.details.diff`. `formatResult` then renders write identically to
   edit (colorized lines, 24-line collapse, `+N / -N lines` tally).

4. **Do NOT wrap the write delegate in `withFileMutationQueue`.** The
   original write tool already serializes through pi's internal file-mutation
   queue. Wrapping again means the wrapper's registration waits on a queue
   that the inner execute is still holding → deadlock (execute never
   resolves). This was tried and removed.

5. **One `case "write": { ... }` block feeds three render paths.** When
   expanding (ctrl+o), bash/edit/write show their full content natively, so
   the generic "raw output when expanded" tail must keep excluding all three
   (`name !== "bash" && name !== "edit" && name !== "write"`) or the output
   is printed twice.

6. **`renderCall` returns an empty `Container` when `!context.isPartial`.**
   Both call and result components are always rendered; the empty call box is
   how exactly one visible box is achieved once the tool finishes.

7. **`resolvePath()` is a local re-implementation of pi's internal
   `resolveToCwd`** (absolute passthrough, otherwise resolve against `CWD`).
   It exists only because pi doesn't export the real one.

## Testing

The extension can be smoke-tested by loading it through pi's own jiti loader
with the same aliases pi uses (pi-tui is a workspace dep, not a standalone
npm package, so a plain `node` import of the package root won't resolve it):

```js
// run from inside node_modules/@earendil-works/pi-coding-agent
import { createJiti } from 'jiti/static';
import path from 'node:path';
import fs from 'node:fs';
const d = path.resolve(import.meta.dirname, 'dist/core/extensions');
const rw = (rel, spec) => { const p = path.join(path.resolve(d, '../../../../'), rel); return fs.existsSync(p) ? p : import.meta.resolve(spec); };
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    '@earendil-works/pi-coding-agent': path.resolve(d, '../..', 'index.js'),
    '@earendil-works/pi-agent-core': rw('agent/dist/index.js', '@earendil-works/pi-agent-core'),
    '@earendil-works/pi-tui': rw('tui/dist/index.js', '@earendil-works/pi-tui'),
  },
});
const factory = await jiti.import(process.env.HOME + '/.pi/agent-dev/extensions/alt-ui.ts', { default: true });
const tools = [];
factory({ registerTool: (t) => tools.push(t) });
// e.g. await tools.find(t => t.name === 'write').execute('id', { path: '/tmp/x', content: 'a\n' }, new AbortController().signal)
// then call .renderResult(result, { expanded: false, isPartial: false }, fakeTheme, { args }) and .render(200)
```

## Background tasks (bundled pi-bg-tasks)

`lib/bg-tasks/` is a copy of [pi-bg-tasks](https://github.com/cyzlmh/pi-extensions/tree/main/pi-bg-tasks)
0.1.4 (MIT, licence alongside), minus its tests. Pi only auto-loads
`extensions/*.ts` and `extensions/*/index.ts`, so `lib/` is never loaded on its
own; alt-ui imports it.

- **`bash` is bg-tasks' tool, in alt-ui's frame.** alt-ui calls bg-tasks with a
  `Proxy` of `pi` that keeps back the `bash` registration, then registers it
  itself (execute / params / prompt guidelines from bg-tasks, renderers from
  alt-ui). Everything else bg-tasks registers (`bg_list`, `bg_output`,
  `bg_stop`, ctrl+shift+b, `/bg`, `/bg-tasks`, hooks) goes straight to pi.
  Its `bg-task-notification` renderer is swapped for alt-ui's (indented, blue on
  success, red otherwise). **Never install the `pi-bg-tasks` npm package as
  well** — two `bash` registrations and pi won't start.
- **Frame title:** a backgrounded call shows `bash · ◷ <reason> · <task id>` in
  the title bar (parsed from bg-tasks' result text, see `parseBgHandoff`).
- **Dock:** one line, `▶ ⠹ background tasks`, appended to the TUI root *after*
  zentui's footer (widgets can only go above/below the editor). An empty
  below-editor widget exists only to hand over the TUI; a 100ms timer keeps the
  line last and animates the spinner (zentui's braille frames) while jobs run.
  Dim when idle. ↓ on an empty prompt selects it (only the `▶` turns blue, the
  editor's fake cursor is hidden via an `Editor.prototype.render` hook), enter
  opens `BgTasksView` in place of the editor: tasks by start time with start
  time, `◷ duration` and status; enter shows a task's live log; esc steps back.
- **Edits to the vendored copy** are limited to `lib/bg-tasks/ui.ts`, marked
  `alt-ui`: `jobsChangedListeners` (called from `renderStatusPill` on every job
  state change) and skipping the footer status pill while alt-ui listens.
  Re-apply those two if you update the copy.
- Prototype hooks that read module state must re-install on every load
  (`__altUiOrigRender`), otherwise after `/reload` they read a stale module.

## Files & backups

- Extension: `~/.pi/agent-dev/extensions/alt-ui.ts`
- The editor auto-creates backups in `~/.pi/agent-dev/extensions/.backups/`
  (`alt-ui.<timestamp>.ts` (older backups keep the `rounded-frames.` prefix)) — diff against the latest backup to see
  what a session changed.
- Restart pi (or `/reload`) to pick up edits.
