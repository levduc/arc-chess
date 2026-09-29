import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { TransactionReceiptNotFoundError, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ChannelSession,
  HubClient,
  HubRevertError,
  LocalKeyTxSender,
  TxDroppedError,
  TxNonceUsedError,
  NO_FEE_CEILING,
  DEFAULT_FEE_CEILING_WEI,
  buildParams,
  hashState,
  offerId as computeOfferId,
  signClose,
  type MatchEvent,
  type SignedAcceptance,
} from "@arena/sdk";
import { SCHOLARS_MATE } from "../../sdk/test/helpers/fixtures.js";
import { CHAIN, RPC, increaseTime, now, setEthBalance, setLimits, setPaused } from "../../sdk/test/helpers/chain.js";
import { ArenaDaemon, DaemonError, FileSessionStore, RecordStore, arenaPaths, loadConfig, type ChannelRecord } from "../src/index.js";
import { startPair, waitFor } from "./helpers/harness.js";

/** Test-only escape hatch: onMatch/records are private/protected, but these tests craft host events. */
type Internals = { onMatch(m: MatchEvent): Promise<void>; records: { saveOffer(r: unknown): void } };
const internals = (d: ArenaDaemon): Internals => d as unknown as Internals;
const randomNonce = (): Hex => `0x${randomBytes(32).toString("hex")}`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function matched() {
  const pair = await startPair();
  cleanups.push(pair.cleanup);
  const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
  await pair.bob.daemon.acceptOffer(offerId);
  const id = await waitFor(async () => {
    const [a, b] = [pair.alice.daemon.channelIds(), pair.bob.daemon.channelIds()];
    return a.length === 1 && b.length === 1 && a[0] === b[0] ? a[0] : null;
  }, 20_000, "match");
  await waitFor(async () => (await pair.alice.daemon.hub.channelInfo(id)).phase === "Open", 20_000, "funding");
  return { ...pair, id };
}

describe("I1: one bad channel entry never disables the watchtower", () => {
  it("P2 regression: start() survives corrupt entries, watches the valid channel and reports the rest as degraded", async () => {
    const { alice, id } = await matched();
    await alice.daemon.stop();
    const channels = join(alice.home, "channels");
    // (1) a truncated record.json
    const garbage = `0x${"ab".repeat(32)}`;
    mkdirSync(join(channels, garbage), { recursive: true });
    writeFileSync(join(channels, garbage, "record.json"), "{ truncated");
    // (2) a directory that is not a channel id at all
    mkdirSync(join(channels, "not-a-channel"), { recursive: true });
    // (3) a well-formed record whose params do not hash to its channelId (e.g. another hub/chain)
    const foreign = `0x${"cd".repeat(32)}` as const;
    const real = new RecordStore(alice.home).channel(id) as ChannelRecord;
    new RecordStore(alice.home).saveChannel({ ...real, channelId: foreign });

    const restarted = new ArenaDaemon({
      home: alice.home,
      config: loadConfig(alice.home),
      walletKey: alice.walletKey,
      lobby: alice.client.lobby,
      relay: alice.client.relay,
    });
    cleanups.push(() => restarted.stop());
    await expect(restarted.start()).resolves.toBeUndefined();

    // The valid channel is live, picked by default, and watched.
    expect(restarted.channelIds()).toEqual([id]);
    expect((await restarted.status()).phase).toBe("Open");
    await restarted.idle();
    const before = restarted.handle(id).mainPasses;
    await restarted.tick();
    expect(restarted.handle(id).mainPasses).toBeGreaterThan(before);

    // The bad entries are reported, not watched, and never picked.
    const listed = await restarted.channels();
    expect(listed).toHaveLength(4);
    const degraded = listed.filter((c) => "degraded" in c && c.degraded) as Array<{ channelId: string; error: string }>;
    expect(degraded.map((d) => d.channelId).sort()).toEqual([garbage, foreign, "not-a-channel"].sort());
    expect(degraded.find((d) => d.channelId === foreign)!.error).toMatch(/does not match this hub and chain/);
    expect(degraded.find((d) => d.channelId === "not-a-channel")!.error).toMatch(/canonical/);
    await expect(restarted.status(garbage)).rejects.toThrow(/could not be loaded/);
  });
});

describe("I1: a corrupt session file", () => {
  it("degrades only that channel: start() resolves and reports it", async () => {
    const { alice, id } = await matched();
    await alice.daemon.stop();
    writeFileSync(arenaPaths(alice.home).channelSession(id), "{ not json");
    const restarted = new ArenaDaemon({ home: alice.home, config: loadConfig(alice.home), walletKey: alice.walletKey, lobby: alice.client.lobby, relay: alice.client.relay });
    cleanups.push(() => restarted.stop());
    await expect(restarted.start()).resolves.toBeUndefined();
    expect(restarted.channelIds()).toEqual([]);
    expect(await restarted.channels()).toEqual([{ channelId: id, degraded: true, error: expect.any(String) }]);
  });
});

