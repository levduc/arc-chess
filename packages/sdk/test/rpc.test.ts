/**
 * Plan 6 hardening H3 (rate-limit resilience): the arena's RPC transport and its error classes, against a fake
 * `fetch` behind viem's real HTTP transport -- so every error here has the exact shape viem gives a caller in
 * production (Arc testnet rehearsal §8.1, §8.2).
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import {
  RPC_RETRY_AFTER_MAX_S,
  RPC_RETRY_COUNT,
  RPC_RETRY_DELAY_MS,
  cappedRetryAfter,
  isRangeRefusal,
  isRateLimited,
  isRpcError,
  rpcErrorSummary,
  rpcTransport,
} from "../src/index.js";

const URL_ = "http://rpc.invalid";
type Answer = { result: unknown } | { error: { code: number; message: string } } | { status: number; headers?: Record<string, string> };

/** A fake RPC: `answer(method, call)` decides each HTTP request's reply (`call` counts that method's requests from 0). */
function fakeRpc(answer: (method: string, call: number) => Answer) {
  const calls: string[] = [];
  const fetchFn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string };
    const call = calls.filter((m) => m === req.method).length;
    calls.push(req.method);
    const a = answer(req.method, call);
    if ("status" in a) return new Response(a.status === 429 ? "Too Many Requests" : "Bad Gateway", { status: a.status, headers: a.headers });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, ...a }), { headers: { "content-type": "application/json" } });
  };
  return { calls, fetchFn };
}

const RATE_LIMIT = { error: { code: -32005, message: "rate limit exceeded" } };
const TOO_MANY = { status: 429 };

/** The error a read through `rpcTransport` (no retries) fails with, for `answer`. */
async function errorOf(a: Answer, method: "eth_blockNumber" | "eth_getLogs" = "eth_blockNumber"): Promise<unknown> {
  const { fetchFn } = fakeRpc(() => a);
  const client = createPublicClient({ transport: rpcTransport(URL_, { fetchFn, retryCount: 0 }) });
  const p = method === "eth_blockNumber" ? client.getBlockNumber({ cacheTime: 0 }) : client.getLogs({ fromBlock: 1n, toBlock: 2n });
  return p.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e,
  );
}

