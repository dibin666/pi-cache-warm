/**
 * Model settings: pi's own model metadata in models.json (cache lifetimes, prices) plus the
 * extension's per-model switches (keep warm, official Claude subscription).
 */
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { costOf, isClaude, missPremium, modelKey, priceOf } from "../engine.ts";
import type { Key } from "../i18n.ts";
import type { IconName } from "../icons.ts";
import { describeSource, effectiveFields, locateModel, type ModelFields, saveModelFields } from "../pi-config.ts";
import { fmtMoney, fmtTok, fmtTtl, type Frame, Row, type Shared, type View, switchText } from "./frame.ts";

type FieldId = "short" | "long" | "cacheRead" | "cacheWrite" | "input" | "sub" | "warm";

interface Field {
	id: FieldId;
	icon: IconName;
	label: Key;
	hint: Key;
	kind: "ttl" | "price" | "toggle";
}

const TTL_PRESETS = [0, 300, 600, 1800, 3600, 7200, 86400];

function parseTtl(s: string): number | undefined {
	const m = /^\s*(\d+(?:\.\d+)?)\s*([smhd]?)\s*$/i.exec(s);
	if (!m) return undefined;
	const mult = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]!.toLowerCase() as "" | "s" | "m" | "h" | "d"];
	return Math.round(Number(m[1]) * mult);
}

export class EditorView implements View {
	private sel = 0;
	private values: ModelFields;
	private readonly original: ModelFields;
	private warm: boolean;
	private sub: boolean;
	private editing?: { id: FieldId; buf: string; error?: boolean };
	private saving = false;
	private fields: Field[];

	constructor(
		private s: Shared,
		private model: any,
		enable: boolean,
		private close: () => void,
	) {
		this.original = effectiveFields(model);
		this.values = { ...this.original };
		const key = modelKey(model);
		this.warm = enable || s.cfg().models.includes(key);
		this.sub = s.cfg().subscription.includes(key);
		this.fields = [
			{ id: "short", icon: "clock", label: "f_short", hint: "f_short_hint", kind: "ttl" },
			{ id: "long", icon: "clockBack", label: "f_long", hint: "f_long_hint", kind: "ttl" },
			{ id: "cacheRead", icon: "database", label: "f_read", hint: "f_read_hint", kind: "price" },
			{ id: "cacheWrite", icon: "pen", label: "f_write", hint: "f_write_hint", kind: "price" },
			{ id: "input", icon: "arrowIn", label: "f_input", hint: "f_price_hint", kind: "price" },
			...(isClaude(model) ? [{ id: "sub", icon: "crown", label: "f_sub", hint: "f_sub_hint", kind: "toggle" } as Field] : []),
			{ id: "warm", icon: "flame", label: "f_warm", hint: "f_warm_hint", kind: "toggle" },
		];
	}

	/** Only while typing a number; otherwise the panel's keys (←→ tabs, Ctrl+S, Esc) apply. */
	captures(): boolean {
		return !!this.editing;
	}

	back(): boolean {
		if (this.editing) {
			this.editing = undefined;
			return true;
		}
		return false;
	}

	scroll(dir: 1 | -1) {
		if (!this.editing) this.sel = Math.max(0, Math.min(this.fields.length - 1, this.sel + dir));
	}

	private get field(): Field {
		return this.fields[this.sel]!;
	}

	private cycleTtl(id: "short" | "long", dir: 1 | -1) {
		const cur = this.values[id] ?? 0;
		let i = TTL_PRESETS.indexOf(cur);
		if (i < 0) i = Math.max(0, TTL_PRESETS.findIndex((p) => p > cur) - (dir > 0 ? 1 : 0));
		this.values[id] = TTL_PRESETS[(i + dir + TTL_PRESETS.length) % TTL_PRESETS.length]! || undefined;
	}

	private change(f: Field, dir: 1 | -1) {
		if (f.kind === "ttl") this.cycleTtl(f.id as "short" | "long", dir);
		else if (f.id === "sub") this.sub = !this.sub;
		else if (f.id === "warm") this.warm = !this.warm;
		else this.startEdit(f);
	}

