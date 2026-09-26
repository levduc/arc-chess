type Bucket = { tokens: number; last: number };

// drop a key's bucket once it has sat fully refilled this long, to bound memory
const IDLE_FULL_MS = 10 * 60 * 1000;
// how often `take` bothers to walk the whole map looking for buckets to drop
const SWEEP_INTERVAL_MS = 60 * 1000;

/** A token-bucket rate limiter, one bucket per key. `now` is injectable (ms) for deterministic tests. */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private lastSweep = 0;

  constructor(
    private readonly burst: number,
    private readonly perSec: number,
    now: () => number = Date.now,
  ) {
    this.now = now;
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Returns false (limited) when fewer than 1 token remains for `key`; otherwise consumes one and returns true. */
  take(key: string): boolean {
    const t = this.now();
    if (t - this.lastSweep >= SWEEP_INTERVAL_MS) this.sweep(t);
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, last: t };
      this.buckets.set(key, b);
    } else {
      const elapsedSec = Math.max(0, t - b.last) / 1000;
      b.tokens = Math.min(this.burst, b.tokens + elapsedSec * this.perSec);
      b.last = t;
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Drops buckets that reached full (burst) more than IDLE_FULL_MS ago, without touching live ones. */
  private sweep(t: number): void {
    this.lastSweep = t;
    for (const [key, b] of this.buckets) {
      const idleMs = t - b.last;
      const missing = this.burst - b.tokens;
      // time it took (or would take) to refill from `b.last` up to a full bucket; Infinity if it never refills
      const refillMs = this.perSec > 0 ? (missing / this.perSec) * 1000 : missing <= 0 ? 0 : Infinity;
      if (idleMs - refillMs > IDLE_FULL_MS) this.buckets.delete(key);
    }
  }
}
