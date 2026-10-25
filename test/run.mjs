// Offline checks: i18n coverage, character icons, and TUI rendering of every view in both
// languages. Uses the jiti bundled with pi.
//   node test/run.mjs [--print]
import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");
const piBin = execSync("command -v pi", { encoding: "utf8" }).trim();
const home = process.env.HOME;
const version = readFileSync(join(home, ".pi/agent/install/current-version"), "utf8").trim();
const nm = process.env.PI_NODE_MODULES ?? join(home, `.pi/agent/install/releases/${version}/node_modules`);
const require = createRequire(join(nm, "x.js"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: {
		"@earendil-works/pi-tui": join(nm, "@earendil-works/pi-tui/dist/index.js"),
		"@earendil-works/pi-coding-agent": join(nm, "@earendil-works/pi-coding-agent/dist/index.js"),
	},
});
void piBin;

// Isolate config / log files from the real agent dir.
const agentDir = mkdtempSync(join(tmpdir(), "cwp-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({ providers: { "my-anthropic": { models: [{ id: "claude-opus-5-5", cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, promptCache: { short: 1800, long: 1800 } }] } } }),
);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "idle", theme: "dark" }));
writeFileSync(join(agentDir, "cache-warm-plus.json"), JSON.stringify({ models: ["my-anthropic/claude-opus-5-5", "my-anthropic/claude-sonnet-5-5"] }));

const tui = await jiti.import(join(nm, "@earendil-works/pi-tui/dist/index.js"));
const args = process.argv.slice(2);
const print = args.includes("--print");
let failures = 0;
const fail = (m) => {
	failures++;
	console.error(`FAIL ${m}`);
};

