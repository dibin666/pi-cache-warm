import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.ts";
import type { Engine } from "../engine.ts";
import type { Key } from "../i18n.ts";
import type { IconName, Icons } from "../icons.ts";
import type { PiSettings } from "../pi-config.ts";

export type Theme = any;
export type Action = () => void;

export interface Shared {
	theme: Theme;
	engine: Engine;
	icons: Icons;
	ctx: ExtensionCommandContext;
	pi: ExtensionAPI;
	tr(key: Key, vars?: Record<string, string | number>): string;
	icon(name: IconName, token: string, slot: string, cols?: number, token2?: string): string;
	notify(text: string, ok?: boolean): void;
	/** Draft configuration shown in the panel; persisted with Ctrl+S. */
	cfg(): Config;
	/** Change the draft (needs Ctrl+S). */
	update(patch: Partial<Config>): void;
	/** View preferences (language, history range) apply immediately. */
	pref(patch: Partial<Config>): void;
	/** Draft of pi's own settings.json values. */
	piDraft(): PiSettings;
	piSaved(): PiSettings;
	setPi(patch: Partial<PiSettings>): void;
	save(): Promise<void>;
	render(): void;
	switchTab(i: number): void;
}

export interface View {
	render(f: Frame, rows: number): void;
	/** Returns true when the key was consumed. */
	handleInput(data: string): boolean;
	/** Contextual description of the focused item. */
	help(): string;
	/** While true (e.g. typing a number) every key goes to the view. */
	captures?(): boolean;
	/** Unsaved changes held by the view itself (the model editor). */
	dirty?(): boolean;
	/** Persist the view's own changes (called by Ctrl+S before the panel saves). */
	save?(): Promise<boolean>;
	/** Esc inside the view; return true when handled (e.g. closing a sub-view). */
	back?(): boolean;
	/** Mouse wheel: -1 up, +1 down. */
	scroll?(dir: 1 | -1): void;
}

export function pad(s: string, w: number): string {
	const c = truncateToWidth(s, Math.max(0, w));
	return c + " ".repeat(Math.max(0, w - visibleWidth(c)));
}

export function padLeft(s: string, w: number): string {
	const c = truncateToWidth(s, Math.max(0, w));
	return " ".repeat(Math.max(0, w - visibleWidth(c))) + c;
}

/** On/off switch shown as plain text: bold green when on, dim when off. */
export function switchText(th: Theme, tr: Shared["tr"], on: boolean): string {
	return on ? th.bold(th.fg("success", tr("on"))) : th.fg("dim", tr("off"));
}

/** One content row built from segments; segments with an action become click targets. */
export class Row {
	text = "";
	width = 0;
	hits: { x0: number; x1: number; action: Action }[] = [];

	add(s: string, action?: Action): this {
		const w = visibleWidth(s);
		if (action && w > 0) this.hits.push({ x0: this.width, x1: this.width + w, action });
		this.text += s;
		this.width += w;
		return this;
	}

	/** Move to absolute column `col` (no-op when already past it). */
	to(col: number): this {
		if (col > this.width) this.add(" ".repeat(col - this.width));
		return this;
	}

	/** Right-align `s` so that it ends at column `end`. */
	right(s: string, end: number, action?: Action): this {
		return this.to(end - visibleWidth(s)).add(s, action);
	}
}

/**
 * Collects body lines plus click targets. Coordinates are recorded relative to the body:
 * row index in `lines`, column from the first content column.
 */
export class Frame {
	readonly inner: number;
	lines: string[] = [];
	hits: { y: number; x0: number; x1: number; action: Action }[] = [];

	constructor(
		readonly theme: Theme,
		readonly width: number,
	) {
		this.inner = width - 4;
	}

	b(s: string): string {
		return this.theme.fg("borderAccent", s);
	}

	wrap(content: string, selected = false): string {
		let c = pad(content, this.inner);
		if (selected) c = this.theme.bg("selectedBg", c);
		return `${this.b("│")} ${c} ${this.b("│")}`;
	}

	/** Push a row. `onRow` makes the whole row clickable (segments still take precedence). */
	push(row: Row | string, opts: { selected?: boolean; onRow?: Action } = {}) {
		const y = this.lines.length;
		const r = typeof row === "string" ? new Row().add(row) : row;
		if (opts.onRow) this.hits.push({ y, x0: 0, x1: this.inner, action: opts.onRow });
		for (const h of r.hits) this.hits.push({ y, ...h });
		this.lines.push(this.wrap(r.text, opts.selected));
	}

	rule(title?: string): void {
		if (!title) {
			this.lines.push(this.b(`├${"─".repeat(this.width - 2)}┤`));
			return;
		}
		const t = ` ${title} `;
		const fill = Math.max(0, this.width - 4 - visibleWidth(t));
		this.lines.push(this.b("├──") + t + this.b(`${"─".repeat(fill)}┤`));
	}
}

// ── formatting ──────────────────────────────────────────────────────────────

export function fmtDur(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (d > 0) return `${d}d${String(h).padStart(2, "0")}h`;
	if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m${String(sec).padStart(2, "0")}s`;
	return `${sec}s`;
}

export function fmtTtl(sec: number | undefined): string {
	if (!sec) return "—";
	if (sec % 86400 === 0) return `${sec / 86400}d`;
	if (sec % 3600 === 0) return `${sec / 3600}h`;
	if (sec % 60 === 0) return `${sec / 60}m`;
	return `${sec}s`;
}

export function fmtTok(n: number): string {
	if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(Math.round(n));
}

export function fmtMoney(n: number): string {
	if (!n) return "$0";
	if (n < 0.001) return `$${n.toFixed(6).replace(/0+$/, "")}`;
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

export function fmtPrice(n: number | undefined): string {
	return n === undefined ? "—" : `$${Number(n.toFixed(4))}`;
}

export function fmtClock(at: number, withDate = false): string {
	const d = new Date(at);
	const p = (x: number) => String(x).padStart(2, "0");
	const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
	return withDate ? `${p(d.getMonth() + 1)}-${p(d.getDate())} ${time.slice(0, 5)}` : time;
}

export function shortModel(key: string): string {
	return key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
}
