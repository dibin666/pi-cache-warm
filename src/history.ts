/**
 * Persistent warm / rebuild / stop records, stored as JSON lines.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LOG_PATH, type HistoryFilter, type HistoryMetric, type HistoryRange } from "./config.ts";

export type EntryKind = "warm" | "rebuild" | "stop";
export type WarmSource = "plugin" | "builtin" | "manual";

export interface LogEntry {
	v: 2;
	ts: string;
	at: number;
	kind: EntryKind;
	source?: WarmSource;
	model: string;
	session?: string;
	ok: boolean;
	/** Uncached input tokens. */
	input: number;
	read: number;
	write: number;
	output: number;
	cost: number;
	/** Cost a full cache rebuild of the same prefix would have added. */
	avoid?: number;
	ms?: number;
	gapMs?: number;
	error?: string;
	reason?: string;
	/** Official Claude subscription: cache reads were not billed. */
	sub?: boolean;
	/** Happened while an ask_user_question dialog was waiting for the user. */
	ask?: boolean;
}

const MAX_LINES = 20_000;
const KEEP_LINES = 12_000;

export const RANGE_MS: Record<HistoryRange, number> = {
	"6h": 6 * 3_600_000,
	"24h": 24 * 3_600_000,
	"7d": 7 * 86_400_000,
	"30d": 30 * 86_400_000,
};

const RANGE_BUCKETS: Record<HistoryRange, number> = { "6h": 36, "24h": 48, "7d": 42, "30d": 30 };

function normalize(raw: any): LogEntry | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const at = typeof raw.at === "number" ? raw.at : Date.parse(raw.ts ?? "");
	if (!Number.isFinite(at)) return undefined;
	if (raw.v === 2) return raw as LogEntry;
	// v1 records only covered the extension's own warms.
	return {
		v: 2,
		ts: raw.ts ?? new Date(at).toISOString(),
		at,
		kind: "warm",
		source: raw.manual ? "manual" : "plugin",
		model: String(raw.model ?? "?"),
		ok: raw.ok !== false,
		input: 0,
		read: Number(raw.cacheRead) || 0,
		write: Number(raw.cacheWrite) || 0,
		output: 0,
		cost: Number(raw.cost) || 0,
		error: raw.error,
	};
}

let cache: { mtime: number; size: number; entries: LogEntry[] } | undefined;

export function readLog(): LogEntry[] {
	try {
		if (!existsSync(LOG_PATH)) return [];
		const st = statSync(LOG_PATH);
		if (cache && cache.mtime === st.mtimeMs && cache.size === st.size) return cache.entries;
		const entries: LogEntry[] = [];
		for (const line of readFileSync(LOG_PATH, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const e = normalize(JSON.parse(line));
				if (e) entries.push(e);
			} catch {
				/* skip corrupt line */
			}
		}
		entries.sort((a, b) => a.at - b.at);
		cache = { mtime: st.mtimeMs, size: st.size, entries };
		return entries;
	} catch {
		return [];
	}
}

export function appendLog(entry: Omit<LogEntry, "v" | "ts">): void {
	try {
		mkdirSync(dirname(LOG_PATH), { recursive: true });
		const full: LogEntry = { v: 2, ts: new Date(entry.at).toISOString(), ...entry };
		appendFileSync(LOG_PATH, `${JSON.stringify(full)}\n`);
		const st = statSync(LOG_PATH);
		if (st.size > 4_000_000) {
			const lines = readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean);
			if (lines.length > MAX_LINES) writeFileSync(LOG_PATH, `${lines.slice(-KEEP_LINES).join("\n")}\n`);
		}
	} catch {
		/* logging is best-effort */
	}
}

export function clearLog(): void {
	try {
		writeFileSync(LOG_PATH, "");
		cache = undefined;
	} catch {
		/* ignore */
	}
}

export interface FilterContext {
	model?: string;
	session?: string;
}

export function filterEntries(entries: LogEntry[], range: HistoryRange, filter: HistoryFilter, fc: FilterContext, now = Date.now()) {
	const since = now - RANGE_MS[range];
	return entries.filter((e) => {
		if (e.at < since || e.at > now + 60_000) return false;
		if (filter === "model" && (!fc.model || e.model !== fc.model)) return false;
		if (filter === "session" && (!fc.session || e.session !== fc.session)) return false;
		return true;
	});
}

/**
 * The first recorded event in a conversation is the bootstrap entry, not a useful warm record.
 * Keep it in the log so it can still be audited, but leave it out of the views that display warm
 * history. Entries are sorted by time by readLog().
 */
export function withoutConversationFirst(entries: LogEntry[]): LogEntry[] {
	const seen = new Set<string>();
	return entries.filter((e) => {
		if (!e.session) return true;
		if (seen.has(e.session)) return true;
		seen.add(e.session);
		return false;
	});
}

export interface Bucket {
	t0: number;
	t1: number;
	plugin: number;
	builtin: number;
	manual: number;
	failed: number;
	rebuild: number;
}

export function bucketize(entries: LogEntry[], range: HistoryRange, metric: HistoryMetric, now = Date.now(), count?: number): Bucket[] {
	const n = Math.max(1, count ?? RANGE_BUCKETS[range]);
	const span = RANGE_MS[range] / n;
	const start = now - RANGE_MS[range];
	const out: Bucket[] = [];
	for (let i = 0; i < n; i++) {
		out.push({ t0: start + i * span, t1: start + (i + 1) * span, plugin: 0, builtin: 0, manual: 0, failed: 0, rebuild: 0 });
	}
	for (const e of entries) {
		if (e.kind === "stop") continue;
		const i = Math.floor((e.at - start) / span);
		const b = out[Math.min(n - 1, Math.max(0, i))];
		if (!b || e.at < start) continue;
		const v = metric === "count" ? 1 : metric === "cost" ? e.cost : e.read + e.write + e.input;
		if (e.kind === "rebuild") b.rebuild += v;
		else if (!e.ok) b.failed += metric === "count" ? 1 : 0;
		else b[e.source ?? "plugin"] += v;
	}
	return out;
}

export interface Summary {
	warms: number;
	plugin: number;
	builtin: number;
	manual: number;
	failed: number;
	warmCost: number;
	avoid: number;
	rebuilds: number;
	rebuildCost: number;
	stops: number;
	ask: number;
}

export function summarize(entries: LogEntry[]): Summary {
	const s: Summary = {
		warms: 0,
		plugin: 0,
		builtin: 0,
		manual: 0,
		failed: 0,
		warmCost: 0,
		avoid: 0,
		rebuilds: 0,
		rebuildCost: 0,
		stops: 0,
		ask: 0,
	};
	for (const e of entries) {
		if (e.kind === "stop") s.stops++;
		else if (e.kind === "rebuild") {
			s.rebuilds++;
			s.rebuildCost += e.cost;
		} else if (!e.ok) s.failed++;
		else {
			s.warms++;
			s[e.source ?? "plugin"]++;
			s.warmCost += e.cost;
			s.avoid += e.avoid ?? 0;
			if (e.ask) s.ask++;
		}
	}
	return s;
}
