// Render the real panel offline (demo data, no network) and convert its terminal output into
// SVG images for the README: truecolor text, CJK widths, character icons.
//   node scripts/render-readme.mjs   → docs/*.svg
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const docs = join(root, "docs");
const home = process.env.HOME;
const version = readFileSync(join(home, ".pi/agent/install/current-version"), "utf8").trim();
const nm = process.env.PI_NODE_MODULES ?? join(home, `.pi/agent/install/releases/${version}/node_modules`);
const { createJiti } = createRequire(join(nm, "x.js"))("jiti");
const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: { "@earendil-works/pi-tui": join(nm, "@earendil-works/pi-tui/dist/index.js") },
});
void execSync;

// ── isolated demo environment ──
const agentDir = mkdtempSync(join(tmpdir(), "cwp-readme-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.TZ ??= "Asia/Shanghai";
const opusKey = "anthropic/claude-opus-4";
const sonnetKey = "anthropic/claude-sonnet-4";
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			anthropic: {
				models: [
					{ id: "claude-opus-4", cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, promptCache: { short: 300, long: 3600 } },
					{ id: "claude-sonnet-4", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, promptCache: { short: 300, long: 3600 } },
				],
			},
		},
	}),
);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "idle" }));
const cfgBase = { enabled: true, models: [sonnetKey, opusKey], subscription: [opusKey], askWarm: true, ignoreEconomics: true, maxKeepWarmHours: 0, takeoverPct: 93, historyRange: "6h" };

// Deterministic demo history over the last six hours.
const now = Date.UTC(2026, 9, 24, 13, 30, 0);
Date.now = () => now + (Date.now.offset ?? 0);
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const log = [];
const add = (at, e) => log.push({ v: 2, ts: new Date(at).toISOString(), at, ok: true, input: 2, read: 0, write: 0, output: 1, cost: 0, session: "demo", ...e });
let ctxTok = 160000;
for (let t = now - 5.8 * 3600e3; t < now - 3 * 60e3; t += (4 + rnd() * 4) * 60e3) {
	const opus = rnd() < 0.35;
	const model = opus ? opusKey : sonnetKey;
	ctxTok += Math.round(1500 + rnd() * 6000);
	const p = opus ? { r: 0, i: 5, o: 25, w: 6.25 } : { r: 0.3, i: 3, o: 15, w: 3.75 };
	add(t, {
		kind: "warm",
		source: rnd() < 0.7 ? "plugin" : "builtin",
		model,
		read: ctxTok,
		cost: +((ctxTok * p.r + 2 * p.i + p.o) / 1e6).toFixed(6),
		avoid: +((ctxTok * (p.w - p.r)) / 1e6).toFixed(4),
		ms: Math.round(700 + rnd() * 1400),
		...(opus ? { sub: true } : {}),
		...(now - t > 1.6 * 3600e3 && now - t < 2.4 * 3600e3 ? { ask: true } : {}),
	});
}
add(now - 4.4 * 3600e3, { kind: "warm", source: "manual", model: sonnetKey, read: 182000, cost: 0.054621, avoid: 0.6279, ms: 1210 });
add(now - 3.1 * 3600e3, { kind: "rebuild", model: opusKey, input: 4, write: 214800, cost: 1.3425, gapMs: 7.2 * 3600e3, reason: "maxDuration", sub: true });
add(now - 0.9 * 3600e3, { kind: "warm", source: "plugin", model: sonnetKey, ok: false, input: 0, output: 0, ms: 30010, error: "HTTP 529: overloaded" });
log.sort((a, b) => a.at - b.at);
writeFileSync(join(agentDir, "cache-warm-plus.log.jsonl"), `${log.map((e) => JSON.stringify(e)).join("\n")}\n`);

const tui = await jiti.import(join(nm, "@earendil-works/pi-tui/dist/index.js"));
const { Engine } = await jiti.import(join(src, "engine.ts"));
const { loadConfig } = await jiti.import(join(src, "config.ts"));
const { Icons } = await jiti.import(join(src, "icons.ts"));
const panelMod = await jiti.import(join(src, "ui/panel.ts"));