	private startEdit(f: Field, first = "") {
		if (f.kind !== "ttl" && f.kind !== "price") return;
		const v = this.values[f.id as keyof ModelFields];
		this.editing = { id: f.id, buf: first || (v === undefined ? "" : String(v)) };
	}

	private commitEdit() {
		const e = this.editing!;
		const f = this.fields.find((x) => x.id === e.id)!;
		const k = e.id as keyof ModelFields;
		if (e.buf.trim() === "") {
			this.values[k] = undefined;
			this.editing = undefined;
			return;
		}
		const v = f.kind === "ttl" ? parseTtl(e.buf) : Number(e.buf);
		if (v === undefined || !Number.isFinite(v) || v < 0) {
			e.error = true;
			return;
		}
		this.values[k] = f.kind === "ttl" && v === 0 ? undefined : v;
		this.editing = undefined;
	}

	dirty(): boolean {
		const key = modelKey(this.model);
		const cfg = this.s.cfg();
		return (
			!!this.editing ||
			(Object.keys(this.values) as (keyof ModelFields)[]).some((k) => this.values[k] !== this.original[k]) ||
			this.warm !== cfg.models.includes(key) ||
			this.sub !== cfg.subscription.includes(key)
		);
	}

	/** Write pi's model metadata and fold the switches into the panel draft. Called by Ctrl+S. */
	async save(): Promise<boolean> {
		if (this.saving) return false;
		const { s, model } = this;
		const tr = s.tr;
		if (this.editing) {
			this.commitEdit();
			if (this.editing) return false; // invalid number
		}
		if (this.warm && !this.values.short && !this.values.long) {
			s.notify(tr("n_need_ttl"), false);
			this.sel = 0;
			return false;
		}
		this.saving = true;
		try {
			const key = modelKey(model);
			const changedPi = (Object.keys(this.values) as (keyof ModelFields)[]).some((k) => this.values[k] !== this.original[k]);
			const models = new Set(s.cfg().models);
			const subs = new Set(s.cfg().subscription);
			this.warm ? models.add(key) : models.delete(key);
			this.sub ? subs.add(key) : subs.delete(key);
			s.update({ models: [...models], subscription: [...subs] });
			if (changedPi) {
				saveModelFields(model.provider, model.id, this.values);
				await s.ctx.modelRegistry.refresh();
				const cur = s.ctx.model;
				if (cur && modelKey(cur) === key) {
					const fresh = s.ctx.modelRegistry.find(model.provider, model.id);
					if (fresh) await s.pi.setModel(fresh);
				}
			}
			this.close();
			return true;
		} catch (err) {
			s.notify(tr("n_save_failed", { err: err instanceof Error ? err.message : String(err) }), false);
			return false;
		} finally {
			this.saving = false;
		}
	}

	handleInput(data: string): boolean {
		if (this.editing) {
			const e = this.editing;
			if (matchesKey(data, "enter") || matchesKey(data, "tab")) this.commitEdit();
			else if (matchesKey(data, "backspace")) {
				e.buf = e.buf.slice(0, -1);
				e.error = false;
			} else if (/^[0-9.smhdSMHD]$/.test(data)) {
				e.buf += data;
				e.error = false;
			}
			return true;
		}
		const f = this.field;
		if (matchesKey(data, "up")) this.sel = (this.sel - 1 + this.fields.length) % this.fields.length;
		else if (matchesKey(data, "down")) this.sel = (this.sel + 1) % this.fields.length;
		// Enter modifies: toggles flip, lifetimes step through presets, prices open for typing.
		else if (matchesKey(data, "enter") || matchesKey(data, "space")) this.change(f, 1);
		else if (/^[0-9]$/.test(data)) this.startEdit(f, data);
		else if (matchesKey(data, "delete") && f.kind !== "toggle") this.values[f.id as keyof ModelFields] = undefined;
		else return false;
		return true;
	}

	help(): string {
		const tr = this.s.tr;
		if (this.editing) return this.editing.error ? tr("e_invalid") : tr(this.fields.find((x) => x.id === this.editing!.id)!.kind === "ttl" ? "e_ttl_units" : "e_price_units");
		return `${tr(this.field.hint)} ${tr("e_keys")}`;
	}

