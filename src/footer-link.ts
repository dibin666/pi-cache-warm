/**
 * Clickable footer status in pi's fullscreen mode.
 *
 * Status text from `ctx.ui.setStatus()` is a plain string that the footer draws however it likes
 * (pi's own footer, pi-open-tui, pi-footer…), so it cannot carry a mouse handler, and footers may
 * strip any escape sequence other than colours. Instead, the fullscreen renderer's mouse entry point
 * is wrapped: a left click that lands on the status text as it appears on screen — outside the
 * scrolling transcript — opens the panel; every other event goes to pi untouched.
 * Regular mode leaves the mouse to the terminal, so there is nothing to hook there.
 */
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

/** Shared across reloads: a reloaded extension swaps the target instead of wrapping again. */
const HOOK = Symbol.for("pi-cache-warm.footer-mouse");

export interface ClickTarget {
	/** Plain status texts to look for on screen, most specific first. */
	texts(): string[];
	onClick(): void;
}

interface Hook {
	target?: ClickTarget;
}

interface RawMouse {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

const MOTION = 32;
const MODIFIERS = 4 | 8 | 16;
const WHEEL = 64;

/** True for pi's fullscreen renderer, the only one that routes mouse events. */
export function canClick(tui: any): boolean {
	try {
		return !!tui && typeof tui.handleMouseEvent === "function" && typeof tui.getScreenLines === "function";
	} catch {
		return false;
	}
}

/** Whether a scroll view (the transcript) covers the cell; status text there is just chat content. */
function inScrollView(layout: any, x: number, y: number): boolean {
	const has = (r: any) => !!r && x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
	const visit = (box: any): boolean => {
		if (!box || !has(box.clip ?? box.rect)) return false;
		if (box.scrollView && has(box.rect)) return true;
		return Array.isArray(box.children) && box.children.some(visit);
	};
	return visit(layout?.root);
}

/** Whether (x, y) falls on one of the texts in a rendered screen line. */
export function hitText(line: string, x: number, texts: string[]): boolean {
	const plain = stripTerminalSequences(line);
	for (const text of texts) {
		if (!text) continue;
		for (let i = plain.indexOf(text); i >= 0; i = plain.indexOf(text, i + 1)) {
			const start = visibleWidth(plain.slice(0, i));
			if (x >= start && x < start + visibleWidth(text)) return true;
		}
	}
	return false;
}

function onStatus(tui: any, target: ClickTarget, x: number, y: number): boolean {
	const line = (tui.getScreenLines() as string[])[y];
	if (!line) return false;
	const layout = tui.currentLayout;
	if (layout ? inScrollView(layout, x, y) : y < (tui.terminal?.rows ?? 0) - 8) return false;
	return hitText(line, x, target.texts());
}

/**
 * Route left clicks on the footer status to `target.onClick` on the active renderer.
 * Returns false when the renderer has no mouse support (regular mode).
 */
export function hookFooterClick(tui: any, target: ClickTarget | undefined): boolean {
	if (!canClick(tui)) return false;
	try {
		const existing = tui[HOOK] as Hook | undefined;
		if (existing) {
			existing.target = target;
			return true;
		}
		const hook: Hook = { target };
		const original = tui.handleMouseEvent as (raw: RawMouse) => void;
		let pressed = false;
		const handle = (raw: RawMouse): boolean => {
			const t = hook.target;
			if (pressed) {
				// The press was ours: keep the gesture away from text selection.
				if (raw.button & MOTION) return true;
				pressed = false;
				if (raw.release && t && onStatus(tui, t, raw.x, raw.y)) setTimeout(() => t.onClick(), 0);
				return true;
			}
			if (!t || raw.release || raw.button & (MOTION | MODIFIERS | WHEEL) || (raw.button & 3) !== 0) return false;
			if (tui.mouseCapture || tui.mousePressTarget || tui.hasOverlay?.()) return false;
			if (!onStatus(tui, t, raw.x, raw.y)) return false;
			pressed = true;
			return true;
		};
		tui.handleMouseEvent = (raw: RawMouse) => {
			let mine = false;
			try {
				mine = handle(raw);
			} catch {
				/* never break pi's mouse handling */
			}
			if (!mine) return original(raw);
		};
		tui[HOOK] = hook;
		return true;
	} catch {
		return false;
	}
}

/** Drop the target, keeping the wrapper so the mouse behaves as before. */
export function unhookFooterClick(tui: any): void {
	try {
		const hook = tui?.[HOOK] as Hook | undefined;
		if (hook) hook.target = undefined;
	} catch {
		/* renderer gone */
	}
}
