# Elemental Temps – Stream Deck plugin

CPU and GPU temperature on Stream Deck keys, with a circular gauge, bar, history graph or a big number. Optional load, power draw and clock speed. Flashes red when a temperature gets critical.

Wtyczka Stream Deck pokazująca temperaturę CPU i GPU na klawiszach: wskaźnik kołowy, pasek, wykres historii albo sama liczba. Opcjonalnie obciążenie, pobór mocy i taktowanie. Przy temperaturze krytycznej klawisz miga na czerwono.

![Elemental Temps keys](docs/showcase.png)

*Example keys with sample values: gauge, bar, history graph, big number, critical alarm, custom colors and background, and the message shown when HWiNFO Shared Memory is off.*

## Requirements / Wymagania

- Windows 10/11, Stream Deck software **7.1+**
- [HWiNFO](https://www.hwinfo.com/) (free is enough), running in *Sensors* mode

## Setup / Konfiguracja (once / jednorazowo)

1. **EN:** In HWiNFO open *Settings* and enable **Shared Memory Support**.
   **PL:** W HWiNFO otwórz *Ustawienia* i włącz **Obsługę pamięci współdzielonej**.
2. Install `com.elemental.temps.streamDeckPlugin` (double-click / dwuklik).
3. Drag one of **CPU Temperature**, **GPU Temperature**, **Disk Temperature** or **RAM Usage** (category **Elemental Temps**) onto a key. Each has its own settings; disk and GPU let you pick the exact drive / card from a list.

> The free version of HWiNFO switches Shared Memory off after about 12 hours. When that happens the key shows **Enable HWiNFO Shared Memory** – just enable it again, the data comes back by itself.
> Darmowa wersja HWiNFO wyłącza pamięć współdzieloną po ok. 12 godzinach. Klawisz pokaże wtedy **Enable HWiNFO Shared Memory** – wystarczy włączyć ją ponownie.

Key messages: **Enable HWiNFO Shared Memory** – option is off or expired · **Start HWiNFO** – HWiNFO is not running · **No data / No GPU** – HWiNFO is running, but no matching sensor was found.

## Options

Sensor name on/off, language of the settings panel (English / Polski), chart type, temperature colour (automatic by thresholds or custom), background (default / black / custom), load / power / clock line, °C / °F, warning and critical thresholds, flashing alarm with optional sound, and what a key press does (refresh, switch CPU/GPU, switch chart).

## Supported hardware / Sprzęt

Sensors are matched by HWiNFO label, with priority lists for Intel (`CPU Package`), AMD (`CPU (Tctl/Tdie)`, `CPU PPT`) and NVIDIA / AMD / Intel GPUs (`GPU [#N]` sensors). Only the author's machine (Intel Core i5-13400F + NVIDIA RTX 4070 SUPER) has been tested; AMD and multi-GPU paths are untested. If a key shows *No data* while HWiNFO shows the sensor, the label probably differs – see `bin/hwinfo-shm.ps1` (`$rules`).

## Development

```
npm install
npm run deploy      # build + restart the plugin (Stream Deck restarts it by itself)
npm run typecheck
npx streamdeck pack com.elemental.temps.sdPlugin --output dist --force
```

- `src/sensors.ts` – readers (HWiNFO shared memory via a long-running PowerShell process, registry and LibreHardwareMonitor fallbacks for CPU)
- `src/render.ts` – SVG key rendering
- `src/plugin.ts` – four actions (cpu, gpu, disk, ram), polling, alarm
- `pi/template.html` + `scripts/gen-pi.mjs` – settings page template; the build generates one page per component (`ui/cpu.html`, ...)
- `bin/hwinfo-shm.ps1` – shared memory reader

Idea for later: an own helper based on LibreHardwareMonitorLib (admin, kernel driver) to drop the HWiNFO dependency.

## License

MIT – see [LICENSE](LICENSE). Third-party components bundled with the plugin and their licenses are listed in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