describe("I2: stalled and withheld states escalate instead of looping", () => {
  it("P1 regression: an opponent Close signature on a non-terminal state is refused and wait() does not hot-loop", async () => {
    const { alice, bob, id, env } = await matched();
    await alice.daemon.move(id, "e4", { actor: "agent" }); // now Bob's turn; Bob stalls
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    const s = bob.daemon.handle(id).session.latest.state;
    const sig = await signClose(bob.daemon.handle(id).record.sessionKey, s, env.domain);
    await bob.client.relay.send({ type: "close", channelId: id, close: { stateHash: hashState(s, env.domain), by: 1, sig } });
    await waitFor(() => /not a finished game/.test(alice.daemon.handle(id).lastError ?? ""), 5_000, "close refused");
    const st = await alice.daemon.status(id);
    expect(st.opponentWantsToClose).toBe(false);
    expect(st.attention).toBeNull();
    for (let i = 0; i < 2; i++) {
      const t0 = Date.now();
      await expect(alice.daemon.wait({ timeoutMs: 300 })).resolves.toEqual({ channelId: null, reason: "timeout" });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    }
  });

  it("wait() returns opponent-silent once the opponent is silent on their move for more than challengeTimeout", async () => {
    const { alice, bob, id } = await matched();
    await alice.daemon.move(id, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    await bob.daemon.stop();
    bob.client.disconnect();
    await alice.daemon.status(id); // the move is observed as progress, on chain time
    expect(alice.daemon.handle(id).lastProgressAt).not.toBeNull();
    await expect(alice.daemon.wait({ timeoutMs: 300 })).resolves.toEqual({ channelId: null, reason: "timeout" });
    await increaseTime(601); // challengeTimeout is 600 s
    await expect(alice.daemon.wait({ timeoutMs: 10_000 })).resolves.toEqual({ channelId: id, reason: "opponent-silent" });
    const st = await alice.daemon.status(id);
    expect(st.attention).toBe("opponent-silent");
    expect(st.suggestedActions[0]).toMatch(/^arena challenge/);
    // Following the suggestion ends the silence alarm: the channel is now Challenged and Bob must answer on-chain.
    await alice.daemon.challenge(id, "agent");
    const after = await alice.daemon.status(id);
    expect(after.phase).toBe("Challenged");
    expect(after.attention).toBeNull();
  });
});

describe("final review C1: the session key's dispute gas is refilled while the channel is Open or Challenged", () => {
  const ANVIL_DEFAULT_BALANCE = 10n ** 22n; // Anvil's 10000 ETH per default account, restored after each test
  const balanceOf = (d: ArenaDaemon, a: Hex) => d.client.getBalance({ address: a });

  it("the main pass refills a drained session key back to sessionGasWei, and leaves one above the floor alone", async () => {
    const { alice, id, config } = await matched();
    const d = alice.daemon;
    const session = d.handle(id).sessionSender.address;
    const target = config.sessionGasWei;
    expect(await balanceOf(d, session)).toBe(target); // topped up at funding
    // An opponent's forced responds drained it below the floor (half of sessionGasWei).
    await setEthBalance(session, target / 10n);
    await waitFor(async () => (await balanceOf(d, session)) === target, 10_000, "refill"); // before: never refilled
    await d.idle(); // the refill's receipt wait may still be finishing
    expect(d.handle(id).refills).toBe(1);
    // Above the floor: not refilled (one top-up per drain, not per spend).
    await setEthBalance(session, target / 2n + 1n);
    await d.idle();
    await d.tick();
    await d.tick();
    expect(await balanceOf(d, session)).toBe(target / 2n + 1n);
    expect(d.handle(id).refills).toBe(1);
  });

  it("a Challenged channel is refilled by the dispute pass alone, and concurrent passes never refill twice", async () => {
    const { alice, bob, id, config } = await matched();
    const d = alice.daemon;
    await d.move(id, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.latest.state.turnNum === 1n, 5_000, "bob has e4");
    await bob.daemon.challenge(id, "agent"); // Bob challenges at turn 1: Bob is on move, Alice has nothing to answer
    await waitFor(async () => (await d.hub.channelInfo(id)).phase === "Challenged", 5_000, "Challenged");
    const session = d.handle(id).sessionSender.address;
    const target = config.sessionGasWei;
    // Only the dispute pass runs: the main pass is switched off for this part.
    const mainPass = d.mainPass.bind(d);
    (d as unknown as { mainPass: () => Promise<void> }).mainPass = async () => undefined;
    try {
      await setEthBalance(session, target / 10n);
      await waitFor(async () => (await balanceOf(d, session)) === target, 10_000, "dispute-pass refill");
      await d.idle();
      expect(d.handle(id).refills).toBe(1);
    } finally {
      (d as unknown as { mainPass: () => Promise<void> }).mainPass = mainPass;
    }
    // Both passes at once on a drained key (plus the timer's own): one refill, to exactly the target.
    await setEthBalance(session, target / 10n);
    const refills = d.handle(id).refills;
    await Promise.all([d.disputePass(), d.mainPass(), d.disputePass()]);
    await waitFor(async () => (await balanceOf(d, session)) >= target, 10_000, "refill");
    await d.idle();
    expect(await balanceOf(d, session)).toBe(target);
    expect(d.handle(id).refills).toBe(refills + 1);
  });

  it("session-gas-low: raised when the wallet cannot refill, wakes wait() once, and clears once the wallet is funded", async () => {
    const { alice, bob, id, config } = await matched();
    const d = alice.daemon;
    await d.move(id, "e4", { actor: "agent" }); // Bob's turn: Alice's channel needs nothing else from her
    await waitFor(() => bob.daemon.handle(id).session.latest.state.turnNum === 1n, 5_000, "bob has e4");
    const session = d.handle(id).sessionSender.address;
    const target = config.sessionGasWei;
    try {
      await setEthBalance(alice.address, 1_000n); // the wallet cannot pay for a refill
      await setEthBalance(session, target / 10n);
      const st = await waitFor(async () => {
        const s = await d.status(id);
        return s.attention === "session-gas-low" ? s : null;
      }, 10_000, "session-gas-low");
      expect(st.suggestedActions[0]).toMatch(new RegExp(`^fund your wallet: dispute gas for channel ${id} is low`));
      // wait() wakes for it once; while it lasts, later waits fall back to the channel's other attention (none here).
      await expect(d.wait({ timeoutMs: 5_000 })).resolves.toEqual({ channelId: id, reason: "session-gas-low" });
      await expect(d.wait({ timeoutMs: 300 })).resolves.toEqual({ channelId: null, reason: "timeout" });
      expect((await d.status(id)).attention).toBe("session-gas-low"); // still shown in status
      // Funded again: the next pass refills and the attention clears.
      await setEthBalance(alice.address, ANVIL_DEFAULT_BALANCE);
      await waitFor(async () => (await balanceOf(d, session)) === target, 10_000, "refill");
      await waitFor(async () => (await d.status(id)).attention === null, 10_000, "attention cleared");
    } finally {
      await setEthBalance(alice.address, ANVIL_DEFAULT_BALANCE);
    }
  });
});

describe("final review I4: a daemon never offers, accepts or funds a challengeTimeout under minChallengeTimeout", () => {
  it("defaults to 900 s: createOffer and acceptOffer refuse 600 s with 400", async () => {
    // Alice uses the suite's 60 s floor; Bob has no minChallengeTimeout in his config, so he gets the default.
    const pair = await startPair({ bobConfig: { minChallengeTimeout: undefined } });
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const refused = (p: Promise<unknown>) =>
      p.then(
        () => {
          throw new Error("expected a refusal");
        },
        (e: unknown) => e as DaemonError,
      );
    const own = await refused(bob.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n }));
    expect(own).toBeInstanceOf(DaemonError);
    expect(own.code).toBe(400);
    expect(own.message).toMatch(/challengeTimeout 600s is below this daemon's minimum of 900s/);
    // A hostile (short) offer from someone else is refused too, before anything is signed or recorded.
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    const accepted = await refused(bob.daemon.acceptOffer(offerId));
    expect(accepted.code).toBe(400);
    expect(accepted.message).toMatch(/below this daemon's minimum of 900s/);
    expect(bob.client.watched()).not.toContain(offerId);
    // At the floor it is fine.
    await expect(bob.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 900n })).resolves.toHaveProperty("offerId");
  });

  it("Plan 5 Task 1: omitting challengeTimeout defaults it to this daemon's minChallengeTimeout, and the daemon accepts its own default offer", async () => {
    const pair = await startPair({ aliceConfig: { minChallengeTimeout: 1800n }, bobConfig: { minChallengeTimeout: 1800n } });
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n });
    const listed = await bob.daemon.listOffers();
    expect(listed.find((o) => o.offerId === offerId)!.offer.challengeTimeout).toBe(1800n);
    await expect(bob.daemon.acceptOffer(offerId)).resolves.toBeUndefined();
  });

  it("ignores a match whose challengeTimeout is under the floor (the floor was raised after the offer was accepted)", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const logs: string[] = [];
    const bobInternals = bob.daemon as unknown as { opts: { config: { minChallengeTimeout?: bigint }; log?: (l: string) => void } };
    bobInternals.opts.log = (l) => logs.push(l);
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    // The in-memory host delivers the match on a later macrotask: raise Bob's floor before it arrives.
    bobInternals.opts.config.minChallengeTimeout = 900n;
    await waitFor(() => alice.daemon.channelIds().length === 1, 20_000, "alice's channel");
    await waitFor(() => logs.some((l) => /challengeTimeout 600s is below this daemon's minChallengeTimeout \(900s\)/.test(l)), 5_000, "bob's refusal");
    expect(bob.daemon.channelIds()).toEqual([]);
  });
});

describe("I4: never-fundable offers and never-funded channels", () => {
  it("createOffer rejects offers the hub could never fund with 400", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const d = pair.alice.daemon;
    const bad = [
      { deposit: 1_000_000n, stakePerGame: 0n, challengeTimeout: 600n, why: /stakePerGame must be greater than 0/ },
      { deposit: 99_999n, stakePerGame: 100_000n, challengeTimeout: 600n, why: /deposit must be at least stakePerGame/ },
      { deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 59n, why: /challengeTimeout must be between 60 and 604800/ },
      { deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 604_801n, why: /challengeTimeout must be between 60 and 604800/ },
    ];
    for (const { why, ...o } of bad) {
      const err = await d.createOffer(o).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DaemonError);
      expect((err as DaemonError).code).toBe(400);
      expect((err as DaemonError).message).toMatch(why);
    }
    expect(await pair.alice.client.lobby.listOffers()).toEqual([]); // nothing was posted
    // The bounds themselves are fine, and so is deposit == stake.
    await expect(d.createOffer({ deposit: 100_000n, stakePerGame: 100_000n, challengeTimeout: 60n })).resolves.toHaveProperty("offerId");
    await expect(d.createOffer({ deposit: 100_000n, stakePerGame: 100_000n, challengeTimeout: 604_800n })).resolves.toHaveProperty("offerId");
  });

  it("retires a matched channel whose funding window passes with nobody funded (phase None)", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    const so = (await alice.client.lobby.listOffers()).find((o) => computeOfferId(o.offer) === offerId)!;
    // Bob holds an acceptance and receives a match that Alice never hears about, so the offerer never funds.
    const sessionKey = generatePrivateKey();
    internals(bob.daemon).records.saveOffer({ offerId, offer: so.offer, sessionKey, role: "accepter" });
    const terms = { rules: pair.env.rules, feeRecipient: pair.env.host, feePerPlayer: 5_000n, fundingWindow: 3600n };
    const acceptance = { offerId, player: bob.address, signer: privateKeyToAccount(sessionKey).address, nonce: randomNonce() };
    await internals(bob.daemon).onMatch({ offerId, params: buildParams(so.offer, acceptance, terms, await now()) });
    const [id] = bob.daemon.channelIds();
    expect(id).toBeDefined();
    expect((await bob.daemon.hub.channelInfo(id)).phase).toBe("None");
    expect(bob.daemon.handle(id).record.finalized).toBe(false);
    expect((await bob.daemon.status()).channelId).toBe(id); // still the one active channel

    await increaseTime(3601);
    await waitFor(() => bob.daemon.handle(id).record.finalized, 10_000, "retired");
    expect((await bob.daemon.hub.channelInfo(id)).phase).toBe("None");
    expect(new RecordStore(bob.home).channel(id)!.finalized).toBe(true); // persisted
    // It has left the active set, and is no longer polled.
    await expect(bob.daemon.status()).rejects.toThrow(/no active channel/);
    const st = await bob.daemon.status(id);
    expect(st.suggestedActions[0]).toMatch(/^done: the funding window closed/);
    await bob.daemon.idle();
    const passes = [bob.daemon.handle(id).disputePasses, bob.daemon.handle(id).mainPasses];
    await bob.daemon.tick();
    expect([bob.daemon.handle(id).disputePasses, bob.daemon.handle(id).mainPasses]).toEqual(passes);
  });
});

