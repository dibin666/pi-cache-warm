/**
 * Warming engine.
 *
 * - Captures every real provider request (payload + headers) so it can be replayed.
 * - Overrides pi's built-in `cache_warming_decision` for the selected models.
 * - Takes over after the built-in warmer stops: replays the last request with a tiny output cap
 *   shortly before the cache expires (Anthropic Messages, OpenAI Responses, OpenAI Chat Completions).
 * - Records every warm (own and built-in), every cache rebuild and every stop in the history log.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";
import { appendLog, type WarmSource } from "./history.ts";
import { resolveLang, t, type Lang } from "./i18n.ts";

const IDLE_CONTINUATION_PROBABILITY = 0.15;
const MIN_EXPECTED_SAVINGS = 0.05;
const MARGIN_MS = 10_000;
const REQUEST_TIMEOUT_MS = 120_000;
const WARM_OUTPUT_LIMIT = 16;

export const TAKEOVER_APIS = new Set(["anthropic-messages", "openai-responses", "openai-completions"]);

/** @juicesharp/rpiv-ask-user-question integration. */
const ASK_BLOCKED_EVENT = "rpiv:ask-user:blocked";
const ASK_TOOLS = new Set(["ask_user_question"]);

type AnyModel = any;

export const modelKey = (m: AnyModel) => `${m.provider}/${m.id}`;

export interface Usage {
	/** Uncached input tokens. */
	input: number;
	read: number;
	write: number;
	output: number;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function usageFrom(api: string, u: any): Usage | undefined {
	if (!u || typeof u !== "object") return undefined;
	if (api === "anthropic-messages") {
		return {
			input: num(u.input_tokens),
			read: num(u.cache_read_input_tokens),
			write: num(u.cache_creation_input_tokens),
			output: num(u.output_tokens),
		};
	}
	if (api === "openai-responses") {
		const total = num(u.input_tokens);
		const read = num(u.input_tokens_details?.cached_tokens);
		return { input: Math.max(0, total - read), read, write: 0, output: num(u.output_tokens) };
	}
	const prompt = num(u.prompt_tokens);
	const read = num(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens);
	const write = num(u.prompt_tokens_details?.cache_write_tokens);
	return { input: Math.max(0, prompt - read - write), read, write, output: num(u.completion_tokens) };
}

function mergeUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
	if (!a) return b;
	if (!b) return a;
	return {
		input: Math.max(a.input, b.input),
		read: Math.max(a.read, b.read),
		write: Math.max(a.write, b.write),
		output: Math.max(a.output, b.output),
	};
}

function streamUsage(api: string, data: any): { usage?: Usage; final: boolean } {
	if (!data || typeof data !== "object") return { final: false };
	if (api === "anthropic-messages") {
		if (data.type === "message_start") return { usage: usageFrom(api, data.message?.usage), final: false };
		if (data.type === "message_delta") return { usage: usageFrom(api, data.usage), final: false };
		return { final: data.type === "message_stop" };
	}
	if (api === "openai-responses") {
		if (data.type === "response.completed" || data.type === "response.incomplete" || data.type === "response.failed")
			return { usage: usageFrom(api, data.response?.usage), final: true };
		return { final: false };
	}
	if (data.usage) return { usage: usageFrom(api, data.usage), final: true };
	return { final: false };
}

