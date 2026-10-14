import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChannelSession,
  MemoryStore,
  decodeWire,
  parseRelayMessage,
  toWire,
  type ArenaDomain,
  type CloseSignature,
  type Params,
  type RelayMessage,
  type RelaySigner,
  type SignedState,
} from "@arena/sdk";
import { initHome, loadConfig, parseXmtpConfig, type ArenaConfig } from "../src/config.js";
import { connectHost, type HostRelay } from "../src/host.js";
import { startDaemonProcess } from "../src/run.js";
import { buildStatus } from "../src/status.js";
import { FallbackRelay, HOST_DOWN_GRACE_MS, XMTP_MAX_PAYLOAD_BYTES, XMTP_SEND_WAIT_MS } from "../src/xmtp/fallback.js";
import { XMTP_INBOUND_BURST, XMTP_INBOUND_PER_SEC } from "../src/xmtp/relay.js";
import type { XmtpTransport } from "../src/xmtp/transport.js";
import { RPC, deployArena } from "../../sdk/test/helpers/chain.js";
import { makeParams } from "../../sdk/test/helpers/fixtures.js";

// ------------------------------------------------------------------------------------------------- fakes

/** A host relay whose link the test drives: `setJoined` flips `isJoined` and fires `onLinkChange` (and `onJoined`
 *  on a join), exactly as `connectHost` does. */
class FakeHost implements HostRelay {
  readonly joined = new Set<Hex>();
  readonly sent: RelayMessage[] = [];
  readonly joins: Hex[] = [];
  readonly left: Hex[] = [];
  /** Throws on send even while `isJoined` (the socket dropping between the check and the send). */
  throwOnSend = false;
  private readonly msgHandlers = new Set<(m: RelayMessage) => void>();
  private readonly joinedHandlers = new Set<(id: Hex) => void>();
  private readonly linkHandlers = new Set<() => void>();

  async join(channelId: Hex): Promise<void> {
    this.joins.push(channelId);
  }
  async send(msg: RelayMessage): Promise<void> {
    if (this.throwOnSend || !this.joined.has(msg.channelId)) throw new Error("relay not connected");
    this.sent.push(msg);
  }
  onMessage(h: (m: RelayMessage) => void): () => void {
    this.msgHandlers.add(h);
    return () => this.msgHandlers.delete(h);
  }
  onJoined(h: (id: Hex) => void): () => void {
    this.joinedHandlers.add(h);
    return () => this.joinedHandlers.delete(h);
  }
  leave(channelId: Hex): void {
    this.left.push(channelId);
    if (this.joined.delete(channelId)) for (const h of this.linkHandlers) h();
  }
  isJoined(channelId: Hex): boolean {
    return this.joined.has(channelId);
  }
  onLinkChange(h: () => void): () => void {
    this.linkHandlers.add(h);
    return () => this.linkHandlers.delete(h);
  }
  setJoined(channelId: Hex, up: boolean): void {
    if (up) this.joined.add(channelId);
    else this.joined.delete(channelId);
    for (const h of this.linkHandlers) h();
    if (up) for (const h of this.joinedHandlers) h(channelId);
  }
  deliver(msg: RelayMessage): void {
    for (const h of this.msgHandlers) h(msg);
  }
}

class FakeXmtp implements XmtpTransport {
  readonly opened: Array<{ channelId: Hex; me: Address; peer: Address }> = [];
  readonly sent: Array<{ channelId: Hex; text: string }> = [];
  readonly closed: Hex[] = [];
  stopped = false;
  openImpl: () => Promise<void> = async () => undefined;
  sendImpl: () => Promise<void> = async () => undefined;
  private readonly handlers = new Set<(channelId: Hex, from: Address, dm: Address, text: string) => void>();