// ── i18n coverage ──
const i18n = await jiti.import(join(src, "i18n.ts"));
const files = [];
const walk = (d) => {
	for (const f of readdirSync(d, { withFileTypes: true })) {
		if (f.isDirectory()) walk(join(d, f.name));
		else if (f.name.endsWith(".ts")) files.push(join(d, f.name));
	}
};
walk(src);
const used = new Set();
for (const f of files) {
	const text = readFileSync(f, "utf8");
	for (const m of text.matchAll(/\b(?:tr|t)\((?:lang, |[a-z.]*lang, )?"([a-zA-Z0-9_]+)"/g)) used.add(m[1]);
	for (const m of text.matchAll(/\b(?:label|hint): "([a-zA-Z0-9_]+)"/g)) used.add(m[1]);
}
const dynamic = {
	state_: ["off", "untracked", "unsupported", "nottl", "waiting", "scheduled", "busy", "thinking", "stopped_short"],
	state_stopped_: ["maxDuration", "expired", "broken", "economics", "auth", "failed"],
	mode_: ["off", "streaming", "idle"],
	src_: ["plugin", "builtin"],
	kind_: ["rebuild", "stop"],
	why_: ["changed", "expired", "untracked", "off", "maxDuration", "broken", "economics", "failed", "auth"],
	range_: ["6h", "24h", "7d", "30d"],
	series_: ["plugin", "builtin", "manual", "failed", "rebuild"],
};
for (const [p, list] of Object.entries(dynamic)) for (const s of list) used.add(p + s);
for (const k of used) {
	if (k === "zh" || k === "en") continue;
	for (const lang of ["zh", "en"]) if (!i18n.t(lang, k)) fail(`missing i18n ${lang}:${k}`);
}
console.log(`i18n: ${used.size} keys checked`);

// ── icons ──
const iconsMod = await jiti.import(join(src, "icons.ts"));
{
	const tuiMod = await jiti.import(join(nm, "@earendil-works/pi-tui/dist/index.js"));
	const iconsSrc = readFileSync(join(src, "icons.ts"), "utf8");
	const glyphs = [...iconsSrc.matchAll(/^\t([a-zA-Z0-9]+): "(.*)",$/gm)];
	const plain = { fg: (_t, s) => s };
	const icons = new iconsMod.Icons();
	for (const [, n, g] of glyphs) {
		if ([...g].length !== 1 || tuiMod.visibleWidth(g) !== 1) fail(`icon ${n}: "${g}" is not one single-width glyph`);
		if (/\p{Extended_Pictographic}/u.test(g) && !"©®".includes(g)) fail(`icon ${n}: "${g}" may render as emoji`);
		if (tuiMod.visibleWidth(icons.icon(plain, n, "text", "", 2)) !== 2) fail(`icon ${n}: wrong padded width`);
	}
	console.log(`icons: ${glyphs.length} glyphs checked`);
}

// ── TUI rendering ──
const { Engine } = await jiti.import(join(src, "engine.ts"));
const { loadConfig } = await jiti.import(join(src, "config.ts"));
const { appendLog, readLog } = await jiti.import(join(src, "history.ts"));
const panelMod = await jiti.import(join(src, "ui/panel.ts"));

const now = Date.now();
for (let i = 0; i < 40; i++) {
	const at = now - i * 27 * 60_000;
	appendLog({ at, kind: "warm", source: i % 5 === 0 ? "builtin" : i % 9 === 0 ? "manual" : "plugin", model: "my-anthropic/claude-opus-5-5", session: "s1", ok: i !== 7, input: 2, read: 120000 + i * 1000, write: 0, output: 1, cost: 0.025, avoid: 0.6, ms: 900 });
}
appendLog({ at: now - 5 * 3600_000, kind: "rebuild", model: "my-anthropic/claude-opus-5-5", session: "s1", ok: true, input: 3, read: 0, write: 124411, output: 1, cost: 0.6, gapMs: 8 * 3600_000, reason: "maxDuration" });
appendLog({ at: now - 5.5 * 3600_000, kind: "stop", model: "my-anthropic/claude-opus-5-5", session: "s1", ok: true, input: 0, read: 0, write: 0, output: 0, cost: 0, reason: "maxDuration" });

const handlers = {};
const busHandlers = {};
const pi = {
	on: (e, h) => (handlers[e] = h),
	setModel: async () => true,
	events: { on: (e, h) => (busHandlers[e] = h), emit: (e, d) => busHandlers[e]?.(d) },
};
const engine = new Engine(pi, loadConfig());
engine.register();
const opus = { provider: "my-anthropic", id: "claude-opus-5-5", api: "anthropic-messages", baseUrl: "http://proxy:8085", promptCache: { short: 1800, long: 1800 }, cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } };
const gem = { provider: "my-gemini", id: "gemini-4-argon", api: "google-generative-ai", cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 } };
const gpt = { provider: "my-openai", id: "gpt-5.6-luna", api: "openai-responses", cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.13 } };
const ctx = {
	model: opus,
	mode: "tui",
	hasUI: true,
	getContextUsage: () => ({ tokens: 123000 }),
	sessionManager: { getSessionId: () => "s1" },
	modelRegistry: { getAvailable: () => [opus, gem, gpt], refresh: async () => ({}), find: () => opus },
	ui: { notify() {}, setStatus() {} },
};
handlers.before_provider_request({ payload: { model: "x", max_tokens: 1000, messages: [] } }, ctx);
handlers.after_provider_response({ status: 200 }, ctx);

const palette = { accent: [137, 180, 250], border: [88, 91, 112], borderAccent: [137, 180, 250], borderMuted: [69, 71, 90], success: [166, 227, 161], error: [243, 139, 168], warning: [249, 226, 175], muted: [166, 173, 200], dim: [108, 112, 134], text: [205, 214, 244] };
const colors = Object.fromEntries(Object.entries(palette).map(([k, [r, g, b]]) => [k, tui.rgbColor(r, g, b)]));
const ansi = (tok, s) => (palette[tok] ? `\x1b[38;2;${palette[tok].join(";")}m${s}\x1b[39m` : s);
const theme = { colors, fg: ansi, bold: (s) => `\x1b[1m${s}\x1b[22m`, inverse: (s) => `\x1b[7m${s}\x1b[27m`, bg: (_t, s) => s };

