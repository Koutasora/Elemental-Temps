import streamDeck, { action, KeyAction, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from "@elgato/streamdeck";
import { spawn } from "node:child_process";
import { readCpu, readGpu, Reading, shmStatus } from "./sensors";
import { ChartType, renderKey, toDataUri } from "./render";

type Settings = {
	sensor?: "cpu" | "gpu";
	gpuIndex?: number | string;
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
	keyAction?: "refresh" | "sensor" | "chart";
};

type Entry = { action: KeyAction<Settings>; settings: Settings; alerting: boolean };

const DEFAULTS = {
	cpu: { warn: 70, crit: 85 },
	gpu: { warn: 70, crit: 83 },
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
/** klucz odczytu: "cpu" albo "gpu0", "gpu1"... */
const keyOf = (s: Settings) => (sensorOf(s) === "gpu" ? `gpu${gpuIndexOf(s)}` : "cpu");
const thresholds = (s: Settings) => {
	const def = DEFAULTS[sensorOf(s)];
	return { warn: Number(s.warn) || def.warn, crit: Number(s.crit) || def.crit };
};

function subText(r: Reading, s: Settings): string | undefined {
	const parts: string[] = [];
	if (s.showLoad !== false && r.load !== undefined) parts.push(`${Math.round(r.load)}%`);
	if (s.showPower === true && r.power !== undefined) parts.push(`${Math.round(r.power)} W`);
	if (s.showClock === true && r.clock !== undefined) parts.push(r.clock >= 1000 ? `${(r.clock / 1000).toFixed(1)} GHz` : `${Math.round(r.clock)} MHz`);
	return parts.length ? parts.join(" · ") : undefined;
}

/** Komunikat dwujęzyczny (PL / EN), gdy nie ma danych. */
function noDataText(sensor: "cpu" | "gpu"): string {
	switch (shmStatus()) {
		case "notrunning":
			return "Uruchom / Start\nHWiNFO";
		case "disabled":
			return "Włącz / Enable\nHWiNFO Shared Memory";
		default:
			return sensor === "cpu" ? "brak danych / no data" : "brak GPU / no GPU";
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
	const svg = renderKey({
		label: sensor === "gpu" && idx > 0 ? `GPU ${idx + 1}` : sensor.toUpperCase(),
		temp: r?.temp ?? null,
		unit: s.unit ?? "C",
		showLabel: s.showLabel !== false,
		bgColor: s.bgMode === "black" ? "#000000" : s.bgMode === "custom" ? (s.bgColor ?? "#1e3a8a") : null,
		alertFlash: e.alerting && flashPhase,
		chart: s.chart ?? "gauge",
		customColor: s.colorMode === "custom" ? (s.color ?? "#38bdf8") : null,
		history: history.get(k) ?? [],
		warn,
		crit,
		sub: r ? subText(r, s) : noDataText(sensor),
	});
	await e.action.setImage(toDataUri(svg));
}

async function tick(): Promise<void> {
	const keys = new Set([...visible.values()].map((e) => keyOf(e.settings)));
	await Promise.all(
		[...keys].map(async (k) => {
			const r = k === "cpu" ? await readCpu() : await readGpu(Number(k.slice(3)));
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

@action({ UUID: "com.rafal.systemtemps.temperature" })
class Temperature extends SingletonAction<Settings> {
	override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, { action: ev.action, settings: ev.payload.settings, alerting: false });
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
		if (e) e.settings = ev.payload.settings;
		await tick();
	}

	override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
		const s = ev.payload.settings;
		streamDeck.logger.info(`keyDown: akcja=${s.keyAction ?? "refresh"} czujnik=${sensorOf(s)} wykres=${s.chart ?? "gauge"}`);
		let next: Settings | undefined;
		if (s.keyAction === "sensor") next = { ...s, sensor: sensorOf(s) === "cpu" ? "gpu" : "cpu" };
		else if (s.keyAction === "chart") next = { ...s, chart: CHARTS[(CHARTS.indexOf(s.chart ?? "gauge") + 1) % CHARTS.length] };
		if (next) {
			// stan lokalny aktualizujemy od razu – nie czekamy na didReceiveSettings
			const e = visible.get(ev.action.id);
			if (e) e.settings = next;
			await ev.action.setSettings(next);
		}
		await tick(); // zawsze też odśwież odczyt
	}
}

streamDeck.actions.registerAction(new Temperature());
void streamDeck.connect();
