/**
 * Plan 4.5 Task 11: a CI load scenario over the real host server, real `arena daemon` processes and a real chain
 * (Anvil) -- 6 daemons, 9 channels open at once (a 3-regular pairing: each daemon in exactly 3 channels), random
 * games capped at 40 plies (forced to a draw at the cap so every game reaches a terminal state), then a cooperative
 * close. Must finish well under CI's budget (a few minutes).
 *
 * The server runs every daemon from 127.0.0.1, so this stack raises the per-IP limits that would otherwise throttle
 * nine simultaneous offers and connections from one source address -- the same way a production deployment behind
 * distinct client IPs would never hit them. See the Task 11 report for the exact values and why.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { HubClient } from "@arena/sdk";
import { readJson, type ChannelRecord } from "@arena/cli";
import { startStack, usdcBalanceOf, type Player, type Stack } from "./harness.js";
import { playRandomGameCapped, waitStatus, type Status } from "./bot.js";

const DEPOSIT = 1_000_000n;
const STAKE = 100_000n;
const START = 10_000_000n;
const FEE = 5_000n;
const N_DAEMONS = 6;
const PLY_CAP = 40;

let stack: Stack | undefined;
afterEach(async () => {
  await stack?.stop();
  stack = undefined;
}, 30_000);

// ------------------------------------------------------------------------------------------------------ helpers

function hubOf(s: Stack): { pub: PublicClient; hub: HubClient } {
  const pub = createPublicClient({ chain: foundry, transport: http(s.rpcUrl) }) as PublicClient;
  return { pub, hub: new HubClient(s.hub, pub) };
}

async function waitFor<T>(fn: () => Promise<T> | T, ms = 20_000, what = "condition"): Promise<Exclude<T, undefined | null | false>> {
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
  throw new Error(`timed out after ${ms}ms waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

async function postOffer(p: Player): Promise<Hex> {
  const { offerId } = await p.api("POST", "/offers", {
    deposit: DEPOSIT.toString(),
    stakePerGame: STAKE.toString(),
  });
  return offerId as Hex;
}

/** The channel id created by accepting `offerId`, found race-free (offerId is unique) even while several other
 *  channels are opening concurrently on the same daemon or the same stack. */
async function findChannelByOffer(p: Player, offerId: Hex): Promise<Hex> {
  return waitFor(async () => {
    const chans = (await p.api("GET", "/channels")) as Array<{ channelId: Hex }>;
    for (const c of chans) {
      const rec = readJson<ChannelRecord>(join(p.home, "channels", c.channelId, "record.json"));
      if (rec && rec.offerId.toLowerCase() === offerId.toLowerCase()) return c.channelId;
    }
    return undefined;
  }, 20_000, `${p.name}'s channel for offer ${offerId}`);
}

/** Cooperative close from both sides of a finished game, then waits for Finalized on chain and in both daemons. */
async function closeBoth(a: Player, b: Player, id: Hex, hub: HubClient): Promise<void> {
  const aStatus = (await a.api("GET", `/status?channel=${id}`)) as Status;
  await waitStatus(b, (s) => s.turnNum === aStatus.turnNum, 20_000, id);
  await a.api("POST", "/close", { channel: id });
  await waitStatus(b, (s) => s.opponentWantsToClose === true, 20_000, id);
  await b.api("POST", "/close", { channel: id });
  await waitFor(async () => (await hub.channelInfo(id)).phase === "Finalized", 30_000, `channel ${id} Finalized`);
  await waitStatus(a, (s) => s.phase === "Finalized", 20_000, id);
  await waitStatus(b, (s) => s.phase === "Finalized", 20_000, id);
}

/** Every channel of every daemon listed ends with no `lastError`. */
async function expectNoErrors(...players: Player[]): Promise<void> {
  for (const p of players) {
    const chs = (await p.api("GET", "/channels")) as Array<{ channelId: Hex; lastError: string | null }>;
    for (const c of chs) expect(c.lastError, `${p.name}'s lastError on ${c.channelId}`).toBeNull();
  }
}

const delta = (r: Status["gameStatus"]): bigint => (r === "white_won" ? STAKE : r === "black_won" ? -STAKE : 0n);

// ---------------------------------------------------------------------------------------------------------- test

