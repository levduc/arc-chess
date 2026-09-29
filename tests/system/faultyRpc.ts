/**
 * Plan 4.5 Task 10: a faulty JSON-RPC proxy in front of a stack's own Anvil. A daemon (or the server) whose `rpcUrl`
 * points here sees every request forwarded to Anvil, except that a seeded PRNG decides, per request and per method,
 * whether to inject one of these faults instead:
 *
 * - `reset`: the TCP connection is destroyed without a response (viem: "fetch failed", retried);
 * - `http500`: an HTTP 500 (viem retries it);
 * - `rpcError`: a JSON-RPC error response `-32000 header not found`, as a load-balanced node behind on its head
 *   returns (viem does NOT retry it: it reaches the caller);
 * - `delay`: the request is held for `delayMs` (default 11 s, beyond viem's 10 s default timeout), then the
 *   connection is dropped.
 *
 * Every fault is injected INSTEAD of forwarding, never after: the request never reaches Anvil. A fault after
 * forwarding (a lost response) would turn viem's transparent retry of `eth_sendRawTransaction` into a "nonce too low"
 * error for a transaction that did land, which is a different scenario from "the RPC is flaky".
 *
 * Two always-on modes model real providers rather than outages:
 * - `getLogsMaxRange`: an `eth_getLogs` over more than N blocks is refused with the standard "query exceeds max
 *   block range N" error (JSON-RPC -32602, not retried by viem);
 * - `lagBlocks` (lagging head): `eth_blockNumber` reports the real head, but `eth_getLogs` serves logs only up to
 *   `head - K` -- a load-balanced provider whose log index runs K blocks behind the head it reports. A range that
 *   starts past `head - K` returns `[]`, one that ends past it is clamped.
 *
 * The PRNG seed is logged at start so a failing run reproduces with the same seed (the fault sequence also depends
 * on request arrival order, which real processes make only approximately reproducible).
 */
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { mulberry32 } from "./bot.js";

export type FaultKind = "reset" | "http500" | "rpcError" | "delay";
export const FAULT_KINDS: readonly FaultKind[] = ["reset", "http500", "rpcError", "delay"];

/** Per-kind probability for one request (each in [0, 1]; their sum is the request's total fault probability). */
export type MethodFaults = Partial<Record<FaultKind, number>>;

export type Faults = {
  /** Per-method fault probabilities; `"*"` applies to every method without its own entry. */
  methods?: Record<string, MethodFaults>;
  /** How long a `delay` fault holds a request before dropping it (default 11 000 ms). */
  delayMs?: number;
  /** `eth_getLogs` block-range cap (inclusive span); unset = no cap. */
  getLogsMaxRange?: number;
  /** Lagging-head depth K: `eth_getLogs` serves nothing newer than `head - K`; unset or 0 = no lag. */
  lagBlocks?: number;
};

export type FaultyRpcStats = {
  requests: number;
  forwarded: number;
  byMethod: Record<string, number>;
  injected: Record<FaultKind, number>;
  injectedByMethod: Record<string, Partial<Record<FaultKind, number>>>;
  /** `eth_getLogs` calls refused by the range cap. */
  rangeErrors: number;
  /** `eth_getLogs` calls clamped or emptied by the lagging head. */
  lagged: number;
  /** Largest `eth_getLogs` span (toBlock - fromBlock + 1) seen, before any clamp. */
  maxGetLogsSpan: number;
};

export type FaultyRpc = {
  url: string;
  seed: number;
  setFaults(f: Faults): void;
  stats: FaultyRpcStats;
  /** Zeroes every counter (e.g. after a setup phase run without faults). */
  resetStats(): void;
  stop(): Promise<void>;
};

type RpcReq = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown[] };

function emptyStats(): FaultyRpcStats {
  return {
    requests: 0,
    forwarded: 0,
    byMethod: {},
    injected: { reset: 0, http500: 0, rpcError: 0, delay: 0 },
    injectedByMethod: {},
    rangeErrors: 0,
    lagged: 0,
    maxGetLogsSpan: 0,
  };
}

const HEX_BLOCK = /^0x[0-9a-fA-F]+$/;

