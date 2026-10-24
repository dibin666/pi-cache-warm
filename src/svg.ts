/**
 * A small, dependency-free SVG rasterizer.
 *
 * It supports the subset used by this extension's hand-drawn icons and charts:
 * <svg viewBox>, <g>, <path>, <rect rx>, <circle>, <ellipse>, <line>, <polyline>, <polygon>;
 * fill / stroke / stroke-width / opacity / fill-opacity / stroke-opacity / fill-rule /
 * stroke-linecap / stroke-linejoin / transform; and every path command, including arcs.
 *
 * Rendering is anti-aliased (vertical super-sampling plus exact horizontal coverage) and the
 * result is encoded as a PNG with node:zlib.
 */
import { deflateSync } from "node:zlib";

type Pt = [number, number];
type Mat = [number, number, number, number, number, number]; // a b c d e f
type RGBA = [number, number, number, number]; // 0..255, 0..255, 0..255, 0..1

interface SubPath {
	pts: Pt[];
	closed: boolean;
}

interface Style {
	fill: string;
	stroke: string;
	strokeWidth: number;
	opacity: number;
	fillOpacity: number;
	strokeOpacity: number;
	fillRule: "nonzero" | "evenodd";
	lineCap: "butt" | "round" | "square";
	lineJoin: "miter" | "round" | "bevel";
}

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

// ── colours ─────────────────────────────────────────────────────────────────

const NAMED: Record<string, RGBA> = {
	black: [0, 0, 0, 1],
	white: [255, 255, 255, 1],
	red: [255, 0, 0, 1],
	transparent: [0, 0, 0, 0],
};

export function parseColor(value: string | undefined, current: string): RGBA | null {
	if (!value) return null;
	let v = value.trim().toLowerCase();
	if (v === "none") return null;
	if (v === "currentcolor") v = current.trim().toLowerCase();
	if (NAMED[v]) return NAMED[v]!;
	if (v.startsWith("#")) {
		let h = v.slice(1);
		if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
		if (h.length !== 6 && h.length !== 8) return null;
		const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16);
		return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
	}
	const m = /^rgba?\(([^)]*)\)$/.exec(v);
	if (m) {
		const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
		return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
	}
	return null;
}

// ── matrices ────────────────────────────────────────────────────────────────

function mul(m: Mat, n: Mat): Mat {
	return [
		m[0] * n[0] + m[2] * n[1],
		m[1] * n[0] + m[3] * n[1],
		m[0] * n[2] + m[2] * n[3],
		m[1] * n[2] + m[3] * n[3],
		m[0] * n[4] + m[2] * n[5] + m[4],
		m[1] * n[4] + m[3] * n[5] + m[5],
	];
}

