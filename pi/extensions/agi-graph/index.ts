/**
 * agi-graph · Agent Graph Interface — a RIGHT-SIDE live panel inside pi.
 *
 * Built ONE STEP AT A TIME. Each step must, on its own:
 *   1. load without error, and
 *   2. leave pi fully launchable.
 * If a step ever breaks launch:
 *   bash ~/.pi/agent/extensions/agi-graph/rollback.sh restore step-2-inline   (then /reload)
 *   ...or nuclear: bash ~/.pi/agent/extensions/reset-pi.sh
 *
 * ── STEP LOG ─────────────────────────────────────────────────────────────
 * step-1  smoke test (notify + /agi).
 * step-2  static matrix, rendered in-line (appendEntry + registerEntryRenderer).
 * step-3  RIGHT-SIDE live panel — technique cloned from @aiwayds/pi-sidebar-panel:
 *          a top-right, non-capturing overlay (so the editor keeps focus),
 *          refreshed on an interval, hidden on narrow terminals.
 *          · COMPACT LIVE VIEW (default): roles + live ● working pulse + phase.
 *          · MATRIX mode: the "who can call what" grid, same right-side panel.
 *          Live state comes from tool_execution_* / turn_* / agent_end events.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Commands:
 *   /agi        toggle the right-side panel
 *   /agi on     show          /agi off   hide
 *   /agi m      switch the panel to MATRIX mode
 *   /agi c      switch the panel to COMPACT (live) mode
 *   /agi full   drop a full-width matrix IN-LINE in the transcript
 *
 * The right-side panel is an overlay (not a widget): pi widgets only support
 * above/below the editor. The overlay is `nonCapturing` + unfocused, so it
 * never steals keyboard focus from the editor — it just sits on the right.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── static graph (permissions attach to the ROLE, not an instance) ─────
type Cap = "msg" | "see" | "fire" | "cut" | null;
type TColor =
  | "accent" | "success" | "warning" | "error" | "muted" | "dim" | "text" | "toolTitle" | "border";

interface Role { id: string; name: string; label: string; color: TColor; }

const ROLES: Role[] = [
  { id: "orch",     name: "orch",  label: "◆ orchestrator", color: "accent" },
  { id: "coder",    name: "coder", label: "● coder",        color: "toolTitle" },
  { id: "reviewer", name: "rev",   label: "○ reviewer",     color: "muted" },
  { id: "scout",    name: "scout", label: "○ scout",        color: "muted" },
  { id: "explore",  name: "exp",   label: "◇ explore",      color: "dim" },
];

const MATRIX: Record<string, Record<string, Cap>> = {
  orch:     { coder: "msg", reviewer: "msg", scout: "msg" },
  coder:    { explore: "msg" },
  reviewer: { coder: "see" },
  scout:    { explore: "fire" },
  explore:  {},
};
const CAP_GLYPH: Record<Exclude<Cap, null>, string> = { msg: "▸", see: "◉", fire: "⚡", cut: "✂" };
const CAP_COLOR: Record<Exclude<Cap, null>, TColor> = { msg: "accent", see: "success", fire: "warning", cut: "error" };

// Map a tool name to a role (best-effort; real wiring later).
function toolRole(toolName: string): string {
  const t = toolName.toLowerCase();
  if (t === "write" || t === "edit" || t === "bash") return "coder";
  if (t === "read" || t === "grep" || t === "find" || t === "ls") return "explore";
  return "orch";
}

// ── live state ──────────────────────────────────────────────────────────
interface LiveState {
  mode: "compact" | "matrix";
  working: Record<string, number>;  // roleId -> startMs
  phase: string;
  tools: number;                    // tools run this session
  tokens: number | null;
  cost: number | null;
}
const live: LiveState = {
  mode: "compact",
  working: {},
  phase: "idle",
  tools: 0,
  tokens: null,
  cost: null,
};

// ── render: COMPACT live view ──────────────────────────────────────────
function renderCompact(theme: Theme, innerW: number): string[] {
  const t = (s: string) => truncateToWidth(s, innerW, "…", true);
  const L: string[] = [];
  L.push(t(theme.bold(theme.fg("accent", " AGI ")) + theme.fg("dim", " live")));
  L.push(t(theme.fg("dim", " roles")));
  for (const r of ROLES) {
    const w = live.working[r.id];
    const marker = w ? theme.fg("success", "●") + " " : "  ";
    const name = theme.fg(r.color, r.label);
    const status = w
      ? " " + theme.fg("success", `working ${((Date.now() - w) / 1000).toFixed(0)}s`)
      : " " + theme.fg("dim", "idle");
    L.push(t(marker + name + status));
  }
  const tok = live.tokens != null ? theme.fg("dim", `  ${Math.round(live.tokens).toLocaleString()} tok`) : "";
  const cost = live.cost != null ? theme.fg("dim", ` $${live.cost.toFixed(4)}`) : "";
  L.push(t(theme.fg("dim", `  ${live.phase}`) + (live.tools ? theme.fg("dim", ` · ${live.tools} tools`) : "") + tok + cost));
  L.push(t(theme.fg("dim", "  /agi m matrix  /agi c live")));
  return L;
}

// ── render: MATRIX ("who can call what") ───────────────────────────────
function renderMatrix(theme: Theme, innerW: number): string[] {
  const t = (s: string) => truncateToWidth(s, innerW, "", true);
  const COL = 7, ROWW = 8;
  const L: string[] = [];
  L.push(t(theme.bold(theme.fg("accent", " AGI ")) + theme.fg("dim", " who→can→call→what")));
  L.push(t(theme.fg("dim", "  who".padEnd(ROWW)) + ROLES.map((r) => theme.fg("dim", r.name.toUpperCase().padEnd(COL))).join("")));
  L.push(t(theme.fg("dim", "─".repeat(ROWW + ROLES.length * COL))));
  for (const from of ROLES) {
    let row = theme.fg(from.color, from.label.slice(0, ROWW).padEnd(ROWW));
    for (const to of ROLES) {
      const cap: Cap = from.id === to.id ? null : MATRIX[from.id]?.[to.id] ?? null;
      const cell = cap ? CAP_GLYPH[cap] : "·";
      const styled = cap ? theme.fg(CAP_COLOR[cap], cell) : theme.fg("dim", cell);
      // pad with plain spaces (not ANSI) so truncation stays honest
      row += " " + styled + " ".repeat(Math.max(0, COL - 2));
    }
    L.push(t(row));
  }
  L.push(t(theme.fg("dim", "▸msg ◉see ⚡fire ✂cut ·none")));
  L.push(t(theme.fg("dim", "  /agi c back to live")));
  return L;
}

// ── the right-side panel component ────────────────────────────────────
class AgiPanel implements Component {
  private theme: Theme;
  constructor(private tui: TUI, theme: Theme) { this.theme = theme; }

  render(width: number): string[] {
    const th = this.theme;
    const innerW = Math.max(1, width - 2);
    const border = (c: string) => th.fg("border", c);
    const bg = (s: string) => th.bg("customMessageBg", s); // OPAQUE fill → hides chat behind the panel
    // build a row, then force it to exactly `width` cols so every pixel is covered
    const solid = (s: string) => {
      const stripped = s; // assume styled width == visible width here
      const vw = visibleWidth(stripped);
      const pad = Math.max(0, width - vw);
      return bg(stripped + " ".repeat(pad));
    };
    const entry = (s: string) => solid(border("│") + truncateToWidth(s, innerW, "…", true) + border("│"));
    const lines: string[] = [];
    lines.push(solid(border(`╭${"─".repeat(innerW)}╮`)));
    lines.push(entry(live.mode === "matrix" ? themeTitle(th, "MATRIX") : themeTitle(th, "LIVE")));
    lines.push(solid(border("├" + "─".repeat(innerW) + "┤")));
    const body = live.mode === "matrix" ? renderMatrix(th, innerW) : renderCompact(th, innerW);
    for (const ln of body) lines.push(entry(ln));
    lines.push(solid(border("╰" + "─".repeat(innerW) + "╯")));
    return lines;
  }
  invalidate(): void {}
  dispose(): void {}
}
function themeTitle(th: Theme, s: string): string { return th.bold(th.fg("accent", " " + s)); }

// ── panel lifecycle (cloned from pi-sidebar-panel) ─────────────────────
const PANEL_WIDTH = 28;
const MIN_TERM_WIDTH = 62;   // show as soon as there's room: panel + a readable main column
let panelEnabled = false;
let panelActive = false;
let panelHandle: OverlayHandle | null = null;
let panelTui: TUI | null = null;
let panelDone: (() => void) | null = null;
let panelInterval: ReturnType<typeof setInterval> | null = null;
let didStartupClear = false;

function startPanel(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (ctx.mode !== "tui" || panelActive) return;
  ctx.ui.custom(
    (tui, theme, _kb, done) => {
      panelActive = true;
      panelDone = done as () => void;
      panelTui = tui;
      if (!didStartupClear) { didStartupClear = true; tui.requestRender(true); }
      if (panelInterval) clearInterval(panelInterval);
      panelInterval = setInterval(() => { if (panelActive) tui.requestRender(); }, 1000);
      return new AgiPanel(tui, theme);
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-right",
        offsetX: -1,
        offsetY: 1,
        width: PANEL_WIDTH,
        maxHeight: "100%",
        nonCapturing: true,
        visible: (termWidth) => termWidth >= MIN_TERM_WIDTH,
      },
      onHandle: (handle) => { panelHandle = handle; handle.unfocus(); },
    },
  );
}

function resetPanelState(): void {
  panelActive = false;
  panelTui = null;
  if (panelInterval) { clearInterval(panelInterval); panelInterval = null; }
  panelHandle = null;
  panelDone = null;
}

function stopPanel(): void {
  panelActive = false;
  panelTui = null;
  if (panelInterval) { clearInterval(panelInterval); panelInterval = null; }
  if (panelHandle) { try { panelHandle.hide(); } catch { /* dead handle */ } panelHandle = null; }
  if (panelDone) { try { (panelDone as () => void)(); } catch { /* already gone */ } panelDone = null; }
}