describe("Task 2: off-chain mirrors of the hub's launch limits (spec §13)", () => {
  it("createOffer rejects a deposit over the hub's per-player cap before posting anything", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    await setLimits(pair.env.hub, 500_000n, 10n ** 12n);
    const err = await pair.alice.daemon
      .createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect((err as DaemonError).code).toBe(400);
    expect((err as DaemonError).message).toBe("deposit exceeds the hub's per-player cap of 500000 base units");
    expect(await pair.alice.client.lobby.listOffers()).toEqual([]); // nothing was posted
  });

  it("acceptOffer rejects an over-cap offer without creating a record or signing anything", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await setLimits(pair.env.hub, 500_000n, 10n ** 12n);
    const err = await bob.daemon.acceptOffer(offerId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect((err as DaemonError).code).toBe(400);
    expect((err as DaemonError).message).toBe("deposit exceeds the hub's per-player cap of 500000 base units");
    expect(new RecordStore(bob.home).offer(offerId)).toBeNull();
    expect(bob.daemon.channelIds()).toEqual([]);
  });

  it("final review I1/m9: createOffer and acceptOffer mirror the escrow cap: committedEscrow + 2*(deposit + fee) <= maxCommittedEscrow", async () => {
    const { alice, bob, env } = await matched(); // one open channel: committedEscrow = 2 * (1_000_000 + 5_000)
    const committed = (await alice.daemon.hub.limits()).committedEscrow;
    expect(committed).toBe(2_010_000n);
    const offer = { deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n };
    // One base unit short of room for another such channel: both sides refuse, before anything is posted or signed.
    await setLimits(env.hub, 10_000_000n, committed + 2_010_000n - 1n);
    const own = (await alice.daemon.createOffer(offer).catch((e: unknown) => e)) as DaemonError;
    expect(own).toBeInstanceOf(DaemonError);
    expect(own.code).toBe(409);
    expect(own.message).toMatch(/escrow cap/);
    // Bob posts his offer while there is room; the cap is lowered again before Alice accepts it.
    await setLimits(env.hub, 10_000_000n, 10n ** 12n);
    const { offerId } = await bob.daemon.createOffer(offer);
    await setLimits(env.hub, 10_000_000n, committed + 2_010_000n - 1n);
    const acc = (await alice.daemon.acceptOffer(offerId).catch((e: unknown) => e)) as DaemonError;
    expect(acc).toBeInstanceOf(DaemonError);
    expect(acc.code).toBe(409);
    expect(acc.message).toMatch(/escrow cap/);
    expect(new RecordStore(alice.home).offer(offerId)).toBeNull();
    // Exactly enough room: accepted.
    await setLimits(env.hub, 10_000_000n, committed + 2_010_000n);
    await expect(alice.daemon.acceptOffer(offerId)).resolves.toBeUndefined();
  });

  it("createOffer rejects while the hub is paused, with a clear cause", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    await setPaused(pair.env.hub, true);
    const err = await pair.alice.daemon
      .createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect((err as DaemonError).code).toBe(409);
    expect((err as DaemonError).message).toBe("the hub is paused: no new channels");
  });

  it("acceptOffer rejects while the hub is paused", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await setPaused(pair.env.hub, true);
    const err = await bob.daemon.acceptOffer(offerId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect((err as DaemonError).code).toBe(409);
    expect((err as DaemonError).message).toBe("the hub is paused: no new channels");
  });

  it("onMatch ignores a match the hub would now reject (paused after the match was posted) and logs it", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    const so = (await alice.client.lobby.listOffers()).find((o) => computeOfferId(o.offer) === offerId)!;
    const sessionKey = generatePrivateKey();
    internals(bob.daemon).records.saveOffer({ offerId, offer: so.offer, sessionKey, role: "accepter" });
    const terms = { rules: pair.env.rules, feeRecipient: pair.env.host, feePerPlayer: 5_000n, fundingWindow: 3600n };
    const acceptance = { offerId, player: bob.address, signer: privateKeyToAccount(sessionKey).address, nonce: randomNonce() };
    await setPaused(pair.env.hub, true);
    await internals(bob.daemon).onMatch({ offerId, params: buildParams(so.offer, acceptance, terms, await now()) });
    expect(bob.daemon.channelIds()).toEqual([]);
  });

  it(
    "a funding revert while paused sets a clear lastError and backs off for 30s; funding completes once unpaused",
    async () => {
      const pair = await startPair();
      cleanups.push(pair.cleanup);
      const { alice, bob } = pair;
      // Deterministic (Task 10 re-review): Alice's funding is held until the pause has landed. Without the gate,
      // her match-triggered tick could deposit before setPaused was mined, and the test flaked.
      const d = alice.daemon as unknown as { fund(l: unknown): Promise<void> };
      const realFund = d.fund.bind(alice.daemon);
      let openGate: () => void = () => undefined;
      const gate = new Promise<void>((r) => (openGate = r));
      d.fund = async (l) => {
        await gate;
        return realFund(l);
      };
      const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
      await bob.daemon.acceptOffer(offerId);
      const id = await waitFor(async () => {
        const [a, b] = [alice.daemon.channelIds(), bob.daemon.channelIds()];
        return a.length === 1 && b.length === 1 && a[0] === b[0] ? a[0] : null;
      }, 20_000, "match");

      await setPaused(pair.env.hub, true);
      openGate();
      await waitFor(async () => {
        await alice.daemon.idle();
        await alice.daemon.tick();
        return /^funding: Paused$/.test(alice.daemon.handle(id).lastError ?? "");
      }, 5_000, "paused funding error");
      expect(alice.daemon.handle(id).fundBlockedUntil).not.toBeNull();
      expect((await alice.daemon.hub.channelInfo(id)).funded[0]).toBe(false);

      // Unpausing alone must not trigger an immediate retry: the back-off (>= 30s of chain time) still applies,
      // so the watchtower does not hot-loop a revert it already saw.
      await setPaused(pair.env.hub, false);
      await alice.daemon.idle();
      await alice.daemon.tick();
      expect((await alice.daemon.hub.channelInfo(id)).funded[0]).toBe(false);

      await increaseTime(31);
      await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).funded[0], 20_000, "alice funded once the back-off expires");
      await bob.daemon.idle();
      await bob.daemon.tick();
      await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Open", 20_000, "open");
      expect(alice.daemon.handle(id).lastError).toBeNull();
      expect(alice.daemon.handle(id).fundBlockedUntil).toBeNull();
    },
  );

  it("status suggests waiting for the hub's pause when a channel is funding-blocked by it", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(async () => {
      const [a, b] = [alice.daemon.channelIds(), bob.daemon.channelIds()];
      return a.length === 1 && b.length === 1 && a[0] === b[0] ? a[0] : null;
    }, 20_000, "match");
    await setPaused(pair.env.hub, true);
    await waitFor(async () => {
      await alice.daemon.idle();
      await alice.daemon.tick();
      return /^funding: Paused$/.test(alice.daemon.handle(id).lastError ?? "");
    }, 5_000, "paused funding error");
    const st = await alice.daemon.status(id);
    expect(st.suggestedActions).toContainEqual(
      "wait: the hub is paused; funding resumes automatically when it is unpaused (or reclaim after the funding deadline)",
    );
  });
});

