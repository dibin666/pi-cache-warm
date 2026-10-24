/**
 * Hand-drawn SVG icons, rasterized by ./svg.ts and shown through the Kitty graphics protocol.
 * When the terminal cannot show images (or text mode is selected) each icon falls back to a
 * single-width, non-emoji glyph so layouts keep the same width.
 */
import { allocateImageId, colorToHex, encodeKitty, getCapabilities, getCellDimensions } from "@earendil-works/pi-tui";
import { renderSvg } from "./svg.ts";

type Theme = any;

/** 24×24 bodies. `currentColor` is the main colour; `{c2}` is the secondary colour. */
const BODIES = {
	logo: `<path d="M12 1.8c.7 3.4 3.5 5.2 5.2 8 1.5 2.5 1.7 5.5.2 7.9A6.4 6.4 0 0 1 12 22.2a6.4 6.4 0 0 1-6-4.1c-1-2.8-.1-5.5 1.7-7.6.3 1.8 1.3 3.1 2.7 3.6-.7-3.8.2-7.8 1.6-12.3z" fill="currentColor" stroke="none"/><path d="M12 12.4c1.7 1.9 3 3.4 2.8 5.3a2.8 2.8 0 0 1-5.6 0c-.1-1.6 1-3.1 2.8-5.3z" fill="{c2}" stroke="none"/>`,
	flame: `<path d="M12 2.5c.6 3.2 3.3 4.9 4.9 7.6 1.4 2.4 1.6 5.2.2 7.5A6 6 0 0 1 12 21.5a6 6 0 0 1-5.6-3.9c-.9-2.6-.1-5.2 1.6-7.2.3 1.7 1.2 2.9 2.5 3.4-.6-3.6.2-7.3 1.5-11.3z"/>`,
	power: `<path d="M12 3v8"/><path d="M6.6 6.6a8 8 0 1 0 10.8 0"/>`,
	layers: `<path d="M12 3 3 7.5 12 12l9-4.5L12 3z"/><path d="M3 12l9 4.5 9-4.5"/><path d="M3 16.5 12 21l9-4.5"/>`,
	scale: `<path d="M12 4v16"/><path d="M7.5 20h9"/><path d="M5 7h14"/><path d="M5 7l-3 6.5h6L5 7z"/><path d="M19 7l-3 6.5h6L19 7z"/><circle cx="12" cy="4" r="1.2" fill="currentColor"/>`,
	hourglass: `<path d="M6.5 3h11"/><path d="M6.5 21h11"/><path d="M8 3c0 5 8 5 8 9s-8 4-8 9"/><path d="M16 3c0 5-8 5-8 9s8 4 8 9"/>`,
	target: `<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/>`,
	globe: `<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a4.2 9 0 0 1 0 18a4.2 9 0 0 1 0-18z"/>`,
	image: `<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 15.5l-5-5L6.5 20"/>`,
	zap: `<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" fill="currentColor" fill-opacity="0.25"/>`,
	reset: `<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5"/><path d="M3.5 3.5v5h5"/>`,
	chart: `<path d="M4 20V11"/><path d="M10 20V5"/><path d="M16 20v-6"/><path d="M22 20V9"/><path d="M2 20h21" stroke-opacity="0.6"/>`,
	cpu: `<rect x="5.5" y="5.5" width="13" height="13" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1" fill="currentColor" fill-opacity="0.35"/><path d="M9 2v3.5M15 2v3.5M9 18.5V22M15 18.5V22M2 9h3.5M2 15h3.5M18.5 9H22M18.5 15H22"/>`,
	pulse: `<path d="M2.5 12h4l2.5-6 4.5 12 2.5-6h5.5"/>`,
	clock: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>`,
	clockBack: `<path d="M3.2 12a8.8 8.8 0 1 0 2.6-6.2L3.2 8.4"/><path d="M3.2 3.4v5h5"/><path d="M12 7.5v4.5l3 2"/>`,
	refresh: `<path d="M20 10.5a8 8 0 0 0-14.6-3.6L3.5 9"/><path d="M3.5 4v5h5"/><path d="M4 13.5a8 8 0 0 0 14.6 3.6l1.9-2.1"/><path d="M20.5 20v-5h-5"/>`,
	moon: `<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z"/>`,
	coin: `<circle cx="12" cy="12" r="9"/><path d="M14.6 9.4c-.5-.9-1.5-1.4-2.6-1.4-1.5 0-2.6.8-2.6 2s1 1.7 2.6 2 2.6.9 2.6 2.1-1.1 2-2.6 2c-1.1 0-2.1-.5-2.6-1.4"/><path d="M12 6.3V8M12 16.1v1.6"/>`,
	check: `<circle cx="12" cy="12" r="9"/><path d="M8 12.4l2.8 2.8L16.2 9.6"/>`,
	cross: `<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>`,
	alert: `<path d="M12 3.2 2.2 20.2h19.6L12 3.2z"/><path d="M12 9.8v4.6"/><circle cx="12" cy="17.2" r="1" fill="currentColor" stroke="none"/>`,
	pause: `<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>`,
	play: `<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5-6-3.5z" fill="currentColor"/>`,
	sliders: `<path d="M4 6h9M18 6h2M4 12h3M12 12h8M4 18h11M20 18h0"/><circle cx="15.5" cy="6" r="2.2"/><circle cx="9.5" cy="12" r="2.2"/><circle cx="17.5" cy="18" r="2.2"/>`,
	box: `<rect x="3.5" y="3.5" width="17" height="17" rx="4"/>`,
	boxOn: `<rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="currentColor"/><path d="M7.8 12.3l2.9 2.9 5.6-6" stroke="{c2}" stroke-width="2.6"/>`,
	bell: `<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.8 1.8H4.2L6 16.5z"/><path d="M10 21a2.2 2.2 0 0 0 4 0"/>`,
	database: `<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13a8 3 0 0 0 16 0v-13"/><path d="M4 12a8 3 0 0 0 16 0"/>`,
	file: `<path d="M14 2.8H6.2v18.4h11.6V6.6L14 2.8z"/><path d="M14 2.8v3.8h3.8"/><path d="M9 12h6M9 16h6"/>`,
	save: `<path d="M5 3h11.5L20 6.5V21H5V3z"/><path d="M8.5 3v5h7V3"/><path d="M8.5 21v-7h8v7"/>`,
	tag: `<path d="M3 12V3.5h8.5L21 13l-8 8-10-9z"/><circle cx="7.5" cy="7.5" r="1.6" fill="currentColor"/>`,
	arrowIn: `<path d="M12 3.5v12"/><path d="M7 10.5l5 5 5-5"/><path d="M4.5 20.5h15"/>`,
	arrowOut: `<path d="M12 20.5v-12"/><path d="M7 13.5l5-5 5 5"/><path d="M4.5 3.5h15"/>`,
	pen: `<path d="M4 20h4.2L19.5 8.7a2.5 2.5 0 0 0-4.2-4.2L4 15.8V20z"/><path d="M13.8 6l4.2 4.2"/>`,
	filter: `<path d="M3 4.5h18l-7 8.2v6.3l-4 2v-8.3L3 4.5z"/>`,
	calendar: `<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>`,
	trash: `<path d="M4 7h16"/><path d="M6.5 7l1 13.5h9l1-13.5"/><path d="M9.5 7V3.5h5V7"/><path d="M10 11v6M14 11v6"/>`,
	info: `<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r="1.1" fill="currentColor" stroke="none"/>`,
	link: `<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L11.8 6"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.4-1.4"/>`,
	list: `<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4.5" cy="6" r="1.3" fill="currentColor"/><circle cx="4.5" cy="12" r="1.3" fill="currentColor"/><circle cx="4.5" cy="18" r="1.3" fill="currentColor"/>`,
	crown: `<path d="M3 8.2l4.6 4L12 5l4.4 7.2L21 8.2 19.2 19H4.8L3 8.2z" fill="currentColor" fill-opacity="0.25"/><path d="M5 22h14"/>`,
	chevLeft: `<path d="M8.5 6.5 3 12l5.5 5.5"/>`,
	chevRight: `<path d="M3.5 6.5 9 12l-5.5 5.5"/>`,
	swatch: `<rect x="1.5" y="7" width="9" height="10" rx="2.5" fill="currentColor" stroke="none"/>`,
	toggleOn: `<rect x="2" y="4" width="36" height="16" rx="8" fill="currentColor" stroke="none"/><circle cx="28" cy="12" r="5.6" fill="{c2}" stroke="none"/>`,
	toggleOff: `<rect x="3" y="5" width="34" height="14" rx="7" stroke-width="1.8"/><circle cx="12" cy="12" r="4.4" fill="currentColor" stroke="none"/>`,
	dot: `<circle cx="12" cy="12" r="9.5" stroke-opacity="0.3" stroke-width="2.2"/><circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>`,
	ring: `<circle cx="12" cy="12" r="5" stroke-width="2.4"/>`,
} as const;

