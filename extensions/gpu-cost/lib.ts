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
  statSync,
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
  /** max temperature across GPUs, °C (0 = unknown) */
  tempC: number;
  /** summed total VRAM across GPUs, MB (0 = unknown) */
  memTotalMb: number;
  /** name of the first GPU with a readable power ("" = unknown) */
  name: string;
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
  /** highest observed temperature, °C */
  peakTempC: number;
  /** integrated energy, joules */
  energyJ: number;
  /** number of failed sample ticks */
  failed: number;
}

/**
 * Parse output of:
 *   nvidia-smi --query-gpu=power.draw,utilization.gpu,memory.used,memory.total,temperature.gpu,name
 *     --format=csv,noheader,nounits
 *
 * Multiple lines (multi-GPU box): watts and memory summed, utilization and
 * temperature = max, name = first readable GPU. `name` is the LAST column,
 * joined from the remaining cells, so names containing commas survive.
 * Lines without a finite power value (e.g. "[N/A]") are ignored.
 * Returns null when no line is usable.
 */
export function parseSmiCsv(stdout: string): Omit<Sample, "t"> | null {
  let watts = 0;
  let util = 0;
  let mem = 0;
  let memTotal = 0;
  let temp = 0;
  let name = "";
  let gpus = 0;
  for (const line of stdout.split("\n")) {
    const raw = line.split(",");
    const cells = raw.map((s) => s.trim());
    const w = parseFloat(cells[0] ?? "");
    if (!Number.isFinite(w)) continue;
    gpus++;
    watts += w;
    const u = cells.length > 1 ? parseFloat(cells[1] ?? "") : NaN;
    const m = cells.length > 2 ? parseFloat(cells[2] ?? "") : NaN;
    const mt = cells.length > 3 ? parseFloat(cells[3] ?? "") : NaN;
    const tc = cells.length > 4 ? parseFloat(cells[4] ?? "") : NaN;
    if (Number.isFinite(u)) util = Math.max(util, u);
    if (Number.isFinite(m)) mem += m;
    if (Number.isFinite(mt)) memTotal += mt;
    if (Number.isFinite(tc)) temp = Math.max(temp, tc);
    if (!name && raw.length > 5) name = raw.slice(5).join(",").trim();
  }
  return gpus > 0
    ? { watts, util, memMb: mem, gpuCount: gpus, tempC: temp, memTotalMb: memTotal, name }
    : null;
}

/** Query all GPUs via nvidia-smi. Resolves null on any failure (missing binary, timeout, bad output). */
export function queryGpu(opts: { timeoutMs?: number } = {}): Promise<Sample | null> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      [
        "--query-gpu=power.draw,utilization.gpu,memory.used,memory.total,temperature.gpu,name",
        "--format=csv,noheader,nounits",
      ],
      { timeout: timeoutMs },
      (err, stdout) => {
        if (err) return resolve(null);
        const parsed = parseSmiCsv(stdout);
        resolve(parsed ? { t: Date.now(), ...parsed } : null);
      },
    );
  });
}

export interface GpuProcess {
  /** process name, aggregated across GPUs */
  name: string;
  /** total VRAM used, MB */
  memMb: number;
}

/**
 * Parse output of:
 *   nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits
 *
 * VRAM is aggregated per process name (one process may appear once per GPU).
 * On Windows nvidia-smi reports full paths — only the file name is kept.
 * Rows without a numeric memory value (e.g. "[N/A]") are skipped.
 * Sorted by VRAM descending. Returns [] for empty or unreadable output.
 */
export function parseProcessCsv(stdout: string): GpuProcess[] {
  const byName = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const cells = line.split(",").map((s) => s.trim());
    const full = cells[1] ?? "";
    const sep = Math.max(full.lastIndexOf("/"), full.lastIndexOf("\\"));
    const name = sep >= 0 ? full.slice(sep + 1) : full;
    const mem = cells.length > 2 ? parseFloat(cells[2] ?? "") : NaN;
    if (!name || !Number.isFinite(mem)) continue;
    byName.set(name, (byName.get(name) ?? 0) + mem);
  }
  return [...byName.entries()].map(([name, memMb]) => ({ name, memMb })).sort((a, b) => b.memMb - a.memMb);
}

