import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CSV_COLUMNS,
  MAX_EXTRAPOLATE_MS,
  appendCsvRow,
  appendLogEntry,
  asNum,
  backfillCsvFromJsonl,
  buildLogEntry,
  createSessionStats,
  csvRow,
  currencySymbol,
  extrapolateEnergy,
  fmtCost,
  fmtEnergy,
  fmtMem,
  integrateSample,
  kwhOf,
  loadConfig,
  localDayKey,
  migrateLegacyLog,
  parseProcessCsv,
  parseSmiCsv,
  readMonthlyTotals,
  readTodayTotals,
  sessionCost,
  sessionLabel,
  type Config,
  type Sample,
} from "../extensions/gpu-cost/lib.ts";

const CFG: Config = { ratePerKwh: 0.282, currency: "€", intervalMs: 5000, idleWatts: 0 };

function sample(
  t: number,
  watts: number,
  util = 50,
  memMb = 1000,
  tempC = 0,
  memTotalMb = 0,
  name = "",
): Sample {
  return { t, watts, util, memMb, gpuCount: 1, tempC, memTotalMb, name };
}

// ---------- parseSmiCsv ----------

test("parseSmiCsv: single GPU", () => {
  assert.deepEqual(parseSmiCsv("242.15, 97, 12345"), {
    watts: 242.15,
    util: 97,
    memMb: 12345,
    gpuCount: 1,
    tempC: 0,
    memTotalMb: 0,
    name: "",
  });
});

test("parseSmiCsv: temperature, memory.total and name (6-column query)", () => {
  const out = [
    "269.5, 97, 12345, 24576, 86, NVIDIA GeForce RTX 4090",
    "120.0, 40, 512, 16384, 61, NVIDIA RTX A6000",
  ].join("\n");
  const p = parseSmiCsv(out);
  assert.ok(p);
  assert.equal(p.gpuCount, 2);
  assert.ok(Math.abs(p.watts - 389.5) < 1e-9);
  assert.equal(p.util, 97);
  assert.equal(p.memMb, 12857);
  assert.equal(p.memTotalMb, 40960);
  assert.equal(p.tempC, 86); // max across GPUs
  assert.equal(p.name, "NVIDIA GeForce RTX 4090"); // first readable GPU
});

test("parseSmiCsv: name containing a comma is preserved (last column)", () => {
  const p = parseSmiCsv("100, 10, 100, 2048, 55, Foo, Bar");
  assert.equal(p?.name, "Foo, Bar");
});

test("parseSmiCsv: multi-GPU sums watts/mem, max util", () => {
  const out = parseSmiCsv("240.0, 90, 8000\n180.5, 40, 6000");
  assert.ok(out);
  assert.equal(out.gpuCount, 2);
  assert.ok(Math.abs(out.watts - 420.5) < 1e-9);
  assert.equal(out.util, 90);
  assert.equal(out.memMb, 14000);
});

test("parseSmiCsv: [N/A] power line is ignored", () => {
  assert.equal(parseSmiCsv("[N/A], 0, 100"), null);
  // one bad line among good ones
  const out = parseSmiCsv("[N/A], 0, 100\n250.0, 80, 2000");
  assert.ok(out);
  assert.equal(out.gpuCount, 1);
  assert.equal(out.watts, 250);
});

test("parseSmiCsv: garbage / empty", () => {
  assert.equal(parseSmiCsv(""), null);
  assert.equal(parseSmiCsv("\n  \n"), null);
  assert.equal(parseSmiCsv("not, a, gpu"), null);
  assert.equal(parseSmiCsv("error: NVIDIA-SMI has failed"), null);
});

test("parseSmiCsv: whitespace tolerant", () => {
  const out = parseSmiCsv("  120.0 ,  33 , 4096  \n");
  assert.ok(out);
  assert.equal(out.watts, 120);
  assert.equal(out.util, 33);
});

// ---------- config ----------

test("loadConfig: defaults when nothing set", () => {
  const cfg = loadConfig({ env: {}, configPaths: [join(tmpdir(), "does-not-exist-gpu-cost.json")] });
  assert.deepEqual(cfg, { ratePerKwh: 0.3, currency: "$", intervalMs: 5000, idleWatts: 0 });
});

