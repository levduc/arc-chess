/**
 * Plan 6 hardening H1 (audit-contracts I1): a griefer who answers the victim's challenge with a finished game can put
 * any bytes in the victim's own signature slot -- the hub checks only the mover's slot of a `hasPrev` proof and
 * re-emits the whole `proof.latest` in `Responded`. Before H1 the victim's daemon stored those bytes, built a
 * `hasPrev: false` proof from them, and the hub refused it (`Unsupported`) on every try: with the griefer gone, the
 * victim had no exit of her own. These tests run the audit's scenario end to end on Anvil and require the victim's
 * daemon to settle the channel by itself.
 *
 * The "oversized events" half: the same unchecked bytes let the griefer make the event too large for an RPC's
 * `getLogs` response. The daemon's scan must not wedge on it.
 */
import type { Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { HubClient, type DisputeEvent } from "@arena/sdk";
import type { ArenaDaemon } from "../src/index.js";
import { UNREADABLE_BLOCK_PASSES, UNSEEN_REGISTERED_PASSES } from "../src/daemon.js";
import { increaseTime, setEthBalance, usdcBalance } from "../../sdk/test/helpers/chain.js";
import { START, startPair, waitFor } from "./helpers/harness.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const TIMEOUT = 600n;
const DEPOSIT = 1_000_000n;
const FEE = 5_000n;

async function matched() {
  const pair = await startPair();
  cleanup = pair.cleanup;
  const { offerId } = await pair.alice.daemon.createOffer({ deposit: DEPOSIT, stakePerGame: 100_000n, challengeTimeout: TIMEOUT });
  await pair.bob.daemon.acceptOffer(offerId);
  const id = await waitFor(async () => {
    const [a, b] = [pair.alice.daemon.channelIds(), pair.bob.daemon.channelIds()];
    return a.length === 1 && b.length === 1 && a[0] === b[0] ? a[0] : null;
  }, 20_000, "match");
  await waitFor(async () => (await pair.alice.daemon.hub.channelInfo(id)).phase === "Open", 20_000, "funding");
  return { ...pair, id };
}

/** The audit's scenario, on a fresh pair (see `griefedDrawOn`). */
async function griefedDraw(junk: Hex) {
  return griefedDrawOn(await matched(), junk);
}

/** After Bob is gone, Alice's only exit: challenge on the draw once her cooldown ends, then time it out. */
async function aliceSettlesAlone(m: Awaited<ReturnType<typeof matched>>) {
  const { alice, env, id } = m;
  await increaseTime(Number(TIMEOUT) + 1); // Alice's cooldown (Bob's respond put her in it) ends
  // Before H1: HubRevertError Unsupported, every time -- the stored junk made the proof `hasPrev: false`.
  await alice.daemon.challenge(undefined, "agent");
  expect((await alice.daemon.hub.channelInfo(id)).phase).toBe("Challenged");
  await increaseTime(Number(TIMEOUT) + 1);
  await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Finalized", 20_000, "alice's timeout");
  expect(await usdcBalance(env.usdc, alice.address)).toBe(START - FEE); // a draw: her deposit back, less the fee
  await waitFor(() => alice.daemon.handle(id).record.finalized, 5_000, "record.finalized");
}

/** Replaces `daemon.hub.disputeEvents` with an RPC that refuses (as a provider's "response size exceeded") any
 *  response carrying an event whose signature bytes are over `limit` -- for any range when `alone` is set, else only
 *  for a range of more than one block. Returns the refusals seen. */
function capResponses(daemon: ArenaDaemon, opts: { limit: number; alone: boolean }) {
  const hub = daemon.hub;
  const real = hub.disputeEvents.bind(hub);
  const refused: Array<{ from: bigint; to: bigint }> = [];
  hub.disputeEvents = async (id: Hex, fromBlock?: bigint, toBlock?: bigint): Promise<DisputeEvent[]> => {
    const events = await real(id, fromBlock, toBlock);
    const big = events.some((e) => e.signed.sigA.length > opts.limit || e.signed.sigB.length > opts.limit);
    const span = fromBlock !== undefined && toBlock !== undefined ? toBlock - fromBlock : 1n;
    if (big && (opts.alone || span > 0n)) {
      refused.push({ from: fromBlock ?? 0n, to: toBlock ?? 0n });
      throw new Error("query returned more than the maximum response size");
    }
    return events;
  };
  return refused;
}

describe("H1 (audit-contracts I1): a junk signature in the victim's slot", () => {
  it("the victim's daemon drops it, and settles the channel on its own", async () => {
    const m = await griefedDraw("0x01");
    const { alice, id } = m;
    await waitFor(() => alice.daemon.handle(id).session.latest.state.turnNum === 2n, 20_000, "alice ingests the draw");
    expect(alice.daemon.handle(id).session.latest.sigA).toBe("0x"); // the junk was not stored
    expect(alice.daemon.handle(id).session.challengeProof().hasPrev).toBe(true);
    await aliceSettlesAlone(m);
  });
});

describe("H1 (audit-contracts I1, oversized events): the dispute scan never wedges on a large event", () => {
  it("a range the RPC refuses because of one large event is split; the event is read alone and the victim settles", async () => {
    const m = await matched();
    // Alice's RPC serves no response holding a large signature for more than one block.
    const refused = capResponses(m.alice.daemon, { limit: 10_000, alone: false });
    const g = await griefedDrawOn(m, `0x${"01".repeat(100_000)}`);
    const { alice, id } = g;
    await waitFor(() => alice.daemon.handle(id).session.latest.state.turnNum === 2n, 20_000, "alice ingests the draw");
    expect(refused.length).toBeGreaterThan(0); // the large event did come back in a multi-block range at first
    expect(alice.daemon.handle(id).session.latest.sigA).toBe("0x");
    expect(alice.daemon.handle(id).record.skippedEventBlocks).toBeUndefined(); // read, not skipped
    await waitFor(() => (alice.daemon.handle(id).record.scannedBlock ?? 0n) >= g.junkBlock, 10_000, "cursor past the event");
    await aliceSettlesAlone(g);
  });

  it("a block the RPC refuses even alone, while it is up, is skipped after a few passes; later events are still read", async () => {
    const m = await matched();
    const refused = capResponses(m.alice.daemon, { limit: 10_000, alone: true });
    const g = await griefedDrawOn(m, `0x${"01".repeat(100_000)}`);
    const { alice, id } = g;
    await waitFor(() => alice.daemon.handle(id).record.skippedEventBlocks?.includes(g.junkBlock) === true, 20_000, "the block is skipped");
    expect(refused.filter((r) => r.from === g.junkBlock && r.to === g.junkBlock).length).toBeGreaterThanOrEqual(UNREADABLE_BLOCK_PASSES);
    expect(alice.daemon.handle(id).session.latest.state.turnNum).toBe(1n); // the draw itself is unreadable here
    await waitFor(() => (alice.daemon.handle(id).record.scannedBlock ?? 0n) >= g.junkBlock, 10_000, "cursor past the block");
    // H1 fix round 1 (review m-2): surfaced from the record, whatever lastError holds.
    alice.daemon.handle(id).lastError = "relay: something else";
    const st = await alice.daemon.status(id);
    expect(st.skippedEventBlocks).toEqual([g.junkBlock.toString()]);
    expect(st.suggestedActions.some((a) => a.startsWith(`check the RPC: block(s) ${g.junkBlock} hold dispute events`))).toBe(true);
    // A later event that carries the same state readably (a challenge on the registered draw) is still ingested.
    // (A client of its own: Bob's stopped daemon aborts its receipt waits.)
    await new HubClient(alice.daemon.hub.hub, alice.daemon.client).challenge(g.bobSender, g.bobDrawProof);
    await waitFor(() => alice.daemon.handle(id).session.latest.state.turnNum === 2n, 20_000, "alice ingests the later event");
    // The settlement goes through either way: the draw is registered, and it is over.
    await increaseTime(Number(TIMEOUT) + 1);
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Finalized", 20_000, "timeout");
  });

  it("an RPC that refuses every read (down) never makes the scan skip a block", async () => {
    const m = await matched();
    const { alice, id } = m;
    const hub = alice.daemon.hub;
    const before = alice.daemon.handle(id).record.scannedBlock;
    hub.disputeEvents = async () => {
      throw new Error("fetch failed");
    };
    for (let i = 0; i < UNREADABLE_BLOCK_PASSES + 2; i++) {
      await alice.daemon.idle();
      await alice.daemon.tick();
    }
    expect(alice.daemon.handle(id).record.skippedEventBlocks).toBeUndefined();
    expect(alice.daemon.handle(id).record.scannedBlock).toBe(before);
    expect(alice.daemon.handle(id).lastError).toBe("events: fetch failed");
  });
});

/**
 * The audit's scenario. Alice (honest, white) plays e4 offering a draw; Bob stalls, so she challenges on it. Bob
 * answers on-chain with ACCEPT_DRAW -- terminal, and free for him -- with `junk` in Alice's slot (sigA). His relay is
 * cut first, so the draw reaches Alice only through the `Responded` event. Then Bob walks away for good. On an
 * already-matched pair, so a test can patch Alice's RPC first. Also returns Bob's session sender and a clean proof
 * of the registered draw, for a later, readable event.
 */
async function griefedDrawOn(m: Awaited<ReturnType<typeof matched>>, junk: Hex) {
  const { alice, bob, id } = m;
  await alice.daemon.move(undefined, "e4", { offerDraw: true, actor: "agent" });
  await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 10_000, "bob's turn");
  bob.client.disconnect();
  await alice.daemon.challenge(undefined, "agent");
  const hub = bob.daemon.hub;
  const real = hub.respond.bind(hub);
  let junkBlock: bigint | undefined;
  hub.respond = async (sender, proof, opts) => {
    const r = await real(sender, { ...proof, latest: { ...proof.latest, sigA: junk } }, opts);
    junkBlock = r.blockNumber;
    return r;
  };
  // The griefer pays for his own junk: 100 KB costs about 3M gas, over the test's session gas at arc-anvil's 25 gwei.
  await setEthBalance(bob.daemon.handle(id).sessionSender.address, 10n ** 18n);
  await bob.daemon.acceptDraw(undefined, "agent");
  await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Open" && junkBlock !== undefined, 20_000, "bob's respond");
  const bobSender = bob.daemon.handle(id).sessionSender;
  const bobDrawProof = bob.daemon.handle(id).session.challengeProof();
  await bob.daemon.stop();
  // (Read through a client of its own: a test may have capped Alice's.)
  const events = await new HubClient(alice.daemon.hub.hub, alice.daemon.client).disputeEvents(id);
  expect(events.find((e) => e.kind === "Responded")?.signed.sigA).toBe(junk); // the hub took the junk and re-emitted it
  return { ...m, junkBlock: junkBlock!, bobSender, bobDrawProof };
}

