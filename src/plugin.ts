import streamDeck, { action, KeyAction, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from "@elgato/streamdeck";
import { connection } from "sd-connection";
import { spawn } from "node:child_process";
import { ListItem, listDisks, listGpus, listSensors, readCpu, readDisk, readGpu, readRam, readSensor, Reading, shmStatus } from "./sensors";
import { ChartType, renderKey, toDataUri } from "./render";

type Sensor = "cpu" | "gpu" | "disk" | "ram" | "sensor";

type Settings = {
	sensor?: Sensor;
	gpuIndex?: number | string;
	diskIndex?: number | string;
	sensorId?: string;
	sensorName?: string;
	unit?: "C" | "F";
	chart?: ChartType;
	showLoad?: boolean;
	showPower?: boolean;
	showClock?: boolean;
	showLabel?: boolean;
	bgMode?: "default" | "black" | "custom";
	bgColor?: string;
	colorMode?: "auto" | "custom";
	color?: string;
	warn?: number | string;
	crit?: number | string;
	alertFlash?: boolean;
	alertSound?: boolean;
	keyAction?: "refresh" | "chart";
};

type Entry = { action: KeyAction<Settings>; settings: Settings; alerting: boolean };

/** progi domyślne i zakres skali wskaźnika dla każdego rodzaju czujnika */
const DEFAULTS: Record<Sensor, { warn: number; crit: number; min: number; max: number; kind: "temp" | "percent" }> = {
	cpu: { warn: 70, crit: 85, min: 20, max: 100, kind: "temp" },
	gpu: { warn: 70, crit: 83, min: 20, max: 100, kind: "temp" },
	disk: { warn: 50, crit: 65, min: 20, max: 80, kind: "temp" },
	ram: { warn: 80, crit: 92, min: 0, max: 100, kind: "percent" },
	sensor: { warn: 40, crit: 50, min: 15, max: 60, kind: "temp" },
};
const POLL_MS = 2000;
const FLASH_MS = 600;
const HISTORY_LEN = 30;
const CHARTS: ChartType[] = ["gauge", "bar", "line", "number"];

const history = new Map<string, number[]>();
const last = new Map<string, Reading | null>();
const visible = new Map<string, Entry>();
let timer: NodeJS.Timeout | undefined;
let flashTimer: NodeJS.Timeout | undefined;
let flashPhase = false;
let lastSound = 0;

const sensorOf = (s: Settings) => s.sensor ?? "cpu";
const gpuIndexOf = (s: Settings) => Math.max(0, (Number(s.gpuIndex) || 1) - 1);
const diskIndexOf = (s: Settings) => Math.max(0, (Number(s.diskIndex) || 1) - 1);
/** klucz odczytu: "cpu", "ram", "gpu0", "gpu1", "disk0"... */
const keyOf = (s: Settings) => {
	const sensor = sensorOf(s);
	return sensor === "gpu" ? `gpu${gpuIndexOf(s)}` : sensor === "disk" ? `disk${diskIndexOf(s)}` : sensor === "sensor" ? `sensor:${s.sensorId ?? ""}` : sensor;
};
const thresholds = (s: Settings) => {
	const def = DEFAULTS[sensorOf(s)];
	return { warn: Number(s.warn) || def.warn, crit: Number(s.crit) || def.crit };
};

function subText(r: Reading, s: Settings): string | undefined {
	if (sensorOf(s) === "ram") return r.name; // np. "18.2 / 32 GB"
	if (sensorOf(s) === "disk" || sensorOf(s) === "sensor") return undefined;
	const parts: string[] = [];
	if (s.showLoad !== false && r.load !== undefined) parts.push(`${Math.round(r.load)}%`);
	if (s.showPower === true && r.power !== undefined) parts.push(`${Math.round(r.power)} W`);
	if (s.showClock === true && r.clock !== undefined) parts.push(r.clock >= 1000 ? `${(r.clock / 1000).toFixed(1)} GHz` : `${Math.round(r.clock)} MHz`);
	return parts.length ? parts.join(" · ") : undefined;
}

/** Komunikat dwujęzyczny (PL / EN), gdy nie ma danych. */
function noDataText(sensor: Sensor): string {
	switch (shmStatus()) {
		case "notrunning":
			return "Start\nHWiNFO";
		case "disabled":
			return "Enable\nHWiNFO\nShared Memory";
		default:
			return sensor === "gpu" ? "No GPU" : sensor === "disk" ? "No disk" : sensor === "sensor" ? "No\nsensor" : "No data";
	}
}

function beep(): void {
	if (Date.now() - lastSound < 30_000) return; // nie częściej niż co 30 s
	lastSound = Date.now();
	spawn("powershell", ["-NoProfile", "-Command", "[System.Media.SystemSounds]::Hand.Play(); Start-Sleep -Milliseconds 1500"], { windowsHide: true, stdio: "ignore" });
}

/** Aktualizuje stan alarmu (z histerezą 2 °C) i zwraca, czy klawisz alarmuje. */
function updateAlert(e: Entry): boolean {
	const r = last.get(keyOf(e.settings)) ?? null;
	const { crit } = thresholds(e.settings);
	const enabled = e.settings.alertFlash !== false;
	const was = e.alerting;
	if (!r || !enabled) e.alerting = false;
	else if (r.temp >= crit) e.alerting = true;
	else if (r.temp < crit - 2) e.alerting = false;
	if (e.alerting && !was && e.settings.alertSound === true) beep();
	return e.alerting;
}

async function draw(id: string): Promise<void> {
	const e = visible.get(id);
	if (!e) return;
	const s = e.settings;
	const sensor = sensorOf(s);
	const k = keyOf(s);
	const r = last.get(k) ?? null;
	const { warn, crit } = thresholds(s);
	const idx = gpuIndexOf(s);
	const meta = DEFAULTS[sensor];
	const label = sensor === "gpu" ? (idx > 0 ? `GPU ${idx + 1}` : "GPU") : sensor === "disk" ? `DISK ${(r?.name ?? String(diskIndexOf(s) + 1)).slice(0, 8)}` : sensor === "sensor" ? (s.sensorName?.trim() || r?.name || "SENSOR").slice(0, 8).toUpperCase() : sensor.toUpperCase();
	const svg = renderKey({
		label,
		temp: r?.temp ?? null,
		unit: s.unit ?? "C",
		kind: meta.kind,
		min: meta.min,
		max: meta.max,
		showLabel: s.showLabel !== false,
		bgColor: s.bgMode === "black" ? "#000000" : s.bgMode === "custom" ? (s.bgColor ?? "#1e3a8a") : null,
		alertFlash: e.alerting && flashPhase,
		chart: s.chart ?? "gauge",
		customColor: s.colorMode === "custom" ? (s.color ?? "#38bdf8") : null,
		history: history.get(k) ?? [],
		warn,
		crit,
		sub: r ? subText(r, s) : undefined,
		message: r ? undefined : noDataText(sensor),
	});
	await e.action.setImage(toDataUri(svg));
}

async function tick(): Promise<void> {
	const keys = new Set([...visible.values()].map((e) => keyOf(e.settings)));
	await Promise.all(
		[...keys].map(async (k) => {
			const r = k === "cpu" ? await readCpu() : k === "ram" ? readRam() : k.startsWith("sensor:") ? await readSensor(k.slice(7)) : k.startsWith("disk") ? await readDisk(Number(k.slice(4))) : await readGpu(Number(k.slice(3)));
			last.set(k, r);
			if (r) history.set(k, [...(history.get(k) ?? []), r.temp].slice(-HISTORY_LEN));
		}),
	);
	for (const e of visible.values()) updateAlert(e);
	ensureTimers();
	await Promise.all([...visible.keys()].map(draw));
}

function ensureTimers(): void {
	if (visible.size && !timer) timer = setInterval(() => void tick(), POLL_MS);
	if (!visible.size && timer) {
		clearInterval(timer);
		timer = undefined;
	}
	// miganie tylko gdy jakiś klawisz alarmuje
	const anyAlert = [...visible.values()].some((e) => e.alerting);
	if (anyAlert && !flashTimer) {
		flashTimer = setInterval(() => {
			flashPhase = !flashPhase;
			for (const [id, e] of visible) if (e.alerting) void draw(id);
		}, FLASH_MS);
	}
	if (!anyAlert && flashTimer) {
		clearInterval(flashTimer);
		flashTimer = undefined;
		flashPhase = false;
	}
}

/** Czujnik wynika z akcji (UUID kończy się na .cpu / .gpu / .disk / .ram / .sensor), a nie z ustawień klawisza. */
const withSensor = (s: Settings, manifestId: string): Settings => ({ ...s, sensor: manifestId.split(".").pop() as Sensor });

class Temperature extends SingletonAction<Settings> {
	override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, { action: ev.action, settings: withSensor(ev.payload.settings, ev.action.manifestId), alerting: false });
		ensureTimers();
		await draw(ev.action.id);
		void tick();
	}

	override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
		visible.delete(ev.action.id);
		ensureTimers();
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> {
		const e = visible.get(ev.action.id);
		if (e) e.settings = withSensor(ev.payload.settings, ev.action.manifestId);
		await tick();
	}

	override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
		const s = ev.payload.settings;
		streamDeck.logger.info(`keyDown: ${ev.action.manifestId} akcja=${s.keyAction ?? "refresh"} wykres=${s.chart ?? "gauge"}`);
		if (s.keyAction === "chart") {
			const next: Settings = { ...s, chart: CHARTS[(CHARTS.indexOf(s.chart ?? "gauge") + 1) % CHARTS.length] };
			// stan lokalny aktualizujemy od razu – nie czekamy na didReceiveSettings
			const e = visible.get(ev.action.id);
			if (e) e.settings = withSensor(next, ev.action.manifestId);
			await ev.action.setSettings(next);
		}
		await tick(); // zawsze też odśwież odczyt
	}
}

