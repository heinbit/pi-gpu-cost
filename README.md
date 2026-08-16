# pi-gpu-cost

Track GPU power draw and estimated electricity cost for each pi session.

> ## ⚠️ Requirements — read this first
>
> **NVIDIA GPUs only.** This package samples power with `nvidia-smi`, so it
> requires **both**:
>
> 1. **An NVIDIA GPU** (AMD, Intel, and Apple Silicon are **not** supported —
>    there is no power-draw backend for them).
> 2. **`nvidia-smi` on your `PATH`.** It ships with the NVIDIA driver — install
>    or update your driver if you don't have it.
>
> Verify before installing:
>
> ```bash
> nvidia-smi --query-gpu=power.draw --format=csv,noheader,nounits
> # -> a number like "242.15" means you're good
> # -> "command not found" / an error means the driver (and nvidia-smi) is missing
> ```
>
> If `nvidia-smi` is unavailable, the extension loads but logs
> `gpu-cost: nvidia-smi not available — GPU cost tracking disabled` and shows
> no footer. It never crashes the session.

## What it does

Samples `nvidia-smi` every few seconds while a pi session is running, integrates
power over time into energy (Wh), and turns that into money using **your**
electricity rate.

- **Live footer status:** `⚡ 269W 97% · 14.2GB · 0.12 kWh · €0.03`
- **`/gpucost`** — current session (avg/peak watts, utilization, energy, cost),
  live GPU status (name, VRAM used/total, temperature), the processes using
  the GPU, and today's total across closed sessions
- **On quit:** summary notification + one JSON line per session in `log.jsonl`
  (avg/peak watts, peak temperature, energy, cost)

No data ever leaves your machine.

## Install

```bash
pi install npm:pi-gpu-cost          # npm (once published)
pi install git:github.com/heinbit/pi-gpu-cost   # git
pi install ./path/to/pi-gpu-cost    # local path
```

Then start (or `/reload` in) a pi session.

## Set your electricity rate (do this once)

The cost column is only as good as your rate. The built-in default is
**`$0.30/kWh`** — set your real price so the numbers mean something.

**1.** Create your config file in the data directory:

```bash
mkdir -p ~/.pi/gpu-cost
cp config.example.json ~/.pi/gpu-cost/config.json   # from the package folder, or just create it
```

**2.** Edit `~/.pi/gpu-cost/config.json` and set your rate:

```json
{
  "ratePerKwh": 0.282,
  "currency": "€",
  "intervalMs": 5000,
  "idleWatts": 0
}
```

`ratePerKwh` is the **price of one kilowatt-hour in your currency** — the same
number your electricity bill uses. Examples:

| You bill in… | `ratePerKwh` | `currency`          |
|--------------|--------------|---------------------|
| €0.282 / kWh (DE) | `0.282`      | `"€"` or `"EUR"`    |
| $0.16 / kWh (US)  | `0.16`       | `"$"` or `"USD"`    |
| £0.30 / kWh (UK)  | `0.30`       | `"GBP"`             |
| 28.2 ct / kWh     | `0.0282`     | `"€"`               |

Both work: ISO 4217 codes (`EUR`, `USD`, `GBP`, `JPY`, `PLN`, …) are
converted to their symbol; any other string (`"€"`, `"kr"`, `"fr"`) is
shown as-is.

That's it — costs update from the next session on (env overrides apply live).

### All config keys

| key          | default | meaning                                              |
|--------------|---------|------------------------------------------------------|
| `ratePerKwh` | `0.3`   | **electricity price per kWh** (your main setting)    |
| `currency`   | `"$"`   | ISO 4217 code (`"EUR"`, `"JPY"`, …) or any symbol (`"€"`, `"kr"`) |
| `intervalMs` | `5000`  | `nvidia-smi` sampling interval (min 50)               |
| `idleWatts`  | `0`     | idle baseline subtracted from draw (0 = no offset)    |

### Precedence & overrides

Config is resolved in this order (first hit wins):

1. Environment variables: `GPU_COST_RATE`, `GPU_COST_CURRENCY`,
   `GPU_COST_INTERVAL_MS`, `GPU_COST_IDLE_WATTS`
2. `~/.pi/gpu-cost/config.json` (your personal config, stable across updates)
3. `config.json` next to the extension (if shipped with the package)
4. Built-in defaults (`$0.30/kWh`)

`GPU_COST_DIR` moves the whole data directory (default `~/.pi/gpu-cost`).

### Notes

- **Energy** = ∫(power.draw − idleWatts) dt over the session. Failed `nvidia-smi`
  ticks extrapolate at the last known wattage for up to 30 s, so brief hiccups
  don't undercount.
- **Multi-GPU:** power and VRAM are summed across GPUs, utilization is the max.
- **`idleWatts`:** set it to your idle draw (e.g. `25`) if you only want the cost
  attributable to active work, not the baseline.

## Data

`log.jsonl` in the data directory holds one JSON line per closed session:

```json
{"sessionId":"…","startedAt":"…","endedAt":"…","durationMin":39.7,"samples":476,"failedSamples":0,"avgWatts":215.1,"peakWatts":271.9,"avgUtil":75,"energyWh":142.531,"cost":0.04019,"ratePerKwh":0.282,"reason":"quit"}
```

A legacy `log.jsonl` from older versions (stored next to the extension) is
migrated automatically on first use.

## Development

```bash
npm install
npm test         # unit + sampler lifecycle + real nvidia-smi smoke test (skipped if no GPU)
npm run typecheck
```

Tests use Node's built-in test runner with native TypeScript type stripping
(Node ≥ 22.18) — no test framework dependency.
