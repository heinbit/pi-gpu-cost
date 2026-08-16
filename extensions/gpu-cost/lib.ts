/**
 * gpu-cost — pure logic: config, nvidia-smi parsing, energy math, formatting, log IO.
 *
 * No pi imports, no timers — everything here is unit-testable.
 * The extension entry point (index.ts) only wires this into pi events.
 */
import { execFile } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------- config ----------

export interface Config {
  /** electricity price per kWh */
  ratePerKwh: number;
  /** currency symbol (normalized from an ISO 4217 code or literal symbol) */
  currency: string;
  /** nvidia-smi sampling interval in ms */
  intervalMs: number;
  /** idle baseline in watts, subtracted from draw (0 = no offset) */
  idleWatts: number;
}

/** Neutral built-in defaults — set your own rate in config.json (see README). */
export const DEFAULT_CONFIG: Config = {
  ratePerKwh: 0.3,
  currency: "$",
  intervalMs: 5000,
  idleWatts: 0,
};

/** Parse a non-negative finite number from a number or numeric string, else fallback. */
export function asNum(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Common ISO 4217 codes → display symbols. Codes not in the map (and literal
 * symbols like "€" or "kr") are passed through unchanged.
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "¥",
  PLN: "zł",
  CHF: "fr",
  SEK: "kr",
  NOK: "kr",
  DKK: "kr",
  CZK: "Kč",
  HUF: "Ft",
  RON: "lei",
  BGN: "lev",
  AUD: "A$",
  CAD: "C$",
  NZD: "NZ$",
  SGD: "S$",
  INR: "₹",
  KRW: "₩",
  ZAR: "R",
};

/**
 * Normalize a user-supplied currency to a display symbol. Accepts ISO 4217
 * codes (case-insensitive, e.g. "eur") or literal symbols ("€"); unknown
 * values pass through unchanged. Empty/missing falls back to the default.
 */
export function currencySymbol(v: string | undefined): string {
  const t = (v ?? "").trim();
  if (!t) return DEFAULT_CONFIG.currency;
  return CURRENCY_SYMBOLS[t.toUpperCase()] ?? t;
}

/**
 * User-level data directory for logs (and optionally config).
 * Stable across package updates — override with GPU_COST_DIR.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GPU_COST_DIR;
  if (typeof override === "string" && override.trim()) return override.trim();
  return join(homedir(), ".pi", "gpu-cost");
}

export interface ConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** candidate config.json paths; the first existing, parseable one wins */
  configPaths?: string[];
}

/**
 * Resolve config. Precedence: env vars > first parseable config.json candidate > defaults.
 * A malformed file is skipped in favor of the next candidate / defaults.
 */
export function loadConfig(opts: ConfigOptions = {}): Config {
  const env = opts.env ?? process.env;
  let file: Record<string, unknown> | null = null;
  for (const p of opts.configPaths ?? []) {
    if (!existsSync(p)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
      if (parsed && typeof parsed === "object") {
        file = parsed as Record<string, unknown>;
        break;
      }
    } catch {
      // malformed — try the next candidate
    }
  }
  const f = file ?? {};
  return {
    ratePerKwh: asNum(env.GPU_COST_RATE ?? f.ratePerKwh, DEFAULT_CONFIG.ratePerKwh),
    currency: currencySymbol(
      typeof env.GPU_COST_CURRENCY === "string" && env.GPU_COST_CURRENCY.trim()
        ? env.GPU_COST_CURRENCY
        : typeof f.currency === "string"
          ? f.currency
          : undefined,
    ),
    intervalMs: Math.max(50, asNum(env.GPU_COST_INTERVAL_MS ?? f.intervalMs, DEFAULT_CONFIG.intervalMs)),
    idleWatts: asNum(env.GPU_COST_IDLE_WATTS ?? f.idleWatts, DEFAULT_CONFIG.idleWatts),
  };
}

// ---------- sampling ----------

export interface Sample {
  /** epoch ms of the sample */
  t: number;
  /** summed power draw across all GPUs, watts */
  watts: number;
  /** max utilization across all GPUs, percent */
  util: number;
  /** summed used VRAM, MB */
  memMb: number;
  /** number of GPUs contributing a readable power value */
  gpuCount: number;
}