export interface Price {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export function priceOf(model: AnyModel, subscription = false): Price {
	const c = model?.cost ?? {};
	return {
		input: num(c.input),
		output: num(c.output),
		// An official Claude subscription does not bill cache reads.
		cacheRead: subscription ? 0 : num(c.cacheRead),
		cacheWrite: num(c.cacheWrite),
	};
}

export function costOf(p: Price, u: Usage): number {
	return (u.input * p.input + u.output * p.output + u.read * p.cacheRead + u.write * p.cacheWrite) / 1e6;
}

/** Extra cost of sending `tokens` without a cache hit, compared with a hit. */
export function missPremium(p: Price, tokens: number): number {
	return (tokens * Math.max(0, (p.cacheWrite || p.input) - p.cacheRead)) / 1e6;
}

/** Whether the official-subscription switch makes sense for a model. */
export function isClaude(model: AnyModel): boolean {
	return model?.api === "anthropic-messages" || model?.provider === "anthropic" || /claude/i.test(String(model?.id ?? ""));
}

interface Req {
	at: number;
	model: AnyModel;
	api: string;
	payload?: any;
	headers: Record<string, string>;
	isWarm: boolean;
	usage?: Usage;
	done: boolean;
	prevTouch?: number;
	prevStop?: string;
	ask?: boolean;
}

interface Snapshot {
	model: AnyModel;
	key: string;
	payload?: any;
	headers: Record<string, string>;
	/** When the provider last saw this prefix (real request or any warm). */
	lastTouch: number;
	/** When the last real (non-warm) request started. */
	lastReal: number;
	pluginWarms: number;
	builtinWarms: number;
	broken: boolean;
	failures: number;
}

export interface WarmRecord {
	at: number;
	ok: boolean;
	source: WarmSource;
	read: number;
	write: number;
	cost: number;
	error?: string;
	ask?: boolean;
}

export type StateId =
	| "off"
	| "untracked"
	| "unsupported"
	| "nottl"
	| "waiting"
	| "scheduled"
	| "busy"
	| "thinking"
	| "stopped";

export interface Status {
	state: StateId;
	stopKey?: string;
	modelKey?: string;
	api?: string;
	takeover: boolean;
	ttlMs?: number;
	lastTouch?: number;
	lastReal?: number;
	nextAt?: number;
	pluginWarms: number;
	builtinWarms: number;
	tokens?: number;
	estWarmCost?: number;
	estRebuildCost?: number;
	subscription?: boolean;
	asking?: boolean;
	askSince?: number;
	last?: WarmRecord;
}

export class Engine {
	cfg: Config;
	private snap?: Snapshot;
	private queue: Req[] = [];
	private live?: Req;
	private timer?: ReturnType<typeof setTimeout>;
	ctx?: ExtensionContext;
	private busy = false;
	private stopKey?: string;
	private nextAt?: number;
	private last?: WarmRecord;
	private budgetThinking = false;
	private listeners = new Set<() => void>();
	/** Open ask_user_question dialogs (tool call ids). */
	private asks = new Set<string>();
	private askSince?: number;

	constructor(
		private pi: ExtensionAPI,
		cfg: Config,
	) {
		this.cfg = cfg;
	}

	get lang(): Lang {
		return resolveLang(this.cfg.lang);
	}

	setConfig(cfg: Config) {
		this.cfg = cfg;
		if (this.stopKey !== "broken") this.stopKey = undefined;
		this.schedule();
	}

