import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createTestClient, http, TransactionReceiptNotFoundError, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ChannelSession,
  HubClient,
  HubRevertError,
  LocalKeyTxSender,
  TxDroppedError,
  TxInsufficientFundsError,
  TxNonceUsedError,
  TxReceiptMissingError,
  NO_FEE_CEILING,
  DEFAULT_FEE_CEILING_WEI,
  buildParams,
  hashState,
  offerId as computeOfferId,
  signClose,
  waitOrReplace,
  type MatchEvent,
  type SignedAcceptance,
} from "@arena/sdk";
import { SCHOLARS_MATE } from "../../sdk/test/helpers/fixtures.js";
import { CHAIN, RPC, increaseTime, now, setEthBalance, setLimits, setPaused } from "../../sdk/test/helpers/chain.js";
import {
  ArenaDaemon,
  DaemonError,
  FileSessionStore,
  RecordStore,
  SETTLED_CACHE_MAX,
  SETTLED_GRACE_SECONDS,
  SWEEP_ABANDON_ATTEMPTS,
  SWEEP_HEADROOM_DEN,
  SWEEP_HEADROOM_NUM,
  arenaPaths,
  loadConfig,
  type ChannelRecord,
} from "../src/index.js";
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

  it("Plan 5 Task 1: session-gas-low precision -- a TxNonceUsedError during a refill is logged only, never raised as an attention", async () => {
    const { alice, id, config } = await matched();
    const d = alice.daemon;
    const session = d.handle(id).sessionSender.address;
    const target = config.sessionGasWei;
    const logs: string[] = [];
    (d as unknown as { opts: { log?: (l: string) => void } }).opts.log = (l) => logs.push(l);
    // Stub out the refill's send entirely: whatever the real cause, this is the shape of error a nonce race
    // between two refills (or this key's own dispute traffic) produces -- and per the ruling it must never raise
    // session-gas-low, only be logged and retried.
    const internals = d as unknown as { topUpSession(l: unknown): Promise<boolean> };
    internals.topUpSession = () => Promise.reject(new TxNonceUsedError(1));
    await setEthBalance(session, target / 10n); // below the floor: every pass tries to refill
    for (let i = 0; i < 5; i++) {
      await d.idle();
      await d.tick();
    }
    expect(logs.some((l) => /TxNonceUsedError/.test(l))).toBe(true);
    expect(d.handle(id).sessionGasLow).toBeNull();
    expect((await d.status(id)).attention).not.toBe("session-gas-low");
  });

  it("fix round (minor): a failed fee estimate during a refill also raises session-gas-low", async () => {
    const { alice, id, config } = await matched();
    const d = alice.daemon;
    const session = d.handle(id).sessionSender.address;
    const target = config.sessionGasWei;
    const real = d.client.estimateFeesPerGas.bind(d.client);
    d.client.estimateFeesPerGas = (async () => {
      throw new Error("RPC unreachable");
    }) as typeof d.client.estimateFeesPerGas;
    try {
      await setEthBalance(session, target / 10n); // below the floor: every pass tries to refill
      const st = await waitFor(async () => {
        const s = await d.status(id);
        return s.attention === "session-gas-low" ? s : null;
      }, 10_000, "session-gas-low");
      expect(st.attention).toBe("session-gas-low");
      expect(d.handle(id).sessionGasLow).toMatch(/fee estimate failed/);
    } finally {
      d.client.estimateFeesPerGas = real;
    }
  });

  it("Plan 5 Task 1: refill back-off bounds attempts, logs once per episode, and resets (with an immediate retry) once the wallet's balance rises", async () => {
    const { alice, id, config } = await matched();
    const d = alice.daemon;
    const session = d.handle(id).sessionSender.address;
    const target = config.sessionGasWei;
    const logs: string[] = [];
    (d as unknown as { opts: { log?: (l: string) => void } }).opts.log = (l) => logs.push(l);
    const internals = d as unknown as { topUpSession(l: unknown): Promise<boolean> };
    const original = internals.topUpSession.bind(d);
    let attempts = 0;
    internals.topUpSession = () => {
      attempts++;
      return Promise.reject(new TxInsufficientFundsError(alice.address));
    };
    try {
      await setEthBalance(alice.address, 1_000n); // the wallet genuinely cannot pay: the stub matches reality
      await setEthBalance(session, target / 10n); // below the floor
      for (let i = 0; i < 20; i++) {
        await d.idle();
        await d.tick();
      }
      // Bounded: back-off after the first failure (30 s) comfortably outlasts 20 fast ticks.
      expect(attempts).toBe(1);
      expect(logs.filter((l) => /refill back-off started/.test(l))).toHaveLength(1);
      expect(d.handle(id).sessionGasLow).not.toBeNull();

      // The wallet's balance rising ends the back-off and allows an immediate retry, even though it still fails.
      await setEthBalance(alice.address, ANVIL_DEFAULT_BALANCE);
      await d.idle();
      await d.tick();
      expect(attempts).toBe(2);
      expect(logs.filter((l) => /refill back-off ended/.test(l))).toHaveLength(1);
      // That immediate retry failed too (still stubbed), so a fresh back-off episode is already running -- rising
      // the balance again ends that one too, so the real refill below is not left waiting out its 30 s.
      internals.topUpSession = original;
      await setEthBalance(alice.address, ANVIL_DEFAULT_BALANCE * 2n);
      for (let i = 0; i < 20 && d.handle(id).sessionGasLow !== null; i++) {
        await d.idle();
        await d.tick();
      }
      expect(d.handle(id).sessionGasLow).toBeNull();
      expect(d.handle(id).refills).toBe(1);
      expect(logs.filter((l) => /refill back-off ended/.test(l))).toHaveLength(2);
    } finally {
      internals.topUpSession = original;
      await setEthBalance(alice.address, ANVIL_DEFAULT_BALANCE);
    }
  });

  it("fix round (minor): refillBackoffGate reads the wallet balance only while a back-off is active", async () => {
    // Root-cause note (coordinator follow-up, on an observed flake in this exact test): this test drives every
    // pass itself via explicit idle()+tick() calls and counts precisely how many of them read the wallet's own
    // balance -- but matched()'s daemon still runs its own periodic timer (100ms) throughout. mainPass()
    // single-flights on `mainTicking`: if the periodic timer's own background mainPass() call starts (during
    // this same tick's disputePass(), which runs first and does not hold that flag) before this tick's own
    // mainPass() call reaches it, the *background* one wins the single-flight slot and does the real work
    // asynchronously, unawaited by this tick() call, while this tick's own mainPass() short-circuits immediately
    // (mainTicking already true) and returns having done nothing. Confirmed by direct instrumentation (a full
    // timeline of every mainPass()/ensureSessionGas() invocation, tagged and timestamped) across two independently
    // captured natural failures: on both, mainPass() was invoked more times than this test called tick(), with
    // the extra invocations landing exactly where this test's own call was skipped -- the background pass, not
    // this test's, ends up doing the gate check the final assertion depends on, and nothing here waits for that
    // background pass to finish before checking `walletBalanceReads` (no `idle()` follows the last `tick()`).
    // Not a product bug: `mainTicking`'s single-flight is working exactly as designed (the periodic timer's own
    // next tick would have done the same check moments later regardless, and no work is lost) -- it just makes
    // this test's precise per-tick counting nondeterministic unless the interfering timer is disabled, the same
    // reasoning the "fix round I9" back-off test below already applies (there, by never starting matched()'s
    // periodic timer in the first place; here, by clearing it below, since matched()'s own funding wait needs it
    // running until the channel actually reaches Open).
    const { alice, id } = await matched();
    const d = alice.daemon;
    // matched()'s own funding wait needs the periodic timer running (its default pollMs, 100ms) to reach Open at
    // all; only now, with the channel already Open and matched() done waiting on it, is it disabled -- clearing
    // the interval directly (not stop(), which would also abort in-flight work and set `stopped`) so every pass
    // from here on is exactly the one this test's own idle()+tick() calls asked for, no more.
    clearInterval((d as unknown as { timer?: NodeJS.Timeout }).timer);
    const realGetBalance = d.client.getBalance.bind(d.client);
    let walletBalanceReads = 0;
    d.client.getBalance = (async (args: { address: Hex }) => {
      if (args.address.toLowerCase() === alice.address.toLowerCase()) walletBalanceReads++;
      return realGetBalance(args);
    }) as typeof d.client.getBalance;
    try {
      // No back-off active, and the session key is already funded: several passes never need to read the
      // wallet's own balance at all.
      for (let i = 0; i < 5; i++) {
        await d.idle();
        await d.tick();
      }
      expect(walletBalanceReads).toBe(0);

      // A failed refill starts a back-off episode: from here on the gate does read the wallet balance (to detect
      // an early-ending rise).
      const internals = d as unknown as { topUpSession(l: unknown): Promise<boolean> };
      internals.topUpSession = () => Promise.reject(new TxInsufficientFundsError(alice.address));
      await setEthBalance(d.handle(id).sessionSender.address, 1n); // below the floor: a refill is attempted
      await d.idle();
      await d.tick(); // this pass's own attempt starts the back-off (no wallet read yet: nothing to reset before it)
      await d.idle();
      await d.tick(); // now backed off: this pass's gate check does read the wallet balance
      expect(walletBalanceReads).toBeGreaterThan(0);
    } finally {
      d.client.getBalance = realGetBalance;
    }
  });

  it("fix round I9: refill back-off doubles from 30s up to the 5 minute cap, then holds there", async () => {
    // A long pollMs: this test drives every pass itself via explicit tick() calls, and the periodic timer
    // independently calling ensureSessionGas (and resetting/bumping the very back-off this test asserts on)
    // between those calls would make the expected sequence unreliable.
    const pair = await startPair({ pollMs: 3_600_000 });
    cleanups.push(pair.cleanup);
    const { alice, config } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await pair.bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    await waitFor(async () => {
      for (const p of [alice, pair.bob]) {
        await p.daemon.idle();
        await p.daemon.tick();
      }
      return (await alice.daemon.hub.channelInfo(id)).phase === "Open";
    }, 20_000, "funding by manual ticks");
    const d = alice.daemon;
    const session = d.handle(id).sessionSender.address;
    const target = config.sessionGasWei;
    const l = d.handle(id);
    const internals = d as unknown as { topUpSession(l: unknown): Promise<boolean> };
    internals.topUpSession = () => Promise.reject(new TxInsufficientFundsError(alice.address));
    const expected = [30_000, 60_000, 120_000, 240_000, 300_000, 300_000];
    try {
      await setEthBalance(alice.address, 1_000n); // the wallet genuinely cannot pay
      await setEthBalance(session, target / 10n); // below the floor
      for (const exp of expected) {
        l.refillBlockedUntil = 0; // bypass the real wait: this test is about the sequence of durations, not timing
        await d.idle();
        await d.tick();
        expect(l.refillBackoffMs).toBe(exp);
      }
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

describe("Plan 5 Task 1: session-gas sweep", () => {
  type SweepableDaemon = { sweepChannel(l: unknown): Promise<void> };

  /** Plays a quick draw, closes both sides (settling the channel), with the automatic sweep suppressed for the
   *  duration -- so a test can pose its own session-key scenario before letting the real sweep run. Returns the
   *  real `sweepChannel` (bound), for the test to reinstate when it is ready. */
  async function settleWithSweepDisabled(alice: Awaited<ReturnType<typeof matched>>["alice"], bob: Awaited<ReturnType<typeof matched>>["bob"], id: Hex) {
    const d = alice.daemon as unknown as SweepableDaemon;
    const original = d.sweepChannel.bind(d);
    d.sweepChannel = () => Promise.resolve();
    await alice.daemon.move(id, "e4", { actor: "agent", offerDraw: true });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    await bob.daemon.acceptDraw(id, "agent");
    await waitFor(async () => (await alice.daemon.status(id)).attention === "game-over", 5_000, "draw seen");
    await alice.daemon.close(id, "agent");
    await waitFor(async () => (await bob.daemon.status(id)).attention === "close-requested", 5_000, "close requested");
    await bob.daemon.close(id, "agent");
    await waitFor(() => alice.daemon.handle(id).record.finalized, 20_000, "settled");
    return original;
  }

  it("sweeps the session key's balance back to the wallet after settle: exact accounting (rule 4/I9)", async () => {
    const { alice, bob, id } = await matched();
    const d = alice.daemon;
    const session = d.handle(id).sessionSender.address;
    // settleWithSweepDisabled waits for `record.finalized`, which only flips once alice's own watch() has read
    // Finalized on-chain -- by then any racing close-resubmission (both sides may submit the same cooperative
    // close at once; Plan 4.5 Task 10) has already landed or reverted, so it is safe to measure the wallet from
    // here: nothing but the sweep itself should touch it from this point on.
    const original = await settleWithSweepDisabled(alice, bob, id);

    const sessionBefore = await d.client.getBalance({ address: session });
    const walletBefore = await d.client.getBalance({ address: alice.address });
    (d as unknown as SweepableDaemon).sweepChannel = original;
    await waitFor(() => d.handle(id).record.swept !== undefined, 20_000, "swept");

    const record = d.handle(id).record;
    expect(record.swept).toBe(true);
    expect(record.sweptAmount).toBeGreaterThan(0n);
    expect(record.sweptTx).toMatch(/^0x[0-9a-f]{64}$/);
    const receipt = await d.client.getTransactionReceipt({ hash: record.sweptTx! });
    expect(receipt.status).toBe("success");
    expect(receipt.to?.toLowerCase()).toBe(alice.address.toLowerCase());

    const sessionAfter = await d.client.getBalance({ address: session });
    const walletAfter = await d.client.getBalance({ address: alice.address });
    // I9 exact assertions:
    expect(walletAfter - walletBefore).toBe(record.sweptAmount); // the wallet gained exactly the recorded amount
    // what left the session key beyond the swept amount is exactly the sweep tx's own gas cost
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
    expect(sessionBefore - sessionAfter - (walletAfter - walletBefore)).toBe(gasCost);
    // the residue stays within the reserved headroom (rule 3: gas * ceil(F * 1.3))
    const { maxFeePerGas } = await d.client.estimateFeesPerGas();
    expect(sessionAfter).toBeLessThanOrEqual((receipt.gasUsed * maxFeePerGas * 13n) / 10n);
  });

  it("declines a dust balance without sending a transaction, recording swept: \"dust\"", async () => {
    const { alice, bob, id } = await matched();
    const original = await settleWithSweepDisabled(alice, bob, id);
    const d = alice.daemon;
    const l = d.handle(id);
    const session = l.sessionSender.address;
    const { maxFeePerGas } = await d.client.estimateFeesPerGas();
    const dustBalance = 21_000n * maxFeePerGas; // rule 3: dust once value <= gas * F -- this balance leaves exactly that
    await setEthBalance(session, dustBalance);
    (d as unknown as SweepableDaemon).sweepChannel = original;
    await waitFor(() => l.record.swept !== undefined, 20_000, "declined");
    expect(l.record.swept).toBe("dust");
    expect(l.record.sweptAmount).toBeUndefined();
    expect(await d.client.getBalance({ address: session })).toBe(dustBalance); // untouched: no transaction sent
  });

  it("scenario A (reviewer repro): a dropped tracked entry on the session key recovers -- no permanent stall", async () => {
    const { alice, bob, id } = await matched();
    const original = await settleWithSweepDisabled(alice, bob, id);
    const d = alice.daemon;
    const l = d.handle(id);
    const sender = l.sessionSender;
    const testClient = createTestClient({ mode: "anvil", chain: CHAIN, transport: http(RPC) });
    await testClient.setAutomine(false);
    try {
      // A stand-in for a stuck respond: sent, then abandoned by an aborted wait (released, never mined).
      const standInHash = await sender.send({ to: sender.address, data: "0x", value: 0n, gas: 100_000n });
      const ac = new AbortController();
      ac.abort();
      await waitOrReplace(d.client, sender, { to: sender.address, data: "0x", value: 0n }, standInHash, { signal: ac.signal }).catch(
        () => undefined,
      );
      expect(sender.tracked().map((t) => t.state)).toEqual(["released"]);
      await testClient.dropTransaction({ hash: standInHash }); // the node no longer knows it at all
      await testClient.setAutomine(true);
    } finally {
      await testClient.setAutomine(true);
    }
    (d as unknown as SweepableDaemon).sweepChannel = original;
    await waitFor(() => l.record.swept === true, 20_000, "recovered and swept");
    const record = l.record;
    expect(record.sweptAmount).toBeGreaterThan(0n);
    const receipt = await d.client.getTransactionReceipt({ hash: record.sweptTx! });
    expect(receipt.status).toBe("success");
    expect(receipt.to?.toLowerCase()).toBe(alice.address.toLowerCase());
  });

  it("fix round 2, important 4 (scenario B, B1 shape): replacing a released entry at its own nonce -- the stand-in never mines, the replacement does", async () => {
    const { alice, bob, id } = await matched();
    const original = await settleWithSweepDisabled(alice, bob, id);
    const d = alice.daemon;
    const l = d.handle(id);
    const sender = l.sessionSender;
    const testClient = createTestClient({ mode: "anvil", chain: CHAIN, transport: http(RPC) });
    await testClient.setAutomine(false);
    try {
      // A stand-in for a stuck respond that is still sitting in the node's mempool (unlike scenario A's dropped
      // one) when the sweep runs -- the old bug waited on *this* hash directly and reported its receipt (to
      // itself, not the wallet) as a successful sweep.
      const standInHash = await sender.send({ to: sender.address, data: "0x", value: 0n, gas: 100_000n });
      const ac = new AbortController();
      ac.abort();
      await waitOrReplace(d.client, sender, { to: sender.address, data: "0x", value: 0n }, standInHash, { signal: ac.signal }).catch(
        () => undefined,
      );
      expect(sender.tracked().map((t) => t.state)).toEqual(["released"]);
      const standInNonce = sender.tracked()[0].nonce;

      const walletBefore = await d.client.getBalance({ address: alice.address });
      (d as unknown as SweepableDaemon).sweepChannel = original;
      // Automine stays OFF: the periodic timer's own tick drives sweepChannel -> runSweepAttempt -> performSweep
      // -> sender.send(req), which must find the released entry and replace it at its own nonce (rule 2) for
      // anything to ever land -- this is the actual replacement path, not a fresh send that automine would let
      // slip in ahead of it.
      await waitFor(() => sender.tracked()[0]?.hashes.length === 2, 10_000, "the sweep replaced the stand-in at its nonce");
      const entry = sender.tracked()[0];
      expect(entry.nonce).toBe(standInNonce); // same nonce: a replacement, not a fresh send queued behind it
      const replacementHash = entry.hashes.find((h) => h !== standInHash);
      expect(replacementHash).toBeDefined();

      await testClient.mine({ blocks: 1 }); // now let the replacement (and only the replacement) land
      await waitFor(() => l.record.swept === true, 20_000, "swept");

      const record = l.record;
      expect(record.sweptTx).toBe(replacementHash); // the replacement is what actually landed and was recorded
      expect(record.sweptTx).not.toBe(standInHash);
      await expect(d.client.getTransactionReceipt({ hash: standInHash })).rejects.toThrow(); // the stand-in never mined

      const walletAfter = await d.client.getBalance({ address: alice.address });
      expect(walletAfter - walletBefore).toBe(record.sweptAmount); // the wallet genuinely received the funds
      const receipt = await d.client.getTransactionReceipt({ hash: record.sweptTx! });
      expect(receipt.status).toBe("success");
      expect(receipt.to?.toLowerCase()).toBe(alice.address.toLowerCase());
      expect(sender.tracked()).toEqual([]); // settled: no dangling entry
    } finally {
      await testClient.setAutomine(true);
    }
  });

  it("fix round 2, important 5: a dead entry bumped several times still gets replaced and swept (dynamic reserve)", async () => {
    const { alice, bob, id } = await matched();
    const original = await settleWithSweepDisabled(alice, bob, id);
    const d = alice.daemon;
    const l = d.handle(id);
    const sender = l.sessionSender;
    const testClient = createTestClient({ mode: "anvil", chain: CHAIN, transport: http(RPC) });
    await testClient.setAutomine(false);
    try {
      const standInHash = await sender.send({ to: sender.address, data: "0x", value: 0n, gas: 100_000n });
      // Bump it several times against a chain that never mines -- the pool still holds the stand-in (and every
      // bump of it) throughout, so the sender's own lastFees for this nonce stays known and elevated, rather
      // than being forgotten by a later prune() (which only forgets it once the pool no longer holds any of this
      // intent's transactions). maxReplacements is generous (the reviewer's own repro reached ~1.67x the market
      // estimate this way, comfortably past the old fixed 1.3x reserve; this run's own ratio depends on how the
      // market estimate itself moved between rounds, not just the bump percentage, so it is observed rather than
      // asserted -- the point of this test is that the sweep succeeds despite it, whatever it turns out to be).
      await waitOrReplace(d.client, sender, { to: sender.address, data: "0x", value: 0n }, standInHash, { timeoutMs: 100, maxReplacements: 5 }).catch(
        () => undefined,
      );
      const stuckEntry = sender.tracked()[0];
      expect(stuckEntry.state).toBe("released");
      const stuckNonce = stuckEntry.nonce;

      const walletBefore = await d.client.getBalance({ address: alice.address });
      (d as unknown as SweepableDaemon).sweepChannel = original;
      // Automine stays off (as in important 4/scenario B): the stuck entry must still be there, at its elevated
      // fee, for the sweep to actually have to reserve for it and replace it -- not just find it already mined
      // and start over at a fresh nonce.
      await waitFor(() => sender.tracked()[0]?.hashes.length === stuckEntry.hashes.length + 1, 10_000, "the sweep replaced the dead entry at its nonce");
      const entry = sender.tracked()[0];
      expect(entry.nonce).toBe(stuckNonce);

      await testClient.mine({ blocks: 1 });
      await waitFor(() => l.record.swept === true, 20_000, "swept despite the elevated dead entry");
      const walletAfter = await d.client.getBalance({ address: alice.address });
      expect(walletAfter - walletBefore).toBe(l.record.sweptAmount);
      const receipt = await d.client.getTransactionReceipt({ hash: l.record.sweptTx! });
      expect(receipt.status).toBe("success");
    } finally {
      await testClient.setAutomine(true);
    }
  });

  it("sweeps a retired (never funded past its deadline) channel's session gas too, not just Finalized/Reclaimed", async () => {
    const pair = await startPair({ pollMs: 3_600_000 });
    cleanups.push(pair.cleanup);
    const { alice, bob, env } = pair;
    const d = alice.daemon;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    try {
      await setPaused(env.hub, true); // fund() tops up the session key, then the deposit itself reverts (Paused)
      await d.idle();
      await d.tick();
      const session = d.handle(id).sessionSender.address;
      await waitFor(async () => (await d.client.getBalance({ address: session })) > 0n, 10_000, "session key funded despite the paused deposit");
      await increaseTime(3601); // past the funding deadline
      await d.idle();
      await d.tick(); // retires the channel (None/Funding, unfunded, past the deadline) -- same pass sweeps it
      await waitFor(() => d.handle(id).record.finalized, 10_000, "retired");
      expect(d.handle(id).record.finalPhase === "None" || d.handle(id).record.finalPhase === "Funding").toBe(true);
      await waitFor(() => d.handle(id).record.swept !== undefined, 20_000, "swept");
      expect(d.handle(id).record.swept === true || d.handle(id).record.swept === "dust").toBe(true);
    } finally {
      await setPaused(env.hub, false);
    }
  });

  it("fix round 2, important 1: arena sweep retries an abandoned channel instead of reporting \"not sweepable yet\"", async () => {
    const { alice, bob, id } = await matched();
    const original = await settleWithSweepDisabled(alice, bob, id);
    const d = alice.daemon;
    const l = d.handle(id);
    (d as unknown as SweepableDaemon).sweepChannel = original;
    // Force straight to "abandoned" (bypassing the real 12-attempt back-off, for speed) -- the same end state
    // the first fix round's own abandonment test drives to more slowly. Persisted too: sweep() reads records
    // from disk, like a real abandonment would have written.
    l.record = { ...l.record, swept: "abandoned" };
    l.sweep.attempts = SWEEP_ABANDON_ATTEMPTS;
    new RecordStore(alice.home).saveChannel(l.record);

    const legacy = await d.sweep(id);
    expect(legacy.results[0].swept).toMatch(/^retried: 0x[0-9a-f]+$/);
    expect(l.record.swept).toBe(true);
    expect(l.record.sweptAmount).toBeGreaterThan(0n);
    expect(l.sweep.attempts).toBe(0); // reset: a fresh episode, not still counting toward the old abandonment
  });

  it("never sweeps while a refill or the dispute pass is working the same session key (rule 1)", async () => {
    const { alice, bob, id } = await matched();
    const original = await settleWithSweepDisabled(alice, bob, id);
    const d = alice.daemon;
    const l = d.handle(id);
    const callSweepChannel = (h: unknown) => (d as unknown as { sweepChannel(x: unknown): Promise<void> }).sweepChannel(h);
    (d as unknown as SweepableDaemon).sweepChannel = original;

    l.refilling = new Promise<void>(() => undefined); // simulates a refill genuinely in flight; never resolves
    await callSweepChannel(l);
    expect(l.record.swept).toBeUndefined(); // skipped: the refill guard held
    l.refilling = null;

    l.disputeBusy = true;
    await callSweepChannel(l);
    expect(l.record.swept).toBeUndefined(); // skipped: the dispute-pass guard held
    l.disputeBusy = false;

    await callSweepChannel(l);
    await waitFor(() => l.record.swept !== undefined, 20_000, "swept once both guards clear");
  });

  it("fix round 2, important 2: sweep() (API path) also honours rule 1 -- never sweeps while a refill or the dispute pass is busy", async () => {
    const { alice, bob, id } = await matched();
    const original = await settleWithSweepDisabled(alice, bob, id);
    const d = alice.daemon;
    const l = d.handle(id);
    (d as unknown as SweepableDaemon).sweepChannel = original; // restored, though sweep() bypasses it regardless
    l.refilling = new Promise<void>(() => undefined); // never resolves: a refill genuinely stuck in flight
    l.disputeBusy = true;
    const before = await d.client.getBalance({ address: l.sessionSender.address });
    try {
      const result = await d.sweep(id);
      expect(result.results[0].swept).toMatch(/^error:/);
      expect(l.record.swept).toBeUndefined();
      // The gas the refill is (ostensibly) still adding, or that the dispute pass may still need, is untouched.
      expect(await d.client.getBalance({ address: l.sessionSender.address })).toBe(before);
    } finally {
      l.refilling = null;
      l.disputeBusy = false;
    }
  });

  it("fix round I8/I9: sweep back-off reaches SWEEP_ABANDON_ATTEMPTS, marks swept: \"abandoned\", and unblocks eviction", async () => {
    const { alice, bob, id } = await matched();
    const original = await settleWithSweepDisabled(alice, bob, id);
    const d = alice.daemon;
    const l = d.handle(id);
    (d as unknown as SweepableDaemon).sweepChannel = original;
    const internals = d as unknown as { performSweep(sender: unknown): Promise<unknown> };
    const realPerformSweep = internals.performSweep.bind(d);
    internals.performSweep = () => Promise.reject(new Error("simulated sweep failure"));
    const callSweepChannel = () => (d as unknown as { sweepChannel(x: unknown): Promise<void> }).sweepChannel(l);
    try {
      for (let i = 0; i < SWEEP_ABANDON_ATTEMPTS; i++) {
        l.sweep.blockedUntil = 0; // bypass the real back-off wait between attempts
        await callSweepChannel();
      }
      expect(l.record.swept).toBe("abandoned");
      expect(l.record.sweptAmount).toBeUndefined();
    } finally {
      internals.performSweep = realPerformSweep;
    }
    // Eviction can now proceed (swept is no longer unset) once the grace period passes.
    await d.idle();
    await d.tick();
    await increaseTime(Number(SETTLED_GRACE_SECONDS) + 1);
    await waitFor(() => d.channelIds().length === 0, 10_000, "evicted despite never actually sweeping");
  });

  it("fix round I9: eviction never proceeds while swept stays unset, even well past the grace period", async () => {
    const { alice, bob, id } = await matched();
    await settleWithSweepDisabled(alice, bob, id); // sweepChannel stays a no-op: never re-enabled below
    const d = alice.daemon;
    await d.idle();
    await d.tick(); // settledAt starts here
    await increaseTime(Number(SETTLED_GRACE_SECONDS) + 1);
    for (let i = 0; i < 3; i++) {
      await d.idle();
      await d.tick();
    }
    expect(d.handle(id).record.swept).toBeUndefined();
    expect(d.channelIds()).toContain(id); // not evicted: the sweep never ran, so its session gas is still live
  });

  it("`arena sweep` (daemon.sweep) sweeps a legacy record -- finalized before this feature, no longer in `live`", async () => {
    const { alice, bob, id } = await matched();
    const d = alice.daemon;
    const session = d.handle(id).sessionSender.address;
    await settleWithSweepDisabled(alice, bob, id); // never re-enabled: this channel stays unswept, like a legacy record
    expect(d.handle(id).record.swept).toBeUndefined();
    const sessionBefore = await d.client.getBalance({ address: session });

    await d.stop();
    const restarted = new ArenaDaemon({
      home: alice.home,
      config: loadConfig(alice.home),
      walletKey: alice.walletKey,
      lobby: alice.client.lobby,
      relay: alice.client.relay,
    });
    // start() fires one tick() of its own (fire-and-forget, regardless of pollMs), which would otherwise race
    // this test's own manual sweep() call below for the very record it is about to queue-sweep automatically
    // (full protection against that race for a real caller is fix round I1/I5's single-flight/busy-wait, not this
    // commit's) -- stubbed out here so this test is solely about the manual sweep() path.
    (restarted as unknown as { sweepQueuePass(): Promise<void> }).sweepQueuePass = () => Promise.resolve();
    cleanups.push(() => restarted.stop());
    await restarted.start();
    expect(restarted.channelIds()).toEqual([]); // finalized: never re-opened (existing I1 behaviour)

    const walletBefore = await restarted.client.getBalance({ address: alice.address });
    const { results, remaining } = await restarted.sweep();
    expect(remaining).toBe(0);
    expect(results).toHaveLength(1);
    expect(results[0].channelId).toBe(id);
    expect(results[0].swept).toMatch(/^0x[0-9a-f]+$/);
    expect(results[0].hash).toMatch(/^0x[0-9a-f]{64}$/); // I9: the sweep hash is returned in the result

    const record = new RecordStore(alice.home).channel(id)!;
    expect(record.swept).toBe(true);
    expect(record.sweptTx).toBe(results[0].hash);
    const sessionAfter = await restarted.client.getBalance({ address: session });
    const walletAfter = await restarted.client.getBalance({ address: alice.address });
    expect(sessionAfter).toBeLessThan(sessionBefore);
    expect(walletAfter - walletBefore).toBe(record.sweptAmount);

    // A second sweep finds nothing left to do (already swept).
    expect(await restarted.sweep()).toEqual({ results: [], remaining: 0 });
  });

  it("fix round I5: sweep() is single-flight -- a concurrent call is refused with 409", async () => {
    const { alice, bob, id } = await matched();
    const d = alice.daemon;
    await settleWithSweepDisabled(alice, bob, id); // unswept: sweep() below has real work to do
    const p1 = d.sweep(); // sets `sweeping` synchronously, before its first await
    const p2 = d.sweep();
    await expect(p2).rejects.toThrow(/already in progress/);
    await expect(p2).rejects.toBeInstanceOf(DaemonError);
    await p1; // let the first one finish before the test's own cleanup runs
  });

  it("fix round: an already-swept channel targeted by `--channel` reports \"already\", not an error", async () => {
    const { alice, bob, id } = await matched();
    const d = alice.daemon;
    await d.move(id, "e4", { actor: "agent", offerDraw: true });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    await bob.daemon.acceptDraw(id, "agent");
    await waitFor(async () => (await d.status(id)).attention === "game-over", 5_000, "draw seen");
    await d.close(id, "agent");
    await waitFor(async () => (await bob.daemon.status(id)).attention === "close-requested", 5_000, "close requested");
    await bob.daemon.close(id, "agent");
    await waitFor(() => d.handle(id).record.swept !== undefined, 20_000, "auto-swept");
    expect(d.handle(id).record.swept).toBe(true);

    expect(await d.sweep(id)).toEqual({ results: [{ channelId: id, swept: "already" }], remaining: 0 });
  });

  it("fix round (minor): `sweep --channel` with an ambiguous prefix errors, matching pick()", async () => {
    const { alice, bob, id } = await matched();
    const d = alice.daemon;
    await settleWithSweepDisabled(alice, bob, id); // never re-enabled: stays unswept
    const realRecord = new RecordStore(alice.home).channel(id)!;
    const paths = arenaPaths(alice.home);
    // A second finalized record whose id shares `id`'s leading hex digits ("0x" + 8 hex chars), but is not `id`.
    const prefix = id.slice(0, 10);
    const cloneId = `${prefix}${"0".repeat(66 - prefix.length)}` as Hex;
    expect(cloneId.toLowerCase()).not.toBe(id.toLowerCase());
    new RecordStore(alice.home).saveChannel({ ...realRecord, channelId: cloneId, finalized: true, finalPhase: "Finalized" });
    writeFileSync(paths.channelSession(cloneId), readFileSync(paths.channelSession(id), "utf8"));

    await expect(d.sweep(prefix)).rejects.toThrow(/ambiguous channel/);
    await expect(d.sweep(prefix)).rejects.toBeInstanceOf(DaemonError);
  });

  it("fix round I5: sweep() spends a bounded budget and reports remaining for what's left", async () => {
    const { alice, bob, id: id0 } = await matched();
    await settleWithSweepDisabled(alice, bob, id0);
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id1 = await waitFor(() => alice.daemon.channelIds().find((c) => c !== id0), 20_000, "second match");
    await waitFor(() => bob.daemon.channelIds().includes(id1), 20_000, "bob's second match");
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id1)).phase === "Open", 20_000, "second open");
    await settleWithSweepDisabled(alice, bob, id1);
    const d = alice.daemon;
    expect(d.handle(id0).record.swept).toBeUndefined();
    expect(d.handle(id1).record.swept).toBeUndefined();

    // A 1 ms budget: real work (an RPC round trip) always exceeds it, so exactly one of the two targets is
    // attempted before the loop's own deadline check stops it. Fix round 2, minor 3 now also threads that same
    // deadline into the attempted record's own receipt wait (giveUpAt) -- exactly the point of minor 3 -- so a
    // budget this tiny is no longer harmless to that one record's own success; `sweepOneNow` is stubbed here to
    // add a deterministic real-time delay around the (otherwise real, unbounded) sweep, so this test keeps
    // isolating what it always tested -- the loop's own "how many, how much left" bookkeeping -- from minor 3's
    // own per-record bound, which the dedicated "minor 3" test below covers.
    const internals = d as unknown as { sweepOneNow(r: ChannelRecord, giveUpAt?: number): Promise<{ channelId: Hex; swept: string; hash?: Hex }> };
    const realSweepOneNow = internals.sweepOneNow.bind(d);
    internals.sweepOneNow = async (r) => {
      const result = await realSweepOneNow(r); // unbounded: always a real, complete sweep attempt
      await new Promise((resolve) => setTimeout(resolve, 50)); // guarantees the loop's own tiny budget has since passed
      return result;
    };
    try {
      // 10 ms, not 1: reaching the loop's own first deadline check (after filtering `targets`) can itself
      // occasionally take a stray millisecond of real wall-clock time; 1 ms was seen to flake to zero attempted.
      const { results, remaining } = await d.sweep(undefined, { budgetMs: 10 });
      expect(results).toHaveLength(1);
      expect(remaining).toBe(1);
    } finally {
      internals.sweepOneNow = realSweepOneNow;
    }
    // A follow-up call (the real budget) finishes what was left.
    const rest = await d.sweep();
    expect(rest.results).toHaveLength(1);
    expect(rest.remaining).toBe(0);
    expect(d.handle(id0).record.swept).not.toBeUndefined();
    expect(d.handle(id1).record.swept).not.toBeUndefined();
  });

  it("fix round I2: the periodic main pass sweeps a finalized-but-unswept record found at start() on its own -- no `arena sweep` needed", async () => {
    const { alice, bob, id } = await matched();
    const d = alice.daemon;
    const session = d.handle(id).sessionSender.address;
    await settleWithSweepDisabled(alice, bob, id); // never re-enabled: settles unswept, like a legacy record
    expect(d.handle(id).record.swept).toBeUndefined();

    await d.stop();
    const restarted = new ArenaDaemon({
      home: alice.home,
      config: loadConfig(alice.home), // the harness's normal (fast) pollMs: the periodic timer must do the work
      walletKey: alice.walletKey,
      lobby: alice.client.lobby,
      relay: alice.client.relay,
    });
    cleanups.push(() => restarted.stop());
    await restarted.start();
    expect(restarted.channelIds()).toEqual([]); // never re-opened into `live`

    // No explicit sweep() call: the queued record sweeps on its own over the next few periodic passes.
    await waitFor(() => new RecordStore(alice.home).channel(id)?.swept === true, 20_000, "auto-swept from the queue");
    const record = new RecordStore(alice.home).channel(id)!;
    expect(record.sweptAmount).toBeGreaterThan(0n);
    expect(await restarted.client.getBalance({ address: session })).toBeLessThan(record.sweptAmount!);

    // status()/channels() show the outcome (I2), and the settled-index cache (populated at start(), before the
    // sweep ran) was refreshed in place rather than left stale.
    const status = await restarted.status(id);
    expect(status.swept).toBe(true);
    expect(status.sweptAmount).toBe(record.sweptAmount!.toString());
    const listed = (await restarted.channels()).find((c) => c.channelId === id) as { swept?: unknown } | undefined;
    expect(listed?.swept).toBe(true);
  });

  it("fix round 2, minor 1: status()/channels() reflect a queued record swept via arena sweep, not only the automatic queue pass", async () => {
    const { alice, bob, id } = await matched();
    await settleWithSweepDisabled(alice, bob, id);
    const d = alice.daemon;
    await d.stop();
    const restarted = new ArenaDaemon({
      home: alice.home,
      config: { ...loadConfig(alice.home), pollMs: 3_600_000 }, // nothing auto-processes the queue during this test
      walletKey: alice.walletKey,
      lobby: alice.client.lobby,
      relay: alice.client.relay,
    });
    // start() fires one tick() of its own (fire-and-forget, regardless of pollMs), which would otherwise race
    // this test's own sweep(id) call for the very record it is about to queue-sweep automatically -- and since
    // that path (sweepQueuePass) already refreshes the cache correctly, letting it win would test nothing.
    (restarted as unknown as { sweepQueuePass(): Promise<void> }).sweepQueuePass = () => Promise.resolve();
    cleanups.push(() => restarted.stop());
    await restarted.start();
    expect(restarted.channelIds()).toEqual([]);

    const before = await restarted.status(id);
    expect(before.swept).toBeNull(); // the index cached a pre-sweep status at start()

    await restarted.sweep(id); // sweepOneNow's *queued* branch: the record is in the sweep queue, not live

    const record = new RecordStore(alice.home).channel(id)!;
    expect(record.swept).toBe(true);
    const after = await restarted.status(id);
    expect(after.swept).toBe(true); // the settled-index cache was refreshed here too, not just by sweepQueuePass
    expect(after.sweptAmount).toBe(record.sweptAmount!.toString());
  });

  it("fix round 2, important 3: a stale snapshot passed into sweepOneNow never overwrites a record the queue pass already swept", async () => {
    const { alice, bob, id } = await matched();
    await settleWithSweepDisabled(alice, bob, id);
    const d = alice.daemon;
    await d.stop();
    const restarted = new ArenaDaemon({
      home: alice.home,
      config: { ...loadConfig(alice.home), pollMs: 3_600_000 },
      walletKey: alice.walletKey,
      lobby: alice.client.lobby,
      relay: alice.client.relay,
    });
    cleanups.push(() => restarted.stop());
    await restarted.start();
    // sweep()'s bulk loop would have snapshotted every record once, right here, before doing any real work.
    const staleRecord = new RecordStore(alice.home).channel(id)!;
    expect(staleRecord.swept).toBeUndefined();

    // The main pass's own queue processing sweeps (and dequeues) the record first -- as it would while a bulk
    // sweep() call's loop was still iterating toward this same record.
    await (restarted as unknown as { sweepQueuePass(): Promise<void> }).sweepQueuePass();
    const afterQueue = new RecordStore(alice.home).channel(id)!;
    expect(afterQueue.swept).toBe(true);

    // sweep()'s bulk loop now reaches this record with its stale (pre-sweep) snapshot.
    const result = await (restarted as unknown as { sweepOneNow(r: unknown): Promise<{ swept: string }> }).sweepOneNow(staleRecord);
    expect(result.swept).toBe("already");
    const record = new RecordStore(alice.home).channel(id)!;
    expect(record.swept).toBe(true); // not overwritten with "dust"
    expect(record.sweptTx).toBe(afterQueue.sweptTx);
    expect(record.sweptAmount).toBe(afterQueue.sweptAmount);
  });

  it("fix round 2, minor 6: a concurrent handoff() is not lost by the sweep's own record update", async () => {
    const { alice, bob, id } = await matched();
    const original = await settleWithSweepDisabled(alice, bob, id);
    const d = alice.daemon;
    const l = d.handle(id);
    // The handoff races the sweep's own in-flight attempt: performSweep's very first action is an RPC round
    // trip (getBalance), a real await gap during which l.record can change underneath runSweepAttempt's own,
    // by-then-stale snapshot of it.
    const internals = d as unknown as { performSweep(sender: unknown): Promise<unknown> };
    const realPerformSweep = internals.performSweep.bind(d);
    internals.performSweep = async (...args: unknown[]) => {
      await d.handoff(id, "human", "reviewing");
      return realPerformSweep(...(args as [unknown]));
    };
    try {
      (d as unknown as SweepableDaemon).sweepChannel = original;
      await waitFor(() => l.record.swept !== undefined, 20_000, "swept despite the concurrent handoff");
      expect(l.record.swept).toBe(true);
      expect(l.record.sweptAmount).toBeGreaterThan(0n);
      expect(l.record.controller).toBe("human"); // the handoff's change was not clobbered
      expect(l.record.note).toBe("reviewing");
      expect(new RecordStore(alice.home).channel(id)!.controller).toBe("human"); // and it was persisted, not just in memory
    } finally {
      internals.performSweep = realPerformSweep;
    }
  });

  it("fix round 2, minor 2: a sweep whose receipt lagged (TxReceiptMissingError) is recovered on the next attempt, not resent", async () => {
    const { alice, bob, id } = await matched();
    const original = await settleWithSweepDisabled(alice, bob, id);
    const d = alice.daemon;
    const l = d.handle(id);
    const sender = l.sessionSender;

    // A real, sweep-shaped transaction, sent and mined directly (bypassing performSweep) -- a genuine landed
    // transaction whose receipt the daemon is then made to "lose track of".
    const balance = await d.client.getBalance({ address: sender.address });
    const gas = 21_000n;
    const { maxFeePerGas } = await d.client.estimateFeesPerGas();
    const value = balance - gas * ((maxFeePerGas * 13n + 9n) / 10n);
    const req = { to: alice.address, data: "0x" as Hex, value, gas };
    const hash = await sender.send(req);
    await d.client.waitForTransactionReceipt({ hash });
    // The real waitOrReplace would have called tracker.settle(hash) right before throwing TxReceiptMissingError
    // (tx.ts); simulated here since this test drives the error directly rather than the slow lagging-round path.
    sender.tracker?.settle(hash);

    const internals = d as unknown as { performSweep(sender: unknown): Promise<unknown> };
    const realPerformSweep = internals.performSweep.bind(d);
    internals.performSweep = () => Promise.reject(new TxReceiptMissingError(hash, 0n));
    (d as unknown as SweepableDaemon).sweepChannel = original;
    await waitFor(() => l.sweep.pendingTx === hash, 10_000, "the hash is remembered for the next attempt");
    expect(l.record.swept).toBeUndefined(); // not yet recorded: this attempt only remembered the hash
    internals.performSweep = realPerformSweep; // the recovery path below must not need it at all

    const walletBefore = await d.client.getBalance({ address: alice.address });
    await waitFor(() => l.record.swept !== undefined, 20_000, "recovered on the next attempt");
    expect(l.record.swept).toBe(true);
    expect(l.record.sweptAmount).toBe(value);
    expect(l.record.sweptTx).toBe(hash);
    expect(l.sweep.pendingTx).toBeUndefined();
    // No new transaction was sent: the wallet's balance is unchanged by this recovery (its money already arrived
    // with the first, real send above).
    expect(await d.client.getBalance({ address: alice.address })).toBe(walletBefore);
  });

  it(
    "fix round 2, minor 3: a receipt wait that would never resolve is bounded by sweep()'s own budget, on --channel too",
    async () => {
      const { alice, bob, id } = await matched();
      await settleWithSweepDisabled(alice, bob, id);
      const d = alice.daemon;
      const testClient = createTestClient({ mode: "anvil", chain: CHAIN, transport: http(RPC) });
      await testClient.setAutomine(false);
      try {
        const started = Date.now();
        // Nothing will ever mine the sweep's own transaction: without a giveUpAt threaded down into
        // performSweep's waitOrReplace, this would poll for up to RECEIPT_TIMEOUT_MS (30s) per round across
        // MAX_REPLACEMENTS+1 rounds -- tens of seconds to ~2 minutes -- for this one `--channel` record alone.
        const { results } = await d.sweep(id, { budgetMs: 300 });
        const elapsed = Date.now() - started;
        expect(elapsed).toBeLessThan(10_000); // bounded by the 300ms budget, not the receipt-wait's own timeouts
        expect(results).toHaveLength(1);
        expect(results[0].swept).toMatch(/^error:/); // stuck, not abandoned or falsely reported swept
        expect(alice.daemon.handle(id).record.swept).toBeUndefined();
      } finally {
        await testClient.setAutomine(true);
        await testClient.mine({ blocks: 1 }); // lands the sweep's own stuck send so the key is left clean
      }
    },
    15_000,
  );

  it("fix round 2, minor 4: `sweep --channel` re-checks an already-swept channel's key balance and sweeps a late top-up", async () => {
    const { alice, bob, id } = await matched();
    await settleWithSweepDisabled(alice, bob, id); // automatic sweeping stays off: only the explicit calls below sweep
    const d = alice.daemon;
    const l = d.handle(id);
    const session = l.sessionSender.address;

    const first = await d.sweep(id);
    expect(first.results[0].swept).toMatch(/^0x[0-9a-f]+$/);
    expect(l.record.swept).toBe(true);
    const firstTx = first.results[0].hash;

    // Documented (minor 4): a wallet-side refill that was in flight, or a manual top-up, can land on the session
    // key after this sweep already ran and reported "true" -- comfortably above dust, not the sweep's own
    // untouched fee reserve (see minor 4's "already" path for that case, covered by the pre-existing
    // "an already-swept channel ... reports already" test just above).
    const topUp = 1_000_000_000_000_000n;
    await setEthBalance(session, topUp);
    const walletBefore = await d.client.getBalance({ address: alice.address });

    const second = await d.sweep(id);
    expect(second.results).toEqual([{ channelId: id, swept: expect.stringMatching(/^0x[0-9a-f]+$/), hash: expect.any(String) }]);
    expect(second.results[0].hash).not.toBe(firstTx); // a new transaction, not the first sweep's own
    expect(l.record.sweptTx).toBe(second.results[0].hash); // the record now reflects the *new* sweep
    expect(await d.client.getBalance({ address: alice.address })).toBeGreaterThan(walletBefore);
    expect(await d.client.getBalance({ address: session })).toBeLessThan(topUp); // actually swept, not left sitting there
  });

  it("fix round 2, minor 5: the dust boundary is exact -- gas*(ceil(1.3F)+F) declines, one wei above sweeps", async () => {
    const gas = 21_000n;
    // A fixed F, not a live read: the real market fee can (and, in practice, does) drift by the time the periodic
    // pass gets around to reading it itself -- enough to tip a balance chosen to land exactly on the boundary
    // computed from an earlier read. currentFeePerGas is stubbed to this fixed value below so the boundary this
    // test computes and the one performSweep actually applies are guaranteed to be the same number.
    const F = 1_500_000_000n;
    const reserve = (F * SWEEP_HEADROOM_NUM + (SWEEP_HEADROOM_DEN - 1n)) / SWEEP_HEADROOM_DEN; // ceil(1.3F)
    // `value = balance - gas*reserve` is dust once `value <= gas*F` -- i.e. `balance <= gas*(reserve+F)` exactly.
    const boundary = gas * (reserve + F);

    // Exactly at the boundary: declined, recorded "dust", the balance left untouched.
    {
      const { alice, bob, id } = await matched();
      const original = await settleWithSweepDisabled(alice, bob, id);
      const d = alice.daemon as unknown as SweepableDaemon & { currentFeePerGas(): Promise<bigint> };
      d.currentFeePerGas = () => Promise.resolve(F);
      const l = alice.daemon.handle(id);
      const session = l.sessionSender.address;
      await setEthBalance(session, boundary);
      d.sweepChannel = original;
      await waitFor(() => l.record.swept !== undefined, 20_000, "declined at the boundary");
      expect(l.record.swept).toBe("dust");
      expect(l.record.sweptAmount).toBeUndefined();
      expect(await alice.daemon.client.getBalance({ address: session })).toBe(boundary); // untouched: no transaction sent
    }

    // One wei above the same boundary: no longer dust -- a real sweep.
    {
      const { alice, bob, id } = await matched();
      const original = await settleWithSweepDisabled(alice, bob, id);
      const d = alice.daemon as unknown as SweepableDaemon & { currentFeePerGas(): Promise<bigint> };
      d.currentFeePerGas = () => Promise.resolve(F);
      const l = alice.daemon.handle(id);
      const session = l.sessionSender.address;
      await setEthBalance(session, boundary + 1n);
      d.sweepChannel = original;
      await waitFor(() => l.record.swept !== undefined, 20_000, "swept one wei above the boundary");
      expect(l.record.swept).toBe(true);
      expect(l.record.sweptAmount).toBeGreaterThan(0n);
    }
  });
});