function apply(m: Mat, p: Pt): Pt {
	return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

function parseTransform(s: string | undefined): Mat {
	let m: Mat = IDENTITY;
	if (!s) return m;
	const re = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g;
	for (let x = re.exec(s); x; x = re.exec(s)) {
		const a = x[2]!.split(/[\s,]+/).filter(Boolean).map(Number);
		let t: Mat = IDENTITY;
		if (x[1] === "matrix" && a.length === 6) t = a as Mat;
		else if (x[1] === "translate") t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
		else if (x[1] === "scale") t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
		else if (x[1] === "rotate") {
			const r = ((a[0] ?? 0) * Math.PI) / 180;
			const c = Math.cos(r);
			const sn = Math.sin(r);
			const cx = a[1] ?? 0;
			const cy = a[2] ?? 0;
			t = mul(mul([1, 0, 0, 1, cx, cy], [c, sn, -sn, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
		}
		m = mul(m, t);
	}
	return m;
}

// ── path parsing and flattening ────────────────────────────────────────────

function tokenize(d: string): (string | number)[] {
	const out: (string | number)[] = [];
	const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?)/g;
	for (let m = re.exec(d); m; m = re.exec(d)) out.push(m[1] ?? Number(m[2]));
	return out;
}

function arcToPoints(
	x1: number,
	y1: number,
	rx: number,
	ry: number,
	phiDeg: number,
	large: boolean,
	sweep: boolean,
	x2: number,
	y2: number,
	seg: number,
): Pt[] {
	if (rx === 0 || ry === 0) return [[x2, y2]];
	rx = Math.abs(rx);
	ry = Math.abs(ry);
	const phi = (phiDeg * Math.PI) / 180;
	const cos = Math.cos(phi);
	const sin = Math.sin(phi);
	const dx = (x1 - x2) / 2;
	const dy = (y1 - y2) / 2;
	const x1p = cos * dx + sin * dy;
	const y1p = -sin * dx + cos * dy;
	const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
	if (lambda > 1) {
		rx *= Math.sqrt(lambda);
		ry *= Math.sqrt(lambda);
	}
	const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
	const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
	let coef = Math.sqrt(Math.max(0, num / den));
	if (large === sweep) coef = -coef;
	const cxp = (coef * rx * y1p) / ry;
	const cyp = (-coef * ry * x1p) / rx;
	const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
	const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
	const ang = (ux: number, uy: number, vx: number, vy: number) => {
		const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
		return a;
	};
	const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
	let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
	if (!sweep && dt > 0) dt -= 2 * Math.PI;
	if (sweep && dt < 0) dt += 2 * Math.PI;
	const n = Math.max(4, Math.ceil((Math.abs(dt) * Math.max(rx, ry)) / seg));
	const pts: Pt[] = [];
	for (let i = 1; i <= n; i++) {
		const t = t1 + (dt * i) / n;
		const ex = rx * Math.cos(t);
		const ey = ry * Math.sin(t);
		pts.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
	}
	return pts;
}

function bezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, seg: number): Pt[] {
	const len =
		Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) +
		Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) +
		Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
	const n = Math.max(4, Math.min(200, Math.ceil(len / seg)));
	const pts: Pt[] = [];
	for (let i = 1; i <= n; i++) {
		const t = i / n;
		const u = 1 - t;
		pts.push([
			u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
			u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
		]);
	}
	return pts;
}

export function parsePath(d: string, seg = 0.25): SubPath[] {
	const tk = tokenize(d);
	const subs: SubPath[] = [];
	let cur: SubPath | undefined;
	let x = 0;
	let y = 0;
	let sx = 0;
	let sy = 0;
	let lastCtrl: Pt | undefined;
	let lastCmd = "";
	let i = 0;
	let cmd = "";
	const num = () => {
		const v = tk[i++];
		return typeof v === "number" ? v : 0;
	};
	const start = (nx: number, ny: number) => {
		cur = { pts: [[nx, ny]], closed: false };
		subs.push(cur);
		x = sx = nx;
		y = sy = ny;
	};
	const lineTo = (nx: number, ny: number) => {
		if (!cur) start(x, y);
		cur!.pts.push([nx, ny]);
		x = nx;
		y = ny;
	};
	while (i < tk.length) {
		if (typeof tk[i] === "string") cmd = tk[i++] as string;
		else if (cmd === "M") cmd = "L";
		else if (cmd === "m") cmd = "l";
		const rel = cmd === cmd.toLowerCase();
		const C = cmd.toUpperCase();
		const ox = rel ? x : 0;
		const oy = rel ? y : 0;
		switch (C) {
			case "M":
				start(ox + num(), oy + num());
				lastCtrl = undefined;
				break;
			case "L":
				lineTo(ox + num(), oy + num());
				lastCtrl = undefined;
				break;
			case "H":
				lineTo(ox + num(), y);
				lastCtrl = undefined;
				break;
			case "V":
				lineTo(x, (rel ? y : 0) + num());
				lastCtrl = undefined;
				break;
			case "C":
			case "S": {
				let c1: Pt;
				if (C === "C") c1 = [ox + num(), oy + num()];
				else
					c1 =
						lastCtrl && (lastCmd === "C" || lastCmd === "S") ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]] : [x, y];
				const c2: Pt = [ox + num(), oy + num()];
				const e: Pt = [ox + num(), oy + num()];
				if (!cur) start(x, y);
				cur!.pts.push(...bezier([x, y], c1, c2, e, seg));
				lastCtrl = c2;
				x = e[0];
				y = e[1];
				break;
			}
			case "Q":
			case "T": {
				let q: Pt;
				if (C === "Q") q = [ox + num(), oy + num()];
				else q = lastCtrl && (lastCmd === "Q" || lastCmd === "T") ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]] : [x, y];
				const e: Pt = [ox + num(), oy + num()];
				const c1: Pt = [x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y)];
				const c2: Pt = [e[0] + (2 / 3) * (q[0] - e[0]), e[1] + (2 / 3) * (q[1] - e[1])];
				if (!cur) start(x, y);
				cur!.pts.push(...bezier([x, y], c1, c2, e, seg));
				lastCtrl = q;
				x = e[0];
				y = e[1];
				break;
			}
			case "A": {
				const rx = num();
				const ry = num();
				const rot = num();
				const large = num() !== 0;
				const sweep = num() !== 0;
				const ex = ox + num();
				const ey = oy + num();
				if (!cur) start(x, y);
				cur!.pts.push(...arcToPoints(x, y, rx, ry, rot, large, sweep, ex, ey, seg));
				x = ex;
				y = ey;
				lastCtrl = undefined;
				break;
			}
			case "Z":
				if (cur) {
					cur.closed = true;
					cur = undefined;
				}
				x = sx;
				y = sy;
				lastCtrl = undefined;
				break;
			default:
				i++; // skip unknown token
		}
		lastCmd = C;
	}
	return subs;
}

