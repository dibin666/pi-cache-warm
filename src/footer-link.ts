/**
 * Clickable footer status in pi's fullscreen mode.
 *
 * Status text from `ctx.ui.setStatus()` is a plain string inside pi's footer, so it cannot carry a
 * mouse handler. Fullscreen pi does open OSC 8 links when they are clicked: it looks up the link
 * under the pointer and passes its URL to the renderer's `openUrl`. The status is therefore wrapped
 * in a private link and `openUrl` is wrapped to catch that one URL; every other URL still goes to
 * pi's own handler. Regular mode leaves clicks to the terminal, so the text stays a plain string.
 */
import { hyperlink } from "@earendil-works/pi-tui";

export const FOOTER_URL = "pi-cache-warm://open";

/** Shared across reloads: a reloaded extension swaps the callback instead of wrapping again. */
const HOOK = Symbol.for("pi-cache-warm.footer-click");

interface Hook {
	onClick?: () => void;
}

/** True for pi's fullscreen renderer, the only one that routes link clicks through `openUrl`. */
export function canClick(tui: any): boolean {
	try {
		return !!tui && "openUrl" in tui && typeof tui.openUrl === "function";
	} catch {
		return false;
	}
}

/**
 * Route clicks on {@link FOOTER_URL} to `onClick` on the active renderer.
 * Returns false when the renderer cannot report clicks (regular mode).
 */
export function hookFooterClick(tui: any, onClick: (() => void) | undefined): boolean {
	if (!canClick(tui)) return false;
	try {
		const hook = tui[HOOK] as Hook | undefined;
		if (hook) {
			hook.onClick = onClick;
			return true;
		}
		const next: Hook = { onClick };
		const original = tui.openUrl as (url: string) => void;
		tui.openUrl = (url: string) => {
			if (url === FOOTER_URL) {
				try {
					next.onClick?.();
				} catch {
					/* a failing panel must not break pi's input loop */
				}
				return;
			}
			return original(url);
		};
		tui[HOOK] = next;
		return true;
	} catch {
		return false;
	}
}

/** Drop the callback, keeping the wrapper so other links behave as before. */
export function unhookFooterClick(tui: any): void {
	try {
		const hook = tui?.[HOOK] as Hook | undefined;
		if (hook) hook.onClick = undefined;
	} catch {
		/* renderer gone */
	}
}

export const clickable = (text: string): string => hyperlink(text, FOOTER_URL);
