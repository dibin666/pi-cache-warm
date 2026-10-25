/**
 * pi-cache-warm — Cache Warm Plus.
 *
 * pi's built-in warmer stops after 30 idle minutes (1 hour while streaming) and skips refreshes it
 * judges "not worth it". Those limits are hard-coded, so this extension:
 *   1. overrides each built-in `cache_warming_decision` for the selected models,
 *   2. takes over once the built-in warmer stops, replaying the last request with a tiny output cap
 *      shortly before the cache expires,
 *   3. records every warm, cache rebuild and stop, and shows them as a chart and list,
 *   4. edits pi's own model cache metadata (models.json) and warming settings (settings.json).
 *
 * Open the panel with `/cachewarm`, or by clicking the footer status in fullscreen mode. Settings: ~/.pi/agent/cache-warm-plus.json
 * History: ~/.pi/agent/cache-warm-plus.log.jsonl
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LANG_CHOICES, type LangSetting, loadConfig, saveConfig } from "./config.ts";
import { Engine } from "./engine.ts";
import { type ClickTarget, hookFooterClick, unhookFooterClick } from "./footer-link.ts";
import { t } from "./i18n.ts";
import { Icons } from "./icons.ts";
import { openPanel } from "./ui/panel.ts";

const STATUS_KEY = "cache-warm-plus";
/** Invisible widget: hands over pi's renderer so footer clicks can be routed to the panel. */
const CLICK_WIDGET_KEY = "cache-warm-plus-click";

export default function (pi: ExtensionAPI) {
	const engine = new Engine(pi, loadConfig());
	const icons = new Icons();
	engine.register();

	let uiCtx: ExtensionContext | undefined;
	let lastFooter: string | undefined;
	/** pi's renderer (a stable reference that follows fullscreen/regular switches). */
	let tuiRef: any;
	let panelOpen = false;

	const open = async (ctx: ExtensionContext, tab: number) => {
		if (panelOpen) return;
		panelOpen = true;
		try {
			await openPanel(ctx, pi, engine, icons, tab);
		} finally {
			panelOpen = false;
		}
	};
	const onFooterClick = () => {
		const ctx = uiCtx;
		if (!ctx?.hasUI || ctx.mode !== "tui") return;
		void open(ctx, 0).catch(() => {
			/* UI gone */
		});
	};
	/** What a click must land on: the whole status, or its label when the footer wraps or cuts it. */
	const clickTarget: ClickTarget = {
		texts: () => (lastFooter ? [lastFooter, lastFooter.split(" · ")[0]!] : []),
		onClick: onFooterClick,
	};
	/** (Re)attach the click route; cheap, and follows fullscreen/regular renderer switches. */
	const syncClick = () => {
		if (tuiRef) hookFooterClick(tuiRef, clickTarget);
	};

	const updateFooter = () => {
		const ctx = uiCtx;
		if (!ctx?.hasUI) return;
		let text: string | undefined;
		if (engine.cfg.enabled && engine.cfg.footer) {
			const st = engine.status(ctx.model);
			const lang = engine.lang;
			if (st.state === "scheduled" && st.nextAt) {
				const d = new Date(st.nextAt);
				const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
				text = t(lang, "footer_next", { t: hhmm });
			} else if (st.state === "busy") text = t(lang, "footer_busy");
			else if (st.state === "stopped") text = t(lang, "footer_stopped");
		}
		if (text === lastFooter) return;
		lastFooter = text;
		try {
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			/* UI gone */
		}
	};
	engine.listen(updateFooter);

	pi.on("session_start", async (_e, ctx) => {
		uiCtx = ctx;
		lastFooter = undefined;
		engine.setConfig(loadConfig()); // pick up edits made outside the TUI
		if (ctx.mode === "tui") {
			try {
				ctx.ui.setWidget(CLICK_WIDGET_KEY, (tui) => {
					tuiRef = tui;
					syncClick();
					// Renders nothing; checking on every frame follows renderer switches.
					return {
						render: () => {
							syncClick();
							return [];
						},
						invalidate: () => {},
					};
				});
			} catch {
				/* no widget support: the status stays plain text */
			}
		}
		updateFooter();
	});
	pi.on("session_shutdown", () => {
		uiCtx = undefined;
		if (tuiRef) unhookFooterClick(tuiRef);
		tuiRef = undefined;
	});

	pi.registerCommand("cachewarm", {
		description: `${t("zh", "cmd_desc")} | ${t("en", "cmd_desc")}`,
		getArgumentCompletions: (prefix) =>
			["on", "off", "status", "now", "history", "models", "lang zh", "lang en", "lang auto"]
				.filter((v) => v.startsWith(prefix.trim()))
				.map((v) => ({ value: v, label: v })),
		handler: async (args, ctx) => {
			uiCtx = ctx;
			const [cmd = "", arg = ""] = args.trim().toLowerCase().split(/\s+/);
			const lang = engine.lang;
			const notify = (m: string, l: "info" | "warning" | "error" = "info") => ctx.ui.notify(m, l);
			const apply = (patch: Partial<typeof engine.cfg>) => {
				const next = { ...engine.cfg, ...patch };
				saveConfig(next);
				engine.setConfig(next);
			};

			if (cmd === "on" || cmd === "off") {
				apply({ enabled: cmd === "on" });
				return notify(t(lang, cmd === "on" ? "n_status_on" : "n_status_off"));
			}
			if (cmd === "lang") {
				if (!LANG_CHOICES.includes(arg as LangSetting)) return notify("usage: /cachewarm lang zh|en|auto", "error");
				apply({ lang: arg as LangSetting });
				return notify(`lang = ${arg}`);
			}
			if (cmd === "now") {
				const r = await engine.warm(true);
				return notify(r.message, r.ok ? "info" : "error");
			}
			if (cmd === "status") {
				const s = engine.status(ctx.model);
				return notify(
					`${t(lang, engine.cfg.enabled ? "n_status_on" : "n_status_off")} | ${s.modelKey ?? "-"} | ${s.state}${s.stopKey ? `:${s.stopKey}` : ""} | ${s.pluginWarms}+${s.builtinWarms}`,
				);
			}
			if (ctx.mode !== "tui") return notify(t(lang, "n_need_tui"), "warning");
			const tab = cmd === "history" ? 1 : cmd === "models" ? 2 : 0;
			await open(ctx, tab);
		},
	});
}
