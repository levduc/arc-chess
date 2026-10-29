/**
 * Plan 6 hardening H1 (audit-contracts I1, "oversized events"): the hub re-emits a proof's signature bytes in its
 * `Challenged`/`Responded` events, so an event can be larger than an RPC serves in a `getLogs` response. The daemon's
 * scan must not wedge on such an event, and a challenge whose event cannot be read must never be a silent forfeit.
 *
 * H3: the owner adopted the hardened hub (I1, `750e280`): it now verifies every signature slot it re-emits, so the
 * griefer's junk signature these tests used to plant on-chain reverts `BadSignature`. The test of the victim's daemon
 * dropping a junk signature it read from an event is gone with it: that event can no longer exist. The unreadable
 * event is now produced by the RPC itself -- a fake fetch in front of Anvil that refuses the block (Arc's -32012
 * "requested range too large") while every signature on-chain is valid -- and the same block, rate-limited instead
 * of refused, must be read again later, never skipped (spec §12 items 18 and 67).
 */
import { createPublicClient, encodeEventTopics, type Hex, type PublicClient } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { HubClient, ZERO_HASH, channelHubAbi, rpcTransport } from "@arena/sdk";
import type { ArenaDaemon } from "../src/index.js";
import { UNREADABLE_BLOCK_PASSES, UNSEEN_REGISTERED_PASSES } from "../src/daemon.js";
import { RPC, increaseTime, usdcBalance } from "../../sdk/test/helpers/chain.js";
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

/** After Bob is gone, Alice's only exit: challenge on the draw once her cooldown ends, then time it out. */
async function aliceSettlesAlone(m: Awaited<ReturnType<typeof matched>>) {
  const { alice, env, id } = m;
  await increaseTime(Number(TIMEOUT) + 1); // Alice's cooldown (Bob's respond put her in it) ends
  await alice.daemon.challenge(undefined, "agent");
  expect((await alice.daemon.hub.channelInfo(id)).phase).toBe("Challenged");
  await increaseTime(Number(TIMEOUT) + 1);
  await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Finalized", 20_000, "alice's timeout");
  expect(await usdcBalance(env.usdc, alice.address)).toBe(START - FEE); // a draw: her deposit back, less the fee
  await waitFor(() => alice.daemon.handle(id).record.finalized, 5_000, "record.finalized");
}

const TOPIC0 = {
  Challenged: encodeEventTopics({ abi: channelHubAbi, eventName: "Challenged" })[0],
  Responded: encodeEventTopics({ abi: channelHubAbi, eventName: "Responded" })[0],
};

/**
 * H3: routes `daemon`'s dispute-event reads through viem's real HTTP transport (`rpcTransport`, retries shortened)
 * over a fake fetch in front of Anvil. A read of channel `id`'s `kind` events whose answer would hold one -- for any
 * range when `alone` is set, else only for a range of more than one block -- is answered as Arc's RPC answers what it
 * will not serve, `-32012 "requested range too large"`, while `state.refusing`, or rate-limited (`-32005 "rate limit
 * exceeded"`) while `state.limiting`. Everything else, the scan's zero-id probe included, is served by Anvil.
 */
function unreadable(daemon: ArenaDaemon, id: Hex, kind: keyof typeof TOPIC0, opts: { alone: boolean; refusing?: boolean; limiting?: boolean }) {
  const state = {
    refusing: opts.refusing ?? true,
    limiting: opts.limiting ?? false,
    refused: [] as Array<{ from: bigint; to: bigint }>,
    limited: [] as Array<{ from: bigint; to: bigint }>,
    probes: 0,
  };
  const rpcError = (reqId: number, code: number, message: string) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: reqId, error: { code, message } }), { headers: { "content-type": "application/json" } });
  const fetchFn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const upstream = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: init?.body });
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: Array<{ fromBlock: Hex; toBlock: Hex; topics?: unknown[] }> };
    if (req.method !== "eth_getLogs") return upstream;
    const f = req.params[0];
    const [topic0, topic1] = [String(f.topics?.[0] ?? "").toLowerCase(), String(f.topics?.[1] ?? "").toLowerCase()];
    if (topic1 === ZERO_HASH) state.probes++;
    if (topic1 !== id.toLowerCase() || topic0 !== TOPIC0[kind].toLowerCase()) return upstream;
    const body = (await upstream.json()) as { id: number; result?: unknown[] };
    const range = { from: BigInt(f.fromBlock), to: BigInt(f.toBlock) };
    if ((body.result?.length ?? 0) > 0 && (opts.alone || range.to > range.from)) {
      if (state.limiting) {
        state.limited.push(range);
        return rpcError(req.id, -32005, "rate limit exceeded");
      }
      if (state.refusing) {
        state.refused.push(range);
        return rpcError(req.id, -32012, "requested range too large");
      }
    }
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  const client = createPublicClient({ transport: rpcTransport(RPC, { fetchFn, retryDelay: 1 }) }) as PublicClient;
  const fake = new HubClient(daemon.hub.hub, client);
  daemon.hub.disputeEvents = fake.disputeEvents.bind(fake);
  return state;
}

