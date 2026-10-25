import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { cycle, LANG_CHOICES, saveConfig, type Config } from "../config.ts";
import type { Engine } from "../engine.ts";
import { t, type Key } from "../i18n.ts";
import type { IconName, Icons } from "../icons.ts";
import { type PiSettings, readPiSettings, writePiSetting } from "../pi-config.ts";
import { type Action, fmtDur, Frame, pad, Row, type Shared, type View } from "./frame.ts";
import { HistoryView } from "./history-view.ts";
import { ModelsView } from "./models-view.ts";
import { OverviewView } from "./overview.ts";

const TABS: { label: Key; icon: IconName }[] = [
	{ label: "tab_overview", icon: "sliders" },
	{ label: "tab_history", icon: "chart" },
	{ label: "tab_models", icon: "layers" },
];

const MAX_WIDTH = 96;
const MIN_WIDTH = 60;

const termCols = () => process.stdout.columns || 100;
const termRows = () => process.stdout.rows || 40;

export function panelWidth(): number {
	const cols = termCols();
	return Math.max(Math.min(MIN_WIDTH, cols - 2), Math.min(MAX_WIDTH, cols - 6));
}

/** Body rows: compact, and the same on every tab so the panel never jumps. */
function bodyRows(): number {
	return Math.max(14, Math.min(26, termRows() - 10));
}

export async function openPanel(ctx: ExtensionCommandContext, pi: ExtensionAPI, engine: Engine, icons: Icons, tab = 0): Promise<void> {
	const reload = await ctx.ui.custom<boolean>(
		(tui, theme, _kb, done) => new Panel(tui, theme, ctx, pi, engine, icons, tab, done),
		{ overlay: true, overlayOptions: () => ({ anchor: "center", width: panelWidth(), maxHeight: termRows() - 1 }) },
	);
	if (reload) {
		await ctx.waitForIdle();
		await ctx.reload();
	}
}

interface Hit {
	y: number;
	x0: number;
	x1: number;
	action: Action;
}

const clone = (c: Config): Config => JSON.parse(JSON.stringify(c));

export class Panel {
	private tab: number;
	private views: View[];
	private models: ModelsView;
	private notice?: { text: string; ok: boolean; at: number };
	private timer: ReturnType<typeof setInterval>;
	private unlisten: () => void;
	private needsReload = false;
	private shared: Shared;
	private hits: Hit[] = [];
	private draft: Config;
	private pi: PiSettings;
	private piSaved: PiSettings;
	private escArmed = 0;

	constructor(
		private tui: any,
		private theme: any,
		ctx: ExtensionCommandContext,
		piApi: ExtensionAPI,
		private engine: Engine,
		private icons: Icons,
		tab: number,
		private done: (reload: boolean) => void,
	) {
		this.tab = tab;
		this.draft = clone(engine.cfg);
		this.piSaved = readPiSettings();
		this.pi = { ...this.piSaved };
		const self = this;
		this.shared = {
			theme,
			engine,
			icons,
			ctx,
			pi: piApi,
			tr: (key, vars) => t(self.engine.lang, key, vars),
			icon: (name, token, slot, cols = 1, token2 = "warning") => self.icons.icon(self.theme, name, token, slot, cols, 1, token2),
			notify: (text, ok = true) => {
				self.notice = { text, ok, at: Date.now() };
				self.tui.requestRender();
			},
			cfg: () => self.draft,
			update: (patch) => {
				self.draft = { ...self.draft, ...patch };
			},
			pref: (patch) => {
				self.draft = { ...self.draft, ...patch };
				const next = { ...self.engine.cfg, ...patch };
				saveConfig(next);
				self.engine.setConfig(next);
			},
			piDraft: () => self.pi,
			piSaved: () => self.piSaved,
			setPi: (patch) => {
				self.pi = { ...self.pi, ...patch };
			},
			save: () => self.save(),
			render: () => self.tui.requestRender(),
			switchTab: (i) => {
				self.tab = i;
			},
		};
		this.models = new ModelsView(this.shared);
		const editModel = (model: any, enable: boolean) => {
			this.models.edit(model, enable);
			this.tab = 2;
		};
		const history = new HistoryView(this.shared);
		const showRecord = (at: number) => {
			history.show(at);
			this.tab = 1;
		};
		this.views = [new OverviewView(this.shared, editModel, showRecord), history, this.models];
		this.timer = setInterval(() => this.tui.requestRender(), 1000);
		this.timer.unref?.();
		this.unlisten = engine.listen(() => this.tui.requestRender());
		// Test hook: feed keys after opening, e.g. CACHE_WARM_PLUS_KEYS='["\u001b[B","\r"]'.
		const keys = process.env.CACHE_WARM_PLUS_KEYS;
		if (keys) {
			try {
				(JSON.parse(keys) as string[]).forEach((k, i) => setTimeout(() => this.handleInput(k), 600 + i * 150));
			} catch {
				/* ignore malformed test input */
			}
		}
	}