describe("minor fixes", () => {
  it("M-c: a restart after receiving a mating move, but before auto-resigning, resigns from the Open-phase tick", async () => {
    const { alice, bob, id, env } = await matched();
    for (const m of SCHOLARS_MATE.slice(0, -1)) {
      const [mover, other] = alice.daemon.handle(id).session.isMyTurn() ? [alice, bob] : [bob, alice];
      await mover.daemon.move(id, m, { actor: "agent" });
      const turn = mover.daemon.handle(id).session.latest.state.turnNum;
      await waitFor(() => other.daemon.handle(id).session.latest.state.turnNum === turn, 5_000, `relay ${m}`);
    }
    // Bob "crashes": his daemon stops, then the mating move reaches (and is persisted by) his session alone.
    await bob.daemon.stop();
    await alice.daemon.move(id, SCHOLARS_MATE.at(-1)!, { actor: "agent" });
    const record = new RecordStore(bob.home).channel(id)!;
    const session = await ChannelSession.open({
      params: record.params,
      me: record.me,
      sessionKey: record.sessionKey,
      domain: env.domain,
      store: new FileSessionStore(arenaPaths(bob.home).channelSession(id)),
    });
    expect(await session.receive(alice.daemon.handle(id).session.latest)).toBe("move");
    expect(session.isMyTurn()).toBe(true); // mated, and not yet resigned

    const restarted = new ArenaDaemon({ home: bob.home, config: loadConfig(bob.home), walletKey: bob.walletKey, lobby: bob.client.lobby, relay: bob.client.relay });
    cleanups.push(() => restarted.stop());
    await restarted.start();
    await waitFor(async () => (await alice.daemon.status(id)).gameStatus === "white_won", 10_000, "auto-resign reaches alice");
    expect(restarted.handle(id).session.isMyTurn()).toBe(false);
    expect((await restarted.status(id)).gameStatus).toBe("white_won");
  });

  it("M-d: acceptOffer is idempotent — a retry re-sends the same signed acceptance and never generates a new key", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    // Bob's first attempt is lost in transit (the host never sees it); later attempts go through.
    const lobby = bob.client.lobby;
    const original = lobby.accept.bind(lobby);
    const sent: SignedAcceptance[] = [];
    let attempts = 0;
    lobby.accept = async (sa) => {
      attempts++;
      sent.push(structuredClone(sa));
      if (attempts === 1) throw new Error("network down");
      return original(sa);
    };
    await expect(bob.daemon.acceptOffer(offerId)).rejects.toThrow(/network down/);
    const keyAfterFirst = new RecordStore(bob.home).offer(offerId)!.sessionKey;
    await bob.daemon.acceptOffer(offerId.toUpperCase().replace("0X", "0x") as Hex); // any hex case is the same offer
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]); // same acceptance, same signature
    const id = await waitFor(async () => {
      const [a, b] = [alice.daemon.channelIds(), bob.daemon.channelIds()];
      return a.length === 1 && b.length === 1 && a[0] === b[0] ? a[0] : null;
    }, 20_000, "match");
    expect(bob.daemon.handle(id).record.sessionKey).toBe(keyAfterFirst);
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Open", 20_000, "funding");
    // Once matched, accepting again is refused outright.
    const again = await bob.daemon.acceptOffer(offerId).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(DaemonError);
    expect((again as DaemonError).code).toBe(409);
    expect((again as DaemonError).message).toMatch(/already accepted/);
    expect(sent).toHaveLength(2);
    await expect(bob.daemon.acceptOffer("./0x1234" as Hex)).rejects.toThrow(/offerId must be/);
  });

  it("concurrent acceptOffer calls for one offer create exactly one acceptance (M-carry)", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    const results = await Promise.allSettled([pair.bob.daemon.acceptOffer(offerId), pair.bob.daemon.acceptOffer(offerId)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/already being accepted|already accepted/);
  });

  it("scans dispute events in chunks from a persisted cursor and survives a getLogs failure (I3)", async () => {
    // Both periodic timers are parked (see the "calls timeout" test above for the same reasoning): the stub
    // below fails hub.disputeEvents exactly once, for whichever caller happens to invoke it first. With a live
    // periodic tick still running, that could be a background pass rather than the explicit one this test
    // drives, and the assertion right after it would then flake against a scan that already recovered.
    const pair = await startPair({ pollMs: 3_600_000, bobConfig: { logChunkBlocks: 2 } });
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    await alice.daemon.idle();
    await alice.daemon.tick(); // alice (offerer) deposits
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).funded[0], 20_000, "alice funded");
    await bob.daemon.idle();
    await bob.daemon.tick(); // bob (accepter) deposits now that funded[0] is true
    await waitFor(async () => (await alice.daemon.status(id)).phase === "Open", 30_000, "open");
    bob.client.disconnect(); // Bob never sees e4 over the relay; only through the Challenged event
    await alice.daemon.move(id, "e4", { actor: "agent" });
    await alice.daemon.challenge(id, "agent");
    // A getLogs failure must not stop the rest of the watchtower pass.
    const hub = bob.daemon.hub;
    const real = hub.disputeEvents.bind(hub);
    let failures = 1;
    hub.disputeEvents = (...a: Parameters<typeof real>) => (failures-- > 0 ? Promise.reject(new Error("range too large")) : real(...a));
    await bob.daemon.idle();
    await bob.daemon.tick();
    expect(bob.daemon.handle(id).lastError).toMatch(/^events:/);
    await waitFor(async () => { await bob.daemon.idle(); await bob.daemon.tick(); return bob.daemon.handle(id).session.isMyTurn(); }, 20_000, "ingested e4 from chain");
    const rec = bob.daemon.handle(id).record;
    expect(rec.scannedBlock).toBeDefined();
    expect(rec.scannedBlock! >= rec.createdBlock).toBe(true);
  });

  it("re-reads the trailing rescan window: an event a laggy getLogs hid on one scan is still ingested later", async () => {
    // Both periodic timers are parked, for the same reason as the getLogs-failure test above: the stub below
    // must be consumed by the explicit tick this test drives, not by a background pass racing ahead of it.
    const pair = await startPair({ pollMs: 3_600_000 });
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    await alice.daemon.idle();
    await alice.daemon.tick(); // alice (offerer) deposits
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).funded[0], 20_000, "alice funded");
    await bob.daemon.idle();
    await bob.daemon.tick(); // bob (accepter) deposits now that funded[0] is true
    await waitFor(async () => (await alice.daemon.status(id)).phase === "Open", 30_000, "open");
    bob.client.disconnect(); // Bob never sees e4 over the relay; only through the Challenged event
    await alice.daemon.move(id, "e4", { actor: "agent" });
    await alice.daemon.challenge(id, "agent");
    // Simulates a load-balanced RPC whose blockNumber() outran its own getLogs index: the very first call to
    // disputeEvents (whatever range it's asked for) comes back empty, hiding the Challenged event entirely --
    // yet the scan still reports a fully-scanned head, since it saw no failure.
    const hub = bob.daemon.hub;
    const real = hub.disputeEvents.bind(hub);
    let hideOnce = true;
    hub.disputeEvents = (...a: Parameters<typeof real>) => {
      if (hideOnce) {
        hideOnce = false;
        return Promise.resolve([]);
      }
      return real(...a);
    };
    await bob.daemon.idle();
    await bob.daemon.tick(); // the event is hidden; no failure is recorded, and the scan "completes" past it
    expect(bob.daemon.handle(id).lastError).toBeNull();
    expect(bob.daemon.handle(id).session.isMyTurn()).toBe(false); // still unaware of e4
    // Without the rescan window, the next scan would start strictly after the (falsely) fully-scanned head and
    // would never see that block's event again. With it, the trailing DISPUTE_RESCAN_BLOCKS are re-read on the
    // very next tick, and the real disputeEvents (hideOnce is now false) returns the event this time.
    await waitFor(async () => { await bob.daemon.idle(); await bob.daemon.tick(); return bob.daemon.handle(id).session.isMyTurn(); }, 20_000, "ingested e4 on rescan");
  });
});

describe("Plan 4.5 Task 10: reorg resilience", () => {
  it("re-approves USDC when the allowance is gone (an approve dropped by a reorg, or revoked) instead of remembering it", async () => {
    const { alice, bob, env } = await matched(); // alice's daemon approved the hub while funding channel 1
    // The approve is gone, as after a reorg deeper than the deposit (the system chaos test drops it with anvil_reorg).
    const aliceWallet = new LocalKeyTxSender(alice.walletKey, RPC, CHAIN);
    await alice.daemon.hub.approve(aliceWallet, env.usdc, 0n);
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const second = await waitFor(
      () => alice.daemon.channelIds().find((c) => alice.daemon.handle(c).record.offerId === offerId) ?? null,
      20_000,
      "second match",
    );
    // Before the fix, alice's in-memory "approved" flag skipped the approve and her deposit reverted on every tick.
    await waitFor(async () => (await alice.daemon.hub.channelInfo(second)).phase === "Open", 20_000, "second channel funded");
    expect(alice.daemon.handle(second).lastError).toBeNull();
  });
});

