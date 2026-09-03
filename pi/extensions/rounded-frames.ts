/**
 * rounded-frames.ts
 *
 * Restyles the built-in tool-call boxes:
 *   - renderShell:"self"  → pi drops its default Box (toolPendingBg), so the
 *     tool call sits on the terminal's *standard* background instead of a
 *     solid black/colored fill.
 *   - A one-line rounded title bar  ╭─ read ─────╮  in the border color, with
 *     the tool name in the accent color, plus a matching bottom bar  ╰───╯.
 *
 * How it works (per the official built-in-tool-renderer example):
 *   Each built-in tool is re-registered under the same name. execute() is
 *   delegated to the original tool so behaviour is unchanged. renderShell is
 *   "self", so pi composes the components returned by renderCall/renderResult
 *   onto a bare Container with NO background. We return a small custom
 *   Component that draws the rounded frame in its render(width) — every line
 *   is truncated to `width`, so the TUI can never overflow (the old
 *   monkey-patch version wrapped pi's already-full-width lines and crashed
 *   with "rendered line exceeds terminal width").
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
} from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Container, Text, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

const CWD = process.cwd();

/** Minimal replacement for pi's internal resolveToCwd (not publicly exported). */
function resolvePath(p: string, cwd: string): string {
	return isAbsolute(p) ? p : resolve(cwd, p);
}

