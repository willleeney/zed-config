/**
 * alt-ui.ts
 *
 * Note: This file replaces the old rounded-frames.ts extension.
 *
 * Restyles tool-call boxes with rounded frames:
 *   - renderShell:"self"  → pi drops its default Box (toolPendingBg), so the
 *     tool call sits on the terminal's *standard* background instead of a
 *     solid black/colored fill.
 *   - A one-line rounded title bar  ╭─ read ─────╮  in the border color, with
 *     the tool name in the accent color, plus a matching bottom bar  ╰───╯.
 *   - Built-ins (bash, edit, read, write, find, grep, ls) get specialized
 *     diffs, status badges and output formatting.
 *   - Non-built-in tools (StackOne execute_action, search_actions, list_accounts,
 *     MCP tools) are intercepted and formatted into the same rounded frame style!
 *   - bash is pi-bg-tasks' override (vendored in ./lib/bg-tasks): run_in_background,
 *     auto-background at timeout, Ctrl+Shift+B, bg_list/bg_output/bg_stop.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	generateDiffString,
	ToolExecutionComponent,
	AssistantMessageComponent,
	CustomMessageComponent,
	InteractiveMode,
	UserMessageComponent,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Container, Editor, Markdown, Spacer, Text, visibleWidth, truncateToWidth, matchesKey, isKeyRelease } from "@earendil-works/pi-tui";
import bgTasks from "./lib/bg-tasks/index.ts";
import { jobsChangedListeners } from "./lib/bg-tasks/ui.ts";
import { readLogTail, type BgRegistry } from "./lib/bg-tasks/registry.ts";
import type { BgJob } from "./lib/bg-tasks/types.ts";
import subagentsLite from "./lib/subagents-lite/index.ts";
import { altUiHooks, getManager as getAgentManager, getStore as getSubagentsStore } from "./lib/subagents-lite/shell.ts";
import type { AgentRecord } from "./lib/subagents-lite/types.ts";


// ── Configuration ────────────────────────────────────────────────────────────
export const ALT_UI_CONFIG = {
	// Colors to use for successful / settled tool calls
	successBorder: "borderAccent", // The border color when a tool finishes successfully
	successTitle: "accent",        // The tool name color when a tool finishes successfully
	successArgs: "accent",         // The color of the tool arguments when successful

	// Colors to use when a tool is actively running
	runningBorder: "borderAccent", // The border color while running (will pulse)
	runningTitle: "accent",        // The tool name color while running
	runningArgs: "accent",         // The color of the tool arguments while running

	// Colors to use when a tool call fails or aborts
	errorBorder: "error",          // The border color on failure
	errorTitle: "error",           // The tool name color on failure
	errorArgs: "text",             // The color of the tool arguments on failure (plain white/default)

	// Custom (extension) messages: zentui "labeled" user-message box, in grey
	messageBorder: "#5a5d63",      // Hex border colour (matches zentui editorBorder)
	messageLabel: "muted",         // Theme colour for the label in the top border
	messageText: "customMessageText",
};

const CWD = process.cwd();

/** Minimal replacement for pi's internal resolveToCwd (not publicly exported). */
function resolvePath(p: string, cwd: string): string {
	return isAbsolute(p) ? p : resolve(cwd, p);
}

function safeFg(theme: Theme, colorName: string, text: string): string {
	try {
		return theme.fg(colorName, text);
	} catch {
		return text;
	}
}

/**
 * The stock write tool reports `details: undefined`, so no diff is available.
 * Read the file (if it exists) BEFORE delegating to the original execute, then
 * compute the same generateDiffString(editContent, writeContent) the edit tool
 * uses, and attach it to the result as details.diff.
 */
async function executeWriteWithDiff(
	path: string,
	content: string,
	execute: any,
	toolCallId: any,
	signal: any,
	onUpdate?: any,
) {
	const absolutePath = resolvePath(path, CWD);
	let oldContent = "";
	try {
		const st = await stat(absolutePath);
		if (st.isFile()) oldContent = await readFile(absolutePath, "utf8");
	} catch {
		oldContent = "";
	}
	const result = await execute(toolCallId, { path, content }, signal, onUpdate);
	if (result && !result.isError && typeof content === "string") {
		try {
			const { diff } = generateDiffString(oldContent, content);
			result.details = { ...(result.details as object | undefined), diff };
		} catch {
			// diff generation failed
		}
	}
	return result;
}

function runningBody(
	name: string,
	theme: Theme,
	state: any,
	args: any,
	partialJson?: string,
): string {
	try {
		if (state) {
			if (args && typeof args === "object") state.args = args;
			if (typeof partialJson === "string" && partialJson.length > 0)
				state.partialJson = partialJson;
		}
		const liveArgs = state?.args ?? args;
		const pj = state?.partialJson ?? partialJson;
		let argText = formatArgs(name, liveArgs, theme);
		if (!argText && name === "bash" && pj) {
			const cmd = partialField(pj, "command");
			if (cmd) argText = formatArgs(name, { command: cmd }, theme);
		}
		return (argText || safeFg(theme, "dim", "…")) + safeFg(theme, "muted", "  (running…)");
	} catch {
		return safeFg(theme, "dim", "…") + safeFg(theme, "muted", "  (running…)");
	}
}

function safeStringify(v: any): string {
	try {
		return v ? JSON.stringify(v) : "";
	} catch {
		return "";
	}
}

function partialField(partialJson: string, field: string): string | null {
	const m = partialJson.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
	if (!m) return null;
	try {
		return JSON.parse(`"${m[1]}"`);
	} catch {
		return m[1];
	}
}

/** Pull the 24-bit RGB back out of a theme colour by sampling its escape code. */
function themeRgb(theme: Theme, name: string): { r: number; g: number; b: number } | null {
	try {
		const m = theme.fg(name, "x").match(/38;2;(\d+);(\d+);(\d+)/);
		if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
	} catch {
		// unknown colour name — caller falls back
	}
	return null;
}

/** How often the in-progress border repaints, and one full bright→dim→bright cycle. */
const PULSE_TICK_MS = 110;
const PULSE_PERIOD_MS = 1400;

/**
 * Tool rows only repaint when something changes, so an animated border needs a
 * timer that calls context.invalidate() (which re-runs the renderers and asks
 * the TUI for a frame). The handle lives on context.state, which pi shares
 * between renderCall and renderResult for a given row.
 */
function startPulse(context: any): void {
	const state = context?.state;
	if (!state || state.__pulseTimer || typeof context?.invalidate !== "function") return;
	const timer = setInterval(() => {
		try {
			context.invalidate();
		} catch {
			stopPulse(context);
		}
	}, PULSE_TICK_MS);
	// Never hold the process open just for an animation.
	(timer as any)?.unref?.();
	state.__pulseTimer = timer;
}

function stopPulse(context: any): void {
	const state = context?.state;
	if (!state?.__pulseTimer) return;
	clearInterval(state.__pulseTimer);
	state.__pulseTimer = undefined;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
	const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
	if (!m) return null;
	const n = parseInt(m[1], 16);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const BUILT_INS: Record<string, (cwd: string) => any> = {
	bash: createBashTool,
	edit: createEditTool,
	read: createReadTool,
	write: createWriteTool,
	find: createFindTool,
	grep: createGrepTool,
	ls: createLsTool,
};

/**
 * A self-contained TUI component that renders `body` inside a rounded
 * frame titled `title`. Implements the Component interface
 * (render / invalidate) and is safe to return from renderCall/renderResult.
 */
class RoundedFrame {
	private title: string;
	private body: string;
	private theme: Theme;
	private borderName: string;
	private titleName: string;
	private pulse: boolean;
	private bgHex?: string;
	private titleSuffix?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		title: string,
		body: string,
		theme: Theme,
		borderName = "border",
		titleName = "accent",
		pulse = false,
		bgHex?: string,
		titleSuffix?: string,
	) {
		this.title = title;
		this.titleSuffix = titleSuffix;
		this.body = body;
		this.theme = theme;
		this.borderName = borderName;
		this.titleName = titleName;
		this.pulse = pulse;
		this.bgHex = bgHex;
	}

	handleInput?(): void {}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (!this.pulse && this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedLines = this.paint(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}

	private paint(width: number): string[] {
		const w = Math.max(10, width);
		const theme = this.theme;
		const fg = (name: string, s: string): string => safeFg(theme, name, s);

		// While a tool is running the border breathes between dim and full
		// brightness of its own colour, so the row reads as "still working".
		let border = (s: string) => fg(this.borderName, s);
		if (this.pulse) {
			const base = themeRgb(theme, this.borderName) ?? { r: 145, g: 180, b: 249 };
			const phase = (Date.now() % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
			const eased = 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI); // 0 → 1 → 0
			const level = 0.4 + 0.6 * eased;
			const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * level)));
			const open = `\x1b[38;2;${ch(base.r)};${ch(base.g)};${ch(base.b)}m`;
			border = (s: string) => `${open}${s}\x1b[39m`;
		}

		let bgOpen = "", bgClose = "";
		if (this.bgHex) {
			const rgb = hexToRgb(this.bgHex);
			if (rgb) {
				bgOpen = `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m`;
				bgClose = "\x1b[49m";
			}
		}
		const applyBg = (s: string) => (bgOpen ? `${bgOpen}${s}${bgClose}` : s);

		const fillLine = (content: string, width: number): string => {
			const clipped = truncateToWidth(content, width);
			const pad = Math.max(0, width - visibleWidth(clipped));
			return applyBg(`${clipped}${" ".repeat(pad)}`);
		};

		// Top: ╭─ title ──────╮
		const label = ` ${fg(this.titleName, this.title)}${this.titleSuffix ?? ""} `;
		const topFill = Math.max(0, w - 3 - visibleWidth(label));
		const top = fillLine(`${border("╭─")}${label}${border("─".repeat(topFill) + "╮")}`, w);
		const lines: string[] = [top];

		// Body: │ content │ (inner padding = 2 cells, budget = w-4)
		const bodyLines = this.body ? this.body.split("\n") : [""];
		for (const raw of bodyLines) {
			const line = truncateToWidth(raw, w - 4);
			const pad = Math.max(0, w - 4 - visibleWidth(line));
			const out = fillLine(`${border("│")} ${line}${" ".repeat(pad)} ${border("│")}`, w);
			lines.push(out);
		}

		// Bottom: ╰───────────╯
		const bottom = fillLine(border(`╰${"─".repeat(Math.max(0, w - 2))}╯`), w);
		lines.push(bottom);
		return lines;
	}
}