/**
 * Alice (honest, white) plays e4 offering a draw; Bob stalls, so she challenges on it. Bob answers on-chain with
 * ACCEPT_DRAW, validly signed. His relay is cut first, so the draw reaches Alice only through the `Responded` event.
 * Then Bob walks away for good. On an already-matched pair, so a test can patch Alice's RPC first. Returns the
 * respond's block, Bob's session sender and his proof of the registered draw, for a later, readable event.
 */
async function drawByRespondOn(m: Awaited<ReturnType<typeof matched>>) {
  const { alice, bob, id } = m;
  await alice.daemon.move(undefined, "e4", { offerDraw: true, actor: "agent" });
  await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 10_000, "bob's turn");
  bob.client.disconnect();
  await alice.daemon.challenge(undefined, "agent");
  const hub = bob.daemon.hub;
  const real = hub.respond.bind(hub);
  let block: bigint | undefined;
  hub.respond = async (sender, proof, opts) => {
    const r = await real(sender, proof, opts);
    block = r.blockNumber;
    return r;
  };
  await bob.daemon.acceptDraw(undefined, "agent");
  await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Open" && block !== undefined, 20_000, "bob's respond");
  const bobSender = bob.daemon.handle(id).sessionSender;
  const bobDrawProof = bob.daemon.handle(id).session.challengeProof();
  await bob.daemon.stop();
  return { ...m, block: block!, bobSender, bobDrawProof };
}

