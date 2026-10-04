export type ChartType = "gauge" | "bar" | "line" | "number";

export type KeyView = {
	label: string;
	temp: number | null;
	unit: "C" | "F";
	warn: number;
	crit: number;
	chart: ChartType;
	/** null = kolor automatyczny wg progów */
	customColor: string | null;
	history: number[];
	showLabel: boolean;
	/** null = domyślne tło */
	bgColor: string | null;
	/** faza migania przy temperaturze krytycznej (czerwone tło) */
	alertFlash: boolean;
	sub?: string;
};

const MIN = 20;
const MAX = 100;
const START = 135; // stopnie, 0 = prawo, rosną zgodnie z ruchem wskazówek
const SWEEP = 270;
const CX = 72;
const CY = 80;
const R = 50;
type Theme = { bg1: string; bg2: string; border: string; track: string; fg: string; label: string; sub: string; warn: string };

const DEFAULT_THEME: Theme = { bg1: "#2a3041", bg2: "#141821", border: "#454e66", track: "#3f485e", fg: "#ffffff", label: "#b8c1d4", sub: "#95a0b6", warn: "#ffb454" };

/** motyw używany przez bieżące renderKey (render jest synchroniczny) */
let theme = DEFAULT_THEME;

function parseHex(hex: string): [number, number, number] | null {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return null;
	const n = parseInt(m[1], 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const mixRgb = (c: number[], to: number, k: number) => `rgb(${c.map((v) => Math.round(v + (to - v) * k)).join(",")})`;

/** Motyw z własnego koloru tła; jasne tła dostają ciemny tekst. */
function themeFor(bg: string | null): Theme {
	const c = bg ? parseHex(bg) : null;
	if (!c) return DEFAULT_THEME;
	const light = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 > 0.55;
	const base = { bg1: mixRgb(c, 255, 0.08), bg2: mixRgb(c, 0, 0.3) };
	return light
		? { ...base, border: "rgba(0,0,0,.25)", track: "rgba(0,0,0,.16)", fg: "#0f172a", label: "#334155", sub: "#475569", warn: "#b45309" }
		: { ...base, border: "rgba(255,255,255,.22)", track: "rgba(255,255,255,.2)", fg: "#ffffff", label: "#cbd5e1", sub: "#b4bfd1", warn: "#ffb454" };
}
const FONT = `font-family="Segoe UI, Arial, sans-serif"`;

const pt = (deg: number) => {
	const a = (deg * Math.PI) / 180;
	return [CX + R * Math.cos(a), CY + R * Math.sin(a)].map((n) => n.toFixed(2));
};

const endPt = (fraction: number) => pt(START + SWEEP * Math.max(0.001, Math.min(1, fraction)));

function arc(fraction: number): string {
	const end = START + SWEEP * Math.max(0.001, Math.min(1, fraction));
	const [x1, y1] = pt(START);
	const [x2, y2] = pt(end);
	return `M${x1} ${y1} A${R} ${R} 0 ${end - START > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}

/** zielony -> bursztyn -> czerwony zależnie od progów */
function autoColor(t: number, warn: number, crit: number): string {
	const lerp = (a: number, b: number, k: number) => Math.round(a + (b - a) * k);
	const mix = (c1: number[], c2: number[], k: number) => `rgb(${c1.map((v, i) => lerp(v, c2[i], k)).join(",")})`;
	const green = [52, 211, 153], amber = [251, 191, 36], red = [248, 82, 82];
	if (t <= warn - 15) return mix(green, green, 0);
	if (t < warn) return mix(green, amber, (t - (warn - 15)) / 15);
	if (t < crit) return mix(amber, red, (t - warn) / Math.max(1, crit - warn));
	return mix(red, red, 0);
}

const conv = (t: number, unit: "C" | "F") => (unit === "F" ? (t * 9) / 5 + 32 : t);

function lineChart(v: KeyView, c: string): string {
	const X0 = 14, X1 = 130, Y0 = 80, Y1 = 116;
	const h = v.history;
	if (h.length < 2) return `<line x1="${X0}" y1="${Y1}" x2="${X1}" y2="${Y1}" stroke="${theme.track}" stroke-width="3" stroke-linecap="round"/>`;
	const lo0 = Math.min(...h), hi0 = Math.max(...h);
	const span = Math.max(20, hi0 - lo0 + 6);
	const lo = (lo0 + hi0) / 2 - span / 2;
	const pts = h.map((t, i) => [X0 + ((X1 - X0) * i) / (h.length - 1), Y1 - ((Y1 - Y0) * (t - lo)) / span]);
	const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
	const [lx, ly] = pts[pts.length - 1];
	return `<defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity=".45"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient></defs>
<path d="${line} L${X1} ${Y1 + 6} L${X0} ${Y1 + 6} Z" fill="url(#fill)"/>
<path d="${line}" fill="none" stroke="${c}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>
<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4.5" fill="${theme.fg}"/>`;
}

function subText(text: string): string {
	const lines = text.split("\n");
	const size = (len: number, max: number) => Math.min(max, Math.floor(130 / (len * 0.56)));
	if (lines.length === 1) return `<text x="72" y="136" text-anchor="middle" ${FONT} font-size="${size(text.length, 15)}" font-weight="600" fill="${theme.sub}">${text}</text>`;
	const s = Math.min(...lines.map((l) => size(l.length, 12)));
	return lines.map((l, i) => `<text x="72" y="${129 + i * (s + 1)}" text-anchor="middle" ${FONT} font-size="${s}" font-weight="600" fill="${theme.warn}">${l}</text>`).join("");
}

export function renderKey(v: KeyView): string {
	theme = themeFor(v.alertFlash ? "#991b1b" : v.bgColor);
	const has = v.temp !== null;
	const t = v.temp ?? 0;
	const c = !has ? "#6b7280" : (v.customColor ?? autoColor(t, v.warn, v.crit));
	const frac = has ? Math.max(0, Math.min(1, (t - MIN) / (MAX - MIN))) : 0;
	const shown = has ? Math.round(conv(t, v.unit)) : "–";
	const hot = has && t >= v.crit;
	const digits = String(shown).length;

	// układ zależny od typu wykresu
	let body = "";
	let labelY = 22;
	if (v.chart === "gauge") {
		const size = digits >= 3 ? 40 : 48;
		const [kx, ky] = endPt(frac);
		body = `<path d="${arc(1)}" fill="none" stroke="${theme.track}" stroke-width="11" stroke-linecap="round"/>
${has ? `<path d="${arc(frac)}" fill="none" stroke="${c}" stroke-width="11" stroke-linecap="round" filter="url(#glow)"/>
<circle cx="${kx}" cy="${ky}" r="4" fill="${theme.fg}"/>` : ""}
<text x="72" y="${CY + size * 0.36}" text-anchor="middle" ${FONT} font-size="${size}" font-weight="700" fill="${theme.fg}">${shown}</text>
<text x="72" y="${CY + size * 0.36 + 21}" text-anchor="middle" ${FONT} font-size="17" font-weight="700" fill="${c}">°${v.unit}</text>`;
	} else if (v.chart === "bar") {
		const w = 104 * frac;
		body = `<text x="72" y="82" text-anchor="middle" ${FONT} font-size="${digits >= 3 ? 46 : 54}" font-weight="700" fill="${theme.fg}">${shown}<tspan font-size="20" font-weight="600" dx="1" dy="-${digits >= 3 ? 24 : 30}" fill="${c}">°${v.unit}</tspan></text>
<rect x="20" y="100" width="104" height="14" rx="7" fill="${theme.track}"/>
${has ? `<rect x="20" y="100" width="${Math.max(14, w).toFixed(1)}" height="14" rx="7" fill="${c}" filter="url(#glow)"/>` : ""}`;
	} else if (v.chart === "line") {
		labelY = 22;
		body = `<text x="72" y="70" text-anchor="middle" ${FONT} font-size="${digits >= 3 ? 36 : 42}" font-weight="700" fill="${theme.fg}">${shown}<tspan font-size="16" font-weight="600" dx="1" dy="-${digits >= 3 ? 16 : 22}" fill="${c}">°${v.unit}</tspan></text>
${lineChart(v, c)}`;
	} else {
		body = `<text x="72" y="96" text-anchor="middle" ${FONT} font-size="${digits >= 3 ? 62 : 76}" font-weight="700" fill="${c}" filter="url(#glow)">${shown}</text>
<text x="72" y="118" text-anchor="middle" ${FONT} font-size="18" font-weight="600" fill="${theme.label}">°${v.unit}</text>`;
	}

	const showSub = v.sub;
	const shift = v.showLabel ? 0 : -8; // bez nazwy cała treść idzie wyżej
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${theme.bg1}"/><stop offset="1" stop-color="${theme.bg2}"/></linearGradient>
<filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<rect width="144" height="144" rx="22" fill="url(#bg)"/>
<rect x=".75" y=".75" width="142.5" height="142.5" rx="21.5" fill="none" stroke="${theme.border}" stroke-width="1.5"/>
${hot ? `<rect x="2" y="2" width="140" height="140" rx="20" fill="none" stroke="${c}" stroke-width="3" opacity=".85"/>` : ""}
${v.showLabel ? `<text x="72" y="${labelY}" text-anchor="middle" ${FONT} font-size="19" font-weight="700" letter-spacing="2" fill="${theme.label}">${v.label}</text>` : ""}
<g transform="translate(0 ${shift})">${body}</g>
${showSub ? subText(v.sub!) : ""}
</svg>`;
}

export const toDataUri = (svg: string) => `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