// Same shape as zentui's "labeled" user-message style (╭─ Label ───╮ with a
// 1-cell inner pad), but the body is any component so it can wrap Markdown.
class LabeledBox {
	constructor(
		private label: string,
		private body: { render(width: number): string[] },
		private theme: Theme,
		private borderColor: string = ALT_UI_CONFIG.messageBorder,
	) {}

	handleInput?(): void {}

	invalidate(): void {
		(this.body as any).invalidate?.();
	}

	render(width: number): string[] {
		const theme = this.theme;
		// Hex colours are drawn directly; anything else is a theme colour name.
		const rgb = hexToRgb(this.borderColor);
		const border = rgb
			? (s: string) => `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${s}\x1b[39m`
			: (s: string) => safeFg(theme, this.borderColor, s);
		if (width < 9) return this.body.render(Math.max(1, width)).map((l) => truncateToWidth(l, width, ""));

		const contentWidth = width - 4;
		const label = ` ${safeFg(theme, ALT_UI_CONFIG.messageLabel, this.label)} `;
		const topFill = Math.max(0, width - 3 - visibleWidth(label));
		const top = truncateToWidth(`${border("╭─")}${label}${border(`${"─".repeat(topFill)}╮`)}`, width, "");
		const side = (line: string) => {
			const clipped = truncateToWidth(line, contentWidth, "");
			const pad = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
			return `${border("│")} ${clipped}${pad} ${border("│")}`;
		};
		const bottom = border(`╰${"─".repeat(width - 2)}╯`);
		const lines = this.body.render(contentWidth);
		return [top, ...(lines.length ? lines : [""]).map(side), bottom];
	}
}

// ── pi-zentui Thinking (Experimental) tweaks ─────────────────────────────────────
// These replace local edits that used to live in pi-zentui's
// thinking-experimental.ts, so zentui can be updated without losing them:
//   1. Ctrl+O (expanded) shows Pi's native full thinking in every mode, not
//      just "streaming".
//   2. The Tree-mode "Thinking" title uses a solid "│ " connector, not "┆ ".
// Both hook zentui from the outside and degrade to stock zentui if its
// internals change.

// Global Ctrl+O state; setToolsExpanded fans out to every component, and new
// assistant messages must follow it too.
let thinkingExpanded = false;

// zentui keeps its prototype patches in a registry on the patched prototype.
const ZENTUI_PATCH_REGISTRY = Symbol.for("pi-zentui.prototype-patch-registry");
const ZENTUI_THINKING_ADAPTER = "thinking-experimental-update-content";
const ALT_UI_WRAPPED = Symbol.for("alt-ui.zentui-thinking-wrapped");

function ensureZentuiThinkingHooks(instance: any): void {
	try {
		// 1. Wrap zentui's registered updateContent behaviour (not the prototype
		//    method, which zentui checks for displacement). Re-checked every call
		//    because zentui swaps the registration on reinstall.
		const record = (AssistantMessageComponent.prototype as any)[ZENTUI_PATCH_REGISTRY]?.get?.(
			ZENTUI_THINKING_ADAPTER,
		);
		const registration = record?.registration;
		const behavior = registration?.behavior;
		if (typeof behavior === "function" && !behavior[ALT_UI_WRAPPED]) {
			const wrapped = (invocation: { predecessor: Function; receiver: unknown; args: unknown[] }) =>
				thinkingExpanded
					? Reflect.apply(invocation.predecessor, invocation.receiver, invocation.args)
					: behavior(invocation);
			(wrapped as any)[ALT_UI_WRAPPED] = true;
			registration.behavior = wrapped;
		}

		// 2. ThinkingStepsRows isn't reachable by import (zentui is a separate
		//    package instance), so find it from a live child and patch its class.
		//    Checked on every render: after /reload zentui brings a new class.
		if (!instance?.contentContainer) return;
		for (const child of instance.contentContainer.children ?? []) {
			const inner = child?.child ?? child;
			if (inner?.constructor?.name === "ThinkingStepsRows") {
				patchThinkingRows(Object.getPrototypeOf(inner));
				break;
			}
		}
	} catch {
		// zentui internals changed; leave its stock behaviour in place.
	}
}

function patchThinkingRows(proto: any): void {
	if (!proto || proto.__altUiConnectorPatched) return;
	proto.__altUiConnectorPatched = true;
	const origRender = proto.render;
	proto.render = function (width: number) {
		const rows = origRender.call(this, width);
		// Row 0 is "<pad>┆ **Thinking**"; the connector is its first "┆".
		// Skip zentui's native fallback, where row 0 is plain thinking text.
		if (Array.isArray(rows) && typeof rows[0] === "string" && rows[0].includes("Thinking")) {
			rows[0] = rows[0].replace("\u2506", "\u2502"); // "┆" → "│"
		}
		return rows;
	};
}

function messageText(message: { content: string | any[] }): string {
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n");
}

// ── Generic (StackOne / MCP) tool title & arg/result formatting ──────────────

function cleanToolTitle(toolName: string, args: any): string {
	if (args?.action_id && typeof args.action_id === "string") {
		return args.action_id;
	}
	if (toolName.startsWith("stackone_stackone_")) {
		return toolName.slice("stackone_".length);
	}
	if (toolName.startsWith("stackone-dev_stackone_")) {
		return toolName.slice("stackone-dev_".length);
	}
	if (toolName.startsWith("stackone_") || toolName.startsWith("stackone-dev_")) {
		return toolName.replace(/^stackone(-dev)?_/, "");
	}
	if (toolName === "Agent") return `Agent · ${args?.agent || "general-purpose"}`;
	if (toolName === "mcp") {
		if (args?.tool) return `mcp: ${args.tool}`;
		if (args?.search) return "mcp: search";
		if (args?.describe) return `mcp: ${args.describe}`;
		if (args?.action) return `mcp: ${args.action}`;
		return "mcp";
	}
	return toolName;
}

function formatGenericArgs(
	toolName: string,
	args: any,
	theme: Theme,
	argColor = ALT_UI_CONFIG.successArgs,
): string {
	const fg = (c: string, s: string) => safeFg(theme, c, s);
	if (!args || typeof args !== "object") return "";

	// subagents-lite's Agent: "<type>  <description>" instead of raw JSON.
	if (toolName === "Agent") {
		const oneLine = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
		const desc = oneLine(args.description);
		const prompt = oneLine(args.prompt);
		return [desc && fg("text", desc), prompt && fg("dim", prompt)].filter(Boolean).join("\n");
	}

	const actionId = String(args.action_id || toolName);

	// 1. Search queries (brave, web search, search_actions)
	if (args.query?.q) {
		return fg(argColor, `"${args.query.q}"`);
	}
	if (typeof args.query === "string" && args.query) {
		const prov = args.provider ? `  ${fg("dim", `(${args.provider})`)}` : "";
		return `${fg(argColor, `"${args.query}"`)}${prov}`;
	}

	// 2. Parallel / multi queries
	if (Array.isArray(args.body?.search_queries)) {
		return fg(argColor, args.body.search_queries.map((q: string) => `"${q}"`).join(", "));
	}
	if (Array.isArray(args.body?.urls)) {
		return fg(argColor, args.body.urls.slice(0, 2).join(", "));
	}

	// 3. Named entity / title / summary in body
	if (args.body && typeof args.body === "object") {
		const prominent = args.body.title || args.body.name || args.body.query || args.body.objective;
		if (prominent && typeof prominent === "string") {
			return fg(argColor, `"${prominent}"`);
		}
	}

	// 4. Path parameter (ID)
	if (args.path && typeof args.path === "object") {
		const id = args.path.id || args.path.key || Object.values(args.path)[0];
		if (id) return fg(argColor, `id: ${id}`);
	}

	// 5. General args (filter out internal plumbing)
	const filtered: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(args)) {
		if (k === "session_id" || k === "stackone_account_id" || k === "action_id") continue;
		if (v !== undefined && v !== null && v !== "") filtered[k] = v;
	}
	const keys = Object.keys(filtered);
	if (keys.length === 0) return "";
	if (keys.length === 1 && typeof filtered[keys[0]] === "string") {
		return fg(argColor, `${keys[0]}: "${filtered[keys[0]]}"`);
	}
	const json = JSON.stringify(filtered);
	return fg(argColor, json.length > 90 ? `${json.slice(0, 87)}…` : json);
}