test("loadConfig: file values", () => {
  const dir = mkdtempSync(join(tmpdir(), "gpu-cost-cfg-"));
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ ratePerKwh: 0.282, currency: "€", idleWatts: 20 }));
    const cfg = loadConfig({ env: {}, configPaths: [p] });
    assert.equal(cfg.ratePerKwh, 0.282);
    assert.equal(cfg.currency, "€");
    assert.equal(cfg.idleWatts, 20);
    assert.equal(cfg.intervalMs, 5000); // default kept
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: env overrides file; string numbers parse", () => {
  const dir = mkdtempSync(join(tmpdir(), "gpu-cost-cfg-"));
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ ratePerKwh: 0.5, currency: "€" }));
    const cfg = loadConfig({
      env: { GPU_COST_RATE: "0.282", GPU_COST_CURRENCY: "kr", GPU_COST_INTERVAL_MS: "1500" },
      configPaths: [p],
    });
    assert.equal(cfg.ratePerKwh, 0.282);
    assert.equal(cfg.currency, "kr");
    assert.equal(cfg.intervalMs, 1500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: currency normalized from ISO code (file + env), literal kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "gpu-cost-cfg-"));
  try {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ currency: "EUR" }));
    assert.equal(loadConfig({ env: {}, configPaths: [p] }).currency, "€");
    assert.equal(loadConfig({ env: { GPU_COST_CURRENCY: "gbp" }, configPaths: [p] }).currency, "£");
    writeFileSync(p, JSON.stringify({ currency: "zł" }));
    assert.equal(loadConfig({ env: {}, configPaths: [p] }).currency, "zł");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: malformed file falls through to next candidate", () => {
  const dir = mkdtempSync(join(tmpdir(), "gpu-cost-cfg-"));
  try {
    const bad = join(dir, "bad.json");
    const good = join(dir, "good.json");
    writeFileSync(bad, "{ not json");
    writeFileSync(good, JSON.stringify({ ratePerKwh: 0.42 }));
    assert.equal(loadConfig({ env: {}, configPaths: [bad] }).ratePerKwh, 0.3); // default
    assert.equal(loadConfig({ env: {}, configPaths: [bad, good] }).ratePerKwh, 0.42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: negative/invalid values fall back to defaults; interval clamped", () => {
  const cfg = loadConfig({
    env: { GPU_COST_RATE: "-5", GPU_COST_INTERVAL_MS: "10" },
    configPaths: [],
  });
  assert.equal(cfg.ratePerKwh, 0.3);
  assert.equal(cfg.intervalMs, 50);
});

test("asNum: edge cases", () => {
  assert.equal(asNum("0.282", 1), 0.282);
  assert.equal(asNum(5, 1), 5);
  assert.equal(asNum("abc", 1), 1);
  assert.equal(asNum(null, 1), 1);
  assert.equal(asNum(-1, 1), 1);
});

test("currencySymbol: ISO codes map to symbols, literals pass through", () => {
  assert.equal(currencySymbol("EUR"), "€");
  assert.equal(currencySymbol("usd"), "$");
  assert.equal(currencySymbol("GBP"), "£");
  assert.equal(currencySymbol("JPY"), "¥");
  assert.equal(currencySymbol("PLN"), "zł");
  assert.equal(currencySymbol("  EUR  "), "€"); // whitespace trimmed
  assert.equal(currencySymbol("€"), "€"); // literal symbol unchanged
  assert.equal(currencySymbol("kr"), "kr"); // unknown string passes through
  assert.equal(currencySymbol("XXY"), "XXY");
  assert.equal(currencySymbol(""), "$"); // empty -> default
  assert.equal(currencySymbol(undefined), "$"); // missing -> default
});

// ---------- energy math ----------

test("integrateSample: rectangle rule over elapsed time", () => {
  const stats = createSessionStats("s1", sample(0, 220));
  assert.equal(stats.count, 1);
  assert.equal(stats.energyJ, 0);

  integrateSample(stats, sample(10_000, 220), CFG); // 220 W × 10 s = 2200 J
  assert.equal(stats.count, 2);
  assert.ok(Math.abs(stats.energyJ - 2200) < 1e-9);
  assert.equal(stats.lastT, 10_000);

  integrateSample(stats, sample(15_000, 200), CFG); // 200 W × 5 s = 1000 J
  assert.ok(Math.abs(stats.energyJ - 3200) < 1e-9);
  assert.equal(stats.peakWatts, 220);
});