	private get view(): View {
		return this.views[this.tab]!;
	}

	/** Unsaved plugin settings, pi settings or model-editor changes. */
	dirty(): boolean {
		const { lang: _a, historyRange: _b, ...draft } = this.draft;
		const { lang: _c, historyRange: _d, ...saved } = this.engine.cfg;
		return (
			JSON.stringify(draft) !== JSON.stringify(saved) ||
			this.pi.cacheWarming !== this.piSaved.cacheWarming ||
			this.views.some((v) => v.dirty?.())
		);
	}

	async save(): Promise<void> {
		const tr = this.shared.tr;
		try {
			// The model editor writes models.json and folds its switches into the draft first.
			for (const v of this.views) if (v.dirty?.() && v.save && !(await v.save())) return;
			saveConfig(this.draft);
			this.engine.setConfig(clone(this.draft));
			if (this.pi.cacheWarming !== this.piSaved.cacheWarming) {
				writePiSetting("cacheWarming", this.pi.cacheWarming);
				this.piSaved = { ...this.pi };
				this.needsReload = true;
			}
			this.shared.notify(tr(this.needsReload ? "n_saved_reload" : "n_saved"), true);
		} catch (err) {
			this.shared.notify(tr("n_save_failed", { err: err instanceof Error ? err.message : String(err) }), false);
		}
		this.tui.requestRender();
	}

	private close() {
		this.dispose();
		this.done(this.needsReload);
	}

	/** Esc: leave a sub-view first; with unsaved changes ask for a second Esc. */
	private escape() {
		if (this.view.back?.()) return;
		if (this.dirty() && Date.now() - this.escArmed > 4000) {
			this.escArmed = Date.now();
			this.shared.notify(this.shared.tr("n_unsaved_close"), false);
			return;
		}
		this.close();
	}

	dispose() {
		clearInterval(this.timer);
		this.unlisten();
	}

	invalidate() {
		this.icons.reset();
	}

	private switchTab(dir: 1 | -1) {
		this.tab = (this.tab + dir + TABS.length) % TABS.length;
	}