	listen(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private emit() {
		for (const cb of this.listeners) {
			try {
				cb();
			} catch {
				/* listener errors must not break warming */
			}
		}
	}

	/** True while an rpiv ask_user_question dialog is waiting for the user. */
	asking(): boolean {
		return this.asks.size > 0;
	}

	askStartedAt(): number | undefined {
		return this.askSince;
	}

	private setAsk(id: string, active: boolean) {
		const before = this.asking();
		if (active) this.asks.add(id);
		else this.asks.delete(id);
		if (this.asking() === before) return;
		this.askSince = this.asking() ? Date.now() : undefined;
		// Entering an ask lifts stops caused by limits; leaving restores normal rules.
		if (this.asking() && this.stopKey && this.stopKey !== "broken" && this.stopKey !== "expired") this.stopKey = undefined;
		this.schedule();
	}

	/** Ask-time warming covers any model with a lifetime, even if it is not selected. */
	private askOverride(model: AnyModel | undefined): boolean {
		return this.asking() && this.cfg.enabled && this.cfg.askWarm && !!this.ttlMs(model);
	}

	isTracked(model: AnyModel | undefined): boolean {
		if (!model || !this.cfg.enabled) return false;
		return this.cfg.models.includes(modelKey(model)) || this.askOverride(model);
	}

	isSubscription(model: AnyModel | undefined): boolean {
		return !!model && this.cfg.subscription.includes(modelKey(model));
	}

	price(model: AnyModel): Price {
		return priceOf(model, this.isSubscription(model));
	}

	ttlMs(model: AnyModel | undefined): number | undefined {
		const override = Number(process.env.CACHE_WARM_PLUS_TTL_SEC); // test hook
		if (override > 0) return override * 1000;
		const retention = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
		const s = model?.promptCache?.[retention];
		return typeof s === "number" && s > 0 ? s * 1000 : undefined;
	}

	retention(): "short" | "long" {
		return process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
	}

	private sessionId(): string | undefined {
		try {
			return this.ctx?.sessionManager.getSessionId();
		} catch {
			return undefined;
		}
	}

	private contextTokens(): number | undefined {
		try {
			return this.ctx?.getContextUsage?.()?.tokens ?? undefined;
		} catch {
			return undefined;
		}
	}

	private keepWarmExceeded(): boolean {
		if (this.askOverride(this.snap?.model)) return false;
		const h = this.cfg.maxKeepWarmHours;
		if (!h || !this.snap) return false;
		return Date.now() - this.snap.lastReal > h * 3_600_000;
	}

	// ── wiring ───────────────────────────────────────────────────────────────

	register() {
		const pi = this.pi;

		pi.on("before_provider_request", (event, ctx) => {
			this.ctx = ctx;
			this.finishLive();
			const m = ctx.model as AnyModel;
			const p = event.payload as any;
			if (!m || !p || typeof p !== "object") return;
			const limit = p.max_tokens ?? p.max_output_tokens ?? p.max_completion_tokens;
			const req: Req = {
				at: Date.now(),
				model: m,
				api: String(m.api ?? ""),
				headers: {},
				isWarm: typeof limit === "number" && limit <= WARM_OUTPUT_LIMIT,
				done: false,
				ask: this.asking(),
			};
			if (!req.isWarm && TAKEOVER_APIS.has(req.api)) {
				try {
					req.payload = structuredClone(p);
				} catch {
					req.payload = undefined;
				}
			}
			this.queue.push(req);
			if (this.queue.length > 4) this.queue.shift();
		});

		pi.on("before_provider_headers", (event) => {
			const req = this.queue[this.queue.length - 1];
			if (!req) return;
			for (const [k, v] of Object.entries(event.headers ?? {})) if (typeof v === "string") req.headers[k] = v;
		});

		pi.on("after_provider_response", (event) => {
			const req = this.queue.shift();
			if (!req) return;
			if (event.status >= 400) {
				if (req.isWarm) this.logBuiltin(req, false, `HTTP ${event.status}`);
				return;
			}
			if (req.isWarm) this.touchByBuiltin(req);
			else this.commit(req);
			this.live = req;
		});

		pi.on("provider_stream_event", (event) => {
			const req = this.live;
			if (!req) return;
			const r = streamUsage(req.api, event.data);
			if (r.usage) req.usage = mergeUsage(req.usage, r.usage);
			if (r.final) this.finishLive();
		});

		pi.on("agent_end", () => {
			this.finishLive();
			// A finished run cannot still be waiting on a questionnaire.
			if (this.asks.size) {
				this.asks.clear();
				this.askSince = undefined;
				this.schedule();
			}
		});

		// rpiv ask_user_question: its public event plus the tool lifecycle as a fallback.
		pi.events.on(ASK_BLOCKED_EVENT, (data: unknown) => {
			const d = data as { active?: boolean; toolCallId?: string } | undefined;
			if (d && typeof d.active === "boolean") this.setAsk(d.toolCallId ?? "ask", d.active);
		});
		pi.on("tool_execution_start", (event: any) => {
			if (ASK_TOOLS.has(event?.toolName)) this.setAsk(event.toolCallId ?? "ask", true);
		});
		pi.on("tool_execution_end", (event: any) => {
			if (ASK_TOOLS.has(event?.toolName)) this.setAsk(event.toolCallId ?? "ask", false);
		});

		// Any change of conversation invalidates the replayable request.
		const reset = (_e: unknown, ctx: ExtensionContext) => {
			this.ctx = ctx;
			this.clear();
		};
		pi.on("session_start", reset);
		pi.on("session_tree", reset);
		pi.on("session_compact", reset);
		pi.on("model_select", reset);
		pi.on("session_shutdown", () => {
			this.clear();
			this.ctx = undefined;
		});

		// Override pi's built-in per-refresh decision for the selected models.
		pi.on("cache_warming_decision", (_event, ctx) => {
			this.ctx = ctx;
			if (!this.isTracked(ctx.model)) return;
			if (this.askOverride(ctx.model)) return { action: "warm" };
			if (this.keepWarmExceeded()) return { action: "stop" };
			if (this.cfg.ignoreEconomics) return { action: "warm" };
		});
	}

	private clear() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.snap = undefined;
		this.queue = [];
		this.live = undefined;
		this.nextAt = undefined;
		this.stopKey = undefined;
		this.budgetThinking = false;
		this.emit();
	}

