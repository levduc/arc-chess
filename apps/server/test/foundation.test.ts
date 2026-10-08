import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { toWire } from "@arena/sdk";
import { DEFAULT_LIMITS, parseServerConfig, type ServerConfig } from "../src/config.js";
import { RpcChainReader, type HubLike } from "../src/chain.js";
import { WebSocket as WsClient } from "ws";
import { ipKey, RateLimiter } from "../src/limits.js";
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
    expect(c.trustProxy).toBe(false);
    const base = { rpcUrl: "http://x", chainId: 1, hub: "0x" + "11".repeat(20), usdc: "0x" + "22".repeat(20), rules: "0x" + "33".repeat(20), audit: "unaudited; guarded launch" };
    expect(parseServerConfig({ ...base, trustProxy: true }).trustProxy).toBe(true);
    expect(() => parseServerConfig({ ...base, trustProxy: "yes" })).toThrow(/trustProxy/);
  });
  it("names the bad field", () => {
    expect(() => parseServerConfig({ rpcUrl: "http://x", chainId: 31337, hub: "nope" })).toThrow(/hub/);
    expect(() => parseServerConfig({ rpcUrl: "http://x", chainId: 31337, hub: "0x" + "11".repeat(20), usdc: "0x" + "22".repeat(20), rules: "0x" + "33".repeat(20), fundingWindow: "9000" })).toThrow(/fundingWindow/); // > 7200
  });
  it("final review m21: outside a local Anvil chain, audit must be set and must not be the development default", () => {
    const base = { rpcUrl: "http://x", chainId: 5042002, hub: "0x" + "11".repeat(20), usdc: "0x" + "22".repeat(20), rules: "0x" + "33".repeat(20) };
    expect(() => parseServerConfig(base)).toThrow(/audit: is required/);
    expect(() => parseServerConfig({ ...base, audit: "unaudited (development build)" })).toThrow(/audit: .*development/);
    const audit = "unaudited; guarded launch, caps 10 USDC per player and 1,000 USDC in total";
    expect(parseServerConfig({ ...base, audit }).audit).toBe(audit);
    // A local Anvil chain keeps the development default.
    expect(parseServerConfig({ ...base, chainId: 31337 }).audit).toBe("unaudited (development build)");
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
  it("Plan 5.5 Task 1: devFaucet defaults to false and is settable; parsing never checks chain or RPC", () => {
    const base = validBase();
    expect(parseServerConfig(base).devFaucet).toBe(false);
    expect(parseServerConfig({ ...base, devFaucet: true }).devFaucet).toBe(true);
    // Review Focus 1: a non-31337 chain with devFaucet: true must still parse -- the three-way guard is enforced
    // at server start (server.ts), not here, so a real-chain config with the flag mistakenly set still starts.
    const real = { ...base, chainId: 5042002, audit: "unaudited; guarded launch", devFaucet: true };
    expect(parseServerConfig(real).devFaucet).toBe(true);
    expect(() => parseServerConfig({ ...base, devFaucet: "yes" })).toThrow(/devFaucet/);
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
      limits() {
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

  it("Task 2 (spec §13): caches limits() for a few seconds, and a rejection is not cached", async () => {
    let calls = 0;
    const value = { maxDepositPerPlayer: 10_000_000n, maxCommittedEscrow: 10n ** 12n, committedEscrow: 0n, paused: false };
    const hub: HubLike = {
      feeConfig() { throw new Error("not used"); },
      timeoutBounds() { throw new Error("not used"); },
      blockNumber() { throw new Error("not used"); },
      hubEvents() { throw new Error("not used"); },
      limits() {
        calls++;
        return calls === 1 ? Promise.reject(new Error("rpc down")) : Promise.resolve(value);
      },
    };
    const reader = new RpcChainReader(
      { rpcUrl: "http://127.0.0.1:1", chainId: 31337, hub: "0x" + "11".repeat(20) as `0x${string}` },
      hub,
    );
    await expect(reader.limits()).rejects.toThrow("rpc down");
    await expect(reader.limits()).resolves.toEqual(value);
    await expect(reader.limits()).resolves.toEqual(value);
    expect(calls).toBe(2); // the second call is served from the 5s cache
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
    expect(r.insertOffer(offerId, so, "127.0.0.1")).toBe(true);
    expect(r.insertOffer(offerId, so, "127.0.0.1")).toBe(false); // duplicate id
    expect(r.offer(offerId)).toEqual({ signed: so, acceptance: null, match: null });

    const open = r.openOffers(1_000_000n);
    expect(open).toEqual([so]);
    expect(r.openOffers(1_000_200n)).toEqual([]); // expired relative to `now`

    // the open-offer cap is keyed by the poster's IP, not the (unauthenticated) offer.player
    expect(r.openOfferCount("127.0.0.1", 1_000_000n)).toBe(1);
    expect(r.openOfferCount("10.0.0.9", 1_000_000n)).toBe(0);
    expect(r.openOfferTotal(1_000_000n)).toBe(1);
    expect(r.openOfferTotal(1_000_200n)).toBe(0); // expired relative to `now`

    const sa = {
      acceptance: { offerId, player: so.offer.signer, signer: so.offer.signer, nonce: so.offer.nonce },
      sig: "0x" as `0x${string}`,
    };
    const m = { offerId, params: { salt: "0x", fundingDeadline: 1_003_600n } as never };
    const matchedChannel = ("0x" + "ee".repeat(32)) as `0x${string}`;
    expect(r.knownChannel(matchedChannel)).toBe(false);
    expect(r.recordMatch(offerId, sa, m, matchedChannel)).toBe(true);
    expect(r.recordMatch(offerId, sa, m, matchedChannel)).toBe(false); // already matched: atomic, only one winner
    expect(r.knownChannel(matchedChannel)).toBe(true); // matched by this host's lobby: the relay may join it
    expect(r.offer(offerId)?.acceptance).toEqual(sa);
    expect(r.offer(offerId)?.match).toEqual(m);

    // an expired *unmatched* offer is pruned only once it is more than a day past expiry
    const expiredId = ("0x" + "bb".repeat(32)) as `0x${string}`;
    const expiredOffer = { ...so, offer: { ...so.offer, expiresAt: 1_000_000n } };
    r.insertOffer(expiredId, expiredOffer, "127.0.0.1");
    expect(r.pruneOffers(1_000_000n + 3600n)).toBe(0); // only 1h past expiry, not pruned yet
    expect(r.pruneOffers(1_000_000n + 86_400n + 1n)).toBe(1); // matched offer above is untouched
    expect(r.offer(expiredId)).toBe(null);
    expect(r.offer(offerId)).not.toBe(null);
    r.close();
  });

  it("caches up to 4 states per (channelId, sender), highest turns kept, plus the latest close", () => {
    const r = new SqliteRepo(":memory:");
    const channelId = ("0x" + "cc".repeat(32)) as `0x${string}`;
    type Loose = { type: "state"; channelId: `0x${string}`; signed: { state: { turnNum: bigint }; sigA: string; sigB: string } };
    const state = (turnNum: bigint, tag = "") =>
      ({ type: "state", channelId, signed: { state: { turnNum }, sigA: `0x${tag}`, sigB: "0x" } }) as Loose as never;
    const turnOf = (m: unknown) => (m as Loose).signed.state.turnNum;
    const turns = (sender: 0 | 1) =>
      r
        .cachedRelay(channelId)
        .filter((c) => c.sender === sender && c.message.type === "state")
        .map((c) => turnOf(c.message));

    r.cacheRelay(channelId, 0, state(2n));
    r.cacheRelay(channelId, 0, state(1n)); // lower, but there is room: kept
    r.cacheRelay(channelId, 1, state(1n)); // different sender: its own entries
    expect(turns(0)).toEqual([1n, 2n]); // ascending turn order
    expect(turns(1)).toEqual([1n]);

    r.cacheRelay(channelId, 0, state(2n, "aa")); // same turn: replaces the held one
    expect(turns(0)).toEqual([1n, 2n]);
    const heldTwo = r.cachedRelay(channelId).find((c) => c.sender === 0 && c.message.type === "state" && turnOf(c.message) === 2n);
    expect(heldTwo?.message).toEqual(state(2n, "aa"));

    for (const t of [3n, 4n, 5n]) r.cacheRelay(channelId, 0, state(t)); // a fifth state evicts the lowest (1)
    expect(turns(0)).toEqual([2n, 3n, 4n, 5n]);
    r.cacheRelay(channelId, 0, state(1n)); // full, and lower than everything held: dropped, evicts nothing
    expect(turns(0)).toEqual([2n, 3n, 4n, 5n]);
    r.cacheRelay(channelId, 0, state(2n, "bb")); // equal to the lowest held: a same-turn replacement, not a drop
    expect(turns(0)).toEqual([2n, 3n, 4n, 5n]);

    const close1 = { type: "close" as const, channelId, close: { stateHash: channelId, by: 0 as const, sig: "0x01" as const } };
    const close2 = { ...close1, close: { ...close1.close, sig: "0x02" as const } };
    r.cacheRelay(channelId, 0, close1);
    r.cacheRelay(channelId, 0, close2); // only the latest close per sender
    const closes = r.cachedRelay(channelId).filter((c) => c.message.type === "close");
    expect(closes).toEqual([{ sender: 0, message: close2 }]);
    expect(turns(1)).toEqual([1n]); // untouched by sender 0's traffic
    r.close();
  });

  it("migrates a relay cache and offers table written by the previous schema", () => {
    const path = join(tmpdir(), `arena-migrate-${randomBytes(8).toString("hex")}.sqlite`);
    try {
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE offers (offer_id TEXT PRIMARY KEY, player TEXT NOT NULL, ip TEXT NOT NULL DEFAULT '',
        expires_at TEXT NOT NULL, body TEXT NOT NULL, acceptance TEXT, match TEXT, created_ms INTEGER NOT NULL);
        CREATE TABLE relay_cache (channel_id TEXT NOT NULL, sender INTEGER NOT NULL, kind TEXT NOT NULL,
        body TEXT NOT NULL, PRIMARY KEY (channel_id, sender, kind));
        CREATE TABLE channels (channel_id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL,
        created_block TEXT NOT NULL, body TEXT NOT NULL);`);
      const channelId = ("0x" + "ab".repeat(32)) as `0x${string}`;
      const msg = { type: "state" as const, channelId, signed: { state: { turnNum: 7n }, sigA: "0x", sigB: "0x" } };
      old.prepare("INSERT INTO relay_cache VALUES (?, 0, 'state', ?)").run(channelId, toWire(msg));
      const params = { salt: "0x", fundingDeadline: 5n };
      old
        .prepare("INSERT INTO offers (offer_id, player, expires_at, body, match, created_ms) VALUES (?, 'p', '0', '{}', ?, 0)")
        .run("0x" + "01".repeat(32), toWire({ offerId: "0x" + "01".repeat(32), params }));
      old.close();

      const matched = ("0x" + "cd".repeat(32)) as `0x${string}`;
      const r = new SqliteRepo(path, () => matched);
      expect(r.cachedRelay(channelId)).toEqual([{ sender: 0, message: msg }]); // carried over, not dropped
      expect(r.knownChannel(matched)).toBe(true); // channel_id backfilled from the stored match
      r.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });

  it("rolls a failed migration back, leaving the old schema intact", () => {
    const path = join(tmpdir(), `arena-migrate-${randomBytes(8).toString("hex")}.sqlite`);
    try {
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE offers (offer_id TEXT PRIMARY KEY, player TEXT NOT NULL, ip TEXT NOT NULL DEFAULT '',
        expires_at TEXT NOT NULL, body TEXT NOT NULL, acceptance TEXT, match TEXT, created_ms INTEGER NOT NULL);
        CREATE TABLE relay_cache (channel_id TEXT NOT NULL, sender INTEGER NOT NULL, kind TEXT NOT NULL,
        body TEXT NOT NULL, PRIMARY KEY (channel_id, sender, kind));`);
      const channelId = ("0x" + "ab".repeat(32)) as `0x${string}`;
      const msg = { type: "state" as const, channelId, signed: { state: { turnNum: 7n }, sigA: "0x", sigB: "0x" } };
      old.prepare("INSERT INTO relay_cache VALUES (?, 0, 'state', ?)").run(channelId, toWire(msg));
      old
        .prepare("INSERT INTO offers (offer_id, player, expires_at, body, match, created_ms) VALUES (?, 'p', '0', '{}', ?, 0)")
        .run("0x" + "01".repeat(32), toWire({ offerId: "0x" + "01".repeat(32), params: { fundingDeadline: 5n } }));
      old.close();

      // the backfill runs last, after the relay cache was rebuilt and columns were added: all of it must roll back
      expect(() => new SqliteRepo(path, () => { throw new Error("backfill failed"); })).toThrow(/backfill failed/);
      const after = new DatabaseSync(path);
      const cols = (t: string) => (after.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols("relay_cache")).not.toContain("turn");
      expect(cols("offers")).not.toContain("channel_id");
      expect(after.prepare("SELECT COUNT(*) AS n FROM relay_cache").get()).toEqual({ n: 1 });
      after.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });

  it("prunes matched offers a day past their funding deadline unless their channel is still live", () => {
    const r = new SqliteRepo(":memory:");
    const deadline = 1_000_000n;
    const mk = (n: number) => {
      const offerId = ("0x" + n.toString(16).padStart(2, "0").repeat(32)) as `0x${string}`;
      const channelId = ("0x" + (n + 16).toString(16).padStart(2, "0").repeat(32)) as `0x${string}`;
      const so = { offer: { player: "0x" + "00".repeat(20), expiresAt: 1n }, sig: "0x" } as never;
      r.insertOffer(offerId, so, "1.2.3.4");
      const sa = { acceptance: { offerId }, sig: "0x" } as never;
      r.recordMatch(offerId, sa, { offerId, params: { fundingDeadline: deadline } as never }, channelId);
      return { offerId, channelId };
    };
    const row = (channelId: `0x${string}`, phase: "Open" | "Finalized" | "Reclaimed") => ({
      channelId, params: { participants: ["0x" + "01".repeat(20), "0x" + "02".repeat(20)] } as never, phase,
      createdBlock: 1n, challenges: [0, 0] as [number, number], answered: [0, 0] as [number, number],
      pendingChallenger: null, registered: null, timeoutLoser: null, balances: null,
    });
    const neverFunded = mk(1); // no indexer row: the channel never reached the chain
    const live = mk(2);
    r.saveChannelRow(row(live.channelId, "Open"));
    const finalized = mk(3);
    r.saveChannelRow(row(finalized.channelId, "Finalized"));
    const reclaimed = mk(4);
    r.saveChannelRow(row(reclaimed.channelId, "Reclaimed"));

    // a self-accepted, never-funded channel whose members pushed states: nothing but this prune would drop them
    const cached = (channelId: `0x${string}`) =>
      ({ type: "state", channelId, signed: { state: { turnNum: 1n }, sigA: "0x", sigB: "0x" } }) as never;
    r.cacheRelay(neverFunded.channelId, 0, cached(neverFunded.channelId));
    r.cacheRelay(neverFunded.channelId, 1, cached(neverFunded.channelId));
    r.cacheRelay(live.channelId, 0, cached(live.channelId));

    expect(r.pruneOffers(deadline + 86_400n)).toBe(0); // exactly a day past: not yet (strictly more than a day)
    expect(r.cachedRelay(neverFunded.channelId)).toHaveLength(2);
    expect(r.pruneOffers(deadline + 86_401n)).toBe(3);
    expect(r.cachedRelay(neverFunded.channelId)).toEqual([]); // no orphaned cache left behind
    expect(r.cachedRelay(live.channelId)).toHaveLength(1); // a live channel's cache is untouched
    expect(r.offer(neverFunded.offerId)).toBe(null);
    expect(r.offer(finalized.offerId)).toBe(null);
    expect(r.offer(reclaimed.offerId)).toBe(null);
    expect(r.offer(live.offerId)).not.toBe(null); // an Open channel keeps its match (and its join gate)
    expect(r.knownChannel(finalized.channelId)).toBe(false); // settled: never joinable again
    expect(r.knownChannel(live.channelId)).toBe(true);
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

  it("Task 2 (spec §13): skill.md explains the launch limits and points at /templates", async () => {
    server = await startServer(testConfig(), { chain: new FakeChain() });
    const text = await (await fetch(`${server.url}/skill.md`)).text();
    expect(text).toMatch(/cap/i);
    expect(text).toMatch(/pause/i);
    expect(text).toMatch(/\/templates/);
  });

  it("Plan 5 Task 5 (spec §6.2/§12 item 44): skill.md teaches handoff etiquette (when, note, 409, status.controller)", async () => {
    server = await startServer(testConfig(), { chain: new FakeChain() });
    const text = await (await fetch(`${server.url}/skill.md`)).text();
    // When to hand off, and to always leave a note.
    expect(text).toMatch(/hard|high-stakes|not confident/i);
    expect(text).toMatch(/leave a short note/i);
    // Never act while the human is in control -- the daemon never signs, and move commands get 409.
    expect(text).toMatch(/409/);
    expect(text).toMatch(/the human is in control/i);
    // control-changed is only a partial signal; agents must re-read status.controller after every wait.
    expect(text).toMatch(/control-changed/);
    expect(text).toMatch(/status\.controller/);
    // Final fix wave (I1): a challenge on a human-held seat -- tell the human; once control auto-returns, move.
    expect(text).toMatch(/`human-must-move`/);
    expect(text).toMatch(/tell the human/i);
    expect(text).toMatch(/auto-returned: challenge deadline approaching/);
    expect(text).toMatch(/you must move at once/);
    // How the human opens the board, and the security note about its link (a one-time code, final fix wave M1).
    expect(text).toMatch(/arena board/);
    expect(text).toMatch(/one-time code/);
    expect(text).toMatch(/never.*(pasted|shared)|(pasted|shared).*never/i);
  });

  it("Plan 5.5 Task 3: skill.md's first section is the play-N-games recipe, with every step's command", async () => {
    server = await startServer(testConfig(), { chain: new FakeChain() });
    const text = await (await fetch(`${server.url}/skill.md`)).text();
    const recipeAt = text.indexOf("## Recipe: play N games at $X per game");
    expect(recipeAt).toBeGreaterThan(-1);
    // It's the *first* `##` section -- nothing else at that heading level comes before it.
    expect(text.slice(0, recipeAt)).not.toMatch(/^## /m);
    const recipe = text.slice(recipeAt, text.indexOf("## Setup (once)"));
    for (const fragment of [
      "arena init --server",
      "arena daemon",
      "arena channels",
      "arena wallet",
      "arena offers",
      "arena accept <offerId>",
      "arena offer --deposit",
      "arena wait --channel <channelId>",
      "arena status --channel <channelId>",
      "arena move <SAN> --channel <channelId>",
      "arena next-game --channel <channelId>",
      "arena close --channel <channelId>",
      "status.controller",
      "Finalized",
      "arena challenge",
      "human-must-move",
      "session-gas-low",
    ]) {
      expect(recipe).toContain(fragment);
    }
  });

  it("Fix round 1, I1: the recipe states which commands report USDC in base units vs whole-USDC decimals", async () => {
    server = await startServer(testConfig(), { chain: new FakeChain() });
    const text = await (await fetch(`${server.url}/skill.md`)).text();
    const recipe = text.slice(text.indexOf("## Recipe: play N games at $X per game"), text.indexOf("## Setup (once)"));
    expect(recipe).toMatch(/base units/);
    expect(recipe).toMatch(/whole-USDC decimals/);
    expect(recipe).toMatch(/"1000000"/); // the worked example: $1 in base units
    // The three comparisons the review called out each say which units they use.
    expect(recipe).toMatch(/stakePerGame.*equals.*1000000.*base/);
    expect(recipe).toMatch(/deposit.*at least.*1000000.*base/);
    expect(recipe).toMatch(/maxDepositPerPlayer.*base units/);
  });

  it("Fix round 1, I2: session-gas-low is reworded to point at the native balance, not USDC", async () => {
    server = await startServer(testConfig(), { chain: new FakeChain() });
    const text = await (await fetch(`${server.url}/skill.md`)).text();
    const line = text.slice(text.indexOf("`session-gas-low`: the channel's"));
    expect(line).toMatch(/native/);
    expect(line).toMatch(/arena wallet.*`native`/);
    expect(line).toMatch(/arena faucet/);
    expect(line).toMatch(/Arc, gas is paid in USDC/);
  });

  it("Plan 5.5 Task 3 (ruling 2): the recipe's daemon-log path is quoted and ARENA_HOME-aware", async () => {
    server = await startServer(testConfig(), { chain: new FakeChain() });
    const text = await (await fetch(`${server.url}/skill.md`)).text();
    expect(text).toContain('"${ARENA_HOME:-$HOME/.arena}/daemon.log"');
  });

  it("Plan 5.5 Task 3 (ruling 3): the recipe sizes the deposit from /templates' limits.maxDepositPerPlayer", async () => {
    server = await startServer(testConfig(), { chain: new FakeChain() });
    const text = await (await fetch(`${server.url}/skill.md`)).text();
    expect(text).toMatch(/limits\.maxDepositPerPlayer/);
    expect(text).toMatch(/min\(N.{1,3}X, cap\)/);
    expect(text).toMatch(/second channel/i);
  });

  it("Plan 5.5 Task 3 (ruling 4): the recipe's commands always use cfg.cliCommand, never a hardcoded \"arena\"", async () => {
    server = await startServer(testConfig({ cliCommand: "/tmp/agent-onboarding-test/bin/my-arena" }), { chain: new FakeChain() });
    const text = await (await fetch(`${server.url}/skill.md`)).text();
    expect(text).toContain("/tmp/agent-onboarding-test/bin/my-arena init --server");
    expect(text).toContain("/tmp/agent-onboarding-test/bin/my-arena wallet");
    // The only mention of the bare word "arena" left anywhere is the product name in the title.
    const strayArena = text
      .split("\n")
      .filter((line) => /\barena\b/i.test(line) && !line.includes("/tmp/agent-onboarding-test/bin/my-arena"));
    expect(strayArena).toEqual(["# Agent Chess Arena"]);
  });

  it("Plan 5.5 Task 3 (ruling 1): the index page addresses an agent above the table, and llms.txt does on its first line", async () => {
    server = await startServer(testConfig(), { chain: new FakeChain() });
    const html = await (await fetch(`${server.url}/`)).text();
    const agentLineAt = html.indexOf("AI agent?");
    const tableAt = html.indexOf("<table>");
    expect(agentLineAt).toBeGreaterThan(-1);
    expect(tableAt).toBeGreaterThan(-1);
    expect(agentLineAt).toBeLessThan(tableAt);
    expect(html).toMatch(/href="\/skill\.md"/);

    const llms = await (await fetch(`${server.url}/llms.txt`)).text();
    const firstLine = llms.split("\n")[1]; // line 0 is the "# Agent Chess Arena" title
    expect(firstLine).toMatch(/^> AI agent\?.*skill\.md/);
  });

  it("Task 2 (spec §13): /templates publishes the hub's current launch limits", async () => {
    const chain = new FakeChain();
    chain.hubLimits = { maxDepositPerPlayer: 10_000_000n, maxCommittedEscrow: 1_000_000_000n, committedEscrow: 500_000n, paused: true };
    server = await startServer(testConfig(), { chain });
    const templates = (await (await fetch(`${server.url}/templates`)).json()) as Array<{ limits: unknown }>;
    expect(templates[0].limits).toEqual({
      maxDepositPerPlayer: "10000000",
      maxCommittedEscrow: "1000000000",
      committedEscrow: "500000",
      paused: true,
    });
  });

  it("Task 2 (spec §13): /templates renders limits: null rather than failing when the chain is unavailable", async () => {
    const chain = new FakeChain();
    chain.limitsError = new Error("rpc down");
    server = await startServer(testConfig(), { chain });
    const res = await fetch(`${server.url}/templates`);
    expect(res.status).toBe(200);
    const templates = (await res.json()) as Array<{ limits: unknown }>;
    expect(templates[0].limits).toBeNull();
  });
  it("rate-limits GETs per IP with 429", async () => {
    server = await startServer({ ...testConfig(), limits: { ...DEFAULT_LIMITS, httpGetBurst: 2, httpGetPerSec: 0.001 } }, { chain: new FakeChain() });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await fetch(`${server.url}/templates`)).status);
    expect(codes).toEqual([200, 200, 429]);
  });
  it("keys IPv6 clients by their /64 and unwraps IPv4-mapped addresses (I7)", () => {
    expect(ipKey("2001:db8:1:2::1")).toBe(ipKey("2001:db8:1:2:ffff:ffff:ffff:5"));
    expect(ipKey("2001:0db8:0001:0002:0000:0000:0000:0001")).toBe(ipKey("2001:db8:1:2::1"));
    expect(ipKey("2001:db8:1:2::1")).not.toBe(ipKey("2001:db8:1:3::1"));
    expect(ipKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("::ffff:cb00:7109")).toBe("203.0.113.9"); // the same mapped address in hex form
    expect(ipKey("203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("fe80::1%eth0")).toBe(ipKey("fe80::2"));
    // proxies may append the client's port
    expect(ipKey("203.0.113.9:5678")).toBe("203.0.113.9");
    expect(ipKey("[2001:db8:1:2::1]:443")).toBe(ipKey("2001:db8:1:2::5"));
    expect(ipKey("[2001:db8:1:2::1]")).toBe(ipKey("2001:db8:1:2::5"));
    const limiter = new RateLimiter(1, 0.001);
    expect(limiter.take(ipKey("2001:db8:1:2::1"))).toBe(true);
    expect(limiter.take(ipKey("2001:db8:1:2::abcd"))).toBe(false); // same /64: same bucket
    expect(limiter.take(ipKey("2001:db8:1:3::1"))).toBe(true);
  });

  it("with trustProxy, keys HTTP limits on the right-most X-Forwarded-For entry", async () => {
    const limits = { ...DEFAULT_LIMITS, httpGetBurst: 1, httpGetPerSec: 0.001 };
    server = await startServer({ ...testConfig(), limits, trustProxy: true }, { chain: new FakeChain() });
    const get = (xff: string) => fetch(`${server!.url}/healthz`, { headers: { "x-forwarded-for": xff } }).then((r) => r.status);
    expect(await get("198.51.100.1")).toBe(200);
    expect(await get("198.51.100.2")).toBe(200); // a different client behind the proxy: its own bucket
    expect(await get("198.51.100.2, 198.51.100.1")).toBe(429); // only the proxy-appended (right-most) entry counts
    expect(await get("2001:db8:5:6::1")).toBe(200);
    expect(await get("2001:db8:5:6::2")).toBe(429); // same /64
    expect(await get("198.51.100.3:4000")).toBe(200); // a port on the entry is dropped...
    expect(await get("198.51.100.3:4001")).toBe(429); // ...so another port of the same client shares its bucket
    expect(await get("[2001:db8:7:8::1]:443")).toBe(200);
    expect(await get("2001:db8:7:8::2")).toBe(429);
  });

  it("without trustProxy, ignores X-Forwarded-For", async () => {
    const limits = { ...DEFAULT_LIMITS, httpGetBurst: 1, httpGetPerSec: 0.001 };
    server = await startServer({ ...testConfig(), limits }, { chain: new FakeChain() });
    const get = (xff: string) => fetch(`${server!.url}/healthz`, { headers: { "x-forwarded-for": xff } }).then((r) => r.status);
    expect(await get("198.51.100.1")).toBe(200);
    expect(await get("198.51.100.2")).toBe(429); // the socket peer is what counts
  });

  it("applies trustProxy to the WebSocket upgrade's per-IP connection cap", async () => {
    const open = (url: string, xff: string) =>
      new Promise<"open" | "refused">((resolve) => {
        const ws = new WsClient(`${url.replace(/^http/, "ws")}/ws`, { headers: { "x-forwarded-for": xff } });
        ws.on("open", () => resolve("open"));
        ws.on("error", () => resolve("refused"));
      });
    const limits = { ...DEFAULT_LIMITS, wsPerIp: 1 };
    server = await startServer({ ...testConfig(), limits, trustProxy: true }, { chain: new FakeChain() });
    expect(await open(server.url, "198.51.100.1")).toBe("open");
    expect(await open(server.url, "198.51.100.2")).toBe("open");
    expect(await open(server.url, "198.51.100.1")).toBe("refused");
    await server.close();

    server = await startServer({ ...testConfig(), limits }, { chain: new FakeChain() });
    expect(await open(server.url, "198.51.100.1")).toBe("open");
    expect(await open(server.url, "198.51.100.2")).toBe("refused"); // header ignored: both are 127.0.0.1
  });

  it("exposes Prometheus metrics", async () => {
    server = await startServer(testConfig(), { chain: new FakeChain() });
    const text = await (await fetch(`${server.url}/metrics`)).text();
    for (const m of ["arena_ws_connections", "arena_relay_messages_total", "arena_offers_open", "arena_indexer_block", "arena_indexer_lag_blocks"]) {
      expect(text).toContain(m);
    }
  });
});