// ── shapes to path data ─────────────────────────────────────────────────────

function n(attrs: Record<string, string>, k: string, d = 0): number {
	const v = Number.parseFloat(attrs[k] ?? "");
	return Number.isFinite(v) ? v : d;
}

function shapeToPath(tag: string, a: Record<string, string>): string | undefined {
	switch (tag) {
		case "path":
			return a.d;
		case "rect": {
			const x = n(a, "x");
			const y = n(a, "y");
			const w = n(a, "width");
			const h = n(a, "height");
			if (w <= 0 || h <= 0) return undefined;
			let rx = Math.min(n(a, "rx", n(a, "ry")), w / 2);
			let ry = Math.min(n(a, "ry", rx), h / 2);
			if (rx <= 0 || ry <= 0) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
			rx = Math.max(0, rx);
			ry = Math.max(0, ry);
			return (
				`M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}` +
				`A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
				`V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
			);
		}
		case "circle":
		case "ellipse": {
			const cx = n(a, "cx");
			const cy = n(a, "cy");
			const rx = tag === "circle" ? n(a, "r") : n(a, "rx");
			const ry = tag === "circle" ? n(a, "r") : n(a, "ry");
			if (rx <= 0 || ry <= 0) return undefined;
			return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
		}
		case "line":
			return `M${n(a, "x1")} ${n(a, "y1")}L${n(a, "x2")} ${n(a, "y2")}`;
		case "polyline":
		case "polygon": {
			const p = (a.points ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
			if (p.length < 4) return undefined;
			let d = `M${p[0]} ${p[1]}`;
			for (let k = 2; k + 1 < p.length; k += 2) d += `L${p[k]} ${p[k + 1]}`;
			return tag === "polygon" ? `${d}Z` : d;
		}
	}
	return undefined;
}

// ── stroking ────────────────────────────────────────────────────────────────

function area(poly: Pt[]): number {
	let s = 0;
	for (let k = 0; k < poly.length; k++) {
		const p = poly[k]!;
		const q = poly[(k + 1) % poly.length]!;
		s += p[0] * q[1] - q[0] * p[1];
	}
	return s / 2;
}

/** Orient every stroke piece the same way so a non-zero fill yields their union. */
function negative(poly: Pt[]): Pt[] {
	return area(poly) > 0 ? poly.reverse() : poly;
}

function disc(c: Pt, r: number): Pt[] {
	const steps = Math.max(12, Math.min(64, Math.ceil(r * 3)));
	const pts: Pt[] = [];
	for (let k = 0; k < steps; k++) {
		const t = (-2 * Math.PI * k) / steps;
		pts.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
	}
	return negative(pts);
}

function strokePolys(sub: SubPath, w: number, cap: Style["lineCap"], join: Style["lineJoin"]): Pt[][] {
	const pts = sub.pts.filter((p, k) => k === 0 || Math.hypot(p[0] - sub.pts[k - 1]![0], p[1] - sub.pts[k - 1]![1]) > 1e-6);
	if (sub.closed && pts.length > 2) {
		const f = pts[0]!;
		const l = pts[pts.length - 1]!;
		if (Math.hypot(f[0] - l[0], f[1] - l[1]) > 1e-6) pts.push([f[0], f[1]]);
	}
	const h = w / 2;
	const out: Pt[][] = [];
	if (pts.length === 1) {
		if (cap === "round") out.push(disc(pts[0]!, h));
		else if (cap === "square") {
			const [x, y] = pts[0]!;
			out.push(negative([[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h]]));
		}
		return out;
	}
	const segs = pts.length - 1;
	for (let k = 0; k < segs; k++) {
		let p = pts[k]!;
		let q = pts[k + 1]!;
		const dx = q[0] - p[0];
		const dy = q[1] - p[1];
		const len = Math.hypot(dx, dy) || 1;
		const ux = dx / len;
		const uy = dy / len;
		if (cap === "square" && !sub.closed) {
			if (k === 0) p = [p[0] - ux * h, p[1] - uy * h];
			if (k === segs - 1) q = [q[0] + ux * h, q[1] + uy * h];
		}
		const nx = -uy * h;
		const ny = ux * h;
		out.push(
			negative([
				[p[0] + nx, p[1] + ny],
				[q[0] + nx, q[1] + ny],
				[q[0] - nx, q[1] - ny],
				[p[0] - nx, p[1] - ny],
			]),
		);
	}
	// joins
	const joinAt = (k: number) => {
		const v = pts[k]!;
		if (join === "round") {
			out.push(disc(v, h));
			return;
		}
		const a = pts[k - 1 < 0 ? pts.length - 2 : k - 1]!;
		const b = pts[k + 1 >= pts.length ? 1 : k + 1]!;
		const d1 = [v[0] - a[0], v[1] - a[1]];
		const d2 = [b[0] - v[0], b[1] - v[1]];
		const l1 = Math.hypot(d1[0]!, d1[1]!) || 1;
		const l2 = Math.hypot(d2[0]!, d2[1]!) || 1;
		const n1: Pt = [(-d1[1]! / l1) * h, (d1[0]! / l1) * h];
		const n2: Pt = [(-d2[1]! / l2) * h, (d2[0]! / l2) * h];
		const cross = d1[0]! * d2[1]! - d1[1]! * d2[0]!;
		const s = cross > 0 ? -1 : 1; // outer side
		const o1: Pt = [v[0] + s * n1[0], v[1] + s * n1[1]];
		const o2: Pt = [v[0] + s * n2[0], v[1] + s * n2[1]];
		const poly: Pt[] = [v, o1, o2];
		if (join === "miter") {
			// Intersect the two outer offset lines (miter limit 4).
			const det = d1[0]! * d2[1]! - d1[1]! * d2[0]!;
			if (Math.abs(det) > 1e-9) {
				const t = ((o2[0] - o1[0]) * d2[1]! - (o2[1] - o1[1]) * d2[0]!) / det;
				const m: Pt = [o1[0] + d1[0]! * t, o1[1] + d1[1]! * t];
				if (Math.hypot(m[0] - v[0], m[1] - v[1]) <= 4 * h) poly.splice(2, 0, m);
			}
		}
		out.push(negative(poly));
	};
	for (let k = 1; k < pts.length - 1; k++) joinAt(k);
	if (sub.closed && pts.length > 3) joinAt(0);
	if (!sub.closed && cap === "round") {
		out.push(disc(pts[0]!, h));
		out.push(disc(pts[pts.length - 1]!, h));
	}
	return out;
}

// ── scanline coverage rasterizer ────────────────────────────────────────────

const SS = 5; // vertical sub-samples per pixel

class Canvas {
	readonly data: Float32Array; // premultiplied RGBA, 0..1

	constructor(
		readonly w: number,
		readonly h: number,
	) {
		this.data = new Float32Array(w * h * 4);
	}

	fill(polys: Pt[][], color: RGBA, rule: "nonzero" | "evenodd") {
		if (color[3] <= 0) return;
		type Edge = { x0: number; y0: number; x1: number; y1: number; dir: number };
		const edges: Edge[] = [];
		let minY = Number.POSITIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const poly of polys) {
			for (let k = 0; k < poly.length; k++) {
				const p = poly[k]!;
				const q = poly[(k + 1) % poly.length]!;
				if (p[1] === q[1]) continue;
				const dir = q[1] > p[1] ? 1 : -1;
				const [a, b] = dir === 1 ? [p, q] : [q, p];
				edges.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1], dir });
				minY = Math.min(minY, a[1]);
				maxY = Math.max(maxY, b[1]);
			}
		}
		if (!edges.length) return;
		const y0 = Math.max(0, Math.floor(minY));
		const y1 = Math.min(this.h - 1, Math.ceil(maxY));
		const cov = new Float32Array(this.w + 2);
		const xs: { x: number; d: number }[] = [];
		for (let py = y0; py <= y1; py++) {
			cov.fill(0);
			let touched = false;
			let minX = this.w;
			let maxX = 0;
			for (let s = 0; s < SS; s++) {
				const sy = py + (s + 0.5) / SS;
				xs.length = 0;
				for (const e of edges) {
					if (sy < e.y0 || sy >= e.y1) continue;
					xs.push({ x: e.x0 + ((sy - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0), d: e.dir });
				}
				if (xs.length < 2) continue;
				xs.sort((u, v) => u.x - v.x);
				let wind = 0;
				for (let k = 0; k < xs.length - 1; k++) {
					wind += xs[k]!.d;
					const inside = rule === "nonzero" ? wind !== 0 : (wind & 1) === 1;
					if (!inside) continue;
					const a = Math.max(0, xs[k]!.x);
					const b = Math.min(this.w, xs[k + 1]!.x);
					if (b <= a) continue;
					touched = true;
					const ia = Math.floor(a);
					const ib = Math.floor(b);
					minX = Math.min(minX, ia);
					maxX = Math.max(maxX, ib);
					if (ia === ib) cov[ia]! += (b - a) / SS;
					else {
						cov[ia]! += (ia + 1 - a) / SS;
						for (let x = ia + 1; x < ib; x++) cov[x]! += 1 / SS;
						if (ib < this.w) cov[ib]! += (b - ib) / SS;
					}
				}
			}
			if (!touched) continue;
			for (let x = minX; x <= Math.min(maxX, this.w - 1); x++) {
				const c = Math.min(1, cov[x]!);
				if (c <= 0) continue;
				const a = c * color[3];
				const o = (py * this.w + x) * 4;
				const d = this.data;
				d[o] = (color[0] / 255) * a + d[o]! * (1 - a);
				d[o + 1] = (color[1] / 255) * a + d[o + 1]! * (1 - a);
				d[o + 2] = (color[2] / 255) * a + d[o + 2]! * (1 - a);
				d[o + 3] = a + d[o + 3]! * (1 - a);
			}
		}
	}

	toPng(): Buffer {
		const { w, h, data } = this;
		const raw = Buffer.alloc((w * 4 + 1) * h);
		for (let y = 0; y < h; y++) {
			const row = y * (w * 4 + 1);
			raw[row] = 0;
			for (let x = 0; x < w; x++) {
				const i = (y * w + x) * 4;
				const a = data[i + 3]!;
				const o = row + 1 + x * 4;
				if (a > 0) {
					raw[o] = Math.round(Math.min(1, data[i]! / a) * 255);
					raw[o + 1] = Math.round(Math.min(1, data[i + 1]! / a) * 255);
					raw[o + 2] = Math.round(Math.min(1, data[i + 2]! / a) * 255);
					raw[o + 3] = Math.round(Math.min(1, a) * 255);
				}
			}
		}
		return encodePng(w, h, raw);
	}
}