test("integrateSample: idleWatts clamps at zero", () => {
  const cfg: Config = { ...CFG, idleWatts: 250 };
  const stats = createSessionStats("s1", sample(0, 200));
  integrateSample(stats, sample(10_000, 200), cfg); // 200 < 250 -> no energy
  assert.equal(stats.energyJ, 0);
});

test("integrateSample: clock going backwards contributes zero", () => {
  const stats = createSessionStats("s1", sample(10_000, 200));
  integrateSample(stats, sample(5_000, 200), CFG);
  assert.equal(stats.energyJ, 0);
});

test("integrateSample: peakTempC tracks the max across samples", () => {
  const stats = createSessionStats("s1", sample(0, 200, 50, 1000, 70));
  integrateSample(stats, sample(5000, 200, 50, 1000, 85), CFG);
  integrateSample(stats, sample(10_000, 200, 50, 1000, 60), CFG);
  assert.equal(stats.peakTempC, 85);
});

test("extrapolateEnergy: capped at MAX_EXTRAPOLATE_MS", () => {
  // fresh: 200 W × 5 s = 1000 J
  assert.ok(Math.abs(extrapolateEnergy(200, 0, 5000, 0) - 1000) < 1e-9);
  // partially exhausted: 25 s already -> only 5 s of the 10 s allowed
  assert.ok(Math.abs(extrapolateEnergy(200, 0, 10_000, 25_000) - 1000) < 1e-9);
  // exhausted: zero
  assert.equal(extrapolateEnergy(200, 0, 10_000, MAX_EXTRAPOLATE_MS), 0);
  // idle offset clamps
  assert.equal(extrapolateEnergy(50, 100, 5000, 0), 0);
});

test("sessionCost: kWh × rate exactly once (regression for the 1000x bug)", () => {
  // 38.4 min at 221 W ≈ 0.142 kWh. At 0.282 €/kWh that is ≈ €0.04 — NOT €<0.0001.
  const stats = createSessionStats("s1", sample(0, 221));
  for (let t = 5_000; t <= 38.4 * 60_000; t += 5_000) {
    integrateSample(stats, sample(t, 221), CFG);
  }
  const kwh = kwhOf(stats);
  assert.ok(kwh > 0.13 && kwh < 0.15, `kwh=${kwh}`);
  const cost = sessionCost(stats, CFG);
  assert.ok(Math.abs(cost - kwh * 0.282) < 1e-12);
  assert.ok(cost > 0.03 && cost < 0.05, `cost=${cost}`);
  assert.ok(cost >= 0.0001, "must not render as <0.0001");
});

// ---------- formatting ----------

test("fmtCost: thresholds and trailing-zero trim", () => {
  assert.equal(fmtCost(0.00005, "€"), "€<0.0001");
  assert.equal(fmtCost(0.0399, "€"), "€0.0399"); // < 1 -> 4 decimals
  assert.equal(fmtCost(0.04, "€"), "€0.04"); // trailing zeros trimmed
  assert.equal(fmtCost(0.0099, "€"), "€0.0099");
  assert.equal(fmtCost(0.01229, "€"), "€0.0123"); // 4-decimal rounding
  assert.equal(fmtCost(1.234, "€"), "€1.23"); // >= 1 -> 2 decimals
  assert.equal(fmtCost(10, "$"), "$10");
});

test("fmtEnergy: Wh below 0.1 kWh, kWh above", () => {
  assert.equal(fmtEnergy(0.0423), "42.3 Wh");
  assert.equal(fmtEnergy(0.0999), "99.9 Wh");
  assert.equal(fmtEnergy(0.1425), "0.14 kWh");
});

test("fmtMem: MB below 1 GB, trimmed GB above", () => {
  assert.equal(fmtMem(0), "0 MB");
  assert.equal(fmtMem(512), "512 MB");
  assert.equal(fmtMem(1023), "1023 MB");
  assert.equal(fmtMem(1024), "1GB");
  assert.equal(fmtMem(15360), "15GB");
  assert.equal(fmtMem(15872), "15.5GB");
  assert.equal(fmtMem(24576), "24GB");
});

