/**
 * gpu-cost — track GPU power draw and estimated electricity cost per pi session.
 *
 * - Samples `nvidia-smi` every `intervalMs` (default 5 s) while a session is active
 * - Integrates power over time -> energy (Wh); cost = kWh × ratePerKwh
 * - Live footer status:  ⚡ 269W · 97% · 61°C · 14.2GB · 0.12 kWh · €0.03
 * - /gpucost — current session, live GPU status (name, VRAM, temperature),
 *   processes using the GPU, + today's closed sessions + monthly cost overview
 * - On quit: final summary notification + one line per closed session in
 *   log.jsonl and one row in log.csv (semicolon-separated long-term log)
 *
 * Data directory (default ~/.pi/gpu-cost, override GPU_COST_DIR):
 *   config.json — optional user config (see config.example.json)
 *   log.jsonl   — one JSON line per closed session
 *   log.csv     — one semicolon-separated row per closed session (long-term log)
 * A config.json next to this file is honored as a second config candidate.
 * Env overrides: GPU_COST_RATE, GPU_COST_CURRENCY, GPU_COST_INTERVAL_MS,
 * GPU_COST_IDLE_WATTS, GPU_COST_DIR.
 */
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  appendCsvRow,
  appendLogEntry,
  backfillCsvFromJsonl,
  buildLogEntry,
  fmtCost,
  fmtEnergy,
  fmtMem,
  kwhOf,
  loadConfig,
  migrateLegacyLog,
  queryGpu,
  queryGpuProcesses,
  readMonthlyTotals,
  readTodayTotals,
  resolveDataDir,
  sessionCost,
  sessionLabel,
  type Config,
} from "./lib.ts";
import { GpuSampler } from "./sampler.ts";

// pi loads extensions through jiti, which provides __dirname; the fallback
// keeps the module importable outside pi (tests).
const EXT_DIR = typeof __dirname !== "undefined" ? __dirname : process.cwd();

interface Live {
  sampler: GpuSampler;
  cfg: Config;
  ctx: ExtensionContext;
}

// globalThis so a /reload (module re-instantiation) cannot leak the old timer.
// pi fires the old session's session_shutdown before the new session_start,
// so this is a belt-and-suspenders guard, not a correctness dependency.
const GLOBAL_KEY = "__pi_gpu_cost_sampler__";
const getLive = (): Live | null => (globalThis as Record<string, unknown>)[GLOBAL_KEY] as Live | null;
const setLive = (l: Live | null): void => {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = l;
};

const dataDir = () => resolveDataDir();
const logPath = () => join(dataDir(), "log.jsonl");
const csvPath = () => join(dataDir(), "log.csv");
const legacyLogPath = () => join(EXT_DIR, "log.jsonl");
const configPaths = () => [join(dataDir(), "config.json"), join(EXT_DIR, "config.json")];

function sessionIdOf(ctx: ExtensionContext): string {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id) return id;
  } catch {
    // fall through
  }
  return process.env.PI_SESSION_ID ?? "unknown";
}

function startSampling(ctx: ExtensionContext): void {
  void (async () => {
    // Idempotent: stop a previous sampler (e.g. after /reload).
    getLive()?.sampler.stop();

    const cfg = loadConfig({ configPaths: configPaths() });
    migrateLegacyLog(legacyLogPath(), logPath());
    backfillCsvFromJsonl(logPath(), csvPath());

    const sampler = new GpuSampler(cfg, sessionIdOf(ctx), {
      // keep the query well inside the sampling interval
      query: () => queryGpu({ timeoutMs: Math.min(5000, Math.max(1000, cfg.intervalMs - 500)) }),
      onSample: (sample) => {
        const l = getLive();
        if (l && l.sampler.stats && l.ctx.hasUI) {
          l.ctx.ui.setStatus("gpu-cost", sessionLabel(l.sampler.stats, l.cfg, sample));
        }
      },
    });

    const first = await sampler.start();
    if (!first) {
      if (ctx.hasUI) ctx.ui.notify("gpu-cost: nvidia-smi not available — GPU cost tracking disabled", "warning");
      return;
    }

    sampler.begin(cfg.intervalMs);
    setLive({ sampler, cfg, ctx });
    if (ctx.hasUI) ctx.ui.setStatus("gpu-cost", sessionLabel(sampler.stats!, cfg, first));
  })();
}