export type IconName = keyof typeof BODIES;

/** Icons that are not square. */
const VIEWBOX: Partial<Record<IconName, string>> = {
	toggleOn: "0 0 40 24",
	toggleOff: "0 0 40 24",
	chevLeft: "0 0 12 24",
	chevRight: "0 0 12 24",
	swatch: "0 0 12 24",
};

/** Single-width text fallbacks, deliberately outside emoji presentation ranges. */
const GLYPHS: Record<IconName, string> = {
	logo: "◆",
	flame: "▲",
	power: "◉",
	layers: "≡",
	scale: "±",
	hourglass: "◷",
	target: "◎",
	globe: "⊕",
	image: "▣",
	zap: "↯",
	reset: "↺",
	chart: "▮",
	cpu: "▦",
	pulse: "∿",
	clock: "◷",
	clockBack: "↶",
	refresh: "⟳",
	moon: "◑",
	coin: "¤",
	check: "✓",
	cross: "✗",
	alert: "△",
	pause: "‖",
	play: "▷",
	sliders: "⊞",
	box: "□",
	boxOn: "■",
	bell: "◔",
	database: "◫",
	file: "▭",
	save: "▪",
	tag: "◇",
	arrowIn: "↓",
	arrowOut: "↑",
	pen: "✎",
	filter: "▽",
	calendar: "▤",
	trash: "✕",
	info: "i",
	link: "∞",
	list: "☰",
	crown: "♛",
	chevLeft: "‹",
	chevRight: "›",
	swatch: "■",
	toggleOn: "●",
	toggleOff: "○",
	dot: "●",
	ring: "○",
};

