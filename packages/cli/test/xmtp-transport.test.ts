import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toWire, type RelayMessage } from "@arena/sdk";
import { FallbackRelay } from "../src/xmtp/fallback.js";
import { XMTP_INBOUND_BURST } from "../src/xmtp/relay.js";
import { createNodeSdkTransport, NOT_THE_PEER, UNDETERMINED, XMTP_CATCH_UP_MESSAGES, type XmtpTransport } from "../src/xmtp/transport.js";
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
  t.onText((id, from, dm, text) => {
    got.push({ id, from, dm, text });
  });
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

  it("the fast path: a message in the opponent's DM, or a stitched duplicate known at open, costs no lookup at all", async () => {
    const { a, sdk, got, t, b, channelId } = await bTransport({ open: false });
    sdk.duplicateDm("dm-dup"); // both sides created a DM at once: XMTP stitches the two
    await t.open(channelId, b, a.address);
    const reads = { conv: sdk.lookups, state: sdk.inboxStateReads, net: sdk.inboxLookups };
    for (let i = 0; i < 100; i++) sdk.stream.push(sdk.msg(`m-${i}`, a.address, `t${i}`, i % 2 === 0 ? "dm-ab" : "dm-dup"));
    await settle();
    expect(got).toHaveLength(100);
    expect(got.every((g) => g.from === a.address && g.dm === a.address)).toBe(true);
    expect({ conv: sdk.lookups, state: sdk.inboxStateReads, net: sdk.inboxLookups }).toEqual(reads);
    expect(reads).toEqual({ conv: 0, state: 0, net: 0 });
  });

  it("a conversation lookup that comes back empty: delivered at once as undetermined, never held or retried in place (I-N1)", async () => {
    const { a, sdk, got, t, b, channelId } = await bTransport({ open: false });
    sdk.peerRegistered = false; // A's DM unknown at open: its first message needs a lookup
    await t.open(channelId, b, a.address);
    sdk.peerRegistered = true;
    sdk.lookupMisses = 1; // a transient native error
    sdk.stream.push(sdk.msg("a-1", a.address, "move-1"));
    sdk.stream.push(sdk.msg("a-2", a.address, "move-2"));
    await settle();
    expect(got.map((g) => [g.text, g.from, g.dm])).toEqual([
      ["move-1", a.address, UNDETERMINED],
      ["move-2", a.address, UNDETERMINED],
    ]);
    expect(sdk.lookups).toBe(1); // no retry in place, and none for the same conversation within LOOKUP_RETRY_MS
    await advance(5_000);
    sdk.stream.push(sdk.msg("a-3", a.address, "move-3"));
    sdk.stream.push(sdk.msg("a-4", a.address, "move-4"));
    await settle();
    expect(got.slice(2).map((g) => [g.text, g.dm])).toEqual([
      ["move-3", a.address],
      ["move-4", a.address],
    ]);
    expect(sdk.lookups).toBe(2); // the real answer is cached: move-4 took the fast path
  });

  /** B's transport whose opponent DM was unknown at open (B opened before A registered), so A's first message needs a
   *  conversation lookup -- and every lookup comes back empty for a while. */
  async function lookupsFailing(misses: number) {
    const tb = await bTransport({ open: false });
    tb.sdk.peerRegistered = false;
    await tb.t.open(tb.channelId, tb.b, tb.a.address);
    tb.sdk.peerRegistered = true;
    tb.sdk.lookupMisses = misses;
    return tb;
  }

  const texts = (got: Got[]) => got.map((g) => [g.text, g.dm]);

  it("lookups that keep coming back empty: every message delivered at once, in order, with no restart and no log (I-N2)", async () => {
    const { a, sdk, got } = await lookupsFailing(1_000);
    const streams = sdk.streams.length;
    sdk.arrive("a-1", a.address, "M1");
    sdk.arrive("a-2", a.address, "M2");
    await settle();
    expect(texts(got)).toEqual([
      ["M1", UNDETERMINED],
      ["M2", UNDETERMINED],
    ]);
    await advance(120_000);
    expect(got).toHaveLength(2); // nothing re-delivered later
    expect(sdk.streams.length).toBe(streams); // no restart
    expect(logs).toEqual([]);
  });

  it("P1: our own send fills the DM cache mid-outage: the next message takes the fast path, after the earlier one (I-N2)", async () => {
    const { a, sdk, got, t, channelId } = await lookupsFailing(1_000);
    sdk.arrive("a-1", a.address, "M1");
    await settle();
    expect(texts(got)).toEqual([["M1", UNDETERMINED]]); // delivered, not held
    await t.send(channelId, "our reply"); // finds the DM: the cache now knows it
    sdk.arrive("a-2", a.address, "M2");
    await settle();
    expect(texts(got)).toEqual([
      ["M1", UNDETERMINED],
      ["M2", a.address],
    ]);
    expect(sdk.lookups).toBe(1); // M2 needed none
  });

  it("P3: the DM cannot be found either: still nothing held, nothing overtaken, nothing repeated by a restart (I-N2)", async () => {
    const { a, sdk, got } = await lookupsFailing(1_000);
    sdk.dmFailures = 1_000; // every catch-up fails to get the DM
    sdk.arrive("a-1", a.address, "M1");
    await settle();
    sdk.arrive("a-3", a.address, "M3");
    await settle();
    expect(got.map((g) => g.text)).toEqual(["M1", "M3"]);
    sdk.stream.fail(); // a restart whose catch-up fails
    await settle();
    await advance(1_000);
    sdk.dmFailures = 0;
    sdk.stream.fail(); // a restart whose catch-up works: same message ids, not repeated
    await settle();
    await advance(2_000);
    expect(got.map((g) => g.text)).toEqual(["M1", "M3"]);
    expect(logs.filter((l) => !l.includes("inbound stream ended; restarting in"))).toEqual([]);
  });

  it("P2: more opponent messages than the catch-up window during an outage are all delivered at once, in order", async () => {
    const { a, sdk, got } = await lookupsFailing(1_000);
    sdk.dmFailures = 1_000;
    sdk.arrive("a-0", a.address, "M1");
    for (let i = 0; i < XMTP_CATCH_UP_MESSAGES + 4; i++) sdk.arrive(`r-${i}`, a.address, `R${i}`);
    await settle();
    expect(got.map((g) => g.text)).toEqual(["M1", ...Array.from({ length: XMTP_CATCH_UP_MESSAGES + 4 }, (_, i) => `R${i}`)]);
    expect(got.every((g) => g.from === a.address)).toBe(true); // the sender was known; only its conversation was not
    expect(logs).toEqual([]); // no line per message
  });

  it("I-N3: the opponent's inbox not known yet and both of its lookups fail: the message is delivered at once, in order", async () => {
    const { a, sdk, got, t, b, channelId } = await bTransport({ open: false });
    sdk.peerRegistered = false; // B opened before A registered: no DM, no inbox id
    await t.open(channelId, b, a.address);
    sdk.peerRegistered = true;
    sdk.inboxStateFailures = 1; // B's local read of the sender's inbox throws once (a busy DB)...
    sdk.inboxLookupFailures = 1; // ...and so does the network lookup of A's inbox
    sdk.arrive("a-1", a.address, "M1");
    sdk.arrive("a-2", a.address, "M2");
    await settle();
    expect(got.map((g) => [g.text, g.from, g.dm])).toEqual([
      ["M1", UNDETERMINED, UNDETERMINED],
      ["M2", a.address, a.address],
    ]);
    await advance(120_000);
    expect(got).toHaveLength(2); // nothing held for later, nothing repeated
    expect(logs).toEqual([]);
  });

  it("the network lookup of the opponent's inbox runs beside the queue: the message at hand never waits for it", async () => {
    const { a, sdk, got, t, b, channelId } = await bTransport({ open: false });
    sdk.peerRegistered = false;
    await t.open(channelId, b, a.address);
    sdk.peerRegistered = true;
    sdk.inboxStateFailures = 1_000; // the local read keeps failing
    sdk.arrive("a-1", a.address, "M1");
    await settle();
    expect(got.map((g) => [g.text, g.from])).toEqual([["M1", UNDETERMINED]]);
    expect(sdk.inboxLookups).toBe(1); // started for later messages, and it found A's inbox
    sdk.arrive("a-2", a.address, "M2");
    await settle();
    expect(got.at(-1)).toMatchObject({ text: "M2", from: a.address, dm: a.address });
    expect(sdk.inboxLookups).toBe(1);
  });

  it("strangers never restart the stream, even with every lookup failing; once the opponent is known they are known strangers", async () => {
    const { sdk, got } = await bTransport();
    sdk.lookupMisses = 1_000_000;
    const streams = sdk.streams.length;
    for (let c = 0; c < 50; c++) {
      const stranger = privateKeyToAccount(generatePrivateKey()).address;
      const conv = sdk.strangerDm(stranger);
      for (let i = 0; i < 3; i++) sdk.stream.push(sdk.msg(`x-${c}-${i}`, stranger, "spam", conv));
    }
    await settle();
    for (let i = 0; i < 12; i++) await advance(5_000);
    expect(sdk.streams.length).toBe(streams); // 0 restarts
    expect(got).toHaveLength(150);
    expect(got.every((g) => g.from === NOT_THE_PEER && g.dm === NOT_THE_PEER)).toBe(true); // all dropped by XmtpRelay
    expect(sdk.lookups).toBeLessThanOrEqual(50 * 2); // one per conversation, then not again for LOOKUP_RETRY_MS
    expect(logs).toEqual([]);
  });

  it("a stranger whose inbox state lists only other identifiers (a passkey, say) is a known stranger, never undetermined", async () => {
    const { sdk, got, t, a, b, channelId } = await bTransport({ open: false });
    sdk.peerRegistered = false; // the opponent never registers: its inbox stays unknown
    await t.open(channelId, b, a.address);
    sdk.inboxStateOf = () => ({ identifiers: [{ identifier: "passkey-1", identifierKind: sdk.IdentifierKind.Passkey }] });
    sdk.stream.push(sdk.msg("p-1", privateKeyToAccount(generatePrivateKey()).address, "spam", "dm-passkey"));
    await settle();
    expect(got.map((g) => [g.from, g.dm])).toEqual([[NOT_THE_PEER, NOT_THE_PEER]]);
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

  it("C-N1: its DM, found by the opponent's address, replaces a wrong opponent inbox (here a stale network answer)", async () => {
    const { a, sdk, got, t, b, channelId } = await bTransport({ open: false });
    sdk.peerRegistered = false; // B opened before A registered
    await t.open(channelId, b, a.address);
    sdk.inboxAnswers.push("inbox-stale"); // the network's lookup of A's inbox answers someone else's
    sdk.inboxStateFailures = 1; // so the first message is undetermined
    sdk.arrive("a-1", a.address, "M1");
    await settle();
    expect(got.map((g) => [g.text, g.from, g.dm])).toEqual([["M1", UNDETERMINED, UNDETERMINED]]);
    expect(sdk.inboxLookups).toBe(1); // the opponent's inbox is now stored as "inbox-stale"
    sdk.peerRegistered = true;
    await t.send(channelId, "our reply"); // dmOf: the DM found by A's address names A's inbox, and replaces the stale one
    const lookups = sdk.lookups;
    sdk.arrive("a-2", a.address, "M2");
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    sdk.stream.push(sdk.msg("x-1", stranger, "spam", sdk.strangerDm(stranger)));
    await settle();
    expect(got.slice(1).map((g) => [g.text, g.from, g.dm])).toEqual([
      ["M2", a.address, a.address], // the fast path
      ["spam", NOT_THE_PEER, NOT_THE_PEER],
    ]);
    expect(sdk.lookups - lookups).toBe(1); // the stranger's DM, to deny it; none for A's message
    expect(sdk.conversations.get("dm-ab")?.consent).not.toContain(FakeSdk.ConsentState.Denied);
  });

  it("C-N1: the opponent's DM denied by an earlier wrong classification is allowed again once found by address; its message is recovered", async () => {
    const { a, sdk, got, t, b, channelId } = await bTransport({ open: false });
    sdk.peerRegistered = false;
    await t.open(channelId, b, a.address);
    sdk.inboxAnswers.push("inbox-stale");
    sdk.inboxStateFailures = 1;
    sdk.arrive("a-1", a.address, "M1"); // undetermined; the network's stale answer is stored
    await settle();
    sdk.arrive("a-2", a.address, "M2"); // A is not "inbox-stale": taken for a stranger, and dm-ab denied
    await settle();
    expect(got.map((g) => [g.text, g.from, g.dm])).toEqual([
      ["M1", UNDETERMINED, UNDETERMINED],
      ["M2", NOT_THE_PEER, NOT_THE_PEER],
    ]);
    expect(sdk.conversations.get("dm-ab")?.consent).toEqual([FakeSdk.ConsentState.Denied]);
    const streams = sdk.streams.length;
    sdk.peerRegistered = true;
    await t.send(channelId, "our reply"); // dmOf: A's inbox replaces the stale one, and dm-ab is allowed again
    await settle();
    expect(sdk.conversations.get("dm-ab")?.consent).toEqual([FakeSdk.ConsentState.Denied, FakeSdk.ConsentState.Allowed]);
    expect(logs.filter((l) => l.includes("the opponent's conversation dm-ab was denied; allowed again"))).toHaveLength(1);
    // The stream is restarted (a stream carries only the conversations allowed when it starts), and its catch-up
    // re-reads dm-ab: M2 was never marked delivered, M1 was.
    await advance(1_000);
    expect(sdk.streams.length).toBe(streams + 1);
    expect(got.slice(2).map((g) => [g.text, g.from, g.dm])).toEqual([["M2", a.address, a.address]]);
    sdk.arrive("a-3", a.address, "M3");
    await settle();
    expect(got.at(-1)).toMatchObject({ text: "M3", from: a.address, dm: a.address });
    expect(sdk.conversations.get("dm-ab")?.consent).toEqual([FakeSdk.ConsentState.Denied, FakeSdk.ConsentState.Allowed]);
  });

  it("C-N1: the opponent's DM left denied in the DB is allowed again at open, before the stream starts", async () => {
    const { a, sdk, got, t, b, channelId } = await bTransport({ open: false });
    sdk.conversations.get("dm-ab")?.updateConsentState(FakeSdk.ConsentState.Denied); // by an earlier run
    sdk.history.push(sdk.msg("a-1", a.address, "M1"));
    await t.open(channelId, b, a.address);
    expect(sdk.conversations.get("dm-ab")?.consent).toEqual([FakeSdk.ConsentState.Denied, FakeSdk.ConsentState.Allowed]);
    expect(sdk.streams).toHaveLength(1); // allowed before the stream was created: no restart needed
    expect(got.map((g) => [g.text, g.from, g.dm])).toEqual([["M1", a.address, a.address]]);
  });

  it("C-N1: deny never denies the opponent's DM once found by address, even for a message classified before that", async () => {
    const { a, sdk, got, t, b, channelId } = await bTransport({ open: false });
    sdk.peerRegistered = false;
    await t.open(channelId, b, a.address);
    // B's local copy of A's inbox is wrong (it lacks A's address), and the network lookup fails: A's message is taken
    // for a stranger's, and its DM is about to be denied.
    const aInbox = FakeSdk.inboxOf(a.address);
    sdk.inboxStateOf = (inbox) => (inbox === aInbox ? { identifiers: [{ identifier: `0x${"0b".repeat(20)}`, identifierKind: 0 }] } : null);
    sdk.inboxLookupFailures = 1_000;
    let release: () => void = () => undefined;
    sdk.lookupGate = new Promise<void>((r) => (release = r)); // deny's conversation lookup is slow
    sdk.arrive("a-1", a.address, "M1");
    await settle();
    sdk.peerRegistered = true;
    await t.send(channelId, "our reply"); // meanwhile, dmOf finds dm-ab by A's address
    release();
    await settle();
    expect(got.map((g) => [g.text, g.from])).toEqual([["M1", NOT_THE_PEER]]);
    expect(sdk.conversations.get("dm-ab")?.consent).toEqual([]); // never denied
    // M1 was never marked delivered: the next catch-up delivers it, as A's.
    sdk.stream.fail();
    await settle();
    await advance(1_000);
    expect(got.at(-1)).toMatchObject({ text: "M1", from: a.address, dm: a.address });
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

describe("FallbackRelay over the node-sdk transport: what reaches the session (I3 scenarios, spec §3)", () => {
  /** B's FallbackRelay over a fake host that is down and the fake-SDK transport, feeding B's real session. A
   *  rejection is handed back to `countRejected`, as the daemon does. `dmKnown`: A registered before B opened.
   *  `registerLater`: A registers only when the test says so (`sdk.peerRegistered = true`). */
  async function bOverXmtp(opts: { dmKnown?: boolean; registerLater?: boolean } = {}) {
    const pair = await sessionPair();
    const [aSigner, bSigner] = pair.signers;
    const sdk = new FakeSdk(bSigner.address, aSigner.address);
    sdk.peerRegistered = opts.dmKnown === true; // otherwise the first message needs a (slow) lookup
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
          results.push(relay.countRejected(m) ? "rejected (counted)" : `error: ${(err as Error).message}`);
        }
      });
    });
    await relay.join(pair.id, pair.params, bSigner);
    await settle();
    if (opts.registerLater !== true) sdk.peerRegistered = true;
    let n = 0;
    const push = (m: RelayMessage, from: Address = aSigner.address, conv = "dm-ab") =>
      sdk.stream.push(sdk.msg(`a-${++n}`, from, toWire({ arena: 1, msg: m }), conv));
    return { ...pair, sdk, transport, relay, push, results, drained: () => chain };
  }

  it("C-N1: a stranger that names the opponent's address as its inbox's recovery identifier stays a known stranger", async () => {
    const { a, b, id, signers, sdk, transport, relay, push, results, drained } = await bOverXmtp({ registerLater: true });
    const [aSigner, bSigner] = signers;
    const eve = privateKeyToAccount(generatePrivateKey()).address;
    const eveInbox = FakeSdk.inboxOf(eve);
    // B's local copy of Eve's inbox: Eve's own address its only member, A's session address its recovery identifier.
    // XMTP's ChangeRecoveryIdentity is signed by the current recovery identity alone: A never signed anything.
    sdk.inboxStateOf = (inbox) =>
      inbox === eveInbox
        ? {
            identifiers: [{ identifier: eve.toLowerCase(), identifierKind: 0 }],
            recoveryIdentifier: { identifier: aSigner.address.toLowerCase(), identifierKind: 0 },
          }
        : null;
    const eveDm = sdk.strangerDm(eve);
    const genuine = await a.move("e2e4");
    const forged = { ...genuine, sigA: await bSigner.signMessage({ message: "eve" }) };

    // B opened before A registered: neither A's inbox nor its DM is known yet.
    push({ type: "state", channelId: id, signed: forged }, eve, eveDm);
    await settle();
    await drained();
    expect(results).toEqual([]); // dropped before the session, as a known stranger's
    expect(relay.dropped(id)).toBe(1);
    expect(sdk.conversations.get(eveDm)?.consent).toEqual([FakeSdk.ConsentState.Denied]);

    // A registers; B sends over XMTP (its DM lookup finds dm-ab); A's genuine move arrives in it.
    sdk.peerRegistered = true;
    await transport.send(id, "b's reply");
    push({ type: "state", channelId: id, signed: genuine });
    await settle();
    await drained();
    expect(results).toEqual(["move"]);
    expect(b.latest.state.turnNum).toBe(1n);
    expect(sdk.conversations.get("dm-ab")?.consent).not.toContain(FakeSdk.ConsentState.Denied);

    // Eve floods: every message a known stranger's, dropped before the session (no lastError, no line per message).
    for (let i = 0; i < 300; i++) push({ type: "state", channelId: id, signed: forged }, eve, eveDm);
    await settle();
    await drained();
    expect(results).toEqual(["move"]);
    expect(relay.dropped(id)).toBe(301);
    expect(sdk.conversations.get("dm-ab")?.consent).not.toContain(FakeSdk.ConsentState.Denied);
  });

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

  it("a known stranger is dropped before it spends any of the channel's rate-limit budget", async () => {
    const { a, id, relay, push, results, drained } = await bOverXmtp({ dmKnown: true });
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    const resign = await a.resign();
    // More than the whole burst, framed as a valid message for this channel.
    for (let i = 0; i < XMTP_INBOUND_BURST + 100; i++) push({ type: "state", channelId: id, signed: resign }, stranger, "dm-stranger");
    push({ type: "state", channelId: id, signed: resign }); // then the opponent's own
    await settle();
    await drained();
    expect(results).toEqual(["move"]);
    expect(relay.dropped(id)).toBe(XMTP_INBOUND_BURST + 100);
  });

  it("m-N10: an opponent message the rate limit turned away is not marked delivered: the next catch-up delivers it", async () => {
    const { a, id, signers, sdk, relay, results, drained } = await bOverXmtp({ registerLater: true });
    sdk.inboxStateFailures = 1_000_000; // a lookup outage: every sender is undetermined
    sdk.inboxLookupFailures = 1_000_000;
    // Undetermined junk spends the channel's whole burst (dropped after the bucket, before the session).
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    const conv = sdk.strangerDm(stranger);
    for (let i = 0; i < XMTP_INBOUND_BURST; i++) sdk.stream.push(sdk.msg(`x-${i}`, stranger, "junk", conv));
    const genuine = await a.move("e2e4");
    sdk.arrive("a-move", signers[0].address, toWire({ arena: 1, msg: { type: "state", channelId: id, signed: genuine } }));
    await settle();
    await drained();
    expect(results).toEqual([]);
    expect(relay.dropped(id)).toBe(XMTP_INBOUND_BURST + 1); // the move too: rate limited
    // The outage heals and the bucket refills; the stream restarts, and its catch-up re-reads the DM.
    sdk.inboxStateFailures = 0;
    sdk.inboxLookupFailures = 0;
    sdk.peerRegistered = true;
    await advance(10_000);
    sdk.stream.fail();
    await settle();
    await advance(1_000);
    await drained();
    expect(results).toEqual(["move"]);
    // Delivered now, so marked: the next restart does not deliver it again.
    sdk.stream.fail();
    await settle();
    await advance(2_000);
    await drained();
    expect(results).toEqual(["move"]);
    expect(sdk.messagesCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("an undetermined sender with the opponent's valid signatures is delivered, in order", async () => {
    const { a, b, id, sdk, relay, push, results, drained } = await bOverXmtp();
    sdk.inboxStateFailures = 1_000_000; // the sender cannot be read locally...
    sdk.inboxLookupFailures = 1_000_000; // ...nor A's inbox found on the network
    push({ type: "state", channelId: id, signed: await a.resign() });
    const ca = await a.signClose();
    push({ type: "close", channelId: id, close: ca });
    await settle();
    await drained();
    expect(results).toEqual(["move", "close"]);
    expect(b.snapshot().closeSigs[0]).toBe(ca.sig);
    expect(relay.dropped(id)).toBe(0);
  });

  it("an undetermined sender with invalid signatures is rejected by the session and counted; a replayed genuine state is a no-op", async () => {
    const { a, b, id, sdk, relay, push, results, drained } = await bOverXmtp();
    sdk.inboxStateFailures = 1_000_000;
    sdk.inboxLookupFailures = 1_000_000;
    const genuine = await a.move("e2e4");
    const eve = privateKeyToAccount(generatePrivateKey());
    const forged = { ...genuine, sigA: await eve.signMessage({ message: "not the opponent" }) };
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    push({ type: "state", channelId: id, signed: forged }, stranger, "dm-stranger"); // a stranger, undetermined
    push({ type: "state", channelId: id, signed: genuine });
    push({ type: "state", channelId: id, signed: genuine }, stranger, "dm-stranger"); // a stranger replays it
    await settle();
    await drained();
    expect(results).toEqual(["rejected (counted)", "move", "duplicate"]);
    expect(b.latest.state.turnNum).toBe(1n);
    expect(relay.dropped(id)).toBe(1);
    expect(logs.filter((l) => l.includes("rejected by the session"))).toHaveLength(1); // the throttled summary only
  });
});