/**
 * The stock write tool reports `details: undefined`, so no diff is available.
 * Read the file (if it exists) BEFORE delegating to the original execute, then
 * compute the same generateDiffString(editContent, writeContent) the edit tool
 * uses, and attach it to the result as details.diff. New files diff against ""
 * (everything is an addition), mirroring an "Applied" overwrite view.
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
		oldContent = ""; // file doesn't exist yet — new file
	}
	const result = await execute(toolCallId, { path, content }, signal, onUpdate);
	if (result && !result.isError && typeof content === "string") {
		try {
			const { diff } = generateDiffString(oldContent, content);
			result.details = { ...(result.details as object | undefined), diff };
		} catch {
			// diff generation failed — leave details alone, box shows "Written"
		}
	}
	return result;
}

function safeStringify(v: any): string {
	try {
		return v ? JSON.stringify(v) : "";
	} catch {
		return "";
	}
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
	// Direct background hex (e.g. "#202123") so the fill matches the theme's
	// user-message bg even when the color name isn't in the theme's bg map.
	private bgHex?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		title: string,
		body: string,
		theme: Theme,
		borderName = "border",
		bgHex?: string,
	) {
		this.title = title;
		this.body = body;
		this.theme = theme;
		this.borderName = borderName;
		this.bgHex = bgHex;
	}

	handleInput?(): void {}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedLines = this.paint(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}

	private paint(width: number): string[] {
		const w = Math.max(10, width);
		const theme = this.theme;
		// Safe color helpers: theme.fg/bg THROW on unknown color names. A throw
		// inside renderResult makes pi drop our box and fall back to raw output
		// (the "box disappeared" bug). So wrap and fall back to plain text.
		const fg = (name: string, s: string): string => {
			try {
				return theme.fg(name, s);
			} catch {
				return s;
			}
		};
		const border = (s: string) => fg(this.borderName, s);
		// Apply a direct 24-bit background (hex) so the fill always matches
		// the theme's user-message bg, independent of the theme's bg color map.
		let bgOpen = "", bgClose = "";
		if (this.bgHex) {
			const rgb = hexToRgb(this.bgHex);
			if (rgb) {
				bgOpen = `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m`;
				bgClose = "\x1b[49m";
			}
		}
		const applyBg = (s: string) => (bgOpen ? `${bgOpen}${s}${bgClose}` : s);

		// Build each line padded to the FULL width `w`, then wrap the ENTIRE line
		// in the bg so the whole rectangle is filled — matching the user-message
		// box (which fills every cell edge-to-edge), not just the interior.
		const fillLine = (content: string, width: number): string => {
			const clipped = truncateToWidth(content, width);
			const pad = Math.max(0, width - visibleWidth(clipped));
			return applyBg(`${clipped}${" ".repeat(pad)}`);
		};

		// Top: ╭─ title ──────╮  (title NOT bold)
		const label = ` ${fg("accent", this.title)} `;
		const topFill = Math.max(0, w - 2 - visibleWidth(label));
		const top = fillLine(`${border("╭")}${label}${border("─".repeat(topFill))}${border("╮")}`, w);
		const lines: string[] = [top];

		// Body: │ content │  (two inner padding cells, so budget is w-4)
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

export default function (pi: ExtensionAPI) {
	for (const [name, factory] of Object.entries(BUILT_INS)) {
		const original = factory(CWD);

		pi.registerTool({
			name,
			label: name,
			description: original.description,
			parameters: original.parameters,
			renderShell: "self",

			// Delegate execution to the untouched original tool. write gets
			// extra wrapping so its result carries a details.diff like edit.
			async execute(toolCallId, params, signal, onUpdate) {
				if (name === "write") {
					const p = (params as any)?.path as string | undefined;
					const c = (params as any)?.content;
					if (p && typeof c === "string") {
						// The original execute already serializes via pi's file
						// mutation queue, so this wrapper only needs to capture the
						// pre-write content and compute the diff afterwards.
						return executeWriteWithDiff(p, c, original.execute, toolCallId, signal, onUpdate);
					}
				}
				return original.execute(toolCallId, params, signal, onUpdate);
			},

			// pi always renders BOTH the call and (once available) the result
			// component. To show exactly ONE box: while running, draw a BLUE box
			// here; once the result is complete, return an EMPTY component so
			// only the grey result box below is visible.
			renderCall(args: any, theme: Theme, context: any) {
				try {
					// isPartial is true while running / streaming, false once done.
					if (!context?.isPartial) return new Container();
					const body = formatArgs(name, args, theme) + theme.fg("muted", "  (running…)");
					return new RoundedFrame(name, body, theme, "borderAccent");
				} catch {
					return new Text(`${name} ${safeStringify(args)}`, 0, 0);
				}
			},

			// Complete: the single rounded box, on the user-message background.
			// Body shows just the args (path/command) + the result summary.
			renderResult(result: any, opts: any, theme: Theme, context: any) {
				try {
					const resultBody = formatResult(
						name,
						result,
						theme,
						opts?.expanded,
						opts?.isPartial,
						context?.args,
					);
					// For bash, the command + output are already inside the box, so
				// skip the separate arg line to avoid a redundant duplicate.
					const argLine = name === "bash" ? "" : formatArgs(name, context?.args, theme);
					const body = resultBody
						? argLine
							? `${argLine}\n${resultBody}`
							: resultBody
						: argLine;
					// No bg override: pi's self-shell already fills the tool region
					// with the message surface. The in-progress box (also no bg)
					// matched perfectly, so the complete box must not paint a darker
					// #202123 over it.
					return new RoundedFrame(name, body, theme, "border");
				} catch {
					// Never let a render error drop the box: show a plain line.
					return new Text(`${name} ${safeStringify(context?.args)}`, 0, 0);
				}
			},
		});
	}
}

// ── Compact arg/result formatting ────────────────────────────────────────────

function formatArgs(name: string, args: any, theme: Theme): string {
	// theme.fg throws on unknown color names; never let that kill the box.
	const fg = (c: string, s: string) => {
		try {
			return theme.fg(c, s);
		} catch {
			return s;
		}
	};
	if (!args) return "";
	switch (name) {
		case "read":
			return fg("accent", args.path ?? "");
		case "write":
		case "edit":
			return fg("accent", args.path ?? "");
		case "bash": {
			const cmd: string = args.command ?? "";
			return fg("accent", cmd.length > 80 ? cmd.slice(0, 77) + "…" : cmd);
		}
		case "find":
		case "grep":
			return fg("accent", (args.pattern ?? "") + (args.path ? `  ${args.path}` : ""));
		case "ls":
			return fg("accent", args.path ?? ".");
		default: {
			const s = JSON.stringify(args);
			return fg("dim", s.length > 80 ? s.slice(0, 77) + "…" : s);
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
): string {
	// theme.fg throws on unknown color names; wrap so a bad name never
	// crashes renderResult (which would make pi drop our box).
	const fg = (c: string, s: string): string => {
		try {
			return theme.fg(c, s);
		} catch {
			return s;
		}
	};
	// Print up to `max` lines of `text`; max <= 0 means "all". Returns [shown, more].
	const slice = (text: string, max: number): [string[], number] => {
		const all = text.split("\n");
		if (max <= 0) return [all, 0];
		const more = Math.max(0, all.length - max);
		return [all.slice(0, max), more];
	};
	if (isPartial) return fg("warning", "…");
	const text: string =
		result?.content?.[0]?.type === "text" ? result.content[0].text : "";
	const isError = result?.isError === true;
	const details = result?.details;

	let out = "";
	switch (name) {
		case "bash": {
			const command: string = (args?.command as string) ?? "";
			// Strip pi's truncation trailer / exit-status line from the output.
			const outText = text
				.split("\n\n[")[0]
				.split("\n\nCommand exited with code")[0]
				.split("\n\nCommand aborted")[0]
				.split("\n\nCommand timed out")[0]
				.trim();
			const m = text.match(/exit code (\d+)/) || text.match(/exited with code (\d+)/);
			const code = m ? m[1] : null;
			// No "done (N lines)" header — go straight to command + output. Only
			// show a status line when the command actually failed.
			if (code !== "0" && code !== null) {
				out = fg("error", `exit ${code}`);
			}

			// Input slice (the command).
			if (command) {
				out += (out ? "\n" : "") + `${fg("dim", "› ")}${fg("toolOutput", command)}`;
			}
			// Output slice — a few lines collapsed, all when expanded (ctrl+o).
			const maxOut = expanded ? 0 : 6; // 0 = all
			if (outText) {
				const [shown, more] = slice(outText, maxOut);
				for (const l of shown) out += `\n${fg("dim", l)}`;
				if (more > 0)
					out += `\n${fg("muted", `… ${more} more lines (ctrl+o to expand)`)}`;
			}
			if (!out) out = fg("success", "done"); // empty command + empty output
			break;
		}
		case "read": {
			const n = text ? text.split("\n").length : 0;
			out = fg("success", `${n} lines`);
			if (details?.truncation?.truncated)
				out += fg("warning", ` (truncated from ${details.truncation.totalLines})`);
			break;
		}
		case "write": {
			const diff = (details?.diff as string | undefined) ?? "";
			if (!diff) {
				out = text.startsWith("Error") ? fg("error", "Error") : fg("success", "Written");
				break;
			}
			// Same presentation as edit: colorized diff, then a +added/-removed tally.
			let add = 0,
				rem = 0;
			const diffLines = diff.split("\n");
			for (const l of diffLines) {
				if (l.startsWith("+") && !l.startsWith("+++")) add++;
				else if (l.startsWith("-") && !l.startsWith("---")) rem++;
			}
			const maxDiff = expanded ? 0 : 24; // 0 = all
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
		case "edit": {
			if (text.startsWith("Error") || (result?.details?.error as string | undefined)) {
				out = fg("error", text.split("\n")[0]);
				break;
			}
			const diff = (details?.diff as string | undefined) ?? "";
			if (!diff) {
				out = fg("success", "Applied");
				break;
			}
			// Show the diff (colorized), then a +added / -removed tally at the end.
			let add = 0, rem = 0;
			const diffLines = diff.split("\n");
			for (const l of diffLines) {
				if (l.startsWith("+") && !l.startsWith("+++")) add++;
				else if (l.startsWith("-") && !l.startsWith("---")) rem++;
			}
			const maxDiff = expanded ? 0 : 24; // 0 = all
			const shownDiff = maxDiff === 0 ? diffLines : diffLines.slice(0, maxDiff);
			for (const l of shownDiff) {
				if (l.startsWith("+") && !l.startsWith("+++"))
					out += `\n${fg("toolDiffAdded", l)}`;
				else if (l.startsWith("-") && !l.startsWith("---"))
					out += `\n${fg("toolDiffRemoved", l)}`;
				else out += `\n${fg("toolDiffContext", l)}`;
			}
			// Only hint at more lines when COLLAPSED; when expanded the whole
			// diff is shown, so no hint. Count the hidden lines, not all of them.
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
		// bash, edit and write already render their full content when expanded, so
		// we only add the raw output slice for the *other* tools.
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