describe("H1 (audit-contracts I1, oversized events): the dispute scan never wedges on a large event", () => {
  it("a range the RPC refuses because of one large event is split; the event is read alone and the victim settles", async () => {
    const m = await matched();
    // Alice's RPC refuses any range of more than one block that holds Bob's Responded.
    const rpc = unreadable(m.alice.daemon, m.id, "Responded", { alone: false });
    const g = await drawByRespondOn(m);
    const { alice, id } = g;
    await waitFor(() => alice.daemon.handle(id).session.latest.state.turnNum === 2n, 20_000, "alice ingests the draw");
    expect(rpc.refused.length).toBeGreaterThan(0); // the event did come back refused in a multi-block range at first
    expect(rpc.refused.every((r) => r.from <= g.block && g.block <= r.to && r.to > r.from)).toBe(true);
    expect(alice.daemon.handle(id).record.skippedEventBlocks).toBeUndefined(); // read, not skipped
    await waitFor(() => (alice.daemon.handle(id).record.scannedBlock ?? 0n) >= g.block, 10_000, "cursor past the event");
    await aliceSettlesAlone(g);
  });

  it("a block the RPC refuses even alone, while it is up, is skipped after a few passes; later events are still read", async () => {
    const m = await matched();
    const rpc = unreadable(m.alice.daemon, m.id, "Responded", { alone: true });
    const g = await drawByRespondOn(m);
    const { alice, id } = g;
    await waitFor(() => alice.daemon.handle(id).record.skippedEventBlocks?.includes(g.block) === true, 20_000, "the block is skipped");
    expect(rpc.refused.filter((r) => r.from === g.block && r.to === g.block).length).toBeGreaterThanOrEqual(UNREADABLE_BLOCK_PASSES);
    expect(alice.daemon.handle(id).session.latest.state.turnNum).toBe(1n); // the draw itself is unreadable here
    await waitFor(() => (alice.daemon.handle(id).record.scannedBlock ?? 0n) >= g.block, 10_000, "cursor past the block");
    // H1 fix round 1 (review m-2): surfaced from the record, whatever lastError holds.
    alice.daemon.handle(id).lastError = "relay: something else";
    const st = await alice.daemon.status(id);
    expect(st.skippedEventBlocks).toEqual([g.block.toString()]);
    expect(st.suggestedActions.some((a) => a.startsWith(`check the RPC: block(s) ${g.block} hold dispute events`))).toBe(true);
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
    hub.disputeEvents = async () => {
      throw new Error("fetch failed");
    };
    // A scan pass already in flight may still advance the cursor with what it read before the stub went in: let it
    // finish, then take the starting point (a race under full-suite load otherwise: 1145n vs 1144n).
    await alice.daemon.idle();
    const before = alice.daemon.handle(id).record.scannedBlock;
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
 * H1 fix round 1 (review I-1): the unreadable event is a `Challenged` that registers a move Alice never received. Bob
 * (white's opponent) signs e5 on Alice's e4 without relaying it and challenges on it, validly signed; a test makes
 * Alice's RPC refuse (or rate-limit) that block. Before the fix, with the block refused, Alice held nothing newer than
 * e4, could not answer, and was told nothing: Bob's timeout forfeited her current game at the deadline.
 */
async function challengeOn(m: Awaited<ReturnType<typeof matched>>) {
  const { alice, bob, id } = m;
  await alice.daemon.move(undefined, "e4", { actor: "agent" });
  await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 10_000, "bob's turn");
  bob.client.disconnect(); // his e5 reaches Alice only through the chain
  const hub = bob.daemon.hub;
  const real = hub.challenge.bind(hub);
  let block: bigint | undefined;
  hub.challenge = async (sender, proof, opts) => {
    const r = await real(sender, proof, opts);
    block = r.blockNumber;
    return r;
  };
  await bob.daemon.move(undefined, "e5", { actor: "agent" }); // signed, never relayed
  await bob.daemon.challenge(undefined, "agent");
  expect((await alice.daemon.hub.channelInfo(id)).phase).toBe("Challenged");
  const bobSigned = bob.daemon.handle(id).session.latest;
  await bob.daemon.stop();
  return { ...m, block: block!, bobSigned };
}

describe("H1 fix round 1 (review I-1): a challenge whose event cannot be read is never a silent forfeit", () => {
  it("(b) the registered move is adopted from the hub's storage: Alice moves on it and her move answers the challenge", async () => {
    const m = await matched();
    unreadable(m.alice.daemon, m.id, "Challenged", { alone: true }); // the challenge's block is refused, even alone
    const g = await challengeOn(m);
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
    unreadable(m.alice.daemon, m.id, "Challenged", { alone: true });
    const l = m.alice.daemon.handle(m.id);
    l.session.adoptRegistered = async () => false; // e.g. a registered state that is not the next turn
    const g = await challengeOn(m);
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
    expect(st.suggestedActions[0]).toContain(`block(s) ${g.block} hold dispute events`);
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

describe("final fix wave B (m-9, h1 N-7): a registered turn ingested during the adopt attempt is never raised as unseen", () => {
  it("the adopt is refused because the relay delivered that turn meanwhile: no challenge-unseen, nothing kept", async () => {
    const m = await matched();
    const { alice, id } = m;
    await parked(alice.daemon);
    const l = alice.daemon.handle(id);
    const before = l.session.latest;
    const registered = { turnNum: before.state.turnNum + 1n } as Awaited<ReturnType<HubClient["registeredState"]>>;
    const info = { phase: "Challenged", deadline: 4_000_000_000n } as Awaited<ReturnType<HubClient["channelInfo"]>>;
    // The hub reads Challenged with a registered state, and the adopt is refused: while it was being tried, a relayed
    // move (modelled by `latest` advancing) brought the session to that very turn.
    let delivered = false;
    Object.defineProperty(l.session, "latest", {
      configurable: true,
      get: () => (delivered ? { ...before, state: { ...before.state, turnNum: registered.turnNum } } : before),
    });
    const realInfo = alice.daemon.hub.channelInfo.bind(alice.daemon.hub);
    alice.daemon.hub.channelInfo = async () => ({ ...info, hasRegistered: true, registeredHash: ZERO_HASH }) as typeof info;
    l.session.adoptRegistered = async () => {
      delivered = true;
      return false;
    };
    // At the last debounced pass: the next one raises.
    l.unseenRegistered = { key: `${info.deadline}:${registered.turnNum}`, turn: registered.turnNum, deadline: info.deadline, passes: UNSEEN_REGISTERED_PASSES - 1, raised: false };
    try {
      await (alice.daemon as unknown as { handleUnseenRegistered(l: unknown, i: unknown, r: unknown): Promise<void> }).handleUnseenRegistered(l, info, registered);
    } finally {
      alice.daemon.hub.channelInfo = realInfo;
      delete (l.session as unknown as { latest?: unknown }).latest;
    }
    expect(delivered).toBe(true);
    // Before: the `latest` read before the awaits was kept, and challenge-unseen was raised (one spurious wake).
    expect(l.unseenRegistered).toBeNull();
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

describe("H3 fix round 1 (review I2): H1's probes, when the RPC refuses the probe too", () => {
  const REFUSED = () => Object.assign(new Error("requested range too large"), { code: -32012 });

  /** Alice parked, her cursor rewound so the scan's range spans several blocks, and every dispute-event read answered
   *  by `answer` (the zero-id probe included); the reads are recorded. */
  async function refusing(answer: (cid: Hex, from: bigint, to: bigint) => "refuse" | "serve") {
    const m = await matched();
    const { alice, id } = m;
    await parked(alice.daemon);
    const l = alice.daemon.handle(id);
    const head = await alice.daemon.hub.blockNumber();
    l.record = { ...l.record, scannedBlock: head - 1n };
    const reads: Array<{ cid: Hex; from: bigint; to: bigint }> = [];
    alice.daemon.hub.disputeEvents = async (cid: Hex, from?: bigint, to?: bigint) => {
      reads.push({ cid, from: from!, to: to! });
      if (answer(cid, from!, to!) === "refuse") throw REFUSED();
      return [];
    };
    const scan = () => (alice.daemon as unknown as { scanDisputes(l: unknown): Promise<void> }).scanDisputes(l);
    return { l, reads, scan, head };
  }

  it("every read refused, the range's probe too: the range is neither split nor counted", async () => {
    const { l, reads, scan } = await refusing(() => "refuse");
    const before = l.record.scannedBlock;
    for (let i = 0; i <= UNREADABLE_BLOCK_PASSES; i++) await scan();
    const first = reads[0];
    expect(first.to).toBeGreaterThan(first.from); // a multi-block range
    expect(reads.filter((r) => r.cid === ZERO_HASH)).toHaveLength(UNREADABLE_BLOCK_PASSES + 1); // probed once a pass
    expect(reads.every((r) => r.from === first.from && r.to === first.to)).toBe(true); // never a half
    expect(l.record.skippedEventBlocks).toBeUndefined();
    expect(l.unreadableBlock).toBeNull();
    expect(l.record.scannedBlock).toBe(before);
    expect(l.lastError).toBe("events: requested range too large");
  });

  it("a range's probe served but a single block's refused: the block is never counted toward a skip", async () => {
    // A node that refuses any one-block query outright (content-independent), and serves the wider probe.
    const { l, reads, scan } = await refusing((cid, from, to) => (cid === ZERO_HASH && to > from ? "serve" : "refuse"));
    for (let i = 0; i <= UNREADABLE_BLOCK_PASSES; i++) await scan();
    expect(reads.some((r) => r.cid === ZERO_HASH && r.from === r.to)).toBe(true); // the single-block probe ran
    // Before the guard, the third pass skipped the block although the RPC refused even the empty query on it.
    expect(l.record.skippedEventBlocks).toBeUndefined();
    expect(l.unreadableBlock).toBeNull();
    expect(l.lastError).toBe("events: requested range too large");
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

describe("H3: the challenge's block rate-limited, not refused, is read again -- never skipped", () => {
  it("rate-limited for more passes than a skip takes, then served: no skip, no probe, and the event is read signed", async () => {
    const m = await matched();
    const rpc = unreadable(m.alice.daemon, m.id, "Challenged", { alone: true, refusing: false, limiting: true });
    await parked(m.alice.daemon); // every scan below is one the test drives, and no dispute pass adopts in between
    const g = await challengeOn(m);
    const { alice, id } = g;
    const l = alice.daemon.handle(id);
    const scan = () => (alice.daemon as unknown as { scanDisputes(l: unknown): Promise<void> }).scanDisputes(l);
    for (let i = 0; i <= UNREADABLE_BLOCK_PASSES; i++) await scan();
    expect(rpc.limited.some((r) => r.from <= g.block && g.block <= r.to)).toBe(true);
    // Before H3: probed, split down to the block, and skipped at the third pass -- with the move then adopted unsigned.
    expect(rpc.probes).toBe(0);
    expect(l.record.skippedEventBlocks).toBeUndefined();
    expect(l.unreadableBlock).toBeNull();
    expect(l.session.latest.state.turnNum).toBe(1n);
    expect(l.lastError).toMatch(/^events: Request exceeds defined limit/);
    rpc.limiting = false; // served again
    await scan();
    expect(l.session.latest.state).toEqual(g.bobSigned.state);
    expect(l.session.latest.sigB).toBe(g.bobSigned.sigB); // from the event, signed: nothing adopted from storage
    expect(l.lastError).toBeNull();
    for (let i = 0; i < UNSEEN_REGISTERED_PASSES; i++) await alice.daemon.tick();
    expect(l.unseenRegistered).toBeNull();
    expect(l.record.skippedEventBlocks).toBeUndefined();
    expect((await alice.daemon.status(id)).attention).toBe("your-turn");
  });
});