describe("Plan 4.5 Task 10: transient RPC failures", () => {
  it("a watchtower pass that fails on an RPC error sets a watch: lastError, and the next good pass clears it", async () => {
    const { alice, id } = await matched();
    const hub = alice.daemon.hub;
    const real = hub.channelInfo.bind(hub);
    // The RPC is down for 600 ms: every pass in that window fails (both the dispute and the main pass read it).
    let failures = 0;
    const downUntil = Date.now() + 600;
    hub.channelInfo = async (c) => {
      if (Date.now() < downUntil) {
        failures++;
        throw new Error("HTTP request failed.");
      }
      return real(c);
    };
    // The failing passes record it ("watch: …" after the fix)...
    await waitFor(() => /HTTP request failed/.test(alice.daemon.handle(id).lastError ?? ""), 5_000, "the failed pass");
    expect(failures).toBeGreaterThan(0);
    // ...and the next good pass clears it. Before the fix it stayed until a relay message happened to arrive.
    await waitFor(() => alice.daemon.handle(id).lastError === null, 5_000, "a good pass to clear it");
    expect(alice.daemon.handle(id).mainPasses).toBeGreaterThan(1);
  });
});

describe("Plan 4.5 Task 10: a move is not failed by an RPC error after it was sent", () => {
  it("move() resolves when the follow-up challenge check cannot reach the chain; the peer still gets the move", async () => {
    const { alice, bob, id } = await matched();
    const hub = alice.daemon.hub;
    const real = hub.channelInfo.bind(hub);
    let fail = false;
    hub.channelInfo = async (c) => {
      if (fail) throw new Error("HTTP request failed.");
      return real(c);
    };
    fail = true; // every chain read of alice's daemon fails for the length of the move call
    try {
      // Before the fix this rejected, although the move had been signed, persisted and relayed.
      await alice.daemon.move(id, "e4", { actor: "agent" });
    } finally {
      fail = false;
    }
    expect(alice.daemon.handle(id).session.latest.state.turnNum).toBe(1n);
    await waitFor(() => bob.daemon.handle(id).session.latest.state.turnNum === 1n, 5_000, "bob holds turn 1");
  });
});

describe("Plan 4.5 Task 10: the watchtower retries a failed cooperative close", () => {
  it("both sides' close submissions fail on an RPC error; the next watchtower pass submits it and clears close:", async () => {
    const { alice, bob, id } = await matched();
    for (const m of SCHOLARS_MATE) {
      const [mover, other] = alice.daemon.handle(id).session.isMyTurn() ? [alice, bob] : [bob, alice];
      await mover.daemon.move(id, m, { actor: "agent" });
      const turn = mover.daemon.handle(id).session.latest.state.turnNum;
      await waitFor(() => other.daemon.handle(id).session.latest.state.turnNum >= turn, 5_000, `relay ${m}`);
    }
    await waitFor(() => alice.daemon.handle(id).session.latest.state.turnNum === 8n, 5_000, "bob's auto-resign");
    // The first submission on each side fails in transport (an RPC blip), after both Close signatures exist.
    const failures: string[] = [];
    for (const p of [alice, bob]) {
      const hub = p.daemon.hub;
      const real = hub.closeCooperative.bind(hub);
      let failed = false;
      hub.closeCooperative = async (sender, tx) => {
        if (!failed) {
          failed = true;
          failures.push(p === alice ? "alice" : "bob");
          throw new Error("HTTP request failed.");
        }
        return real(sender, tx);
      };
    }
    await alice.daemon.close(id, "agent"); // alice alone: nothing to submit yet
    await waitFor(() => bob.daemon.handle(id).session.snapshot().closeSigs[0] !== "0x", 5_000, "alice's Close reaches bob");
    await expect(bob.daemon.close(id, "agent")).rejects.toThrow(/HTTP request failed/);
    await waitFor(() => failures.length === 2, 5_000, "alice's relay-path submission to fail too");
    // Before the fix nothing retried: the channel stayed Open with a fully co-signed close.
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Finalized", 10_000, "the watchtower's retry");
    await waitFor(() => alice.daemon.handle(id).lastError === null && bob.daemon.handle(id).lastError === null, 5_000, "close: cleared");
  });
});

describe("Plan 4.5 Task 10: a match whose handling fails on an RPC error is retried", () => {
  it("the offerer's first read at match time fails; the next tick handles the match and the channel opens", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const hub = alice.daemon.hub;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    // Installed after createOffer (which reads the fee itself for the escrow-cap check): the read that fails is the
    // one at match time.
    const real = hub.feeConfig.bind(hub);
    let failed = false;
    hub.feeConfig = async () => {
      if (!failed) {
        failed = true;
        throw new Error("HTTP request failed.");
      }
      return real();
    };
    await bob.daemon.acceptOffer(offerId);
    // Before the fix the host's one match event was lost to the failed read: alice never opened (or funded) it.
    const id = await waitFor(() => alice.daemon.channelIds()[0] ?? null, 10_000, "alice handles the match");
    expect(failed).toBe(true);
    await waitFor(async () => (await hub.channelInfo(id)).phase === "Open", 20_000, "funded and open");
  });
});

describe("Plan 4.5 Task 10: a settled channel keeps no transient error", () => {
  it("the pass that sees Finalized, then fails its last read, leaves lastError null (the channel is never watched again)", async () => {
    // Manual ticks only (a long pollMs), so each pass below is exactly the one the test stages.
    const pair = await startPair({ pollMs: 3_600_000 });
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0] ?? null, 10_000, "match");
    await waitFor(async () => {
      for (const p of [alice, bob]) {
        await p.daemon.idle();
        await p.daemon.tick();
      }
      return (await alice.daemon.hub.channelInfo(id)).phase === "Open";
    }, 20_000, "funding by manual ticks");
    // Inside one pass: an earlier failure is on record, the step-4 read sees Finalized, then refreshChain's read
    // fails. (The phase is faked: this is the daemon's bookkeeping, not the hub's.)
    const hub = alice.daemon.hub;
    const real = hub.channelInfo.bind(hub);
    let call = 0;
    hub.channelInfo = async (c) => {
      call++;
      if (call === 1) return real(c); // the pass's first read
      if (call === 2) return { ...(await real(c)), phase: "Finalized" }; // step 4: settled
      throw new Error("HTTP request failed."); // refreshChain
    };
    alice.daemon.handle(id).lastError = "watch: HTTP request failed."; // from an earlier failed pass
    await alice.daemon.idle();
    await alice.daemon.mainPass(); // the main pass alone (the dispute pass would take the first read)
    expect(call).toBe(3);
    expect(alice.daemon.handle(id).record.finalized).toBe(true);
    // Before the fix: "watch: HTTP request failed." for good.
    expect(alice.daemon.handle(id).lastError).toBeNull();
  });
});

describe("Plan 4.5 Task 10: a close that went through is not reported as failed", () => {
  it("the close transaction lands but the RPC fails before its receipt: close() resolves and leaves no close: error", async () => {
    const { alice, bob, id } = await matched();
    for (const m of SCHOLARS_MATE) {
      const [mover, other] = alice.daemon.handle(id).session.isMyTurn() ? [alice, bob] : [bob, alice];
      await mover.daemon.move(id, m, { actor: "agent" });
      const turn = mover.daemon.handle(id).session.latest.state.turnNum;
      await waitFor(() => other.daemon.handle(id).session.latest.state.turnNum >= turn, 5_000, `relay ${m}`);
    }
    await waitFor(() => alice.daemon.handle(id).session.latest.state.turnNum === 8n, 5_000, "bob's auto-resign");
    for (const p of [alice, bob]) {
      const hub = p.daemon.hub;
      const real = hub.closeCooperative.bind(hub);
      hub.closeCooperative = async (sender, tx) => {
        const receipt = await real(sender, tx); // mined...
        // ...but the RPC fails before this daemon hears so, after its watchtower has already seen Finalized.
        await waitFor(() => p.daemon.handle(id).record.finalized, 5_000, "the watchtower marks it settled");
        throw new Error(`HTTP request failed. (${receipt.status})`);
      };
    }
    await alice.daemon.close(id, "agent");
    await waitFor(() => bob.daemon.handle(id).session.snapshot().closeSigs[0] !== "0x", 5_000, "alice's Close reaches bob");
    // Before the fix this rejected with the transport error and left "close: HTTP request failed." for good.
    await bob.daemon.close(id, "agent");
    expect((await bob.daemon.hub.channelInfo(id)).phase).toBe("Finalized");
    await waitFor(() => alice.daemon.handle(id).record.finalized, 5_000, "alice settled");
    expect(bob.daemon.handle(id).lastError).toBeNull();
    expect(alice.daemon.handle(id).lastError).toBeNull();
  });
});