interface FoundItems {
	label: string;
	items: any[];
}

function findItemArray(obj: any): FoundItems | null {
	if (!obj || typeof obj !== "object") return null;

	// Check direct keys
	if (Array.isArray(obj.actions)) return { label: "matching actions", items: obj.actions };
	if (Array.isArray(obj.accounts)) return { label: "connected accounts", items: obj.accounts };
	if (Array.isArray(obj.nodes)) return { label: "items", items: obj.nodes };
	if (Array.isArray(obj.results)) return { label: "results", items: obj.results };
	if (Array.isArray(obj.web?.results)) return { label: "results", items: obj.web.results };
	if (Array.isArray(obj.grounding?.generic)) return { label: "results", items: obj.grounding.generic };
	if (Array.isArray(obj.generic)) return { label: "results", items: obj.generic };
	if (Array.isArray(obj.items)) return { label: "items", items: obj.items };
	if (Array.isArray(obj.records)) return { label: "records", items: obj.records };
	if (Array.isArray(obj.messages)) return { label: "messages", items: obj.messages };

	// Check nested 'data' or 'result'
	if (obj.data && typeof obj.data === "object") {
		const found = findItemArray(obj.data);
		if (found) return found;
	}
	if (obj.result && typeof obj.result === "object") {
		const found = findItemArray(obj.result);
		if (found) return found;
	}
	return null;
}

function extractItemLabel(item: any): { title: string; subtitle?: string } {
	if (typeof item === "string") return { title: item };
	if (!item || typeof item !== "object") return { title: String(item) };

	if (item.action_id) {
		return { title: String(item.action_id), subtitle: item.description ? String(item.description).slice(0, 60) : undefined };
	}
	if (item.connector && item.name) {
		return { title: String(item.name), subtitle: String(item.connector) };
	}
	if (item.identifier && item.title) {
		return { title: `${item.identifier}: ${item.title}` };
	}
	if (item.title) {
		return { title: String(item.title), subtitle: item.url ? String(item.url) : undefined };
	}
	if (item.name) {
		return { title: String(item.name) };
	}
	if (item.id) {
		return { title: String(item.id) };
	}
	return { title: JSON.stringify(item).slice(0, 80) };
}

function summarizeJsonResult(
	data: any,
	args: any,
	toolName: string,
	theme: Theme,
	expanded: boolean,
	truncationInfo: string,
): string | null {
	const fg = (c: string, s: string) => safeFg(theme, c, s);

	const found = findItemArray(data);
	if (found && Array.isArray(found.items)) {
		const total = found.items.length;
		const header = fg("success", `✓ ${total} ${found.label}${truncationInfo}`);
		if (total === 0) return header;
		const maxShown = expanded ? total : Math.min(3, total);
		const lines = [header];
		for (let i = 0; i < maxShown; i++) {
			const item = found.items[i];
			const { title, subtitle } = extractItemLabel(item);
			const sub = subtitle ? fg("dim", ` (${subtitle})`) : "";
			lines.push(`  ${fg("muted", "•")} ${fg("text", title)}${sub}`);
		}
		if (!expanded && total > maxShown) {
			lines.push(`  ${fg("muted", `… ${total - maxShown} more (ctrl+o to expand)`)}`);
		}
		return lines.join("\n");
	}

	// Single entity summary
	const inner = data?.result?.data ?? data?.result ?? data;
	if (typeof inner === "object" && inner !== null) {
		const summaryKeys = ["id", "title", "name", "status", "state", "message"];
		const parts: string[] = [];
		for (const k of summaryKeys) {
			if (inner[k]) parts.push(`${k}: ${inner[k]}`);
		}
		if (parts.length > 0) {
			return fg("success", `✓ ${parts.join("  ")}`);
		}
	}

	return null;
}