export function svgDocument(body: string, color: string, color2: string, viewBox = "-1.5 -1.5 27 27"): string {
	return `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body.replaceAll("{c2}", color2)}</svg>`;
}

function hexOf(theme: Theme, token: string, fallback: string): string {
	try {
		const c = theme?.colors?.[token];
		return c ? colorToHex(c) : fallback;
	} catch {
		return fallback;
	}
}

export class Icons {
	private cache = new Map<string, string>();
	private slots = new Map<string, { key: string; seq: string; id: number }>();

	/** Icons are always drawn as SVG through the Kitty graphics protocol. */
	graphics(): boolean {
		return true;
	}

	/**
	 * An icon `cols` cells wide and `rows` cells tall. `slot` must be unique per on-screen position:
	 * every slot gets its own Kitty image id because one image id can only hold one placement.
	 */
	icon(theme: Theme, name: IconName, token: string, slot: string, cols = 2, rows = 1, token2 = "warning"): string {
		// Only used if rasterization fails.
		const glyph = () => theme.fg(token, GLYPHS[name]) + " ".repeat(Math.max(0, cols - 1));
		const color = hexOf(theme, token, "#cdd6f4");
		const color2 = hexOf(theme, token2, "#f9e2af");
		const cell = getCellDimensions();
		const key = `${name}|${color}|${color2}|${slot}|${cols}x${rows}|${cell.widthPx}x${cell.heightPx}`;
		const hit = this.cache.get(key);
		if (hit !== undefined) return hit;
		try {
			const w = cols * cell.widthPx * 2;
			const h = rows * cell.heightPx * 2;
			const png = renderSvg(svgDocument(BODIES[name], color, color2, VIEWBOX[name]), w, h, { color });
			const out = this.place(png, w, h, cols, rows);
			const s = out ?? glyph();
			this.cache.set(key, s);
			return s;
		} catch {
			return glyph();
		}
	}

	/**
	 * A rasterized image owned by one on-screen slot. When `key` changes the slot's image is
	 * re-rendered and replaces the previous one under the same Kitty image id.
	 */
	slotImage(slot: string, key: string, cols: number, rows: number, make: (wPx: number, hPx: number) => Buffer): string {
		const hit = this.slots.get(slot);
		if (hit && hit.key === key) return hit.seq;
		const cell = getCellDimensions();
		const w = Math.round(cols * cell.widthPx * 1.5);
		const h = Math.round(rows * cell.heightPx * 1.5);
		const id = hit?.id ?? allocateImageId();
		try {
			const seq = encodeKitty(make(w, h).toString("base64"), { columns: cols, rows, imageId: id, moveCursor: false }) + " ".repeat(cols);
			this.slots.set(slot, { key, seq, id });
			return seq;
		} catch {
			return " ".repeat(cols);
		}
	}

	/**
	 * Full transmit-and-place sequence. The image is deliberately NOT registered with pi-tui's
	 * placement cache: after a full redraw (ESC[2J, e.g. on resize) Ghostty drops uploaded image
	 * data, so pi's placement-only re-draws would show nothing. Re-sending small icons is cheap.
	 */
	private place(png: Buffer, _w: number, _h: number, cols: number, rows: number): string | undefined {
		const seq = encodeKitty(png.toString("base64"), { columns: cols, rows, imageId: allocateImageId(), moveCursor: false });
		// The cursor does not move over the image (C=1), so reserve the cells with spaces.
		return seq + " ".repeat(cols);
	}

	/** Drop cached placements, e.g. after a theme or cell-size change. */
	reset() {
		this.cache.clear();
		this.slots.clear();
	}
}