	private commit(req: Req) {
		if (req.api === "anthropic-messages") this.budgetThinking = req.payload?.thinking?.type === "enabled";
		else this.budgetThinking = false;
		const key = modelKey(req.model);
		const prev = this.snap;
		const same = prev?.key === key;
		req.prevTouch = same ? prev!.lastTouch : undefined;
		req.prevStop = same ? (this.stopKey ?? undefined) : undefined;
		this.snap = {
			model: req.model,
			key,
			payload: req.payload,
			headers: req.headers,
			lastTouch: req.at,
			lastReal: req.at,
			pluginWarms: 0,
			builtinWarms: 0,
			broken: same ? prev!.broken : false,
			failures: 0,
		};
		if (this.stopKey !== "broken" || !same) this.stopKey = undefined;
		this.schedule();
	}

	private touchByBuiltin(req: Req) {
		const s = this.snap;
		if (!s || s.key !== modelKey(req.model)) return;
		s.lastTouch = req.at;
		s.builtinWarms += 1;
		this.schedule();
	}

	private finishLive() {
		const req = this.live;
		this.live = undefined;
		if (!req || req.done) return;
		req.done = true;
		if (req.isWarm) {
			this.logBuiltin(req, true);
			return;
		}
		// A real request that missed a cache we expected to be warm: record the rebuild.
		const u = req.usage;
		if (!u || req.prevTouch === undefined) return;
		const total = u.input + u.read + u.write;
		if (total < 4096 || u.read >= total * 0.3) return;
		const gap = req.at - req.prevTouch;
		const ttl = this.ttlMs(req.model) ?? 0;
		const reason =
			ttl && gap < ttl
				? "changed"
				: (req.prevStop ?? (!this.cfg.enabled ? "off" : !this.isTracked(req.model) ? "untracked" : "expired"));
		appendLog({
			at: req.at,
			kind: "rebuild",
			model: modelKey(req.model),
			session: this.sessionId(),
			ok: true,
			...u,
			cost: missPremium(this.price(req.model), total - u.read),
			sub: this.isSubscription(req.model) || undefined,
			gapMs: gap,
			reason,
		});
		this.emit();
	}

	private logBuiltin(req: Req, ok: boolean, error?: string) {
		const u = req.usage ?? { input: 0, read: 0, write: 0, output: 0 };
		const rec: WarmRecord = {
			at: req.at,
			ok,
			source: "builtin",
			read: u.read,
			write: u.write,
			cost: costOf(this.price(req.model), u),
			error,
			ask: req.ask || undefined,
		};
		this.last = rec;
		appendLog({
			at: req.at,
			kind: "warm",
			source: "builtin",
			model: modelKey(req.model),
			session: this.sessionId(),
			ok,
			...u,
			cost: rec.cost,
			avoid: missPremium(this.price(req.model), u.read),
			error,
			sub: this.isSubscription(req.model) || undefined,
			ask: req.ask || undefined,
		});
		this.emit();
	}

	// ── scheduling ───────────────────────────────────────────────────────────

	private canTakeover(s: Snapshot): boolean {
		return !!s.payload && TAKEOVER_APIS.has(s.model.api) && !this.budgetThinking;
	}

	private schedule() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.nextAt = undefined;
		const s = this.snap;
		if (!s || this.stopKey || s.broken || !this.canTakeover(s) || !this.isTracked(s.model)) return this.emit();
		const ttl = this.ttlMs(s.model);
		if (!ttl) return this.emit();
		// pi's built-in warmer refreshes at min(90% TTL, TTL - 10s). Always fire a few seconds after
		// that point so the two never refresh the same prefix twice, but still before expiry.
		const builtinDelay = Math.min(ttl * 0.9, ttl - MARGIN_MS);
		let delay = Math.min(ttl * (this.cfg.takeoverPct / 100), ttl - MARGIN_MS / 2);
		delay = Math.min(ttl - 3_000, Math.max(delay, builtinDelay + 3_000));
		this.nextAt = s.lastTouch + Math.max(1, Math.floor(delay));
		this.timer = setTimeout(() => void this.fire(), Math.max(0, this.nextAt - Date.now()));
		this.timer.unref?.();
		this.emit();
	}

	private economicsOk(s: Snapshot): boolean {
		if (this.cfg.ignoreEconomics || this.askOverride(s.model)) return true;
		const tokens = this.contextTokens() ?? 0;
		if (!tokens) return false;
		const p = this.price(s.model);
		const read = (tokens * p.cacheRead) / 1e6;
		return IDLE_CONTINUATION_PROBABILITY * missPremium(p, tokens) - read >= MIN_EXPECTED_SAVINGS;
	}