describe("load: 6 daemons, 9 channels at once (Plan 4.5 Task 11)", () => {
  it(
    "every channel settles with conserving balances, no channel is ever Challenged, and ws connections drop to 0 after teardown",
    async () => {
      // Raised per-IP limits: every daemon here runs from 127.0.0.1, so nine simultaneous offers/opens would
      // otherwise hit the lobby's per-IP offer cap (default 5) and the connection cap (default 16) -- a production
      // deployment sees these spread across distinct client IPs instead. See the Task 11 report.
      stack = await startStack({
        serverOverrides: { limits: { wsPerIp: 64, maxOpenOffersPerIp: 64, httpPostBurst: 200 } },
      });
      const { hub } = hubOf(stack);

      // Sequential player creation: `fund()` sends from the shared deployer wallet with no nonce manager of its
      // own, so concurrent `player()` calls would race its nonce.
      const players: Player[] = [];
      for (let i = 0; i < N_DAEMONS; i++) players.push(await stack.player(`p${i}`));

      // 3-regular pairing over 6 daemons, 9 channels: the bipartite K(3,3) between {0,1,2} (offerers) and
      // {3,4,5} (accepters) -- every node has degree 3, no duplicate edges.
      const edges: Array<[number, number]> = [];
      for (const i of [0, 1, 2]) for (const j of [3, 4, 5]) edges.push([i, j]);
      expect(edges).toHaveLength(9);

      // The hub's commitment cap must allow all 9 channels' escrow (2*(deposit+fee) each) at once.
      const neededEscrow = 2n * BigInt(edges.length) * (DEPOSIT + FEE);
      const limitsBefore = await hub.limits();
      expect(
        limitsBefore.maxCommittedEscrow,
        "the hub's maxCommittedEscrow must cover all 9 channels' committed escrow at once",
      ).toBeGreaterThanOrEqual(neededEscrow);

      // Every channel funded at once: all 9 offers posted and accepted concurrently.
      const opened = await Promise.all(
        edges.map(async ([i, j]) => {
          const offerId = await postOffer(players[i]);
          await players[j].api("POST", "/offers/accept", { offerId });
          const id = await findChannelByOffer(players[j], offerId);
          await waitStatus(players[i], (s) => s.phase === "Open", 30_000, id);
          await waitStatus(players[j], (s) => s.phase === "Open", 30_000, id);
          return { white: players[i], black: players[j], id };
        }),
      );

      expect((await hub.limits()).committedEscrow).toBe(neededEscrow);

      // Random games, seeded, capped at 40 plies (a forced draw at the cap), all 9 channels concurrently.
      const results = await Promise.all(
        opened.map(async ({ white, black, id }, idx) => {
          await playRandomGameCapped(white, black, { channelId: id, seed: idx + 1, maxMoves: PLY_CAP, ms: 15_000 });
          const end = await waitStatus(white, (s) => s.gameStatus !== "playing" && s.gameStatus !== "draw_offered", 20_000, id);
          return end.gameStatus;
        }),
      );
      console.log(`[load] 9 games: ${results.join(", ")}`);

      // Close every channel.
      await Promise.all(opened.map(({ white, black, id }) => closeBoth(white, black, id, hub)));

      // All channels Finalized, and none was ever Challenged (a lost relay message would have forced one).
      for (const { id } of opened) {
        expect((await hub.channelInfo(id)).phase).toBe("Finalized");
        expect(await hub.disputeEvents(id), `channel ${id} must never have been Challenged`).toEqual([]);
      }

      // Exact balance conservation: for each player, the sum of its balance changes equals -fee*channels plus its
      // game results.
      const balanceDelta = new Map<number, bigint>(players.map((_, i) => [i, 0n]));
      edges.forEach(([i, j], k) => {
        const d = delta(results[k]);
        balanceDelta.set(i, balanceDelta.get(i)! + d - FEE);
        balanceDelta.set(j, balanceDelta.get(j)! - d - FEE);
      });
      for (let i = 0; i < N_DAEMONS; i++) {
        expect(await usdcBalanceOf(stack, players[i].address), `${players[i].name}'s USDC`).toBe(START + balanceDelta.get(i)!);
      }
      const hostBalance = await usdcBalanceOf(stack, stack.host);
      expect(hostBalance).toBe(2n * FEE * BigInt(edges.length));

      // Total-supply cross-check: nothing was minted or burned by the run.
      let total = hostBalance;
      for (const p of players) total += await usdcBalanceOf(stack, p.address);
      expect(total).toBe(START * BigInt(N_DAEMONS));

      // committedEscrow returns to 0.
      expect((await hub.limits()).committedEscrow).toBe(0n);

      // No lastError on any daemon.
      await expectNoErrors(...players);

      // After the daemons stop, the server's arena_ws_connections metric is 0.
      await Promise.all(players.map((p) => p.kill("SIGTERM")));
      await waitFor(
        async () => {
          const text = await (await fetch(`${stack!.serverUrl}/metrics`)).text();
          const m = /^arena_ws_connections (\d+)/m.exec(text);
          return m !== null && Number(m[1]) === 0;
        },
        15_000,
        "arena_ws_connections to reach 0 after every daemon stopped",
      );
    },
    170_000,
  );
});