/**
 * H1 fix round 1 (review I-1): the oversized event is a `Challenged` that registers a move Alice never received. Bob
 * (white's opponent) signs e5 on Alice's e4 without relaying it and challenges on it, with junk in Alice's slot; Alice's
 * RPC refuses that block even alone. Before the fix Alice held nothing newer than e4, could not answer, and was told
 * nothing: Bob's timeout forfeited her current game at the deadline.
 */
async function griefedChallengeOn(m: Awaited<ReturnType<typeof matched>>, junk: Hex) {
  const { alice, bob, id } = m;
  await alice.daemon.move(undefined, "e4", { actor: "agent" });
  await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 10_000, "bob's turn");
  bob.client.disconnect(); // his e5 reaches Alice only through the chain
  const hub = bob.daemon.hub;
  const real = hub.challenge.bind(hub);
  let junkBlock: bigint | undefined;
  hub.challenge = async (sender, proof, opts) => {
    const r = await real(sender, { ...proof, latest: { ...proof.latest, sigA: junk } }, opts);
    junkBlock = r.blockNumber;
    return r;
  };
  await bob.daemon.move(undefined, "e5", { actor: "agent" }); // signed, never relayed
  await setEthBalance(bob.daemon.handle(id).sessionSender.address, 10n ** 18n); // he pays for his own junk
  await bob.daemon.challenge(undefined, "agent");
  expect((await alice.daemon.hub.channelInfo(id)).phase).toBe("Challenged");
  const bobSigned = bob.daemon.handle(id).session.latest;
  await bob.daemon.stop();
  return { ...m, junkBlock: junkBlock!, bobSigned };
}