// ── live event wiring ──────────────────────────────────────────────────
function bindEvents(pi: ExtensionAPI) {
  pi.on("tool_execution_start", async (e, ctx) => {
    if (ctx.mode !== "tui") return;
    const role = toolRole(e.toolName);
    if (!live.working[role]) live.working[role] = Date.now();
    live.phase = `act · ${role}`;
  });
  pi.on("tool_execution_end", async (e, ctx) => {
    if (ctx.mode !== "tui") return;
    const role = toolRole(e.toolName);
    delete live.working[role];
    live.tools += 1;
    live.phase = "act";
  });
  pi.on("turn_start", async (_e, ctx) => { if (ctx.mode === "tui") live.phase = "plan"; });
  pi.on("turn_end", async (_e, ctx) => { if (ctx.mode === "tui" && Object.keys(live.working).length === 0) live.phase = "observe"; });
  pi.on("agent_end", async (e, ctx) => {
    if (ctx.mode !== "tui") return;
    live.tokens = e.message?.usage?.totalTokens ?? live.tokens;
    live.cost = e.message?.usage?.cost?.total ?? live.cost;
    live.phase = "observe";
  });
}

// ── extension ──────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  bindEvents(pi);

  pi.on("session_start", async (_e, ctx) => {
    if (ctx.mode !== "tui") return; // never touch state from sub-agent/print sessions
    if (!panelEnabled) return;
    resetPanelState();          // stale handle from a previous in-process session
    startPanel(pi, ctx);
  });

  pi.on("session_shutdown", async (_e, ctx) => {
    if (ctx.mode !== "tui") return;
    try { stopPanel(); } catch { resetPanelState(); }
  });

  pi.registerCommand("agi", {
    description: "AGI agent-graph right-side panel (live + matrix). Args: on|off|m|c|full|status",
    handler: async (args, ctx) => {
      const a = (args || "").trim();
      const notify = (m: string, s: "info" | "warning" | "error" = "info") => ctx.ui.notify(m, s);

      if (a === "full") {
        // Full-width matrix IN-LINE (works even on narrow terminals).
        if (ctx.hasUI) pi.appendEntry("agi-graph", { ts: Date.now(), full: true });
        else notify("agi full: needs interactive terminal", "warning");
        return;
      }

      if (ctx.mode !== "tui") { notify("agi: right-side panel needs interactive terminal", "warning"); return; }

      if (a === "m")  { live.mode = "matrix";  panelTui?.requestRender(); notify("AGI: matrix mode"); return; }
      if (a === "c")  { live.mode = "compact"; panelTui?.requestRender(); notify("AGI: live mode");  return; }

      if (a === "on")    { panelEnabled = true;  startPanel(pi, ctx); notify("AGI: panel on");  return; }
      if (a === "off")   { panelEnabled = false; stopPanel();         notify("AGI: panel off"); return; }
      if (a === "status"){ notify(`AGI: ${panelEnabled ? "on" : "off"} · ${live.mode}`); return; }

      // default: toggle
      panelEnabled = !panelEnabled;
      if (panelEnabled) startPanel(pi, ctx); else stopPanel();
      notify(`AGI: panel ${panelEnabled ? "on" : "off"}`);
    },
  });

  // /agi full renders the entry in-line as a full-width matrix.
  pi.registerEntryRenderer("agi-graph", (_entry, _opts, theme) => {
    const lines = renderMatrix(theme, 120);
    return {
      invalidate() {}, dispose() {},
      render: () => lines,
    } as Component;
  });
}