function formatGenericResult(
	toolName: string,
	result: any,
	theme: Theme,
	expanded = false,
	isPartial?: boolean,
	args?: any,
	isErrorFlag = false,
): string {
	const fg = (c: string, s: string) => safeFg(theme, c, s);
	if (isPartial) return fg("warning", "…");
	if (!result) return "";

	const rawText: string = (result?.content?.[0]?.text ?? "").trim();

	// Check if this is an error or aborted operation
	if (isErrorFlag || rawText.startsWith("Failed to call tool:") || rawText.startsWith("Error:")) {
		let msg = result?.details?.error || rawText || "Error";
		if (typeof msg === "string") {
			msg = msg.replace(/^Failed to call tool:\s*/i, "").split("\n")[0].trim();
		}
		return fg("error", `✗ ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
	}

	if (!rawText) return fg("success", "✓ Done");
	// Background Agent hand-off: status + id go in the title bar (agentBgTitle).
	if (toolName === "Agent" && rawText.startsWith("[Agent running]")) return "";

	let textToParse = rawText;
	let truncationInfo = "";
	const truncMatch = rawText.match(
		/\[MCP text output truncated: original \d+ lines \/ ([0-9.]+[A-Z]+)\. .*Full text saved to: ([^\s\]]+)/,
	);
	if (truncMatch) {
		truncationInfo = ` (${truncMatch[1]})`;
		const filePath = truncMatch[2];
		try {
			textToParse = readFileSync(filePath, "utf8");
		} catch {
			// fallback to rawText
		}
	}

	try {
		const parsed = JSON.parse(textToParse.trim());
		const summary = summarizeJsonResult(parsed, args, toolName, theme, expanded, truncationInfo);
		if (summary) return summary;
	} catch {
		// not JSON
	}

	const lines = textToParse.trim().split("\n");
	if (!expanded && lines.length > 5) {
		const shown = lines.slice(0, 4);
		const remaining = lines.length - 4;
		return `${shown.join("\n")}\n${fg("muted", `… ${remaining} more lines (ctrl+o to expand)`)}`;
	}
	return lines.join("\n");
}

// ── Dock: background tasks + subagents ──────────────────────────────────────
// Two lines always below the footer, "▶ background tasks" and "▶ subagents":
// dim when nothing is running, normal text + spinner while something runs.
// ↓ on an empty prompt selects the first, ↓/↑ move between them, Enter opens
// that list (in place of the editor), Enter on an item opens it (a task's live
// output / an agent's live conversation), Esc steps back out.

const BG_DOCK_KEY = "alt-ui-bg-dock";

let bgReg: BgRegistry | undefined;
let bgUi: any;
/** Which dock line has the keyboard, if any. */
let dockFocus: "bg" | "agents" | undefined;
let bgViewOpen = false;

function runningAgents(): AgentRecord[] {
	return (getAgentManager()?.listAgents() ?? []).filter((r) => r.lifecycle.status === "running" || r.lifecycle.status === "queued");
}

function hasRunningBgJobs(reg: BgRegistry | undefined): boolean {
	return !!reg && [...reg.jobs.values()].some((j) => j.status === "running" && j.isBackgrounded);
}

// Same frames/speed as zentui's working-line spinner ("braille", 100ms).
const BG_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BG_SPINNER_MS = 100;

let bgDockTui: any;
let bgDockUiInstalled: any;
let bgDockLineComponent: any;

/** Subagent spinner colour: the purple zentui uses for user messages / footer. */
const AGENT_SPINNER_HEX = "#9a8ddb";

function dockLine(theme: Theme, label: string, running: boolean, focused: boolean, spinnerHex?: string): string {
	// Only the ▶ lights up (blue) when the line is selected; the label is plain
	// text while something runs and dim otherwise.
	const labelColour = running ? "text" : "dim";
	const frame = BG_SPINNER_FRAMES[Math.floor(Date.now() / BG_SPINNER_MS) % BG_SPINNER_FRAMES.length];
	const rgb = spinnerHex ? hexToRgb(spinnerHex) : null;
	const spinner = running
		? `${rgb ? `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${frame}\x1b[39m` : safeFg(theme, "accent", frame)} `
		: "";
	return (
		`${safeFg(theme, focused ? "accent" : labelColour, "▶")} ${spinner}${safeFg(theme, labelColour, label)}` +
		(focused ? safeFg(theme, "dim", "  enter to view · esc") : "")
	);
}

function dockLines(theme: Theme): string[] {
	return [
		dockLine(theme, "background tasks", hasRunningBgJobs(bgReg), dockFocus === "bg"),
		dockLine(theme, "subagents", runningAgents().length > 0, dockFocus === "agents", AGENT_SPINNER_HEX) +
			(subView && dockFocus !== "agents"
				? safeFg(theme, "dim", `  viewing ${subView.record.display.type} · esc back to main`)
				: ""),
	];
}
/** Keep the dock line as the TUI's last child, i.e. below zentui's footer. */
function keepBgDockLast(): void {
	const tui = bgDockTui;
	if (!tui || !bgDockLineComponent) return;
	if (tui.children[tui.children.length - 1] === bgDockLineComponent) return;
	tui.removeChild(bgDockLineComponent);
	tui.addChild(bgDockLineComponent);
	tui.requestRender();
}

/**
 * Widgets only go above/below the editor, and the footer sits after both. So
 * an empty below-editor widget just hands us the TUI, and the dock line is
 * appended to the TUI root after the footer. Installed once per UI; after that
 * a paint is just a redraw.
 */
function paintBgDock(): void {
	if (!bgUi) return;
	if (bgDockUiInstalled === bgUi) {
		keepBgDockLast();
		bgDockTui?.requestRender();
		return;
	}
	bgDockUiInstalled = bgUi;
	bgUi.setWidget(
		BG_DOCK_KEY,
		(tui: any, theme: Theme) => {
			// Drop a dock left behind by a previous load (/reload).
			for (const child of [...tui.children]) if (child.__altUiBgDock) tui.removeChild(child);
			bgDockTui = tui;
			const line = {
				__altUiBgDock: true,
				render: (width: number) => dockLines(theme).map((l) => truncateToWidth(` ${l}`, width)),
				invalidate: () => {},
			};
			bgDockLineComponent = line;
			tui.addChild(line);
			// Animate the spinner while something runs (plus one redraw when that
			// stops); re-assert position always (zentui re-adds its footer).
			let wasBusy = false;
			const timer = setInterval(() => {
				keepBgDockLast();
				const busy = hasRunningBgJobs(bgReg) || runningAgents().length > 0;
				if (busy || wasBusy) tui.requestRender();
				wasBusy = busy;
			}, BG_SPINNER_MS);
			timer.unref?.();
			return {
				render: () => [],
				invalidate: () => {},
				dispose: () => {
					clearInterval(timer);
					tui.removeChild(line);
				},
			};
		},
		{ placement: "belowEditor" },
	);
}

// The editor always paints a fake block cursor (inverse video). Hide it while
// the dock is selected so it's clear where the keyboard is. Hooked on the base
// class so zentui's editor subclass is covered too. Re-installed on every load
// (on top of the saved original) so the hook reads this module's state after
// /reload rather than a stale copy's.
const editorProto = Editor.prototype as any;
editorProto.__altUiOrigRender ??= editorProto.render;
{
	const origEditorRender = editorProto.__altUiOrigRender;
	editorProto.render = function (width: number) {
		const lines: string[] = origEditorRender.call(this, width);
		if (!dockFocus) return lines;
		return lines.map((l) => l.replace(/\x1b\[7m([^\x1b]*?)\x1b\[0m/g, "$1\x1b[0m"));
	};
}

// bg-tasks doesn't record when a job ends; note it the first time we see it finished.
const bgJobEndTimes = new Map<string, number>();

function renderBgDock(reg: BgRegistry, ctx: any): void {
	if (ctx.hasUI === false) return; // a subagent's own bg jobs, not ours
	for (const job of [...reg.jobs.values(), ...reg.recentTerminal]) {
		if (job.status !== "running" && !bgJobEndTimes.has(job.id)) bgJobEndTimes.set(job.id, Date.now());
	}
	bgReg = reg;
	bgUi = ctx.ui;
	paintBgDock();
}

function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

/** Background jobs, running or recently finished, oldest start first (last 20). */
function listedBgJobs(reg: BgRegistry | undefined): BgJob[] {
	if (!reg) return [];
	const all = [...reg.jobs.values(), ...reg.recentTerminal].filter((j) => j.isBackgrounded || j.status !== "running");
	const seen = new Set<string>();
	return all
		.filter((j) => !seen.has(j.id) && seen.add(j.id))
		.sort((a, b) => a.startTime - b.startTime)
		.slice(-20);
}

/** Row cells: start time, "◷ <duration>" (live while running), status. Uncoloured. */
function bgJobCells(job: BgJob): { start: string; took: string; status: string; colour: string } {
	const start = new Date(job.startTime).toLocaleTimeString("en-GB", { hour12: false });
	const end = job.status === "running" ? Date.now() : (bgJobEndTimes.get(job.id) ?? Date.now());
	const took = `◷ ${formatElapsed(end - job.startTime)}`;
	if (job.status === "running") return { start, took, status: "running", colour: "accent" };
	if (job.status === "completed") return { start, took, status: "✓ done", colour: "accent" };
	const exit = job.exitCode !== undefined ? ` (exit ${job.exitCode})` : "";
	return { start, took, status: `✗ ${job.status}${exit}`, colour: "error" };
}

function bgJobStatus(job: BgJob, theme: Theme): string {
	const c = bgJobCells(job);
	return `${safeFg(theme, "dim", c.start)}  ${safeFg(theme, "accent", c.took)}  ${safeFg(theme, c.colour, c.status)}`;
}

class BgTasksView {
	private selected = 0;
	private openJob?: BgJob;
	private timer: ReturnType<typeof setInterval>;

	constructor(
		private tui: any,
		private theme: Theme,
		private done: () => void,
	) {
		// Keep elapsed times and log tails live.
		this.timer = setInterval(() => this.tui.requestRender(), 1000);
	}

	handleInput(data: string): void {
		const jobs = listedBgJobs(bgReg);
		if (this.openJob) {
			if (matchesKey(data, "escape")) this.openJob = undefined;
		} else if (matchesKey(data, "escape")) {
			return this.done();
		} else if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
		} else if (matchesKey(data, "down")) {
			this.selected = Math.min(jobs.length - 1, this.selected + 1);
		} else if (matchesKey(data, "enter") && jobs[this.selected]) {
			this.openJob = jobs[this.selected];
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return this.openJob ? this.renderJob(this.openJob, width) : this.renderList(width);
	}

	private renderList(width: number): string[] {
		const fg = (c: string, t: string) => safeFg(this.theme, c, t);
		const jobs = listedBgJobs(bgReg);
		this.selected = Math.min(this.selected, Math.max(0, jobs.length - 1));
		const cells = jobs.map(bgJobCells);
		const tookW = Math.max(0, ...cells.map((c) => visibleWidth(c.took)));
		const statusW = Math.max(0, ...cells.map((c) => visibleWidth(c.status)));
		const rows = jobs.length
			? jobs.map((job, i) => {
					const c = cells[i];
					const cmd = job.command.replace(/\s+/g, " ").trim();
					const mark = i === this.selected ? fg("accent", "❯ ") : "  ";
					const label = i === this.selected ? fg("text", this.theme.bold(cmd)) : fg("text", cmd);
					return (
						`${mark}${fg("dim", c.start)}  ${fg("accent", c.took.padEnd(tookW))}  ` +
						`${fg(c.colour, c.status.padEnd(statusW))}  ${label}`
					);
				})
			: [fg("muted", "No background tasks")];
		rows.push("", fg("dim", "↑↓ select · enter view output · esc close"));
		return new RoundedFrame("background tasks", rows.join("\n"), this.theme, ALT_UI_CONFIG.successBorder, ALT_UI_CONFIG.successTitle).render(width);
	}

	private renderJob(job: BgJob, width: number): string[] {
		const fg = (c: string, t: string) => safeFg(this.theme, c, t);
		const maxLines = Math.max(5, (this.tui.terminal?.rows ?? 30) - 14);
		const log = readLogTail(job, 32_000).replace(/\r/g, "").split("\n");
		while (log.length && !log[log.length - 1].trim()) log.pop();
		const hidden = Math.max(0, log.length - maxLines);
		const body = [
			`${fg("text", job.command.replace(/\s+/g, " ").trim())}`,
			`${bgJobStatus(job, this.theme)}${fg("dim", ` · ${job.id} · ${job.logPath}`)}`,
			"",
			...(hidden ? [fg("muted", `… ${hidden} earlier lines`)] : []),
			...log.slice(-maxLines).map((l) => fg("dim", l)),
			"",
			fg("dim", "esc back"),
		];
		return new RoundedFrame("output", body.join("\n"), this.theme, ALT_UI_CONFIG.successBorder, ALT_UI_CONFIG.successTitle).render(width);
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
	}
}

async function openDockView(ui: any, which: "bg" | "agents"): Promise<void> {
	if (bgViewOpen) return;
	bgViewOpen = true;
	dockFocus = undefined;
	paintBgDock();
	let picked: AgentRecord | undefined;
	try {
		picked = await ui.custom((tui: any, theme: Theme, _kb: any, done: (r?: AgentRecord) => void) =>
			which === "bg" ? new BgTasksView(tui, theme, () => done()) : new AgentsView(tui, theme, done),
		);
	} finally {
		bgViewOpen = false;
		paintBgDock();
	}
	if (picked) openSubagentView(picked);
}

/** True when ↓ has nowhere to go inside the editor (last line, no autocomplete). */
function cursorOnLastEditorLine(): boolean {
	const ed = piMode?.editor;
	const base = ed?.base ?? ed; // zentui may wrap pi's editor
	if (!base?.getCursor || !base?.getLines) return true;
	if (base.isShowingAutocomplete?.()) return false;
	return base.getCursor().line >= base.getLines().length - 1;
}

/** Raw-input hook: ↓ on the editor's last line focuses the dock, ↓/↑ move, Enter opens. */
function bgDockInput(ui: any, data: string): { consume: boolean } | undefined {
	if (bgViewOpen || isKeyRelease(data)) return;
	const sub = subViewInput(ui, data);
	if (sub) return sub;
	const focus = (next: typeof dockFocus) => {
		dockFocus = next;
		paintBgDock();
		return { consume: true };
	};
	if (!dockFocus) {
		if (matchesKey(data, "down") && cursorOnLastEditorLine()) return focus("bg");
		return;
	}
	if (matchesKey(data, "enter")) {
		void openDockView(ui, dockFocus);
		return { consume: true };
	}
	if (matchesKey(data, "down")) return focus("agents");
	if (matchesKey(data, "up")) return focus(dockFocus === "agents" ? "bg" : undefined);
	if (matchesKey(data, "escape")) return focus(undefined);
	// Any other key leaves the dock and goes on to the editor.
	focus(undefined);
	return;
}

// subagents-lite's completion card, replaced by one line in the same style as
// bg-tasks': ● Subagent Explore "Find the config loader" completed · 42s
function renderAgentNotification(message: any, _opts: any, theme: Theme) {
	const d = (message.details ?? {}) as { status?: string; type?: string; description?: string };
	const ok = d.status === "completed";
	const what = [d.type, d.description ? `"${d.description}"` : ""].filter(Boolean).join(" ");
	const text = ` ● Subagent ${what} ${ok ? "completed" : (d.status ?? "finished")}`;
	return {
		render: (width: number) => [safeFg(theme, ok ? "accent" : "error", truncateToWidth(text, width))],
		invalidate: () => {},
	};
}

// ── Subagents list ──────────────────────────────────────────────────────────

/** Subagents, oldest start first (last 20). */
function listedAgents(): AgentRecord[] {
	return [...(getAgentManager()?.listAgents() ?? [])].sort((a, b) => a.lifecycle.startedAt - b.lifecycle.startedAt).slice(-20);
}

/** Row cells for an agent, same shape as bgJobCells. */
function agentCells(r: AgentRecord): { start: string; took: string; status: string; colour: string } {
	const { status, startedAt, completedAt } = r.lifecycle;
	const start = new Date(startedAt).toLocaleTimeString("en-GB", { hour12: false });
	const took = `◷ ${formatElapsed((completedAt ?? Date.now()) - startedAt)}`;
	if (status === "running") return { start, took, status: "running", colour: "accent" };
	if (status === "queued") return { start, took, status: "queued", colour: "muted" };
	if (status === "completed") return { start, took, status: "✓ done", colour: "accent" };
	const label = status === "turn_limited" ? "turn limit" : status;
	return { start, took, status: `✗ ${label}`, colour: "error" };
}

class AgentsView {
	private selected = 0;
	private timer: ReturnType<typeof setInterval>;

	constructor(
		private tui: any,
		private theme: Theme,
		/** Close the list; pass an agent to open it in the main window. */
		private done: (picked?: AgentRecord) => void,
	) {
		this.timer = setInterval(() => this.tui.requestRender(), 1000);
	}

	handleInput(data: string): void {
		const agents = listedAgents();
		if (matchesKey(data, "escape")) return this.done();
		if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down")) this.selected = Math.min(agents.length - 1, this.selected + 1);
		else if (matchesKey(data, "enter") && agents[this.selected]) return this.done(agents[this.selected]);
		else if (matchesKey(data, "x")) {
			// Stop the selected agent (same as StopAgent / the package's menu).
			const r = agents[this.selected];
			if (r && (r.lifecycle.status === "running" || r.lifecycle.status === "queued")) getAgentManager()?.abort(r.id, "user");
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const fg = (c: string, t: string) => safeFg(this.theme, c, t);
		const agents = listedAgents();
		this.selected = Math.min(this.selected, Math.max(0, agents.length - 1));
		const cells = agents.map(agentCells);
		const tookW = Math.max(0, ...cells.map((c) => visibleWidth(c.took)));
		const statusW = Math.max(0, ...cells.map((c) => visibleWidth(c.status)));
		const typeW = Math.max(0, ...agents.map((r) => visibleWidth(r.display.type)));
		const rows = agents.length
			? agents.map((r, i) => {
					const c = cells[i];
					const desc = r.display.description.replace(/\s+/g, " ").trim();
					const mark = i === this.selected ? fg("accent", "❯ ") : "  ";
					const label = i === this.selected ? fg("text", this.theme.bold(desc)) : fg("text", desc);
					return (
						`${mark}${fg("dim", c.start)}  ${fg("accent", c.took.padEnd(tookW))}  ` +
						`${fg(c.colour, c.status.padEnd(statusW))}  ${fg("muted", r.display.type.padEnd(typeW))}  ${label}`
					);
				})
			: [fg("muted", "No subagents")];
		rows.push("", fg("dim", "↑↓ select · enter open · x stop · esc close"));
		return new RoundedFrame("subagents", rows.join("\n"), this.theme, ALT_UI_CONFIG.successBorder, ALT_UI_CONFIG.successTitle).render(width);
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
	}
}

// ── Subagent in the main window ─────────────────────────────────────────────
// Opening a subagent swaps pi's chat container for one showing the subagent's
// session, built from pi's own message components (so alt-ui frames, zentui
// user boxes and thinking all look the same). The editor, footer and dock
// stay: Enter sends the subagent a steering message, Esc swaps the main chat
// back. The main session keeps appending to its own (hidden) container.

/** pi's InteractiveMode, captured from its renderWidgets (see the hook below). */
let piMode: any;
{
	const modeProto = InteractiveMode.prototype as any;
	modeProto.__altUiOrigRenderWidgets ??= modeProto.renderWidgets;
	const orig = modeProto.__altUiOrigRenderWidgets;
	modeProto.renderWidgets = function (...args: any[]) {
		piMode = this;
		return orig.apply(this, args);
	};
}

/** The component whose children include `target`, searched from `root`. */
function findParent(root: any, target: any, depth = 0): any {
	if (!root?.children || depth > 6) return undefined;
	if (root.children.includes(target)) return root;
	for (const child of root.children) {
		const hit = findParent(child, target, depth + 1);
		if (hit) return hit;
	}
	return undefined;
}

let subView:
	| { record: AgentRecord; chat: Container; unsubscribe: () => void; lastAssistant?: any; timer?: ReturnType<typeof setTimeout> }
	| undefined;

function buildSubagentChat(view: NonNullable<typeof subView>): void {
	const mode = piMode;
	const tui = mode.ui;
	const theme = bgUi?.theme;
	const md = mode.getMarkdownThemeWithSettings?.() ?? getMarkdownTheme();
	const r = view.record;
	const chat = view.chat;
	chat.clear();
	if (theme) {
		chat.addChild(
			new Text(
				`${safeFg(theme, "accent", `◂ subagent · ${r.display.type}`)}${safeFg(theme, "dim", " · ")}` +
					`${safeFg(theme, "text", r.display.description)}${safeFg(theme, "dim", `  ·  ${agentCells(r).status}  ·  esc back to main`)}`,
				1,
				0,
			),
		);
	}
	const pending = new Map<string, any>();
	view.lastAssistant = undefined;
	for (const msg of (r.execution?.session?.messages ?? []) as any[]) {
		if (msg.role === "user") {
			const text = typeof msg.content === "string" ? msg.content : msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
			if (!text) continue;
			chat.addChild(new Spacer(1));
			chat.addChild(new UserMessageComponent(text, md, mode.outputPad));
		} else if (msg.role === "assistant") {
			const component = new AssistantMessageComponent(msg, mode.hideThinkingBlock, md, mode.hiddenThinkingLabel, mode.outputPad);
			chat.addChild(component);
			view.lastAssistant = { component, msg };
			for (const c of msg.content) {
				if (c.type !== "toolCall") continue;
				const tool = new ToolExecutionComponent(
					c.name,
					c.id,
					c.arguments,
					{ showImages: false },
					mode.getRegisteredToolDefinition?.(c.name),
					tui,
					r.display.worktreePath ?? mode.sessionManager?.getCwd?.() ?? CWD,
				);
				tool.setExpanded(!!mode.toolOutputExpanded);
				chat.addChild(tool);
				pending.set(c.id, tool);
			}
		} else if (msg.role === "toolResult") {
			pending.get(msg.toolCallId)?.updateResult(msg);
		}
	}
	tui.requestRender(true);
}

/**
 * While a subagent is on screen, zentui's editor shows "◂ subagent · <type> ·
 * <description>" where it normally shows the session name (top-left of its
 * border). zentui reads that through the editor's getModelMeta(); wrap it on
 * the instance so the real session name is untouched.
 */
function labelEditorForSubagent(): void {
	const ed = piMode?.editor;
	if (!ed || ed.__altUiMetaWrapped) return;
	ed.__altUiMetaWrapped = true;
	// zentui's minimalist style reads getMinimalistMetadata(), the others getModelMeta().
	for (const key of ["getModelMeta", "getMinimalistMetadata"]) {
		const orig = ed[key];
		if (typeof orig !== "function") continue;
		ed[key] = () => {
			const meta = orig.call(ed);
			if (!subView) return meta;
			const r = subView.record;
			return { ...meta, sessionName: `◂ subagent · ${r.display.type} · ${r.display.description.replace(/\s+/g, " ").trim()}` };
		};
	}
}

function openSubagentView(record: AgentRecord): void {
	const mode = piMode;
	const session = record.execution?.session;
	if (!mode || !session) {
		bgUi?.notify("That subagent hasn't started yet.", "info");
		return;
	}
	closeSubagentView();
	const chat = new Container();
	// The chat sits inside a layout container, not directly on the TUI root.
	const parent = findParent(mode.ui, mode.chatContainer);
	if (!parent) return;
	parent.children[parent.children.indexOf(mode.chatContainer)] = chat;
	const view: NonNullable<typeof subView> = { record, chat, unsubscribe: () => {} };
	subView = view;
	const rebuildSoon = () => {
		if (view.timer) return;
		view.timer = setTimeout(() => {
			view.timer = undefined;
			if (subView === view) buildSubagentChat(view);
		}, 80);
	};
	view.unsubscribe = session.subscribe((event: any) => {
		if (subView !== view) return;
		// Streaming text/thinking: update the live message in place; anything
		// else (new message, tool start/end) rebuilds.
		const msgs = session.messages;
		const last = msgs[msgs.length - 1];
		if (event?.type === "message_update" && view.lastAssistant?.msg === last) {
			view.lastAssistant.component.updateContent(last);
			mode.ui.requestRender();
		} else rebuildSoon();
	});
	labelEditorForSubagent();
	buildSubagentChat(view);
	paintBgDock();
}

function closeSubagentView(): void {
	const view = subView;
	if (!view) return;
	subView = undefined;
	view.unsubscribe();
	if (view.timer) clearTimeout(view.timer);
	const mode = piMode;
	const parent = mode && findParent(mode.ui, view.chat);
	if (parent) parent.children[parent.children.indexOf(view.chat)] = mode.chatContainer;
	mode?.ui.requestRender(true);
	paintBgDock();
}

/** Keys while a subagent is on screen: Esc returns, Enter steers it. */
function subViewInput(ui: any, data: string): { consume: boolean } | undefined {
	if (!subView || isKeyRelease(data)) return;
	if (matchesKey(data, "escape") && !dockFocus) {
		closeSubagentView();
		return { consume: true };
	}
	if (matchesKey(data, "enter") && !dockFocus) {
		const text = ui.getEditorText().trim();
		if (!text) return { consume: true };
		const r = subView.record;
		if (r.lifecycle.status === "running" || r.lifecycle.status === "queued") {
			getAgentManager()?.steer(r.id, text);
			ui.setEditorText("");
		} else {
			ui.notify("This subagent has finished; Esc to go back to the main chat.", "info");
		}
		return { consume: true };
	}
	return;
}

// bg-tasks' completion line, restyled: indented to the transcript's text
// column, blue on success, red otherwise.
function renderBgNotification(message: any, _opts: any, theme: Theme) {
	const details = message.details as { status?: string; summary?: string } | undefined;
	const colour = details?.status === "completed" ? "accent" : "error";
	const text = ` ● ${details?.summary ?? String(message.content)}`;
	return {
		render: (width: number) => [safeFg(theme, colour, truncateToWidth(text, width))],
		invalidate: () => {},
	};
}

// ── Built-in tool registration & ToolExecutionComponent patching ─────────────

export default function (pi: ExtensionAPI) {
	// 0. Load bg-tasks, but keep its `bash` override for ourselves so it gets
	//    alt-ui's frame. Everything else it registers goes straight to pi.
	let bgBash: any;
	bgTasks(
		new Proxy(pi, {
			get(target, prop, receiver) {
				if (prop === "registerTool") {
					return (tool: any) => (tool.name === "bash" ? (bgBash = tool) : target.registerTool(tool));
				}
				if (prop === "registerMessageRenderer") {
					return (type: string, renderer: any) =>
						target.registerMessageRenderer(type, type === "bg-task-notification" ? renderBgNotification : renderer);
				}
				const v = Reflect.get(target, prop, receiver);
				return typeof v === "function" ? v.bind(target) : v;
			},
		}),
	);
	jobsChangedListeners.add(renderBgDock);

	// 0b. Load subagents-lite. alt-ui draws its UI (the "▶ subagents" dock line
	//     and list) and the completion line; the rest is registered as-is.
	altUiHooks.ownsUi = true;
	subagentsLite(
		new Proxy(pi, {
			get(target, prop, receiver) {
				if (prop === "registerMessageRenderer") {
					return (type: string, renderer: any) =>
						target.registerMessageRenderer(type, type === "subagent-result" ? renderAgentNotification : renderer);
				}
				// Subagents always run in the background: the call returns at once and
				// the result arrives as a message. The flag is dropped from the schema
				// so the model can't ask for a blocking run.
				if (prop === "registerTool") {
					return (tool: any) => {
						if (tool.name !== "Agent") return target.registerTool(tool);
						const { run_in_background: _drop, ...props } = tool.parameters.properties;
						const required = tool.parameters.required?.filter((k: string) => k !== "run_in_background");
						target.registerTool({
							...tool,
							parameters: { ...tool.parameters, properties: props, ...(required ? { required } : {}) },
							execute: (id: string, params: any, ...rest: any[]) =>
								tool.execute(id, { ...params, run_in_background: true }, ...rest),
						});
					};
				}
				const v = Reflect.get(target, prop, receiver);
				return typeof v === "function" ? v.bind(target) : v;
			},
		}),
	);

	pi.on("session_shutdown", () => closeSubagentView());
	pi.on("session_start", (_event, ctx) => {
		// Subagent sessions load extensions too, in-process; the dock belongs to
		// the interactive parent only.
		if (!ctx.hasUI) return;
		bgUi = ctx.ui;
		bgDockUiInstalled = undefined; // widgets don't survive a session switch
		paintBgDock();
		ctx.ui.onTerminalInput((data) => bgDockInput(ctx.ui, data));
	});

	// 1. Re-register built-in tools with specialized formatting
	for (const [name, factory] of Object.entries(BUILT_INS)) {
		const original = name === "bash" && bgBash ? bgBash : factory(CWD);

		pi.registerTool({
			name,
			label: name,
			description: original.description,
			promptSnippet: original.promptSnippet,
			promptGuidelines: original.promptGuidelines,
			parameters: original.parameters,
			renderShell: "self",

			async execute(toolCallId, params, signal, onUpdate, ctx) {
				if (name === "write") {
					const p = (params as any)?.path as string | undefined;
					const c = (params as any)?.content;
					if (p && typeof c === "string") {
						return executeWriteWithDiff(p, c, original.execute, toolCallId, signal, onUpdate);
					}
				}
				return original.execute(toolCallId, params, signal, onUpdate, ctx);
			},

			renderCall(_args: any, _theme: Theme, _context: any) {
				return new Container();
			},

			renderResult(result: any, opts: any, theme: Theme, context: any) {
				try {
					if (opts?.isPartial) {
						const safeFgLocal = (c: string, s: string) => safeFg(theme, c, s);
						const callBody = runningBody(
							name,
							theme,
							context?.state,
							context?.args,
							typeof context?.args?.partialJson === "string" ? context.args.partialJson : undefined,
						);
						const partialText =
							result?.content?.[0]?.type === "text" ? (result.content[0].text as string).trim() : "";
						let outputLines = "";
						if (partialText) {
							const all = partialText.split("\n");
							const shown = all.slice(-5);
							const hidden = all.length - shown.length;
							outputLines = shown.map((l) => `\n${safeFgLocal("dim", l)}`).join("");
							if (hidden > 0) outputLines += `\n${safeFgLocal("muted", `… ${hidden} earlier lines`)}`;
						}
						const body = outputLines ? `${callBody}${outputLines}` : callBody;
						startPulse(context);
						return new RoundedFrame(name, body, theme, ALT_UI_CONFIG.runningBorder, ALT_UI_CONFIG.runningTitle, true);
					}
					const rawText: string =
						result?.content?.[0]?.type === "text" ? (result.content[0].text as string) : "";
					const exitMatch = rawText.match(/Command exited with code (\d+)/);
					// context.isError is the only place pi exposes the flag here.
					const isErr = context?.isError === true || (exitMatch ? Number(exitMatch[1]) > 0 : false);
					const resultBody = formatResult(
						name,
						result,
						theme,
						opts?.expanded,
						opts?.isPartial,
						context?.args,
						isErr,
					);
					const argLine = formatArgs(name, context?.args, theme, isErr ? ALT_UI_CONFIG.errorArgs : ALT_UI_CONFIG.successArgs);
					const body = resultBody
						? argLine
							? `${argLine}\n${resultBody}`
							: resultBody
						: argLine;
					stopPulse(context);
					return new RoundedFrame(
						name,
						body,
						theme,
						isErr ? ALT_UI_CONFIG.errorBorder : ALT_UI_CONFIG.successBorder,
						isErr ? ALT_UI_CONFIG.errorTitle : ALT_UI_CONFIG.successTitle,
						false,
						undefined,
						name === "bash" && !isErr ? bashBgTitle(rawText, theme) : undefined,
					);
				} catch {
					return new Text(`${name} ${safeStringify(context?.args)}`, 0, 0);
				}
			},
		});
	}

	// Pi draws custom messages that have no renderer as a grey-background box
	// with a "[customType]" label. Swap that for a LabeledBox so they match the
	// zentui user-message frame. Messages with their own renderer are untouched.
	const customProto = CustomMessageComponent.prototype as any;
	if (customProto) {
		customProto.__altUiOrigRebuild ??= customProto.rebuild;
		const origRebuild = customProto.__altUiOrigRebuild;
		customProto.rebuild = function () {
			origRebuild.call(this);
			if (this.customComponent) return;
			// Pi's live theme (same global its own `theme` proxy reads).
			const theme = (globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")];
			if (!theme) return;
			const body = new Markdown(messageText(this.message), 0, 0, this.markdownTheme ?? getMarkdownTheme(), {
				color: (t: string) => safeFg(theme, ALT_UI_CONFIG.messageText, t),
			});
			this.removeChild(this.box);
			// Stored as customComponent so the next rebuild() removes it.
			this.customComponent = new LabeledBox(this.message.customType, body, theme);
			this.addChild(this.customComponent);
		};
	}

	// pi-mcp-adapter posts OAuth results as a "mcp-oauth-status" custom message
	// with no renderer. Give it a status icon and a server-specific label.
	pi.registerMessageRenderer("mcp-oauth-status", (message, _opts, theme) => {
		const details = (message.details ?? {}) as { server?: string; status?: string };
		const ok = details.status !== "failed";
		const [first, ...rest] = messageText(message).split(/(?<=\.)\s+/).filter(Boolean);
		const icon = ok ? safeFg(theme, "success", "✓") : safeFg(theme, "error", "✗");
		const body = new Container();
		body.addChild(new Text(`${icon} ${first ?? ""}`, 0, 0));
		if (rest.length) body.addChild(new Text(safeFg(theme, "muted", rest.join(" ")), 2, 0));
		const label = details.server ? `mcp auth · ${details.server}` : "mcp auth";
		return new LabeledBox(label, body, theme, ok ? ALT_UI_CONFIG.messageBorder : ALT_UI_CONFIG.errorBorder);
	});

	// 2. Patch ToolExecutionComponent so all other tools (StackOne execute_action,
	//    search_actions, list_accounts, MCP tools) get the exact same RoundedFrame format!
	// Make AssistantMessageComponent expandable so Pi's setToolsExpanded (Ctrl+O)
	// applies globally to ALL thinking blocks as well as all tool outputs.
	// Expanded thinking bypasses zentui's Thinking (Experimental) renderer and
	// shows Pi's native full text (see ensureZentuiThinkingHooks).
	const assistantProto = AssistantMessageComponent.prototype as any;
	if (assistantProto) {
		assistantProto.__altUiOrigRender ??= assistantProto.render;
		assistantProto.setExpanded = function (expanded: boolean) {
			thinkingExpanded = expanded;
			ensureZentuiThinkingHooks(this);
			if (this.lastMessage) {
				try {
					this.updateContent(this.lastMessage);
				} catch {
					// ignore
				}
			}
		};
		// zentui installs its thinking patch at session start, after extensions
		// load, so hook it lazily from the first renders instead.
		const origRender = assistantProto.__altUiOrigRender;
		assistantProto.render = function (width: number) {
			ensureZentuiThinkingHooks(this);
			return origRender.call(this, width);
		};
	}

	const proto = ToolExecutionComponent.prototype as any;
	// Re-installed on every load (over pi's saved originals) so /reload picks up
	// edits to the formatting code instead of keeping the first load's closures.
	if (proto) {
		proto.__altUiOrig ??= {
			getRenderShell: proto.getRenderShell,
			getCallRenderer: proto.getCallRenderer,
			getResultRenderer: proto.getResultRenderer,
		};
		const origGetRenderShell = proto.__altUiOrig.getRenderShell;
		const origGetCallRenderer = proto.__altUiOrig.getCallRenderer;
		const origGetResultRenderer = proto.__altUiOrig.getResultRenderer;

		proto.hasRendererDefinition = function () {
			return true;
		};

		// Only Pi's built-ins (which alt-ui re-registers with its own frames) keep
		// their renderers. Every other tool — including pi-mcp-adapter's direct
		// tools, which ship their own compact renderCall/renderResult — is taken
		// over so the whole transcript uses one RoundedFrame style.
		const isBuiltIn = (self: any) => Object.prototype.hasOwnProperty.call(BUILT_INS, self.toolName);

		proto.getRenderShell = function () {
			if (isBuiltIn(this)) return origGetRenderShell.call(this);
			return "self";
		};

		proto.getCallRenderer = function () {
			if (isBuiltIn(this)) return origGetCallRenderer.call(this);
			const self = this;
			return (args: any, theme: Theme, context: any) => {
				if (self.result) {
					stopPulse(context);
					return new Container();
				}
				const title = cleanToolTitle(self.toolName, args);
				const argLine = formatGenericArgs(self.toolName, args, theme, ALT_UI_CONFIG.runningArgs);
				const running = `${argLine ? `${argLine}  ` : ""}${safeFg(theme, "muted", "(running…)")}`;
				startPulse(context);
				return new RoundedFrame(title, running, theme, ALT_UI_CONFIG.runningBorder, ALT_UI_CONFIG.runningTitle, true);
			};
		};

		proto.getResultRenderer = function () {
			if (isBuiltIn(this)) return origGetResultRenderer.call(this);
			const self = this;
			return (result: any, opts: any, theme: Theme, context: any) => {
				const title = cleanToolTitle(self.toolName, self.args);
				if (opts?.isPartial) {
					const argLine = formatGenericArgs(self.toolName, self.args, theme, opts?.isPartial ? ALT_UI_CONFIG.runningArgs : ALT_UI_CONFIG.successArgs);
					const running = `${argLine ? `${argLine}  ` : ""}${safeFg(theme, "muted", "(running…)")}`;
					startPulse(context);
					return new RoundedFrame(title, running, theme, ALT_UI_CONFIG.runningBorder, ALT_UI_CONFIG.runningTitle, true);
				}
				const rawT = (result?.content?.[0]?.text ?? "").trim();
				const isErr =
					context?.isError === true ||
					rawT.startsWith("Failed to call tool:") ||
					rawT.startsWith("Error:");
				// On failure: red border + red tool name, args in plain white.
				const argLine = formatGenericArgs(
					self.toolName,
					self.args,
					theme,
					isErr ? ALT_UI_CONFIG.errorArgs : ALT_UI_CONFIG.successArgs,
				);
				const resText = formatGenericResult(
					self.toolName,
					result,
					theme,
					opts?.expanded,
					opts?.isPartial,
					self.args,
					isErr,
				);
				const body = resText ? (argLine ? `${argLine}\n${resText}` : resText) : argLine;
				const border = isErr ? "error" : "borderAccent";
				stopPulse(context);
				return new RoundedFrame(
					title,
					body,
					theme,
					isErr ? ALT_UI_CONFIG.errorBorder : ALT_UI_CONFIG.successBorder,
					isErr ? ALT_UI_CONFIG.errorTitle : ALT_UI_CONFIG.successTitle,
					false,
					undefined,
					self.toolName === "Agent" && !isErr ? agentBgTitle(result, theme) : undefined,
				);
			};
		};
	}
}

// ── Compact arg/result formatting for built-ins ──────────────────────────────

function formatArgs(
	name: string,
	args: any,
	theme: Theme,
	argColor = ALT_UI_CONFIG.successArgs,
): string {
	const fg = (c: string, s: string) => safeFg(theme, c, s);
	if (!args) return "";
	switch (name) {
		case "read":
		case "write":
		case "edit":
			return fg(argColor, args.path ?? "");
		case "bash": {
			const cmd: string = (args.command ?? "").replace(/\s+/g, " ");
			// Always render bash commands in plain white text
			return fg("text", cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd);
		}
		case "find":
		case "grep":
			return fg(argColor, (args.pattern ?? "") + (args.path ? `  ${args.path}` : ""));
		case "ls":
			return fg(argColor, args.path ?? ".");
		default: {
			const s = JSON.stringify(args);
			return fg("dim", s.length > 80 ? `${s.slice(0, 77)}…` : s);
		}
	}
}

/** " · ◷ running in background · <agent id>" for a backgrounded Agent call. */
function agentBgTitle(result: any, theme: Theme): string | undefined {
	const text: string = result?.content?.[0]?.text ?? "";
	if (!text.startsWith("[Agent running]")) return undefined;
	const id = result?.details?.agentId ?? text.match(/Agent ID: (\S+)/)?.[1] ?? "";
	const dim = (t: string) => safeFg(theme, "dim", t);
	return `${dim(" · ")}${safeFg(theme, "accent", "◷ running in background")}${id ? dim(` · ${id.slice(0, 8)}`) : ""}`;
}

/** Parse bg-tasks' "Command … with ID: <id>. Output is being written to: <log>" result. */
function parseBgHandoff(text: string): { why: string; id: string; logPath: string } | undefined {
	const m = text.match(/^Command (.*?) with ID: ([^\s.]+).*?Output is being written to: (\S+)/s);
	if (!m) return undefined;
	const why = m[1].includes("manually")
		? "backgrounded by you"
		: m[1].includes("auto-backgrounded")
			? "auto-backgrounded (timeout)"
			: m[1].includes("moved to the background")
				? "backgrounded (you sent a message)"
				: "running in background";
	return { why, id: m[2], logPath: m[3] };
}

/** " · ◷ running in background · bash-xxxx" for the frame's title bar. */
function bashBgTitle(text: string, theme: Theme): string | undefined {
	const bg = parseBgHandoff(text);
	if (!bg) return undefined;
	const dim = (t: string) => safeFg(theme, "dim", t);
	return `${dim(" · ")}${safeFg(theme, "accent", `◷ ${bg.why}`)}${dim(` · ${bg.id}`)}`;
}

function formatResult(
	name: string,
	result: any,
	theme: Theme,
	expanded: boolean,
	isPartial?: boolean,
	args?: any,
	isErrorFlag = false,
): string {
	const fg = (c: string, s: string): string => safeFg(theme, c, s);
	const slice = (text: string, max: number): [string[], number] => {
		const all = text.split("\n");
		if (max <= 0) return [all, 0];
		const more = Math.max(0, all.length - max);
		return [all.slice(0, max), more];
	};
	if (isPartial) return fg("warning", "…");
	const text: string =
		result?.content?.[0]?.type === "text" ? result.content[0].text : "";
	// Pi strips isError before calling renderResult (it passes only
	// { content, details }), so the flag must come from the render context and
	// be threaded in by the caller.
	const isError = isErrorFlag;
	const details = result?.details;

	let out = "";
	switch (name) {
		case "bash": {
			// bg-tasks hand-off: the badge goes in the title bar (bashBgTitle).
			const bg = !isError && parseBgHandoff(text);
			if (bg) {
				if (expanded) out = fg("dim", bg.logPath);
				break;
			}
			// A non-zero exit is a failure even when the tool itself did not set
			// isError, so parse the trailer pi appends to the output.
			const exitMatch = text.match(/Command exited with code (\d+)/);
			const exitCode = exitMatch ? Number(exitMatch[1]) : 0;
			const failed = isError || exitCode > 0;
			const failLine = fg("error", `✗ Command failed${exitCode ? ` (exit ${exitCode})` : ""}`);
			const outText = text
				.replace(/\n\nCommand exited with code \d+.*$/s, "")
				.replace(/^\(no output(?: yet)?\)$/, "") // bg-tasks' empty-log placeholder
				.trim();
			if (!outText) {
				out = failed ? failLine : fg("success", "Done");
				break;
			}
			const maxLines = expanded ? 0 : 5;
			const [lines, more] = slice(outText, maxLines);
			out = lines.map((l) => fg("dim", l)).join("\n");
			if (more > 0)
				out += `\n${fg("muted", `… ${more} more lines (ctrl+o to expand)`)}`;
			// Keep stderr readable in dim, but lead with the red failure marker.
			if (failed) out = `${failLine}\n${out}`;
			break;
		}
		case "read": {
			if (isError) {
				out = fg("error", `✗ ${text.trim() || "Read failed"}`);
				break;
			}
			const lineCount = text.split("\n").length;
			out = fg("success", `${lineCount} lines`);
			break;
		}
		case "edit": {
			if (isError) {
				out = fg("error", `✗ ${text.trim() || "Edit failed"}`);
				break;
			}
			const diff: string = details?.diff ?? "";
			if (!diff) {
				out = fg("success", "Applied");
				break;
			}
			let add = 0, rem = 0;
			const diffLines = diff.split("\n");
			for (const l of diffLines) {
				if (l.startsWith("+") && !l.startsWith("+++")) add++;
				else if (l.startsWith("-") && !l.startsWith("---")) rem++;
			}
			const maxDiff = expanded ? 0 : 24;
			const shownDiff = maxDiff === 0 ? diffLines : diffLines.slice(0, maxDiff);
			for (const l of shownDiff) {
				if (l.startsWith("+") && !l.startsWith("+++"))
					out += `\n${fg("toolDiffAdded", l)}`;
				else if (l.startsWith("-") && !l.startsWith("---"))
					out += `\n${fg("toolDiffRemoved", l)}`;
				else out += `\n${fg("toolDiffContext", l)}`;
			}
			if (!expanded && diffLines.length > maxDiff)
				out += `\n${fg("muted", `… ${diffLines.length - maxDiff} more diff lines (ctrl+o to expand)`)}`;
			out +=
				`\n${fg("success", `+${add}`)}${fg("dim", " / ")}${fg("error", `-${rem}`)}${fg("dim", " lines")}`;
			break;
		}
		case "write": {
			if (isError) {
				out = fg("error", `✗ ${text.trim() || "Write failed"}`);
				break;
			}
			const diff: string = details?.diff ?? "";
			if (!diff) {
				out = fg("success", "Written");
				break;
			}
			let add = 0, rem = 0;
			const diffLines = diff.split("\n");
			for (const l of diffLines) {
				if (l.startsWith("+") && !l.startsWith("+++")) add++;
				else if (l.startsWith("-") && !l.startsWith("---")) rem++;
			}
			const maxDiff = expanded ? 0 : 24;
			const shownDiff = maxDiff === 0 ? diffLines : diffLines.slice(0, maxDiff);
			for (const l of shownDiff) {
				if (l.startsWith("+") && !l.startsWith("+++"))
					out += `\n${fg("toolDiffAdded", l)}`;
				else if (l.startsWith("-") && !l.startsWith("---"))
					out += `\n${fg("toolDiffRemoved", l)}`;
				else out += `\n${fg("toolDiffContext", l)}`;
			}
			if (!expanded && diffLines.length > maxDiff)
				out += `\n${fg("muted", `… ${diffLines.length - maxDiff} more diff lines (ctrl+o to expand)`)}`;
			out +=
				`\n${fg("success", `+${add}`)}${fg("dim", " / ")}${fg("error", `-${rem}`)}${fg("dim", " lines")}`;
			break;
		}
		default:
			out = isError ? fg("error", "Error") : fg("success", "done");
	}

	if (expanded) {
		if (name !== "bash" && name !== "edit" && name !== "write") {
			const maxLines = 15;
			const all = text.split("\n");
			for (const l of all.slice(0, maxLines)) out += `\n${fg("dim", l)}`;
			if (all.length > maxLines)
				out += `\n${fg("muted", `… ${all.length - maxLines} more lines`)}`;
		}
	}
	return out;
}