describe("H1 fix round 1 (review I-1): a challenge whose event cannot be read is never a silent forfeit", () => {
  it("(b) the registered move is adopted from the hub's storage: Alice moves on it and her move answers the challenge", async () => {
    const m = await matched();
    capResponses(m.alice.daemon, { limit: 10_000, alone: true }); // the challenge's block is unreadable, even alone
    const g = await griefedChallengeOn(m, `0x${"01".repeat(100_000)}`);
    const { alice, id } = g;
    const l = alice.daemon.handle(id);
    // Before the fix: Alice stayed at turn 1 -- "not your turn" -- until Bob's timeout took her current game.
    await waitFor(() => l.session.latest.state.turnNum === 2n, 20_000, "the registered move is adopted");
    expect(l.session.latest).toEqual({ state: g.bobSigned.state, sigA: "0x", sigB: "0x" }); // unsigned: none was verified
    const st = await alice.daemon.status(id);
    expect(st.challenge?.mustMove).toBe(true);
    expect(st.attention).toBe("your-turn");
    await alice.daemon.move(id, "Nf3", { actor: "agent" });
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Open", 20_000, "alice's move answers the challenge");
    expect((await alice.daemon.hub.registeredState(id)).turnNum).toBe(3n);
    // The lock the review describes: Alice's own later challenge needs Bob's signature on e5. Once the block can be
    // read, the retried event carries it, and her proof is complete again.
    expect(l.session.snapshot().prev?.sigB).toBe("0x");
    const plain = new HubClient(alice.daemon.hub.hub, alice.daemon.client); // the RPC serves the block again
    alice.daemon.hub.disputeEvents = plain.disputeEvents.bind(plain);
    l.skippedRetryAt = 0;
    await waitFor(() => l.session.snapshot().prev?.sigB === g.bobSigned.sigB, 20_000, "bob's signature is repaired from the event");
    await alice.daemon.challenge(id, "agent"); // single-signature endorsement of e5 by Bob: accepted
    expect((await alice.daemon.hub.channelInfo(id)).phase).toBe("Challenged");
  });

  it("(c) when the registered state cannot be adopted: the challenge-unseen attention names the deadline, and wakes wait once", async () => {
    const m = await matched();
    capResponses(m.alice.daemon, { limit: 10_000, alone: true });
    const l = m.alice.daemon.handle(m.id);
    l.session.adoptRegistered = async () => false; // e.g. a registered state that is not the next turn
    const g = await griefedChallengeOn(m, `0x${"01".repeat(100_000)}`);
    const { alice, id } = g;
    const st = await waitFor(async () => {
      const s = await alice.daemon.status(id);
      return s.attention === "challenge-unseen" ? s : null;
    }, 20_000, "challenge-unseen");
    const deadline = (await alice.daemon.hub.channelInfo(id)).deadline;
    expect(st.suggestedActions[0]).toMatch(
      new RegExp(`^switch RPC: channel ${id} is challenged on turn 2, newer than this daemon holds \\(turn 1\\)`),
    );
    expect(st.suggestedActions[0]).toContain(`forfeited at the deadline (${deadline}`);
    expect(st.suggestedActions[0]).toContain(`block(s) ${g.junkBlock} hold dispute events`);
    expect(await alice.daemon.wait({ ref: id, timeoutMs: 1_000 })).toEqual({ channelId: id, reason: "challenge-unseen" });
    expect((await alice.daemon.wait({ ref: id, timeoutMs: 500 })).reason).not.toBe("challenge-unseen"); // once per challenge
  });

  it("debounced: an unrelayed move registered by a readable challenge is ingested by the scan, with no attention", async () => {
    const m = await matched();
    const { alice, bob, id } = m;
    await alice.daemon.move(undefined, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 10_000, "bob's turn");
    bob.client.disconnect();
    await bob.daemon.move(undefined, "e5", { actor: "agent" });
    await bob.daemon.challenge(undefined, "agent");
    const l = alice.daemon.handle(id);
    await waitFor(() => l.session.latest.state.turnNum === 2n, 20_000, "the scan ingests e5");
    expect(l.session.latest.sigB).not.toBe("0x"); // from the event, signed -- not adopted from storage
    for (let i = 0; i < UNSEEN_REGISTERED_PASSES; i++) {
      await alice.daemon.idle();
      await alice.daemon.tick();
    }
    expect(l.unseenRegistered).toBeNull();
    expect((await alice.daemon.status(id)).attention).toBe("your-turn");
  });
});