describe("Plan 4.5 Task 10 review: dispute work first", () => {
  it("bounds a dispute transaction's receipt wait by min(30 s, a third of the time left), never under 10 s", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const f = (deadline: bigint, now: bigint) =>
      (pair.alice.daemon as unknown as { disputeReceiptTimeoutMs(d: bigint, n: bigint): number }).disputeReceiptTimeoutMs(deadline, now);
    expect(f(1_600n, 1_000n)).toBe(30_000); // 600 s left
    expect(f(1_045n, 1_000n)).toBe(15_000); // 45 s left: a third
    expect(f(1_012n, 1_000n)).toBe(10_000); // 12 s left: the floor
    expect(f(900n, 1_000n)).toBe(10_000); // past the deadline (a timeout transaction)
  });

  it("the respond the dispute pass sends carries that bound", async () => {
    const { alice, bob, id } = await matched(); // challengeTimeout 600: 30 s
    await alice.daemon.move(id, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob's turn");
    const stale = alice.daemon.handle(id).session.challengeProof(); // turn 1
    await bob.daemon.move(id, "e5", { actor: "agent" });
    await waitFor(() => alice.daemon.handle(id).session.latest.state.turnNum === 2n, 5_000, "alice holds turn 2");
    await alice.daemon.stop();
    const seen: Array<number | undefined> = [];
    const hub = bob.daemon.hub;
    const real = hub.respond.bind(hub);
    const giveUps: Array<number | undefined> = [];
    hub.respond = async (sender, proof, opts) => {
      seen.push(opts?.receiptTimeoutMs);
      giveUps.push(opts?.giveUpAt);
      return real(sender, proof, opts);
    };
    await hub.challenge(alice.daemon.handle(id).sessionSender, stale);
    await waitFor(async () => (await hub.channelInfo(id)).phase === "Open", 10_000, "bob responds");
    expect(seen[0]).toBe(30_000);
    // Task 10 re-review (I2): the wait gives up at the deadline (600 s out), never later.
    expect(giveUps[0]).toBeGreaterThan(Date.now() + 590_000);
    expect(giveUps[0]).toBeLessThanOrEqual(Date.now() + 600_000);
  });

  it("a stalled main pass (e.g. a funding or close receipt wait) never delays answering a challenge", async () => {
    const { alice, bob, id } = await matched();
    await alice.daemon.move(id, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob's turn");
    await bob.daemon.move(id, "e5", { actor: "agent" });
    await waitFor(() => alice.daemon.handle(id).session.isMyTurn(), 5_000, "alice's turn");
    const stale = bob.daemon.handle(id).session.challengeProof(); // turn 2
    await alice.daemon.move(id, "Nf3", { actor: "agent" }); // alice now holds turn 3
    await waitFor(() => bob.daemon.handle(id).session.latest.state.turnNum === 3n, 5_000, "bob holds turn 3");
    await bob.daemon.stop(); // only alice's watchtower may answer

    // Alice's main pass hangs from now on, as if stuck in a receipt wait for another channel's transaction.
    let release: () => void = () => undefined;
    const stalled = new Promise<void>((r) => (release = r));
    let mainPassesEntered = 0;
    (alice.daemon as unknown as { watch: () => Promise<boolean> }).watch = async () => {
      mainPassesEntered++;
      await stalled;
      return true;
    };
    try {
      await waitFor(() => mainPassesEntered > 0, 5_000, "the main pass to stall");
      await alice.daemon.hub.challenge(bob.daemon.handle(id).sessionSender, stale);
      // Before the fix the dispute branch ran inside that same stalled pass: the challenge went unanswered.
      await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Open", 10_000, "alice's dispute pass responds");
      expect((await alice.daemon.hub.registeredState(id)).turnNum).toBe(3n);
      expect(mainPassesEntered).toBe(1); // still the same stalled main pass
    } finally {
      release();
    }
  });
});

describe("Plan 4.5 Task 10 review: a retried match opens a recorded channel that is not live", () => {
  it("openChannel fails once after the record is saved; the retry opens it and the channel funds", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const d = alice.daemon as unknown as { openChannel(r: ChannelRecord): Promise<void> };
    const real = d.openChannel.bind(alice.daemon);
    let failed = false;
    d.openChannel = async (r) => {
      if (!failed) {
        failed = true;
        throw new Error("EIO: session store unavailable");
      }
      return real(r);
    };
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    // Before the fix the retry found the record (offer already removed) and ignored the match: never live.
    const id = await waitFor(() => alice.daemon.channelIds()[0] ?? null, 10_000, "alice's channel goes live");
    expect(failed).toBe(true);
    expect(new RecordStore(alice.home).channel(id)?.offerId).toBe(offerId);
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Open", 20_000, "funded and open");
  });
});

describe("Plan 4.5 Task 10 review: the close retry backs off after a revert", () => {
  it("a co-signed close whose submission reverts is retried by the watchtower at most once per 30 s", async () => {
    const { alice, bob, id } = await matched();
    for (const m of SCHOLARS_MATE) {
      const [mover, other] = alice.daemon.handle(id).session.isMyTurn() ? [alice, bob] : [bob, alice];
      await mover.daemon.move(id, m, { actor: "agent" });
      const turn = mover.daemon.handle(id).session.latest.state.turnNum;
      await waitFor(() => other.daemon.handle(id).session.latest.state.turnNum >= turn, 5_000, `relay ${m}`);
    }
    await waitFor(() => alice.daemon.handle(id).session.latest.state.turnNum === 8n, 5_000, "bob's auto-resign");
    const calls = { alice: 0, bob: 0 };
    for (const [name, p] of [["alice", alice], ["bob", bob]] as const) {
      p.daemon.hub.closeCooperative = async () => {
        calls[name]++;
        throw new HubRevertError("BadSignature", new Error("stubbed revert"));
      };
    }
    await alice.daemon.close(id, "agent");
    await waitFor(() => bob.daemon.handle(id).session.snapshot().closeSigs[0] !== "0x", 5_000, "alice's Close reaches bob");
    await expect(bob.daemon.close(id, "agent")).rejects.toThrow(/BadSignature/);
    await new Promise((r) => setTimeout(r, 2_000)); // ~20 watchtower passes at pollMs 100
    // One submission each from the close API / relay path, and no watchtower retry inside the back-off window.
    // Before the fix both watchtowers retried the same revert on every pass.
    expect(calls.alice).toBeLessThanOrEqual(1);
    expect(calls.bob).toBeLessThanOrEqual(1);
    expect(bob.daemon.handle(id).lastError).toMatch(/^close: hub reverted: BadSignature/);
  });
});

describe("Plan 4.5 Task 10 re-review (C1): the timer is armed before the first round", () => {
  it("a daemon restarted while its main pass stalls still answers a challenge that arrives afterwards", async () => {
    const { alice, bob, id } = await matched();
    await alice.daemon.move(id, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob's turn");
    await bob.daemon.move(id, "e5", { actor: "agent" });
    await waitFor(() => alice.daemon.handle(id).session.isMyTurn(), 5_000, "alice's turn");
    const stale = bob.daemon.handle(id).session.challengeProof(); // turn 2
    await alice.daemon.move(id, "Nf3", { actor: "agent" }); // alice holds turn 3
    await waitFor(() => bob.daemon.handle(id).session.latest.state.turnNum === 3n, 5_000, "bob holds turn 3");
    const bobSession = bob.daemon.handle(id).sessionSender;
    await bob.daemon.stop();
    await alice.daemon.stop();

    // Alice restarts, and her main pass stalls from the very first round (as in a receipt wait).
    const restarted = new ArenaDaemon({ home: alice.home, config: loadConfig(alice.home), walletKey: alice.walletKey, lobby: alice.client.lobby, relay: alice.client.relay });
    let release: () => void = () => undefined;
    const stalled = new Promise<void>((r) => (release = r));
    (restarted as unknown as { watch: () => Promise<boolean> }).watch = async () => {
      await stalled;
      return true;
    };
    cleanups.push(async () => {
      release();
      await restarted.stop();
    });
    void restarted.start(); // before the fix this never resolved: it awaited the stalled first round
    await new Promise((r) => setTimeout(r, 500));
    await restarted.hub.challenge(bobSession, stale);
    // Before the fix no timer was armed yet, so no dispute pass ever ran after the challenge.
    await waitFor(async () => (await restarted.hub.channelInfo(id)).phase === "Open", 10_000, "the restarted daemon responds");
    expect((await restarted.hub.registeredState(id)).turnNum).toBe(3n);
  });
});

describe("Plan 4.5 Task 10 re-review (I3): the session-gas top-up is never paid twice", () => {
  it("a top-up reported dropped that had in fact landed is not paid again (the balance is re-read first)", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const wallet = alice.daemon.wallet;
    const real = wallet.send.bind(wallet);
    const topUps: Hex[] = [];
    let sessionAddr: string | undefined;
    wallet.send = async (tx) => {
      if (tx.value === undefined || tx.data !== "0x" || tx.nonce !== undefined) return real(tx);
      sessionAddr = tx.to;
      const hash = await real(tx);
      topUps.push(hash);
      if (topUps.length === 1) {
        await alice.daemon.client.waitForTransactionReceipt({ hash });
        throw new TxDroppedError(hash); // it landed, but was reported dropped
      }
      return hash;
    };
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0] ?? null, 10_000, "match");
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Open", 20_000, "open");
    expect(topUps).toHaveLength(1); // the balance is re-read first: the landed top-up is not paid again
    expect(await alice.daemon.client.getBalance({ address: sessionAddr as Hex })).toBe(pair.config.sessionGasWei);
  });
});

