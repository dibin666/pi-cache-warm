import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function runForcedChecks({ jiti, src, agentDir, ctx, engine, pi, open, draw, click, strip, fail }) {
	const { Engine, costOf, priceOf } = await jiti.import(join(src, "engine.ts"));
	const { loadConfig, saveConfig, CONFIG_PATH } = await jiti.import(join(src, "config.ts"));
	const { readLog, appendLog, summarize, bucketize, withoutInitialRebuilds } = await jiti.import(join(src, "history.ts"));
	const { readAnthropicStart } = await jiti.import(join(src, "anthropic-stream.ts"));
	const extension = (await jiti.import(join(src, "index.ts"))).default;
	const originalFetch = globalThis.fetch;
	const originalConfig = readFileSync(CONFIG_PATH, "utf8");
	const fixtures = [];
	let count = 0;
	const check = async (name, fn) => {
		try { await fn(); count++; }
		catch (err) { fail(`forced ${name}: ${err.stack}`); }
	};
	const initial = { input_tokens: 100, cache_read_input_tokens: 7000, cache_creation_input_tokens: 0, output_tokens: 1 };
	const payload = {
		model: "test-thinking", stream: true, max_tokens: 16384,
		thinking: { type: "enabled", budget_tokens: 8192 }, output_config: { effort: "high" },
		betas: ["test-beta"], tool_choice: { type: "auto" },
		tools: [{ name: "do_not_execute", description: "offline test", input_schema: { type: "object", properties: {} }, cache_control: { type: "ephemeral" } }],
		system: [{ type: "text", text: "系统前缀", cache_control: { type: "ephemeral" } }],
		messages: [{ role: "user", content: [{ type: "text", text: "original conversation", cache_control: { type: "ephemeral" } }] }],
	};
	let nextId = 0;
	const make = (options = {}) => {
		const name = options.name ?? `case-${nextId++}`;
		const key = `offline-force/${name}`;
		const model = { provider: "offline-force", id: name, api: "anthropic-messages", baseUrl: "http://offline.invalid", promptCache: { short: 300, long: 300 }, cost: { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 }, ...options.model };
		const context = {
			...ctx, model, sessionManager: { getSessionId: () => `force-${name}` },
			getContextUsage: () => ({ tokens: 7100 }),
			modelRegistry: { ...ctx.modelRegistry, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "offline-key" }) },
		};
		const h = {};
		const e = new Engine({ on: (event, fn) => (h[event] = fn), events: { on() {} } }, {
			...loadConfig(), enabled: true, models: [key], forceModels: options.force === false ? [] : [key],
			subscription: [], lang: "zh", ignoreEconomics: false, maxKeepWarmHours: 0,
		});
		e.register();
		h.session_start({}, context);
		const send = (body = payload, usage = initial, headers = { "x-session-affinity": name }) => {
			h.before_provider_headers({ headers }, context);
			// Later header handlers may add fields in place before the payload hook.
			headers["x-late-header"] = "preserve-me";
			h.before_provider_request({ payload: body }, context);
			h.after_provider_response({ status: 200 }, context);
			if (usage) {
				h.provider_stream_event({ data: { type: "message_start", message: { usage } } }, context);
				h.provider_stream_event({ data: { type: "message_stop" } }, context);
			}
		};
		const rows = () => readLog().filter((row) => row.session === `force-${name}`);
		const fixture = { e, h, model, context, key, send, rows };
		fixtures.push(fixture);
		return fixture;
	};
	const startEvent = (usage = initial) => ({ type: "message_start", message: { model: "测试模型", usage } });
	const wire = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
	const stream = (events, options = {}) => {
		let cancelled = false;
		let reads = 0;
		const bytes = new TextEncoder().encode(options.text ?? wire(events));
		let offset = 0;
		const body = new ReadableStream({
			pull(controller) {
				reads++;
				if (offset < bytes.length) {
					const end = Math.min(bytes.length, offset + (options.chunkSize ?? bytes.length));
					controller.enqueue(bytes.slice(offset, end));
					offset = end;
				} else if (options.eof) controller.close();
			},
			cancel() { cancelled = true; },
		});
		return { response: new Response(body, { headers: { "content-type": options.contentType ?? "text/event-stream; charset=utf-8" } }), cancelled: () => cancelled, reads: () => reads };
	};
	const mock = async (fetch, fn) => {
		globalThis.fetch = fetch;
		try { return await fn(); } finally { globalThis.fetch = originalFetch; }
	};

	try {
		await check("config migration and round trip", () => {
			writeFileSync(CONFIG_PATH, JSON.stringify({ models: ["p/m"] }));
			assert.deepEqual(loadConfig().forceModels, []);
			writeFileSync(CONFIG_PATH, JSON.stringify({ forceModels: [null, 4, "bad", "p/m", "p/m", "q/n"] }));
			assert.deepEqual(loadConfig().forceModels, ["p/m", "q/n"]);
			writeFileSync(CONFIG_PATH, JSON.stringify({ forceModels: "p/m" }));
			assert.deepEqual(loadConfig().forceModels, []);
			saveConfig({ ...loadConfig(), forceModels: ["p/m"] });
			assert.deepEqual(loadConfig().forceModels, ["p/m"]);
			writeFileSync(CONFIG_PATH, originalConfig);
		});

		await check("SSE fragmented UTF-8, CRLF, multiline data, heartbeat and cancellation", async () => {
			const text = `: comment\r\n\r\nevent: ping\r\ndata: {"type":"ping"}\r\n\r\nevent: message_start\r\ndata: {"type":"message_start",\r\ndata: "message":${JSON.stringify(startEvent().message)}}\r\n\r\n`;
			const s = stream([], { text, chunkSize: 1 });
			let aborted = false;
			const event = await readAnthropicStart(s.response, () => (aborted = true));
			assert.equal(event.message.model, "测试模型");
			assert.equal(event.message.usage.cache_read_input_tokens, 7000);
			assert.ok(aborted && s.cancelled());
		});
		for (const [name, events, options] of [
			["heartbeat alone", [{ type: "ping" }], { eof: true }],
			["content before usage", [{ type: "content_block_start" }], {}],
			["provider error", [{ type: "error", error: { message: "offline error" } }], {}],
			["invalid JSON", [], { text: "data: invalid\n\n" }],
			["oversized probe", [], { text: ":" + "x".repeat(300_000) }],
			["JSON instead of SSE", [], { text: "{}", contentType: "application/json" }],
		]) {
			await check(`SSE rejects ${name}`, async () => {
				const s = stream(events, options);
				let aborted = false;
				await assert.rejects(readAnthropicStart(s.response, () => (aborted = true)));
				assert.ok(aborted);
				if (!options.eof) assert.ok(s.cancelled());
			});
		}

		await check("default safety, per-model opt-in and real-usage baseline", async () => {
			let calls = 0;
			await mock(async () => { calls++; throw new Error("must not fetch"); }, async () => {
				const normal = make({ force: false });
				normal.send();
				assert.equal(normal.e.status(normal.model).state, "thinking");
				assert.equal((await normal.e.warm(true)).ok, false);
				const pending = make();
				pending.send(payload, null);
				assert.equal(pending.e.status(pending.model).state, "waiting");
				assert.equal((await pending.e.warm(true)).ok, false);
				pending.h.provider_stream_event({ data: startEvent() }, pending.context);
				assert.equal(pending.e.status(pending.model).state, "scheduled");
				assert.ok(pending.e.status(pending.model).nextAt);
				assert.equal(calls, 0);
			});
		});

		await check("original cached request and session headers preserved, no standalone ping", async () => {
			const f = make();
			const body = structuredClone(payload);
			const original = structuredClone(body);
			f.send(body, initial, { "x-session-affinity": "session-a", "anthropic-beta": "identity-beta", "content-length": "999" });
			const response = stream([{ type: "ping" }, startEvent(), { type: "content_block_start", content_block: { type: "tool_use", name: "do_not_execute" } }]);
			let signal;
			await mock(async (url, options) => {
				signal = options.signal;
				assert.ok(url.endsWith("/v1/messages?beta=true"));
				assert.equal(options.headers["x-session-affinity"], "session-a");
				assert.equal(options.headers["x-late-header"], "preserve-me");
				assert.equal(options.headers["anthropic-beta"], "identity-beta");
				assert.equal(options.headers["content-length"], undefined);
				assert.equal(options.headers.accept, "text/event-stream");
				const expected = structuredClone(original);
				delete expected.betas;
				assert.deepEqual(JSON.parse(options.body), expected);
				return response.response;
			}, async () => {
				const result = await f.e.warm(true);
				assert.ok(result.ok, result.message);
				assert.ok(result.message.includes("最终计费"));
			});
			assert.deepEqual(body, original);
			assert.ok(signal.aborted && response.cancelled());
			const record = f.rows().at(-1);
			assert.ok(record.ok && record.force && record.partial);
			assert.equal(record.read, 7000);
			assert.equal(record.cost, costOf(priceOf(f.model), { input: 100, read: 7000, write: 0, output: 1 }));
			assert.equal(f.e.status(f.model).pluginWarms, 1);
			assert.equal(f.e.status(f.model).estWarmCost, undefined);
		});

		await check("provider-derived session affinity is kept when header hooks omit it", async () => {
			for (const [model, header] of [
				[{ compat: { sendSessionAffinityHeaders: true } }, "x-session-affinity"],
				[{ baseUrl: "https://openrouter.ai/api" }, "x-session-id"],
			]) {
				const f = make({ model }); f.send(payload, initial, {});
				await mock(async (_url, options) => {
					assert.equal(options.headers[header], f.context.sessionManager.getSessionId());
					return stream([startEvent()]).response;
				}, async () => assert.ok((await f.e.warm(true)).ok));
			}
		});

		await check("manual verified retry lifts the stop and ordinary models retain tiny caps", async () => {
			const f = make(); f.send();
			await mock(async () => stream([startEvent({ ...initial, cache_read_input_tokens: 0 })]).response, async () => assert.equal((await f.e.warm(true)).ok, false));
			assert.equal(f.e.status(f.model).state, "stopped");
			await mock(async () => stream([startEvent()]).response, async () => assert.ok((await f.e.warm(true)).ok));
			assert.equal(f.e.status(f.model).state, "scheduled");
			assert.ok(f.e.status(f.model).nextAt);
			for (const thinking of [undefined, { type: "adaptive" }]) {
				f.send({ ...payload, thinking });
				await mock(async (_url, options) => {
					const body = JSON.parse(options.body);
					assert.equal(body.max_tokens, 1);
					assert.equal(body.stream, false);
					assert.deepEqual(body.thinking, thinking);
					return new Response(JSON.stringify({ usage: initial }));
				}, async () => assert.ok((await f.e.warm(true)).ok));
				assert.ok(f.rows().at(-1).force);
				assert.ok(!f.rows().at(-1).partial);
			}
		});

		await check("TTL starts at dispatch, not response completion", async () => {
			const realNow = Date.now;
			let clock = realNow();
			Date.now = () => clock;
			try {
				const f = make();
				f.send();
				const started = clock;
				await mock(async () => { clock += 10_000; return stream([startEvent()]).response; }, async () => assert.ok((await f.e.warm(true)).ok));
				assert.equal(f.e.status(f.model).lastTouch, started);
				assert.ok(f.e.status(f.model).nextAt < clock + 279_000);
			} finally { Date.now = realNow; }
		});

		for (const [name, usage, reason] of [
			["cache miss", { ...initial, input_tokens: 7000, cache_read_input_tokens: 0, cache_creation_input_tokens: 7000 }, "broken"],
			["tools-only hit", { ...initial, input_tokens: 7000, cache_read_input_tokens: 64 }, "broken"],
			["shorter prefix", { ...initial, input_tokens: 0, cache_read_input_tokens: 100 }, "broken"],
			["missing cache usage", { input_tokens: 7000, output_tokens: 1 }, "unverified"],
			["invalid cache usage", { ...initial, cache_read_input_tokens: "7000" }, "unverified"],
		]) {
			await check(`${name} is not a successful refresh and stops automatic spending`, async () => {
				const f = make();
				f.send();
				const touch = f.e.status(f.model).lastTouch;
				await mock(async () => stream([startEvent(usage)]).response, async () => assert.equal((await f.e.warm(false)).ok, false));
				let status = f.e.status(f.model);
				assert.equal(status.state, "stopped");
				assert.equal(status.stopKey, reason);
				assert.equal(status.nextAt, undefined);
				assert.equal(status.lastTouch, touch);
				assert.equal(status.pluginWarms, 0);
				const record = f.rows().findLast((e) => e.kind === "warm");
				assert.equal(record.ok, false);
				assert.ok(!record.avoid);
				assert.equal(summarize(f.rows()).warmCost, record.cost);
				assert.equal(bucketize(f.rows(), "24h", "cost").reduce((sum, b) => sum + b.failed, 0), record.cost);
				f.e.setConfig({ ...f.e.cfg });
				f.send();
				status = f.e.status(f.model);
				assert.equal(status.state, "stopped");
				assert.equal(status.nextAt, undefined);
			});
		}

		for (const [name, response] of [
			["non-streaming", () => new Response("{}", { headers: { "content-type": "application/json" } })],
			["empty stream", () => stream([{ type: "ping" }], { eof: true }).response],
			["HTTP failure", () => new Response("offline failure", { status: 503 })],
			["stream failure", () => stream([{ type: "error", error: { message: "offline failure" } }]).response],
		]) {
			await check(`${name} is unverified`, async () => {
				const f = make(); f.send();
				await mock(async () => response(), async () => assert.equal((await f.e.warm(false)).ok, false));
				assert.equal(f.e.status(f.model).stopKey, "unverified");
				assert.equal(f.e.status(f.model).nextAt, undefined);
			});
		}
		await check("forced timeout aborts and stops without retries", async () => {
			const f = make(); f.send();
			const originalTimer = globalThis.setTimeout;
			const keepAlive = originalTimer(() => {}, 1000);
			globalThis.setTimeout = (fn, ms, ...args) => originalTimer(fn, ms === 30_000 ? 1 : ms, ...args);
			try {
				await mock(async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })), async () => {
					assert.equal((await f.e.warm(false)).ok, false);
				});
				assert.equal(f.e.status(f.model).stopKey, "unverified");
				assert.equal(f.e.status(f.model).nextAt, undefined);
			} finally { globalThis.setTimeout = originalTimer; clearTimeout(keepAlive); }
		});
		await check("failed manual replay cancels the old timer instead of silently retrying", async () => {
			const f = make(); f.send();
			assert.ok(f.e.status(f.model).nextAt);
			await mock(async () => new Response("offline", { status: 503 }), async () => assert.equal((await f.e.warm(true)).ok, false));
			assert.equal(f.e.status(f.model).nextAt, undefined);
			assert.equal(f.e.status(f.model).stopKey, "unverified");
		});
		await check("cancelled header values do not leak model defaults", async () => {
			const f = make({ model: { headers: { "x-remove": "must-not-send" } } });
			f.send(payload, initial, { "x-remove": null });
			await mock(async (_url, options) => {
				assert.equal(options.headers["x-remove"], undefined);
				return stream([startEvent()]).response;
			}, async () => assert.ok((await f.e.warm(true)).ok));
		});
		await check("invalid thinking budget never reaches the provider", async () => {
			const f = make(); f.send({ ...payload, max_tokens: 8192 });
			let calls = 0;
			await mock(async () => { calls++; }, async () => assert.equal((await f.e.warm(true)).ok, false));
			assert.equal(calls, 0);
			assert.equal(f.e.status(f.model).stopKey, "unverified");
		});
		await check("automatic forced timer bypasses only the economics guard", async () => {
			const realNow = Date.now;
			const realSet = globalThis.setTimeout;
			const realClear = globalThis.clearTimeout;
			let clock = realNow();
			const timers = [];
			Date.now = () => clock;
			globalThis.setTimeout = (fn, ms) => { const timer = { fn, ms, unref() {}, cleared: false }; timers.push(timer); return timer; };
			globalThis.clearTimeout = (timer) => { if (timer) timer.cleared = true; };
			try {
				const f = make(); f.send();
				assert.equal(f.h.cache_warming_decision({}, f.context).action, "warm");
				clock = f.e.status(f.model).nextAt;
				await mock(async () => stream([startEvent()]).response, async () => {
					const timer = timers.findLast((t) => !t.cleared);
					timer.fn();
					for (let n = 0; n < 5 && !f.rows().length; n++) await delay(0);
					assert.equal(f.e.status(f.model).pluginWarms, 1);
					assert.ok(f.e.status(f.model).nextAt > clock);
				});
				f.e.setConfig({ ...f.e.cfg, maxKeepWarmHours: 1 });
				clock += 3600_001;
				assert.equal(f.h.cache_warming_decision({}, f.context).action, "stop");
				f.e.setConfig({ ...f.e.cfg, enabled: false });
				assert.equal(f.e.status(f.model).state, "off");
				assert.equal(f.e.status(f.model).nextAt, undefined);
				f.h.session_shutdown({}, f.context);
			} finally { Date.now = realNow; globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; }
		});

		for (const name of ["shutdown", "new real request", "force disabled", "plugin disabled", "model changed"]) {
			await check(`${name} aborts an in-flight forced refresh`, async () => {
				const f = make(); f.send();
				let signal;
				await mock(async (_url, options) => {
					signal = options.signal;
					return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
				}, async () => {
					const promise = f.e.warm(false);
					await delay(0);
					assert.ok(signal);
					if (name === "shutdown") f.h.session_shutdown({}, f.context);
					else if (name === "new real request") f.send();
					else if (name === "force disabled") f.e.setConfig({ ...f.e.cfg, forceModels: [] });
					else if (name === "plugin disabled") f.e.setConfig({ ...f.e.cfg, enabled: false });
					else f.h.model_select({}, { ...f.context, model: { ...f.model, id: "new-model" } });
					assert.ok(signal.aborted);
					assert.equal((await promise).ok, false);
					assert.equal(f.rows().length, 0, "cancelled refresh must not log into a stale session");
				});
			});
		}

		await check("real HTTP stream is cancelled after cache usage", async () => {
			let observed;
			let closed;
			const closePromise = new Promise((resolve) => (closed = resolve));
			const server = createServer((req, res) => {
				let text = "";
				req.on("data", (data) => (text += data));
				req.on("end", () => {
					observed = JSON.parse(text);
					res.writeHead(200, { "content-type": "text/event-stream" });
					res.write(wire([{ type: "ping" }, startEvent()]));
					res.on("close", closed);
				});
			});
			await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
			try {
				const f = make({ model: { baseUrl: `http://127.0.0.1:${server.address().port}` } }); f.send();
				const result = await f.e.warm(true);
				assert.ok(result.ok, result.message);
				assert.deepEqual(observed.messages, payload.messages);
				assert.deepEqual(observed.thinking, payload.thinking);
				assert.equal(observed.max_tokens, payload.max_tokens);
				assert.equal(await Promise.race([closePromise.then(() => true), delay(1000, false)]), true);
			} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
		});

		await check("per-model command persists opt-in and validates API/TTL", async () => {
			const commands = {};
			const events = {};
			const notices = [];
			extension({ on: (event, fn) => ((events[event] ??= []).push(fn)), events: { on() {} }, registerCommand: (name, command) => (commands[name] = command) });
			const f = make();
			const context = { ...f.context, ui: { ...f.context.ui, notify: (text) => notices.push(text) } };
			assert.ok(commands.cachewarm.getArgumentCompletions("force").some((c) => c.value === "force on"));
			await commands.cachewarm.handler("force on", context);
			assert.ok(loadConfig().forceModels.includes(f.key));
			assert.ok(loadConfig().models.includes(f.key));
			await commands.cachewarm.handler("force off", context);
			assert.ok(!loadConfig().forceModels.includes(f.key));
			assert.ok(loadConfig().models.includes(f.key));
			const before = readFileSync(CONFIG_PATH, "utf8");
			await commands.cachewarm.handler("force on", { ...context, model: { ...f.model, api: "openai-responses" } });
			await commands.cachewarm.handler("force on", { ...context, model: { ...f.model, promptCache: {} } });
			assert.equal(readFileSync(CONFIG_PATH, "utf8"), before);
			assert.equal(notices.length, 4);
			await commands.cachewarm.handler("status", context);
			await commands.cachewarm.handler("force maybe", context);
			await commands.cachewarm.handler("force on", { ...context, model: undefined });
			assert.equal(notices.length, 7);
			writeFileSync(CONFIG_PATH, originalConfig);
		});

		await check("model editor force switch saves/cancels and shows both languages", async () => {
			const cfg = structuredClone(engine.cfg);
			const modelMetadata = readFileSync(join(agentDir, "models.json"), "utf8");
			try {
				for (const lang of ["zh", "en"]) {
					engine.setConfig({ ...engine.cfg, forceModels: [] });
					const opts = { name: `force-editor-${lang}`, lang, tab: 2, cols: 70, rows: 22 };
					let panel = await open(opts);
					click(draw(opts), ctx.model.id, "force editor");
					click(draw(opts), lang === "zh" ? "强制保温" : "Force warming", "force switch");
					assert.ok(panel.dirty());
					assert.ok(draw(opts).map(strip).join("\n").includes(lang === "zh" ? "额外计费" : "extra charges"));
					assert.deepEqual(engine.cfg.forceModels, []);
					panel.handleInput("\x13");
					await delay(10);
					assert.ok(engine.cfg.forceModels.includes(`${ctx.model.provider}/${ctx.model.id}`));
					assert.equal(readFileSync(join(agentDir, "models.json"), "utf8"), modelMetadata);
					panel.dispose();
					panel = await open(opts);
					click(draw(opts), ctx.model.id, "reopen force editor");
					click(draw(opts), lang === "zh" ? "强制保温" : "Force warming", "draft force off");
					panel.handleInput("\x1b"); panel.handleInput("\x1b");
					assert.ok(engine.cfg.forceModels.includes(`${ctx.model.provider}/${ctx.model.id}`), "discard must not save force off");
					click(draw(opts), ctx.model.id, "edit persisted force switch");
					click(draw(opts), lang === "zh" ? "强制保温" : "Force warming", "persist force off");
					panel.handleInput("\x13");
					await delay(10);
					assert.ok(!engine.cfg.forceModels.includes(`${ctx.model.provider}/${ctx.model.id}`));
					panel.dispose();
				}
			} finally { engine.setConfig(cfg); writeFileSync(CONFIG_PATH, originalConfig); }
		});
		await check("forced partial history is visible and explains incomplete billing", async () => {
			const sessionManager = ctx.sessionManager;
			ctx.sessionManager = { getSessionId: () => "forced-ui" };
			appendLog({ at: Date.now(), kind: "warm", source: "manual", model: "offline/forced-model", session: "forced-ui", ok: true, input: 100, read: 7000, write: 0, output: 1, cost: 0.002, force: true, partial: true });
			assert.equal(withoutInitialRebuilds(readLog().filter((row) => row.session === "forced-ui")).length, 1);
			try {
				for (const lang of ["zh", "en"]) {
					const opts = { name: `force-history-${lang}`, lang, tab: 1, cols: 90, rows: 40 };
					const panel = await open(opts);
					panel.shared.pref({ historyFilter: "session", historyRange: "24h" });
					click(draw(opts), "forced-model", "forced history details");
					const text = draw(opts).map(strip).join("\n");
					assert.ok(text.includes(lang === "zh" ? "最终计费" : "final charges"));
					assert.ok(text.includes(lang === "zh" ? "强制" : "force"));
					panel.dispose();
				}
			} finally { ctx.sessionManager = sessionManager; }
		});
	} finally {
		globalThis.fetch = originalFetch;
		writeFileSync(CONFIG_PATH, originalConfig);
		for (const fixture of fixtures) fixture.h.session_shutdown({}, fixture.context);
	}
	console.log(`forced: ${count} checks passed`);
}
