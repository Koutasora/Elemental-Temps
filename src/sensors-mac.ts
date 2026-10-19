// macOS: odczyty z darmowego narzędzia macmon (Apple Silicon, `brew install macmon`), na Intel Macach z osx-cpu-temp.
// RAM i obciążenie CPU liczone z systemu, bez dodatkowych narzędzi. Temperatury dysku na Macu nie ma.
import { ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { cpus, freemem, homedir, totalmem } from "node:os";
import type { ListGroup, ListItem, Reading } from "./sensors";

const STALE_MS = 8000;

/** Fragment JSON-a z `macmon pipe` (pary = [MHz, użycie 0..1]). */
type MacmonSample = {
	temp?: { cpu_temp_avg?: number; gpu_temp_avg?: number };
	pcpu_usage?: unknown;
	ecpu_usage?: unknown;
	gpu_usage?: unknown;
	cpu_power?: number;
	gpu_power?: number;
	ane_power?: number;
	ram_power?: number;
	all_power?: number;
	sys_power?: number;
};

const find = (name: string) => [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/opt/local/bin/${name}`, `${homedir()}/.cargo/bin/${name}`, `${homedir()}/.local/bin/${name}`, `/usr/bin/${name}`].find((p) => existsSync(p));
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const pair = (x: unknown): [number, number] | undefined => (Array.isArray(x) && num(x[0]) !== undefined && num(x[1]) !== undefined ? [x[0], x[1]] : undefined);

let proc: ChildProcess | undefined;
let startedAt = 0;
let sample: { at: number; d: MacmonSample } | undefined;
let intelTimer: NodeJS.Timeout | undefined;
let tools: { macmon?: string; intel?: string } | undefined;

// Stream Deck uruchamia plugin bez PATH z Homebrew, więc narzędzia szukamy po znanych ścieżkach.
function toolPaths() {
	return (tools ??= { macmon: find("macmon"), intel: find("osx-cpu-temp") });
}

function ensure(): void {
	const t = toolPaths();
	if (t.macmon) {
		if (proc || Date.now() - startedAt < 10_000) return; // nie częściej niż co 10 s
		startedAt = Date.now();
		const p = spawn(t.macmon, ["pipe", "-i", "2000"], { stdio: ["ignore", "pipe", "ignore"] });
		proc = p;
		createInterface({ input: p.stdout! }).on("line", (line) => {
			try {
				sample = { at: Date.now(), d: JSON.parse(line) };
			} catch {
				/* ignoruj śmieci */
			}
		});
		const done = () => { if (proc === p) proc = undefined; };
		p.on("exit", done);
		p.on("error", done);
		process.on("exit", () => p.kill());
	} else if (t.intel && !intelTimer) {
		const poll = () => execFile(t.intel!, [], { timeout: 4000 }, (err, out) => {
			const v = parseFloat(/(-?\d+(?:[.,]\d+)?)\s*°?C/.exec(String(out))?.[1]?.replace(",", ".") ?? "");
			if (!err && v > 0 && v < 150) sample = { at: Date.now(), d: { temp: { cpu_temp_avg: v } } };
		});
		poll();
		intelTimer = setInterval(poll, 2000);
		intelTimer.unref();
	}
}

const fresh = () => {
	ensure();
	return sample && Date.now() - sample.at < STALE_MS ? sample.d : undefined;
};

/** "nomacmon" = brak macmon i osx-cpu-temp – klawisz pokazuje wtedy "Install macmon". */
export function macStatus(): "ok" | "nomacmon" | "unknown" {
	const t = toolPaths();
	if (!t.macmon && !t.intel) return "nomacmon";
	return fresh() ? "ok" : "unknown";
}

let prevCpu: { idle: number; total: number } | undefined;
let lastLoad: number | undefined;
function cpuLoad(): number | undefined {
	let idle = 0;
	let total = 0;
	for (const c of cpus()) {
		const t = c.times;
		idle += t.idle;
		total += t.user + t.nice + t.sys + t.idle + t.irq;
	}
	if (prevCpu && total > prevCpu.total) lastLoad = Math.max(0, Math.min(100, (1 - (idle - prevCpu.idle) / (total - prevCpu.total)) * 100));
	prevCpu = { idle, total };
	return lastLoad;
}

let chip: string | undefined;
function chipName(): string {
	if (chip === undefined) {
		try {
			chip = execFileSync("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"], { timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
		} catch {
			chip = "";
		}
	}
	return chip || "Mac";
}

const SRC = "macmon";

export function macCpu(): Reading | null {
	const d = fresh();
	const temp = num(d?.temp?.cpu_temp_avg);
	if (!d || temp === undefined || temp <= 0) return null;
	const p = pair(d.pcpu_usage);
	const e = pair(d.ecpu_usage);
	// taktowanie: rdzenie bardziej obciążone (P albo E)
	const clock = p && e ? (p[1] >= e[1] ? p[0] : e[0]) : (p ?? e)?.[0];
	return { temp, load: cpuLoad(), power: num(d.cpu_power), clock, name: chipName(), source: SRC };
}

export function macGpu(): Reading | null {
	const d = fresh();
	const temp = num(d?.temp?.gpu_temp_avg);
	if (!d || temp === undefined || temp <= 0) return null;
	const g = pair(d.gpu_usage);
	return { temp, load: g ? g[1] * 100 : undefined, power: num(d.gpu_power), clock: g?.[0], name: `${chipName()} GPU`, source: SRC };
}

export function macGpuList(): ListItem[] {
	return [{ value: "1", label: `${chipName()} GPU` }];
}

// RAM jak w Monitorze aktywności (pamięć aplikacji + przewodowa + skompresowana); os.freemem() na Macu zawyża zajętość.
let ramCache: { at: number; used: number } | undefined;
function usedBytes(): number {
	if (ramCache && Date.now() - ramCache.at < 1500) return ramCache.used;
	let used = totalmem() - freemem();
	try {
		const out = execFileSync("/usr/bin/vm_stat", [], { timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).toString();
		const page = Number(/page size of (\d+) bytes/.exec(out)?.[1]) || 16384;
		const get = (re: RegExp) => Number(re.exec(out)?.[1]);
		const anon = get(/Anonymous pages:\s+(\d+)/);
		const purg = get(/Pages purgeable:\s+(\d+)/) || 0;
		const wired = get(/Pages wired down:\s+(\d+)/);
		const comp = get(/Pages occupied by compressor:\s+(\d+)/) || 0;
		if (Number.isFinite(anon) && Number.isFinite(wired)) used = Math.max(0, anon - purg + wired + comp) * page;
	} catch {
		/* zostaje totalmem - freemem */
	}
	ramCache = { at: Date.now(), used };
	return used;
}

export function macRam(): Reading {
	const total = totalmem();
	const used = Math.min(total, usedBytes());
	return { temp: (used / total) * 100, name: `${(used / 1024 ** 3).toFixed(1)} / ${(total / 1024 ** 3).toFixed(0)} GB`, source: "os" };
}

// --- Custom Sensor: odczyty macmon do wyboru w panelu ---
const pct = (x: [number, number] | undefined) => (x ? x[1] * 100 : undefined);
const DEFS: Record<string, { group: string; label: string; unit: string; get: (d: MacmonSample) => number | undefined }> = {
	cpuTemp: { group: "Temperature", label: "CPU temperature", unit: "C", get: (d) => num(d.temp?.cpu_temp_avg) },
	gpuTemp: { group: "Temperature", label: "GPU temperature", unit: "C", get: (d) => num(d.temp?.gpu_temp_avg) },
	cpuPower: { group: "Power", label: "CPU power", unit: "W", get: (d) => num(d.cpu_power) },
	gpuPower: { group: "Power", label: "GPU power", unit: "W", get: (d) => num(d.gpu_power) },
	anePower: { group: "Power", label: "Neural Engine power", unit: "W", get: (d) => num(d.ane_power) },
	ramPower: { group: "Power", label: "RAM power", unit: "W", get: (d) => num(d.ram_power) },
	allPower: { group: "Power", label: "Chip total power", unit: "W", get: (d) => num(d.all_power) },
	sysPower: { group: "Power", label: "System power", unit: "W", get: (d) => num(d.sys_power) },
	pClock: { group: "Clocks", label: "Performance cores clock", unit: "MHz", get: (d) => pair(d.pcpu_usage)?.[0] },
	eClock: { group: "Clocks", label: "Efficiency cores clock", unit: "MHz", get: (d) => pair(d.ecpu_usage)?.[0] },
	gpuClock: { group: "Clocks", label: "GPU clock", unit: "MHz", get: (d) => pair(d.gpu_usage)?.[0] },
	pUsage: { group: "Usage", label: "Performance cores usage", unit: "%", get: (d) => pct(pair(d.pcpu_usage)) },
	eUsage: { group: "Usage", label: "Efficiency cores usage", unit: "%", get: (d) => pct(pair(d.ecpu_usage)) },
	gpuUsage: { group: "Usage", label: "GPU usage", unit: "%", get: (d) => pct(pair(d.gpu_usage)) },
};
const GROUPS = ["Temperature", "Power", "Clocks", "Usage"];

export function macListSensors(): ListGroup[] {
	const d = fresh();
	if (!d) return [];
	return GROUPS.map((g) => ({
		label: g,
		children: Object.entries(DEFS)
			.filter(([, def]) => def.group === g && def.get(d) !== undefined)
			.map(([value, def]) => ({ value, label: `${def.label} (${def.unit === "C" ? "°C" : def.unit})` })),
	})).filter((g) => g.children.length);
}

export function macSensor(id: string): Reading | null {
	const d = fresh();
	const def = DEFS[id];
	const v = d && def ? def.get(d) : undefined;
	return def && v !== undefined ? { temp: v, unit: def.unit, name: def.label, model: def.group, source: SRC } : null;
}
