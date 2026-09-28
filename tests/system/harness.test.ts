import { afterEach, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { hasLockFile, startStack, usdcBalanceOf, type Player, type Stack } from "./harness.js";
import { playLine, waitStatus } from "./bot.js";
import { SCHOLARS_MATE } from "../../packages/sdk/test/helpers/fixtures.js";

const DEPOSIT = "1000000";
const STAKE = "100000";
const START = 10_000_000n;
const FEE = 5_000n;

let stack: Stack | undefined;
afterEach(async () => {
  await stack?.stop();
  stack = undefined;
}, 30_000);

/** Posts alice's offer, has bob accept it, and waits for both sides to see the channel Open. */
async function matchAndOpen(alice: Player, bob: Player): Promise<Hex> {
  const { offerId } = await alice.api("POST", "/offers", { deposit: DEPOSIT, stakePerGame: STAKE, challengeTimeout: "600" });
  await bob.api("POST", "/offers/accept", { offerId });
  const id = await waitFor(async () => {
    const channels = (await alice.api("GET", "/channels")) as Array<{ channelId: Hex }>;
    return channels[0]?.channelId;
  }, 20_000);
  await waitStatus(alice, (s) => s.phase === "Open", 30_000, id);
  await waitStatus(bob, (s) => s.phase === "Open", 30_000, id);
  return id;
}

async function waitFor<T>(fn: () => Promise<T> | T, ms = 20_000): Promise<Exclude<T, undefined | null | false>> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as Exclude<T, undefined | null | false>;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out after ${ms}ms${last ? `: ${String(last)}` : ""}`);
}

describe("system harness (real Anvil, real server, real `arena daemon` processes)", () => {
  it(
    "two process daemons over the real server: match -> scholar's mate -> cooperative close -> exact balances",
    async () => {
      stack = await startStack();
      const alice = await stack.player("alice");
      const bob = await stack.player("bob");

      const id = await matchAndOpen(alice, bob);
      await playLine(alice, bob, id, SCHOLARS_MATE); // alice (white, the offerer) mates; bob's daemon auto-resigns
      await waitStatus(alice, (s) => s.gameStatus === "white_won", 15_000, id);

      await alice.api("POST", "/close", { channel: id });
      await waitStatus(bob, (s) => s.attention === "close-requested", 15_000, id);
      await bob.api("POST", "/close", { channel: id });
      await waitStatus(alice, (s) => s.phase === "Finalized", 20_000, id);
      await waitStatus(bob, (s) => s.phase === "Finalized", 20_000, id);

      expect(await usdcBalanceOf(stack, alice.address)).toBe(START + 100_000n - FEE);
      expect(await usdcBalanceOf(stack, bob.address)).toBe(START - 100_000n - FEE);
      expect(await usdcBalanceOf(stack, stack.host)).toBe(2n * FEE);
    },
    120_000,
  );

  it(
    "SIGKILL mid-game leaves a stale lock; start() takes it over and the game continues",
    async () => {
      stack = await startStack();
      const alice = await stack.player("alice");
      const bob = await stack.player("bob");

      const id = await matchAndOpen(alice, bob);
      await alice.api("POST", "/move", { move: "e4", channel: id });
      await waitStatus(bob, (s) => s.myTurn, 10_000, id);

      await alice.kill("SIGKILL");
      expect(hasLockFile(alice.home)).toBe(true); // the lock is stale, not released -- SIGKILL gives no chance to clean up

      await alice.start(); // must succeed by taking the stale lock over, not by refusing "another daemon is using this home"
      await waitStatus(alice, (s) => s.phase === "Open", 15_000, id);

      await bob.api("POST", "/move", { move: "e5", channel: id });
      await waitStatus(alice, (s) => s.myTurn, 10_000, id);
      await alice.api("POST", "/move", { move: "Nf3", channel: id });
      await waitStatus(bob, (s) => s.myTurn, 10_000, id);
    },
    90_000,
  );
});