// ── PNG encoding ───────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let k = 0; k < 256; k++) {
		let c = k;
		for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[k] = c >>> 0;
	}
	return t;
})();

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(td));
	return Buffer.concat([len, td, crc]);
}

function encodePng(w: number, h: number, raw: Buffer): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// ── document walk ───────────────────────────────────────────────────────────

const DEFAULT_STYLE: Style = {
	fill: "#000",
	stroke: "none",
	strokeWidth: 1,
	opacity: 1,
	fillOpacity: 1,
	strokeOpacity: 1,
	fillRule: "nonzero",
	lineCap: "butt",
	lineJoin: "miter",
};

function inherit(parent: Style, a: Record<string, string>): Style {
	const s = { ...parent };
	if (a.fill !== undefined) s.fill = a.fill;
	if (a.stroke !== undefined) s.stroke = a.stroke;
	if (a["stroke-width"] !== undefined) s.strokeWidth = Number.parseFloat(a["stroke-width"]) || 0;
	if (a["fill-opacity"] !== undefined) s.fillOpacity = Number.parseFloat(a["fill-opacity"]);
	if (a["stroke-opacity"] !== undefined) s.strokeOpacity = Number.parseFloat(a["stroke-opacity"]);
	if (a["fill-rule"] === "evenodd" || a["fill-rule"] === "nonzero") s.fillRule = a["fill-rule"];
	if (a["stroke-linecap"] === "round" || a["stroke-linecap"] === "square" || a["stroke-linecap"] === "butt")
		s.lineCap = a["stroke-linecap"];
	if (a["stroke-linejoin"] === "round" || a["stroke-linejoin"] === "bevel" || a["stroke-linejoin"] === "miter")
		s.lineJoin = a["stroke-linejoin"];
	s.opacity = parent.opacity * (a.opacity !== undefined ? Number.parseFloat(a.opacity) : 1);
	return s;
}