const strip = (l) => l.replace(/\x1b_G[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;:]*[A-Za-z]/g, "");
let comp;
const open = async (opts) => {
	process.stdout.columns = opts.cols;
	process.stdout.rows = opts.rows;
	engine.cfg.lang = opts.lang;
	tui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
	tui.setCellDimensions({ widthPx: 10, heightPx: 20 });
	ctx.ui.custom = (factory) => {
		comp = factory({ requestRender() {} }, theme, null, () => {});
		return new Promise(() => {});
	};
	void panelMod.openPanel(ctx, pi, engine, new iconsMod.Icons(), opts.tab);
	await new Promise((r) => setTimeout(r, 0));
	for (const k of opts.keys ?? []) comp.handleInput(k);
	return comp;
};
const draw = (opts) => {
	const width = panelMod.panelWidth();
	const lines = comp.render(width);
	for (const [i, l] of lines.entries()) {
		const w = tui.visibleWidth(l);
		if (w !== width) fail(`${opts.name}: line ${i} width ${w} != ${width}: ${JSON.stringify(strip(l)).slice(0, 90)}`);
	}
	if (lines.length > opts.rows - 1) fail(`${opts.name}: ${lines.length} lines > ${opts.rows - 1}`);
	if (lines.some((l) => l.includes("\x1b_G"))) fail(`${opts.name}: unexpected graphics escape`);
	return lines;
};
/** Click the first occurrence of `text` on screen. */
const click = (lines, text, name, nth = 0) => {
	let seen = 0;
	for (const [y, l] of lines.entries()) {
		const plain = strip(l);
		const idx = plain.indexOf(text);
		if (idx >= 0 && seen++ === nth) {
			const x = tui.visibleWidth(plain.slice(0, idx));
			comp.handleMouse({ type: "click", button: "left", x, y });
			return true;
		}
	}
	fail(`${name}: "${text}" not found to click`);
	return false;
};
const show = (name, lines) => print && console.log(`\n=== ${name}\n${lines.map(strip).join("\n")}`);

const cases = [];
for (const lang of ["zh", "en"]) {
	for (const [tab, name] of [[0, "overview"], [1, "history"], [2, "models"]]) {
		for (const [cols, rows] of [[160, 50], [90, 30], [70, 22]]) cases.push({ name: `${name}-${lang}-${cols}x${rows}`, lang, tab, cols, rows });
	}
}
cases.push({ name: "editor-zh", lang: "zh", tab: 2, cols: 120, rows: 40, keys: ["\x1b[B", "\x1b[B", "\r"] });
cases.push({ name: "editor-editing-en", lang: "en", tab: 2, cols: 100, rows: 30, keys: ["\x1b[B", "\x1b[B", "\r", "\r", "3", "0", "m"] });
for (const c of cases) {
	try {
		await open(c);
		const lines = draw(c);
		if (c.name.endsWith("160x50") || c.name.startsWith("editor")) show(c.name, lines);
		comp.dispose();
	} catch (e) {
		fail(`${c.name}: ${e.stack}`);
	}
}
console.log(`tui: ${cases.length} renders checked`);

