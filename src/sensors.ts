import { execFile, spawn, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { freemem, totalmem } from "node:os";

const run = promisify(execFile);

/** `temp` to główna wartość odczytu: °C dla CPU/GPU/dysku, % dla RAM. `name` – krótka nazwa (np. litera dysku). */
export type Reading = { temp: number; unit?: string; load?: number; power?: number; clock?: number; name?: string; model?: string; source: string };

export type ListItem = { label: string; value: string };
export type ListGroup = { label: string; children: ListItem[] };

/** Lista dysków do wyboru w panelu: "C: · WD_BLACK SN770 500GB", wartość = numer (od 1). */
export function listDisks(): ListItem[] {
	ensureShm();
	return [...shmLast.disks.entries()].sort((a, b) => a[0] - b[0]).map(([i, r]) => ({ value: String(i + 1), label: [r.name, r.model].filter(Boolean).join(" · ") || `Disk ${i + 1}` }));
}

/** Lista kart graficznych do wyboru w panelu, wartość = numer (od 1). */
export function listGpus(): ListItem[] {
	ensureShm();
	return [...shmLast.gpus.entries()].sort((a, b) => a[0] - b[0]).map(([i, r]) => ({ value: String(i + 1), label: r.name || `GPU ${i + 1}` }));
}

/** Rodzaj urządzenia po nazwie grupy czujników HWiNFO (typ 3 = wentylator ma własną kategorię). */
function categoryOf(group: string, type: number): string {
	if (type === 3) return "Fans";
	if (/^GPU \[#\d+\]/.test(group)) return /radeon\(tm\) graphics|radeon graphics|\bvega\b.*graphics|intel.*(uhd|iris|hd graphics)|\bapu\b/i.test(group) ? "APU / iGPU" : "GPU";
	if (/^(CPU|Core|Intel Core|AMD Ryzen)\b/i.test(group) || /\b(Ryzen|Core i\d|Xeon|Threadripper)\b/i.test(group)) return "CPU";
	if (/^S\.M\.A\.R\.T\.|^Drive:|NVMe|\bSSD\b/i.test(group)) return "Disks";
	if (/DIMM|^Memory/i.test(group)) return "Memory";
	if (/^Network|Ethernet|Wi-?Fi/i.test(group)) return "Network";
	return "Motherboard & other";
}
const CATEGORY_ORDER = ["Motherboard & other", "CPU", "GPU", "APU / iGPU", "Disks", "Fans", "Memory", "Network"];

/** Wszystkie odczyty HWiNFO do wyboru w Custom Sensor, pogrupowane na płytę, CPU, GPU, APU, dyski i wentylatory. Klucz = "grupa|etykieta|typ". */
export function listSensors(): ListGroup[] {
	ensureShm();
	const groups = new Map<string, ListItem[]>();
	for (const [value, r] of shmLast.temps) {
		const type = Number(value.slice(value.lastIndexOf("|") + 1));
		const cat = categoryOf(r.model ?? "", type);
		const unit = r.unit === "C" ? "°C" : r.unit;
		const item = { value, label: `${r.name} (${unit}) · ${(r.model ?? "").replace(/^[A-Za-z. ]+\[#\d+\]: /, "")}` };
		groups.set(cat, [...(groups.get(cat) ?? []), item]);
	}
	return CATEGORY_ORDER.filter((c) => groups.has(c)).map((label) => ({ label, children: groups.get(label)!.sort((a, b) => a.label.localeCompare(b.label)) }));
}

/** Dowolny wybrany czujnik temperatury z HWiNFO. */
export async function readSensor(id: string): Promise<Reading | null> {
	ensureShm();
	return Date.now() - shmLast.at < 8000 ? (shmLast.temps.get(id) ?? null) : null;
}

/** Dysk (SMART "Drive Temperature") z HWiNFO – w kolejności czujników S.M.A.R.T. */
export async function readDisk(index = 0): Promise<Reading | null> {
	ensureShm();
	return Date.now() - shmLast.at < 8000 ? (shmLast.disks.get(index) ?? null) : null;
}

/** RAM: zajętość w % (`temp`) prosto z systemu, bez HWiNFO; `name` = "użyte / razem GB". */
export function readRam(): Reading {
	const total = totalmem();
	const used = total - freemem();
	return { temp: (used / total) * 100, name: `${(used / 1024 ** 3).toFixed(1)} / ${(total / 1024 ** 3).toFixed(0)} GB`, source: "os" };
}

/** GPU: HWiNFO pamięć współdzielona (każda karta osobno, po nazwie czujnika "GPU [#N]"). */
export async function readGpu(index = 0): Promise<Reading | null> {
	ensureShm();
	return Date.now() - shmLast.at < 8000 ? (shmLast.gpus.get(index) ?? null) : null;
}

/** CPU: HWiNFO pamięć współdzielona -> HWiNFO rejestr ("Report value in Gadget") -> LibreHardwareMonitor (HTTP). */
export async function readCpu(): Promise<Reading | null> {
	return readCpuShm() ?? (await readCpuHwinfo()) ?? (await readCpuLhm());
}

// --- HWiNFO shared memory: jeden długo działający proces PowerShell, jedna linia JSON na 2 s ---
let shmProc: ChildProcess | undefined;
export type ShmStatus = "ok" | "notrunning" | "disabled" | "unknown";
let shmLast: { cpu: Reading | null; gpus: Map<number, Reading>; disks: Map<number, Reading>; temps: Map<string, Reading>; status: ShmStatus; at: number } = { cpu: null, gpus: new Map(), disks: new Map(), temps: new Map(), status: "unknown", at: 0 };
let shmStartedAt = 0;

function ensureShm(): void {
	if (shmProc || Date.now() - shmStartedAt < 10_000) return; // nie częściej niż co 10 s
	shmStartedAt = Date.now();
	const script = join(dirname(fileURLToPath(import.meta.url)), "hwinfo-shm.ps1");
	const proc = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-ParentPid", String(process.pid)], {
		windowsHide: true,
		stdio: ["ignore", "pipe", "ignore"],
	});
	shmProc = proc;
	createInterface({ input: proc.stdout! }).on("line", (line) => {
		try {
			const j = JSON.parse(line) as { status?: ShmStatus; cpu?: Omit<Reading, "source">; gpu?: Record<string, Omit<Reading, "source">>; disk?: Record<string, Omit<Reading, "source">>; sens?: { g: string; l: string; v: number; u: string; t: number }[] };
			const src = "HWiNFO: pamięć współdzielona";
			shmLast = { at: Date.now(), status: j.status ?? "unknown", cpu: j.cpu ? { ...j.cpu, source: src } : null, gpus: new Map(Object.entries(j.gpu ?? {}).map(([n, r]) => [Number(n), { ...r, source: src }])), disks: new Map(Object.entries(j.disk ?? {}).map(([n, r]) => [Number(n), { ...r, source: src }])), temps: new Map((j.sens ?? []).map((t) => [`${t.g}|${t.l}|${t.t}`, { temp: t.v, unit: t.u, name: t.l, model: t.g, source: src }])) };
		} catch {
			/* ignoruj śmieci */
		}
	});
	const done = () => { if (shmProc === proc) shmProc = undefined; };
	proc.on("exit", done);
	proc.on("error", done);
	process.on("exit", () => proc.kill());
}

function readCpuShm(): Reading | null {
	ensureShm();
	return Date.now() - shmLast.at < 8000 ? shmLast.cpu : null;
}

/** Stan źródła HWiNFO – do komunikatu na klawiszu, gdy brak danych. */
export function shmStatus(): ShmStatus {
	return Date.now() - shmLast.at < 8000 ? shmLast.status : "unknown";
}

const CPU_PREFERENCE = [/cpu package/i, /tctl|tdie/i, /cpu.*(temp|\(tctl)/i, /^cpu/i];

async function readCpuHwinfo(): Promise<Reading | null> {
	try {
		const { stdout } = await run("reg", ["query", "HKCU\\SOFTWARE\\HWiNFO64\\VSB"], { timeout: 3000, windowsHide: true });
		const labels = new Map<string, string>();
		const raws = new Map<string, string>();
		for (const line of stdout.split(/\r?\n/)) {
			const m = line.match(/^\s+(Label|ValueRaw)(\d+)\s+REG_SZ\s+(.*)$/);
			if (!m) continue;
			(m[1] === "Label" ? labels : raws).set(m[2], m[3].trim());
		}
		const candidates = [...labels].filter(([, l]) => /cpu|tctl|tdie|core/i.test(l) && !/clock|usage|power|volt|fan/i.test(l));
		for (const re of CPU_PREFERENCE) {
			for (const [id, label] of candidates) {
				const v = parseFloat(raws.get(id) ?? "");
				if (re.test(label) && v > 0 && v < 150) return { temp: v, ...extras(labels, raws), source: `HWiNFO: ${label}` };
			}
		}
	} catch {
		/* brak klucza = HWiNFO nie raportuje do rejestru */
	}
	return null;
}

/** Opcjonalne: obciążenie i moc CPU, jeśli HWiNFO je raportuje do rejestru. */
function extras(labels: Map<string, string>, raws: Map<string, string>): { load?: number; power?: number; clock?: number } {
	const find = (re: RegExp) => {
		for (const [id, l] of labels) if (re.test(l)) { const v = parseFloat(raws.get(id) ?? ""); if (Number.isFinite(v)) return v; }
		return undefined;
	};
	let clock = find(/average effective clock|core clocks.*avg|avg.*core clock/i);
	if (clock === undefined) {
		const cores = [...labels].filter(([, l]) => /^(p-core|e-core)?s*core d+.*clock/i.test(l)).map(([id]) => parseFloat(raws.get(id) ?? "")).filter((v) => v > 0);
		if (cores.length) clock = cores.reduce((a, b) => a + b, 0) / cores.length;
	}
	return { load: find(/total cpu usage/i), power: find(/cpu package power/i), clock };
}

type LhmNode = { Text: string; Value?: string; Children?: LhmNode[] };

async function readCpuLhm(): Promise<Reading | null> {
	try {
		const res = await fetch("http://localhost:8085/data.json", { signal: AbortSignal.timeout(1500) });
		const root = (await res.json()) as LhmNode;
		const temps: { name: string; v: number }[] = [];
		const walk = (n: LhmNode, inCpu: boolean) => {
			const cpu = inCpu || /intel|amd|ryzen|core i\d|cpu/i.test(n.Text);
			if (cpu && n.Value?.includes("°C")) temps.push({ name: n.Text, v: parseFloat(n.Value.replace(",", ".")) });
			n.Children?.forEach((c) => walk(c, cpu));
		};
		walk(root, false);
		for (const re of CPU_PREFERENCE) {
			const hit = temps.find((t) => re.test(t.name));
			if (hit) return { temp: hit.v, source: `LHM: ${hit.name}` };
		}
		return temps.length ? { temp: Math.max(...temps.map((t) => t.v)), source: "LHM" } : null;
	} catch {
		return null;
	}
}
