import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { generatePrivateKey } from "viem/accounts";
import {
  ChannelSession,
  EMPTY_SIGNED,
  HubClient,
  HubRevertError,
  LocalKeyTxSender,
  MAX_FUNDING_WINDOW,
  MemoryStore,
  channelHubAbi,
  chunkRanges,
  signState,
  type CloseTransaction,
  type SessionConfig,
} from "../src/index.js";
import { ANVIL_KEYS, CHAIN, RPC, deployArena, increaseTime, mintUsdc, now, setEthBalance, usdcBalance } from "./helpers/chain.js";
import { SCHOLARS_MATE, makeParams } from "./helpers/fixtures.js";

const START = 10_000_000n;
const MAX = 2n ** 255n;

async function arena(salt: string) {
  const env = await deployArena();
  const alice = new LocalKeyTxSender(ANVIL_KEYS[1], RPC, CHAIN);
  const bob = new LocalKeyTxSender(ANVIL_KEYS[2], RPC, CHAIN);
  const sessionKeys = [generatePrivateKey(), generatePrivateKey()] as const;
  const params = makeParams({
    participants: [alice.address, bob.address],
    sessionKeys,
    rules: env.rules,
    feeRecipient: env.host,
    fundingDeadline: (await now()) + 3600n,
    salt,
  });
  const hub = new HubClient(env.hub, env.pub);
  for (const who of [alice, bob]) {
    await mintUsdc(env.usdc, who.address, START);
    await hub.approve(who, env.usdc, MAX);
  }
  const cfg = (me: 0 | 1): SessionConfig => ({ params, me, sessionKey: sessionKeys[me], domain: env.domain, store: new MemoryStore() });
  return { env, hub, alice, bob, params, sessionKeys, cfg };
}

async function open(x: Awaited<ReturnType<typeof arena>>) {
  await x.hub.deposit(x.alice, x.params);
  await x.hub.deposit(x.bob, x.params);
  const a = await ChannelSession.create(x.cfg(0));
  const b = await ChannelSession.create(x.cfg(1));
  expect((await x.hub.channelInfo(a.id)).phase).toBe("Open");
  return { a, b };
}

async function play(a: ChannelSession, b: ChannelSession, moves: string[]) {
  for (const m of moves) {
    const [mover, other] = a.isMyTurn() ? [a, b] : [b, a];
    await other.receive(await mover.move(m));
  }
}