// ── keyboard: ←→ tabs, Enter modifies, Ctrl+S saves, Esc guards unsaved ──
{
	const o = { name: "keys", lang: "zh", tab: 0, cols: 120, rows: 40 };
	await open(o);
	let lines = draw(o);
	comp.handleInput("\x1b[C"); // →
	lines = draw(o);
	if (!lines.some((l) => strip(l).includes("24小时"))) fail("keys: → did not switch to History");
	comp.handleInput("\x1b[D"); // ←
	lines = draw(o);
	if (!lines.some((l) => strip(l).includes("启用插件"))) fail("keys: ← did not switch back to Overview");
	const before = engine.cfg.askWarm;
	comp.handleInput("\x1b[B"); // ↓ to "ask"
	comp.handleInput("\r"); // Enter modifies (draft)
	if (engine.cfg.askWarm !== before) fail("keys: Enter must not save immediately");
	lines = draw(o);
	if (!lines.some((l) => strip(l).includes("未保存"))) fail("keys: unsaved marker missing");
	comp.handleInput("\x1b"); // Esc with unsaved changes only warns
	if (comp.dirty() !== true) fail("keys: first Esc must keep the draft");
	comp.handleInput("\x13"); // Ctrl+S
	await new Promise((r) => setTimeout(r, 20));
	if (engine.cfg.askWarm === before) fail("keys: Ctrl+S did not save");
	comp.handleInput("\r");
	comp.handleInput("\x13");
	await new Promise((r) => setTimeout(r, 20));
	if (engine.cfg.askWarm !== before) fail("keys: restore failed");
	show("keys-overview", draw(o));
	comp.dispose();
	console.log("keys: checked");
}

// ── mouse ──
{
	const o = { name: "mouse", lang: "zh", tab: 0, cols: 120, rows: 40 };
	await open(o);
	let lines = draw(o);
	click(lines, "记录", "tab chip");
	lines = draw(o);
	if (!lines.some((l) => strip(l).includes("24小时"))) fail("mouse: clicking the History chip did not switch tabs");
	click(lines, "7天", "range chip");
	if (engine.cfg.historyRange !== "7d") fail(`mouse: range chip -> ${engine.cfg.historyRange}`);
	lines = draw(o);
	show("mouse-history", lines);
	click(lines, "概览", "tab chip");
	lines = draw(o);
	const before = comp.draft.maxKeepWarmHours;
	const row = lines.findIndex((l) => strip(l).includes("最长保温"));
	const plain = strip(lines[row]);
	comp.handleMouse({ type: "click", button: "left", x: tui.visibleWidth(plain.slice(0, plain.indexOf("无限制"))) + 4, y: row });
	if (comp.draft.maxKeepWarmHours === before) fail("mouse: chevron did not change max keep-warm draft");
	comp.draft.maxKeepWarmHours = before;
	lines = draw(o);
	const wasTracked = comp.draft.models.includes("my-anthropic/claude-opus-5-5");
	const y1 = lines.findIndex((l) => strip(l).includes("claude-opus-5-5"));
	const p1 = strip(lines[y1]);
	comp.handleMouse({ type: "click", button: "left", x: tui.visibleWidth(p1.slice(0, p1.lastIndexOf("保温"))), y: y1 });
	if (comp.draft.models.includes("my-anthropic/claude-opus-5-5") === wasTracked) fail("mouse: keep-warm switch did not toggle");
	comp.handleMouse({ type: "click", button: "left", x: tui.visibleWidth(p1.slice(0, p1.lastIndexOf("保温"))), y: y1 });
	lines = draw(o);
	click(lines, "模型", "tab chip");
	lines = draw(o);
	click(lines, "claude-opus-5-5", "model row");
	lines = draw(o);
	if (!lines.some((l) => strip(l).includes("Claude 官方订阅"))) fail("mouse: editor did not open with subscription switch");
	click(lines, "Claude 官方订阅", "subscription row");
	lines = draw(o);
	show("mouse-editor", lines);
	{
		const y = lines.findIndex((l) => strip(l).includes("取消"));
		const p = strip(lines[y]);
		comp.handleMouse({ type: "click", button: "left", x: tui.visibleWidth(p.slice(0, p.lastIndexOf("保存"))), y });
	}
	await new Promise((r) => setTimeout(r, 30));
	if (!engine.cfg.subscription.includes("my-anthropic/claude-opus-5-5")) fail("mouse: subscription not saved");
	const st = engine.status(opus);
	if (!st.subscription || !(st.estWarmCost > 0 && st.estWarmCost < 0.001)) fail(`mouse: subscription warm cost should be tiny but shown, got ${st.estWarmCost}`);
	lines = draw(o);
	show("mouse-models-after-save", lines);
	comp.handleMouse({ type: "wheel", button: "none", x: 5, y: 5, wheelDelta: 1 });
	comp.dispose();
	console.log("mouse: clicks checked");
}