test("sessionLabel: shape", () => {
  const stats = createSessionStats("s1", sample(0, 269, 97));
  const label = sessionLabel(stats, CFG, sample(0, 269, 97));
  assert.ok(label.startsWith("⚡ 269W · 97% · 1000 MB ·"), label);
  assert.ok(label.includes("€"), label);
  assert.equal(sessionLabel(stats, CFG, null).startsWith("⚡ --"), true);
});

test("sessionLabel: VRAM segment omitted when 0 MB", () => {
  const stats = createSessionStats("s1", sample(0, 269, 97, 0));
  const label = sessionLabel(stats, CFG, sample(0, 269, 97, 0));
  assert.ok(label.startsWith("⚡ 269W · 97% · 0.0 Wh"), label);
});

test("sessionLabel: temperature segment when known, omitted when 0", () => {
  const stats = createSessionStats("s1", sample(0, 269, 97, 1000, 61));
  assert.ok(sessionLabel(stats, CFG, sample(0, 269, 97, 1000, 61)).startsWith("⚡ 269W · 97% · 61°C · 1000 MB ·"));
  assert.ok(sessionLabel(stats, CFG, sample(0, 269, 97, 1000, 0)).startsWith("⚡ 269W · 97% · 1000 MB ·"));
});

test("parseProcessCsv: aggregates per name, sorts by VRAM desc, skips garbage", () => {
  const out = "1234, llama-server, 4096\n1234, llama-server, 1024\n5678, python, 512\n, , \n";
  assert.deepEqual(parseProcessCsv(out), [
    { name: "llama-server", memMb: 5120 },
    { name: "python", memMb: 512 },
  ]);
  assert.deepEqual(parseProcessCsv(""), []);
  assert.deepEqual(parseProcessCsv("\n"), []);
});

test("parseProcessCsv: Windows full paths shortened, [N/A] rows skipped", () => {
  const out = [
    "1252, [Insufficient Permissions], [N/A]",
    "6924, C:\\Windows\\explorer.exe, [N/A]",
    "15508, C:\\Program Files\\llama\\llama-server.exe, 4123",
    "15509, /usr/bin/python3, 512",
  ].join("\n");
  assert.deepEqual(parseProcessCsv(out), [
    { name: "llama-server.exe", memMb: 4123 },
    { name: "python3", memMb: 512 },
  ]);
});

// ---------- log ----------

function entryLine(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    sessionId: "x",
    startedAt: "2026-08-16T10:00:00.000Z",
    endedAt: "2026-08-16T11:00:00.000Z",
    durationMin: 60,
    samples: 720,
    failedSamples: 0,
    avgWatts: 200,
    peakWatts: 270,
    avgUtil: 70,
    energyWh: 200,
    cost: 0.0564,
    ratePerKwh: 0.282,
    reason: "quit",
    ...overrides,
  });
}

test("buildLogEntry: fields and rounding", () => {
  const stats = createSessionStats("sess-1", sample(1_000_000, 200, 50, 1000, 72));
  integrateSample(stats, sample(1_000_000 + 3_600_000, 210, 60, 1000, 85), CFG); // 1 h @ ~205 W
  const entry = buildLogEntry(stats, CFG, 1_000_000 + 3_600_000, "quit");
  assert.equal(entry.sessionId, "sess-1");
  assert.equal(entry.durationMin, 60);
  assert.equal(entry.samples, 2);
  assert.equal(entry.peakWatts, 210);
  assert.equal(entry.peakTempC, 85);
  assert.equal(entry.avgWatts, 205);
  // rectangle rule: second sample's 210 W covers the whole 1 h interval
  assert.ok(Math.abs(entry.energyWh - 210) < 0.001, `wh=${entry.energyWh}`);
  assert.ok(Math.abs(entry.cost - entry.energyWh / 1000 * 0.282) < 1e-5);
  assert.ok(!Number.isNaN(Date.parse(entry.startedAt)));
});