export async function startFaultyRpc(target: string, opts: { seed?: number; faults?: Faults; label?: string } = {}): Promise<FaultyRpc> {
  const seed = opts.seed ?? (Date.now() & 0x7fffffff);
  const label = opts.label ?? "faulty-rpc";
  console.log(`[${label}] seed=${seed} target=${target}`);
  const rand = mulberry32(seed);
  let faults: Faults = opts.faults ?? {};
  const stats: FaultyRpcStats = emptyStats();
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();

  async function upstream(body: unknown): Promise<unknown> {
    stats.forwarded++;
    const res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async function realHead(): Promise<bigint> {
    const r = (await upstream({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] })) as { result: string };
    return BigInt(r.result);
  }

  /** Resolves a getLogs block tag against `head`; undefined for a tag it cannot place (then no cap/lag applies). */
  function blockOf(tag: unknown, head: bigint): bigint | undefined {
    if (tag === undefined || tag === "latest" || tag === "pending" || tag === "safe" || tag === "finalized") return head;
    if (tag === "earliest") return 0n;
    if (typeof tag === "string" && HEX_BLOCK.test(tag)) return BigInt(tag);
    return undefined;
  }

  /** One JSON-RPC call (never a transport fault here: those are decided per HTTP request). */
  async function handleOne(req: RpcReq): Promise<unknown> {
    const method = req.method ?? "?";
    if (method !== "eth_getLogs") return upstream(req);
    const filter = (Array.isArray(req.params) ? req.params[0] : undefined) as Record<string, unknown> | undefined;
    if (!filter || filter.blockHash !== undefined) return upstream(req);
    const cap = faults.getLogsMaxRange;
    const lag = BigInt(faults.lagBlocks ?? 0);
    const head = await realHead();
    const from = blockOf(filter.fromBlock, head);
    const to = blockOf(filter.toBlock, head);
    if (from === undefined || to === undefined) return upstream(req);
    const span = Number(to - from + 1n);
    if (span > stats.maxGetLogsSpan) stats.maxGetLogsSpan = span;
    if (cap !== undefined && span > cap) {
      stats.rangeErrors++;
      return { jsonrpc: "2.0", id: req.id, error: { code: -32602, message: `query exceeds max block range ${cap}` } };
    }
    if (lag > 0n) {
      const visible = head - lag;
      if (from > visible) {
        stats.lagged++;
        return { jsonrpc: "2.0", id: req.id, result: [] };
      }
      if (to > visible) {
        stats.lagged++;
        return upstream({ ...req, params: [{ ...filter, toBlock: `0x${visible.toString(16)}` }] });
      }
    }
    return upstream(req);
  }

  /** Picks at most one fault for a request calling `methods` (a batch uses the most fault-prone of its methods). */
  function pickFault(methods: string[]): FaultKind | undefined {
    const table = faults.methods ?? {};
    let probs: MethodFaults = {};
    let best = -1;
    for (const m of methods) {
      const p = table[m] ?? table["*"] ?? {};
      const total = FAULT_KINDS.reduce((acc, k) => acc + (p[k] ?? 0), 0);
      if (total > best) {
        best = total;
        probs = p;
      }
    }
    // One draw per request, even when no fault is configured, so the sequence of draws depends only on the seed
    // and on how many requests arrived -- not on which fault table was active at the time.
    const r = rand();
    let acc = 0;
    for (const k of FAULT_KINDS) {
      acc += probs[k] ?? 0;
      if (r < acc) return k;
    }
    return undefined;
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        stats.requests++;
        let parsed: RpcReq | RpcReq[];
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RpcReq | RpcReq[];
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
          return;
        }
        const calls = Array.isArray(parsed) ? parsed : [parsed];
        const methods = calls.map((c) => c.method ?? "?");
        for (const m of methods) stats.byMethod[m] = (stats.byMethod[m] ?? 0) + 1;
        const fault = pickFault(methods);
        if (fault) {
          stats.injected[fault]++;
          for (const m of methods) {
            const per = (stats.injectedByMethod[m] ??= {});
            per[fault] = (per[fault] ?? 0) + 1;
          }
          if (fault === "reset") {
            req.socket.destroy();
            return;
          }
          if (fault === "http500") {
            res.writeHead(500, { "content-type": "text/plain" });
            res.end("Internal Server Error");
            return;
          }
          if (fault === "rpcError") {
            const errs = calls.map((c) => ({ jsonrpc: "2.0", id: c.id ?? null, error: { code: -32000, message: "header not found" } }));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(Array.isArray(parsed) ? errs : errs[0]));
            return;
          }
          // delay: hold past the client's timeout, then drop the connection (never forwarded)
          const t = setTimeout(() => {
            timers.delete(t);
            req.socket.destroy();
          }, faults.delayMs ?? 11_000);
          timers.add(t);
          return;
        }
        try {
          const out = Array.isArray(parsed) ? await Promise.all(calls.map(handleOne)) : await handleOne(parsed);
          const text = JSON.stringify(out);
          res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
          res.end(text);
        } catch (err) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: `faulty-rpc: upstream failed: ${String(err)}` } }));
        }
      })();
    });
  });
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    seed,
    setFaults(f: Faults) {
      faults = f;
    },
    stats,
    resetStats() {
      Object.assign(stats, emptyStats());
    },
    async stop() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
