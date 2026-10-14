import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelSession, toWire, type CloseSignature, type RelayClient, type RelayMessage, type SignedState } from "@arena/sdk";
import { initHome, loadConfig, parseXmtpConfig, readConfig, type ArenaConfig } from "../src/config.js";
import { ArenaDaemon, type DaemonOptions } from "../src/daemon.js";
import { connectHost, type HostRelay } from "../src/host.js";
import { startDaemonProcess } from "../src/run.js";
import { buildStatus } from "../src/status.js";
import { FallbackRelay, HOST_DOWN_GRACE_MS, XMTP_MAX_PAYLOAD_BYTES, XMTP_SEND_WAIT_MS } from "../src/xmtp/fallback.js";
import { XMTP_DROP_LOG_INTERVAL_MS, XMTP_INBOUND_BURST, XMTP_INBOUND_PER_SEC } from "../src/xmtp/relay.js";
import { NOT_THE_PEER, UNDETERMINED, XMTP_CATCH_UP_MESSAGES } from "../src/xmtp/transport.js";
import { ANVIL_KEYS, RPC, deployArena, mintUsdc, now } from "../../sdk/test/helpers/chain.js";
import { waitFor } from "./helpers/harness.js";
import { MemoryArena } from "./helpers/memoryArena.js";
import { FakeHost, FakeXmtp, domain, sessionPair, settle } from "./helpers/xmtpFakes.js";

// ------------------------------------------------------------------------------------------------- fixtures

const frame = (msg: RelayMessage) => toWire({ arena: 1, msg });
const stateMsg = (id: Hex, signed: SignedState): RelayMessage => ({ type: "state", channelId: id, signed });

let clock = 0;
let logs: string[] = [];
const relays: FallbackRelay[] = [];

/** B's side of a channel: a FallbackRelay over fakes, joined as B's session key, and armed (the channel is Open on
 *  chain: spec §3) unless `armed: false`. */