	render(f: Frame, rows: number): void {
		const { theme: th, tr, icon } = this.s;
		const m = this.model;
		const W = f.inner;

		// Title with save / cancel buttons.
		const head = new Row().add(icon("pen", "accent", "e:title")).add(" ").add(th.bold(th.fg("accent", m.id))).add(th.fg("dim", `  ${m.provider}`));
		if (this.dirty()) head.add("  ").add(icon("dot", "warning", "e:dirty", 2)).add(th.fg("warning", tr("e_dirty")));
		const buttons = new Row();
		buttons.add(`${icon("save", "success", "e:save")}${th.bg("selectedBg", th.bold(th.fg("success", ` ${tr("btn_save")} `)))}`, () => void this.s.save());
		buttons.add("  ");
		buttons.add(`${icon("cross", "muted", "e:cancel")}${th.fg("muted", ` ${tr("btn_cancel")} `)}`, () => this.close());
		head.to(W - buttons.width);
		const base = head.width;
		head.add(buttons.text);
		for (const h of buttons.hits) head.hits.push({ x0: base + h.x0, x1: base + h.x1, action: h.action });
		f.push(head);
		f.push(new Row().add(icon("file", "muted", "e:src")).add(th.fg("dim", ` models.json → ${describeSource(locateModel(m.provider, m.id), m.id)}`)));
		f.rule();

		const labelW = Math.max(...this.fields.map((x) => visibleWidth(tr(x.label)))) + 3;
		this.fields.forEach((fd, i) => {
			const selected = i === this.sel;
			const r = new Row().add(icon(fd.icon, selected ? "accent" : "muted", `e:${fd.id}:${selected}`)).add(" ");
			r.add(selected ? th.bold(th.fg("accent", tr(fd.label))) : tr(fd.label)).to(3 + labelW);
			const select = () => {
				this.sel = i;
			};
			if (fd.kind === "toggle") {
				const on = fd.id === "sub" ? this.sub : this.warm;
				r.add(switchText(th, tr, on));
				if (fd.id === "sub") r.add(th.fg("dim", `   ${tr("f_sub_note")}`));
				f.push(r, { selected, onRow: () => (select(), this.change(fd, 1)) });
				return;
			}
			const k = fd.id as keyof ModelFields;
			const v = this.values[k];
			const changed = v !== this.original[k];
			if (this.editing?.id === fd.id) {
				r.add(th.fg(this.editing.error ? "error" : "accent", this.editing.buf)).add(th.inverse(" "));
			} else if (fd.kind === "ttl") {
				r.add(icon("chevLeft", "accent", `e:${fd.id}:l`, 1), () => (select(), this.change(fd, -1)));
				r.add(v ? th.fg("accent", ` ${fmtTtl(v)} `) : th.fg("warning", ` ${tr("unset")} `));
				r.add(icon("chevRight", "accent", `e:${fd.id}:r`, 1), () => (select(), this.change(fd, 1)));
			} else {
				const sub = fd.id === "cacheRead" && this.sub;
				r.add(v === undefined ? th.fg("warning", tr("unset")) : th.fg(sub ? "dim" : "accent", `$${v}`)).add(th.fg("dim", " / M"));
				if (sub) r.add(th.fg("warning", `   ${tr("sub_not_billed")}`));
			}
			if (changed && this.editing?.id !== fd.id) r.add(th.fg("warning", "  *"));
			f.push(r, { selected, onRow: () => (select(), fd.kind === "price" ? this.startEdit(fd) : undefined) });
		});

		// Live estimate with the edited prices.
		const tokens = this.s.ctx.getContextUsage?.()?.tokens ?? 0;
		const p = priceOf({ cost: { ...m.cost, ...this.values } }, this.sub);
		const est = new Row().add(icon("coin", "warning", "e:est")).add(" ");
		if (tokens) {
			est.add(
				tr("e_estimate", {
					tok: fmtTok(tokens),
					warm: `${fmtMoney(costOf(p, { read: tokens, input: 4, write: 0, output: 1 }))}${this.sub ? ` (${tr("sub_reads_free")})` : ""}`,
					rebuild: fmtMoney(missPremium(p, tokens)),
				}),
			);
		} else est.add(th.fg("dim", tr("e_estimate_none")));
		while (f.lines.length < rows - 1) f.push("");
		f.push(est);
	}
}