describe("Plan 5 Task 1: settled index", () => {
  /** Plays a quick draw and closes both sides, so `id` settles (Finalized). */
  async function settleByDraw(alice: Awaited<ReturnType<typeof matched>>["alice"], bob: Awaited<ReturnType<typeof matched>>["bob"], id: Hex) {
    await alice.daemon.move(id, "e4", { actor: "agent", offerDraw: true });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    await bob.daemon.acceptDraw(id, "agent");
    await waitFor(async () => (await alice.daemon.status(id)).attention === "game-over", 5_000, "draw seen");
    await alice.daemon.close(id, "agent");
    await waitFor(async () => (await bob.daemon.status(id)).attention === "close-requested", 5_000, "close requested");
    await bob.daemon.close(id, "agent");
    await waitFor(() => alice.daemon.handle(id).record.finalized, 20_000, "settled");
  }

  it("channels() lists settled channels after a restart (loaded from the index at start(), not re-opened)", async () => {
    const { alice, bob, id: id0 } = await matched();
    await settleByDraw(alice, bob, id0);
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id1 = await waitFor(() => alice.daemon.channelIds().find((c) => c !== id0), 20_000, "second match");
    await waitFor(() => bob.daemon.channelIds().includes(id1), 20_000, "bob's second match");
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id1)).phase === "Open", 20_000, "second open");
    await settleByDraw(alice, bob, id1);

    await alice.daemon.stop();
    await bob.daemon.stop();
    const restarted = new ArenaDaemon({
      home: alice.home,
      config: loadConfig(alice.home),
      walletKey: alice.walletKey,
      lobby: alice.client.lobby,
      relay: alice.client.relay,
    });
    cleanups.push(() => restarted.stop());
    await restarted.start();
    expect(restarted.channelIds()).toEqual([]); // finalized: never re-opened (existing I1 behaviour)
    const listed = await restarted.channels();
    expect(listed.map((c) => c.channelId).sort()).toEqual([id0, id1].sort());
    expect(listed.every((c) => "phase" in c && c.phase === "Finalized")).toBe(true);
    // Served directly too, without a `channels()` scan.
    expect((await restarted.status(id0)).phase).toBe("Finalized");
  });

  it("orders the loaded index by settledAt, newest first, capped at SETTLED_CACHE_MAX", async () => {
    const { alice, id } = await matched();
    await alice.daemon.stop();
    const realRecord = new RecordStore(alice.home).channel(id)!;
    const paths = arenaPaths(alice.home);
    const sessionSnapshot = readFileSync(paths.channelSession(id), "utf8");
    // A handful of synthetic finalized records, cloned from one real (never-settled, but that only affects
    // `phase`, not the ordering this test checks) channel's session file, each with its own settledAt. Finalized
    // records skip the params/channelId hash check (see openChannel's docstring), so the clones need only a
    // canonical id of their own.
    const settledAts = [500, 100, 900, 300];
    const cloneIds = settledAts.map((_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex);
    for (const [i, sat] of settledAts.entries()) {
      const cloneId = cloneIds[i];
      const clone: ChannelRecord = { ...realRecord, channelId: cloneId, finalized: true, finalPhase: "Finalized", settledAt: sat, swept: true };
      mkdirSync(join(alice.home, "channels", cloneId), { recursive: true });
      new RecordStore(alice.home).saveChannel(clone);
      writeFileSync(paths.channelSession(cloneId), sessionSnapshot);
    }
    const restarted = new ArenaDaemon({
      home: alice.home,
      config: loadConfig(alice.home),
      walletKey: alice.walletKey,
      lobby: alice.client.lobby,
      relay: alice.client.relay,
    });
    cleanups.push(() => restarted.stop());
    await restarted.start();
    const listed = await restarted.channels();
    const ordered = listed.map((c) => c.channelId).filter((cid) => cloneIds.includes(cid as Hex));
    // Newest (highest settledAt) first: 900, 500, 300, 100 -> cloneIds[2], cloneIds[0], cloneIds[3], cloneIds[1].
    // (SETTLED_CACHE_MAX itself -- the cap on how many are kept -- is exercised only at this small scale here;
    // see the report's concerns for the untested large-N boundary.)
    expect(ordered).toEqual([cloneIds[2], cloneIds[0], cloneIds[3], cloneIds[1]]);
  });

  it("fix round I4: trims by settledAt (oldest dropped), not insertion order, past SETTLED_CACHE_MAX entries", async () => {
    const { alice } = await matched();
    const d = alice.daemon as unknown as {
      insertSettled(id: Hex, status: unknown, settledAt: number): void;
      settled: Map<Hex, { status: { channelId: Hex }; settledAt: number }>;
    };
    // SETTLED_CACHE_MAX + a handful more, inserted in an order that does NOT match settledAt order (a plain FIFO
    // eviction, keyed on insertion order, would drop the wrong ones): the newest-settledAt entries are inserted
    // first, then a run of older ones, so a FIFO trim would keep the (wrong) newest-inserted-but-oldest-settled
    // ones and drop the genuinely newest.
    const total = SETTLED_CACHE_MAX + 5;
    const ids: Hex[] = [];
    for (let i = 0; i < total; i++) {
      const id = `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex;
      ids.push(id);
      // Insert order: i = 0..4 get the HIGHEST settledAt values (inserted first); i = 5.. get lower ones
      // (inserted after) -- the opposite of settledAt order, so insertion-order (FIFO) trimming would keep
      // exactly the wrong five and drop five of the genuinely newest.
      const settledAt = i < 5 ? 1_000_000 - i : total - i;
      d.insertSettled(id, { channelId: id }, settledAt);
    }
    expect(d.settled.size).toBe(SETTLED_CACHE_MAX);
    // The five inserted first (highest settledAt: 1000000..999996) must all still be present.
    for (let i = 0; i < 5; i++) expect(d.settled.has(ids[i])).toBe(true);
    // The five with the very lowest settledAt (inserted last, ids[total-5..total-1], settledAt 5..1) must be the
    // ones dropped -- a FIFO trim (oldest-inserted-first) would instead have dropped ids[0..4].
    for (let i = total - 5; i < total; i++) expect(d.settled.has(ids[i])).toBe(false);
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
    // fails, and (Plan 5 fix round, rule 1) the same pass's sweep gate re-reads the chain too and fails the same
    // way. (The phase is faked: this is the daemon's bookkeeping, not the hub's.)
    const hub = alice.daemon.hub;
    const real = hub.channelInfo.bind(hub);
    let call = 0;
    hub.channelInfo = async (c) => {
      call++;
      if (call === 1) return real(c); // the pass's first read
      if (call === 2) return { ...(await real(c)), phase: "Finalized" }; // step 4: settled
      throw new Error("HTTP request failed."); // refreshChain, then the sweep gate's own fresh read
    };
    alice.daemon.handle(id).lastError = "watch: HTTP request failed."; // from an earlier failed pass
    await alice.daemon.idle();
    await alice.daemon.mainPass(); // the main pass alone (the dispute pass would take the first read)
    expect(call).toBe(4);
    expect(alice.daemon.handle(id).record.finalized).toBe(true);
    // Before the fix: "watch: HTTP request failed." for good.
    expect(alice.daemon.handle(id).lastError).toBeNull();
    // The sweep gate's own failure never sets lastError either (the channel is already settled).
    expect(alice.daemon.handle(id).record.swept).toBeUndefined(); // the gate's read failed: not yet swept
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
