import type http from "node:http";
import { isIPv4, isIPv6 } from "node:net";

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

/** The eight 16-bit groups of a valid IPv6 address (`::` expanded, an embedded dotted IPv4 tail converted). */
function ipv6Groups(ip: string): number[] {
  let s = ip;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4[1].split(".").map(Number);
    s = `${s.slice(0, -v4[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  return [...h, ...Array<string>(fill).fill("0"), ...t].map((g) => parseInt(g, 16));
}

/** `ipKey` of `raw`, or `null` when it is not an IP address. Accepts a proxy's `a.b.c.d:port` and `[v6]:port`
 *  forms, dropping the port. */
function ipKeyOf(raw: string): string | null {
  let ip = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1];
  const v4WithPort = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(ip);
  if (v4WithPort) ip = v4WithPort[1];
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return null;
  const g = ipv6Groups(ip);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join(".");
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/** The key per-IP limits count against: an IPv4 address as is (IPv4-mapped IPv6 unwrapped to it), an IPv6 address
 *  by its /64 -- one subscriber's allocation, which is free to rotate through -- and anything else verbatim. */
export function ipKey(raw: string): string {
  return ipKeyOf(raw) ?? raw;
}

/** The client key for `req`: the socket's peer address, or -- only with `trustProxy`, when a reverse proxy in front
 *  of this server appends the address it saw -- the right-most `X-Forwarded-For` entry. Entries to its left were
 *  written by the client and prove nothing. */
export function clientKey(req: http.IncomingMessage, trustProxy: boolean): string {
  const socketIp = req.socket.remoteAddress ?? "?";
  if (trustProxy) {
    const raw = req.headers["x-forwarded-for"];
    const joined = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
    const last = joined
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e !== "")
      .at(-1);
    const proxied = last === undefined ? null : ipKeyOf(last);
    if (proxied !== null) return proxied;
  }
  return ipKey(socketIp);
}