describe("Plan 4.5 Task 10 re-review (I2): challenged channels are handled concurrently", () => {
  it("two channels challenged at once on one daemon: one's respond is stuck, the other is still answered", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const ids: Hex[] = [];
    for (let i = 0; i < 2; i++) {
      const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
      await bob.daemon.acceptOffer(offerId);
      ids.push(
        await waitFor(() => bob.daemon.channelIds().find((c) => !ids.includes(c)) ?? null, 10_000, `match ${i}`),
      );
    }
    for (const id of ids) await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Open", 20_000, "open");
    const stale = new Map<Hex, ReturnType<ChannelSession["challengeProof"]>>();
    for (const id of ids) {
      await alice.daemon.move(id, "e4", { actor: "agent" });
      await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob's turn");
      await bob.daemon.move(id, "e5", { actor: "agent" });
      await waitFor(() => alice.daemon.handle(id).session.isMyTurn(), 5_000, "alice's turn");
      stale.set(id, bob.daemon.handle(id).session.challengeProof()); // turn 2
      await alice.daemon.move(id, "Nf3", { actor: "agent" }); // alice holds turn 3
      await waitFor(() => bob.daemon.handle(id).session.latest.state.turnNum === 3n, 5_000, "bob holds turn 3");
    }
    const senders = ids.map((id) => bob.daemon.handle(id).sessionSender);
    await bob.daemon.stop();

    // Alice's first respond (whichever channel it is for) hangs, as a transaction stuck in the mempool would.
    const hub = alice.daemon.hub;
    const real = hub.respond.bind(hub);
    let release: () => void = () => undefined;
    const stuck = new Promise<void>((r) => (release = r));
    let stuckOn: Hex | undefined;
    hub.respond = async (sender, proof, opts) => {
      if (stuckOn === undefined || stuckOn === proof.latest.state.channelId) {
        stuckOn = proof.latest.state.channelId;
        await stuck;
      }
      return real(sender, proof, opts);
    };
    try {
      await Promise.all(ids.map((id, i) => hub.challenge(senders[i], stale.get(id)!)));
      // Before the fix one dispute pass walked the channels in turn: the stuck respond held the other one back.
      await waitFor(async () => {
        const phases = await Promise.all(ids.map(async (id) => (await hub.channelInfo(id)).phase));
        return phases.filter((p) => p === "Open").length === 1;
      }, 10_000, "the other channel answered while the first respond is stuck");
      expect((await hub.channelInfo(stuckOn!)).phase).toBe("Challenged");
    } finally {
      release();
    }
    for (const id of ids) await waitFor(async () => (await hub.channelInfo(id)).phase === "Open", 20_000, "both answered");
  });
});

describe("Plan 4.5 Task 10 re-review (M3): dispute and main passes are counted apart", () => {
  it("while the main pass stalls, the dispute-pass count keeps rising and the main-pass count does not", async () => {
    const { alice, id } = await matched();
    let release: () => void = () => undefined;
    const stalled = new Promise<void>((r) => (release = r));
    (alice.daemon as unknown as { watch: () => Promise<boolean> }).watch = async () => {
      await stalled;
      return true;
    };
    try {
      await new Promise((r) => setTimeout(r, 300)); // let a main pass enter the stall
      const h = alice.daemon.handle(id);
      const [d0, m0] = [h.disputePasses, h.mainPasses];
      await new Promise((r) => setTimeout(r, 1_000)); // ~10 timer ticks at pollMs 100
      expect(h.disputePasses).toBeGreaterThan(d0 + 3);
      expect(h.mainPasses).toBe(m0); // one pass, still stalled
    } finally {
      release();
    }
  });
});

describe("Plan 4.5 Task 10 re-review (M5): a channel that never opens is degraded, not retried forever", () => {
  it("openChannel fails on every match retry: after MAX_OPEN_ATTEMPTS the channel is reported degraded and retries stop", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const d = alice.daemon as unknown as { openChannel(r: ChannelRecord): Promise<void> };
    let attempts = 0;
    d.openChannel = async () => {
      attempts++;
      throw new Error("EIO: session store unavailable");
    };
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const degraded = await waitFor(async () => {
      const chs = await alice.daemon.channels();
      return chs.find((c) => "degraded" in c && c.degraded) ?? null;
    }, 10_000, "the channel reported degraded");
    expect((degraded as { error: string }).error).toMatch(/could not be opened after \d+ attempts: EIO/);
    const settled = attempts;
    await new Promise((r) => setTimeout(r, 1_000)); // ~10 more ticks at pollMs 100
    expect(attempts).toBe(settled); // before the fix: one more attempt on every tick, forever
  });
});

describe("Plan 4.5 Task 10 re-review 2: a stuck respond is replaced by the next dispute send", () => {
  async function anvil<T = unknown>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return ((await res.json()) as { result: T }).result;
  }
  async function pooled(address: string): Promise<Record<string, { hash: Hex; maxFeePerGas: Hex }>> {
    const c = await anvil<{ pending: Record<string, Record<string, { hash: Hex; maxFeePerGas: Hex }>> }>("txpool_content", []);
    return Object.entries(c.pending).find(([a]) => a.toLowerCase() === address.toLowerCase())?.[1] ?? {};
  }

  it("after the respond's wait gives up, the next respond goes out at the same nonce with higher fees, and lands once", async () => {
    const { alice, bob, id } = await matched();
    await alice.daemon.move(id, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob's turn");
    await bob.daemon.move(id, "e5", { actor: "agent" });
    await waitFor(() => alice.daemon.handle(id).session.isMyTurn(), 5_000, "alice's turn");
    const stale = bob.daemon.handle(id).session.challengeProof(); // turn 2
    await alice.daemon.move(id, "Nf3", { actor: "agent" }); // alice holds turn 3
    await waitFor(() => bob.daemon.handle(id).session.latest.state.turnNum === 3n, 5_000, "bob holds turn 3");
    const bobSession = bob.daemon.handle(id).sessionSender;
    await bob.daemon.stop();
    // Alice's dispute waits give up fast (each respond: 4 rounds of 300 ms), so "the next dispute send" comes soon.
    (alice.daemon as unknown as { disputeReceiptTimeoutMs: () => number }).disputeReceiptTimeoutMs = () => 300;
    const aliceSession = alice.daemon.handle(id).sessionSender.address;

    await anvil("evm_setAutomine", [false]);
    try {
      // Bob's challenge is mined by hand; after it, nothing is mined: Alice's respond is stuck.
      const challenging = alice.daemon.hub.challenge(bobSession, stale);
      await waitFor(async () => Object.keys(await pooled(bobSession.address)).length > 0, 5_000, "bob's challenge pending");
      await anvil("evm_mine", []);
      await challenging;
      await waitFor(async () => Object.keys(await pooled(aliceSession)).length > 0, 5_000, "alice's respond pending");
      const first = Object.values(await pooled(aliceSession))[0];
      // Several give-ups later (each followed by a new respond from the dispute pass) ...
      await waitFor(() => /still pending/.test(alice.daemon.handle(id).lastError ?? ""), 10_000, "a respond wait gave up");
      await new Promise((r) => setTimeout(r, 1_500));
      // ... everything Alice's session key has pending is still one nonce, now at a higher fee. Before the fix the
      // next respond took a fresh nonce and queued behind the stuck one, whose fee stayed frozen.
      const pool = await pooled(aliceSession);
      expect(Object.keys(pool)).toEqual(["0"]);
      expect(BigInt(pool["0"].maxFeePerGas)).toBeGreaterThan(BigInt(first.maxFeePerGas));
      await anvil("evm_mine", []);
      await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Open", 10_000, "the respond lands");
    } finally {
      await anvil("evm_setAutomine", [true]);
    }
    expect((await alice.daemon.hub.registeredState(id)).turnNum).toBe(3n);
    expect((await alice.daemon.hub.disputeEvents(id)).filter((e) => e.kind === "Responded")).toHaveLength(1);
  });
});

