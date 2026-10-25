/**
 * Character icons: one single-width Unicode symbol per icon, coloured with the theme.
 * They are plain text on purpose so they show in every terminal and font (no image protocol,
 * no Nerd Font, nothing from emoji presentation ranges), and layouts keep a fixed width.
 */
type Theme = any;

const GLYPHS = {
	logo: "◆",
	flame: "▲",
	power: "◉",
	layers: "≡",
	scale: "±",
	hourglass: "◴",
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
	refresh: "↻",
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
	save: "⇓",
	tag: "◇",
	arrowIn: "↓",
	arrowOut: "↑",
	pen: "✎",
	filter: "▽",
	calendar: "▤",
	trash: "✕",
	info: "i",
	link: "∞",
	list: "≣",
	crown: "♛",
	chevLeft: "‹",
	chevRight: "›",
	swatch: "■",
	dot: "●",
	ring: "○",
} as const;

export type IconName = keyof typeof GLYPHS;

export class Icons {
	private cache = new Map<string, string>();

	/**
	 * An icon `cols` cells wide: the glyph followed by padding. `slot` and `rows` are kept for
	 * call-site compatibility; text icons need neither.
	 */
	icon(theme: Theme, name: IconName, token: string, _slot = "", cols = 2, _rows = 1, _token2 = ""): string {
		const key = `${name}|${token}|${cols}`;
		const hit = this.cache.get(key);
		if (hit !== undefined) return hit;
		const s = theme.fg(token, GLYPHS[name]) + " ".repeat(Math.max(0, cols - 1));
		this.cache.set(key, s);
		return s;
	}

	/** Drop cached strings, e.g. after a theme change. */
	reset() {
		this.cache.clear();
	}
}
