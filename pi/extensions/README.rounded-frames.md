# rounded-frames

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
const factory = await jiti.import(process.env.HOME + '/.pi/agent/extensions/rounded-frames.ts', { default: true });
const tools = [];
factory({ registerTool: (t) => tools.push(t) });
// e.g. await tools.find(t => t.name === 'write').execute('id', { path: '/tmp/x', content: 'a\n' }, new AbortController().signal)
// then call .renderResult(result, { expanded: false, isPartial: false }, fakeTheme, { args }) and .render(200)
```

## Files & backups

- Extension: `~/.pi/agent/extensions/rounded-frames.ts`
- The editor auto-creates backups in `~/.pi/agent/extensions/.backups/`
  (`rounded-frames.<timestamp>.ts`) — diff against the latest backup to see
  what a session changed.
- Restart pi (or `/reload`) to pick up edits.
