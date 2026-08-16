/**
 * End-to-end smoke test: loads the extension the way pi does (via jiti) and
 * runs the full lifecycle against the real nvidia-smi on this machine.
 * Skipped automatically when no NVIDIA GPU / nvidia-smi is available.
 */
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";

function hasNvidiaSmi(): boolean {
  try {
    execFileSync(
      "nvidia-smi",
      ["--query-gpu=power.draw", "--format=csv,noheader,nounits"],
      { timeout: 8000, stdio: "pipe" },
    );
    return true;
  } catch {
    return false;
  }
}

const smiAvailable = hasNvidiaSmi();
const smoke = smiAvailable ? test : test.skip;

smoke("extension lifecycle against real nvidia-smi", async () => {
  // Isolated env: temp data dir, fast sampling, known rate.
  const dataDir = mkdtempSync(join(tmpdir(), "gpu-cost-smoke-"));
  const prevEnv = { ...process.env };
  process.env.GPU_COST_DIR = dataDir;
  process.env.GPU_COST_INTERVAL_MS = "500";
  process.env.GPU_COST_RATE = "0.282";
  process.env.GPU_COST_CURRENCY = "€";
  delete process.env.GPU_COST_IDLE_WATTS;

  try {
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    const mod = (await jiti.import("../extensions/gpu-cost/index.ts")) as {
      default: (pi: unknown) => void;
    };

    // Mock the pi surface the extension touches.
    const statuses: Array<string | undefined> = [];
    const notifications: string[] = [];
    const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
    const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};

    const ctx = {
      hasUI: true,
      mode: "tui",
      cwd: process.cwd(),
      ui: {
        notify: (m: string) => notifications.push(m),
        setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      },
      sessionManager: { getSessionId: () => "smoke-session-123" },
    };

    mod.default({
      on: (event: string, h: (event: unknown, ctx: unknown) => void) => (handlers[event] = h),
      registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
        (commands[name] = opts),
    } as never);

    assert.equal(typeof handlers.session_start, "function");
    assert.equal(typeof handlers.session_shutdown, "function");
    assert.equal(typeof commands.gpucost?.handler, "function");

    // --- session_start: first sample should land quickly ---
    handlers.session_start!({ type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => statuses.length > 0, 10_000);
    const firstStatus = statuses[0];
    assert.ok(firstStatus, "expected a footer status");
    assert.ok(firstStatus.startsWith("⚡ "), firstStatus);

    // --- let it sample for a few intervals ---
    await new Promise((r) => setTimeout(r, 4000));
    assert.ok(statuses.length >= 3, `expected repeated footer updates, got ${statuses.length}`);

    // --- /gpucost while running ---
    await commands.gpucost!.handler("", ctx);
    const cmdOut = notifications[notifications.length - 1];
    assert.ok(cmdOut, "expected /gpucost notification");
    assert.ok(cmdOut.includes("this session ("), cmdOut);
    assert.ok(cmdOut.includes("avg"), cmdOut);
    assert.ok(cmdOut.includes("rate: 0.282 €/kWh"), cmdOut);

    // --- session_shutdown: final entry in log.jsonl ---
    handlers.session_shutdown!({ type: "session_shutdown", reason: "quit" }, ctx);
    await waitUntil(() => existsSync(join(dataDir, "log.jsonl")), 5000);

    const logPath = join(dataDir, "log.jsonl");
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, `expected one log line, got: ${lines.join(" | ")}`);
    const e = JSON.parse(lines[0]!);

    assert.equal(e.sessionId, "smoke-session-123");
    assert.equal(e.reason, "quit");
    assert.ok(e.samples >= 3, `samples=${e.samples}`);
    assert.ok(e.energyWh > 0, `energyWh=${e.energyWh}`);
    assert.ok(e.avgWatts > 0 && e.peakWatts >= e.avgWatts);
    // cost must be Wh/1000 × rate — the regression the user reported.
    // (No lower bound: an idle 4090 at ~18 W over ~5 s legitimately costs <€0.0001.)
    assert.ok(Math.abs(e.cost - (e.energyWh / 1000) * 0.282) < 1e-5, `cost=${e.cost} wh=${e.energyWh}`);

    // quit notification fired
    const quitNote = notifications.find((n) => n.startsWith("gpu-cost: "));
    assert.ok(quitNote, `notifications: ${JSON.stringify(notifications)}`);
    assert.ok(quitNote.includes("min"), quitNote);

    // footer cleared on shutdown
    assert.equal(statuses[statuses.length - 1], undefined);
  } finally {
    // restore env, clean up
    for (const k of Object.keys(process.env)) if (!(k in prevEnv)) delete process.env[k];
    Object.assign(process.env, prevEnv);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

smoke("second run appends to the same log (today totals see both)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gpu-cost-smoke-"));
  const prevEnv = { ...process.env };
  process.env.GPU_COST_DIR = dataDir;
  process.env.GPU_COST_INTERVAL_MS = "500";
  process.env.GPU_COST_RATE = "0.282";

  try {
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    const mod = (await jiti.import("../extensions/gpu-cost/index.ts")) as {
      default: (pi: unknown) => void;
    };

    const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
    let commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> | undefined;
    const ctx = {
      hasUI: true,
      ui: { notify: () => {}, setStatus: () => {} },
      sessionManager: { getSessionId: () => "smoke-session-456" },
    };
    mod.default({
      on: (event: string, h: (event: unknown, ctx: unknown) => void) => (handlers[event] = h),
      registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        if (!commands) commands = {};
        commands[name] = opts;
      },
    } as never);

    // start, let it sample, THEN shut down (startSampling is async — the
    // sampler is only registered after the first nvidia-smi query resolves)
    handlers.session_start!({ type: "session_start", reason: "startup" }, ctx);
    await new Promise((r) => setTimeout(r, 2000));
    assert.ok(commands, "command not registered");
    await commands.gpucost!.handler("", ctx); // today-totals path (sees nothing yet)
    handlers.session_shutdown!({ type: "session_shutdown", reason: "quit" }, ctx);
    await waitUntil(() => existsSync(join(dataDir, "log.jsonl")), 5000);

    const lines = readFileSync(join(dataDir, "log.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const e = JSON.parse(lines[0]!);
    assert.equal(e.sessionId, "smoke-session-456");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prevEnv)) delete process.env[k];
    Object.assign(process.env, prevEnv);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function waitUntil(pred: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const id = setInterval(() => {
      if (pred()) {
        clearInterval(id);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(id);
        reject(new Error("timeout waiting for condition"));
      }
    }, 50);
  });
}
