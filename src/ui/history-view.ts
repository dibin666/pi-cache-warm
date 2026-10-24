import { matchesKey } from "@earendil-works/pi-tui";
import { chartBuckets, SERIES, SERIES_TOKEN, textChart } from "../chart.ts";
import { RANGE_CHOICES, type HistoryRange } from "../config.ts";
import { costOf, priceOf } from "../engine.ts";
import { bucketize, clearLog, filterEntries, type LogEntry, RANGE_MS, readLog, summarize } from "../history.ts";
import type { Key } from "../i18n.ts";
import type { IconName } from "../icons.ts";
import { fmtClock, fmtDur, fmtMoney, fmtTok, type Frame, pad, padLeft, Row, type Shared, shortModel, type View } from "./frame.ts";

export function kindIcon(e: LogEntry): [IconName, string] {
	if (e.kind === "rebuild") return ["alert", SERIES_TOKEN.rebuild];
	if (e.kind === "stop") return ["pause", "muted"];
	if (!e.ok) return ["cross", "error"];
	if (e.source === "manual") return ["zap", SERIES_TOKEN.manual];
	if (e.source === "builtin") return ["sliders", SERIES_TOKEN.builtin];
	return ["flame", SERIES_TOKEN.plugin];
}

export function kindLabel(tr: Shared["tr"], e: LogEntry): string {
	if (e.kind === "warm") return e.ok ? tr(`series_${e.source ?? "plugin"}` as Key) : tr("series_failed");
	return tr(`kind_${e.kind}` as Key);
}