	handleInput(data: string): void {
		const v = this.view;
		if (matchesKey(data, "ctrl+c")) return this.close();
		if (v.captures?.()) {
			if (matchesKey(data, "escape")) v.back?.();
			else v.handleInput(data);
		} else if (matchesKey(data, "escape")) this.escape();
		else if (matchesKey(data, "ctrl+s")) void this.save();
		else if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) this.switchTab(-1);
		else if (matchesKey(data, "right") || matchesKey(data, "tab")) this.switchTab(1);
		else if (data === "1" || data === "2" || data === "3") this.tab = Number(data) - 1;
		else if (data === "q" || data === "Q") this.escape();
		else if (data === "l" || data === "L") this.cycleLang();
		else if (!v.handleInput(data)) return;
		this.tui.requestRender();
	}

	handleMouse(e: { type: string; button: string; x: number; y: number; wheelDelta?: number }) {
		if (e.type === "wheel" && e.wheelDelta) {
			this.view.scroll?.(e.wheelDelta < 0 ? -1 : 1);
			return { handled: true, render: true };
		}
		if (e.type === "click" && e.button === "left") {
			for (let i = this.hits.length - 1; i >= 0; i--) {
				const h = this.hits[i]!;
				if (h.y === e.y && e.x >= h.x0 && e.x < h.x1) {
					h.action();
					return { handled: true, render: true };
				}
			}
		}
		// Swallow everything else inside the panel (no transcript selection underneath).
		return { handled: true, render: false };
	}

	private cycleLang() {
		this.shared.pref({ lang: cycle(LANG_CHOICES, this.engine.cfg.lang, 1) });
	}

	render(width: number): string[] {
		const th = this.theme;
		const tr = this.shared.tr;
		const icon = this.shared.icon;
		const out: string[] = [];
		const hits: Hit[] = [];
		const W = width - 4;
		const b = (s: string) => th.fg("borderAccent", s);
		const line = (r: Row, y: number) => {
			for (const h of r.hits) hits.push({ y, x0: h.x0 + 2, x1: h.x1 + 2, action: h.action });
			return `${b("│")} ${pad(r.text, W)} ${b("│")}`;
		};

		// ── header: logo · tabs · unsaved / state ──
		out.push(b(`╭${"─".repeat(width - 2)}╮`));
		const head = new Row().add(icon("logo", "error", "hdr:logo")).add(" ").add(th.bold(th.fg("accent", tr("title")))).add("   ");
		TABS.forEach((tb, i) => {
			const active = i === this.tab;
			const chip = `${icon(tb.icon, active ? "accent" : "muted", `tab:${i}:${active}`)} ${tr(tb.label)} `;
			head.add(active ? th.bg("selectedBg", th.bold(th.fg("accent", ` ${chip}`))) : th.fg("muted", ` ${chip}`), () => (this.tab = i));
			head.add(" ");
		});
		let right: string;
		let rightAction: Action | undefined;
		if (this.dirty()) {
			right = `${icon("dot", "warning", "hdr:dirty", 2)}${th.fg("warning", tr("unsaved_save"))}`;
			rightAction = () => void this.save();
		} else {
			const st = this.engine.status(this.shared.ctx.model);
			const live = st.state === "scheduled" || st.state === "busy";
			const tone = st.asking ? "warning" : live ? "success" : st.state === "stopped" ? "warning" : "dim";
			const text = st.asking
				? `${tr("ask_waiting")}${st.nextAt ? ` ${fmtDur(st.nextAt - Date.now())}` : ""}`
				: st.state === "scheduled" && st.nextAt
					? `${tr("state_scheduled")} ${fmtDur(st.nextAt - Date.now())}`
					: tr((st.state === "stopped" ? "state_stopped_short" : `state_${st.state}_short`) as Key) || tr(`state_${st.state}` as Key);
			right = `${icon(live ? "dot" : "ring", tone, "hdr:pill", 2)}${th.fg(tone, text)}`;
			rightAction = () => (this.tab = 0);
		}
		if (head.width + visibleWidth(right) + 2 <= W) head.right(right, W, rightAction);
		out.push(line(head, 1));
		out.push(b(`├${"─".repeat(width - 2)}┤`));

		// ── body ──
		const rows = bodyRows();
		const f = new Frame(th, width);
		this.view.render(f, rows);
		const body = f.lines.slice(0, rows);
		while (body.length < rows) body.push(f.wrap(""));
		const y0 = out.length;
		for (const h of f.hits) if (h.y < rows) hits.push({ y: y0 + h.y, x0: h.x0 + 2, x1: h.x1 + 2, action: h.action });
		out.push(...body);

		// ── footer: help or notice · language ──
		out.push(b(`├${"─".repeat(width - 2)}┤`));
		if (this.notice && Date.now() - this.notice.at > 6000) this.notice = undefined;
		const lang = this.engine.lang === "zh" ? "中文" : "EN";
		const langChip = `${icon("globe", "muted", "ft:lang", 2)}${th.fg("muted", lang)}`;
		const foot = new Row();
		const room = W - visibleWidth(langChip) - 2;
		if (this.notice) {
			const n = this.notice;
			foot.add(icon(n.ok ? "check" : "alert", n.ok ? "success" : "warning", "ft:notice")).add(" ");
			foot.add(th.fg(n.ok ? "success" : "warning", pad(n.text, room - 3)));
		} else foot.add(th.fg("muted", pad(this.view.help(), room)));
		foot.right(langChip, W, () => this.cycleLang());
		out.push(line(foot, out.length));

		// Key hints live in the bottom border.
		const hint = ` ${th.fg("dim", truncateToWidth(tr(this.view.captures?.() ? "keys_typing" : "keys_main"), width - 8))} `;
		const fill = Math.max(0, width - 4 - visibleWidth(hint));
		out.push(b("╰─") + hint + b(`${"─".repeat(fill)}─╯`));

		this.hits = hits;
		return out;
	}
}