function parseAttrs(src: string): Record<string, string> {
	const out: Record<string, string> = {};
	const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
	for (let m = re.exec(src); m; m = re.exec(src)) out[m[1]!] = m[3] ?? m[4] ?? "";
	return out;
}

export interface RenderOptions {
	/** Value used for `currentColor`. */
	color?: string;
}

/** Rasterize an SVG document to a PNG of exactly `width` × `height` pixels. */
export function renderSvg(svg: string, width: number, height: number, opts: RenderOptions = {}): Buffer {
	const w = Math.max(1, Math.round(width));
	const h = Math.max(1, Math.round(height));
	const canvas = new Canvas(w, h);
	const current = opts.color ?? "#000";
	const tagRe = /<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g;
	const stack: { style: Style; mat: Mat }[] = [];
	let style = DEFAULT_STYLE;
	let mat: Mat = IDENTITY;
	for (let m = tagRe.exec(svg); m; m = tagRe.exec(svg)) {
		const closing = m[1] === "/";
		const tag = m[2]!.toLowerCase();
		const selfClose = m[4] === "/";
		if (closing) {
			if (tag === "g" || tag === "svg") {
				const top = stack.pop();
				if (top) ({ style, mat } = top);
			}
			continue;
		}
		const a = parseAttrs(m[3]!);
		if (tag === "svg") {
			const vb = (a.viewBox ?? `0 0 ${w} ${h}`).split(/[\s,]+/).map(Number);
			const [vx, vy, vw, vh] = [vb[0] ?? 0, vb[1] ?? 0, vb[2] || w, vb[3] || h];
			const scale = Math.min(w / vw, h / vh);
			const tx = (w - vw * scale) / 2 - vx * scale;
			const ty = (h - vh * scale) / 2 - vy * scale;
			stack.push({ style, mat });
			style = inherit(style, a);
			mat = [scale, 0, 0, scale, tx, ty];
			if (selfClose) ({ style, mat } = stack.pop()!);
			continue;
		}
		if (tag === "g") {
			stack.push({ style, mat });
			style = inherit(style, a);
			mat = mul(mat, parseTransform(a.transform));
			if (selfClose) ({ style, mat } = stack.pop()!);
			continue;
		}
		const d = shapeToPath(tag, a);
		if (!d) continue;
		const s = inherit(style, a);
		const m2 = mul(mat, parseTransform(a.transform));
		const scale = Math.sqrt(Math.abs(m2[0] * m2[3] - m2[1] * m2[2])) || 1;
		const subs = parsePath(d, 0.3 / scale).map((sp) => ({ closed: sp.closed, pts: sp.pts.map((p) => apply(m2, p)) }));
		const fill = parseColor(s.fill, current);
		if (fill && tag !== "line" && tag !== "polyline") {
			canvas.fill(
				subs.map((sp) => sp.pts),
				[fill[0], fill[1], fill[2], fill[3] * s.fillOpacity * s.opacity],
				s.fillRule,
			);
		}
		const stroke = parseColor(s.stroke, current);
		if (stroke && s.strokeWidth > 0) {
			const sw = s.strokeWidth * scale;
			const polys: Pt[][] = [];
			for (const sp of subs) polys.push(...strokePolys(sp, sw, s.lineCap, s.lineJoin));
			canvas.fill(polys, [stroke[0], stroke[1], stroke[2], stroke[3] * s.strokeOpacity * s.opacity], "nonzero");
		}
	}
	return canvas.toPng();
}
