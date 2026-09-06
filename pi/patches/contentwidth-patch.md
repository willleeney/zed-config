# Pi TUI contentWidth Patch

Adds a `terminal.contentWidth` setting to pi that caps the rendered content width.
Tested on pi v0.84.4. The main TUI chunk filename changes per version (content-hash).

Find the right chunk: it's the largest `.js` file in `dist/bundle/chunks/` (~3.7 MB).

```
ls -lS $(volta which pi | xargs dirname)/../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/*.js | head -3
```

There are 6 patches applied in order. Each shows a SEARCH string and a REPLACE string.

---

## Patch 1: Add `contentWidth` property to TuiBase class

**Search:**
```
var TuiBase=class _TuiBase extends Container{terminal;focusedComponent
```

**Replace:**
```
var TuiBase=class _TuiBase extends Container{terminal;contentWidth;focusedComponent
```

---

## Patch 2: Add `effectiveColumns()` and `setContentWidth()` methods to TuiBase

Insert after the `overlayFocusRestore` line, before the constructor.

**Search:**
```
overlayFocusRestore={status:"inactive"};constructor(terminal,showHardwareCursor,logDirectory)
```

**Replace:**
```
overlayFocusRestore={status:"inactive"};effectiveColumns(){let full=Math.max(1,this.terminal.columns);return typeof this.contentWidth=="number"&&Number.isFinite(this.contentWidth)?Math.max(1,Math.min(full,Math.floor(this.contentWidth))):full}setContentWidth(width){this.contentWidth=typeof width=="number"&&Number.isFinite(width)?Math.max(1,Math.floor(width)):void 0,this.requestRender()}constructor(terminal,showHardwareCursor,logDirectory,options)
```

---

## Patch 3: Wire `contentWidth` in TuiBase constructor

**Search:**
```
super(),this.terminal=terminal,this.logDirectory=logDirectory??process.env.PI_CODING_AGENT_DIR??path.join(os2.homedir(),".pi","agent"),showHardwareCursor!==void 0&&(this.showHardwareCursor=showHardwareCursor)}
```

**Replace:**
```
super(),this.terminal=terminal,this.logDirectory=logDirectory,this.contentWidth=options?.contentWidth,showHardwareCursor!==void 0&&(this.showHardwareCursor=showHardwareCursor)}
```

Note: the clean version inlines the default logDirectory; the patch simplifies it since logDirectory is always passed explicitly by callers. If a future version changes this, keep the fallback but add `this.contentWidth=options?.contentWidth,` after setting logDirectory.

---

## Patch 4: Add `getContentWidth()` to the settings manager

Insert between `this.save()}` (end of `setImageWidthCells`) and `getClearOnShrink()`.

**Search:**
```
this.save()}getClearOnShrink()
```

**Replace:**
```
this.save()}getContentWidth(){let width=this.settings.terminal?.contentWidth;if(!(typeof width!="number"||!Number.isFinite(width)))return Math.max(1,Math.floor(width))}getClearOnShrink()
```

---

## Patch 5: Pass `contentWidth` from settings into the TUI constructor (2 sites)

There are two call sites that create the TUI renderer (initial + recreate on mode switch). Both end with `getFullscreenCopyOnSelect()})`.

**Search (both occurrences):**
```
getFullscreenCopyOnSelect()})
```

**Replace (both occurrences):**
```
getFullscreenCopyOnSelect(),contentWidth:this.settingsManager.getContentWidth()})
```

---

## Patch 6: Replace `this.terminal.columns` with `this.effectiveColumns()` in render paths (3 sites)

### 6a. TuiMainScreen.doRender

**Search:**
```
doRender(){if(this.stopped)return;let width=this.terminal.columns,height=this.terminal.rows
```

**Replace:**
```
doRender(){if(this.stopped)return;let width=this.effectiveColumns(),height=this.terminal.rows
```

### 6b. TuiAltScreen.doRender

**Search:**
```
doRender(){if(this.stopped||!this.altScreenActive)return;let width=Math.max(1,this.terminal.columns),height
```

**Replace:**
```
doRender(){if(this.stopped||!this.altScreenActive)return;let width=this.effectiveColumns(),height
```

### 6c. Document render (non-interactive mode)

**Search:**
```
else{let width=Math.max(1,this.terminal.columns),documentLines=this.render(width)
```

**Replace:**
```
else{let width=this.effectiveColumns(),documentLines=this.render(width)
```

---

## Patch 7: Forward `contentWidth` through the factory function

### 7a. TuiAltScreen creation

**Search:**
```
copySelection:async text=>{try{return await copyToClipboard(text),!0}catch{return!1}}})}return new TuiMainScreen(terminal,options.showHardwareCursor,options.logDirectory)}
```

**Replace:**
```
copySelection:async text=>{try{return await copyToClipboard(text),!0}catch{return!1}},contentWidth:options.contentWidth})}return new TuiMainScreen(terminal,options.showHardwareCursor,options.logDirectory,{contentWidth:options.contentWidth})}
```

---

## Settings

In `~/.pi/agent/settings.json`, add:

```json
{
  "terminal": {
    "contentWidth": 160
  }
}
```

Omit or remove to use the full terminal width (default behavior).