export interface SessionStats {
  sessionId: string;
  startedAt: number;
  /** epoch ms of the last processed sample (or extrapolated tick) */
  lastT: number;
  /** number of successful samples (includes the first) */
  count: number;
  sumWatts: number;
  sumUtil: number;
  peakWatts: number;
  /** integrated energy, joules */
  energyJ: number;
  /** number of failed sample ticks */
  failed: number;
}

/**
 * Parse output of:
 *   nvidia-smi --query-gpu=power.draw,utilization.gpu,memory.used --format=csv,noheader,nounits
 *
 * Multiple lines (multi-GPU box): watts and memory summed, utilization = max.
 * Lines without a finite power value (e.g. "[N/A]") are ignored.
 * Returns null when no line is usable.
 */
export function parseSmiCsv(stdout: string): Omit<Sample, "t"> | null {
  let watts = 0;
  let util = 0;
  let mem = 0;
  let gpus = 0;
  for (const line of stdout.split("\n")) {
    const cells = line.split(",").map((s) => s.trim());
    const w = parseFloat(cells[0] ?? "");
    const u = cells.length > 1 ? parseFloat(cells[1] ?? "") : NaN;
    const m = cells.length > 2 ? parseFloat(cells[2] ?? "") : NaN;
    if (!Number.isFinite(w)) continue;
    gpus++;
    watts += w;
    if (Number.isFinite(u)) util = Math.max(util, u);
    if (Number.isFinite(m)) mem += m;
  }
  return gpus > 0 ? { watts, util, memMb: mem, gpuCount: gpus } : null;
}

/** Query all GPUs via nvidia-smi. Resolves null on any failure (missing binary, timeout, bad output). */
export function queryGpu(opts: { timeoutMs?: number } = {}): Promise<Sample | null> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=power.draw,utilization.gpu,memory.used", "--format=csv,noheader,nounits"],
      { timeout: timeoutMs },
      (err, stdout) => {
        if (err) return resolve(null);
        const parsed = parseSmiCsv(stdout);
        resolve(parsed ? { t: Date.now(), ...parsed } : null);
      },
    );
  });
}

export function createSessionStats(sessionId: string, first: Sample): SessionStats {
  return {
    sessionId,
    startedAt: first.t,
    lastT: first.t,
    count: 1,
    sumWatts: first.watts,
    sumUtil: first.util,
    peakWatts: first.watts,
    energyJ: 0,
    failed: 0,
  };
}

/** Integrate a successful sample into stats (rectangle rule over the interval since the last tick). */
export function integrateSample(stats: SessionStats, sample: Sample, cfg: Config): number {
  const dt = Math.max(0, sample.t - stats.lastT) / 1000;
  stats.energyJ += Math.max(0, sample.watts - cfg.idleWatts) * dt;
  stats.lastT = sample.t;
  stats.count++;
  stats.sumWatts += sample.watts;
  stats.sumUtil += sample.util;
  stats.peakWatts = Math.max(stats.peakWatts, sample.watts);
  return dt;
}

/**
 * Max wall-clock time (ms) a failed tick may keep extrapolating at the last
 * known wattage before it contributes zero. Prevents runaway estimates after
 * a long nvidia-smi outage while still covering normal hiccups.
 */
export const MAX_EXTRAPOLATE_MS = 30_000;

/** Joules for extrapolating a failed tick at `lastWatts`, capped by the total already extrapolated. */
export function extrapolateEnergy(lastWatts: number, idleWatts: number, dtMs: number, alreadyMs: number): number {
  const cappedMs = Math.max(0, Math.min(dtMs, MAX_EXTRAPOLATE_MS - alreadyMs));
  return Math.max(0, lastWatts - idleWatts) * (cappedMs / 1000);
}

// ---------- energy / cost ----------

export function kwhOf(stats: SessionStats): number {
  return stats.energyJ / 3.6e6;
}

/**
 * Session cost = kWh × rate. Single source of truth — kwhOf() already returns
 * kWh, so multiply exactly once. (Regression-guarded: this expression used to
 * be divided by 1000 a second time in three places, rendering €<0.0001.)
 */
export function sessionCost(stats: SessionStats, cfg: Config): number {
  return kwhOf(stats) * cfg.ratePerKwh;
}

// ---------- formatting ----------