// ── palette (dark) ──
const P = {
	bg: "#1b1d2a",
	accent: "#b4a4f7",
	borderAccent: "#7f74c9",
	borderMuted: "#3b3f55",
	success: "#7ec699",
	warning: "#e0a64a",
	error: "#e8787a",
	muted: "#9aa0b4",
	dim: "#686d84",
	text: "#d8dbe8",
	selectedBg: "#283447",
};
const rgb = (h) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
const colors = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, tui.rgbColor(...rgb(v))]));
const theme = {
	colors,
	fg: (tok, s) => (P[tok] ? `\x1b[38;2;${rgb(P[tok]).join(";")}m${s}\x1b[39m` : s),
	bg: (tok, s) => (P[tok] ? `\x1b[48;2;${rgb(P[tok]).join(";")}m${s}\x1b[49m` : s),
	bold: (s) => `\x1b[1m${s}\x1b[22m`,
	inverse: (s) => `\x1b[7m${s}\x1b[27m`,
};

function renderPanel({ lang, tab, keys = [], cols = 104, rows = 30 }) {
	writeFileSync(join(agentDir, "cache-warm-plus.json"), JSON.stringify({ ...cfgBase, lang }));
	process.stdout.columns = cols;
	process.stdout.rows = rows;
	tui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
	tui.setCellDimensions({ widthPx: 10, heightPx: 20 });
	const handlers = {};
	const pi = { on: (e, h) => (handlers[e] = h), events: { on() {} }, setModel: async () => true };
	const engine = new Engine(pi, loadConfig());
	engine.register();
	const sonnet = { provider: "anthropic", id: "claude-sonnet-4", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", promptCache: { short: 300, long: 3600 }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
	const opus = { provider: "anthropic", id: "claude-opus-4", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", promptCache: { short: 300, long: 3600 }, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } };
	const gem = { provider: "google", id: "gemini-2.5-pro", api: "google-generative-ai", cost: { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 0 } };
	const gpt = { provider: "openai", id: "gpt-5", api: "openai-responses", cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } };
	const byKey = { [sonnetKey]: sonnet, [opusKey]: opus };
	let comp;
	const ctx = {
		model: sonnet,
		mode: "tui",
		hasUI: true,
		getContextUsage: () => ({ tokens: 214000 }),
		sessionManager: { getSessionId: () => "demo" },
		modelRegistry: { getAvailable: () => [sonnet, opus, gem, gpt], refresh: async () => ({}), find: (p, id) => byKey[`${p}/${id}`] },
		ui: {
			notify() {},
			setStatus() {},
			custom: (factory) => {
				comp = factory({ requestRender() {} }, theme, null, () => {});
				return new Promise(() => {});
			},
		},
		waitForIdle: async () => {},
		reload: async () => {},
	};
	// A real request 61 s ago, so the overview shows a live countdown.
	Date.now.offset = -61_000;
	handlers.before_provider_request({ payload: { model: "x", max_tokens: 8000, messages: [] } }, ctx);
	handlers.after_provider_response({ status: 200 }, ctx);
	Date.now.offset = 0;
	void panelMod.openPanel(ctx, pi, engine, new Icons(), tab);
	for (const k of keys) comp.handleInput(k);
	const lines = comp.render(panelMod.panelWidth());
	comp.dispose();
	return lines;
}

// ── ANSI → SVG ──
const CW = 9.6;
const CH = 20;
const PAD = 14;
const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function toCells(lines) {
	const grid = [];
	const images = [];
	lines.forEach((line, y) => {
		const row = [];
		let fg = P.text;
		let bg;
		let bold = false;
		let inv = false;
		let i = 0;
		let kitty;
		while (i < line.length) {
			if (line.startsWith("\x1b[", i)) {
				const m = /^\x1b\[([0-9;:]*)([A-Za-z])/.exec(line.slice(i));
				i += m[0].length;
				if (m[2] !== "m") continue;
				const p = m[1].split(";").map(Number);
				for (let k = 0; k < p.length; k++) {
					const v = p[k];
					if (v === 0 || Number.isNaN(v)) [fg, bg, bold, inv] = [P.text, undefined, false, false];
					else if (v === 1) bold = true;
					else if (v === 22) bold = false;
					else if (v === 7) inv = true;
					else if (v === 27) inv = false;
					else if (v === 39) fg = P.text;
					else if (v === 49) bg = undefined;
					else if ((v === 38 || v === 48) && p[k + 1] === 2) {
						const c = `#${p.slice(k + 2, k + 5).map((x) => x.toString(16).padStart(2, "0")).join("")}`;
						v === 38 ? (fg = c) : (bg = c);
						k += 4;
					}
				}
				continue;
			}
			if (line.startsWith("\x1b_G", i)) {
				const end = line.indexOf("\x1b\\", i);
				const body = line.slice(i + 3, end);
				const semi = body.indexOf(";");
				const params = Object.fromEntries(body.slice(0, semi).split(",").map((kv) => kv.split("=")));
				const data = body.slice(semi + 1);
				if (params.a) kitty = { x: row.length, y, c: Number(params.c), r: Number(params.r), data };
				else if (kitty) kitty.data += data;
				if (params.m !== "1" && kitty) {
					images.push(kitty);
					kitty = undefined;
				}
				i = end + 2;
				continue;
			}
			if (line.startsWith("\x1b]", i)) {
				const end = line.indexOf("\x07", i);
				i = end < 0 ? line.length : end + 1;
				continue;
			}
			const next = line.indexOf("\x1b", i);
			const text = line.slice(i, next < 0 ? line.length : next);
			for (const { segment } of seg.segment(text)) {
				const w = tui.visibleWidth(segment);
				if (w === 0) continue;
				const [f, b] = inv ? [bg ?? P.bg, fg] : [fg, bg];
				row.push({ ch: segment, fg: f, bg: b, bold, w });
				for (let k = 1; k < w; k++) row.push({ ch: "", fg: f, bg: b, bold, w: 0 });
			}
			i += text.length;
		}
		grid.push(row);
	});
	return { grid, images };
}

const BOX = new Set("─━│┃╭╮╰╯├┤┬┴┼");
const BLOCKS = { "▁": 1, "▂": 2, "▃": 3, "▄": 4, "▅": 5, "▆": 6, "▇": 7, "█": 8 };

function boxPath(ch, x, y) {
	const cx = x + CW / 2;
	const cy = y + CH / 2;
	const r = 5;
	switch (ch) {
		case "─":
		case "━":
			return `M${x} ${cy}H${x + CW}`;
		case "│":
		case "┃":
			return `M${cx} ${y}V${y + CH}`;
		case "├":
			return `M${cx} ${y}V${y + CH}M${cx} ${cy}H${x + CW}`;
		case "┤":
			return `M${cx} ${y}V${y + CH}M${x} ${cy}H${cx}`;
		case "╭":
			return `M${x + CW} ${cy}H${cx + r}Q${cx} ${cy} ${cx} ${cy + r}V${y + CH}`;
		case "╮":
			return `M${x} ${cy}H${cx - r}Q${cx} ${cy} ${cx} ${cy + r}V${y + CH}`;
		case "╰":
			return `M${cx} ${y}V${cy - r}Q${cx} ${cy} ${cx + r} ${cy}H${x + CW}`;
		case "╯":
			return `M${cx} ${y}V${cy - r}Q${cx} ${cy} ${cx - r} ${cy}H${x}`;
	}
	return "";
}

function toSvg(lines, title) {
	const { grid, images } = toCells(lines);
	const cols = Math.max(...grid.map((r) => r.length));
	const W = Math.ceil(cols * CW + PAD * 2);
	const H = Math.ceil(grid.length * CH + PAD * 2);
	const out = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">`,
		`<rect width="${W}" height="${H}" rx="10" fill="${P.bg}"/>`,
		`<g font-family="'JetBrains Mono','Cascadia Mono','SF Mono',Menlo,Consolas,'Noto Sans Mono CJK SC','Microsoft YaHei',monospace" font-size="16">`,
	];
	grid.forEach((row, ry) => {
		const y = PAD + ry * CH;
		// Backgrounds.
		for (let x = 0; x < row.length; ) {
			const b = row[x].bg;
			let e = x;
			while (e < row.length && row[e].bg === b) e++;
			if (b) out.push(`<rect x="${(PAD + x * CW).toFixed(1)}" y="${y}" width="${((e - x) * CW).toFixed(1)}" height="${CH}" fill="${b}"/>`);
			x = e;
		}
		// Box lines and chart blocks as shapes; text runs with per-glyph x positions.
		const paths = {};
		let run;
		const flush = () => {
			if (!run) return;
			// Double-width glyphs get a larger size so they fill their two cells like in a terminal.
			out.push(
				`<text y="${y + CH * 0.74}" x="${run.xs.map((v) => v.toFixed(1)).join(" ")}" fill="${run.fg}"${run.bold ? ' font-weight="700"' : ""}${run.wide ? ' font-size="18.4"' : ""}>${esc(run.text)}</text>`,
			);
			run = undefined;
		};
		row.forEach((c, x) => {
			const px = PAD + x * CW;
			if (!c.ch || c.ch === " ") return flush();
			if (BOX.has(c.ch)) {
				flush();
				const key = `${c.fg}|${c.ch === "━" || c.ch === "┃" ? 2.4 : 1.3}`;
				paths[key] = (paths[key] ?? "") + boxPath(c.ch, px, y);
				return;
			}
			if (BLOCKS[c.ch]) {
				flush();
				const h = (CH * BLOCKS[c.ch]) / 8;
				out.push(`<rect x="${px.toFixed(1)}" y="${(y + CH - h).toFixed(1)}" width="${(CW + 0.6).toFixed(1)}" height="${h.toFixed(1)}" fill="${c.fg}"/>`);
				return;
			}
			const wide = c.w === 2;
			if (run && (run.fg !== c.fg || run.bold !== c.bold || run.wide !== wide)) flush();
			run ??= { fg: c.fg, bold: c.bold, wide, text: "", xs: [] };
			run.text += c.ch;
			// One x per code point; wide glyphs are centred in their two cells.
			for (let k = 0; k < [...c.ch].length; k++) run.xs.push(px + (wide ? 0.4 : 0));
		});
		flush();
		for (const [key, d] of Object.entries(paths)) {
			const [color, w] = key.split("|");
			out.push(`<path d="${d}" stroke="${color}" stroke-width="${w}" fill="none" stroke-linecap="square"/>`);
		}
	});
	for (const im of images) {
		out.push(
			`<image x="${(PAD + im.x * CW).toFixed(1)}" y="${PAD + im.y * CH}" width="${(im.c * CW).toFixed(1)}" height="${im.r * CH}" href="data:image/png;base64,${im.data}"/>`,
		);
	}
	out.push("</g></svg>");
	return out.join("\n");
}

// ── outputs ──
mkdirSync(docs, { recursive: true });
const shots = [
	{ name: "overview", tab: 0 },
	{ name: "history", tab: 1 },
	{ name: "models", tab: 2, keys: ["\x1b[B", "\r"] },
];
for (const lang of ["zh", "en"]) {
	for (const s of shots) {
		const lines = renderPanel({ lang, tab: s.tab, keys: s.keys, rows: s.name === "models" ? 26 : 30 });
		const file = join(docs, `${s.name}.${lang}.svg`);
		writeFileSync(file, toSvg(lines, `Cache Warm – ${s.name}`));
		console.log(`${file}  ${lines.length} lines`);
	}
}
rmSync(agentDir, { recursive: true, force: true });
