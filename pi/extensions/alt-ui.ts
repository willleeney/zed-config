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
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Container, Text, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";


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
	) {
		this.title = title;
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
		const label = ` ${fg(this.titleName, this.title)} `;
		const topFill = Math.max(0, w - 2 - visibleWidth(label));
		const top = fillLine(`${border("╭")}${label}${border("─".repeat(topFill))}${border("╮")}`, w);
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
		const bottom = fillLine(`${border("╰")}${border("─".repeat(Math.max(1, w - 2)))}${border("╯")}`, w);
		lines.push(bottom);
		return lines;
	}
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

// ── Built-in tool registration & ToolExecutionComponent patching ─────────────

export default function (pi: ExtensionAPI) {
	// 1. Re-register built-in tools with specialized formatting
	for (const [name, factory] of Object.entries(BUILT_INS)) {
		const original = factory(CWD);

		pi.registerTool({
			name,
			label: name,
			description: original.description,
			parameters: original.parameters,
			renderShell: "self",

			async execute(toolCallId, params, signal, onUpdate) {
				if (name === "write") {
					const p = (params as any)?.path as string | undefined;
					const c = (params as any)?.content;
					if (p && typeof c === "string") {
						return executeWriteWithDiff(p, c, original.execute, toolCallId, signal, onUpdate);
					}
				}
				return original.execute(toolCallId, params, signal, onUpdate);
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
					// bash normally hides the command (its output is the point), but on a
					// failure show it so the command that failed is visible.
					const argLine =
						name === "bash" && !isErr
							? ""
							: formatArgs(name, context?.args, theme, isErr ? ALT_UI_CONFIG.errorArgs : ALT_UI_CONFIG.successArgs);
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
					);
				} catch {
					return new Text(`${name} ${safeStringify(context?.args)}`, 0, 0);
				}
			},
		});
	}

	// 2. Patch ToolExecutionComponent so all other tools (StackOne execute_action,
	//    search_actions, list_accounts, MCP tools) get the exact same RoundedFrame format!
		// Make AssistantMessageComponent expandable so Pi's setToolsExpanded (Ctrl+O)
	// applies globally to ALL thinking blocks as well as all tool outputs.
	const assistantProto = AssistantMessageComponent.prototype as any;
	if (assistantProto && !assistantProto.__altUiExpandedPatched) {
		assistantProto.__altUiExpandedPatched = true;
		assistantProto.setExpanded = function (expanded: boolean) {
			this.__thinkingExpanded = expanded;
			if (typeof (globalThis as any).__setAllThinkingExpanded === "function") {
				(globalThis as any).__setAllThinkingExpanded(expanded);
			}
			if (this.lastMessage) {
				try {
					this.updateContent(this.lastMessage);
				} catch {
					// ignore
				}
			}
		};
	}

	const proto = ToolExecutionComponent.prototype as any;
	if (proto && !proto.__altUiPatched) {
		proto.__altUiPatched = true;

		const origHasRendererDefinition = proto.hasRendererDefinition;
		const origGetRenderShell = proto.getRenderShell;
		const origGetCallRenderer = proto.getCallRenderer;
		const origGetResultRenderer = proto.getResultRenderer;

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
				return new RoundedFrame(title, body, theme, isErr ? ALT_UI_CONFIG.errorBorder : ALT_UI_CONFIG.successBorder, isErr ? ALT_UI_CONFIG.errorTitle : ALT_UI_CONFIG.successTitle);
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
			return fg(argColor, cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd);
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
			// A non-zero exit is a failure even when the tool itself did not set
			// isError, so parse the trailer pi appends to the output.
			const exitMatch = text.match(/Command exited with code (\d+)/);
			const exitCode = exitMatch ? Number(exitMatch[1]) : 0;
			const failed = isError || exitCode > 0;
			const failLine = fg("error", `✗ Command failed${exitCode ? ` (exit ${exitCode})` : ""}`);
			const outText = text
				.replace(/\n\nCommand exited with code \d+.*$/s, "")
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