	private stop(key: string) {
		const already = this.stopKey === key;
		this.stopKey = key;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.nextAt = undefined;
		if (!already && this.snap) {
			appendLog({
				at: Date.now(),
				kind: "stop",
				model: this.snap.key,
				session: this.sessionId(),
				ok: true,
				input: 0,
				read: 0,
				write: 0,
				output: 0,
				cost: 0,
				reason: key,
			});
		}
		this.emit();
	}

	private async fire() {
		this.timer = undefined;
		const s = this.snap;
		if (!s || this.busy) return;
		const ttl = this.ttlMs(s.model) ?? 0;
		if (!this.isTracked(s.model)) return this.schedule();
		// A built-in warm is in flight: let it land, its response reschedules this timer.
		if (this.queue.some((r) => r.isWarm) || (this.live?.isWarm && !this.live.done)) {
			if (Date.now() < s.lastTouch + ttl - 3_000) {
				this.timer = setTimeout(() => void this.fire(), 2_000);
				this.timer.unref?.();
				return;
			}
		}
		if (this.keepWarmExceeded()) return this.stop("maxDuration");
		if (Date.now() > s.lastTouch + ttl - 3_000) return this.stop("expired");
		if (!this.economicsOk(s)) return this.stop("economics");
		await this.warm(false);
	}

	// ── replay ───────────────────────────────────────────────────────────────