@action({ UUID: "com.elemental.temps.cpu" })
class CpuTemperature extends Temperature {}
@action({ UUID: "com.elemental.temps.gpu" })
class GpuTemperature extends Temperature {}
@action({ UUID: "com.elemental.temps.disk" })
class DiskTemperature extends Temperature {}
@action({ UUID: "com.elemental.temps.ram" })
class RamUsage extends Temperature {}
@action({ UUID: "com.elemental.temps.sensor" })
class CustomSensor extends Temperature {}

for (const a of [new CpuTemperature(), new GpuTemperature(), new DiskTemperature(), new RamUsage(), new CustomSensor()]) streamDeck.actions.registerAction(a);

/** Listy do wyboru w panelu (sdpi-select z datasource): panel wysyła { event: "disks" | "gpus" }, odsyłamy { event, items }. */
const withFallback = (items: ListItem[], name: string): ListItem[] => (items.length ? items : [1, 2, 3, 4].map((n) => ({ value: String(n), label: `${name} ${n}` })));
/** Odpowiadamy prosto na kontekst akcji, która pytała: po przeładowaniu panelu (zmiana języka) streamDeck.ui gubi bieżącą akcję i odpowiedź by przepadła. */
streamDeck.ui.onSendToPlugin((ev) => {
	const event = (ev.payload as { event?: string } | null)?.event;
	const items = event === "disks" ? withFallback(listDisks(), "Disk") : event === "sensors" ? listSensors() : event === "gpus" ? withFallback(listGpus(), "GPU") : undefined;
	if (items) void connection.send({ event: "sendToPropertyInspector", context: ev.action.id, payload: { event, items } });
});

void streamDeck.connect();