describe("channel lifecycle on Anvil", () => {
  it("plays two games off-chain and closes cooperatively with Close signatures", async () => {
    const x = await arena("coop");
    const { a, b } = await open(x);

    await play(a, b, SCHOLARS_MATE); // game 0: A white mates
    await a.receive(await b.resign());
    const proposal = await a.proposeNewGame();
    await b.receive(proposal);
    await a.receive(await b.countersignNewGame());
    await play(a, b, SCHOLARS_MATE); // game 1: B white mates
    await b.receive(await a.resign());

    await b.receiveClose(await a.signClose());
    await a.receiveClose(await b.signClose());
    const tx = a.closeTransaction();
    expect(tx).not.toBeNull();
    await x.hub.closeCooperative(x.alice, tx!);

    expect((await x.hub.channelInfo(a.id)).phase).toBe("Finalized");
    expect(await usdcBalance(x.env.usdc, x.alice.address)).toBe(START - x.params.feePerPlayer);
    expect(await usdcBalance(x.env.usdc, x.bob.address)).toBe(START - x.params.feePerPlayer);
    expect(await usdcBalance(x.env.usdc, x.env.host)).toBe(2n * x.params.feePerPlayer);
  });

  it("challenges via a session key, answers on-chain, resumes, and forfeits a staller on timeout", async () => {
    const x = await arena("dispute");
    const { a, b } = await open(x);
    const aliceSessionSender = new LocalKeyTxSender(x.sessionKeys[0], RPC, CHAIN);
    await setEthBalance(aliceSessionSender.address, 10n ** 18n);

    const e4 = await a.move("e2e4");
    await b.receive(e4); // Bob goes quiet instead of answering
    await x.hub.challenge(aliceSessionSender, a.challengeProof());
    expect((await x.hub.channelInfo(a.id)).phase).toBe("Challenged");

    // Bob's watchtower sees the challenge, answers on-chain; Alice adopts the answer from the event.
    const events = await x.hub.disputeEvents(b.id);
    expect(events.map((e) => e.kind)).toEqual(["Challenged"]);
    const challengeReceipt = await x.env.pub.getTransactionReceipt({ hash: events[0].transactionHash });
    expect(challengeReceipt.blockNumber).toBe(events[0].blockNumber);
    expect(await b.ingestOnChain(events[0].signed)).toBe(false); // Bob already had it
    await b.move("e7e5");
    await x.hub.respond(x.bob, b.challengeProof());
    const responded = (await x.hub.disputeEvents(a.id)).at(-1)!;
    expect(responded.kind).toBe("Responded");
    expect(await a.ingestOnChain(responded.signed)).toBe(true);
    expect(a.isMyTurn()).toBe(true);
    expect((await x.hub.channelInfo(a.id)).phase).toBe("Open");

    // Now Alice stalls; Bob challenges the registered state and wins the stake on timeout.
    await x.hub.challenge(x.bob, b.challengeProof());
    await expect(x.hub.timeout(x.alice, a.id)).rejects.toThrow(/TooEarly/);
    await increaseTime(Number(x.params.challengeTimeout));
    await x.hub.timeout(x.alice, a.id);
    const d = x.params.deposit;
    const f = x.params.feePerPlayer;
    const s = x.params.stakePerGame;
    expect(await usdcBalance(x.env.usdc, x.alice.address)).toBe(START - d - f + (d - s));
    expect(await usdcBalance(x.env.usdc, x.bob.address)).toBe(START - d - f + (d + s));
  });

  it("reclaims an unfunded channel after the deadline", async () => {
    const x = await arena("reclaim");
    await x.hub.deposit(x.alice, x.params);
    const a = await ChannelSession.create(x.cfg(0));
    await expect(x.hub.reclaim(x.alice, a.id)).rejects.toThrow(/TooEarly/);
    await increaseTime(3601);
    await x.hub.reclaim(x.alice, a.id);
    expect(await usdcBalance(x.env.usdc, x.alice.address)).toBe(START);
    expect((await x.hub.channelInfo(a.id)).phase).toBe("Reclaimed");
  });

  it("reads the launch limits and tracks committedEscrow across deposit and close", async () => {
    const x = await arena("limits");
    // Drift check: the SDK's exported MAX_FUNDING_WINDOW must track the hub's own on-chain constant.
    const onChainMaxFundingWindow = await x.env.pub.readContract({
      address: x.env.hub,
      abi: channelHubAbi,
      functionName: "MAX_FUNDING_WINDOW",
    });
    expect(onChainMaxFundingWindow).toBe(MAX_FUNDING_WINDOW);

    const limits0 = await x.hub.limits();
    expect(limits0.maxDepositPerPlayer).toBe(10_000_000n);
    expect(limits0.maxCommittedEscrow).toBe(10n ** 12n);
    expect(limits0.paused).toBe(false);
    expect(limits0.committedEscrow).toBe(0n);

    const commit = 2n * (x.params.deposit + x.params.feePerPlayer);
    await x.hub.deposit(x.alice, x.params);
    expect((await x.hub.limits()).committedEscrow).toBe(commit);

    await x.hub.deposit(x.bob, x.params); // second deposit never changes committedEscrow
    expect((await x.hub.limits()).committedEscrow).toBe(commit);

    const a = await ChannelSession.create(x.cfg(0));
    const b = await ChannelSession.create(x.cfg(1));
    await b.receive(await a.resign());
    await b.receiveClose(await a.signClose());
    await a.receiveClose(await b.signClose());
    const tx = a.closeTransaction();
    expect(tx).not.toBeNull();
    await x.hub.closeCooperative(x.alice, tx!);
    expect((await x.hub.limits()).committedEscrow).toBe(0n);
  });

  it("surfaces hub custom errors by name", async () => {
    const x = await arena("errors");
    const { a, b } = await open(x);
    await b.receive(await a.move("e2e4"));
    await a.receive(await b.resign());
    // State co-signatures are not a close intent: the hub rejects them. This is deliberately WRONG input: it is
    // labelled `kind: "close"` only to get past the CloseTransaction type, but carries State signatures instead
    // of Close signatures, to prove the hub itself refuses them.
    const s = a.latest.state;
    const cosigned: CloseTransaction = {
      kind: "close",
      state: s,
      sigA: await signState(x.sessionKeys[0], s, x.env.domain),
      sigB: await signState(x.sessionKeys[1], s, x.env.domain),
    };
    const err = await x.hub.closeCooperative(x.alice, cosigned).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubRevertError);
    expect((err as HubRevertError).errorName).toBe("BadSignature");
    await expect(x.hub.deposit(x.alice, x.params)).rejects.toThrow(/WrongPhase/);
  });

  // --- R8: Close only on terminal states (regressions for PoC1a/PoC1b) -------------------------------------

  it("R8: a withheld Close counter-signature on a terminal state costs the closer nothing", async () => {
    const x = await arena("r8-terminal");
    const { a, b } = await open(x);
    await b.receive(await a.move("e2e4"));
    await a.receive(await b.resign()); // terminal: A +stake
    await b.receiveClose(await a.signClose()); // Alice signs Close; Bob keeps it and withholds his own
    expect(a.isClosing).toBe(true);

    await x.hub.challenge(x.bob, b.challengeProof()); // Bob registers the terminal state instead
    const registered = await x.hub.registeredState(a.id);
    expect(registered).toEqual(a.latest.state);
    await increaseTime(Number(x.params.challengeTimeout));
    await x.hub.timeout(x.bob, a.id);

    // Settled exactly as the terminal state says — no forfeit of the frozen closer.
    const d = x.params.deposit;
    const f = x.params.feePerPlayer;
    const s = x.params.stakePerGame;
    expect([registered.balanceA, registered.balanceB]).toEqual([d + s, d - s]);
    expect(await usdcBalance(x.env.usdc, x.alice.address)).toBe(START - d - f + registered.balanceA);
    expect(await usdcBalance(x.env.usdc, x.bob.address)).toBe(START - d - f + registered.balanceB);
  });

  it("R8: PoC1a/PoC1b cannot start — Close is refused at the opening and at a checkpoint", async () => {
    // PoC1a: at the opening, neither player will sign Close, so nobody is frozen when Bob challenges.
    {
      const x = await arena("r8-poc1a");
      const { a, b } = await open(x);
      await expect(a.signClose()).rejects.toThrow(/can only close on a finished game/);
      await expect(b.signClose()).rejects.toThrow(/can only close on a finished game/);
      await x.hub.challenge(x.bob, b.challengeProof()); // opening, hasPrev = false
      const ev = (await x.hub.disputeEvents(a.id)).at(-1)!;
      expect(await a.ingestOnChain(ev.signed)).toBe(false);
      expect(a.isMyTurn()).toBe(true); // not frozen: Alice answers the challenge
      await a.move("e2e4");
      await x.hub.respond(x.alice, a.challengeProof());
      expect((await x.hub.channelInfo(a.id)).phase).toBe("Open");
      await expect(x.hub.timeout(x.bob, a.id)).rejects.toThrow(/WrongPhase/);
    }
    // PoC1b: on a both-signed checkpoint (B white, on move), neither player will sign Close either.
    {
      const x = await arena("r8-poc1b");
      const { a, b } = await open(x);
      await play(a, b, SCHOLARS_MATE);
      await a.receive(await b.resign());
      await b.receive(await a.proposeNewGame());
      await a.receive(await b.countersignNewGame());
      await expect(b.signClose()).rejects.toThrow(/can only close on a finished game/);
      await expect(a.signClose()).rejects.toThrow(/can only close on a finished game/);
      await x.hub.challenge(x.alice, a.challengeProof()); // both-signed checkpoint
      const ev = (await x.hub.disputeEvents(b.id)).at(-1)!;
      expect(await b.ingestOnChain(ev.signed)).toBe(false);
      expect(b.isMyTurn()).toBe(true); // not frozen: Bob answers
      await b.move("e2e4");
      await x.hub.respond(x.bob, b.challengeProof());
      expect((await x.hub.channelInfo(b.id)).phase).toBe("Open");
      await expect(x.hub.timeout(x.alice, b.id)).rejects.toThrow(/WrongPhase/);
    }
  });

  // --- R9: a move that chains from this player's pending checkpoint (regression for PoC2) ------------------

  it("R9: a withheld countersign plus a challenge on the next move is answered, not forfeited", async () => {
    const x = await arena("r9-poc2");
    const { a, b } = await open(x);
    await play(a, b, SCHOLARS_MATE); // game 0: A mates
    await a.receive(await b.resign()); // A +stake
    const proposal = await a.proposeNewGame(); // A's pending checkpoint C
    expect(await b.receive(proposal)).toBe("checkpoint-proposed");
    const full = await b.countersignNewGame(); // withheld from A
    const m = await b.move("e2e4"); // C+1: B is white in game 1
    await x.hub.challenge(x.bob, { hasPrev: true, prev: full, latest: m });

    const ev = (await x.hub.disputeEvents(a.id)).at(-1)!;
    expect(ev.kind).toBe("Challenged");
    expect(ev.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ev.turnNum).toBe(a.latest.state.turnNum + 2n);
    expect(await a.ingestOnChain(ev.signed)).toBe(true);
    expect(a.isMyTurn()).toBe(true);

    await a.move("e7e5"); // C+2
    const proof = a.challengeProof();
    expect(proof.hasPrev).toBe(true);
    expect(proof.prev.state).toEqual(m.state);
    await x.hub.respond(x.alice, proof);
    expect((await x.hub.channelInfo(a.id)).phase).toBe("Open");
    await expect(x.hub.timeout(x.bob, a.id)).rejects.toThrow(/WrongPhase/);

    // Bob picks the answer up from the Responded event and play continues off-chain.
    const responded = (await x.hub.disputeEvents(b.id)).at(-1)!;
    expect(responded.kind).toBe("Responded");
    expect(await b.ingestOnChain(responded.signed)).toBe(true);
    await play(a, b, ["g1f3"]);
    expect(a.isMyTurn()).toBe(true);
  });

  // --- R4/I1: a terminal move on a withheld checkpoint, registered on-chain (Plan 3 fix round 1) -------------

  it("R4/I1: Bob registers a move-1 resignation on Alice's withheld checkpoint; Alice ingests, proves alone, and is paid out on timeout", async () => {
    const x = await arena("r4-i1");
    const { a, b } = await open(x);

    await play(a, b, SCHOLARS_MATE); // game 0: A mates
    await a.receive(await b.resign()); // A +stake

    const proposal = await a.proposeNewGame(); // A's pending checkpoint C (game 1: B white)
    await b.receive(proposal);
    const full = await b.countersignNewGame(); // withheld from A off-chain
    const resign = await b.resign(); // C+1: B resigns move 1 of game 1 -- never delivered to A off-chain either

    // Reviewer's probe "b": instead of relaying `resign` to Alice, Bob registers {prev: C (both-signed), latest:
    // C+1 (Bob-signed)} on-chain directly. Before this fix (I1), the only way for Alice to recover from this was
    // through ingestOnChain's R9 path (iv), which left `prev` a checkpoint only Alice had signed and `latest`
    // signed only by Bob -- `challengeProof` then threw, and only Bob could unlock the funds. R4 fixes path (iv)
    // the same way it fixes `receive`'s on-pending branch: Alice also signs the adopted C+1 herself.
    await x.hub.challenge(x.bob, { hasPrev: true, prev: full, latest: resign });
    expect((await x.hub.channelInfo(a.id)).phase).toBe("Challenged");
    const ev = (await x.hub.disputeEvents(a.id)).at(-1)!;
    expect(ev.kind).toBe("Challenged");
    expect(await a.ingestOnChain(ev.signed)).toBe(true);

    // Alice's own proof of the adopted (terminal) state needs no predecessor and no help from Bob.
    const proof = a.challengeProof();
    expect(proof.hasPrev).toBe(false);
    expect(proof.latest.state).toEqual(resign.state);
    expect(proof.latest.sigA).not.toBe("0x");
    expect(proof.latest.sigB).not.toBe("0x");

    // The state Bob registered is already this exact, final, Alice-favouring state: nothing further to dispute.
    // `respond` would revert (StaleState, same turnNum) and `challenge` would revert (WrongPhase, already
    // Challenged) if either player tried -- timeout alone settles it as registered.
    await increaseTime(Number(x.params.challengeTimeout));
    await x.hub.timeout(x.alice, a.id);
    expect((await x.hub.channelInfo(a.id)).phase).toBe("Finalized");

    const d = x.params.deposit;
    const f = x.params.feePerPlayer;
    const s = x.params.stakePerGame;
    const bal = a.latest.state; // balances after both games (game 0 mate, game 1 resignation), both won by Alice
    expect([bal.balanceA, bal.balanceB]).toEqual([d + 2n * s, d - 2n * s]); // Alice: the game-1 stake, plus game 0's
    expect(await usdcBalance(x.env.usdc, x.alice.address)).toBe(START - d - f + bal.balanceA);
    expect(await usdcBalance(x.env.usdc, x.bob.address)).toBe(START - d - f + bal.balanceB);
  });

  it("R4 respond path: Bob challenges at checkpoint C; Alice answers with her co-signed C+1 and no predecessor", async () => {
    // Reviewer's final-review probe, committed: the hub accepts R4's both-signed, prev-less move on `respond`
    // (spec §12 items 11 and 14), not only on `challenge`.
    const x = await arena("r4-respond");
    const { a, b } = await open(x);
    await play(a, b, SCHOLARS_MATE);
    await a.receive(await b.resign());
    const proposal = await a.proposeNewGame(); // A's pending checkpoint C
    await b.receive(proposal);
    const full = await b.countersignNewGame(); // withheld from A
    const resign = await b.resign(); // C+1, delivered to A off-chain
    expect(await a.receive(resign)).toBe("move"); // R4: A adopts C+1 and co-signs it

    // Bob registers the (both-signed) checkpoint C, hiding the move he already made on it.
    await x.hub.challenge(x.bob, { hasPrev: false, prev: EMPTY_SIGNED, latest: full });
    expect((await x.hub.channelInfo(a.id)).phase).toBe("Challenged");
    const proof = a.challengeProof();
    expect(proof.hasPrev).toBe(false);
    expect(proof.latest.state).toEqual(resign.state);
    await x.hub.respond(x.alice, proof);
    expect((await x.hub.channelInfo(a.id)).phase).toBe("Open");
    expect((await x.hub.registeredState(a.id)).turnNum).toBe(resign.state.turnNum);
  });
});

