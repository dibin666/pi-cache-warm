/**
 * Read and write pi's own configuration: model metadata in models.json and global
 * settings in settings.json. Every write keeps a backup of the previous file.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR } from "./config.ts";

export const MODELS_PATH = join(AGENT_DIR, "models.json");
export const SETTINGS_PATH = join(AGENT_DIR, "settings.json");
const BACKUP_SUFFIX = ".cache-warm-plus.bak";

export type CacheWarmingMode = "off" | "streaming" | "idle";
export const CACHE_WARMING_MODES: CacheWarmingMode[] = ["off", "streaming", "idle"];

export interface ModelFields {
	short?: number;
	long?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export type ModelSource =
	| { kind: "model"; provider: string; index: number } // providers[p].models[index]
	| { kind: "override"; provider: string }; // providers[p].modelOverrides[id]

function readJson(path: string): any {
	if (!existsSync(path)) return {};
	const text = readFileSync(path, "utf8");
	return text.trim() ? JSON.parse(text) : {};
}

function writeJson(path: string, data: unknown) {
	if (existsSync(path)) copyFileSync(path, path + BACKUP_SUFFIX);
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

/** Where a model's configuration lives (or would live) in models.json. */
export function locateModel(provider: string, id: string): ModelSource {
	try {
		const data = readJson(MODELS_PATH);
		const models: any[] = data?.providers?.[provider]?.models ?? [];
		const index = models.findIndex((m) => m?.id === id);
		if (index >= 0) return { kind: "model", provider, index };
	} catch {
		/* fall through */
	}
	return { kind: "override", provider };
}

export function describeSource(src: ModelSource, id: string): string {
	return src.kind === "model"
		? `providers.${src.provider}.models[${src.index}]`
		: `providers.${src.provider}.modelOverrides["${id}"]`;
}

/** Effective values pi currently uses for a model (from the live registry object). */
export function effectiveFields(model: any): ModelFields {
	const c = model?.cost ?? {};
	const p = model?.promptCache ?? {};
	return {
		short: typeof p.short === "number" ? p.short : undefined,
		long: typeof p.long === "number" ? p.long : undefined,
		input: typeof c.input === "number" ? c.input : undefined,
		output: typeof c.output === "number" ? c.output : undefined,
		cacheRead: typeof c.cacheRead === "number" ? c.cacheRead : undefined,
		cacheWrite: typeof c.cacheWrite === "number" ? c.cacheWrite : undefined,
	};
}

/** Persist `fields` for provider/id into models.json, creating an override entry if needed. */
export function saveModelFields(provider: string, id: string, fields: ModelFields): ModelSource {
	const data = readJson(MODELS_PATH);
	data.providers ??= {};
	data.providers[provider] ??= {};
	const prov = data.providers[provider];
	const models: any[] = Array.isArray(prov.models) ? prov.models : [];
	const index = models.findIndex((m) => m?.id === id);
	let target: any;
	let src: ModelSource;
	if (index >= 0) {
		target = models[index];
		src = { kind: "model", provider, index };
	} else {
		prov.modelOverrides ??= {};
		prov.modelOverrides[id] ??= {};
		target = prov.modelOverrides[id];
		src = { kind: "override", provider };
	}

	const pc: Record<string, number> = { ...(target.promptCache ?? {}) };
	for (const k of ["short", "long"] as const) {
		if (fields[k] === undefined || fields[k]! <= 0) delete pc[k];
		else pc[k] = Math.round(fields[k]!);
	}
	if (Object.keys(pc).length) target.promptCache = pc;
	else delete target.promptCache;

	const cost: Record<string, unknown> = { ...(target.cost ?? {}) };
	for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		if (fields[k] !== undefined) cost[k] = fields[k];
	}
	if (src.kind === "model") {
		// Custom models require all four prices.
		for (const k of ["input", "output", "cacheRead", "cacheWrite"]) cost[k] ??= 0;
	}
	if (Object.keys(cost).length) target.cost = cost;

	writeJson(MODELS_PATH, data);
	return src;
}

export interface PiSettings {
	cacheWarming: CacheWarmingMode;
	showCacheMissNotices: boolean;
}

export function readPiSettings(): PiSettings {
	try {
		const s = readJson(SETTINGS_PATH);
		return {
			cacheWarming: CACHE_WARMING_MODES.includes(s.cacheWarming) ? s.cacheWarming : "streaming",
			showCacheMissNotices: s.showCacheMissNotices === true,
		};
	} catch {
		return { cacheWarming: "streaming", showCacheMissNotices: false };
	}
}

export function writePiSetting<K extends keyof PiSettings>(key: K, value: PiSettings[K]): void {
	const s = readJson(SETTINGS_PATH);
	s[key] = value;
	writeJson(SETTINGS_PATH, s);
}
