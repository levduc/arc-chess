import { afterEach, describe, expect, it } from "vitest";
import { increaseTime, mintUsdc, usdcBalance } from "../../sdk/test/helpers/chain.js";
import { mulberry32 } from "../../sdk/test/helpers/fixtures.js";
import { pickMove, runBot } from "../src/bot.js";
import { START, startPair, waitFor } from "./helpers/harness.js";

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
