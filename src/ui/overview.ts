import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { textLifeBar } from "../chart.ts";
import { cycle, HOURS_CHOICES } from "../config.ts";
import { modelKey } from "../engine.ts";
import type { Key } from "../i18n.ts";
import type { IconName } from "../icons.ts";
import { CACHE_WARMING_MODES } from "../pi-config.ts";
import { filterEntries, readLog, withoutConversationFirst } from "../history.ts";
import { kindIcon, kindLabel } from "./history-view.ts";
import { fmtClock, fmtDur, fmtMoney, fmtTok, fmtTtl, type Frame, pad, padLeft, Row, type Shared, shortModel, type View, switchText } from "./frame.ts";

interface Setting {
	id: string;
	icon: IconName;
	label: Key;
	hint: Key;
	kind: "toggle" | "cycle" | "action";
	value: () => string | boolean;
	/** Saved value, to mark unsaved rows. */
	saved: () => string | boolean;
	change: (dir: 1 | -1) => void;
}

export class OverviewView implements View {
	private sel = 0;
	private settings: Setting[];

	constructor(
		private s: Shared,
		private editModel: (model: any, enable: boolean) => void,
		private showRecord: (at: number) => void,
	) {
		this.settings = this.build();
	}

	private build(): Setting[] {
		const s = this.s;
		const d = () => s.cfg();
		const saved = () => s.engine.cfg;
		const hours = (h: number) => (h ? `${h}h` : s.tr("unlimited"));
		return [
			{
				id: "enabled",
				icon: "power",
				label: "row_enabled",
				hint: "row_enabled_hint",
				kind: "toggle",
				value: () => d().enabled,
				saved: () => saved().enabled,
				change: () => s.update({ enabled: !d().enabled }),
			},
			{
				id: "ask",
				icon: "bell",
				label: "row_ask",
				hint: "row_ask_hint",
				kind: "toggle",
				value: () => d().askWarm,
				saved: () => saved().askWarm,
				change: () => s.update({ askWarm: !d().askWarm }),
			},
			{
				id: "economics",
				icon: "scale",
				label: "row_economics",
				hint: "row_economics_hint",
				kind: "toggle",
				value: () => d().ignoreEconomics,
				saved: () => saved().ignoreEconomics,
				change: () => s.update({ ignoreEconomics: !d().ignoreEconomics }),
			},
			{
				id: "duration",
				icon: "hourglass",
				label: "row_duration",
				hint: "row_duration_hint",
				kind: "cycle",
				value: () => hours(d().maxKeepWarmHours),
				saved: () => hours(saved().maxKeepWarmHours),
				change: (dir) => s.update({ maxKeepWarmHours: cycle(HOURS_CHOICES, d().maxKeepWarmHours, dir) }),
			},
			{
				id: "piMode",
				icon: "sliders",
				label: "row_pi_mode",
				hint: "row_pi_mode_hint",
				kind: "cycle",
				value: () => s.tr(`mode_${s.piDraft().cacheWarming}` as Key),
				saved: () => s.tr(`mode_${s.piSaved().cacheWarming}` as Key),
				change: (dir) => s.setPi({ cacheWarming: cycle(CACHE_WARMING_MODES, s.piDraft().cacheWarming, dir) }),
			},
			{
				id: "now",
				icon: "zap",
				label: "row_now",
				hint: "row_now_hint",
				kind: "action",
				value: () => "",
				saved: () => "",
				change: () => {
					s.notify(s.tr("state_busy"), true);
					void s.engine.warm(true).then((r) => s.notify(r.message, r.ok));
				},
			},
		];
	}

	private toggleTracked() {
		const m = this.s.ctx.model;
		if (!m) return;
		const key = modelKey(m);
		const models = this.s.cfg().models;
		if (!models.includes(key) && !this.s.engine.ttlMs(m)) return this.editModel(m, true);
		const set = new Set(models);
		set.has(key) ? set.delete(key) : set.add(key);
		this.s.update({ models: [...set] });
	}

