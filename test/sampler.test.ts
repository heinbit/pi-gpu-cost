import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_EXTRAPOLATE_MS, type Config, type Sample } from "../extensions/gpu-cost/lib.ts";
import { GpuSampler } from "../extensions/gpu-cost/sampler.ts";

const CFG: Config = { ratePerKwh: 0.282, currency: "€", intervalMs: 5000, idleWatts: 0 };

function sample(t: number, watts: number, util = 50): Sample {
  return { t, watts, util, memMb: 1000, gpuCount: 1, tempC: 0, memTotalMb: 0, name: "" };
}

/** Scripted query: returns queued results, or `fail` forever when empty. */
function scripted(queued: Array<Sample | null>, now: () => number) {
  let i = 0;
  return async () => {
    if (i < queued.length) return queued[i++] ?? null;
    return null;
  };
}

test("start: no GPU -> null, no stats", async () => {
  const s = new GpuSampler(CFG, "s1", { query: scripted([], () => 0) });
  assert.equal(await s.start(), null);
  assert.equal(s.stats, null);
});

test("start + ticks: energy integrates at real intervals", async () => {
  let t = 1_000_000;
  const now = () => t;
  const s = new GpuSampler(CFG, "s1", {
    query: scripted([sample(t, 200), sample(t += 5000, 200), sample(t += 5000, 300)], now),
    now,
  });
  const first = await s.start();
  assert.ok(first);
  assert.equal(s.stats!.count, 1);
  assert.equal(s.stats!.energyJ, 0);

  await s.tick(); // 200 W × 5 s = 1000 J
  assert.equal(s.stats!.count, 2);
  assert.ok(Math.abs(s.stats!.energyJ - 1000) < 1e-9);

  await s.tick(); // 300 W × 5 s = 1500 J
  assert.equal(s.stats!.count, 3);
  assert.ok(Math.abs(s.stats!.energyJ - 2500) < 1e-9);
  assert.equal(s.stats!.peakWatts, 300);
  assert.equal(s.stats!.failed, 0);
});

test("failed ticks extrapolate at last known watts, then cap", async () => {
  let t = 1_000_000;
  const now = () => t;
  const s = new GpuSampler(CFG, "s1", {
    // first sample ok, then failures forever
    query: scripted([sample(t, 200)], now),
    now,
  });
  assert.ok(await s.start());

  // 5 failed ticks × 5 s = 25 s extrapolated at 200 W
  for (let i = 0; i < 5; i++) {
    t += 5000;
    assert.equal(await s.tick(), null);
  }
  assert.equal(s.stats!.failed, 5);
  assert.ok(Math.abs(s.stats!.energyJ - 200 * 25) < 1e-9, `energyJ=${s.stats!.energyJ}`);

  // tick 6: 25 s + 5 s -> hits the 30 s cap exactly
  t += 5000;
  await s.tick();
  assert.ok(Math.abs(s.stats!.energyJ - 200 * 30) < 1e-9);

  // ticks beyond the cap contribute nothing
  t += 5000;
  await s.tick();
  assert.ok(Math.abs(s.stats!.energyJ - 200 * 30) < 1e-9);
  assert.equal(s.stats!.failed, 7);
});

test("recovery after outage resets extrapolation budget", async () => {
  let t = 1_000_000;
  const now = () => t;
  let mode: "ok" | "fail" = "ok";
  const s = new GpuSampler(CFG, "s1", {
    query: async () => {
      if (mode === "ok") return sample(t, 200);
      return null;
    },
    now,
  });
  assert.ok(await s.start()); // 200 W at t0
  mode = "fail";

  // 7 failed ticks (35 s > 30 s cap) -> 6000 J extrapolated
  for (let i = 0; i < 7; i++) {
    t += 5000;
    await s.tick();
  }
  assert.ok(Math.abs(s.stats!.energyJ - 6000) < 1e-9);

  // recovery after 5 s: full 200 W × 5 s = 1000 J counted again (budget reset)
  t += 5000;
  mode = "ok";
  await s.tick();
  assert.ok(Math.abs(s.stats!.energyJ - 7000) < 1e-9);
  assert.equal(s.stats!.failed, 7); // failed ticks never increment count
  assert.equal(s.stats!.count, 2);
});

test("idleWatts clamps extrapolation at zero too", async () => {
  const cfg: Config = { ...CFG, idleWatts: 250 };
  let t = 0;
  const now = () => t;
  const s = new GpuSampler(cfg, "s1", {
    query: scripted([sample(0, 200)], now),
    now,
  });
  assert.ok(await s.start());
  t += 10_000;
  await s.tick(); // 200 W < 250 W idle -> 0 J
  assert.equal(s.stats!.energyJ, 0);
  assert.equal(s.stats!.failed, 1);
});

test("concurrent ticks are skipped, not stacked", async () => {
  let t = 0;
  const now = () => t;
  let call = 0;
  let release: (() => void) | undefined;
  const s = new GpuSampler(CFG, "s1", {
    query: async () => {
      call++;
      if (call === 2) {
        // hold the first tick open to simulate a slow nvidia-smi
        await new Promise<void>((r) => (release = r));
      }
      return sample(t, 200);
    },
    now,
  });
  assert.ok(await s.start()); // call 1, un-gated

  // two overlapping ticks: second must be skipped
  const p1 = s.tick(); // call 2 — held open
  const p2 = s.tick(); // in-flight guard -> immediate null
  t += 5000;
  assert.equal(typeof release, "function");
  release!();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.ok(r1); // first completed
  assert.equal(r2, null); // second skipped
  assert.equal(s.stats!.count, 2); // exactly one integration
});

test("begin/stop: interval timer drives ticks (real timers)", async () => {
  const s = new GpuSampler(CFG, "s1", { query: async () => sample(Date.now(), 200) });
  assert.ok(await s.start());
  s.begin(30);
  assert.equal(s.running, true);
  await new Promise((r) => setTimeout(r, 200));
  s.stop();
  assert.equal(s.running, false);
  const afterStop = s.stats!.count;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.stats!.count, afterStop);
  assert.ok(s.stats!.count >= 3, `count=${s.stats!.count}`);
});

test("onSample callback fires for successes and failures", async () => {
  let t = 0;
  const seen: Array<Sample | null> = [];
  const s = new GpuSampler(CFG, "s1", {
    query: scripted([sample(0, 200), null, sample(10_000, 200)], () => t),
    now: () => t,
    onSample: (x) => seen.push(x),
  });
  assert.ok(await s.start());
  t += 5000;
  await s.tick(); // failure
  t += 5000;
  await s.tick(); // success
  assert.deepEqual(seen.map((x) => (x ? x.watts : null)), [null, 200]);
});

test("MAX_EXTRAPOLATE_MS is a sane bound", () => {
  assert.ok(MAX_EXTRAPOLATE_MS >= 10_000 && MAX_EXTRAPOLATE_MS <= 60_000);
});
