/**
 * Character-drawn graphics: the stacked history bar chart and the cache-life bar.
 * They are text on purpose so they show in every terminal (including multiplexers that do not
 * forward Kitty graphics); icons stay SVG.
 */
import type { Bucket } from "./history.ts";

type Theme = any;

export const SERIES = ["plugin", "builtin", "manual", "failed", "rebuild"] as const;
export type Series = (typeof SERIES)[number];

/** Theme tokens per series, shared by bars, legend and list icons. */
export const SERIES_TOKEN: Record<Series, string> = {
	plugin: "success",
	builtin: "accent",
	manual: "warning",
	failed: "muted",
	rebuild: "error",
};

const EIGHTHS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Width of every bar in cells; bars are separated by one blank cell. */
export const BAR_W = 2;

/** Number of buckets that fit `cols` columns with uniform bars. */
export function chartBuckets(cols: number): number {
	return Math.max(4, Math.floor(cols / (BAR_W + 1)));
}

const total = (b: Bucket) => SERIES.reduce((s, k) => s + b[k], 0);

/**
 * Stacked bars, one bucket per column group, height in eighth blocks. Each cell takes the
 * colour of the series that fills most of it, so stacks stay readable without sub-cell colour.
 */
export function textChart(buckets: Bucket[], cols: number, rows: number, theme: Theme): string[] {
	const n = buckets.length;
	const max = Math.max(1e-9, ...buckets.map(total));
	const levels = rows * 8;
	// Cumulative tops (in eighths) for each series per bucket.
	const stacks = buckets.map((b) => {
		const t = total(b);
		const h = t > 0 ? Math.max(1, Math.round((t / max) * levels)) : 0;
		let acc = 0;
		return SERIES.map((k) => {
			acc += b[k];
			return { k, top: t > 0 ? Math.round((acc / t) * h) : 0 };
		});
	});
	// Fixed geometry: every bar is BAR_W cells with a one-cell gap. The caller sizes the bucket
	// count with chartBuckets(), so the bars fill the width without uneven rounding.
	const step = BAR_W + 1;
	const offset = Math.max(0, cols - n * step);
	const out: string[] = [];
	for (let r = rows - 1; r >= 0; r--) {
		const lo = r * 8;
		const hi = lo + 8;
		let line = " ".repeat(offset);
		let col = offset;
		for (let i = 0; i < n && col + step <= cols; i++) {
			const st = stacks[i]!;
			const height = st[st.length - 1]!.top;
			const fill = Math.max(0, Math.min(8, height - lo));
			if (fill === 0) {
				line += " ".repeat(step);
				col += step;
				continue;
			}
			// Series covering the most eighths inside this cell.
			let best: Series = "plugin";
			let bestCover = -1;
			let prev = 0;
			for (const { k, top } of st) {
				const cover = Math.max(0, Math.min(top, hi) - Math.max(prev, lo));
				if (cover > bestCover) {
					bestCover = cover;
					best = k;
				}
				prev = top;
			}
			line += `${theme.fg(SERIES_TOKEN[best], EIGHTHS[fill]!.repeat(BAR_W))} `;
			col += step;
		}
		out.push(line + " ".repeat(Math.max(0, cols - col)));
	}
	return out;
}

/**
 * Cache-life bar: filled part = remaining lifetime (shrinks toward the left),
 * tick = the remaining fraction at which the refresh fires.
 */
export function textLifeBar(theme: Theme, cols: number, remaining: number | undefined, marker: number): string {
	if (remaining === undefined) return theme.fg("dim", "─".repeat(cols));
	const filled = Math.round(Math.max(0, Math.min(1, remaining)) * cols);
	const tick = Math.min(cols - 1, Math.max(0, Math.round(marker * cols)));
	const tone = remaining < 0.15 ? "error" : "success";
	let s = "";
	for (let i = 0; i < cols; i++) {
		if (i === tick) s += theme.fg("warning", "┃");
		else if (i < filled) s += theme.fg(tone, "━");
		else s += theme.fg("dim", "─");
	}
	return s;
}