describe("HubClient.disputeEvents", () => {
  it("M7: reads the head once and bounds both event queries by it", async () => {
    const calls: Array<{ eventName: string; fromBlock: bigint; toBlock: bigint }> = [];
    let heads = 0;
    const fake = {
      getBlockNumber: async (opts?: { cacheTime?: number }) => {
        heads++;
        expect(opts?.cacheTime).toBe(0); // a cached head would hide events mined since the last poll
        return 42n;
      },
      getContractEvents: async (q: { eventName: string; fromBlock: bigint; toBlock: bigint }) => {
        calls.push({ eventName: q.eventName, fromBlock: q.fromBlock, toBlock: q.toBlock });
        return [];
      },
    } as unknown as PublicClient;
    const hub = new HubClient("0x000000000000000000000000000000000000beef", fake);
    expect(await hub.disputeEvents(`0x${"11".repeat(32)}`, 7n)).toEqual([]);
    expect(heads).toBe(1);
    expect(calls.map((c) => c.eventName).sort()).toEqual(["Challenged", "Responded"]);
    for (const c of calls) expect([c.fromBlock, c.toBlock]).toEqual([7n, 42n]);
  });
});

describe("hub scans", () => {
  it("chunkRanges splits inclusive ranges", () => {
    expect(chunkRanges(10n, 12n, 2n)).toEqual([
      { fromBlock: 10n, toBlock: 11n },
      { fromBlock: 12n, toBlock: 12n },
    ]);
    expect(chunkRanges(5n, 4n, 10n)).toEqual([]);
    expect(() => chunkRanges(0n, 1n, 0n)).toThrow();
  });

  // No existing lifecycle test both challenges and closes cooperatively (Finalized) in one flow; this scenario
  // (challenge -> timeout -> Finalized, no Responded) is built fresh, mirroring "challenges via a session key,
  // answers on-chain..." up to its first challenge/timeout instead of sharing state across `it` blocks.
  it("hubEvents decodes a challenged-then-finalized channel in order; disputeEvents honours toBlock", async () => {
    const x = await arena("hub-scan");
    const { a, b } = await open(x);
    const id = a.id;
    const params = x.params;
    const aliceSessionSender = new LocalKeyTxSender(x.sessionKeys[0], RPC, CHAIN);
    await setEthBalance(aliceSessionSender.address, 10n ** 18n);

    const e4 = await a.move("e2e4");
    await b.receive(e4); // Bob goes quiet instead of answering
    await x.hub.challenge(aliceSessionSender, a.challengeProof());
    await increaseTime(Number(x.params.challengeTimeout));
    await x.hub.timeout(x.alice, id);
    expect((await x.hub.channelInfo(id)).phase).toBe("Finalized");

    const events = await x.hub.hubEvents(0n, await x.hub.blockNumber());
    const kinds = events.filter((e) => e.channelId === id).map((e) => e.kind);
    expect(kinds[0]).toBe("ChannelCreated");
    expect(kinds).toContain("Deposited");
    expect(kinds).toContain("Opened");
    expect(kinds.at(-1)).toMatch(/Finalized|Reclaimed/);
    const created = events.find((e) => e.kind === "ChannelCreated" && e.channelId === id);
    expect(created && created.kind === "ChannelCreated" && created.params).toEqual(params);

    const all = await x.hub.disputeEvents(id, 0n);
    expect(all.map((e) => e.kind)).toEqual(["Challenged"]); // Bob never responded
    const first = all[0];
    expect(await x.hub.disputeEvents(id, 0n, first.blockNumber - 1n)).toEqual([]);
  });
});
