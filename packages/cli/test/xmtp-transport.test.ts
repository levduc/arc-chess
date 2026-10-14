import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toWire, type RelayMessage } from "@arena/sdk";
import { FallbackRelay } from "../src/xmtp/fallback.js";
import { createNodeSdkTransport, NOT_THE_PEER, XMTP_CATCH_UP_MESSAGES, type XmtpTransport } from "../src/xmtp/transport.js";
import { FakeHost, FakeSdk, sessionPair, settle } from "./helpers/xmtpFakes.js";

// Plan 5.7 Task 1 fix round 1: createNodeSdkTransport against a fake of the SDK's own stream semantics (C1, I1, I3,
// m3, m4, m5). The real SDK is exercised by the opt-in smoke test in xmtp-loader.test.ts.

type Got = { id: Hex; from: Address; dm: Address; text: string };

let dirs: string[] = [];
let transports: XmtpTransport[] = [];
let logs: string[] = [];

beforeEach(() => {
  logs = [];
  // The transport's holds and back-offs run on performance.now(): faked too, so they follow the fake timers.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});

afterEach(async () => {
  for (const t of transports.splice(0)) await t.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

/** B's transport over a fake SDK, opened on one channel with A as the opponent. */
async function bTransport(opts: { open?: boolean } = {}) {
  const a = privateKeyToAccount(generatePrivateKey());
  const b = privateKeyToAccount(generatePrivateKey());
  const sdk = new FakeSdk(b.address, a.address);
  const dir = mkdtempSync(join(tmpdir(), "arena-xmtp-transport-"));
  dirs.push(dir);
  const t = createNodeSdkTransport({ sdk, dbDir: dir, config: { env: "dev" }, log: (l) => logs.push(l) });
  transports.push(t);
  const got: Got[] = [];
  t.onText((id, from, dm, text) => got.push({ id, from, dm, text }));
  const channelId = `0x${"ab".repeat(32)}` as Hex;
  if (opts.open !== false) await t.open(channelId, b, a.address);
  return { a, b, sdk, t, got, channelId };
}

async function advance(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await settle();
}

describe("createNodeSdkTransport: the inbound stream", () => {
  it("drains the stream with for-await (no onValue), so a flood never piles up in the SDK's buffer (C1)", async () => {
    const { a, sdk, got } = await bTransport();
    const stream = sdk.stream;
    expect(stream.opts.onValue).toBeUndefined();
    expect(stream.opts.retryOnFail).toBe(false);
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 1000; i++) stream.push(sdk.msg(`m-${round}-${i}`, a.address, `t${round}-${i}`));
      await settle();
      expect(stream.buffer).toHaveLength(0); // read as fast as it arrives, not kept
    }
    expect(got).toHaveLength(5000);
    expect(got[0]).toMatchObject({ from: a.address, dm: a.address, text: "t0-0" });
    expect(got.at(-1)?.text).toBe("t4-999");
    expect(sdk.lookups).toBe(0); // the DM was created at open: its peer is known without a lookup (m3)
  });

  it("asks only for DMs in Allowed or Unknown consent, and denies a stranger's DM on its first message (m5)", async () => {
    const { sdk, got } = await bTransport();
    expect(sdk.stream.opts.conversationType).toBe(sdk.ConversationType.Dm);
    expect(sdk.stream.opts.consentStates).toEqual([FakeSdk.ConsentState.Allowed, FakeSdk.ConsentState.Unknown]);
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    const conv = sdk.strangerDm(stranger);
    for (let i = 0; i < 50; i++) sdk.stream.push(sdk.msg(`x-${i}`, stranger, "spam", conv));
    await settle();
    expect(got).toHaveLength(50);
    expect(got.every((g) => g.from === NOT_THE_PEER && g.dm === NOT_THE_PEER)).toBe(true);
    expect(sdk.conversations.get(conv)?.consent).toEqual([FakeSdk.ConsentState.Denied]); // once, not 50 times
    expect(sdk.conversations.get("dm-ab")?.consent).not.toContain(FakeSdk.ConsentState.Denied);
  });

  it("never denies the opponent's DM, even when its first message arrives before the opponent's inbox is known", async () => {
    const { a, sdk, got, t, b, channelId } = await bTransport({ open: false });
    sdk.peerRegistered = false; // no DM can be created, no network lookup finds A
    await t.open(channelId, b, a.address);
    sdk.peerRegistered = true;
    sdk.stream.push(sdk.msg("a-1", a.address, "hello")); // A created the DM from its side
    await settle();
    expect(got).toEqual([{ id: channelId, from: a.address, dm: a.address, text: "hello" }]);
    expect(sdk.conversations.get("dm-ab")?.consent).toEqual([FakeSdk.ConsentState.Allowed]);
  });

  it("delivers in arrival order, one at a time, even when a lookup for the first message is slow (I3)", async () => {
    const { a, sdk, got, t, b, channelId } = await bTransport({ open: false });
    sdk.peerRegistered = false; // A's DM unknown at open: the first message needs a conversation lookup
    await t.open(channelId, b, a.address);
    sdk.peerRegistered = true;
    let release: () => void = () => undefined;
    sdk.lookupGate = new Promise<void>((r) => (release = r));
    sdk.stream.push(sdk.msg("a-1", a.address, "first"));
    sdk.stream.push(sdk.msg("a-2", a.address, "second"));
    await settle();
    expect(got).toEqual([]); // the second waits for the first
    release();
    await settle();
    expect(got.map((g) => g.text)).toEqual(["first", "second"]);
    expect(sdk.lookups).toBe(1); // cached per conversation (m3)
  });

  it("restarts a failed stream for as long as the channel is open, re-delivering what arrived in the gap (I1)", async () => {
    const { a, sdk, got } = await bTransport();
    sdk.stream.push(sdk.msg("a-1", a.address, "before"));
    sdk.history.push(sdk.msg("a-1", a.address, "before"));
    await settle();
    sdk.stream.fail();
    await settle();
    expect(logs.some((l) => l.includes("inbound stream ended; restarting in 1s"))).toBe(true);
    // Arrived while the stream was down: only the catch-up can deliver them.
    sdk.history.push(sdk.msg("a-2", a.address, "gap-1"), sdk.msg("a-3", a.address, "gap-2"));
    await advance(1_000);
    expect(sdk.streams).toHaveLength(2);
    expect(got.map((g) => g.text)).toEqual(["before", "gap-1", "gap-2"]); // "before" not twice: same message id
    expect(sdk.messagesCalls.at(-1)?.limit).toBe(XMTP_CATCH_UP_MESSAGES);
    // Far past the SDK's own 10 attempts: starts that keep failing (the SDK returns an already-ended stream and reports
    // onError) are retried with a capped back-off, and each one still runs its catch-up.
    const catchUpsBefore = sdk.messagesCalls.length;
    sdk.stream.fail();
    sdk.failStarts = 20;
    await settle();
    expect(logs.some((l) => l.includes("restarting in 2s"))).toBe(true); // the back-off doubled
    for (let i = 0; i < 25; i++) await advance(30_000);
    expect(sdk.streamCalls.length).toBeGreaterThanOrEqual(2 + 20 + 1);
    expect(sdk.messagesCalls.length - catchUpsBefore).toBeGreaterThanOrEqual(20 + 1);
    expect(logs.some((l) => l.includes("stream error: syncAll failed: offline"))).toBe(true);
    expect(logs.some((l) => l.includes("restarting in 30s"))).toBe(true); // capped
    expect(sdk.stream.isDone).toBe(false); // a live stream again
    sdk.stream.push(sdk.msg("a-4", a.address, "after"));
    await settle();
    expect(got.at(-1)?.text).toBe("after");
  });

  it("the catch-up is bounded, and a message in both the catch-up and the stream is delivered once, in order", async () => {
    const { a, sdk, got, t, b, channelId } = await bTransport({ open: false });
    for (let i = 0; i < 20; i++) sdk.history.push(sdk.msg(`h-${i}`, a.address, `h${i}`));
    await t.open(channelId, b, a.address);
    expect(got.map((g) => g.text)).toEqual(Array.from({ length: XMTP_CATCH_UP_MESSAGES }, (_, i) => `h${20 - XMTP_CATCH_UP_MESSAGES + i}`));
    sdk.stream.push(sdk.msg("h-19", a.address, "h19")); // the overlap
    sdk.stream.push(sdk.msg("n-1", a.address, "new"));
    await settle();
    expect(got.map((g) => g.text).slice(-2)).toEqual(["h19", "new"]);
    expect(got).toHaveLength(XMTP_CATCH_UP_MESSAGES + 1);
  });

  it("a conversation lookup that comes back empty once is retried in place: the opponent's messages arrive in order (I-N1)", async () => {
    const { a, sdk, got, t, b, channelId } = await bTransport({ open: false });
    sdk.peerRegistered = false; // A's DM unknown at open: its first message needs a lookup
    await t.open(channelId, b, a.address);
    sdk.peerRegistered = true;
    sdk.lookupMisses = 1; // a transient native error
    sdk.stream.push(sdk.msg("a-1", a.address, "move-1"));
    sdk.stream.push(sdk.msg("a-2", a.address, "move-2"));
    await settle();
    expect(got).toEqual([]); // waiting on the retry, in order
    await advance(100);
    expect(got.map((g) => [g.text, g.dm])).toEqual([
      ["move-1", a.address],
      ["move-2", a.address],
    ]);
    expect(sdk.lookups).toBe(2); // the empty answer was not cached
    sdk.stream.push(sdk.msg("a-3", a.address, "move-3"));
    await settle();
    expect(got.at(-1)).toMatchObject({ text: "move-3", dm: a.address });
    expect(sdk.lookups).toBe(2); // the real answer was
  });

  it("lookups that keep coming back empty: passed on unresolved, never seen, then delivered in order by a catch-up", async () => {
    const { a, sdk, got, t, b, channelId } = await bTransport({ open: false });
    sdk.peerRegistered = false;
    await t.open(channelId, b, a.address);
    sdk.peerRegistered = true;
    sdk.lookupMisses = 4; // the first lookup and its three retries
    for (const [id, text] of [["a-1", "move-1"], ["a-2", "move-2"]] as const) {
      sdk.history.push(sdk.msg(id, a.address, text));
      sdk.stream.push(sdk.msg(id, a.address, text));
    }
    await settle();
    await advance(100);
    await advance(400);
    await advance(1_500);
    // Both passed on as not in the DM (XmtpRelay drops and counts them); the second one without any lookup.
    expect(got.map((g) => [g.text, g.dm])).toEqual([
      ["move-1", NOT_THE_PEER],
      ["move-2", NOT_THE_PEER],
    ]);
    expect(sdk.lookups).toBe(4);
    for (let i = 0; i < 100; i++) sdk.stream.push(sdk.msg(`s-${i}`, a.address, "flood"));
    await settle();
    expect(sdk.lookups).toBe(4); // held: no lookup per message
    // After the hold, the stream is restarted; its catch-up finds the DM itself and delivers what was left un-seen.
    const streams = sdk.streams.length;
    await advance(5_000);
    await advance(1_000);
    expect(sdk.streams.length).toBe(streams + 1);
    expect(got.filter((g) => g.dm === a.address).map((g) => g.text)).toEqual(["move-1", "move-2"]);
  });

  it("denies a stranger's DM even before the opponent's inbox is known, when the sender's inbox lacks the opponent's address", async () => {
    const { a, sdk, got, t, b, channelId } = await bTransport({ open: false });
    sdk.peerRegistered = false; // the opponent never registers (it runs without XMTP)
    await t.open(channelId, b, a.address);
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    const conv = sdk.strangerDm(stranger);
    for (let i = 0; i < 10; i++) sdk.stream.push(sdk.msg(`x-${i}`, stranger, "spam", conv));
    await settle();
    expect(got).toHaveLength(10);
    expect(sdk.conversations.get(conv)?.consent).toEqual([FakeSdk.ConsentState.Denied]);
  });

  it("a stranger's DM whose lookup comes back empty is denied on a later message, not marked denied meanwhile", async () => {
    const { sdk } = await bTransport();
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    const conv = sdk.strangerDm(stranger);
    sdk.lookupMisses = 1;
    sdk.stream.push(sdk.msg("x-1", stranger, "spam", conv));
    await settle();
    expect(sdk.conversations.get(conv)?.consent).toEqual([]);
    sdk.stream.push(sdk.msg("x-2", stranger, "spam", conv)); // within the hold: no lookup
    await settle();
    expect(sdk.lookups).toBe(1);
    await advance(5_000);
    sdk.stream.push(sdk.msg("x-3", stranger, "spam", conv));
    await settle();
    expect(sdk.conversations.get(conv)?.consent).toEqual([FakeSdk.ConsentState.Denied]);
  });

  it("denies strangers' group invites at every stream (re)start (m5)", async () => {
    const { sdk, t, a, b, channelId } = await bTransport({ open: false });
    const g1 = sdk.strangerGroup("group-1");
    await t.open(channelId, b, a.address);
    expect(g1.consent).toEqual([FakeSdk.ConsentState.Denied]);
    const g2 = sdk.strangerGroup("group-2"); // invited mid-stream
    sdk.stream.fail();
    await settle();
    await advance(1_000);
    expect(g2.consent).toEqual([FakeSdk.ConsentState.Denied]);
    expect(g1.consent).toEqual([FakeSdk.ConsentState.Denied]); // not denied twice
    expect(logs.filter((l) => l.includes("denied 1 group invite(s) from strangers"))).toHaveLength(2);
  });

  it("stop ends the restart loop: no stream is created after it (m4)", async () => {
    const { sdk, t } = await bTransport();
    sdk.stream.fail();
    await settle(); // now sleeping before a restart
    const calls = sdk.streamCalls.length;
    await t.stop();
    await advance(120_000);
    expect(sdk.streamCalls.length).toBe(calls);
  });

  it("close while a stream is being created ends that stream and starts no other", async () => {
    const { a, sdk, t, b, channelId } = await bTransport({ open: false });
    const opening = t.open(channelId, b, a.address);
    const closing = t.close(channelId); // before Client.create / streamAllMessages have returned
    await opening.catch(() => undefined);
    await closing;
    await advance(120_000);
    expect(sdk.streams.every((s) => s.isDone)).toBe(true);
    expect(sdk.streamCalls.length).toBeLessThanOrEqual(1);
  });
});

describe("FallbackRelay over the node-sdk transport: XMTP order reaches the session (I3 scenarios)", () => {
  /** B's FallbackRelay over a fake host that is down and the fake-SDK transport, feeding B's real session. */
  async function bOverXmtp() {
    const pair = await sessionPair();
    const [aSigner, bSigner] = pair.signers;
    const sdk = new FakeSdk(bSigner.address, aSigner.address);
    sdk.peerRegistered = false; // so the first message needs a (slow) lookup
    const dir = mkdtempSync(join(tmpdir(), "arena-xmtp-transport-"));
    dirs.push(dir);
    const transport = createNodeSdkTransport({ sdk, dbDir: dir, config: { env: "dev" }, log: (l) => logs.push(l) });
    const host = new FakeHost();
    const relay = new FallbackRelay({ host, xmtp: transport, log: (l) => logs.push(l) });
    transports.push({ ...transport, stop: () => relay.stop() });
    const results: string[] = [];
    let chain = Promise.resolve();
    relay.onMessage((m: RelayMessage) => {
      chain = chain.then(async () => {
        try {
          if (m.type === "state") results.push(await pair.b.receive(m.signed));
          else {
            await pair.b.receiveClose(m.close);
            results.push("close");
          }
        } catch (err) {
          results.push(`error: ${(err as Error).message}`);
        }
      });
    });
    await relay.join(pair.id, pair.params, bSigner);
    await settle();
    sdk.peerRegistered = true;
    let n = 0;
    const push = (m: RelayMessage) => sdk.stream.push(sdk.msg(`a-${++n}`, aSigner.address, toWire({ arena: 1, msg: m })));
    return { ...pair, sdk, push, results, drained: () => chain };
  }

  it("the opponent resigns, then signs Close: both arrive together, the slow first one still goes first", async () => {
    const { a, b, id, sdk, push, results, drained } = await bOverXmtp();
    let release: () => void = () => undefined;
    sdk.lookupGate = new Promise<void>((r) => (release = r));
    push({ type: "state", channelId: id, signed: await a.resign() });
    const ca = await a.signClose();
    push({ type: "close", channelId: id, close: ca });
    await settle();
    release();
    await settle();
    await drained();
    expect(results).toEqual(["move", "close"]);
    expect(b.snapshot().closeSigs[0]).toBe(ca.sig);
  });

  it("the opponent's terminal move, then its new-game proposal: never processed the wrong way round", async () => {
    const { a, id, sdk, push, results, drained } = await bOverXmtp();
    let release: () => void = () => undefined;
    sdk.lookupGate = new Promise<void>((r) => (release = r));
    push({ type: "state", channelId: id, signed: await a.resign() });
    push({ type: "state", channelId: id, signed: await a.proposeNewGame() });
    await settle();
    release();
    await settle();
    await drained();
    expect(results).toEqual(["move", "checkpoint-proposed"]);
  });
});