	private buildRequest(s: Snapshot, auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string }) {
		const api: string = s.model.api;
		const body = structuredClone(s.payload);
		const base = String(auth.baseUrl ?? s.model.baseUrl ?? "").replace(/\/+$/, "");
		const headers: Record<string, string> = { "content-type": "application/json" };
		for (const src of [s.model.headers, auth.headers, s.headers]) {
			for (const [k, v] of Object.entries(src ?? {})) if (typeof v === "string") headers[k.toLowerCase()] = v;
		}
		for (const k of ["content-length", "host", "accept-encoding", "connection"]) delete headers[k];
		headers.accept = "application/json";
		const bearer = () => {
			if (auth.apiKey && !headers.authorization) headers.authorization = `Bearer ${auth.apiKey}`;
		};
		let url: string;
		if (api === "anthropic-messages") {
			const betas: string[] | undefined = Array.isArray(body.betas) ? body.betas : undefined;
			delete body.betas;
			body.max_tokens = 1;
			body.stream = false;
			headers["anthropic-version"] ??= "2023-06-01";
			if (betas?.length && !headers["anthropic-beta"]) headers["anthropic-beta"] = betas.join(",");
			if (auth.apiKey && !headers["x-api-key"] && !headers.authorization) {
				if (auth.apiKey.includes("sk-ant-oat")) headers.authorization = `Bearer ${auth.apiKey}`;
				else headers["x-api-key"] = auth.apiKey;
			}
			url = `${base}/v1/messages?beta=true`;
		} else if (api === "openai-responses") {
			body.stream = false;
			delete body.stream_options;
			body.max_output_tokens = WARM_OUTPUT_LIMIT;
			bearer();
			url = `${base}/responses`;
		} else {
			body.stream = false;
			delete body.stream_options;
			if ("max_completion_tokens" in body) body.max_completion_tokens = 1;
			else body.max_tokens = 1;
			bearer();
			url = `${base}/chat/completions`;
		}
		return { url, headers, body };
	}

	/** Replay the last real request with a tiny output cap. Returns a user-facing message. */
	async warm(manual: boolean): Promise<{ ok: boolean; message: string }> {
		const lang = this.lang;
		const s = this.snap;
		const ctx = this.ctx;
		if (!s || !ctx || !s.payload) return { ok: false, message: t(lang, "n_no_snapshot") };
		if (!this.canTakeover(s)) return { ok: false, message: t(lang, "state_unsupported") };
		if (this.busy) return { ok: false, message: t(lang, "state_busy") };
		const source: WarmSource = manual ? "manual" : "plugin";
		this.busy = true;
		this.emit();
		const started = Date.now();
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(s.model);
			if (!auth.ok) throw new Error(auth.error);
			const { url, headers, body } = this.buildRequest(s, auth);
			const res = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			const text = await res.text();
			if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
			const u = usageFrom(s.model.api, JSON.parse(text).usage) ?? { input: 0, read: 0, write: 0, output: 0 };
			const cost = costOf(this.price(s.model), u);
			s.lastTouch = Date.now();
			s.pluginWarms += 1;
			s.failures = 0;
			this.last = { at: s.lastTouch, ok: true, source, read: u.read, write: u.write, cost, ask: this.asking() || undefined };
			appendLog({
				at: s.lastTouch,
				kind: "warm",
				source,
				model: s.key,
				session: this.sessionId(),
				ok: true,
				...u,
				cost,
				avoid: missPremium(this.price(s.model), u.read),
				ms: s.lastTouch - started,
				sub: this.isSubscription(s.model) || undefined,
				ask: this.asking() || undefined,
			});
			const total = u.input + u.read + u.write;
			if (total > 1024 && u.read < total * 0.5) {
				// The replay did not hit the existing cache: our request differs from pi's.
				s.broken = true;
				if (ctx.hasUI) ctx.ui.notify(t(lang, "n_broken", { read: u.read, write: u.write + u.input }), "warning");
				this.stop("broken");
			} else {
				this.schedule();
			}
			return { ok: true, message: t(lang, "n_warmed", { read: u.read, write: u.write, cost: cost.toFixed(4) }) };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.last = { at: Date.now(), ok: false, source, read: 0, write: 0, cost: 0, error: msg };
			appendLog({
				at: Date.now(),
				kind: "warm",
				source,
				model: s.key,
				session: this.sessionId(),
				ok: false,
				input: 0,
				read: 0,
				write: 0,
				output: 0,
				cost: 0,
				ms: Date.now() - started,
				error: msg.slice(0, 300),
				ask: this.asking() || undefined,
			});
			s.failures += 1;
			const ttl = this.ttlMs(s.model) ?? 0;
			if (!manual) {
				if (s.failures >= 3 || Date.now() > s.lastTouch + ttl - 15_000) this.stop("failed");
				else {
					// Retry soon, still inside the TTL.
					this.nextAt = Date.now() + 20_000;
					this.timer = setTimeout(() => void this.fire(), 20_000);
					this.timer.unref?.();
				}
			}
			return { ok: false, message: t(lang, "n_warm_failed", { err: msg }) };
		} finally {
			this.busy = false;
			this.emit();
		}
	}

	/** Resume after a stop (e.g. the max duration was reached) without waiting for a new request. */
	resume(): boolean {
		const s = this.snap;
		if (!s || s.broken) return false;
		const ttl = this.ttlMs(s.model) ?? 0;
		if (Date.now() > s.lastTouch + ttl - 3_000) return false;
		this.stopKey = undefined;
		s.lastReal = Date.now();
		this.schedule();
		return true;
	}

	// ── status for the UI ────────────────────────────────────────────────────

	status(model: AnyModel | undefined): Status {
		const s = this.snap;
		const base: Status = {
			state: "waiting",
			takeover: false,
			pluginWarms: s?.pluginWarms ?? 0,
			builtinWarms: s?.builtinWarms ?? 0,
			last: this.last,
			asking: this.asking(),
			askSince: this.askSince,
		};
		if (!this.cfg.enabled) return { ...base, state: "off" };
		if (!model) return base;
		const key = modelKey(model);
		const ttl = this.ttlMs(model);
		const api = String(model.api ?? "");
		const out: Status = { ...base, modelKey: key, api, ttlMs: ttl, takeover: TAKEOVER_APIS.has(api) };
		const tokens = this.contextTokens();
		out.subscription = this.isSubscription(model);
		if (tokens) {
			const p = this.price(model);
			out.tokens = tokens;
			// A warm reads the whole prefix from cache and sends a couple of new tokens.
			out.estWarmCost = costOf(p, { read: tokens, input: 4, write: 0, output: 1 });
			out.estRebuildCost = missPremium(p, tokens);
		}
		if (!this.isTracked(model)) return { ...out, state: "untracked" };
		if (!ttl) return { ...out, state: "nottl" };
		if (!out.takeover) return { ...out, state: "unsupported" };
		if (this.busy) return { ...out, state: "busy" };
		if (this.budgetThinking) return { ...out, state: "thinking" };
		if (!s || s.key !== key) return { ...out, state: "waiting" };
		out.lastTouch = s.lastTouch;
		out.lastReal = s.lastReal;
		if (this.stopKey || s.broken) return { ...out, state: "stopped", stopKey: this.stopKey ?? "broken" };
		out.nextAt = this.nextAt;
		return { ...out, state: "scheduled" };
	}
}
