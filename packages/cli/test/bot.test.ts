import type { Address, Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { increaseTime, mintUsdc, setPaused, usdcBalance } from "../../sdk/test/helpers/chain.js";
import { mulberry32 } from "../../sdk/test/helpers/fixtures.js";
import { pickMove, runBot } from "../src/bot.js";
import type { ArenaDaemon } from "../src/daemon.js";
import type { ChannelStatus } from "../src/status.js";
import { START, startPair, waitFor } from "./helpers/harness.js";

const FAKE_CHANNEL_ID = `0x${"1".repeat(64)}` as Hex;

/** A minimal `ChannelStatus` with just the fields `actOnChannel` actually reads, for fake-daemon unit tests of
 *  the challenge back-off/cooldown logic below that need no chain, no Anvil and no real game at all. */
function fakeStatus(overrides: Partial<ChannelStatus> = {}): ChannelStatus {
  return {
    channelId: FAKE_CHANNEL_ID,
    controller: "agent",
    attention: "opponent-silent",
    gameIndex: 0,
    cooldown: { meSeconds: 0, opponentSeconds: 0 },
    suggestedActions: [],
    ...overrides,
  } as unknown as ChannelStatus;
}

/** A fake `ArenaDaemon` exposing only the surface `runBot` touches -- `channels` is required; `challenge`/
 *  `move`/`nextGame`/`close` default to a harmless no-op and are overridden by whichever one a test cares
 *  about. The standing-offer check still runs every pass with `offers: 0`, so `listOffers`/`hub.feeConfig` must
 *  resolve to something, even though `maintainOffers` returns before ever reading them when `need <= 0`. */
function fakeDaemon(overrides: {
  channels: () => Promise<ChannelStatus[]>;
  challenge?: (id: Hex, actor: string) => Promise<void>;
  move?: (id: Hex, move: string, opts: { actor: string }) => Promise<void>;
  nextGame?: (id: Hex, actor: string) => Promise<void>;
  close?: (id: Hex, actor: string) => Promise<void>;
}): ArenaDaemon {
  return {
    wait: async () => ({ channelId: null, reason: "timeout" }),
    channels: overrides.channels,
    listOffers: async () => [],
    hub: { feeConfig: async () => ({ feePerPlayer: 0n, feeRecipient: "0x0000000000000000000000000000000000000000" as Address }) },
    client: { readContract: async () => 0n },
    wallet: { address: "0x0000000000000000000000000000000000000000" as Address },
    challenge: overrides.challenge ?? (async () => {}),
    move: overrides.move ?? (async () => {}),
    nextGame: overrides.nextGame ?? (async () => {}),
    close: overrides.close ?? (async () => {}),
  } as unknown as ArenaDaemon;
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

// ------------------------------------------------------------------------------------------------- pickMove (unit)

describe("pickMove", () => {
  it("plays a one-move checkmate when one is available, regardless of randomness", () => {
    // Scholar's mate: 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6, and White has Qxf7#.
    const fen = "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4";
    expect(pickMove(fen, () => 0.999)).toBe("h5f7");
    expect(pickMove(fen, () => 0)).toBe("h5f7");
  });

  it("captures the most valuable qualifying piece when no mate is available", () => {
    // White knight on d4 can capture a bishop (c6, value 3) or a rook (b5, value 5); both are worth at least as
    // much as the knight (3), so the rook capture -- the higher value -- must win regardless of randomness.
    const fen = "4k3/8/2b5/1r6/3N4/8/8/4K3 w - - 0 1";
    expect(pickMove(fen, () => 0)).toBe("d4b5");
    expect(pickMove(fen, () => 0.999)).toBe("d4b5");
  });

  it("never picks a capture of a piece worth less than the capturing piece over a qualifying one", () => {
    // Same shape, but the knight could also take an undefended pawn (c2, value 1 < 3) -- never the "most
    // valuable" since it does not qualify; the rook (value 5) still wins.
    const fen = "4k3/8/2b5/1r6/3N4/8/2p5/4K3 w - - 0 1";
    expect(pickMove(fen, () => 0)).toBe("d4b5");
  });

  it("falls back to a random legal move when there is nothing to capture or check with", () => {
    const fen = "4k3/8/8/8/3N4/8/8/4K3 w - - 0 1"; // lone knight and kings: no captures, no checks
    const rng = mulberry32(42);
    const move = pickMove(fen, rng);
    expect(move).toMatch(/^[a-h][1-8][a-h][1-8]$/);
  });
});

// ------------------------------------------------------------------------- runBot's challenge retry (fake daemon)

describe("runBot: the opponent-silent challenge retries instead of giving up after one failure", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fix round (critical 1): a challenge that fails once is retried with back-off, and succeeds on a later pass", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let challenged = false;
    const challenge = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("boom: a transient RPC blip");
      challenged = true;
    });
    // Once the real `challenge()` succeeds, attention goes quiet (see the cooldown test below for why) -- without
    // this, the fake would keep reporting `opponent-silent` forever and the bot would (correctly, for a *real*
    // silent opponent) keep challenging again on every pass, which isn't what this test is about.
    const daemon = fakeDaemon({ channels: async () => [fakeStatus({ attention: challenged ? null : "opponent-silent" })], challenge });
    const controller = new AbortController();
    const logs: string[] = [];
    const done = runBot(daemon, {
      usdc: "0x0000000000000000000000000000000000000000" as Address,
      deposit: 0n,
      stake: 0n,
      offers: 0,
      offerRecheckMs: 1_000_000,
      waitTimeoutMs: 50,
      moveDelayMs: 0,
      challengeBackoffStartMs: 3_000,
      challengeBackoffMaxMs: 10_000,
      log: (l) => logs.push(l),
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(10); // the first pass runs essentially immediately
    expect(calls).toBe(1); // the first attempt failed

    // Several outer passes (the loop's own 1s idle sleep) go by, but the 3s challenge back-off is not up yet.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(calls).toBe(1);

    // Now past the 3s back-off: the next pass retries, and this time it succeeds.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toBe(2);
    expect(logs.some((l) => /challenge on .* failed \(attempt 1, retrying in 3s\)/.test(l))).toBe(true);

    // Settled (attention quiet): no further attempts, ever.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(2);

    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    await done;
  }, 5_000);

  it("fix round (critical 1): waits out status.cooldown.meSeconds (an InCooldown-style refusal) before retrying", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const cooldownSecondsAt0 = 5;
    // Once the real `challenge()` succeeds, the channel goes Challenged and (per daemon.ts's own buildStatus,
    // confirmed in hardening.test.ts) attention goes quiet -- modeled here so a successful call doesn't keep
    // reporting `opponent-silent` forever and sending this fake straight into an unthrottled retry loop.
    let challenged = false;
    const challenge = vi.fn(async () => {
      challenged = true;
    });
    const channels = async () => {
      if (challenged) return [fakeStatus({ attention: null })];
      const elapsedS = (Date.now() - startedAt) / 1000;
      const remaining = Math.max(0, cooldownSecondsAt0 - elapsedS);
      return [fakeStatus({ cooldown: { meSeconds: Math.ceil(remaining), opponentSeconds: 0 } })];
    };
    const daemon = fakeDaemon({ channels, challenge });
    const controller = new AbortController();
    const done = runBot(daemon, {
      usdc: "0x0000000000000000000000000000000000000000" as Address,
      deposit: 0n,
      stake: 0n,
      offers: 0,
      offerRecheckMs: 1_000_000,
      waitTimeoutMs: 50,
      moveDelayMs: 0,
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(challenge).not.toHaveBeenCalled(); // still in cooldown

    await vi.advanceTimersByTimeAsync(3_000);
    expect(challenge).not.toHaveBeenCalled(); // still in cooldown (5s total)

    await vi.advanceTimersByTimeAsync(3_000); // now past the 5s cooldown
    expect(challenge).toHaveBeenCalledTimes(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    await done;
  }, 5_000);

  it("fix round (item 6 follow-on): a second silence episode after the challenge record is cleared challenges again", async () => {
    // attention !== "opponent-silent" clears the record (see actOnChannel); a later opponent-silent episode on
    // the same channel must not be treated as already-attempted.
    vi.useFakeTimers();
    let attention: ChannelStatus["attention"] = "opponent-silent";
    const challenge = vi.fn(async () => {
      throw new Error("boom");
    });
    const daemon = fakeDaemon({ channels: async () => [fakeStatus({ attention })], challenge });
    const controller = new AbortController();
    const done = runBot(daemon, {
      usdc: "0x0000000000000000000000000000000000000000" as Address,
      deposit: 0n,
      stake: 0n,
      offers: 0,
      offerRecheckMs: 1_000_000,
      waitTimeoutMs: 50,
      moveDelayMs: 0,
      challengeBackoffStartMs: 60_000,
      challengeBackoffMaxMs: 300_000,
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(challenge).toHaveBeenCalledTimes(1); // episode 1: the one and only attempt (then a long back-off)

    // The episode ends (e.g. the opponent finally moved) before the 60s back-off would have allowed a retry.
    attention = null;
    await vi.advanceTimersByTimeAsync(1_500);

    // Episode 2 starts: despite the still-running 60s back-off from episode 1, a fresh episode retries at once.
    attention = "opponent-silent";
    await vi.advanceTimersByTimeAsync(1_500);
    expect(challenge).toHaveBeenCalledTimes(2);

    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    await done;
  }, 5_000);

  it("board rate-limit fix: never challenges on a chainStale status (silence judged on a stale chain view); does once it is fresh", async () => {
    // channels() now lists a channel whose chain refresh failed from its last read, `chainStale`, instead of throwing
    // (which left the bot with no channels that pass). Silence is a chain-time judgment: a dispute on it waits for a
    // fresh read. Moves and co-signing (session state) still go ahead on such a status.
    vi.useFakeTimers();
    let stale = true;
    let challenged = false;
    const challenge = vi.fn(async () => {
      challenged = true;
    });
    // Once challenged, attention goes quiet: a fake that kept reporting opponent-silent would be challenged on every
    // pass with no idle sleep between (a successful action skips it) -- a hot loop under fake timers.
    const daemon = fakeDaemon({
      channels: async () => [
        fakeStatus({
          attention: challenged ? null : "opponent-silent",
          ...(stale ? { chainStale: true, chainStaleReason: "the RPC is rate-limiting (HTTP 429)" } : {}),
        }),
      ],
      challenge,
    });
    const controller = new AbortController();
    const done = runBot(daemon, {
      usdc: "0x0000000000000000000000000000000000000000" as Address,
      deposit: 0n,
      stake: 0n,
      offers: 0,
      offerRecheckMs: 1_000_000,
      waitTimeoutMs: 50,
      moveDelayMs: 0,
      challengeBackoffStartMs: 3_000,
      challengeBackoffMaxMs: 10_000,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(5_000); // several passes
    expect(challenge).not.toHaveBeenCalled();
    stale = false;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(challenge).toHaveBeenCalledTimes(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    await done;
  }, 5_000);
});

// ------------------------------------------------------------------------ runBot's generic action retry (fake daemon)

describe("runBot: a persistently failing action backs off instead of hot-looping", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

  it("fix round (important 2): a move that always fails is retried on a bounded, growing schedule, not every pass", async () => {
    vi.useFakeTimers();
    const move = vi.fn(async () => {
      throw new Error("boom: always fails");
    });
    const daemon = fakeDaemon({ channels: async () => [fakeStatus({ attention: "your-turn", fen: START_FEN })], move });
    const controller = new AbortController();
    const logs: string[] = [];
    const done = runBot(daemon, {
      usdc: "0x0000000000000000000000000000000000000000" as Address,
      deposit: 0n,
      stake: 0n,
      offers: 0,
      offerRecheckMs: 1_000_000,
      waitTimeoutMs: 50,
      moveDelayMs: 0,
      rng: mulberry32(99),
      log: (l) => logs.push(l),
      signal: controller.signal,
    });

    // 60s of fake time: with 1s-doubling-to-30s back-off, that's at most ~1+1+2+4+8+16+30 ~= a handful of
    // attempts -- a world away from "once per pass" (the loop's own 1s idle floor alone would allow ~60).
    await vi.advanceTimersByTimeAsync(60_000);

    expect(move.mock.calls.length).toBeGreaterThanOrEqual(5); // it does keep retrying...
    expect(move.mock.calls.length).toBeLessThanOrEqual(10); // ...but on a bounded, growing schedule
    expect(logs.some((l) => /move .* failed \(attempt 1, retrying in 1s\)/.test(l))).toBe(true);
    expect(logs.some((l) => /retrying in 30s/.test(l))).toBe(true); // it did reach the cap within 60s

    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    await done;
  }, 5_000);
});

// -------------------------------------------------------------------------------------------- runBot (Anvil, :8546)

describe("runBot", () => {
  it(
    "posts a standing offer, plays to a terminal state, accepts the next game, co-signs the close -- exact balances",
    async () => {
      const pair = await startPair();
      cleanup = pair.cleanup;
      const { alice, bob, env } = pair;
      const controller = new AbortController();
      const logs: string[] = [];
      const botDone = runBot(alice.daemon, {
        usdc: env.usdc,
        deposit: 1_000_000n,
        stake: 100_000n,
        offers: 1,
        idleCloseMs: 30_000,
        offerRecheckMs: 250,
        waitTimeoutMs: 250,
        moveDelayMs: 10,
        rng: mulberry32(7),
        log: (l) => logs.push(l),
        signal: controller.signal,
      });

      const offerId = await waitFor(
        async () => (await alice.daemon.listOffers()).find((o) => o.mine)?.offerId,
        10_000,
        "the bot's standing offer",
      );
      await bob.daemon.acceptOffer(offerId!);
      const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
      await waitFor(async () => (await alice.daemon.status(id)).phase === "Open", 30_000, "open");

      // Scripted opponent: resign the instant it is Bob's move -- works whichever colour Bob is dealt (White
      // moves first in game 0, so Bob may need to wait for the bot's own first move before this fires).
      await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 20_000, "bob's turn in game 0");
      await bob.daemon.resign(id, "agent");
      await waitFor(async () => (await alice.daemon.status(id)).attention === "game-over", 10_000, "game 0 over");

      // The opponent proposes game 1; the bot (still well inside its 30s idle-close window) must accept it.
      await bob.daemon.nextGame(id, "agent");
      await waitFor(async () => (await alice.daemon.status(id)).gameIndex === 1, 10_000, "game 1 started");

      await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 20_000, "bob's turn in game 1");
      await bob.daemon.resign(id, "agent");
      await waitFor(async () => (await alice.daemon.status(id)).attention === "game-over", 10_000, "game 1 over");

      // The opponent requests the close; the bot must co-sign it.
      await bob.daemon.close(id, "agent");
      await waitFor(async () => (await alice.daemon.status(id)).phase === "Finalized", 20_000, "finalized");

      controller.abort();
      await botDone;

      // Bob resigned both games: the bot (Alice) wins both stakes; the fee was paid once per player at funding.
      expect(await usdcBalance(env.usdc, alice.address)).toBe(START - 5_000n + 2n * 100_000n);
      expect(await usdcBalance(env.usdc, bob.address)).toBe(START - 5_000n - 2n * 100_000n);
      expect(await usdcBalance(env.usdc, env.host)).toBe(10_000n);
    },
    60_000,
  );

  it(
    "re-posts a standing offer once the first one is matched",
    async () => {
      const pair = await startPair();
      cleanup = pair.cleanup;
      const { alice, bob, env } = pair;
      const controller = new AbortController();
      const botDone = runBot(alice.daemon, {
        usdc: env.usdc,
        deposit: 1_000_000n,
        stake: 100_000n,
        offers: 1,
        idleCloseMs: 30_000,
        offerRecheckMs: 200,
        waitTimeoutMs: 200,
        moveDelayMs: 10,
        rng: mulberry32(11),
        signal: controller.signal,
      });

      const firstOfferId = await waitFor(
        async () => (await alice.daemon.listOffers()).find((o) => o.mine)?.offerId,
        10_000,
        "first standing offer",
      );
      await bob.daemon.acceptOffer(firstOfferId!);
      await waitFor(() => alice.daemon.channelIds().length === 1, 20_000, "matched");

      const secondOfferId = await waitFor(
        async () => (await alice.daemon.listOffers()).find((o) => o.mine && o.offerId !== firstOfferId)?.offerId,
        10_000,
        "a freshly re-posted offer",
      );
      expect(secondOfferId).toBeDefined();
      expect(secondOfferId).not.toBe(firstOfferId);

      controller.abort();
      await botDone;
    },
    40_000,
  );

  it(
    "stops posting once it cannot afford another offer, and resumes once its balance recovers",
    async () => {
      const pair = await startPair();
      cleanup = pair.cleanup;
      const { alice, env } = pair;
      const controller = new AbortController();
      const logs: string[] = [];
      // deposit + fee (6_005_000) fits once out of a 10_000_000 balance, but not twice.
      const botDone = runBot(alice.daemon, {
        usdc: env.usdc,
        deposit: 6_000_000n,
        stake: 100_000n,
        offers: 2,
        offerRecheckMs: 150,
        waitTimeoutMs: 150,
        signal: controller.signal,
        log: (l) => logs.push(l),
      });

      await waitFor(async () => (await alice.daemon.listOffers()).filter((o) => o.mine).length === 1, 10_000, "one offer posted");
      // Give it a few more recheck passes: it must not post a second one, and must log the shortfall exactly once.
      await new Promise((r) => setTimeout(r, 700));
      expect((await alice.daemon.listOffers()).filter((o) => o.mine).length).toBe(1);
      expect(logs.filter((l) => l.includes("too low")).length).toBe(1);

      await mintUsdc(env.usdc, alice.address, 10_000_000n);
      await waitFor(async () => (await alice.daemon.listOffers()).filter((o) => o.mine).length === 2, 10_000, "resumed posting");
      expect(logs.some((l) => l.includes("recovered"))).toBe(true);

      controller.abort();
      await botDone;
    },
    30_000,
  );

  it(
    "fix round (important 3): a paused hub produces one log line over several passes, and resumes once unpaused",
    async () => {
      const pair = await startPair();
      cleanup = pair.cleanup;
      const { alice, env } = pair;
      await setPaused(env.hub, true);

      const controller = new AbortController();
      const logs: string[] = [];
      const botDone = runBot(alice.daemon, {
        usdc: env.usdc,
        deposit: 1_000_000n,
        stake: 100_000n,
        offers: 1,
        offerRecheckMs: 100,
        waitTimeoutMs: 100,
        offerBlockBackoffMs: 300,
        signal: controller.signal,
        log: (l) => logs.push(l),
      });

      // Several recheck passes, and several 300ms back-off cycles, all while still paused.
      await new Promise((r) => setTimeout(r, 1_000));
      expect((await alice.daemon.listOffers()).filter((o) => o.mine).length).toBe(0);
      expect(logs.filter((l) => l.includes("the hub is paused")).length).toBe(1);

      await setPaused(env.hub, false);
      await waitFor(async () => (await alice.daemon.listOffers()).filter((o) => o.mine).length === 1, 10_000, "resumed posting once unpaused");
      expect(logs.some((l) => l.includes("standing offers resumed"))).toBe(true);

      controller.abort();
      await botDone;
    },
    30_000,
  );

  it(
    "idle-closes a finished game and recovers its funds by challenge + timeout when the opponent goes silent",
    async () => {
      const pair = await startPair();
      cleanup = pair.cleanup;
      const { alice, bob, env } = pair;
      const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 60n });
      await bob.daemon.acceptOffer(offerId);
      const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
      await waitFor(async () => (await alice.daemon.status(id)).phase === "Open", 30_000, "open");

      // Alice (the offerer) is white in game 0, so the bot must already be running to play that first move --
      // it keeps running through the rest of the test, handling the idle-close and the challenge below too.
      const controller = new AbortController();
      const botDone = runBot(alice.daemon, {
        usdc: env.usdc,
        deposit: 1_000_000n,
        stake: 100_000n,
        offers: 0,
        idleCloseMs: 300,
        offerRecheckMs: 10_000,
        waitTimeoutMs: 200,
        moveDelayMs: 10,
        rng: mulberry32(13),
        signal: controller.signal,
      });

      await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 20_000, "bob's turn");
      await bob.daemon.resign(id, "agent");
      await waitFor(async () => (await alice.daemon.status(id)).attention === "game-over", 10_000, "game over");

      // The opponent disappears for good.
      await bob.daemon.stop();
      bob.client.disconnect();

      await waitFor(async () => (await alice.daemon.status(id)).closing === true, 10_000, "bot signed the close itself");

      await increaseTime(61); // past the 60s challengeTimeout: the bot sees opponent-silent and challenges
      await waitFor(async () => (await alice.daemon.status(id)).phase === "Challenged", 10_000, "bot challenged on-chain");

      await increaseTime(61); // past the challenge deadline: the daemon's own watchtower times it out
      await waitFor(async () => (await alice.daemon.status(id)).phase === "Finalized", 15_000, "settled by timeout");

      controller.abort();
      await botDone;

      // Bob resigned the only game played: the bot wins the one stake.
      expect(await usdcBalance(env.usdc, alice.address)).toBe(START - 5_000n + 100_000n);
    },
    60_000,
  );
});