function stopSampling(ctx: ExtensionContext | undefined): void {
  const l = getLive();
  if (l) l.sampler.stop();
  setLive(null);
  if (ctx?.hasUI) ctx.ui.setStatus("gpu-cost", undefined);
}

function finalizeSession(reason: string, ctx: ExtensionContext | undefined): void {
  const l = getLive();
  if (!l) return;
  const { sampler, cfg } = l;
  stopSampling(ctx);

  const stats = sampler.stats;
  if (!stats) return;

  const entry = buildLogEntry(stats, cfg, Date.now(), reason);
  try {
    migrateLegacyLog(legacyLogPath(), logPath());
    appendLogEntry(logPath(), entry);
    appendCsvRow(csvPath(), entry);
  } catch (e) {
    console.error(`gpu-cost: failed to write log: ${e}`);
  }

  if (reason === "quit" && ctx?.hasUI) {
    ctx.ui.notify(
      `gpu-cost: ${entry.durationMin} min · avg ${entry.avgWatts}W (${entry.avgUtil}%) · ${entry.energyWh} Wh · ${fmtCost(entry.cost, cfg.currency)}`,
      "info",
    );
  }
}

// ---------- extension ----------

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    startSampling(ctx);
  });

  pi.on("session_shutdown", (event, ctx) => {
    finalizeSession(event.reason, ctx);
  });

  pi.registerCommand("gpucost", {
    description: "GPU energy & cost: current session, today + monthly totals",
    handler: async (_args, ctx) => {
      const cfg = loadConfig({ configPaths: configPaths() });
      const lines: string[] = [];

      const stats = getLive()?.sampler.stats;
      if (stats) {
        const mins = (Date.now() - stats.startedAt) / 60000;
        const avgW = stats.count > 0 ? stats.sumWatts / stats.count : 0;
        const avgU = stats.count > 0 ? stats.sumUtil / stats.count : 0;
        lines.push(
          `this session (${mins.toFixed(1)} min): avg ${avgW.toFixed(0)}W / ${avgU.toFixed(0)}%, peak ${stats.peakWatts.toFixed(0)}W → ${fmtEnergy(kwhOf(stats))} = ${fmtCost(sessionCost(stats, cfg), cfg.currency)}`,
        );
      } else {
        lines.push("this session: GPU sampling not running");
      }

      const last = getLive()?.sampler.last ?? null;
      if (last) {
        const parts = [last.name || "GPU"];
        if (last.memTotalMb > 0) parts.push(`${fmtMem(last.memMb)}/${fmtMem(last.memTotalMb)} VRAM`);
        else if (last.memMb > 0) parts.push(`${fmtMem(last.memMb)} VRAM`);
        if (last.tempC > 0) parts.push(`${last.tempC.toFixed(0)}°C`);
        lines.push(`gpu: ${parts.join(" · ")}`);
      }

      const procs = await queryGpuProcesses();
      if (procs.length > 0) {
        lines.push(`processes: ${procs.slice(0, 5).map((p) => `${p.name} ${fmtMem(p.memMb)}`).join(", ")}`);
      }

      const totals = readTodayTotals([logPath(), legacyLogPath()]);
      if (totals.sessions > 0) {
        lines.push(
          `today (closed sessions, ${totals.sessions}): ${
            totals.wh < 100 ? `${totals.wh.toFixed(1)} Wh` : `${(totals.wh / 1000).toFixed(2)} kWh`
          } = ${fmtCost((totals.wh / 1000) * cfg.ratePerKwh, cfg.currency)}`,
        );
      }

      const months = readMonthlyTotals([logPath(), legacyLogPath()]);
      if (months.length > 0) {
        lines.push("monthly (closed sessions, newest first):");
        for (const m of months) {
          lines.push(`  ${m.month}: ${fmtEnergy(m.wh / 1000)} = ${fmtCost(m.cost, cfg.currency)} (${m.sessions})`);
        }
      }

      lines.push(`rate: ${cfg.ratePerKwh} ${cfg.currency}/kWh`);
      if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