test("readTodayTotals: filters by local day, skips malformed, dedupes across files", () => {
  const dir = mkdtempSync(join(tmpdir(), "gpu-cost-log-"));
  try {
    const now = new Date();
    const today = localDayKey(now);
    const todayA = new Date(now.getTime() - 1 * 3600_000).toISOString();
    const todayB = new Date(now.getTime() - 2 * 3600_000).toISOString();
    const yesterday = new Date(now.getTime() - 26 * 3600_000).toISOString();
    const lineA = entryLine({ startedAt: todayA, energyWh: 100 });
    const lineB = entryLine({ startedAt: todayB, energyWh: 50 });

    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    writeFileSync(a, [lineA, lineB, entryLine({ startedAt: yesterday, energyWh: 999 }), "not json", JSON.stringify({ startedAt: todayA })].join("\n") + "\n");
    // file b repeats lineA (legacy dup) plus one malformed-fields line
    writeFileSync(b, [lineA, JSON.stringify({ energyWh: 77 })].join("\n") + "\n");

    const totals = readTodayTotals([a, b], now);
    assert.equal(totals.sessions, 2);
    assert.ok(Math.abs(totals.wh - 150) < 1e-9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTodayTotals: missing files are fine", () => {
  const t = readTodayTotals([join(tmpdir(), "nope-1.jsonl"), join(tmpdir(), "nope-2.jsonl")]);
  assert.deepEqual(t, { wh: 0, sessions: 0 });
});

test("appendLogEntry: creates dir and appends", () => {
  const dir = mkdtempSync(join(tmpdir(), "gpu-cost-log-"));
  try {
    const p = join(dir, "nested", "log.jsonl");
    const e1 = buildLogEntry(createSessionStats("a", sample(0, 100)), CFG, 60_000, "quit");
    const e2 = buildLogEntry(createSessionStats("b", sample(0, 100)), CFG, 60_000, "reload");
    appendLogEntry(p, e1);
    appendLogEntry(p, e2);
    const lines = readFileSync(p, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]!).sessionId, "a");
    assert.equal(JSON.parse(lines[1]!).reason, "reload");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrateLegacyLog: renames when target absent, no-op otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "gpu-cost-mig-"));
  try {
    const legacy = join(dir, "legacy.jsonl");
    const target = join(dir, "target.jsonl");
    writeFileSync(legacy, "line1\n");

    migrateLegacyLog(legacy, target);
    assert.ok(existsSync(target));
    assert.ok(!existsSync(legacy));
    assert.equal(readFileSync(target, "utf8"), "line1\n");

    // re-run: no-op (both or neither state unchanged)
    writeFileSync(legacy, "line1\n");
    migrateLegacyLog(legacy, target);
    assert.equal(readFileSync(target, "utf8"), "line1\n"); // untouched
    assert.ok(existsSync(legacy)); // kept, target wins

    // identical paths: no-op
    migrateLegacyLog(target, target);
    assert.equal(readFileSync(target, "utf8"), "line1\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- csv ----------

test("csvRow: semicolon-separated fields in CSV_COLUMNS order", () => {
  const e = buildLogEntry(createSessionStats("s1", sample(0, 200)), CFG, 60_000, "quit");
  const cells = csvRow(e).split(";");
  assert.equal(cells.length, CSV_COLUMNS.length);
  assert.equal(cells[0], "s1");
  assert.equal(cells[1], e.startedAt);
  assert.equal(cells[11], String(e.cost));
  assert.equal(cells[13], "quit");
});

test("csvRow: quotes cells containing separators or quotes", () => {
  const e = buildLogEntry(createSessionStats("s1", sample(0, 200)), CFG, 60_000, 'quit "a"; reload');
  assert.ok(csvRow(e).endsWith('"quit ""a""; reload"'));
});

test("appendCsvRow: header once, CRLF rows, creates dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "gpu-cost-csv-"));
  try {
    const p = join(dir, "nested", "log.csv");
    appendCsvRow(p, buildLogEntry(createSessionStats("a", sample(0, 100)), CFG, 60_000, "quit"));
    appendCsvRow(p, buildLogEntry(createSessionStats("b", sample(0, 100)), CFG, 60_000, "reload"));
    const raw = readFileSync(p, "utf8");
    const lines = raw.split("\r\n");
    assert.equal(lines.length, 4); // header + 2 rows + trailing "" after final CRLF
    assert.equal(lines[0], CSV_COLUMNS.join(";"));
    assert.ok(lines[1]!.startsWith("a;"), lines[1]);
    assert.ok(lines[2]!.startsWith("b;"), lines[2]);
    assert.equal(lines[3], "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendCsvRow: does not duplicate an existing header", () => {
  const dir = mkdtempSync(join(tmpdir(), "gpu-cost-csv-"));
  try {
    const p = join(dir, "log.csv");
    writeFileSync(p, CSV_COLUMNS.join(";") + "\r\nx;1\n");
    appendCsvRow(p, buildLogEntry(createSessionStats("a", sample(0, 100)), CFG, 60_000, "quit"));
    const raw = readFileSync(p, "utf8");
    const headerCount = raw.split(CSV_COLUMNS.join(";")).length - 1;
    assert.equal(headerCount, 1, raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backfillCsvFromJsonl: converts existing JSONL once, no-op afterwards", () => {
  const dir = mkdtempSync(join(tmpdir(), "gpu-cost-csv-"));
  try {
    const jsonl = join(dir, "log.jsonl");
    const csv = join(dir, "log.csv");
    const l1 = entryLine({ sessionId: "a", energyWh: 100 });
    const l2 = entryLine({ sessionId: "b", energyWh: 200 });
    writeFileSync(jsonl, [l1, l2, "not json"].join("\n") + "\n");

    backfillCsvFromJsonl(jsonl, csv);
    const first = readFileSync(csv, "utf8");
    const lines = first.split("\r\n");
    assert.equal(lines[0], CSV_COLUMNS.join(";"));
    assert.ok(lines[1]!.startsWith("a;"), lines[1]);
    assert.ok(lines[2]!.startsWith("b;"), lines[2]);

    // re-run: no-op (CSV exists)
    backfillCsvFromJsonl(jsonl, csv);
    assert.equal(readFileSync(csv, "utf8"), first);

    // missing jsonl: no-op
    backfillCsvFromJsonl(join(dir, "nope.jsonl"), join(dir, "other.csv"));
    assert.ok(!existsSync(join(dir, "other.csv")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- monthly ----------

test("readMonthlyTotals: groups by local month, newest first, sums energy and cost", () => {
  const dir = mkdtempSync(join(tmpdir(), "gpu-cost-mon-"));
  try {
    const a = join(dir, "a.jsonl");
    writeFileSync(
      a,
      [
        entryLine({ startedAt: "2026-08-01T10:00:00.000Z", energyWh: 100, cost: 0.0282 }),
        entryLine({ startedAt: "2026-08-30T10:00:00.000Z", energyWh: 50, cost: 0.0141 }),
        entryLine({ startedAt: "2026-07-15T10:00:00.000Z", energyWh: 200, cost: 0.0564 }),
        entryLine({ startedAt: "2026-06-02T10:00:00.000Z", energyWh: 10, cost: 0.0028 }),
        "not json",
        JSON.stringify({ startedAt: "2026-05-01T10:00:00.000Z" }), // no energyWh — skipped
      ].join("\n") + "\n",
    );
    const months = readMonthlyTotals([a]);
    assert.deepEqual(months.map((m) => m.month), ["2026-08", "2026-07", "2026-06"]);
    assert.equal(months[0]!.sessions, 2);
    assert.ok(Math.abs(months[0]!.wh - 150) < 1e-9);
    assert.ok(Math.abs(months[0]!.cost - 0.0423) < 1e-9);
    assert.ok(Math.abs(months[2]!.cost - 0.0028) < 1e-9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readMonthlyTotals: dedupes across files, honors limit, missing files fine", () => {
  const dir = mkdtempSync(join(tmpdir(), "gpu-cost-mon-"));
  try {
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    writeFileSync(a, entryLine({ startedAt: "2026-08-01T10:00:00.000Z", energyWh: 100, cost: 0.03 }) + "\n");
    writeFileSync(b, entryLine({ startedAt: "2026-08-01T10:00:00.000Z", energyWh: 100, cost: 0.03 }) + "\n"); // dup
    const months = readMonthlyTotals([a, b, join(dir, "nope.jsonl")]);
    assert.equal(months.length, 1);
    assert.equal(months[0]!.sessions, 1);

    writeFileSync(
      a,
      [
        entryLine({ startedAt: "2026-01-01T10:00:00.000Z", energyWh: 1, cost: 0.001 }),
        entryLine({ startedAt: "2026-02-01T10:00:00.000Z", energyWh: 1, cost: 0.001 }),
        entryLine({ startedAt: "2026-03-01T10:00:00.000Z", energyWh: 1, cost: 0.001 }),
      ].join("\n"),
    );
    assert.deepEqual(readMonthlyTotals([a], 2).map((m) => m.month), ["2026-03", "2026-02"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