describe("Plan 4.5 Task 10 re-review 2 (minor 5): stop() aborts receipt waits", () => {
  it("a daemon stopped while its main pass waits for a receipt stops at once, not after the 30 s round", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    // Alice's node serves no receipt while `blind`: every wait of hers runs its full 30 s round. The first receipt
    // read is her funding pass's first wait (the approve's): that is the trigger, not a sleep.
    const client = alice.daemon.client;
    const real = client.getTransactionReceipt.bind(client);
    let blind = true;
    let entered: () => void = () => undefined;
    const inWait = new Promise<void>((r) => (entered = r));
    client.getTransactionReceipt = (async (args: { hash: Hex }) => {
      if (!blind) return real(args);
      entered();
      throw new TransactionReceiptNotFoundError({ hash: args.hash });
    }) as typeof client.getTransactionReceipt;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    await inWait;
    const t0 = Date.now();
    const outcome = await Promise.race([
      alice.daemon.stop().then(() => "stopped" as const),
      new Promise<"still waiting">((r) => setTimeout(() => r("still waiting"), 3_000)),
    ]);
    blind = false; // a wait that was not aborted now finds its receipt, so the cleanup never hangs either
    // Before the fix: stop() waited for the pass, i.e. the rest of the 30 s round and its replacements.
    expect(outcome).toBe("stopped");
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
});

describe("Plan 4.5 Task 10 re-review 2 (minor 7): the timer is armed before offer pruning", () => {
  it("a restart whose offer pruning hangs (a slow RPC) still answers a challenge", async () => {
    const { alice, bob, id } = await matched();
    await alice.daemon.move(id, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob's turn");
    await bob.daemon.move(id, "e5", { actor: "agent" });
    await waitFor(() => alice.daemon.handle(id).session.isMyTurn(), 5_000, "alice's turn");
    const stale = bob.daemon.handle(id).session.challengeProof(); // turn 2
    await alice.daemon.move(id, "Nf3", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.latest.state.turnNum === 3n, 5_000, "bob holds turn 3");
    const bobSession = bob.daemon.handle(id).sessionSender;
    await bob.daemon.stop();
    await alice.daemon.stop();

    const restarted = new ArenaDaemon({ home: alice.home, config: loadConfig(alice.home), walletKey: alice.walletKey, lobby: alice.client.lobby, relay: alice.client.relay });
    // Offer pruning hangs the first time (start()'s own call); the periodic passes' calls go through.
    let release: () => void = () => undefined;
    const hung = new Promise<void>((r) => (release = r));
    const d = restarted as unknown as { pruneOffers: () => Promise<void> };
    const realPrune = d.pruneOffers.bind(restarted);
    let first = true;
    d.pruneOffers = async () => {
      if (first) {
        first = false;
        await hung;
      }
      return realPrune();
    };
    cleanups.push(async () => {
      release();
      await restarted.stop();
    });
    void restarted.start(); // hangs in pruneOffers
    await new Promise((r) => setTimeout(r, 500));
    await new HubClient(restarted.hub.hub, restarted.client).challenge(bobSession, stale);
    // Before the fix start() armed the timer only after pruning: no dispute pass ran.
    await waitFor(async () => (await restarted.hub.channelInfo(id)).phase === "Open", 10_000, "the restarted daemon responds");
  });
});

describe("Plan 4.5 Task 10 round 4: one respond and one reclaim per channel at a time", () => {
  /** Alice to move at turn 2; Bob's daemon is stopped; Bob's session key can still challenge. */
  async function aliceToMove() {
    const m = await matched();
    const { alice, bob, id } = m;
    await alice.daemon.move(id, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob's turn");
    await bob.daemon.move(id, "e5", { actor: "agent" });
    await waitFor(() => alice.daemon.handle(id).session.isMyTurn(), 5_000, "alice's turn");
    const proof = bob.daemon.handle(id).session.challengeProof(); // turn 2
    const bobSession = bob.daemon.handle(id).sessionSender;
    await bob.daemon.stop();
    return { ...m, proof, bobSession };
  }

  it("a move-path respond while the dispute pass holds the channel sends no second respond", async () => {
    const { alice, id, proof, bobSession } = await aliceToMove();
    const h = alice.daemon.handle(id);
    const hub = alice.daemon.hub;
    const real = hub.respond.bind(hub);
    let responds = 0;
    hub.respond = async (sender, p, opts) => {
      responds++;
      return real(sender, p, opts);
    };
    await idleDispute(h); // the dispute pass "is working on" this channel from here on
    try {
      await new HubClient(hub.hub, alice.daemon.client).challenge(bobSession, proof); // registers turn 2
      await alice.daemon.move(id, "Nf3", { actor: "agent" }); // turn 3: newer than the challenge
      // Before the fix the move path answered at once, beside the dispute pass's own respond.
      expect(responds).toBe(0);
      expect((await hub.channelInfo(id)).phase).toBe("Challenged");
    } finally {
      h.disputeBusy = false; // the dispute pass finishes; its next run answers the challenge
    }
    await waitFor(async () => (await hub.channelInfo(id)).phase === "Open", 10_000, "the dispute pass responds");
    expect(responds).toBe(1);
  });

  it("a respond whose nonce turns out used, on a channel that is Open again, leaves no respond: error", async () => {
    const { alice, id, proof, bobSession } = await aliceToMove();
    const hub = alice.daemon.hub;
    const real = hub.respond.bind(hub);
    hub.respond = async (sender, p, opts) => {
      await real(sender, p, opts); // it lands...
      throw new TxNonceUsedError(0); // ...but the wait saw its nonce taken (e.g. by another respond of ours)
    };
    await alice.daemon.move(id, "Nf3", { actor: "agent" });
    await new HubClient(hub.hub, alice.daemon.client).challenge(bobSession, proof);
    await waitFor(async () => (await hub.channelInfo(id)).phase === "Open", 10_000, "answered");
    await new Promise((r) => setTimeout(r, 300));
    // Before the fix: "respond: nonce 0 is already used ..." stayed as lastError on an answered channel.
    expect(alice.daemon.handle(id).lastError ?? "").not.toMatch(/^respond:/);
  });

  it("the reclaim API and the main pass never run on one channel at once", async () => {
    const { alice, id } = await matched();
    const h = alice.daemon.handle(id);
    const hub = alice.daemon.hub;
    let reclaims = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    hub.reclaim = async () => {
      reclaims++;
      await gate;
      throw new HubRevertError("WrongPhase", new Error("reverted"));
    };
    const api = alice.daemon.reclaim(id).catch((e: unknown) => e); // holds the channel while its reclaim waits
    await waitFor(() => reclaims === 1, 5_000, "the API's reclaim is in flight"); // it waited out any main pass
    const m0 = h.mainPasses;
    await new Promise((r) => setTimeout(r, 600)); // ~6 timer ticks at pollMs 100
    expect(h.mainPasses).toBe(m0); // before the fix: the main pass ran on the channel meanwhile
    // A second reclaim while the first is in flight is refused (after RECLAIM_BUSY_WAIT_MS), not sent.
    await expect(alice.daemon.reclaim(id)).rejects.toMatchObject({ code: 409 });
    expect(reclaims).toBe(1);
    release();
    expect(await api).toMatchObject({ code: 409, message: expect.stringMatching(/WrongPhase/) }); // its own revert
    await waitFor(() => h.mainPasses > m0, 5_000, "the main pass resumes");
  });

  it("a stopped daemon cannot be started again (M5)", async () => {
    const { alice } = await matched();
    await alice.daemon.stop();
    await expect(alice.daemon.start()).rejects.toThrow(/cannot be restarted/);
  });
});

/** Waits for the channel's in-flight dispute pass (if any) to finish, then holds the channel as a dispute pass would. */
async function idleDispute(h: { disputeBusy: boolean }): Promise<void> {
  await waitFor(() => !h.disputeBusy, 5_000, "no dispute pass in flight");
  h.disputeBusy = true;
}

describe("Plan 4.5 Task 10 round 5 (I1): dispute intents are never refused by a fee ceiling", () => {
  it("session-key senders have no fee ceiling (only their balance bounds them); the wallet keeps the configured one", async () => {
    const { alice, id } = await matched();
    const ceiling = (s: unknown) => (s as { feeCeiling: bigint }).feeCeiling;
    expect(ceiling(alice.daemon.handle(id).sessionSender)).toBe(NO_FEE_CEILING); // before: the wallet's 100 gwei
    expect(ceiling(alice.daemon.wallet)).toBe(loadConfig(alice.home).feeCeilingWei ?? DEFAULT_FEE_CEILING_WEI);
  });
});
