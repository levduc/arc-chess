import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { signRelayJoin } from "@arena/sdk";
import { DEFAULT_LIMITS } from "../src/config.js";
import { Relay, type RelayPeer } from "../src/relay.js";
import { SqliteRepo } from "../src/repo.js";
import { startServer, type ArenaServer, type Metrics } from "../src/server.js";
import { FakeChain, testConfig } from "./helpers/fakeChain.js";
import { wsConnect } from "./helpers/wsClient.js";
import { makeChannelFixture, rawStateAt, signStateAs, type ChannelFixture } from "./helpers/channel.js";

let server: ArenaServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Joins `url` as `key` (one of `fx.params.signers`), signing over this fresh connection's own nonce as the
 *  protocol requires. Waits for `joined` or `error` before returning the connected client. */
async function joinAs(url: string, fx: ChannelFixture, key: Hex) {
  const c = await wsConnect(url);
  const acct = privateKeyToAccount(key);
  c.send({
    type: "join",
    channelId: fx.id,
    params: fx.params,
    signer: acct.address,
    sig: await signRelayJoin(acct, fx.id, c.nonce),
  });
  await c.next((f) => (f.type === "joined" && f.channelId === fx.id) || f.type === "error");
  return c;
}

function randomNonce(): Hex {
  return `0x${randomBytes(32).toString("hex")}` as Hex;
}

function fakePeer(): RelayPeer & { frames: unknown[] } {
  const frames: unknown[] = [];
  return { send: (f) => frames.push(f), joined: new Map(), nonce: randomNonce(), closed: false, frames };
}

/** A `close` relay message for `fx`'s channel, attributed to player `by`; the relay never checks `sig`. */
function closeMsg(fx: ChannelFixture, by: 0 | 1) {
  return { type: "close" as const, channelId: fx.id, close: { stateHash: fx.id, by, sig: "0x" as Hex } };
}