  async open(channelId: Hex, me: RelaySigner, peer: Address): Promise<void> {
    this.opened.push({ channelId, me: me.address, peer });
    return this.openImpl();
  }
  async send(channelId: Hex, text: string): Promise<void> {
    await this.sendImpl();
    this.sent.push({ channelId, text });
  }
  onText(h: (channelId: Hex, from: Address, dm: Address, text: string) => void): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
  async close(channelId: Hex): Promise<void> {
    this.closed.push(channelId);
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  deliver(channelId: Hex, from: Address, dm: Address, text: string): void {
    for (const h of this.handlers) h(channelId, from, dm, text);
  }
  /** The RelayMessages sent so far, decoded from their `{"arena":1,"msg":…}` frames. */
  messages(): RelayMessage[] {
    return this.sent.map((s) => {
      const outer = decodeWire(s.text) as { arena: number; msg: unknown };
      expect(outer.arena).toBe(1);
      return parseRelayMessage(outer.msg);
    });
  }
}

// ------------------------------------------------------------------------------------------------- fixtures

const domain: ArenaDomain = { chainId: 31337, hub: "0x000000000000000000000000000000000000beef" };

/** A real ChannelSession pair (A is seat 0, B seat 1) over fresh session keys. */
async function sessionPair() {
  const keys = [generatePrivateKey(), generatePrivateKey()] as const;
  const params: Params = makeParams({
    participants: ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000b2"],
    sessionKeys: keys,
    rules: "0x00000000000000000000000000000000000000e5" as Address,
    feeRecipient: "0x00000000000000000000000000000000000000f6" as Address,
    fundingDeadline: 2_000_000_000n,
    salt: `xmtp-${Math.random()}`,
  });
  const cfg = (me: 0 | 1) => ({ params, me, sessionKey: keys[me], domain, store: new MemoryStore() });
  const a = await ChannelSession.create(cfg(0));
  const b = await ChannelSession.create(cfg(1));
  const signers = [privateKeyToAccount(keys[0]), privateKeyToAccount(keys[1])] as const;
  return { a, b, params, id: a.id, signers };
}

/** Runs every queued microtask and promise continuation (fake timers fake only setTimeout/clearTimeout). */
const settle = () => new Promise<void>((r) => setImmediate(r));

const frame = (msg: RelayMessage) => toWire({ arena: 1, msg });
const stateMsg = (id: Hex, signed: SignedState): RelayMessage => ({ type: "state", channelId: id, signed });

let clock = 0;
let logs: string[] = [];
const relays: FallbackRelay[] = [];

/** B's side of a channel: a FallbackRelay over fakes, joined as B's session key. */
async function bSide(opts: { joined?: boolean } = {}) {
  const pair = await sessionPair();
  const host = new FakeHost();
  const xmtp = new FakeXmtp();
  if (opts.joined) host.joined.add(pair.id);
  const relay = new FallbackRelay({ host, xmtp, now: () => clock, log: (l) => logs.push(l) });
  relays.push(relay);
  await relay.join(pair.id, pair.params, pair.signers[1]);
  await settle();
  return { ...pair, host, xmtp, relay, opponent: pair.signers[0].address };
}

/** Steps the injected clock and the fake timers together. */
async function advance(ms: number): Promise<void> {
  clock += ms;
  vi.advanceTimersByTime(ms);
  await settle();
}

beforeEach(() => {
  clock = 1_000_000;
  logs = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  for (const r of relays.splice(0)) await r.stop();
  vi.useRealTimers();
});

// ------------------------------------------------------------------------------------------------- send rule

describe("FallbackRelay: the send rule (spec §2)", () => {
  it("sends via the host while it has the channel joined, never via XMTP", async () => {
    const { a, id, host, xmtp, relay } = await bSide({ joined: true });
    const m = stateMsg(id, await a.move("e2e4"));
    await relay.send(m);
    expect(host.sent).toEqual([m]);
    expect(xmtp.sent).toHaveLength(0);
    expect(relay.transportOf(id)).toBe("relay");
  });

  it("joins the host as before and opens XMTP to the opponent without waiting for it", async () => {
    const { id, params, signers, host } = await bSide();
    expect(host.joins).toEqual([id]);
    // An XMTP open that never settles must not hold up the host join.
    const host2 = new FakeHost();
    const xmtp2 = new FakeXmtp();
    xmtp2.openImpl = () => new Promise<void>(() => undefined);
    const relay2 = new FallbackRelay({ host: host2, xmtp: xmtp2, now: () => clock });
    relays.push(relay2);
    await relay2.join(id, params, signers[1]);
    expect(host2.joins).toEqual([id]);
    expect(xmtp2.opened).toEqual([{ channelId: id, me: signers[1].address, peer: signers[0].address }]);
  });

  it("a channel never joined: held for the grace window, then via XMTP; the host's later join switches back", async () => {
    const { a, b, id, host, xmtp, relay } = await bSide();
    expect(relay.transportOf(id)).toBe("none");
    const s1 = await a.move("e2e4");
    await b.receive(s1);
    const m = stateMsg(id, await b.move("e7e5"));
    let done = false;
    const sending = relay.send(m).then(() => (done = true));
    await advance(HOST_DOWN_GRACE_MS - 1);
    expect(done).toBe(false); // held: neither side has it yet
    expect(host.sent).toHaveLength(0);
    expect(xmtp.sent).toHaveLength(0);
    expect(relay.transportOf(id)).toBe("none");
    await advance(1);
    await sending;
    expect(xmtp.messages()).toEqual([m]);
    expect(xmtp.sent[0].channelId).toBe(id);
    expect(relay.transportOf(id)).toBe("xmtp");
    expect(logs.some((l) => l.includes("sending via XMTP"))).toBe(true);

    // Later sends go straight to XMTP while it stays down...
    const m2 = { type: "close", channelId: id, close: { stateHash: keccak256("0x01"), by: 1, sig: "0x" } } as RelayMessage;
    await relay.send(m2);
    await settle();
    expect(xmtp.messages()).toEqual([m, m2]);

    // ...and to the host again once it has the channel joined.
    host.setJoined(id, true);
    expect(relay.transportOf(id)).toBe("relay");
    await relay.send(m);
    expect(host.sent).toEqual([m]);
    expect(xmtp.sent).toHaveLength(2);
    expect(logs.some((l) => l.includes("back on the host relay"))).toBe(true);
  });

  it("the host drops a joined channel: held within the window and flushed via the host if it comes back first", async () => {
    const { a, id, host, xmtp, relay } = await bSide({ joined: true });
    host.setJoined(id, false); // socket closed, or open with the channel no longer joined (Review Focus 1)
    const m = stateMsg(id, await a.move("e2e4"));
    const sending = relay.send(m);
    await advance(HOST_DOWN_GRACE_MS / 2);
    expect(host.sent).toHaveLength(0);
    host.setJoined(id, true); // back within the window
    await sending;
    expect(host.sent).toEqual([m]);
    expect(xmtp.sent).toHaveLength(0);
    await advance(HOST_DOWN_GRACE_MS);
    expect(xmtp.sent).toHaveLength(0); // the window's timer found nothing left to do
  });

  it("the window starts when the host drops, not at join; held sends keep their order", async () => {
    const { a, b, id, host, xmtp, relay } = await bSide({ joined: true });
    await advance(60_000); // up for a minute
    host.setJoined(id, false);
    const s1 = await a.move("e2e4");
    await b.receive(s1);
    const m1 = stateMsg(id, await b.move("e7e5"));
    const m2: RelayMessage = { type: "close", channelId: id, close: { stateHash: keccak256("0x02"), by: 1, sig: "0x" } };
    const sends = [relay.send(m1), relay.send(m2)];
    await advance(HOST_DOWN_GRACE_MS - 1);
    expect(xmtp.sent).toHaveLength(0);
    expect(relay.transportOf(id)).toBe("none");
    await advance(1);
    await Promise.all(sends);
    expect(xmtp.messages()).toEqual([m1, m2]);
  });

  it("replays the last messages sent via the host over XMTP once the host has been down for the window", async () => {
    const { a, b, id, host, xmtp, relay } = await bSide({ joined: true });
    const s1 = await a.move("e2e4");
    await b.receive(s1);
    const mine = stateMsg(id, await b.move("e7e5"));
    await relay.send(mine); // the host accepted it -- and died before forwarding it
    expect(host.sent).toEqual([mine]);
    host.setJoined(id, false);
    await advance(HOST_DOWN_GRACE_MS);
    expect(xmtp.messages()).toEqual([mine]);
    // Replayed once per outage, not on every later wake.
    await advance(HOST_DOWN_GRACE_MS * 3);
    expect(xmtp.sent).toHaveLength(1);
  });

  it("a host send that throws while isJoined is not passed on: the message takes the held path", async () => {
    const { a, id, host, xmtp, relay } = await bSide({ joined: true });
    host.throwOnSend = true;
    const m = stateMsg(id, await a.move("e2e4"));
    let settled = false;
    const sending = relay.send(m).then(() => (settled = true));
    await settle();
    expect(settled).toBe(false);
    host.throwOnSend = false;
    host.setJoined(id, false);
    await advance(HOST_DOWN_GRACE_MS);
    await expect(sending).resolves.toBe(true);
    expect(xmtp.messages()).toEqual([m]);
  });

  it("an XMTP send failure never rejects to the daemon; it is logged", async () => {
    const { a, id, xmtp, relay } = await bSide();
    await advance(HOST_DOWN_GRACE_MS);
    xmtp.sendImpl = async () => {
      throw new Error("xmtp unreachable");
    };
    await expect(relay.send(stateMsg(id, await a.move("e2e4")))).resolves.toBeUndefined();
    await settle();
    expect(logs.some((l) => l.includes("send failed: xmtp unreachable"))).toBe(true);
  });

  it("a hung XMTP send holds the channel's later messages for at most XMTP_SEND_WAIT_MS", async () => {
    const { a, id, host, xmtp, relay } = await bSide();
    await advance(HOST_DOWN_GRACE_MS);
    let release: () => void = () => undefined;
    xmtp.sendImpl = () => new Promise<void>((r) => (release = r));
    await relay.send(stateMsg(id, await a.move("e2e4"))); // handed over at once, though XMTP never answers
    const m2: RelayMessage = { type: "close", channelId: id, close: { stateHash: keccak256("0x03"), by: 1, sig: "0x" } };
    let second = false;
    const sending = relay.send(m2).then(() => (second = true));
    await advance(XMTP_SEND_WAIT_MS - 1);
    expect(second).toBe(false);
    host.setJoined(id, true); // the host is back meanwhile: the queue still waits out the hung send first
    await advance(1);
    await sending;
    expect(host.sent).toEqual([m2]);
    expect(logs.some((l) => l.includes(`send still pending after ${XMTP_SEND_WAIT_MS} ms`))).toBe(true);
    release();
  });

  it("a failed XMTP open is retried in the background with back-off, and at once by a send", async () => {
    const pair = await sessionPair();
    const host = new FakeHost();
    const xmtp = new FakeXmtp();
    let fail = true;
    xmtp.openImpl = async () => {
      if (fail) throw new Error("network down");
    };
    const relay = new FallbackRelay({ host, xmtp, graceMs: 500, now: () => clock, log: (l) => logs.push(l) });
    relays.push(relay);
    await relay.join(pair.id, pair.params, pair.signers[1]);
    await settle();
    expect(xmtp.opened).toHaveLength(1);
    expect(logs.some((l) => l.includes("client failed to start (network down); retrying in 1s"))).toBe(true);
    await advance(999);
    expect(xmtp.opened).toHaveLength(1);
    await advance(1); // the first back-off
    expect(xmtp.opened).toHaveLength(2);
    expect(logs.some((l) => l.includes("retrying in 2s"))).toBe(true);
    fail = false;
    await relay.send(stateMsg(pair.id, await pair.a.move("e2e4"))); // down past the window: via XMTP, opening it first
    await settle();
    expect(xmtp.opened).toHaveLength(3);
    expect(xmtp.sent).toHaveLength(1);
    await advance(10_000);
    expect(xmtp.opened).toHaveLength(3); // open now: no more retries
  });

  it("leave leaves the host relay, closes XMTP, and forgets the channel", async () => {
    const { id, host, xmtp, relay } = await bSide({ joined: true });
    relay.leave(id);
    await settle();
    expect(host.left).toEqual([id]);
    expect(xmtp.closed).toEqual([id]);
    expect(relay.transportOf(id)).toBe("none");
    expect(relay.dropped(id)).toBe(0);
  });

  it("transportOf is none for a channel never joined through it, and a send for one is the host's own", async () => {
    const host = new FakeHost();
    const relay = new FallbackRelay({ host, xmtp: new FakeXmtp(), now: () => clock });
    relays.push(relay);
    const id = keccak256(toHex("unknown"));
    expect(relay.transportOf(id)).toBe("none");
    await expect(relay.send({ type: "close", channelId: id, close: { stateHash: id, by: 0, sig: "0x" } })).rejects.toThrow(
      "relay not connected",
    );
  });
});

// ------------------------------------------------------------------------------------------------- receive and dedupe

describe("FallbackRelay: the same message by both transports is processed once (Review Focus 2)", () => {
  /** B's session fed by B's relay, recording each receive's result in delivery order. */
  function feed(b: ChannelSession, relay: FallbackRelay) {
    const results: string[] = [];
    let chain = Promise.resolve();
    relay.onMessage((m) => {
      chain = chain.then(async () => {
        if (m.type === "state") results.push(await b.receive(m.signed));
        else {
          await b.receiveClose(m.close);
          results.push("close");
        }
      });
    });
    return { results, drained: () => chain };
  }

  it("relay then XMTP", async () => {
    const { a, b, id, host, xmtp, relay, opponent } = await bSide({ joined: true });
    const { results, drained } = feed(b, relay);
    const m = stateMsg(id, await a.move("e2e4"));
    host.deliver(m);
    xmtp.deliver(id, opponent, opponent, frame(m));
    await drained();
    expect(results).toEqual(["move", "duplicate"]);
    expect(b.latest.state.turnNum).toBe(1n);
  });

  it("XMTP then relay", async () => {
    const { a, b, id, host, xmtp, relay, opponent } = await bSide({ joined: true });
    const { results, drained } = feed(b, relay);
    const m = stateMsg(id, await a.move("e2e4"));
    xmtp.deliver(id, opponent, opponent, frame(m));
    host.deliver(m);
    await drained();
    expect(results).toEqual(["move", "duplicate"]);
    expect(b.latest.state.turnNum).toBe(1n);
  });

  it("interleaved with a newer state: the late copies are stale or duplicate, never a second move", async () => {
    const { a, b, id, host, xmtp, relay, opponent } = await bSide({ joined: true });
    const { results, drained } = feed(b, relay);
    const s1 = await a.move("e2e4");
    xmtp.deliver(id, opponent, opponent, frame(stateMsg(id, s1)));
    await drained();
    await a.receive(await b.move("e7e5"));
    const s3 = await a.move("g1f3");
    host.deliver(stateMsg(id, s3)); // the newer state first by the relay...
    host.deliver(stateMsg(id, s1)); // ...then the old one, late, by the relay
    xmtp.deliver(id, opponent, opponent, frame(stateMsg(id, s3))); // ...and the newer one again by XMTP
    await drained();
    expect(results).toEqual(["move", "move", "stale", "duplicate"]);
    expect(b.latest.state.turnNum).toBe(3n);
  });

  it("a Close signature by both transports is recorded once", async () => {
    const { a, b, id, host, xmtp, relay, opponent } = await bSide({ joined: true });
    const { results, drained } = feed(b, relay);
    // A resigns at once: a finished game, so Close can be signed.
    const resign = await a.resign();
    host.deliver(stateMsg(id, resign));
    xmtp.deliver(id, opponent, opponent, frame(stateMsg(id, resign)));
    const ca: CloseSignature = await a.signClose();
    const closeMsg: RelayMessage = { type: "close", channelId: id, close: ca };
    xmtp.deliver(id, opponent, opponent, frame(closeMsg));
    host.deliver(closeMsg);
    await drained();
    expect(results).toEqual(["move", "duplicate", "close", "close"]);
    expect(b.snapshot().closeSigs[0]).toBe(ca.sig);
    await a.receiveClose(await b.signClose());
    expect(a.closeTransaction()).not.toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------- acceptance

describe("FallbackRelay: XMTP acceptance (spec §3)", () => {
  it("drops and counts everything that is not a valid arena message from the opponent, in the opponent's DM", async () => {
    const { a, id, xmtp, relay, opponent, signers } = await bSide({ joined: true });
    const got: RelayMessage[] = [];
    relay.onMessage((m) => got.push(m));
    const m = stateMsg(id, await a.move("e2e4"));
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    const other = keccak256(toHex("another channel"));
    const cases: Array<[string, Address, Address, string]> = [
      ["a third party", stranger, stranger, frame(m)],
      ["a third party claiming the opponent's DM", stranger, opponent, frame(m)],
      ["the opponent, outside the DM", opponent, stranger, frame(m)],
      ["our own key as sender", signers[1].address, opponent, frame(m)],
      ["oversized", opponent, opponent, toWire({ arena: 1, msg: m, pad: "x".repeat(XMTP_MAX_PAYLOAD_BYTES) })],
      ["arena 2", opponent, opponent, toWire({ arena: 2, msg: m })],
      ["no arena field", opponent, opponent, toWire({ msg: m })],
      ["the bare message, unframed", opponent, opponent, toWire(m)],
      ["not JSON", opponent, opponent, "e2e4 please"],
      ["a JSON array", opponent, opponent, "[1,2]"],
      ["an invalid relay message", opponent, opponent, toWire({ arena: 1, msg: { type: "state", channelId: id } })],
      ["a message for another channel", opponent, opponent, frame({ ...m, channelId: other })],
    ];
    for (const [, from, dm, text] of cases) xmtp.deliver(id, from, dm, text);
    expect(got).toEqual([]);
    expect(relay.dropped(id)).toBe(cases.length);
    expect(logs.filter((l) => l.includes("dropped an inbound message"))).toHaveLength(1); // the first only

    // The same message, framed right, from the opponent in its DM, is accepted (address case does not matter).
    xmtp.deliver(id, opponent.toLowerCase() as Address, opponent.toUpperCase().replace("0X", "0x") as Address, frame(m));
    expect(got).toEqual([m]);
    expect(relay.dropped(id)).toBe(cases.length);
  });

  it("a message at exactly the size limit passes the size check", async () => {
    const { a, id, xmtp, relay, opponent } = await bSide({ joined: true });
    const got: RelayMessage[] = [];
    relay.onMessage((m) => got.push(m));
    const m = stateMsg(id, await a.move("e2e4"));
    const base = toWire({ arena: 1, msg: m, pad: "" });
    const text = toWire({ arena: 1, msg: m, pad: "x".repeat(XMTP_MAX_PAYLOAD_BYTES - Buffer.byteLength(base)) });
    expect(Buffer.byteLength(text)).toBe(XMTP_MAX_PAYLOAD_BYTES);
    xmtp.deliver(id, opponent, opponent, text);
    expect(got).toHaveLength(1);
  });

  it("ignores texts for a channel it never joined, without counting them anywhere", async () => {
    const { a, id, xmtp, relay, opponent } = await bSide({ joined: true });
    const got: RelayMessage[] = [];
    relay.onMessage((m) => got.push(m));
    const other = keccak256(toHex("never joined"));
    xmtp.deliver(other, opponent, opponent, frame(stateMsg(id, await a.move("e2e4"))));
    expect(got).toEqual([]);
    expect(relay.dropped(other)).toBe(0);
    expect(relay.dropped(id)).toBe(0);
  });

  it("rate-limits inbound per channel with the host relay's budget; strangers never spend it", async () => {
    const { a, id, xmtp, relay, opponent } = await bSide({ joined: true });
    let got = 0;
    relay.onMessage(() => got++);
    const text = frame(stateMsg(id, await a.move("e2e4")));
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    for (let i = 0; i < 100; i++) xmtp.deliver(id, stranger, stranger, text); // dropped before the bucket
    for (let i = 0; i < XMTP_INBOUND_BURST + 1; i++) xmtp.deliver(id, opponent, opponent, text);
    expect(got).toBe(XMTP_INBOUND_BURST);
    expect(relay.dropped(id)).toBe(101);
    expect(logs.some((l) => l.includes("(rate limited)") || l.includes("dropped an inbound message"))).toBe(true);
    // One token back per 1/400 s.
    clock += Math.ceil(1000 / XMTP_INBOUND_PER_SEC);
    xmtp.deliver(id, opponent, opponent, text);
    expect(got).toBe(XMTP_INBOUND_BURST + 1);
    xmtp.deliver(id, opponent, opponent, text);
    expect(got).toBe(XMTP_INBOUND_BURST + 1);
    expect(relay.dropped(id)).toBe(102);
  });
});

// ------------------------------------------------------------------------------------------------- the host's up-signal

/** A stand-in for the global WebSocket that `connectHost` drives, so the host's up-signal is tested with no server. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(e: unknown) => void>>();
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }
  frame(f: unknown): void {
    this.emit("message", { data: toWire(f) });
  }
  private emit(type: string, e: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}

describe("connectHost: isJoined and onLinkChange", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWebSocket.instances = [];
  });

  it("is joined exactly while the socket is open and the server has confirmed the join, and signals every change", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { id, params, signers } = await sessionPair();
    const conn = connectHost("http://host.invalid", { minBackoffMs: 60_000 });
    try {
      let changes = 0;
      conn.relay.onLinkChange(() => changes++);
      const ws = FakeWebSocket.instances[0];
      ws.open();
      ws.frame({ type: "hello", nonce: keccak256("0x01") });
      expect(changes).toBe(1);
      const joining = conn.relay.join(id, params, signers[1]);
      await settle();
      expect(conn.relay.isJoined(id)).toBe(false); // socket open, join not yet confirmed: half-up
      ws.frame({ type: "joined", channelId: id });
      await joining;
      expect(conn.relay.isJoined(id)).toBe(true);
      expect(changes).toBe(2);
      ws.close(); // the server goes away
      expect(conn.relay.isJoined(id)).toBe(false);
      expect(changes).toBe(3);
      await expect(conn.relay.send({ type: "close", channelId: id, close: { stateHash: id, by: 1, sig: "0x" } })).rejects.toThrow(
        "relay not connected",
      );
    } finally {
      conn.close();
    }
  });

  it("a new hello and a leave both signal a change", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { id, params, signers } = await sessionPair();
    const conn = connectHost("http://host.invalid", { minBackoffMs: 60_000 });
    try {
      let changes = 0;
      conn.relay.onLinkChange(() => changes++);
      const ws = FakeWebSocket.instances[0];
      ws.open();
      ws.frame({ type: "hello", nonce: keccak256("0x01") });
      const joining = conn.relay.join(id, params, signers[1]);
      await settle();
      ws.frame({ type: "joined", channelId: id });
      await joining;
      ws.frame({ type: "hello", nonce: keccak256("0x02") }); // a fresh session on the same socket: joins are gone
      expect(conn.relay.isJoined(id)).toBe(false);
      expect(changes).toBe(3);
      ws.frame({ type: "joined", channelId: id });
      expect(conn.relay.isJoined(id)).toBe(true);
      conn.relay.leave(id);
      expect(conn.relay.isJoined(id)).toBe(false);
      expect(changes).toBe(5);
    } finally {
      conn.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------- status and config

describe("status and config", () => {
  it("ChannelStatus.transport defaults to none and carries the given side", async () => {
    const { a, params, id } = await sessionPair();
    const record = {
      channelId: id,
      me: 0 as const,
      params,
      sessionKey: generatePrivateKey(),
      controller: "agent" as const,
      note: "",
    } as unknown as Parameters<typeof buildStatus>[0]["record"];
    const input = { record, snapshot: a.snapshot(), myTurn: true, chain: null, lastError: null };
    expect(buildStatus(input).transport).toBe("none");
    expect(buildStatus({ ...input, transport: "xmtp" }).transport).toBe("xmtp");
  });

  it("parseXmtpConfig accepts the three envs with optional apiUrl/gatewayHost and refuses anything else", () => {
    expect(parseXmtpConfig({ env: "dev" })).toEqual({ env: "dev" });
    expect(parseXmtpConfig({ env: "local", apiUrl: "http://127.0.0.1:5556", extra: 1 })).toEqual({
      env: "local",
      apiUrl: "http://127.0.0.1:5556",
    });
    expect(parseXmtpConfig({ env: "production", gatewayHost: "https://gw.example" })).toEqual({
      env: "production",
      gatewayHost: "https://gw.example",
    });
    expect(() => parseXmtpConfig({ env: "mainnet" })).toThrow("xmtp.env");
    expect(() => parseXmtpConfig({})).toThrow("xmtp.env");
    expect(() => parseXmtpConfig("dev")).toThrow("must be an object");
    expect(() => parseXmtpConfig(null)).toThrow("must be an object");
    expect(() => parseXmtpConfig({ env: "dev", apiUrl: "grpc.dev.xmtp.network" })).toThrow("xmtp.apiUrl");
    expect(() => parseXmtpConfig({ env: "dev", apiUrl: 5 })).toThrow("xmtp.apiUrl");
    expect(() => parseXmtpConfig({ env: "dev", gatewayHost: "" })).toThrow("xmtp.gatewayHost");
    expect(() => parseXmtpConfig({ env: "dev", apiUrl: "http://user:pw@127.0.0.1:5556" })).toThrow("must not contain credentials");
    expect(() => parseXmtpConfig({ env: "local", gatewayHost: "https://gw.example" })).toThrow('not allowed with env: "local"');
    expect(parseXmtpConfig({ env: "dev", gatewayHost: "https://gw.example" })).toEqual({ env: "dev", gatewayHost: "https://gw.example" });
  });

  it("loadConfig validates xmtp when present and leaves a config without it as it was", () => {
    const home = mkdtempSync(join(tmpdir(), "arena-xmtp-cfg-"));
    try {
      const base = {
        rpcUrl: RPC,
        chainId: 31337,
        hub: domain.hub,
        usdc: domain.hub,
        rules: domain.hub,
        serverUrl: "http://127.0.0.1:9",
        port: 0,
        maxFeePerPlayer: 1n,
        sessionGasWei: 1n,
        pollMs: 100,
      } as ArenaConfig;
      initHome(home, base);
      expect("xmtp" in loadConfig(home)).toBe(false);
      initHome(home, { ...base, xmtp: { env: "local", apiUrl: "http://127.0.0.1:5556" } });
      expect(loadConfig(home).xmtp).toEqual({ env: "local", apiUrl: "http://127.0.0.1:5556" });
      initHome(home, { ...base, xmtp: { env: "nope" } as unknown as ArenaConfig["xmtp"] });
      expect(() => loadConfig(home)).toThrow("xmtp.env");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------------------------------------- run.ts wiring

describe("startDaemonProcess: choosing the relay", () => {
  // Real timers here: the daemon and its RPC client run for real against Anvil.
  beforeEach(() => vi.useRealTimers());

  const NOWHERE = "http://127.0.0.1:9";
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });

  async function home(xmtp?: ArenaConfig["xmtp"]): Promise<string> {
    const env = await deployArena();
    const dir = mkdtempSync(join(tmpdir(), "arena-xmtp-run-"));
    homes.push(dir);
    const config: ArenaConfig = {
      rpcUrl: RPC,
      chainId: env.domain.chainId,
      hub: env.hub,
      usdc: env.usdc,
      rules: env.rules,
      serverUrl: NOWHERE,
      port: 0,
      maxFeePerPlayer: 10_000n,
      sessionGasWei: 10n ** 16n,
      pollMs: 100,
      minChallengeTimeout: 60n,
      ...(xmtp ? { xmtp } : {}),
    };
    initHome(dir, config, generatePrivateKey());
    return dir;
  }

  it("without config.xmtp: the plain host relay, fallback off, the SDK never looked for, nothing logged about XMTP", async () => {
    const dir = await home();
    const out: string[] = [];
    const load = vi.fn();
    const proc = await startDaemonProcess(dir, { log: (l) => out.push(l), xmtp: { load } });
    try {
      expect(proc.relay).toBe(proc.host.relay);
      expect(proc.fallback).toBe("off");
      expect(proc.daemon.fallback).toBe("off");
      expect(load).not.toHaveBeenCalled();
      expect(out.filter((l) => l.startsWith("xmtp:"))).toEqual([]);
    } finally {
      await proc.stop();
    }
  });

  it("with config.xmtp but no SDK installed: the plain host relay, fallback off, logged once", async () => {
    const dir = await home({ env: "local", apiUrl: "http://127.0.0.1:5556" });
    const out: string[] = [];
    const proc = await startDaemonProcess(dir, { log: (l) => out.push(l) });
    try {
      expect(proc.relay).toBe(proc.host.relay);
      expect(proc.fallback).toBe("off");
      const lines = out.filter((l) => l.startsWith("xmtp:"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("xmtp: fallback off: the XMTP SDK is not installed");
    } finally {
      await proc.stop();
    }
  });

  it("with config.xmtp and the SDK loaded: a FallbackRelay over the host relay, stopped with the process", async () => {
    const dir = await home({ env: "dev" });
    const out: string[] = [];
    const fake = new FakeXmtp();
    const seen: Array<{ dbDir: string; env: string }> = [];
    const proc = await startDaemonProcess(dir, {
      log: (l) => out.push(l),
      xmtp: {
        load: async () => ({ ok: true, sdk: {}, version: "6.0.0" }),
        transport: (o) => {
          seen.push({ dbDir: o.dbDir, env: o.config.env });
          return fake;
        },
      },
    });
    try {
      expect(proc.relay).toBeInstanceOf(FallbackRelay);
      expect(proc.fallback).toBe("xmtp");
      expect(proc.daemon.fallback).toBe("xmtp");
      expect(seen).toEqual([{ dbDir: join(dir, "xmtp", "db"), env: "dev" }]);
      expect(out.filter((l) => l.startsWith("xmtp:"))).toEqual(["xmtp: fallback on (env dev, node-sdk 6.0.0)"]);
    } finally {
      await proc.stop();
    }
    expect(fake.stopped).toBe(true);
  });

  it("a hung XMTP stop delays shutdown by at most a few seconds, and the home lock is still released", async () => {
    const dir = await home({ env: "dev" });
    const out: string[] = [];
    const hung = new FakeXmtp();
    hung.stop = () => new Promise<void>(() => undefined);
    const wiring = { load: async () => ({ ok: true as const, sdk: {}, version: "6.0.0" }), transport: () => hung };
    const proc = await startDaemonProcess(dir, { log: (l) => out.push(l), xmtp: wiring });
    const t0 = Date.now();
    await proc.stop();
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(out.some((l) => l.includes("xmtp: stop still pending"))).toBe(true);
    const again = await startDaemonProcess(dir, { log: () => undefined }); // the lock was released
    await again.stop();
  });
});