	handleInput(data: string): boolean {
		const n = this.settings.length;
		const cur = this.settings[this.sel]!;
		if (matchesKey(data, "up")) this.sel = (this.sel - 1 + n) % n;
		else if (matchesKey(data, "down")) this.sel = (this.sel + 1) % n;
		else if (matchesKey(data, "enter") || matchesKey(data, "space")) cur.change(1);
		else if (data === "w" || data === "W") this.settings.find((x) => x.id === "now")!.change(1);
		else if (data === "t" || data === "T") this.toggleTracked();
		else return false;
		return true;
	}

	scroll(dir: 1 | -1) {
		this.sel = Math.max(0, Math.min(this.settings.length - 1, this.sel + dir));
	}

	help(): string {
		return this.s.tr(this.settings[this.sel]!.hint);
	}

	render(f: Frame, rows: number): void {
		const { theme: th, tr, icon, engine, ctx } = this.s;
		const st = engine.status(ctx.model);
		const now = Date.now();
		const W = f.inner;
		const draft = this.s.cfg();

		// Row 1: model, cache lifetime, subscription badge, keep-warm switch.
		const tracked = !!ctx.model && draft.models.includes(modelKey(ctx.model));
		const r1 = new Row().add(icon("cpu", "accent", "ov:cpu")).add(" ");
		r1.add(th.bold(ctx.model ? shortModel(modelKey(ctx.model)) : tr("none")));
		if (st.ttlMs) r1.add("  ").add(icon("database", "muted", "ov:ttl")).add(th.fg("muted", ` ${fmtTtl(st.ttlMs / 1000)}`));
		if (st.subscription) r1.add("  ").add(icon("crown", "warning", "ov:sub")).add(th.fg("warning", ` ${tr("sub_badge")}`));
		const sw = `${th.fg(tracked ? "success" : "dim", `${tr("keep_warm")} `)}${switchText(th, tr, tracked)}`;
		r1.right(sw, W, () => this.toggleTracked());
		f.push(r1);

		// Row 2: countdown, or what is missing and how to fix it.
		const r2 = new Row().add(icon("clock", st.nextAt ? "accent" : "muted", "ov:next")).add(" ");
		if (st.nextAt) {
			r2.add(th.fg("muted", `${tr("next_warm")} `)).add(th.bold(th.fg("success", fmtDur(st.nextAt - now))));
			if (st.asking) r2.add("   ").add(icon("bell", "warning", "ov:ask")).add(th.fg("warning", ` ${tr("ask_waiting_for", { d: fmtDur(now - (st.askSince ?? now)) })}`));
		} else {
			const tone = st.state === "stopped" || st.state === "nottl" || st.state === "thinking" ? "warning" : "muted";
			const key = (st.state === "stopped" ? `state_stopped_${st.stopKey ?? "broken"}` : `state_${st.state}`) as Key;
			r2.add(th.fg("muted", `${tr("next_warm")} `)).add(th.fg(tone, tr(key)));
			const fix: Record<string, [Key, () => void] | undefined> = {
				off: ["fix_enable", () => this.s.update({ enabled: true })],
				untracked: ["fix_track", () => this.toggleTracked()],
				nottl: ["fix_config", () => ctx.model && this.editModel(ctx.model, true)],
				stopped: ["fix_resume", () => this.s.notify(tr(engine.resume() ? "n_resumed" : "n_resume_failed"), true)],
			};
			const action = fix[st.state];
			if (action) r2.add("   ").add(`${icon("chevRight", "accent", "ov:fix", 1)}${th.fg("accent", tr(action[0]))}`, action[1]);
		}
		f.push(r2);

		// Row 3: cache life bar (text so it shows everywhere).
		const live = !!(st.ttlMs && st.lastTouch && (st.state === "scheduled" || st.state === "busy"));
		const remain = live ? Math.max(0, st.ttlMs! - (now - st.lastTouch!)) : undefined;
		const label = live ? th.fg("text", ` ${tr("left", { d: fmtDur(remain!) })}`) : th.fg("dim", ` ${tr("none")}`);
		const r3 = new Row().add(icon("hourglass", live ? "accent" : "muted", "ov:life")).add(" ");
		const barCols = Math.max(10, W - 3 - 12);
		r3.add(textLifeBar(th, barCols, live ? remain! / st.ttlMs! : undefined, 1 - draft.takeoverPct / 100)).add(label);
		f.push(r3);

		// Row 4: counters and the cost of each warm.
		const r4 = new Row();
		r4.add(icon("flame", "success", "ov:warms")).add(` ${tr("src_plugin")} ${st.pluginWarms} · ${tr("src_builtin")} ${st.builtinWarms}`);
		r4.add("   ").add(icon("coin", "warning", "ov:cost")).add(` ${tr("per_warm")} `);
		r4.add(st.estWarmCost !== undefined ? th.bold(fmtMoney(st.estWarmCost)) : th.fg("dim", tr("none")));
		if (st.subscription) r4.add(th.fg("warning", ` (${tr("sub_reads_free")})`));
		if (st.last) {
			const l = st.last;
			r4.add("   ").add(icon(l.ok ? "check" : "cross", l.ok ? "success" : "error", "ov:last"));
			r4.add(` ${tr("last_warm", { d: fmtDur(now - l.at), cost: fmtMoney(l.cost) })}`);
			if (l.ask) r4.add(th.fg("warning", ` · ${tr("tag_ask")}`));
		}
		f.push(r4);

		f.rule();

		// Settings (changes are drafts until Ctrl+S).
		const labelW = Math.max(...this.settings.map((x) => visibleWidth(tr(x.label)))) + 3;
		this.settings.forEach((x, i) => {
			const selected = i === this.sel;
			const activate = (dir: 1 | -1) => () => {
				this.sel = i;
				x.change(dir);
			};
			const r = new Row().add(icon(x.icon, selected ? "accent" : "muted", `set:${x.id}:${selected}`)).add(" ");
			r.add(selected ? th.bold(th.fg("accent", tr(x.label))) : tr(x.label)).to(3 + labelW);
			const v = x.value();
			if (x.kind === "toggle") {
				const on = v === true;
				r.add(switchText(th, tr, on));
			} else if (x.kind === "cycle") {
				r.add(icon("chevLeft", "accent", `set:${x.id}:l`, 1), activate(-1));
				r.add(th.fg("accent", ` ${v} `));
				r.add(icon("chevRight", "accent", `set:${x.id}:r`, 1), activate(1));
			} else if (selected) r.add(th.fg("dim", tr("press_enter")));
			if (x.kind !== "action" && v !== x.saved()) r.add(th.fg("warning", "  *"));
			f.push(r, { selected, onRow: activate(1) });
		});

		// Recent warms fill the remaining height; click one for its details.
		const room = rows - f.lines.length - 1;
		if (room < 2) return;
		f.rule(th.fg("muted", tr("recent")));
		let session: string | undefined;
		try {
			session = ctx.sessionManager.getSessionId();
		} catch {
			session = undefined;
		}
		const recentLog = filterEntries(
			withoutConversationFirst(readLog()),
			draft.historyRange,
			draft.historyFilter,
			{ session, model: ctx.model ? modelKey(ctx.model) : undefined },
			now,
		);
		const recent = recentLog.slice(-room).reverse();
		if (!recent.length) f.push(th.fg("dim", tr("hist_empty")));
		const modelW = Math.max(10, W - 3 - 10 - 10 - 9 - 11 - 6);
		recent.forEach((e, i) => {
			const [ic, tok] = kindIcon(e);
			const r = new Row()
				.add(icon(ic, tok, `ov:rec:${i}:${ic}:${tok}`))
				.add(" ")
				.add(pad(fmtClock(e.at), 10))
				.add(th.fg(tok, pad(kindLabel(tr, e), 10)))
				.add(pad(shortModel(e.model), modelW))
				.add(th.fg("muted", padLeft(e.kind === "stop" ? "" : fmtTok(e.read), 9)))
				.add(th.bold(padLeft(e.kind === "stop" ? "" : fmtMoney(e.cost), 11)))
				.add(e.ask ? th.fg("warning", `  ${tr("tag_ask")}`) : "")
				.to(W - 1)
				.add(icon("chevRight", "dim", `ov:rec:more:${i}`, 1));
			f.push(r, { onRow: () => this.showRecord(e.at) });
		});
	}
}