// ── history details + uniform bars ──
{
	const o = { name: "detail", lang: "zh", tab: 1, cols: 140, rows: 50 };
	await open(o);
	comp.shared.pref({ historyRange: "24h" });
	let lines = draw(o);
	// Bars: every run of block characters in the chart has the same width.
	const chart = lines.map(strip).filter((l) => /[▁▂▃▄▅▆▇█]{1,}/.test(l) && !l.includes("插件"));
	const widths = new Set(chart.flatMap((l) => (l.match(/[▁▂▃▄▅▆▇█]+/g) ?? []).map((r) => r.length)));
	if (widths.size !== 1 || !widths.has(2)) fail(`bars: uneven widths ${[...widths]}`);
	show("history-tall", lines);
	click(lines, "claude-opus-5-5", "record row");
	lines = draw(o);
	if (!lines.some((l) => strip(l).includes("缓存命中")) || !lines.some((l) => strip(l).includes("本次费用"))) fail("detail: did not open on click");
	show("history-detail", lines);
	comp.handleInput("\x1b[B"); // older
	lines = draw(o);
	if (!lines.some((l) => strip(l).includes("2 / "))) fail("detail: ↓ did not move to the next record");
	comp.handleInput("\x1b"); // back to list
	lines = draw(o);
	if (lines.some((l) => strip(l).includes("缓存命中"))) fail("detail: Esc did not return to the list");
	comp.handleInput("\x1b[D"); // to overview
	lines = draw(o);
	show("overview-tall", lines);
	const y = lines.findIndex((l) => strip(l).includes("最近预热"));
	if (y < 0) fail("overview: recent list missing");
	else {
		comp.handleMouse({ type: "click", button: "left", x: 10, y: y + 1 });
		lines = draw(o);
		if (!lines.some((l) => strip(l).includes("缓存命中"))) fail("overview: recent click did not open details");
	}
	comp.dispose();
	console.log("detail: checked");
}