describe("H3: isRateLimited / isRangeRefusal on viem's own errors", () => {
  it("Arc's -32005 'rate limit exceeded' (viem: 'Request exceeds defined limit.') is a rate limit, never a refusal", async () => {
    const err = await errorOf(RATE_LIMIT, "eth_getLogs");
    expect((err as Error).name).toBe("LimitExceededRpcError");
    expect((err as Error).message).toMatch(/Request exceeds defined limit/);
    expect(isRateLimited(err)).toBe(true);
    expect(isRangeRefusal(err)).toBe(false);
  });

  it("an HTTP 429 is a rate limit, never a refusal", async () => {
    const err = await errorOf(TOO_MANY, "eth_getLogs");
    expect(isRateLimited(err)).toBe(true);
    expect(isRangeRefusal(err)).toBe(false);
  });

  it("Arc's -32012 'requested range too large' is a refusal", async () => {
    const err = await errorOf({ error: { code: -32012, message: "requested range too large" } }, "eth_getLogs");
    expect(isRangeRefusal(err)).toBe(true);
    expect(isRateLimited(err)).toBe(false);
  });

  it("a -32005 whose words are a result-count limit (Infura's) is a refusal, not a rate limit", async () => {
    const err = await errorOf({ error: { code: -32005, message: "query returned more than 10000 results" } }, "eth_getLogs");
    expect(isRangeRefusal(err)).toBe(true);
    expect(isRateLimited(err)).toBe(false);
  });

  it("other refusal wordings: a block range, a response size", async () => {
    for (const message of ["query exceeds max block range 100000", "Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range"]) {
      expect(isRangeRefusal(await errorOf({ error: { code: -32602, message } }, "eth_getLogs"))).toBe(true);
    }
  });

  it("a response over the client's size limit is a refusal", async () => {
    const { fetchFn } = fakeRpc(() => ({ result: [] }));
    const client = createPublicClient({ transport: http(URL_, { fetchFn, retryCount: 0, maxResponseBodySize: 8 }) });
    const err = await client.getLogs({ fromBlock: 1n, toBlock: 2n }).catch((e: unknown) => e);
    expect(isRangeRefusal(err)).toBe(true);
  });

  it("a 5xx, an internal error, a timeout, a network failure: neither -- retried on the same range, uncounted", async () => {
    const errs = [
      await errorOf({ status: 503 }),
      await errorOf({ status: 502 }),
      await errorOf({ error: { code: -32603, message: "internal error" } }),
      new Error("fetch failed"),
    ];
    const hang = createPublicClient({
      transport: rpcTransport(URL_, {
        retryCount: 0,
        timeout: 20,
        // never answers; viem aborts it at its timeout, as fetch would
        fetchFn: (_i, init) =>
          new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      }),
    });
    errs.push(await hang.getBlockNumber({ cacheTime: 0 }).catch((e: unknown) => e));
    expect((errs.at(-1) as Error).name).toBe("TimeoutError");
    for (const e of errs) {
      expect(isRangeRefusal(e)).toBe(false);
      expect(isRateLimited(e)).toBe(false);
    }
  });

  it("fix round 1 (review I1): a -32005 whose words say 'exceeds max requests per second' is a rate limit, never a refusal", async () => {
    const err = await errorOf({ error: { code: -32005, message: "request exceeds max requests per second (25)" } }, "eth_getLogs");
    expect((err as Error).name).toBe("LimitExceededRpcError"); // viem's own rate-limit class, which it retries
    // Before: the refusal branch "exceeds max" matched first, so a rate-limited scan was probed, split and counted.
    expect(isRateLimited(err)).toBe(true);
    expect(isRangeRefusal(err)).toBe(false);
    for (const message of ["exceeds max requests", "100 requests per second allowed", "monthly quota used up", "429: compute units exhausted"]) {
      const e = await errorOf({ error: { code: -32000, message } }, "eth_getLogs");
      expect([message, isRateLimited(e), isRangeRefusal(e)]).toEqual([message, true, false]);
    }
    // The narrowed refusal branch still knows a range or result limit.
    for (const message of ["query exceeds max block range 100000", "query exceeds max results 20000", "exceed maximum block range: 5000"]) {
      const e = await errorOf({ error: { code: -32000, message } }, "eth_getLogs");
      expect([message, isRateLimited(e), isRangeRefusal(e)]).toEqual([message, false, true]);
    }
  });

  it("fix round 1: Arc's real answers, through viem's HTTP stack", async () => {
    const table: Array<[string, Answer, boolean, boolean]> = [
      ["-32005 rate limit exceeded", RATE_LIMIT, true, false],
      ["-32012 requested range too large", { error: { code: -32012, message: "requested range too large" } }, false, true],
      ["-32014 requested data not available", { error: { code: -32014, message: "requested data not available" } }, false, false],
      ["HTTP 429", TOO_MANY, true, false],
    ];
    for (const [name, answer, limited, refused] of table) {
      const err = await errorOf(answer, "eth_getLogs");
      expect([name, isRateLimited(err), isRangeRefusal(err), isRpcError(err)]).toEqual([name, limited, refused, true]);
    }
  });

  it("fix round 1 (review M5, M6): rpcErrorSummary names the RPC's own answer; isRpcError tells the RPC from the host", async () => {
    expect(rpcErrorSummary(await errorOf(TOO_MANY))).toBe("HTTP 429");
    expect(rpcErrorSummary(await errorOf(RATE_LIMIT))).toBe('-32005 "rate limit exceeded"');
    expect(rpcErrorSummary(Object.assign(new Error("requested range too large"), { code: -32012 }))).toBe('-32012 "requested range too large"');
    expect(rpcErrorSummary(new Error("rate limited"))).toBe("rate limited");
    expect(isRpcError(new Error("rate limited"))).toBe(false); // e.g. the host's own 429, as host.ts throws it
  });

  it("the H1 tests' plain refusal stays a refusal; plain 'rpc down' is not", () => {
    expect(isRangeRefusal(new Error("query returned more than the maximum response size"))).toBe(true);
    expect(isRangeRefusal(new Error("rpc down"))).toBe(false);
    expect(isRangeRefusal(Object.assign(new Error("requested range too large"), { code: -32012 }))).toBe(true);
  });
});

