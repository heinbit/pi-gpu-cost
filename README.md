# pi-gpu-cost

Track GPU power draw and estimated electricity cost for each pi session.

Samples `nvidia-smi` every few seconds while a pi session is running, integrates
power over time into energy (Wh), and turns that into money using your electricity
rate.

- **Live footer status:** `⚡ 269W 97% · 0.12 kWh · €0.03`
- **`/gpucost`** — current session (avg/peak watts, utilization, energy, cost) + today's total across closed sessions
- **On quit:** summary notification + one JSON line per session in `log.jsonl`

## Install

```bash
pi install npm:pi-gpu-cost          # npm (once published)
pi install git:github.com/YOU/pi-gpu-cost   # git
pi install ./path/to/pi-gpu-cost    # local path
```

Requires an NVIDIA GPU with a working `nvidia-smi` on `PATH`. No data ever
leaves your machine.

## Configuration

Config is looked up in this order (first hit wins):

1. Environment variables (see below)
2. `~/.pi/gpu-cost/config.json` — your personal config, stable across package updates
3. `config.json` next to the extension (shipped with the package if present)
4. Built-in defaults: `$0.30/kWh`

Copy the example and put it in `~/.pi/gpu-cost/`:

```bash
mkdir -p ~/.pi/gpu-cost && cp config.example.json ~/.pi/gpu-cost/config.json
```

| key          | default | meaning                                              |
|--------------|---------|------------------------------------------------------|
| `ratePerKwh` | `0.3`   | electricity price per kWh                             |
| `currency`   | `"$"`   | currency symbol                                       |
| `intervalMs` | `5000`  | `nvidia-smi` sampling interval (min 50)               |
| `idleWatts`  | `0`     | idle baseline subtracted from draw (0 = no offset)    |

Environment overrides: `GPU_COST_RATE`, `GPU_COST_CURRENCY`,
`GPU_COST_INTERVAL_MS`, `GPU_COST_IDLE_WATTS`.
`GPU_COST_DIR` moves the data directory (default `~/.pi/gpu-cost`).

Notes:
- Energy = ∫(power.draw − idleWatts) dt over the session. Failed `nvidia-smi`
  ticks extrapolate at the last known wattage for up to 30 s, so brief hiccups
  don't undercount.
- Multi-GPU boxes: power and VRAM are summed across GPUs, utilization is the max.
- `idleWatts` example: set it to your idle draw (e.g. `25`) if you only want the
  cost attributable to active work.

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