export function fmtCost(cost: number, currency: string): string {
  if (cost < 0.0001) return `${currency}<0.0001`;
  // typical GPU sessions cost fractions of a cent: keep 4 decimals below 1,
  // 2 decimals from 1 up ("0.0399" stays readable, "10.00" -> "10")
  const v = cost < 1 ? cost.toFixed(4) : cost.toFixed(2);
  return `${currency}${v.replace(/0+$/, "").replace(/\.$/, "")}`;
}

export function fmtEnergy(kwh: number): string {
  return kwh < 0.1 ? `${(kwh * 1000).toFixed(1)} Wh` : `${kwh.toFixed(2)} kWh`;
}

export function sessionLabel(stats: SessionStats, cfg: Config, last: Sample | null): string {
  const live = last ? `${last.watts.toFixed(0)}W ${last.util.toFixed(0)}%` : "--";
  return `⚡ ${live} · ${fmtEnergy(kwhOf(stats))} · ${fmtCost(sessionCost(stats, cfg), cfg.currency)}`;
}

// ---------- log ----------

export interface LogEntry {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  durationMin: number;
  samples: number;
  failedSamples: number;
  avgWatts: number;
  peakWatts: number;
  avgUtil: number;
  energyWh: number;
  cost: number;
  ratePerKwh: number;
  reason: string;
}

export function buildLogEntry(stats: SessionStats, cfg: Config, endedAt: number, reason: string): LogEntry {
  const kwh = kwhOf(stats);
  const cost = sessionCost(stats, cfg);
  const avgWatts = stats.count > 0 ? stats.sumWatts / stats.count : 0;
  const avgUtil = stats.count > 0 ? stats.sumUtil / stats.count : 0;
  return {
    sessionId: stats.sessionId,
    startedAt: new Date(stats.startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMin: Math.round(((endedAt - stats.startedAt) / 60000) * 10) / 10,
    samples: stats.count,
    failedSamples: stats.failed,
    avgWatts: Math.round(avgWatts * 10) / 10,
    peakWatts: Math.round(stats.peakWatts * 10) / 10,
    avgUtil: Math.round(avgUtil * 10) / 10,
    energyWh: Math.round(kwh * 1e6) / 1000,
    cost: Math.round(cost * 100000) / 100000,
    ratePerKwh: cfg.ratePerKwh,
    reason,
  };
}

/** Local-calendar day key (YYYY-MM-DD) — "today" is a local concept. */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface TodayTotals {
  wh: number;
  sessions: number;
}

/**
 * Sum energy of closed sessions started on the local "today" across one or
 * more log files (e.g. new data dir + legacy extension dir). Malformed lines
 * are skipped; identical lines across files are counted once.
 */
export function readTodayTotals(logPaths: string[], now: Date = new Date()): TodayTotals {
  const day = localDayKey(now);
  const seen = new Set<string>();
  let wh = 0;
  let sessions = 0;
  for (const p of logPaths) {
    if (!existsSync(p)) continue;
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      let entry: unknown;
      try {
        entry = JSON.parse(t);
      } catch {
        continue; // malformed line — skip
      }
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as { startedAt?: unknown; energyWh?: unknown };
      if (typeof e.energyWh !== "number" || typeof e.startedAt !== "string") continue;
      const d = new Date(e.startedAt);
      if (Number.isNaN(d.getTime())) continue;
      if (localDayKey(d) === day) {
        wh += e.energyWh;
        sessions++;
      }
    }
  }
  return { wh, sessions };
}

/** Append one log entry, creating the data directory if needed. */
export function appendLogEntry(logPath: string, entry: LogEntry): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

/**
 * One-time best-effort migration of a legacy log.jsonl from the old
 * extension-dir location to the new data-dir location. No-op when either
 * side already exists or paths match.
 */
export function migrateLegacyLog(legacyPath: string, newPath: string): void {
  if (legacyPath === newPath) return;
  try {
    if (existsSync(legacyPath) && !existsSync(newPath)) {
      mkdirSync(dirname(newPath), { recursive: true });
      try {
        renameSync(legacyPath, newPath);
      } catch {
        copyFileSync(legacyPath, newPath);
      }
    }
  } catch {
    // best effort — never break the session for a log migration
  }
}
