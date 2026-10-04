import { execFile, spawn, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Reading = { temp: number; load?: number; power?: number; clock?: number; source: string };

/** GPU NVIDIA przez nvidia-smi (instalowane ze sterownikiem). */
export async function readGpu(index = 0): Promise<Reading | null> {
	// HWiNFO zwraca tylko pierwszą kartę, więc jako zapas służy wyłącznie dla indeksu 0
	return (await readGpuNvidia(index)) ?? (index === 0 ? readShm("gpu") : null);
}

async function readGpuNvidia(index: number): Promise<Reading | null> {
	try {
		const { stdout } = await run(
			"nvidia-smi",
			["-i", String(index), "--query-gpu=temperature.gpu,utilization.gpu,power.draw,clocks.gr", "--format=csv,noheader,nounits"],
			{ timeout: 3000, windowsHide: true },
		);
		const [t, l, p, c] = stdout.trim().split(/\r?\n/)[0].split(",").map((s) => parseFloat(s));
		return Number.isFinite(t)
			? { temp: t, load: Number.isFinite(l) ? l : undefined, power: Number.isFinite(p) ? p : undefined, clock: Number.isFinite(c) ? c : undefined, source: "nvidia-smi" }
			: null;
	} catch {
		return null;
	}
}

/** CPU: HWiNFO pamięć współdzielona -> HWiNFO rejestr ("Report value in Gadget") -> LibreHardwareMonitor (HTTP). */
export async function readCpu(): Promise<Reading | null> {
	return readCpuShm() ?? (await readCpuHwinfo()) ?? (await readCpuLhm());
}

// --- HWiNFO shared memory: jeden długo działający proces PowerShell, jedna linia JSON na 2 s ---
let shmProc: ChildProcess | undefined;
export type ShmStatus = "ok" | "notrunning" | "disabled" | "unknown";
let shmLast: { cpu: Reading | null; gpu: Reading | null; status: ShmStatus; at: number } = { cpu: null, gpu: null, status: "unknown", at: 0 };
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
			const j = JSON.parse(line) as { status?: ShmStatus; cpu?: Omit<Reading, "source">; gpu?: Omit<Reading, "source"> };
			const src = "HWiNFO: pamięć współdzielona";
			shmLast = { at: Date.now(), status: j.status ?? "unknown", cpu: j.cpu ? { ...j.cpu, source: src } : null, gpu: j.gpu ? { ...j.gpu, source: src } : null };
		} catch {
			/* ignoruj śmieci */
		}
	});
	const done = () => { if (shmProc === proc) shmProc = undefined; };
	proc.on("exit", done);
	proc.on("error", done);
	process.on("exit", () => proc.kill());
}

function readShm(kind: "cpu" | "gpu"): Reading | null {
	ensureShm();
	return Date.now() - shmLast.at < 8000 ? shmLast[kind] : null;
}
const readCpuShm = () => readShm("cpu");

/** Stan źródła HWiNFO – do komunikatu na klawiszu, gdy brak danych. */
export function shmStatus(): ShmStatus {
	return Date.now() - shmLast.at < 8000 ? shmLast.status : "unknown";
}

const CPU_PREFERENCE = [/cpu package/i, /tctl|tdie/i, /cpu.*(temp|\(tctl)/i, /^cpu/i];

async function readCpuHwinfo(): Promise<Reading | null> {
	try {
		const { stdout } = await run("reg", ["query", "HKCU\SOFTWARE\HWiNFO64\VSB"], { timeout: 3000, windowsHide: true });
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