// ── rpiv ask integration ──
{
	const gptKey = "my-openai/gpt-5.6-luna";
	const gptTtl = { ...gpt, promptCache: { short: 600 } };
	ctx.model = gptTtl;
	handlers.model_select({}, ctx);
	handlers.before_provider_request({ payload: { model: "x", max_output_tokens: 4000, input: [] } }, ctx);
	handlers.after_provider_response({ status: 200 }, ctx);
	if (engine.status(gptTtl).state !== "untracked") fail(`ask: expected untracked before ask, got ${engine.status(gptTtl).state}`);
	busHandlers["rpiv:ask-user:blocked"]({ active: true, toolCallId: "t1" });
	const st = engine.status(gptTtl);
	if (!st.asking || st.state !== "scheduled") fail(`ask: expected scheduled while asking, got ${st.state}`);
	// A built-in warm during the ask is logged with the ask tag.
	handlers.before_provider_request({ payload: { model: "x", max_output_tokens: 16, input: [] } }, ctx);
	handlers.after_provider_response({ status: 200 }, ctx);
	handlers.provider_stream_event({ data: { type: "response.completed", response: { usage: { input_tokens: 5000, input_tokens_details: { cached_tokens: 4900 }, output_tokens: 1 } } } }, ctx);
	const last = readLog().at(-1);
	if (!last || last.kind !== "warm" || last.source !== "builtin" || last.ask !== true) fail(`ask: built-in warm not tagged: ${JSON.stringify(last)}`);
	busHandlers["rpiv:ask-user:blocked"]({ active: false, toolCallId: "t1" });
	if (engine.status(gptTtl).asking) fail("ask: still asking after close");
	// Fallback through the tool lifecycle.
	handlers.tool_execution_start({ toolName: "ask_user_question", toolCallId: "t2" }, ctx);
	if (!engine.asking()) fail("ask: tool_execution_start fallback");
	handlers.tool_execution_end({ toolName: "ask_user_question", toolCallId: "t2" }, ctx);
	if (engine.asking()) fail("ask: tool_execution_end fallback");
	console.log(`ask: checked (${gptKey})`);
	ctx.model = opus;
}
// ── footer status click (fullscreen) ──
{
	const fl = await jiti.import(join(src, "footer-link.ts"));
	const { createInteractiveTuiReference } = await jiti.import(join(nm, "@earendil-works/pi-coding-agent/dist/modes/interactive/tui-renderer.js"));
	const noop = () => {};
	const makeTerm = () => {
		const t = { columns: 80, rows: 10, kittyProtocolActive: false, drainInput: async () => {} };
		for (const m of ["stop", "write", "moveBy", "hideCursor", "showCursor", "clearLine", "clearFromCursor", "clearScreen", "setTitle", "setProgress", "setProgramStatus"]) t[m] = noop;
		t.start = (onInput) => (t.input = onInput);
		return t;
	};
	const term = makeTerm();
	const opened = [];
	const alt = new tui.TuiAltScreen(term, false, undefined, { openUrl: (u) => opened.push(u) });
	const ref = createInteractiveTuiReference(() => alt);
	if (fl.canClick(createInteractiveTuiReference(() => new tui.TuiMainScreen(makeTerm(), false)))) fail("footer: regular mode must not be clickable");

	// Load the extension against the real fullscreen renderer.
	const ext = (await jiti.import(join(src, "index.ts"))).default;
	const h = {};
	const fpi = { on: (e, f) => (h[e] ??= []).push(f), registerCommand: noop, setModel: async () => true, events: { on: noop, emit: noop } };
	ext(fpi);
	let status;
	let customs = 0;
	const fctx = {
		...ctx,
		ui: {
			notify: noop,
			setStatus: (_k, v) => (status = v),
			setWidget: (_k, factory) => alt.addChild(factory(ref, theme)),
			custom: () => {
				customs++;
				return new Promise(noop);
			},
		},
	};
	const fire = async (e, ev) => {
		for (const f of h[e] ?? []) await f(ev, fctx);
	};
	await fire("session_start", {});
	await fire("before_provider_request", { payload: { model: "x", max_tokens: 1000, messages: [] } });
	await fire("after_provider_response", { status: 200 });
	await new Promise((r) => setTimeout(r, 10));
	if (!status?.includes(fl.FOOTER_URL)) fail(`footer: status is not a link: ${JSON.stringify(status)}`);
	alt.addChild({ render: (w) => [tui.truncateToWidth(`« ${status ?? ""}`, w)], invalidate: noop });
	alt.start();
	alt.requestRender(true);
	await new Promise((r) => setTimeout(r, 30));
	const y = alt.getScreenLines().findIndex((l) => l.includes(fl.FOOTER_URL));
	const press = async (x, row) => {
		term.input(`\x1b[<0;${x + 1};${row + 1}M`);
		term.input(`\x1b[<0;${x + 1};${row + 1}m`);
		await new Promise((r) => setTimeout(r, 600)); // past the double-click window
	};
	if (y < 0) fail("footer: link not on screen");
	else {
		await press(0, y); // the « before the status
		if (customs !== 0) fail("footer: click outside the status opened the panel");
		await press(4, y);
		if (customs !== 1) fail(`footer: click opened ${customs} panel(s)`);
		await press(4, y);
		if (customs !== 1) fail("footer: second click while open must not stack panels");
		if (opened.length) fail(`footer: pi's URL opener got ${opened}`);
	}
	alt.stop();
	console.log("footer: click checked");
}

console.log(failures ? `${failures} failure(s)` : "all checks passed");
process.exit(failures ? 1 : 0);