async function bSide(opts: { joined?: boolean; armed?: boolean } = {}) {
  const pair = await sessionPair();
  const host = new FakeHost();
  const xmtp = new FakeXmtp();
  if (opts.joined) host.joined.add(pair.id);
  const relay = new FallbackRelay({ host, xmtp, now: () => clock, log: (l) => logs.push(l) });
  relays.push(relay);
  await relay.join(pair.id, pair.params, pair.signers[1]);
  if (opts.armed !== false) relay.arm(pair.id);
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

  it("joins the host as before, and opens XMTP to the opponent only once armed, without waiting for it", async () => {
    const { id, params, signers, host } = await bSide();
    expect(host.joins).toEqual([id]);
    // An XMTP open that never settles must not hold up the host join, or anything else.
    const host2 = new FakeHost();
    const xmtp2 = new FakeXmtp();
    xmtp2.openImpl = () => new Promise<void>(() => undefined);
    const relay2 = new FallbackRelay({ host: host2, xmtp: xmtp2, now: () => clock });
    relays.push(relay2);
    await relay2.join(id, params, signers[1]);
    expect(host2.joins).toEqual([id]);
    expect(xmtp2.opened).toEqual([]); // joined at match time: no XMTP client yet (I-1)
    relay2.arm(id); // the daemon saw the channel Open on chain
    relay2.arm(id); // idempotent
    expect(xmtp2.opened).toEqual([{ channelId: id, me: signers[1].address, peer: signers[0].address }]);
  });

  it("I-1: a channel not armed (not Open on chain yet) is the host relay's alone: no XMTP client, host sends, no xmtp transport", async () => {
    const { a, id, host, xmtp, relay } = await bSide({ armed: false });
    expect(xmtp.opened).toEqual([]);
    expect(relay.armed(id)).toBe(false);
    const m = stateMsg(id, await a.move("e2e4"));
    // The host does not have it joined: the send fails exactly as on the host relay alone, never held for XMTP.
    await expect(relay.send(m)).rejects.toThrow("relay not connected");
    await advance(HOST_DOWN_GRACE_MS * 10);
    expect(relay.transportOf(id)).toBe("none");
    expect(xmtp.sent).toEqual([]);
    expect(xmtp.opened).toEqual([]);
    host.setJoined(id, true);
    await relay.send(m);
    expect(host.sent).toEqual([m]);
    expect(relay.transportOf(id)).toBe("relay");
    // Armed later with the host down: what it last sent via the host is replayed over XMTP once past the window.
    host.setJoined(id, false);
    relay.arm(id);
    expect(xmtp.opened).toHaveLength(1);
    await advance(HOST_DOWN_GRACE_MS);
    expect(xmtp.messages()).toEqual([m]);
    expect(relay.transportOf(id)).toBe("xmtp");
  });

  it("I-1: at most maxClients channels are armed at once; one past it runs without the fallback, logged once, until a slot frees", async () => {
    const host = new FakeHost();
    const xmtp = new FakeXmtp();
    const relay = new FallbackRelay({ host, xmtp, now: () => clock, log: (l) => logs.push(l), maxClients: 2 });
    relays.push(relay);
    const pairs = [await sessionPair(), await sessionPair(), await sessionPair(), await sessionPair()];
    for (const p of pairs) await relay.join(p.id, p.params, p.signers[1]);
    for (const p of pairs.slice(0, 3)) relay.arm(p.id);
    relay.arm(pairs[2].id); // asked again on the next chain refresh: still refused, not logged again
    expect(xmtp.opened.map((o) => o.channelId)).toEqual([pairs[0].id, pairs[1].id]);
    expect(logs.filter((l) => l.includes("XMTP clients already open"))).toHaveLength(1);
    expect(logs.find((l) => l.includes("XMTP clients already open"))).toContain(pairs[2].id.toLowerCase());
    // The refused channel behaves as without XMTP: never "xmtp", sends to the host.
    await advance(HOST_DOWN_GRACE_MS * 2);
    expect(relay.transportOf(pairs[2].id)).toBe("none");
    expect(relay.transportOf(pairs[0].id)).toBe("xmtp");
    // A finalized channel frees its slot once its client has closed (and its DB is purged); the refused one stays
    // without the fallback for good, and the next channel gets the slot.
    relay.leave(pairs[0].id);
    await settle();
    expect(xmtp.purged).toEqual([pairs[0].id.toLowerCase()]);
    relay.arm(pairs[2].id);
    relay.arm(pairs[3].id);
    expect(xmtp.opened.map((o) => o.channelId)).toEqual([pairs[0].id, pairs[1].id, pairs[3].id]);
    expect(relay.transportOf(pairs[2].id)).toBe("none");
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

  it("a host send that throws while isJoined stays true: held with a timer, then via XMTP, until a link change (m1)", async () => {
    const { a, b, id, host, xmtp, relay } = await bSide({ joined: true });
    host.throwOnSend = true; // isJoined keeps saying yes, and no onLinkChange ever fires
    const m = stateMsg(id, await a.move("e2e4"));
    let settled = false;
    const sending = relay.send(m).then(() => (settled = true));
    await settle();
    expect(settled).toBe(false);
    expect(relay.transportOf(id)).toBe("none");
    await advance(HOST_DOWN_GRACE_MS); // the window's own timer, no link change needed
    await expect(sending).resolves.toBe(true);
    expect(xmtp.messages()).toEqual([m]);
    expect(relay.transportOf(id)).toBe("xmtp");
    // The host's next link change gives it another try.
    host.throwOnSend = false;
    host.setJoined(id, true);
    expect(relay.transportOf(id)).toBe("relay");
    await b.receive(m.type === "state" ? m.signed : (undefined as never));
    const m2 = stateMsg(id, await b.move("e7e5"));
    await relay.send(m2);
    expect(host.sent).toEqual([m2]);
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

  it("a hung XMTP send holds the channel's later messages for at most XMTP_SEND_WAIT_MS while the host stays down", async () => {
    const { a, id, xmtp, relay } = await bSide();
    await advance(HOST_DOWN_GRACE_MS);
    let release: () => void = () => undefined;
    xmtp.sendImpl = () => new Promise<void>((r) => (release = r));
    await relay.send(stateMsg(id, await a.move("e2e4"))); // handed over at once, though XMTP never answers
    const m2: RelayMessage = { type: "close", channelId: id, close: { stateHash: keccak256("0x03"), by: 1, sig: "0x" } };
    let second = false;
    const sending = relay.send(m2).then(() => (second = true));
    await advance(XMTP_SEND_WAIT_MS - 1);
    expect(second).toBe(false);
    await advance(1);
    await sending;
    expect(logs.some((l) => l.includes(`send still pending after ${XMTP_SEND_WAIT_MS} ms`))).toBe(true);
    release();
  });

  it("the host back during a hung replay: the replay stops and the next send reaches the host within a tick (I2)", async () => {
    const { a, b, id, host, xmtp, relay } = await bSide({ joined: true });
    // Three of B's moves go via the host; then it dies, and XMTP hangs on every send.
    await b.receive(await a.move("e2e4"));
    const aMoves = ["g1f3", "b1c3", "a2a3"];
    for (const [i, mv] of ["e7e5", "d7d6", "c7c6"].entries()) {
      const signed = await b.move(mv);
      await relay.send(stateMsg(id, signed));
      await a.receive(signed);
      await b.receive(await a.move(aMoves[i]));
    }
    expect(host.sent).toHaveLength(3);
    const releases: Array<() => void> = [];
    xmtp.sendImpl = () => new Promise<void>((r) => releases.push(r));
    host.setJoined(id, false);
    await advance(HOST_DOWN_GRACE_MS); // the replay starts: its first XMTP send hangs
    expect(releases).toHaveLength(1);
    await advance(1_000);
    host.setJoined(id, true); // back, 1 s into a 30 s wait
    const next = stateMsg(id, await b.move("b7b6"));
    await relay.send(next);
    await settle();
    expect(host.sent.at(-1)).toEqual(next); // at once, not after the hung replay
    expect(releases).toHaveLength(1); // the rest of the replay was dropped: onJoined's re-send covers it
    expect(relay.transportOf(id)).toBe("relay");
    for (const r of releases) r();
  });

  it("an in-flight outbox XMTP send stops being waited for as soon as the host rejoins", async () => {
    const { a, id, host, xmtp, relay } = await bSide();
    await advance(HOST_DOWN_GRACE_MS);
    let release: () => void = () => undefined;
    xmtp.sendImpl = () => new Promise<void>((r) => (release = r));
    await relay.send(stateMsg(id, await a.move("e2e4")));
    const m2: RelayMessage = { type: "close", channelId: id, close: { stateHash: keccak256("0x04"), by: 1, sig: "0x" } };
    const sending = relay.send(m2);
    await advance(50);
    host.setJoined(id, true);
    await settle();
    await sending;
    expect(host.sent).toEqual([m2]);
    release();
  });

  it("the grace window runs on a monotonic clock by default: a wall-clock step back does not stretch it (m2)", async () => {
    vi.useRealTimers();
    const { id, params, signers, a } = await sessionPair();
    const host = new FakeHost();
    const xmtp = new FakeXmtp();
    const relay = new FallbackRelay({ host, xmtp, graceMs: 50 }); // no `now`: the default clock
    relays.push(relay);
    await relay.join(id, params, signers[1]);
    relay.arm(id);
    const realNow = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(realNow - 3_600_000); // NTP stepped the clock back an hour
    try {
      await relay.send(stateMsg(id, await a.move("e2e4"))); // held for the 50 ms window...
      await new Promise((r) => setTimeout(r, 150));
      expect(xmtp.sent).toHaveLength(1); // ...not for an hour and 50 ms
    } finally {
      spy.mockRestore();
    }
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
    relay.arm(pair.id);
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

  it("leave leaves the host relay, closes XMTP and purges its DB (finalized), and forgets the channel", async () => {
    const { id, host, xmtp, relay } = await bSide({ joined: true });
    relay.leave(id);
    await settle();
    expect(host.left).toEqual([id]);
    expect(xmtp.closed).toEqual([id.toLowerCase()]);
    expect(xmtp.purged).toEqual([id.toLowerCase()]);
    expect(relay.transportOf(id)).toBe("none");
    expect(relay.dropped(id)).toBe(0);
  });

  it("m-1: leave of a channel never armed in this process still purges its XMTP DB (one from an earlier run)", async () => {
    const { id, xmtp, relay } = await bSide({ joined: true, armed: false });
    relay.leave(id);
    await settle();
    expect(xmtp.opened).toEqual([]);
    expect(xmtp.purged).toEqual([id.toLowerCase()]);
  });

  it("stop closes every client without purging (a restarted daemon resumes the same installations)", async () => {
    const { xmtp, relay } = await bSide({ joined: true });
    await relay.stop();
    expect(xmtp.stopped).toBe(true);
    expect(xmtp.purged).toEqual([]);
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

  it("an undetermined sender or conversation is accepted and tagged: only a session rejection of it is counted", async () => {
    const { a, id, xmtp, host, relay, opponent } = await bSide({ joined: true });
    const got: RelayMessage[] = [];
    relay.onMessage((m) => got.push(m));
    const m = stateMsg(id, await a.move("e2e4"));
    xmtp.deliver(id, UNDETERMINED, UNDETERMINED, frame(m)); // neither sender nor conversation known
    xmtp.deliver(id, opponent, UNDETERMINED, frame(m)); // the opponent, in a conversation not resolved
    xmtp.deliver(id, opponent, opponent, frame(m)); // the opponent, in its DM
    host.deliver(m); // the host relay's
    expect(got).toHaveLength(4);
    expect(got.map((g) => relay.countRejected(g))).toEqual([true, true, false, false]);
    expect(relay.countRejected(got[0])).toBe(false); // counted once
    expect(relay.dropped(id)).toBe(2);
    // A known stranger stays one, whatever the other field says; and an undetermined text passes every other check.
    xmtp.deliver(id, NOT_THE_PEER, UNDETERMINED, frame(m));
    xmtp.deliver(id, UNDETERMINED, NOT_THE_PEER, frame(m));
    xmtp.deliver(id, UNDETERMINED, UNDETERMINED, "not json");
    xmtp.deliver(id, UNDETERMINED, UNDETERMINED, toWire({ arena: 1, msg: m, pad: "x".repeat(XMTP_MAX_PAYLOAD_BYTES) }));
    expect(got).toHaveLength(4);
    expect(relay.dropped(id)).toBe(6);
  });

  it("undetermined senders share the channel's budget (spec §3's accepted residual); rejections log a throttled summary only", async () => {
    const { a, id, xmtp, relay, opponent } = await bSide({ joined: true });
    const got: RelayMessage[] = [];
    relay.onMessage((m) => got.push(m));
    const text = frame(stateMsg(id, await a.move("e2e4")));
    for (let i = 0; i < 250; i++) xmtp.deliver(id, UNDETERMINED, UNDETERMINED, text);
    for (const g of got.splice(0)) relay.countRejected(g);
    expect(relay.dropped(id)).toBe(250);
    // No line per message: the drop summary, at most one per channel per XMTP_DROP_LOG_INTERVAL_MS.
    expect(logs.filter((l) => l.includes("dropped an inbound message"))).toHaveLength(1);
    for (let i = 0; i < XMTP_INBOUND_BURST - 250; i++) xmtp.deliver(id, UNDETERMINED, UNDETERMINED, text);
    xmtp.deliver(id, opponent, opponent, text);
    expect(got).toHaveLength(XMTP_INBOUND_BURST - 250); // the opponent's was rate-limited
  });

  it("the drop summary is throttled by time: the first at once, then at most one line per channel per 10 s, with the count (m-N13)", async () => {
    const { a, id, xmtp, relay } = await bSide({ joined: true });
    const other = await bSide({ joined: true });
    expect(XMTP_DROP_LOG_INTERVAL_MS).toBe(10_000);
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    const text = frame(stateMsg(id, await a.move("e2e4")));
    const lines = (cid: Hex) => logs.filter((l) => l.includes(cid.toLowerCase()) && l.includes("dropped an inbound message"));
    xmtp.deliver(id, stranger, stranger, text);
    expect(lines(id)).toHaveLength(1);
    expect(lines(id)[0]).toMatch(/\(not from the opponent\); 1 dropped so far$/);
    for (let i = 0; i < 500; i++) xmtp.deliver(id, stranger, stranger, text); // a flood at one instant
    clock += XMTP_DROP_LOG_INTERVAL_MS - 1;
    xmtp.deliver(id, stranger, stranger, text);
    expect(lines(id)).toHaveLength(1); // still within the interval
    other.xmtp.deliver(other.id, stranger, stranger, text); // another channel has its own interval
    expect(lines(other.id)).toHaveLength(1);
    clock += 1;
    xmtp.deliver(id, UNDETERMINED, UNDETERMINED, "not json");
    expect(lines(id)).toHaveLength(2);
    expect(lines(id)[1]).toMatch(/\(malformed: .*\); 503 dropped so far \(502 since the last line\)$/);
    expect(relay.dropped(id)).toBe(503);
    clock += 60_000;
    xmtp.deliver(id, stranger, stranger, text);
    expect(lines(id)[2]).toMatch(/; 504 dropped so far$/); // a lone drop after a quiet spell: no "since" count
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
    // K1: the turned-away text is re-delivered by a catch-up once the bucket has refilled (a catch-up's worth:
    // XMTP_CATCH_UP_MESSAGES tokens), asked of the transport -- never by a stream restart. Strangers never ask.
    expect(xmtp.catchUps).toEqual([{ channelId: id.toLowerCase(), afterMs: Math.ceil((XMTP_CATCH_UP_MESSAGES / XMTP_INBOUND_PER_SEC) * 1000) }]);
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
    // K3: the XMTP drop count, 0 without the fallback.
    expect(buildStatus(input).xmtpDropped).toBe(0);
    expect(buildStatus({ ...input, xmtpDropped: 7 }).xmtpDropped).toBe(7);
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
      // m-7: an invalid xmtp (a hand edit, or a newer CLI's value) is dropped with one warning, never a throw.
      initHome(home, { ...base, xmtp: { env: "nope" } as unknown as ArenaConfig["xmtp"] });
      const warnings: string[] = [];
      const cfg = loadConfig(home, { warn: (l) => warnings.push(l) });
      expect("xmtp" in cfg).toBe(false);
      expect(cfg.rpcUrl).toBe(RPC);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/^warning: config\.json's xmtp is invalid \(xmtp\.env: .*\), so the XMTP fallback is off/);
      const read = readConfig(home);
      expect(read.xmtpProblem).toContain("xmtp.env");
      expect("xmtp" in read.config).toBe(false);
      // The file itself is left as it was.
      expect((JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { xmtp: unknown }).xmtp).toEqual({ env: "nope" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------------------------------------- run.ts wiring

/** The options a daemon was started with (white-box: what run.ts wired). */
const optsOf = (d: ArenaDaemon) => (d as unknown as { opts: DaemonOptions }).opts;

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
      expect(optsOf(proc.daemon).relayRejected).toBeUndefined(); // every rejection is reported, as before
      expect(optsOf(proc.daemon).relayUndetermined).toBeUndefined(); // and every success clears lastError
      expect(optsOf(proc.daemon).armFallback).toBeUndefined();
      expect(load).not.toHaveBeenCalled();
      expect(out.filter((l) => l.startsWith("xmtp:"))).toEqual([]);
      expect(proc.daemon.fallbackInfo()).toEqual({
        fallback: "off",
        reason: "the XMTP fallback is not configured (config.json has no xmtp)",
      });
    } finally {
      await proc.stop();
    }
  });

  it("m-7: an invalid xmtp in config.json: the daemon still starts, fallback off, one line, the reason on GET /fallback", async () => {
    const dir = await home();
    const path = join(dir, "config.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...raw, xmtp: { env: "mainnet" } }));
    const out: string[] = [];
    const load = vi.fn();
    const proc = await startDaemonProcess(dir, { log: (l) => out.push(l), xmtp: { load } });
    try {
      expect(proc.relay).toBe(proc.host.relay);
      expect(proc.fallback).toBe("off");
      expect(load).not.toHaveBeenCalled();
      const lines = out.filter((l) => l.startsWith("xmtp:"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^xmtp: fallback off: config\.json's xmtp is invalid \(xmtp\.env/);
      const token = (JSON.parse(readFileSync(join(dir, "token.json"), "utf8")) as { token: string }).token;
      const res = await fetch(`${proc.apiUrl}/fallback`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { fallback: string; reason: string };
      expect(body.fallback).toBe("off");
      expect(body.reason).toContain("config.json's xmtp is invalid");
      // Read-only and token-gated like every other data route.
      expect((await fetch(`${proc.apiUrl}/fallback`)).status).toBe(401);
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
      const info = proc.daemon.fallbackInfo();
      expect(info.fallback).toBe("off");
      expect(info.reason).toContain("the XMTP SDK is not installed");
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
        load: async () => ({ ok: true, sdk: {}, version: "6.1.0" }),
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
      // The daemon hands session rejections to FallbackRelay.countRejected (a host relay message is never one).
      const host = { type: "close", channelId: keccak256(toHex("c")), close: { stateHash: keccak256("0x01"), by: 0, sig: "0x" } };
      expect(optsOf(proc.daemon).relayRejected?.(host as RelayMessage)).toBe(false);
      expect(optsOf(proc.daemon).relayUndetermined?.(host as RelayMessage)).toBe(false);
      expect(seen).toEqual([{ dbDir: join(dir, "xmtp", "db"), env: "dev" }]);
      expect(out.filter((l) => l.startsWith("xmtp:"))).toEqual(["xmtp: fallback on (env dev, node-sdk 6.1.0)"]);
      // I-1: the daemon arms a channel's XMTP side on its chain refresh (Open), through FallbackRelay.arm.
      expect(typeof optsOf(proc.daemon).armFallback).toBe("function");
      expect(optsOf(proc.daemon).xmtpDroppedOf?.(keccak256(toHex("c")))).toBe(0);
      // I-2: GET /fallback says what this running daemon loaded.
      const token = (JSON.parse(readFileSync(join(dir, "token.json"), "utf8")) as { token: string }).token;
      const res = await fetch(`${proc.apiUrl}/fallback`, { headers: { authorization: `Bearer ${token}` } });
      expect(await res.json()).toEqual({ fallback: "xmtp" });
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
    const wiring = { load: async () => ({ ok: true as const, sdk: {}, version: "6.1.0" }), transport: () => hung };
    const proc = await startDaemonProcess(dir, { log: (l) => out.push(l), xmtp: wiring });
    const t0 = Date.now();
    await proc.stop();
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(out.some((l) => l.includes("xmtp: stop still pending"))).toBe(true);
    const again = await startDaemonProcess(dir, { log: () => undefined }); // the lock was released
    await again.stop();
  });
});

// ------------------------------------------------------------------------------------------------- the daemon (spec §3)

describe("ArenaDaemon over a FallbackRelay: an XMTP message whose sender is undetermined", () => {
  // Real timers here: the daemons and their RPC clients run for real against Anvil.
  beforeEach(() => vi.useRealTimers());
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  /** The memory relay as a host relay that always has the channel joined, plus `inject`: a message from the host. */
  function asHost(relay: RelayClient): HostRelay & { inject(m: RelayMessage): void } {
    const handlers = new Set<(m: RelayMessage) => void>();
    return {
      join: (id, params, signer) => relay.join(id, params, signer),
      send: (m) => relay.send(m),
      onMessage: (h) => {
        handlers.add(h);
        const off = relay.onMessage(h);
        return () => {
          handlers.delete(h);
          off();
        };
      },
      onJoined: (h) => relay.onJoined(h),
      leave: (id) => relay.leave(id),
      isJoined: () => true,
      onLinkChange: () => () => undefined,
      inject: (m) => {
        for (const h of handlers) h(m);
      },
    };
  }

  /** Alice on the memory relay; Bob on a FallbackRelay over it (as his host) and a FakeXmtp, wired as run.ts does.
   *  `bobUnfunded`: Bob's wallet holds no USDC, so the channel stays in Funding after the match (no wait for Open). */
  async function aliceAndBob(opts: { bobUnfunded?: boolean } = {}) {
    const env = await deployArena();
    const arena = new MemoryArena(async () => ({
      rules: env.rules,
      feeRecipient: env.host,
      feePerPlayer: 5_000n,
      fundingWindow: 3600n,
      now: await now(),
    }));
    const config: ArenaConfig = {
      rpcUrl: RPC,
      chainId: env.domain.chainId,
      hub: env.hub,
      usdc: env.usdc,
      rules: env.rules,
      serverUrl: "memory:",
      port: 0,
      maxFeePerPlayer: 10_000n,
      sessionGasWei: 10n ** 16n,
      pollMs: 100,
      minChallengeTimeout: 60n,
    };
    const homes: string[] = [];
    const start = async (walletKey: Hex, wire: (relay: RelayClient) => Partial<DaemonOptions>, funded = true) => {
      const home = mkdtempSync(join(tmpdir(), "arena-xmtp-daemon-"));
      homes.push(home);
      const own = { ...config };
      initHome(home, own, walletKey);
      if (funded) await mintUsdc(env.usdc, privateKeyToAccount(walletKey).address, 10_000_000n);
      const client = arena.client();
      const daemon = new ArenaDaemon({ home, config: own, walletKey, lobby: client.lobby, relay: client.relay, ...wire(client.relay) });
      await daemon.start();
      return { daemon, client };
    };
    const bobLogs: string[] = [];
    const xmtp = new FakeXmtp();
    let host: ReturnType<typeof asHost> | undefined;
    let fallback: FallbackRelay | undefined;
    const alice = await start(ANVIL_KEYS[1], () => ({}));
    const bob = await start(ANVIL_KEYS[2], (relay) => {
      const h = asHost(relay);
      const fb = new FallbackRelay({ host: h, xmtp, log: (l) => bobLogs.push(l) });
      host = h;
      fallback = fb;
      return {
        relay: fb,
        relayRejected: (m) => fb.countRejected(m),
        relayUndetermined: (m) => fb.isUndetermined(m),
        armFallback: (id) => fb.arm(id),
        xmtpDroppedOf: (id) => fb.dropped(id),
        transportOf: (id) => fb.transportOf(id),
        fallback: "xmtp",
        log: (l) => bobLogs.push(l),
      };
    }, opts.bobUnfunded !== true);
    cleanup = async () => {
      await alice.daemon.stop();
      await bob.daemon.stop();
      await fallback?.stop();
      for (const h of homes) rmSync(h, { recursive: true, force: true });
    };
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    await waitFor(() => bob.daemon.channelIds()[0], 20_000, "bob's match");
    if (opts.bobUnfunded !== true) {
      await waitFor(async () => (await alice.daemon.status(id)).phase === "Open", 30_000, "alice open");
      await waitFor(async () => (await bob.daemon.status(id)).phase === "Open", 30_000, "bob open");
      await waitFor(() => xmtp.opened.length === 1, 10_000, "bob's XMTP client armed");
    }
    const mintBob = () => mintUsdc(env.usdc, privateKeyToAccount(ANVIL_KEYS[2]).address, 10_000_000n);
    return { alice, bob, id, xmtp, host: host as ReturnType<typeof asHost>, fallback: fallback as FallbackRelay, bobLogs, mintBob };
  }

  it("I-1: a match alone (no deposit from the acceptor) starts no XMTP client; the channel Open on chain does", async () => {
    const { bob, id, xmtp, fallback, mintBob } = await aliceAndBob({ bobUnfunded: true });
    // Bob's daemon has the channel, joined on the relay, and its passes run (pollMs 100): still in Funding.
    await new Promise((r) => setTimeout(r, 1_500));
    const st = await bob.daemon.status(id);
    expect(st.phase).not.toBe("Open");
    expect(xmtp.opened).toEqual([]);
    expect(fallback.armed(id)).toBe(false);
    expect(st.transport).toBe("relay");
    expect(st.xmtpDropped).toBe(0);
    // Bob's USDC arrives: his daemon funds, the channel opens, and only now is its XMTP client started -- once.
    await mintBob();
    await waitFor(async () => (await bob.daemon.status(id)).phase === "Open", 30_000, "bob open");
    await waitFor(() => xmtp.opened.length === 1, 10_000, "bob's XMTP client armed");
    await new Promise((r) => setTimeout(r, 500));
    expect(xmtp.opened).toHaveLength(1);
    expect(xmtp.opened[0].channelId.toLowerCase()).toBe(id.toLowerCase());
  });

  it("rejected: counted, no lastError, no line per message; the genuine move is applied and a replay of it is a no-op", async () => {
    const { alice, bob, id, xmtp, host, fallback, bobLogs } = await aliceAndBob();
    bob.client.disconnect(); // Bob hears nothing from the host relay from here on
    await alice.daemon.move(id, "e4", { actor: "agent" });
    const genuine = alice.daemon.handle(id).session.latest;
    expect(genuine.state.turnNum).toBe(1n);
    expect(bob.daemon.handle(id).session.latest.state.turnNum).toBe(0n);
    const eve = privateKeyToAccount(generatePrivateKey());
    const bad = await eve.signMessage({ message: "not the opponent" });
    const forged: SignedState = { ...genuine, sigA: bad, sigB: bad };

    // 150 forgeries from an undetermined sender: the session rejects each; none is an error.
    for (let i = 0; i < 150; i++) xmtp.deliver(id, UNDETERMINED, UNDETERMINED, frame(stateMsg(id, forged)));
    await waitFor(() => fallback.dropped(id) === 150, 20_000, "150 rejections counted");
    expect((await bob.daemon.status(id)).xmtpDropped).toBe(150); // K3: in the channel's status
    expect(bob.daemon.handle(id).lastError).toBeNull();
    expect(bob.daemon.handle(id).session.latest.state.turnNum).toBe(0n);
    expect(bobLogs.filter((l) => l.includes("signature"))).toEqual([]); // no daemon line per message
    // The time-throttled drop summary: the first at once, then at most one per 10 s (the run takes about a second).
    const summaries = bobLogs.filter((l) => l.includes("dropped an inbound message")).length;
    expect(summaries).toBeGreaterThanOrEqual(1);
    expect(summaries).toBeLessThanOrEqual(2);

    // The same forgery from the host relay is reported exactly as before.
    host.inject(stateMsg(id, forged));
    await waitFor(() => bob.daemon.handle(id).lastError !== null, 10_000, "host rejection reported");
    expect(bob.daemon.handle(id).lastError).toContain("invalid opponent signature");
    expect(bobLogs.filter((l) => l.includes("invalid opponent signature"))).toHaveLength(1);
    expect(fallback.dropped(id)).toBe(150);

    // Alice's genuine move, from an undetermined sender, is applied; a replay of it changes nothing.
    xmtp.deliver(id, UNDETERMINED, UNDETERMINED, frame(stateMsg(id, genuine)));
    await waitFor(() => bob.daemon.handle(id).session.latest.state.turnNum === 1n, 10_000, "genuine move applied");
    expect(bob.daemon.handle(id).lastError).toBeNull();
    const before = bob.daemon.handle(id).session.snapshot();
    xmtp.deliver(id, UNDETERMINED, UNDETERMINED, frame(stateMsg(id, genuine)));
    await new Promise((r) => setTimeout(r, 300));
    expect(bob.daemon.handle(id).session.snapshot()).toEqual(before);
    expect(bob.daemon.handle(id).lastError).toBeNull();
    expect(fallback.dropped(id)).toBe(150);

    // m-N12: a repeat from an undetermined sender (here a duplicate, and a stale state nobody signed) leaves a
    // lastError as it was. The host relay's repeat still clears it, exactly as before.
    host.inject(stateMsg(id, { ...forged, state: { ...genuine.state, turnNum: 2n } })); // a forged next state
    await waitFor(() => bob.daemon.handle(id).lastError !== null, 10_000, "host rejection reported again");
    const shown = bob.daemon.handle(id).lastError;
    const stale: SignedState = { ...forged, state: { ...genuine.state, turnNum: 0n } };
    xmtp.deliver(id, UNDETERMINED, UNDETERMINED, frame(stateMsg(id, genuine)));
    xmtp.deliver(id, UNDETERMINED, UNDETERMINED, frame(stateMsg(id, stale)));
    await new Promise((r) => setTimeout(r, 300));
    expect(bob.daemon.handle(id).lastError).toBe(shown);
    expect(bob.daemon.handle(id).session.snapshot()).toEqual(before);
    expect(fallback.dropped(id)).toBe(150);
    host.inject(stateMsg(id, genuine));
    await waitFor(() => bob.daemon.handle(id).lastError === null, 10_000, "host repeat clears lastError");

    // m-N11: an undetermined message whose receive fails for any other reason than a protocol rejection (a failed
    // store.save, say) is reported as before: lastError and one line, not counted as dropped.
    vi.spyOn(bob.daemon.handle(id).session, "receive").mockRejectedValueOnce(new Error("disk full"));
    xmtp.deliver(id, UNDETERMINED, UNDETERMINED, frame(stateMsg(id, genuine)));
    await waitFor(() => bob.daemon.handle(id).lastError !== null, 10_000, "non-protocol failure reported");
    expect(bob.daemon.handle(id).lastError).toBe("disk full");
    expect(bobLogs.filter((l) => l.includes("disk full"))).toHaveLength(1);
    expect(fallback.dropped(id)).toBe(150);
  });
});
