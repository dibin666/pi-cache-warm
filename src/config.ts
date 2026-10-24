import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type LangSetting = "auto" | "zh" | "en";
export type HistoryRange = "6h" | "24h" | "7d" | "30d";
export type HistoryMetric = "count" | "cost" | "tokens";
export type HistoryFilter = "all" | "model" | "session";

export interface Config {
	/** Master switch for everything this extension does. */
	enabled: boolean;
	/** UI language. "auto" follows LANG / LC_ALL. */
	lang: LangSetting;
	/** Models kept warm, as "provider/modelId". */
	models: string[];
	/** Models used through an official Claude subscription: cache reads are not billed. */
	subscription: string[];
	/** While an rpiv ask_user_question dialog waits for the user, keep the cache warm regardless of limits. */
	askWarm: boolean;
	/** Warm even when pi's own cost estimate says it is not worth it. */
	ignoreEconomics: boolean;
	/** Stop keeping warm this many hours after the last real request. 0 = never. */
	maxKeepWarmHours: number;
	/** Where the extension's own refresh fires, as % of the cache TTL (pi's built-in warmer uses 90). */
	takeoverPct: number;
	/** Show the next refresh time in pi's footer. */
	footer: boolean;
	/** Remembered history-view preferences. */
	historyRange: HistoryRange;
	historyMetric: HistoryMetric;
	historyFilter: HistoryFilter;
}

export const DEFAULTS: Config = {
	enabled: true,
	lang: "auto",
	models: [],
	subscription: [],
	askWarm: true,
	ignoreEconomics: true,
	maxKeepWarmHours: 0,
	takeoverPct: 93,
	footer: true,
	historyRange: "24h",
	historyMetric: "count",
	historyFilter: "all",
};

export const HOURS_CHOICES = [0, 1, 2, 4, 8, 12, 24, 48];
export const PCT_CHOICES = [90, 92, 93, 95, 97];
export const LANG_CHOICES: LangSetting[] = ["auto", "zh", "en"];
export const RANGE_CHOICES: HistoryRange[] = ["6h", "24h", "7d", "30d"];
export const METRIC_CHOICES: HistoryMetric[] = ["count", "cost", "tokens"];
export const FILTER_CHOICES: HistoryFilter[] = ["all", "model", "session"];

export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
export const CONFIG_PATH = join(AGENT_DIR, "cache-warm-plus.json");
export const LOG_PATH = join(AGENT_DIR, "cache-warm-plus.log.jsonl");

function pick<T>(list: readonly T[], v: unknown, d: T): T {
	return list.includes(v as T) ? (v as T) : d;
}

export function loadConfig(): Config {
	try {
		if (existsSync(CONFIG_PATH)) {
			const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
			const { iconMode: _legacy, ...rest } = raw;
			const cfg: Config = { ...DEFAULTS, ...rest };
			if (!Array.isArray(cfg.models)) cfg.models = [...DEFAULTS.models];
			if (!Array.isArray(cfg.subscription)) cfg.subscription = [];
			cfg.lang = pick(LANG_CHOICES, cfg.lang, "auto");
			cfg.historyRange = pick(RANGE_CHOICES, cfg.historyRange, "24h");
			cfg.historyMetric = pick(METRIC_CHOICES, cfg.historyMetric, "count");
			cfg.historyFilter = pick(FILTER_CHOICES, cfg.historyFilter, "all");
			if (!(cfg.maxKeepWarmHours >= 0)) cfg.maxKeepWarmHours = 0;
			cfg.takeoverPct = Math.min(97, Math.max(80, Number(cfg.takeoverPct) || DEFAULTS.takeoverPct));
			cfg.footer = cfg.footer !== false;
			cfg.askWarm = cfg.askWarm !== false;
			return cfg;
		}
	} catch {
		/* fall through to defaults */
	}
	return { ...DEFAULTS, models: [...DEFAULTS.models], subscription: [] };
}

export function saveConfig(cfg: Config): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
}

export function cycle<T>(list: readonly T[], cur: T, dir: 1 | -1 | 0): T {
	const i = Math.max(0, list.indexOf(cur));
	const step = dir === 0 ? 1 : dir;
	return list[(i + step + list.length) % list.length]!;
}
