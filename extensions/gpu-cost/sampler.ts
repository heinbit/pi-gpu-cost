/**
 * GpuSampler — one session's sampling lifecycle as a small state machine.
 *
 * The core (start/tick/stop) is timer-free and deterministic: the clock and
 * the GPU query are injected, so tests can script samples and time. index.ts
 * adds the real interval timer around it.
 */
import {
  MAX_EXTRAPOLATE_MS,
  type Config,
  type Sample,
  type SessionStats,
  createSessionStats,
  extrapolateEnergy,
  integrateSample,
} from "./lib.ts";

export interface SamplerDeps {
  /** performs one GPU query; null on failure */
  query: () => Promise<Sample | null>;
  /** clock (defaults to Date.now) — injected for tests */
  now?: () => number;
  /** called after every tick with the sample (or null on failure) */
  onSample?: (sample: Sample | null) => void;
}

export class GpuSampler {
  readonly sessionId: string;
  /** null until start() succeeds */
  stats: SessionStats | null = null;
  /** most recent successful sample (for on-demand lookups like /gpucost) */
  last: Sample | null = null;

  private readonly cfg: Config;
  private readonly query: () => Promise<Sample | null>;
  private readonly now: () => number;
  private readonly onSample?: (sample: Sample | null) => void;
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private lastWatts: number | null = null;
  private extrapolatedMs = 0;

  constructor(cfg: Config, sessionId: string, deps: SamplerDeps) {
    this.cfg = cfg;
    this.sessionId = sessionId;
    this.query = deps.query;
    this.now = deps.now ?? Date.now;
    this.onSample = deps.onSample;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Perform the first query and seed the session stats.
   * Returns the first sample, or null when no GPU is available.
   */
  async start(): Promise<Sample | null> {
    const first = await this.query();
    if (!first) return null;
    this.stats = createSessionStats(this.sessionId, first);
    this.last = first;
    this.lastWatts = first.watts;
    return first;
  }

  /** Start the interval timer (idempotent). */
  begin(intervalMs: number): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  /**
   * One sampling tick. Concurrency-safe: a tick already in flight (slow
   * nvidia-smi) is skipped instead of stacking execFile calls.
   */
  async tick(): Promise<Sample | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    try {
      return await this.tickCore();
    } finally {
      this.inFlight = false;
    }
  }

  private async tickCore(): Promise<Sample | null> {
    const sample = await this.query();
    if (sample) {
      if (this.stats) {
        integrateSample(this.stats, sample, this.cfg);
      }
      this.last = sample;
      this.lastWatts = sample.watts;
      this.extrapolatedMs = 0;
      this.onSample?.(sample);
      return sample;
    }

    // Failed tick: count it, and keep integrating at the last known wattage
    // for up to MAX_EXTRAPOLATE_MS so brief nvidia-smi hiccups don't undercount.
    const now = this.now();
    if (this.stats) {
      this.stats.failed++;
      if (this.lastWatts !== null) {
        const dtMs = Math.max(0, now - this.stats.lastT);
        this.stats.energyJ += extrapolateEnergy(this.lastWatts, this.cfg.idleWatts, dtMs, this.extrapolatedMs);
        this.extrapolatedMs = Math.min(MAX_EXTRAPOLATE_MS, this.extrapolatedMs + dtMs);
      }
      this.stats.lastT = now;
    }
    this.onSample?.(null);
    return null;
  }

  /** Stop the interval timer (idempotent). */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