describe("H3: rpcTransport retries a rate-limited read, never a send", () => {
  it("a read rate-limited three times is served on the fourth attempt", async () => {
    const rpc = fakeRpc((_m, call) => (call < 2 ? RATE_LIMIT : call < 3 ? TOO_MANY : { result: "0x2a" }));
    const client = createPublicClient({ transport: rpcTransport(URL_, { fetchFn: rpc.fetchFn, retryDelay: 1 }) });
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(42n);
    expect(rpc.calls).toHaveLength(4);
  });

  it(`a read rate-limited throughout fails after ${RPC_RETRY_COUNT + 1} attempts, as a rate limit`, async () => {
    const rpc = fakeRpc(() => RATE_LIMIT);
    const client = createPublicClient({ transport: rpcTransport(URL_, { fetchFn: rpc.fetchFn, retryDelay: 1 }) });
    const err = await client.getBlockNumber({ cacheTime: 0 }).catch((e: unknown) => e);
    expect(isRateLimited(err)).toBe(true);
    expect(rpc.calls).toHaveLength(RPC_RETRY_COUNT + 1);
  });

  it("a refused range is not retried: it would be refused again", async () => {
    const rpc = fakeRpc(() => ({ error: { code: -32012, message: "requested range too large" } }));
    const client = createPublicClient({ transport: rpcTransport(URL_, { fetchFn: rpc.fetchFn, retryDelay: 1 }) });
    await expect(client.getLogs({ fromBlock: 1n, toBlock: 2n })).rejects.toThrow();
    expect(rpc.calls).toEqual(["eth_getLogs"]);
  });

  it("eth_sendRawTransaction is sent once, whatever it is answered: a retry could deliver a transaction twice", async () => {
    for (const a of [RATE_LIMIT, TOO_MANY, { status: 503 }] as Answer[]) {
      const rpc = fakeRpc(() => a);
      const wallet = createWalletClient({ transport: rpcTransport(URL_, { fetchFn: rpc.fetchFn, retryDelay: 1 }) });
      await expect(wallet.sendRawTransaction({ serializedTransaction: "0x02f8" as Hex })).rejects.toThrow();
      expect(rpc.calls).toEqual(["eth_sendRawTransaction"]);
    }
  });

  it("the added wait is bounded: at most ~20 s per call, Retry-After included", () => {
    expect(RPC_RETRY_DELAY_MS * (2 ** RPC_RETRY_COUNT - 1)).toBe(15_500); // 0.5 + 1 + 2 + 4 + 8 s
    expect(RPC_RETRY_COUNT * RPC_RETRY_AFTER_MAX_S * 1000).toBeLessThanOrEqual(20_000);
  });

  it("a Retry-After over the cap is lowered to it; an HTTP date is dropped; a short one is kept", async () => {
    const reply = (h: Record<string, string>) => cappedRetryAfter(async () => new Response("", { status: 429, headers: h }))(URL_);
    expect((await reply({ "retry-after": "3600" })).headers.get("retry-after")).toBe(String(RPC_RETRY_AFTER_MAX_S));
    expect((await reply({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" })).headers.get("retry-after")).toBeNull();
    expect((await reply({ "retry-after": "2" })).headers.get("retry-after")).toBe("2");
    const capped = await reply({ "retry-after": "60" });
    expect(capped.status).toBe(429);
  });
});
