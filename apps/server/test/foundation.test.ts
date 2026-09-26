import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, parseServerConfig, type ServerConfig } from "../src/config.js";
import { RpcChainReader, type HubLike } from "../src/chain.js";
import { RateLimiter } from "../src/limits.js";
import { SqliteRepo } from "../src/repo.js";
import { startServer, type ArenaServer } from "../src/server.js";
import { FakeChain, testConfig } from "./helpers/fakeChain.js";

let server: ArenaServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

describe("config", () => {
  it("defaults optional fields and parses bigints from strings", () => {
    const c = parseServerConfig({ rpcUrl: "http://x", chainId: 31337, hub: "0x" + "11".repeat(20), usdc: "0x" + "22".repeat(20), rules: "0x" + "33".repeat(20) });
    expect(c.port).toBe(8080);
    expect(c.fundingWindow).toBe(3600n);
    expect(c.defaults.deposit).toBe(1_000_000n);
    expect(c.limits).toEqual(DEFAULT_LIMITS);
  });
  it("names the bad field", () => {
    expect(() => parseServerConfig({ rpcUrl: "http://x", chainId: 31337, hub: "nope" })).toThrow(/hub/);
    expect(() => parseServerConfig({ rpcUrl: "http://x", chainId: 31337, hub: "0x" + "11".repeat(20), usdc: "0x" + "22".repeat(20), rules: "0x" + "33".repeat(20), fundingWindow: "9000" })).toThrow(/fundingWindow/); // > 7200
  });
  it("rejects a non-positive rate-limit burst or perSec, naming the field", () => {
    const base = validBase();
    const bad1 = { ...base, limits: { ...DEFAULT_LIMITS, httpPostBurst: 0 } };
    const bad2 = { ...base, limits: { ...DEFAULT_LIMITS, httpGetPerSec: -1 } };
    expect(() => parseServerConfig(bad1)).toThrow(/httpPostBurst/);
    expect(() => parseServerConfig(bad2)).toThrow(/httpGetPerSec/);
  });
  it("rejects a port outside 0..65535", () => {
    const base = validBase();
    expect(() => parseServerConfig({ ...base, port: 70_000 })).toThrow(/port/);
    expect(() => parseServerConfig({ ...base, port: 1.5 })).toThrow(/port/);
  });
});

function validBase() {
  return {
    rpcUrl: "http://x",
    chainId: 31337,
    hub: "0x" + "11".repeat(20),
    usdc: "0x" + "22".repeat(20),
    rules: "0x" + "33".repeat(20),
  };
}

describe("chain", () => {
  it("does not cache a rejected timeoutBounds forever", async () => {
    let calls = 0;
    const hub: HubLike = {
      feeConfig() {
        throw new Error("not used");
      },
      timeoutBounds() {
        calls++;
        return calls === 1 ? Promise.reject(new Error("rpc down")) : Promise.resolve({ min: 60n, max: 86_400n });
      },
      blockNumber() {
        throw new Error("not used");
      },
      hubEvents() {
        throw new Error("not used");
      },
    };
    const reader = new RpcChainReader(
      { rpcUrl: "http://127.0.0.1:1", chainId: 31337, hub: "0x" + "11".repeat(20) as `0x${string}` },
      hub,
    );
    await expect(reader.timeoutBounds()).rejects.toThrow("rpc down");
    await expect(reader.timeoutBounds()).resolves.toEqual({ min: 60n, max: 86_400n });
    expect(calls).toBe(2);
  });
});

describe("rate limiter", () => {
  it("allows a burst then refills over time, per key", () => {
    let t = 0;
    const rl = new RateLimiter(2, 1, () => t);
    expect([rl.take("a"), rl.take("a"), rl.take("a")]).toEqual([true, true, false]);
    expect(rl.take("b")).toBe(true);
    t = 1000;
    expect(rl.take("a")).toBe(true);
  });

  it("drops a bucket once it has sat fully refilled for 10 minutes, to bound memory", () => {
    let t = 0;
    const rl = new RateLimiter(2, 1, () => t);
    rl.take("a"); // tokens: 1 at t=0, refills fully (2) by t=1000
    t = 11 * 60_000 + 2000; // long past both the refill and the 10-minute idle-while-full window
    rl.take("b"); // any call triggers the periodic sweep
    expect(rl.size).toBe(1); // only "b" remains; "a" was dropped
  });
});