/** Query the processes using the GPU(s). Resolves [] on any failure. */
export function queryGpuProcesses(opts: { timeoutMs?: number } = {}): Promise<GpuProcess[]> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"],
      { timeout: timeoutMs },
      (err, stdout) => {
        if (err) return resolve([]);
        resolve(parseProcessCsv(stdout));
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
    peakTempC: first.tempC,
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
  stats.peakTempC = Math.max(stats.peakTempC, sample.tempC);
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

/** Human VRAM size: "512 MB" below 1 GB, trimmed GB above ("24GB", "15.5GB"). */
export function fmtMem(mb: number): string {
  if (mb <= 0) return "0 MB";
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1).replace(/\.0$/, "")}GB`;
}

export function sessionLabel(stats: SessionStats, cfg: Config, last: Sample | null): string {
  const live = last ? `${last.watts.toFixed(0)}W · ${last.util.toFixed(0)}%` : "--";
  const temp = last && last.tempC > 0 ? ` · ${last.tempC.toFixed(0)}°C` : "";
  const vram = last && last.memMb > 0 ? ` · ${fmtMem(last.memMb)}` : "";
  return `⚡ ${live}${temp}${vram} · ${fmtEnergy(kwhOf(stats))} · ${fmtCost(sessionCost(stats, cfg), cfg.currency)}`;
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
  peakTempC: number;
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
    peakTempC: Math.round(stats.peakTempC),
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

/** Local-calendar month key (YYYY-MM) — "this month" is a local concept. */
export function localMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export interface TodayTotals {
  wh: number;
  sessions: number;
}

interface ParsedEntry {
  startedAt: string;
  energyWh: number;
  /** cost in the session's own currency at its own rate (0 when missing) */
  cost: number;
}

/**
 * Call cb once per unique, parseable log entry across one or more log files
 * (e.g. new data dir + legacy extension dir). Malformed lines are skipped;
 * identical lines across files are counted once.
 */
function forEachLogEntry(logPaths: string[], cb: (e: ParsedEntry, d: Date) => void): void {
  const seen = new Set<string>();
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
      const e = entry as { startedAt?: unknown; energyWh?: unknown; cost?: unknown };
      if (typeof e.energyWh !== "number" || typeof e.startedAt !== "string") continue;
      const d = new Date(e.startedAt);
      if (Number.isNaN(d.getTime())) continue;
      cb(
        {
          startedAt: e.startedAt,
          energyWh: e.energyWh,
          cost: typeof e.cost === "number" ? e.cost : 0,
        },
        d,
      );
    }
  }
}

/**
 * Sum energy of closed sessions started on the local "today" across one or
 * more log files. Malformed lines are skipped; identical lines across files
 * are counted once.
 */
export function readTodayTotals(logPaths: string[], now: Date = new Date()): TodayTotals {
  const day = localDayKey(now);
  let wh = 0;
  let sessions = 0;
  forEachLogEntry(logPaths, (e, d) => {
    if (localDayKey(d) === day) {
      wh += e.energyWh;
      sessions++;
    }
  });
  return { wh, sessions };
}

export interface MonthTotals {
  /** local calendar month (YYYY-MM) the sessions started in */
  month: string;
  /** total energy, Wh */
  wh: number;
  /** total cost (each session at its own rate) */
  cost: number;
  sessions: number;
}

/**
 * Group closed sessions by local calendar month across one or more log
 * files, newest month first. Each session's cost is summed as stored
 * (computed at that session's own rate), so later rate changes do not
 * rewrite history. Months without sessions are omitted; `limit` caps the
 * number of returned months.
 */
export function readMonthlyTotals(logPaths: string[], limit = 6): MonthTotals[] {
  const byMonth = new Map<string, MonthTotals>();
  forEachLogEntry(logPaths, (e, d) => {
    const key = localMonthKey(d);
    let m = byMonth.get(key);
    if (!m) {
      m = { month: key, wh: 0, cost: 0, sessions: 0 };
      byMonth.set(key, m);
    }
    m.wh += e.energyWh;
    m.cost += e.cost;
    m.sessions++;
  });
  return [...byMonth.values()].sort((a, b) => (a.month < b.month ? 1 : -1)).slice(0, Math.max(0, limit));
}

/** Append one log entry, creating the data directory if needed. */
export function appendLogEntry(logPath: string, entry: LogEntry): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

// ---------- long-term CSV log ----------

/** Column order of the long-term CSV log (semicolon-separated). */
export const CSV_COLUMNS: readonly (keyof LogEntry)[] = [
  "sessionId",
  "startedAt",
  "endedAt",
  "durationMin",
  "samples",
  "failedSamples",
  "avgWatts",
  "peakWatts",
  "peakTempC",
  "avgUtil",
  "energyWh",
  "cost",
  "ratePerKwh",
  "reason",
];

/** Quote a CSV cell only when it contains a separator, quote, or line break. */
function csvCell(v: string): string {
  return /[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** One CSV row for a log entry: fields joined with `;` (Excel-friendly). */
export function csvRow(entry: LogEntry): string {
  return CSV_COLUMNS.map((c) => csvCell(String(entry[c] ?? ""))).join(";");
}

/**
 * Append one row to the long-term CSV log, writing the header first when the
 * file is new or empty. Lines end with CRLF (CSV/Excel convention); numbers
 * keep `.` as decimal separator. Creates the directory if needed.
 */
export function appendCsvRow(csvPath: string, entry: LogEntry): void {
  mkdirSync(dirname(csvPath), { recursive: true });
  const header = CSV_COLUMNS.join(";");
  const prefix = !existsSync(csvPath) || statSync(csvPath).size === 0 ? header + "\r\n" : "";
  appendFileSync(csvPath, prefix + csvRow(entry) + "\r\n");
}

/**
 * One-time backfill: when the CSV log does not exist yet but a JSONL log
 * does, convert all existing JSONL entries into CSV rows so the CSV covers
 * the full history. No-op when the CSV exists, the JSONL is missing, or it
 * holds no parseable entries.
 */
export function backfillCsvFromJsonl(jsonlPath: string, csvPath: string): void {
  if (existsSync(csvPath) || !existsSync(jsonlPath)) return;
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf8");
  } catch {
    return;
  }
  const rows: string[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e: unknown;
    try {
      e = JSON.parse(t);
    } catch {
      continue;
    }
    if (typeof e !== "object" || e === null) continue;
    rows.push(csvRow(e as LogEntry));
  }
  if (rows.length === 0) return;
  mkdirSync(dirname(csvPath), { recursive: true });
  appendFileSync(csvPath, CSV_COLUMNS.join(";") + "\r\n" + rows.join("\r\n") + "\r\n");
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