describe("relay", () => {
  it("forwards a signed state from A to B and not back to A", async () => {
    const cfg = testConfig();
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx = makeChannelFixture(cfg);
    const a = await joinAs(server.url, fx, fx.kA);
    const b = await joinAs(server.url, fx, fx.kB);

    const s1 = await signStateAs(fx, rawStateAt(fx, 1n), 0);
    a.send({ type: "relay", message: { type: "state", channelId: fx.id, signed: s1 } });

    const gotB = await b.next((f) => f.type === "relay");
    expect(gotB.message).toEqual({ type: "state", channelId: fx.id, signed: s1 });
    await expect(a.next((f) => f.type === "relay", 200)).rejects.toThrow();
  });

  it("delivers a state and a following close in send order, though state verification awaits", async () => {
    const cfg = testConfig();
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx = makeChannelFixture(cfg);
    const a = await joinAs(server.url, fx, fx.kA);
    const b = await joinAs(server.url, fx, fx.kB);

    const s1 = await signStateAs(fx, rawStateAt(fx, 1n), 0);
    const close = closeMsg(fx, 0);
    // sent back to back, with no wait in between: `forward`'s state branch awaits signature recovery but its
    // close branch doesn't, so without per-connection serialization the close would overtake the state.
    a.send({ type: "relay", message: { type: "state", channelId: fx.id, signed: s1 } });
    a.send({ type: "relay", message: close });

    const first = await b.next((f) => f.type === "relay");
    expect(first.message).toEqual({ type: "state", channelId: fx.id, signed: s1 });
    const second = await b.next((f) => f.type === "relay");
    expect(second.message).toEqual(close);
  });

  it("forwards a relay frame sent immediately after join, without waiting for `joined`", async () => {
    const cfg = testConfig();
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx = makeChannelFixture(cfg);
    const b = await joinAs(server.url, fx, fx.kB);
    const c = await wsConnect(server.url);
    const acct = privateKeyToAccount(fx.kA);
    const s1 = await signStateAs(fx, rawStateAt(fx, 1n), 0);

    // join and relay sent back to back, without waiting for `joined`: without serialization, the relay frame's
    // (synchronous, once parsed) handling could run before the join's (async, awaits `verifyRelayJoin`) does,
    // and get refused as "not joined to this channel".
    c.send({
      type: "join",
      channelId: fx.id,
      params: fx.params,
      signer: acct.address,
      sig: await signRelayJoin(acct, fx.id, c.nonce),
    });
    c.send({ type: "relay", message: { type: "state", channelId: fx.id, signed: s1 } });

    const got = await b.next((f) => f.type === "relay");
    expect(got.message.signed).toEqual(s1);
  });

  it("refuses a join whose params do not hash to channelId", async () => {
    const cfg = testConfig();
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx = makeChannelFixture(cfg);
    const c = await wsConnect(server.url);
    const acct = privateKeyToAccount(fx.kA);
    const wrongId = `0x${"ab".repeat(32)}` as Hex;
    c.send({
      type: "join",
      channelId: wrongId,
      params: fx.params,
      signer: acct.address,
      sig: await signRelayJoin(acct, wrongId, c.nonce),
    });
    const f = await c.next((f) => f.type === "error" || f.type === "joined");
    expect(f.type).toBe("error");
    expect(f.error).toMatch(/params do not match channel/);
    expect(f.channelId).toBe(wrongId); // the CLI matches join errors by the channelId *it* sent, not the host's guess
  });

  it("refuses a join by a key that is not one of the channel's signers", async () => {
    const cfg = testConfig();
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx = makeChannelFixture(cfg);
    const outsider = generatePrivateKey();
    const c = await wsConnect(server.url);
    const acct = privateKeyToAccount(outsider);
    c.send({
      type: "join",
      channelId: fx.id,
      params: fx.params,
      signer: acct.address,
      sig: await signRelayJoin(acct, fx.id, c.nonce),
    });
    const f = await c.next((f) => f.type === "error" || f.type === "joined");
    expect(f.type).toBe("error");
    expect(f.error).toMatch(/not a member of this channel/);
  });

  it("refuses a join signed over another connection's nonce (replay)", async () => {
    const cfg = testConfig();
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx = makeChannelFixture(cfg);
    const c1 = await wsConnect(server.url);
    const c2 = await wsConnect(server.url);
    const acct = privateKeyToAccount(fx.kA);
    const sig = await signRelayJoin(acct, fx.id, c1.nonce); // signed over c1's nonce
    c2.send({ type: "join", channelId: fx.id, params: fx.params, signer: acct.address, sig }); // replayed on c2
    const f = await c2.next((f) => f.type === "error" || f.type === "joined");
    expect(f.type).toBe("error");
    expect(f.error).toMatch(/bad join signature/);
  });

  it("refuses a second join over the connection's channel limit", async () => {
    const cfg = testConfig({ limits: { ...DEFAULT_LIMITS, maxJoinsPerConnection: 1 } });
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx1 = makeChannelFixture(cfg);
    const fx2 = makeChannelFixture(cfg); // a different channel
    const a = await joinAs(server.url, fx1, fx1.kA);

    const acct2 = privateKeyToAccount(fx2.kA);
    a.send({
      type: "join",
      channelId: fx2.id,
      params: fx2.params,
      signer: acct2.address,
      sig: await signRelayJoin(acct2, fx2.id, a.nonce),
    });
    const f = await a.next((f) => f.type === "error" || f.type === "joined");
    expect(f.type).toBe("error");
    expect(f.error).toMatch(/too many channels on this connection/);
  });

  it("refuses relay messages for channels the connection has not joined", async () => {
    const cfg = testConfig();
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx = makeChannelFixture(cfg);
    const c = await wsConnect(server.url); // never joins
    const s1 = await signStateAs(fx, rawStateAt(fx, 1n), 0);
    c.send({ type: "relay", message: { type: "state", channelId: fx.id, signed: s1 } });
    const f = await c.next((f) => f.type === "error");
    expect(f.error).toMatch(/not joined to this channel/);
    expect(f.channelId).toBe(fx.id);
  });

  it("refuses a state whose sender signature is missing or wrong and does not forward it", async () => {
    const cfg = testConfig();
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx = makeChannelFixture(cfg);
    const a = await joinAs(server.url, fx, fx.kA); // idx 0
    const b = await joinAs(server.url, fx, fx.kB);

    const state = rawStateAt(fx, 1n);
    const missing = { state, sigA: "0x" as Hex, sigB: "0x" as Hex }; // A forwards with no signature at all
    a.send({ type: "relay", message: { type: "state", channelId: fx.id, signed: missing } });
    const err1 = await a.next((f) => f.type === "error");
    expect(err1.error).toMatch(/state not signed by sender/);
    await expect(b.next((f) => f.type === "relay", 200)).rejects.toThrow();

    const wrong = await signStateAs(fx, state, 1); // signed by B's key, but A (idx 0) is the one forwarding it
    a.send({ type: "relay", message: { type: "state", channelId: fx.id, signed: wrong } });
    const err2 = await a.next((f) => f.type === "error");
    expect(err2.error).toMatch(/state not signed by sender/);
    await expect(b.next((f) => f.type === "relay", 200)).rejects.toThrow();
  });

  it("refuses a close message whose `by` is not the sender's index", async () => {
    const cfg = testConfig();
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx = makeChannelFixture(cfg);
    const a = await joinAs(server.url, fx, fx.kA); // idx 0
    const b = await joinAs(server.url, fx, fx.kB);

    a.send({ type: "relay", message: closeMsg(fx, 1) });
    const err = await a.next((f) => f.type === "error");
    expect(err.error).toMatch(/close not from sender/);
    await expect(b.next((f) => f.type === "relay", 200)).rejects.toThrow();
  });

  it("replays the peer's cached latest state and close to a (re)joining member", async () => {
    const cfg = testConfig();
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx = makeChannelFixture(cfg);
    const s1 = await signStateAs(fx, rawStateAt(fx, 1n), 0);
    const close = closeMsg(fx, 0);

    const a = await joinAs(server.url, fx, fx.kA);
    a.send({ type: "relay", message: { type: "state", channelId: fx.id, signed: s1 } }); // B offline
    await a.next(() => false, 200).catch(() => undefined); // let it land
    a.send({ type: "relay", message: close });
    await a.next(() => false, 200).catch(() => undefined);

    const b = await joinAs(server.url, fx, fx.kB);
    const first = await b.next((f) => f.type === "relay");
    expect(first.message).toEqual({ type: "state", channelId: fx.id, signed: s1 });
    const second = await b.next((f) => f.type === "relay");
    expect(second.message).toEqual(close);
  });

  it("does not replay a member's own messages back to it", async () => {
    const cfg = testConfig();
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx = makeChannelFixture(cfg);
    const s1 = await signStateAs(fx, rawStateAt(fx, 1n), 0);

    const a = await joinAs(server.url, fx, fx.kA);
    a.send({ type: "relay", message: { type: "state", channelId: fx.id, signed: s1 } });
    await a.next(() => false, 200).catch(() => undefined);

    const a2 = await joinAs(server.url, fx, fx.kA); // A reconnects and rejoins
    await expect(a2.next((f) => f.type === "relay", 200)).rejects.toThrow();
  });

  it("keeps only the latest state per sender (a newer state replaces the cache)", async () => {
    const cfg = testConfig();
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx = makeChannelFixture(cfg);
    const a = await joinAs(server.url, fx, fx.kA);
    const s1 = await signStateAs(fx, rawStateAt(fx, 1n), 0);
    const s2 = await signStateAs(fx, rawStateAt(fx, 2n), 0);
    a.send({ type: "relay", message: { type: "state", channelId: fx.id, signed: s1 } });
    await a.next(() => false, 200).catch(() => undefined);
    a.send({ type: "relay", message: { type: "state", channelId: fx.id, signed: s2 } });
    await a.next(() => false, 200).catch(() => undefined);

    const b = await joinAs(server.url, fx, fx.kB);
    const got = await b.next((f) => f.type === "relay");
    expect(got.message.signed).toEqual(s2);
    await expect(b.next((f) => f.type === "relay", 200)).rejects.toThrow(); // only one cached entry per sender
  });

  it("survives a server restart with a file database: cache is replayed after restart", async () => {
    const dbPath = join(tmpdir(), `arena-relay-${randomBytes(8).toString("hex")}.sqlite`);
    try {
      const cfg = testConfig({ dbPath });
      server = await startServer(cfg, { chain: new FakeChain() });
      const fx = makeChannelFixture(cfg);
      const a = await joinAs(server.url, fx, fx.kA);
      const s1 = await signStateAs(fx, rawStateAt(fx, 1n), 0);
      a.send({ type: "relay", message: { type: "state", channelId: fx.id, signed: s1 } });
      await a.next(() => false, 200).catch(() => undefined);
      await server.close();

      server = await startServer(cfg, { chain: new FakeChain() });
      const b = await joinAs(server.url, fx, fx.kB); // repopulates the channel's in-memory params
      const got = await b.next((f) => f.type === "relay");
      expect(got.message.signed).toEqual(s1);
    } finally {
      await server?.close();
      server = undefined;
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
  });

  it("drops frames above maxFrameBytes without affecting other members", async () => {
    const cfg = testConfig({ limits: { ...DEFAULT_LIMITS, maxFrameBytes: 1024 } });
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx = makeChannelFixture(cfg);
    const a = await joinAs(server.url, fx, fx.kA);
    const b = await joinAs(server.url, fx, fx.kB);

    const closed = new Promise<number>((resolve) => a.ws.addEventListener("close", (e: any) => resolve(e.code)));
    a.ws.send("x".repeat(2048)); // oversized raw payload -- `ws`'s maxPayload closes the socket with 1009
    expect(await closed).toBe(1009);

    // a fresh connection for A still works, and B still receives from it
    const a2 = await joinAs(server.url, fx, fx.kA);
    const s1 = await signStateAs(fx, rawStateAt(fx, 1n), 0);
    a2.send({ type: "relay", message: { type: "state", channelId: fx.id, signed: s1 } });
    const got = await b.next((f) => f.type === "relay");
    expect(got.message.signed).toEqual(s1);
  });

  it("re-confirms and replays a duplicate join, without double-counting maxJoinsPerConnection", async () => {
    const cfg = testConfig({ limits: { ...DEFAULT_LIMITS, maxJoinsPerConnection: 1 } });
    server = await startServer(cfg, { chain: new FakeChain() });
    const fx = makeChannelFixture(cfg);
    const a = await joinAs(server.url, fx, fx.kA);
    const b = await joinAs(server.url, fx, fx.kB);

    // something cached for A to replay: B's last message, not A's own
    const s1 = await signStateAs(fx, rawStateAt(fx, 1n), 1);
    b.send({ type: "relay", message: { type: "state", channelId: fx.id, signed: s1 } });
    await a.next((f) => f.type === "relay"); // A gets it live, once

    const acct = privateKeyToAccount(fx.kA);
    a.send({
      type: "join",
      channelId: fx.id,
      params: fx.params,
      signer: acct.address,
      sig: await signRelayJoin(acct, fx.id, a.nonce),
    });
    const f = await a.next((f) => f.type === "joined" || f.type === "error");
    expect(f.type).toBe("joined");
    expect(f.channelId).toBe(fx.id);
    // the duplicate join must not just re-confirm -- it replays the cache again too, at the limit of 1
    const replayed = await a.next((f) => f.type === "relay");
    expect(replayed.message.signed).toEqual(s1);
  });

  it("latestState returns the highest-turn validly signed cached state", async () => {
    const cfg = testConfig();
    const repo = new SqliteRepo(":memory:");
    const metrics: Metrics = { wsConnections: 0, relayMessages: 0, indexerBlock: null, indexerLag: null };
    const relay = new Relay(repo, cfg, metrics, () => {});
    const fx = makeChannelFixture(cfg);
    const peerA = fakePeer();
    const peerB = fakePeer();
    const acctA = privateKeyToAccount(fx.kA);
    const acctB = privateKeyToAccount(fx.kB);

    await relay.join(peerA, {
      channelId: fx.id,
      params: fx.params,
      signer: acctA.address,
      sig: await signRelayJoin(acctA, fx.id, peerA.nonce),
    });
    await relay.join(peerB, {
      channelId: fx.id,
      params: fx.params,
      signer: acctB.address,
      sig: await signRelayJoin(acctB, fx.id, peerB.nonce),
    });

    expect(relay.latestState(fx.id)).toBe(null);

    const s1 = await signStateAs(fx, rawStateAt(fx, 1n), 0);
    const s3 = await signStateAs(fx, rawStateAt(fx, 3n), 1);
    const s2 = await signStateAs(fx, rawStateAt(fx, 2n), 0);
    await relay.forward(peerA, { type: "state", channelId: fx.id, signed: s1 });
    await relay.forward(peerB, { type: "state", channelId: fx.id, signed: s3 });
    await relay.forward(peerA, { type: "state", channelId: fx.id, signed: s2 });

    expect(relay.latestState(fx.id)).toEqual(s3);
    repo.close();
  });

  it("seeds the verified-latest cache from the repo on a channel's first join in this process", async () => {
    const cfg = testConfig();
    const repo = new SqliteRepo(":memory:");
    const metrics: Metrics = { wsConnections: 0, relayMessages: 0, indexerBlock: null, indexerLag: null };
    const fx = makeChannelFixture(cfg);
    const acctA = privateKeyToAccount(fx.kA);
    const acctB = privateKeyToAccount(fx.kB);

    // one relay instance: B forwards a high-turn state, which lands in the shared repo cache
    const relay1 = new Relay(repo, cfg, metrics, () => {});
    const peerB1 = fakePeer();
    await relay1.join(peerB1, {
      channelId: fx.id,
      params: fx.params,
      signer: acctB.address,
      sig: await signRelayJoin(acctB, fx.id, peerB1.nonce),
    });
    const high = await signStateAs(fx, rawStateAt(fx, 5n), 1);
    await relay1.forward(peerB1, { type: "state", channelId: fx.id, signed: high });

    // a fresh Relay sharing the same repo (as after a restart): no channel joined yet in this process
    const relay2 = new Relay(repo, cfg, metrics, () => {});
    const peerA2 = fakePeer();
    await relay2.join(peerA2, {
      channelId: fx.id,
      params: fx.params,
      signer: acctA.address,
      sig: await signRelayJoin(acctA, fx.id, peerA2.nonce),
    });
    // A re-sends an older state, as it would on reconnect before learning of B's progress
    const low = await signStateAs(fx, rawStateAt(fx, 4n), 0);
    await relay2.forward(peerA2, { type: "state", channelId: fx.id, signed: low });

    expect(relay2.latestState(fx.id)).toEqual(high); // not clobbered by the lower-turn re-send
    repo.close();
  });

  it("channel map shrinks to 0 once both members have disconnected", async () => {
    const cfg = testConfig();
    const repo = new SqliteRepo(":memory:");
    const metrics: Metrics = { wsConnections: 0, relayMessages: 0, indexerBlock: null, indexerLag: null };
    const relay = new Relay(repo, cfg, metrics, () => {});
    const fx = makeChannelFixture(cfg);
    const peerA = fakePeer();
    const peerB = fakePeer();
    const acctA = privateKeyToAccount(fx.kA);
    const acctB = privateKeyToAccount(fx.kB);

    await relay.join(peerA, {
      channelId: fx.id,
      params: fx.params,
      signer: acctA.address,
      sig: await signRelayJoin(acctA, fx.id, peerA.nonce),
    });
    await relay.join(peerB, {
      channelId: fx.id,
      params: fx.params,
      signer: acctB.address,
      sig: await signRelayJoin(acctB, fx.id, peerB.nonce),
    });
    expect(relay.channelCount()).toBe(1);

    relay.leave(peerA);
    expect(relay.channelCount()).toBe(1); // B is still a member

    relay.leave(peerB);
    expect(relay.channelCount()).toBe(0); // no members left: the channel entry itself is dropped
    repo.close();
  });

  it("a join that completes after its socket closed leaves no member behind", async () => {
    const cfg = testConfig();
    const repo = new SqliteRepo(":memory:");
    const metrics: Metrics = { wsConnections: 0, relayMessages: 0, indexerBlock: null, indexerLag: null };
    const relay = new Relay(repo, cfg, metrics, () => {});
    const fx = makeChannelFixture(cfg);
    const peerA = fakePeer();
    const acctA = privateKeyToAccount(fx.kA);
    const sig = await signRelayJoin(acctA, fx.id, peerA.nonce); // computed before the race, like a real join

    const joinPromise = relay.join(peerA, {
      channelId: fx.id,
      params: fx.params,
      signer: acctA.address,
      sig,
    });
    relay.leave(peerA); // the socket closes while `join` is still awaiting signature verification
    await joinPromise;

    expect(relay.channelCount()).toBe(0); // `join` must not have added the now-dead peer as a member
    repo.close();
  });
});
