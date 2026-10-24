import { matchesKey } from "@earendil-works/pi-tui";
import { modelKey, TAKEOVER_APIS } from "../engine.ts";
import { EditorView } from "./editor.ts";
import { fmtTtl, type Frame, Row, type Shared, type View } from "./frame.ts";

interface Entry {
	key: string;
	model: any | undefined;
	ttl?: number;
}

export class ModelsView implements View {
	private sel = 0;
	private top = 0;
	private editor?: EditorView;
	private entries: Entry[] = [];

	constructor(private s: Shared) {
		this.reload();
	}

	private get cfg() {
		return this.s.cfg();
	}

	private escArmed = 0;

	reload() {
		let list: any[] = [];
		try {
			list = this.s.ctx.modelRegistry.getAvailable() as any[];
		} catch {
			list = [];
		}
		const map = new Map<string, Entry>();
		for (const m of list) {
			const ttl = this.s.engine.ttlMs(m);
			map.set(modelKey(m), { key: modelKey(m), model: m, ttl: ttl ? ttl / 1000 : undefined });
		}
		for (const k of this.cfg.models) if (!map.has(k)) map.set(k, { key: k, model: undefined });
		const cur = this.s.ctx.model ? modelKey(this.s.ctx.model) : "";
		const rank = (e: Entry) => (e.key === cur ? 0 : this.cfg.models.includes(e.key) ? 1 : e.ttl ? 2 : 3);
		this.entries = [...map.values()].sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
	}

	captures(): boolean {
		return !!this.editor?.captures();
	}

	dirty(): boolean {
		return !!this.editor?.dirty();
	}

	async save(): Promise<boolean> {
		return this.editor ? this.editor.save() : true;
	}

	back(): boolean {
		if (!this.editor) return false;
		if (this.editor.back()) return true;
		if (this.editor.dirty() && Date.now() - this.escArmed > 4000) {
			this.escArmed = Date.now();
			this.s.notify(this.s.tr("n_unsaved_editor"), false);
			return true;
		}
		this.editor = undefined;
		this.reload();
		return true;
	}

	/** Open pi's model editor, e.g. from the overview or when enabling a model without a lifetime. */
	edit(model: any, enable: boolean) {
		this.editor = new EditorView(this.s, model, enable, () => {
			this.editor = undefined;
			this.reload();
		});
	}

	private toggle(e: Entry) {
		const on = this.cfg.models.includes(e.key);
		if (!on && e.model && !e.ttl) {
			// Nothing can warm a model without a cache lifetime: configure pi's model metadata first.
			this.edit(e.model, true);
			this.s.notify(this.s.tr("n_need_ttl"), false);
			return;
		}
		const set = new Set(this.cfg.models);
		on ? set.delete(e.key) : set.add(e.key);
		this.s.update({ models: [...set] });
	}

	private open(e: Entry) {
		if (e.model) this.edit(e.model, false);
		else this.s.notify(this.s.tr("n_model_unavailable"), false);
	}

	handleInput(data: string): boolean {
		if (this.editor) return this.editor.handleInput(data);
		const n = this.entries.length;
		const e = this.entries[this.sel];
		if (matchesKey(data, "up")) this.scroll(-1);
		else if (matchesKey(data, "down")) this.scroll(1);
		else if (!e) return false;
		else if (matchesKey(data, "space")) this.toggle(e);
		else if (matchesKey(data, "enter") || data === "e" || data === "E") this.open(e);
		else return false;
		void n;
		return true;
	}

	scroll(dir: 1 | -1) {
		if (this.editor) return this.editor.scroll(dir);
		this.sel = Math.max(0, Math.min(this.entries.length - 1, this.sel + dir));
	}

	help(): string {
		if (this.editor) return this.editor.help();
		const e = this.entries[this.sel];
		const tr = this.s.tr;
		if (!e) return tr("pick_empty");
		if (!e.model) return tr("n_model_unavailable");
		const api = TAKEOVER_APIS.has(e.model.api) ? tr("mode_takeover") : tr("pick_noapi");
		return `${e.model.api} · ${api} · ${e.ttl ? tr("m_help") : tr("m_help_nottl")}`;
	}

	render(f: Frame, rows: number): void {
		if (this.editor) return this.editor.render(f, rows);
		const { theme: th, tr, icon } = this.s;
		const W = f.inner;
		const cur = this.s.ctx.model ? modelKey(this.s.ctx.model) : "";
		this.sel = Math.min(this.sel, Math.max(0, this.entries.length - 1));
		const room = Math.max(1, rows);
		if (this.sel < this.top) this.top = this.sel;
		if (this.sel >= this.top + room) this.top = this.sel - room + 1;
		this.top = Math.max(0, Math.min(this.top, Math.max(0, this.entries.length - room)));
		if (!this.entries.length) f.push(th.fg("dim", tr("pick_empty")));
		for (let i = this.top; i < Math.min(this.entries.length, this.top + room); i++) {
			const e = this.entries[i]!;
			const on = this.cfg.models.includes(e.key);
			const selected = i === this.sel;
			const slash = e.key.indexOf("/");
			const provider = e.key.slice(0, slash);
			const id = e.key.slice(slash + 1);
			const r = new Row();
			r.add(icon(on ? "boxOn" : "box", on ? "success" : "muted", `m:box:${i - this.top}:${on}`, 2, "text"), () => {
				this.sel = i;
				this.toggle(e);
			});
			r.add(" ").add(selected ? th.bold(th.fg("accent", id)) : th.bold(id)).add(th.fg("dim", `  ${provider}`));
			if (e.key === cur) r.add(th.fg("warning", `  ${tr("current")}`));
			// Right side: lifetime, subscription badge, edit button.
			const right = new Row();
			if (this.cfg.subscription.includes(e.key))
				right.add(icon("crown", "warning", `m:sub:${i - this.top}`)).add(th.fg("warning", ` ${tr("sub_badge")}  `));
			right.add(icon("clock", e.ttl ? "muted" : "warning", `m:ttl:${i - this.top}:${!!e.ttl}`)).add(
				e.ttl ? ` ${fmtTtl(e.ttl)}` : th.fg("warning", ` ${tr("pick_nottl")}`),
			);
			right.add("   ");
			const editStart = right.width;
			right.add(icon("pen", selected ? "accent" : "muted", `m:edit:${i - this.top}:${selected}`));
			r.to(W - right.width);
			const base = r.width;
			r.add(right.text);
			// Clicking the pen (or anywhere else on the row) opens the editor.
			r.hits.push({ x0: base + editStart, x1: base + right.width, action: () => this.open(e) });
			f.push(r, {
				selected,
				onRow: () => {
					this.sel = i;
					this.open(e);
				},
			});
		}
	}
}