function fullDate(at: number): string {
	const d = new Date(at);
	const p = (x: number) => String(x).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export class HistoryView implements View {
	private sel = 0;
	private top = 0;
	private clearArmed = 0;
	private list: LogEntry[] = [];
	/** Index into `list` of the record whose details are shown. */
	private detail?: number;

	constructor(private s: Shared) {}

	private get range(): HistoryRange {
		return this.s.cfg().historyRange;
	}

	private setRange(r: HistoryRange) {
		this.s.pref({ historyRange: r });
		this.sel = 0;
		this.top = 0;
		this.detail = undefined;
	}

	/** Open the details of a record on the next render, e.g. from the overview's recent list. */
	show(at: number) {
		this.pendingAt = at;
	}

	private pendingAt?: number;

	back(): boolean {
		if (this.detail === undefined) return false;
		this.detail = undefined;
		return true;
	}

	handleInput(data: string): boolean {
		const n = this.list.length;
		if (matchesKey(data, "up")) this.scroll(-1);
		else if (matchesKey(data, "down")) this.scroll(1);
		else if (matchesKey(data, "pageUp")) this.sel = Math.max(0, this.sel - 8);
		else if (matchesKey(data, "pageDown")) this.sel = Math.min(Math.max(0, n - 1), this.sel + 8);
		else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
			if (this.detail !== undefined) this.detail = undefined;
			else if (n) this.detail = this.sel;
		} else if (data === "r" || data === "R") {
			const i = RANGE_CHOICES.indexOf(this.range) + 1;
			this.setRange(RANGE_CHOICES[i % RANGE_CHOICES.length]!);
		} else if (data === "x" || data === "X") {
			if (Date.now() - this.clearArmed < 4000) {
				clearLog();
				this.clearArmed = 0;
				this.sel = 0;
				this.detail = undefined;
				this.s.notify(this.s.tr("n_cleared"), true);
			} else {
				this.clearArmed = Date.now();
				this.s.notify(this.s.tr("n_clear_confirm"), false);
			}
		} else return false;
		return true;
	}

	scroll(dir: 1 | -1) {
		this.sel = Math.max(0, Math.min(Math.max(0, this.list.length - 1), this.sel + dir));
		if (this.detail !== undefined) this.detail = this.sel;
	}

	help(): string {
		const tr = this.s.tr;
		if (this.detail !== undefined) return tr("detail_keys");
		return this.list.length ? tr("hist_hint") : tr("hist_empty_hint");
	}

	render(f: Frame, rows: number): void {
		const { ctx } = this.s;
		const now = Date.now();
		let session: string | undefined;
		try {
			session = ctx.sessionManager.getSessionId();
		} catch {
			session = undefined;
		}
		const entries = filterEntries(readLog(), this.range, "all", { session }, now);
		this.list = [...entries].reverse();
		if (this.pendingAt !== undefined) {
			const i = this.list.findIndex((e) => e.at === this.pendingAt);
			this.pendingAt = undefined;
			if (i >= 0) this.sel = this.detail = i;
		}
		this.sel = Math.min(this.sel, Math.max(0, this.list.length - 1));
		if (this.detail !== undefined && this.list[this.detail]) return this.renderDetail(f, this.list[this.detail]!, now);
		this.detail = undefined;
		this.renderList(f, rows, entries, now);
	}

	private renderList(f: Frame, rows: number, entries: LogEntry[], now: number) {
		const { theme: th, tr, icon } = this.s;
		const W = f.inner;
		const sum = summarize(entries);

		// Range chips + totals.
		const r1 = new Row().add(icon("calendar", "accent", "h:cal")).add(" ");
		for (const r of RANGE_CHOICES) {
			const label = ` ${tr(`range_${r}` as Key)} `;
			r1.add(r === this.range ? th.bg("selectedBg", th.bold(th.fg("accent", label))) : th.fg("muted", label), () => this.setRange(r));
			r1.add(" ");
		}
		const avg = sum.warms ? sum.warmCost / sum.warms : 0;
		r1.right(
			`${th.fg("success", tr("sum_warms", { n: sum.warms }))}  ${th.fg("text", fmtMoney(sum.warmCost))}  ${th.fg("dim", tr("avg_cost", { v: fmtMoney(avg) }))}`,
			W,
		);
		f.push(r1);

		// Chart: grows with the panel height.
		const chartRows = Math.max(4, Math.min(8, Math.floor((rows - 4) / 2)));
		for (const line of textChart(bucketize(entries, this.range, "count", now, chartBuckets(W)), W, chartRows, th)) f.push(line);

		// Time axis.
		const span = RANGE_MS[this.range];
		const long = span > 86_400_000;
		const axis = new Row();
		const ticks = Math.max(2, Math.min(5, Math.floor(W / 16)));
		for (let i = 0; i < ticks; i++) {
			const at = now - span + (span * i) / ticks;
			axis.to(Math.floor((W * i) / ticks)).add(th.fg("dim", long ? fmtClock(at, true).slice(0, 5) : fmtClock(at).slice(0, 5)));
		}
		axis.right(th.fg("dim", tr("now")), W);
		f.push(axis);

		// Legend doubles as per-kind totals.
		const counts: Record<string, number> = { plugin: sum.plugin, builtin: sum.builtin, manual: sum.manual, failed: sum.failed, rebuild: sum.rebuilds };
		const legend = new Row();
		for (const k of SERIES) legend.add(th.fg(SERIES_TOKEN[k], "█")).add(th.fg("muted", ` ${tr(`series_${k}` as Key)} `)).add(`${counts[k]}   `);
		legend.add(icon("bell", "warning", "h:ask")).add(th.fg("muted", ` ${tr("tag_ask")} `)).add(`${sum.ask}`);
		f.push(legend);
		f.rule();

		// Event list, newest first; click or Enter shows the details.
		const room = Math.max(1, rows - f.lines.length);
		if (this.sel < this.top) this.top = this.sel;
		if (this.sel >= this.top + room) this.top = this.sel - room + 1;
		this.top = Math.max(0, Math.min(this.top, Math.max(0, this.list.length - room)));
		if (!this.list.length) f.push(th.fg("dim", tr("hist_empty")));
		const tagW = 8;
		const dated = this.range !== "6h" && this.range !== "24h";
		const timeW = dated ? 13 : 10;
		const modelW = Math.max(10, W - 3 - timeW - 10 - 9 - 11 - tagW - 3);
		for (let i = this.top; i < Math.min(this.list.length, this.top + room); i++) {
			const e = this.list[i]!;
			const [ic, tok] = kindIcon(e);
			const selected = i === this.sel;
			const cost = e.kind === "stop" ? "" : `${e.kind === "rebuild" ? "+" : ""}${fmtMoney(e.cost)}`;
			const tags = [e.ask ? th.fg("warning", tr("tag_ask")) : "", e.sub ? th.fg("muted", tr("sub_short")) : ""].filter(Boolean).join(" ");
			const r = new Row()
				.add(icon(ic, tok, `h:row:${i - this.top}:${ic}:${tok}`))
				.add(" ")
				.add(pad(fmtClock(e.at, dated), timeW))
				.add(th.fg(tok, pad(kindLabel(tr, e), 10)))
				.add(pad(shortModel(e.model), modelW))
				.add(th.fg("muted", padLeft(e.kind === "stop" ? "" : fmtTok(e.read), 9)))
				.add(th.bold(padLeft(cost, 11)))
				.add("  ")
				.add(pad(tags, tagW))
				.add(icon("chevRight", selected ? "accent" : "dim", `h:more:${i - this.top}:${selected}`, 1));
			f.push(r, {
				selected,
				onRow: () => {
					this.sel = i;
					this.detail = i;
				},
			});
		}
	}

	private renderDetail(f: Frame, e: LogEntry, now: number) {
		const { theme: th, tr, icon, ctx } = this.s;
		const W = f.inner;
		const [ic, tok] = kindIcon(e);
		const idx = this.detail!;

		// Title: kind, result, position, navigation.
		const head = new Row().add(icon(ic, tok, "hd:kind")).add(" ").add(th.bold(th.fg(tok, kindLabel(tr, e))));
		if (e.kind === "warm") head.add(th.fg(e.ok ? "success" : "error", `  ${tr(e.ok ? "d_ok" : "d_failed")}`));
		if (e.ask) head.add("  ").add(icon("bell", "warning", "hd:ask")).add(th.fg("warning", ` ${tr("tag_ask_long")}`));
		const nav = new Row();
		nav.add(`${icon("chevLeft", "accent", "hd:prev", 1)}${th.fg("accent", ` ${tr("d_newer")}`)}`, () => idx > 0 && (this.sel = this.detail = idx - 1));
		nav.add("  ");
		nav.add(`${th.fg("accent", `${tr("d_older")} `)}${icon("chevRight", "accent", "hd:next", 1)}`, () => idx < this.list.length - 1 && (this.sel = this.detail = idx + 1));
		nav.add("   ");
		nav.add(`${icon("cross", "muted", "hd:close")}${th.fg("muted", tr("d_back"))}`, () => (this.detail = undefined));
		head.to(W - nav.width);
		const base = head.width;
		head.add(nav.text);
		for (const h of nav.hits) head.hits.push({ x0: base + h.x0, x1: base + h.x1, action: h.action });
		f.push(head, { onRow: undefined });
		f.push(th.fg("dim", `${idx + 1} / ${this.list.length}`));
		f.rule();

		const lab = (k: Key) => th.fg("muted", pad(tr(k), 12));
		const kv = (icn: IconName, k: Key, v: string, slot: string) => f.push(new Row().add(icon(icn, "muted", `hd:${slot}`)).add(" ").add(lab(k)).add(v));
		kv("clock", "d_time", `${fullDate(e.at)}  ${th.fg("dim", tr("last_ago_short", { d: fmtDur(now - e.at) }))}`, "time");
		kv("cpu", "d_model", e.model, "model");
		if (e.session) kv("link", "d_session", th.fg("dim", e.session), "session");
		const flags = [e.sub ? tr("sub_reads_free") : "", e.ask ? tr("tag_ask_long") : ""].filter(Boolean).join(" · ");
		if (flags) kv("tag", "d_flags", th.fg("warning", flags), "flags");

		if (e.kind !== "stop") {
			// Token and cost breakdown at the model's current prices (cache reads free on a subscription).
			const slash = e.model.indexOf("/");
			const model = ctx.modelRegistry.find(e.model.slice(0, slash), e.model.slice(slash + 1));
			const p = priceOf(model ?? {}, !!e.sub);
			const line = (icn: IconName, k: Key, tokens: number, price: number, slot: string) => {
				const c = costOf({ input: price, output: 0, cacheRead: 0, cacheWrite: 0 }, { input: tokens, read: 0, write: 0, output: 0 });
				f.push(
					new Row()
						.add(icon(icn, "muted", `hd:${slot}`))
						.add(" ")
						.add(lab(k))
						.add(padLeft(tokens.toLocaleString("en-US"), 12))
						.add(th.fg("dim", `  × $${price}/M  =  `))
						.add(th.bold(fmtMoney(c))),
				);
			};
			line("database", "d_read", e.read, p.cacheRead, "read");
			line("pen", "d_write", e.write, p.cacheWrite, "write");
			line("arrowIn", "d_input", e.input, p.input, "input");
			line("arrowOut", "d_output", e.output, p.output, "output");
			const total = new Row().add(icon("coin", "warning", "hd:total")).add(" ").add(lab(e.kind === "rebuild" ? "d_extra" : "d_cost")).add(th.bold(th.fg("warning", fmtMoney(e.cost))));
			if (!model) total.add(th.fg("dim", `   ${tr("d_no_price")}`));
			f.push(total);
			if (e.avoid) kv("check", "d_avoid", th.fg("success", fmtMoney(e.avoid)), "avoid");
		}
		if (e.ms) kv("pulse", "d_latency", `${e.ms} ms`, "ms");
		if (e.gapMs) kv("moon", "d_gap", fmtDur(e.gapMs), "gap");
		if (e.reason) kv("info", "d_reason", tr(`why_${e.reason}` as Key) || tr(`state_stopped_${e.reason}` as Key) || e.reason, "reason");
		if (e.error) kv("alert", "d_error", th.fg("error", e.error), "error");
	}
}