/** Stops `daemon`'s periodic passes, so every scan below is one the test drives. */
async function parked(daemon: ArenaDaemon) {
  clearInterval((daemon as unknown as { timer?: NodeJS.Timeout }).timer);
  await daemon.idle();
}

describe("H1 fix round 1 (review m-3): only refusals in a row skip a block", () => {
  it("a block that reads between two refusals starts its count again", async () => {
    const m = await matched();
    const { alice, id } = m;
    await parked(alice.daemon);
    const l = alice.daemon.handle(id);
    const target = await alice.daemon.hub.blockNumber();
    const refuse = { on: true };
    const hub = alice.daemon.hub;
    const real = hub.disputeEvents.bind(hub);
    hub.disputeEvents = async (cid: Hex, from?: bigint, to?: bigint) => {
      if (refuse.on && cid === id && from !== undefined && to !== undefined && from <= target && target <= to) {
        throw new Error("query returned more than the maximum response size");
      }
      return real(cid, from, to);
    };
    const scan = () => (alice.daemon as unknown as { scanDisputes(l: unknown): Promise<void> }).scanDisputes(l);
    const rewind = () => {
      l.record = { ...l.record, scannedBlock: target - 1n };
    };
    rewind();
    await scan();
    await scan();
    expect(l.unreadableBlock).toEqual({ block: target, tries: 2 });
    refuse.on = false;
    await scan(); // it reads
    expect(l.unreadableBlock).toBeNull();
    refuse.on = true;
    rewind();
    await scan();
    // Before the fix the count went on from 2: this third refusal skipped a block that had been read in between.
    expect(l.unreadableBlock).toEqual({ block: target, tries: 1 });
    expect(l.record.skippedEventBlocks).toBeUndefined();
  });
});

describe("H1 fix round 1 (review m-1): skipped blocks are retried in turn", () => {
  it("a skipped block that never reads does not keep the others from being re-read", async () => {
    const m = await matched();
    const { alice, id } = m;
    await parked(alice.daemon);
    const l = alice.daemon.handle(id);
    const head = await alice.daemon.hub.blockNumber();
    const [bad, good] = [head - 1n, head];
    const hub = alice.daemon.hub;
    const real = hub.disputeEvents.bind(hub);
    hub.disputeEvents = async (cid: Hex, from?: bigint, to?: bigint) => {
      if (cid === id && from === bad && to === bad) throw new Error("query returned more than the maximum response size");
      return real(cid, from, to);
    };
    l.record = { ...l.record, skippedEventBlocks: [bad, good] };
    const retry = () => (alice.daemon as unknown as { retrySkippedEventBlock(l: unknown): Promise<void> }).retrySkippedEventBlock(l);
    l.skippedRetryAt = 0;
    await retry(); // the oldest: still refused
    expect(l.record.skippedEventBlocks).toEqual([bad, good]);
    l.skippedRetryAt = 0;
    await retry(); // before the fix, the oldest again; now the next one, which reads
    expect(l.record.skippedEventBlocks).toEqual([bad]);
  });
});
