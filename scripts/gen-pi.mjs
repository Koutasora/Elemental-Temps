// Generuje osobne strony ustawień (ui/cpu.html, gpu.html, disk.html, ram.html) z pi/template.html.
// Bloki <sdpi-item data-for="cpu gpu"> trafiają tylko na wskazane strony; pozostałe są wspólne.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = fs.readFileSync(path.join(root, "pi", "template.html"), "utf8").replace(/\r\n/g, "\n");
const outDir = path.join(root, "com.elemental.temps.sdPlugin", "ui");

// jednostka progów i podpowiedzi (placeholdery) dla każdego podzespołu
const SENSORS = {
	cpu: { unit: "°C", warn: 70, crit: 85 },
	gpu: { unit: "°C", warn: 70, crit: 83 },
	disk: { unit: "°C", warn: 50, crit: 65 },
	ram: { unit: "%", warn: 80, crit: 92 },
};

const block = /[ \t]*<sdpi-item\b[^>]*\bdata-for="([^"]*)"[^>]*>[\s\S]*?<\/sdpi-item>\n?/g;

for (const [sensor, meta] of Object.entries(SENSORS)) {
	let html = template.replace(block, (match, targets) => (targets.split(/\s+/).includes(sensor) ? match : ""));
	html = html
		.replace(/ data-for="[^"]*"/g, "")
		.replaceAll("@UNIT@", meta.unit)
		.replaceAll("@WARN@", String(meta.warn))
		.replaceAll("@CRIT@", String(meta.crit));
	fs.writeFileSync(path.join(outDir, `${sensor}.html`), html);
}
console.log("PI pages generated:", Object.keys(SENSORS).join(", "));