describe("sqlite repo", () => {
  it("persists the indexer cursor and relay cache across reopen", () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/arena-repo-${Date.now()}.db`;
    const r1 = new SqliteRepo(path);
    r1.setCursor(42n);
    r1.close();
    const r2 = new SqliteRepo(path);
    expect(r2.cursor()).toBe(42n);
    r2.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  });

  it("runs the offer lifecycle: insert, match once, prune expired", () => {
    const r = new SqliteRepo(":memory:");
    const offerId = ("0x" + "aa".repeat(32)) as `0x${string}`;
    const so = {
      offer: {
        template: "chess" as const,
        player: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        signer: "0x2222222222222222222222222222222222222222" as `0x${string}`,
        deposit: 1_000_000n,
        stakePerGame: 100_000n,
        challengeTimeout: 600n,
        expiresAt: 1_000_100n,
        nonce: ("0x" + "01".repeat(32)) as `0x${string}`,
      },
      sig: "0x" as `0x${string}`,
    };
    expect(r.insertOffer(offerId, so)).toBe(true);
    expect(r.insertOffer(offerId, so)).toBe(false); // duplicate id
    expect(r.offer(offerId)).toEqual({ signed: so, acceptance: null, match: null });

    const open = r.openOffers(1_000_000n);
    expect(open).toEqual([so]);
    expect(r.openOffers(1_000_200n)).toEqual([]); // expired relative to `now`

    expect(r.openOfferCount("0x1111111111111111111111111111111111111111", 1_000_000n)).toBe(1);
    const upperPlayer = "0X1111111111111111111111111111111111111111" as `0x${string}`;
    expect(r.openOfferCount(upperPlayer, 1_000_000n)).toBe(1); // case-insensitive

    const sa = {
      acceptance: { offerId, player: so.offer.signer, signer: so.offer.signer, nonce: so.offer.nonce },
      sig: "0x" as `0x${string}`,
    };
    const m = { offerId, params: { salt: "0x" } as never };
    expect(r.recordMatch(offerId, sa, m)).toBe(true);
    expect(r.recordMatch(offerId, sa, m)).toBe(false); // already matched: atomic, only one winner
    expect(r.offer(offerId)?.acceptance).toEqual(sa);
    expect(r.offer(offerId)?.match).toEqual(m);

    // an expired *unmatched* offer is pruned only once it is more than a day past expiry
    const expiredId = ("0x" + "bb".repeat(32)) as `0x${string}`;
    const expiredOffer = { ...so, offer: { ...so.offer, expiresAt: 1_000_000n } };
    r.insertOffer(expiredId, expiredOffer);
    expect(r.pruneOffers(1_000_000n + 3600n)).toBe(0); // only 1h past expiry, not pruned yet
    expect(r.pruneOffers(1_000_000n + 86_400n + 1n)).toBe(1); // matched offer above is untouched
    expect(r.offer(expiredId)).toBe(null);
    expect(r.offer(offerId)).not.toBe(null);
    r.close();
  });

  it("caches relay messages keyed by (channelId, sender, type), last write wins", () => {
    const r = new SqliteRepo(":memory:");
    const channelId = ("0x" + "cc".repeat(32)) as `0x${string}`;
    const signed1 = { state: { turnNum: 1n }, sigA: "0x", sigB: "0x" } as never;
    const signed2 = { state: { turnNum: 2n }, sigA: "0x", sigB: "0x" } as never;
    const state1 = { type: "state" as const, channelId, signed: signed1 };
    const state2 = { type: "state" as const, channelId, signed: signed2 };
    r.cacheRelay(channelId, 0, state1);
    r.cacheRelay(channelId, 0, state2); // same (channelId, sender, type): overwrites
    r.cacheRelay(channelId, 1, state1); // different sender: separate entry
    const cached = r.cachedRelay(channelId);
    expect(cached).toHaveLength(2);
    const bySender0 = cached.find((c) => c.sender === 0);
    expect(bySender0?.message).toEqual(state2);
    r.close();
  });

  it("finds channel rows for a player case-insensitively", () => {
    const r = new SqliteRepo(":memory:");
    const a = "0xAbCd000000000000000000000000000000000001" as `0x${string}`;
    const b = "0x0000000000000000000000000000000000000002" as `0x${string}`;
    const row = {
      channelId: ("0x" + "dd".repeat(32)) as `0x${string}`,
      params: { participants: [a, b] } as never,
      phase: "Open" as const,
      createdBlock: 10n,
      challenges: [0, 0] as [number, number],
      answered: [0, 0] as [number, number],
      pendingChallenger: null,
      registered: null,
      timeoutLoser: null,
      balances: null,
    };
    r.saveChannelRow(row);
    expect(r.channelRowsFor("0xabcd000000000000000000000000000000000001")).toEqual([row]);
    expect(r.channelRowsFor(b)).toEqual([row]);
    expect(r.channelRowsFor("0x0000000000000000000000000000000000000099")).toEqual([]);
    r.close();
  });
});

describe("http foundation", () => {
  it("serves health, templates, skill docs and 404s", async () => {
    server = await startServer(testConfig(), { chain: new FakeChain() });
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    const templates = await (await fetch(`${server.url}/templates`)).json();
    expect(templates).toEqual([
      expect.objectContaining({ id: "chess", version: "1", chainId: 31337, hub: server.config.hub, rules: server.config.rules, usdc: server.config.usdc,
        rpcUrl: server.config.rpcUrl, defaults: { deposit: "1000000", stakePerGame: "100000", challengeTimeout: "600" },
        skillUrl: `${server.url}/templates/chess/skill.md` }),
    ]);
    for (const p of ["/skill.md", "/llms.txt", "/templates/chess/skill.md"]) {
      const res = await fetch(`${server.url}${p}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/(markdown|plain)/);
      const text = await res.text();
      expect(text).toContain(server.url);
    }
    expect(await (await fetch(`${server.url}/skill.md`)).text()).toMatch(/arena init --server/);
    expect((await fetch(`${server.url}/nope`)).status).toBe(404);
  });
  it("rate-limits GETs per IP with 429", async () => {
    server = await startServer({ ...testConfig(), limits: { ...DEFAULT_LIMITS, httpGetBurst: 2, httpGetPerSec: 0.001 } }, { chain: new FakeChain() });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await fetch(`${server.url}/templates`)).status);
    expect(codes).toEqual([200, 200, 429]);
  });
  it("exposes Prometheus metrics", async () => {
    server = await startServer(testConfig(), { chain: new FakeChain() });
    const text = await (await fetch(`${server.url}/metrics`)).text();
    for (const m of ["arena_ws_connections", "arena_relay_messages_total", "arena_offers_open", "arena_indexer_block", "arena_indexer_lag_blocks"]) {
      expect(text).toContain(m);
    }
  });
});
