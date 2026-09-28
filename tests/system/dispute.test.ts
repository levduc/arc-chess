/**
 * Plan 4.5 Task 8 (spec §8.7): every dispute path end-to-end over the real host server, real `arena daemon`
 * processes and a real chain (Anvil). Each scenario runs on a fresh stack with `challengeTimeout = 60` (the hub's
 * `MIN_TIMEOUT`) and moves chain time with `increaseTime` instead of waiting. Every wait is a condition poll
 * (`waitStatus` or an on-chain read), never a fixed sleep. Balances are asserted exactly, from on-chain USDC
 * `balanceOf`.
 *
 * "No human step beyond X": each test calls only the daemon API the scenario names; every other on-chain action
 * (respond, timeout, reclaim, funding) must come from the daemons' own watchtowers.
 */
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createPublicClient, createTestClient, http, type Hex, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import {
  ChannelSession,
  HubClient,
  LocalKeyTxSender,
  channelHubAbi,
  isGameOver,
  playerOnMove,
  type Proof,
  type SessionSnapshot,
} from "@arena/sdk";
import { FileSessionStore, readJson, type ChannelRecord } from "@arena/cli";
import { startStack, usdcBalanceOf, type Player, type Stack } from "./harness.js";
import { playLine, playRandomGame, waitStatus, type Status } from "./bot.js";

const SCHOLARS_MATE = ["e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6", "h5f7"];

const DEPOSIT = 1_000_000n;
const STAKE = 100_000n;
const START = 10_000_000n;
const FEE = 5_000n;
const TIMEOUT = 60; // the hub's MIN_TIMEOUT
const FUNDING_WINDOW = 3600; // the harness server config's fundingWindow

let stack: Stack | undefined;
afterEach(async () => {
  await stack?.stop();
  stack = undefined;
}, 30_000);

// Per-scenario wall-clock times, printed at the end of the file (the Task 8 report needs them).
const times: Array<{ name: string; ms: number }> = [];
afterAll(() => {
  for (const t of times) console.log(`[dispute timing] ${(t.ms / 1000).toFixed(1)}s  ${t.name}`);
});
function timed(name: string, fn: () => Promise<void>, ms: number): void {
  it(
    name,
    async () => {
      const t0 = Date.now();
      try {
        await fn();
      } finally {
        times.push({ name, ms: Date.now() - t0 });
      }
    },
    ms,
  );
}

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

/** Polls the hub until the channel reaches `phase`. */
async function waitPhase(hub: HubClient, id: Hex, phase: string, ms = 20_000): Promise<void> {
  await waitFor(async () => (await hub.channelInfo(id)).phase === phase, ms, `on-chain phase ${phase}`);
}

async function postOffer(alice: Player): Promise<Hex> {
  const { offerId } = await alice.api("POST", "/offers", {
    deposit: DEPOSIT.toString(),
    stakePerGame: STAKE.toString(),
    challengeTimeout: String(TIMEOUT),
  });
  return offerId as Hex;
}

/** The accepter's one channel (the offerer may hold several, so its list is never indexed). */
async function channelOf(p: Player): Promise<Hex> {
  return waitFor(async () => {
    const channels = (await p.api("GET", "/channels")) as Array<{ channelId: Hex }>;
    return channels[0]?.channelId;
  }, 20_000, `${p.name}'s channel`);
}

/** Alice offers, `bob` accepts, and both daemons see the channel Open. Returns the channel id. */
async function matchAndOpen(alice: Player, bob: Player): Promise<Hex> {
  const offerId = await postOffer(alice);
  await bob.api("POST", "/offers/accept", { offerId });
  const id = await channelOf(bob);
  await waitStatus(alice, (s) => s.phase === "Open", 30_000, id);
  await waitStatus(bob, (s) => s.phase === "Open", 30_000, id);
  return id;
}

/** One move through the daemon API, then waits for `other` to hold it (use when `playLine` can't: one side is down). */
async function moveAndSync(mover: Player, other: Player | null, id: Hex, move: string): Promise<Status> {
  const st = (await mover.api("POST", "/move", { move, channel: id })) as Status;
  if (other) await waitStatus(other, (s) => s.turnNum === st.turnNum, 15_000, id);
  return st;
}

/** Cooperative close from both sides of a finished game, then waits for Finalized on chain and in both daemons. */
async function closeBoth(a: Player, b: Player, id: Hex, hub: HubClient): Promise<void> {
  const aStatus = (await a.api("GET", `/status?channel=${id}`)) as Status;
  await waitStatus(b, (s) => s.turnNum === aStatus.turnNum, 15_000, id);
  await a.api("POST", "/close", { channel: id });
  await waitStatus(b, (s) => s.opponentWantsToClose === true, 15_000, id);
  await b.api("POST", "/close", { channel: id });
  await waitPhase(hub, id, "Finalized");
  await waitStatus(a, (s) => s.phase === "Finalized", 20_000, id);
  await waitStatus(b, (s) => s.phase === "Finalized", 20_000, id);
}

/** Alice (white in game 0) wins game 0 by scholar's mate; bob's daemon auto-resigns the mated position. */
async function scholarsMate(alice: Player, bob: Player, id: Hex, from = 0): Promise<void> {
  await playLine(alice, bob, id, SCHOLARS_MATE.slice(from));
  await waitStatus(alice, (s) => s.gameStatus === "white_won", 15_000, id);
  await waitStatus(bob, (s) => s.gameStatus === "white_won", 15_000, id);
}

/** The sender (lower-cased) of the transaction that emitted this channel's `Finalized` event. */
async function finalizedBy(s: Stack, id: Hex): Promise<string> {
  const { pub } = hubOf(s);
  const logs = await pub.getContractEvents({
    address: s.hub,
    abi: channelHubAbi,
    eventName: "Finalized",
    args: { channelId: id },
    fromBlock: 0n,
  });
  expect(logs).toHaveLength(1);
  const tx = await pub.getTransaction({ hash: logs[0].transactionHash });
  return tx.from.toLowerCase();
}

async function expectBalances(s: Stack, want: Array<[Player | "host", bigint]>): Promise<void> {
  for (const [who, amount] of want) {
    const addr = who === "host" ? s.host : who.address;
    expect(await usdcBalanceOf(s, addr), `${who === "host" ? "host" : who.name}'s USDC`).toBe(amount);
  }
}

/** Every channel of every running daemon listed ends with no `lastError` (a settled dispute or close must not leave
 *  a stale error behind, e.g. the loser of a cooperative-close race reporting the winner's WrongPhase). */
async function expectNoErrors(...players: Player[]): Promise<void> {
  for (const p of players) {
    const chs = (await p.api("GET", "/channels")) as Array<{ channelId: Hex; lastError: string | null }>;
    for (const c of chs) expect(c.lastError, `${p.name}'s lastError on ${c.channelId}`).toBeNull();
  }
}

/** Opens a channel, Alice plays e4, and challenges while it is Bob's turn; Bob answers through `/move` (the daemon
 *  submits it via `respond`). Shared by scenarios 3 and 4. */
async function challengeAnsweredByMove(s: Stack): Promise<{ alice: Player; bob: Player; id: Hex; hub: HubClient }> {
  const alice = await s.player("alice");
  const bob = await s.player("bob");
  const { hub, pub } = hubOf(s);
  const id = await matchAndOpen(alice, bob);
  await playLine(alice, bob, id, ["e2e4"]);

  await alice.api("POST", "/challenge", { channel: id });
  const bobView = await waitStatus(bob, (st) => st.phase === "Challenged" && (st.challenge as any)?.mustMove === true, 15_000, id);
  expect((bobView.challenge as any).challenger).toBe("opponent");
  expect(bobView.myTurn).toBe(true);
  const info = await hub.channelInfo(id);
  expect(info.phase).toBe("Challenged");
  expect(info.challenger).toBe(0);

  await bob.api("POST", "/move", { move: "e7e5", channel: id });
  await waitPhase(hub, id, "Open");
  expect((await hub.registeredState(id)).turnNum).toBe(2n);
  // Alice's challenge was answered: she is in cooldown for one challengeTimeout.
  const after = await hub.channelInfo(id);
  expect(after.cooldownUntil[0]).toBeGreaterThan(0n);
  await waitStatus(alice, (st) => st.phase === "Open" && st.turnNum === "2" && st.myTurn, 15_000, id);
  // Informational only: which daemon's respond landed. Bob's daemon submits it right after relaying his move; Alice's
  // own watchtower may race it (it also holds the newer state once the relay delivers it) -- both are correct, so it
  // is logged, not asserted. The responder's identity is covered at unit level in packages/cli/test/daemon.test.ts:
  // "answers a stale challenge automatically" (lines 203-207: the Responded tx came from the answering daemon's
  // session key) and the respond-race tests after it.
  const [ev] = (await hub.disputeEvents(id)).filter((e) => e.kind === "Responded");
  const tx = await pub.getTransaction({ hash: ev.transactionHash });
  const params = await hub.channelParams(id);
  console.log(`[dispute] respond submitted by ${tx.from.toLowerCase() === params.signers[1].toLowerCase() ? "bob" : "alice"}'s session key`);
  return { alice, bob, id, hub };
}

// ---------------------------------------------------------------------------------------------------- scenarios

describe("dispute paths end-to-end (real server, real `arena daemon` processes, real chain)", () => {
  timed(
    "1. opponent disappears mid-game -> one challenge -> watchtower timeout forfeits the stake",
    async () => {
      stack = await startStack();
      const alice = await stack.player("alice");
      const bob = await stack.player("bob");
      const { hub } = hubOf(stack);
      const id = await matchAndOpen(alice, bob);

      await playLine(alice, bob, id, ["e2e4"]);
      await waitStatus(bob, (s) => s.myTurn, 10_000, id);
      await bob.kill("SIGKILL");

      // The one human/agent step: the challenge. Everything after it is Alice's watchtower.
      await alice.api("POST", "/challenge", { channel: id });
      await waitPhase(hub, id, "Challenged");
      const registered = await hub.registeredState(id);
      expect(registered.turnNum).toBe(1n);
      expect(playerOnMove(registered.gameIndex, registered.meta)).toBe(1); // Bob is on move: he forfeits

      await stack.increaseTime(TIMEOUT + 1);
      await waitPhase(hub, id, "Finalized");
      await waitStatus(alice, (s) => s.phase === "Finalized", 15_000, id);
      // The timeout came from Alice's watchtower, through her session key (spec §3.1), not from the test.
      expect(await finalizedBy(stack, id)).toBe((await hub.channelParams(id)).signers[0].toLowerCase());
      await expectBalances(stack, [
        [alice, START + STAKE - FEE],
        [bob, START - STAKE - FEE],
        ["host", 2n * FEE],
      ]);
      await expectNoErrors(alice);
    },
    90_000,
  );

  timed(
    "2. stale challenge from Bob's session key -> Alice's watchtower responds -> play resumes off-chain and closes",
    async () => {
      stack = await startStack();
      const alice = await stack.player("alice");
      const bob = await stack.player("bob");
      const { hub } = hubOf(stack);
      const id = await matchAndOpen(alice, bob);

      await playLine(alice, bob, id, SCHOLARS_MATE.slice(0, 2)); // e4 e5: Bob's latest = turn 2, prev = turn 1
      const bobHome = join(bob.home, "channels", id);
      const oldSnap = readJson<SessionSnapshot>(join(bobHome, "session.json"))!;
      expect(oldSnap.latest.state.turnNum).toBe(2n);
      expect(oldSnap.prev?.state.turnNum).toBe(1n);
      const staleProof: Proof = { hasPrev: true, prev: oldSnap.prev!, latest: oldSnap.latest };

      await playLine(alice, bob, id, SCHOLARS_MATE.slice(2, 5)); // Qh5 Nc6 Bc4: turn 5, Bob to move
      await waitStatus(bob, (s) => s.myTurn && s.turnNum === "5", 10_000, id);
      await bob.kill("SIGTERM");

      // Bob (daemon stopped) cheats with an older supported state, straight from his session key.
      const record = readJson<ChannelRecord>(join(bobHome, "record.json"))!;
      const bobSession = new LocalKeyTxSender(record.sessionKey, stack.rpcUrl, foundry);
      await hub.challenge(bobSession, staleProof);

      // Alice's watchtower answers automatically with her newer state (turn 5) -- no Alice API call.
      await waitPhase(hub, id, "Open");
      expect((await hub.registeredState(id)).turnNum).toBe(5n);
      const info = await hub.channelInfo(id);
      expect(info.cooldownUntil[1]).toBeGreaterThan(0n); // Bob, the answered challenger, is in cooldown
      await waitStatus(alice, (s) => s.phase === "Open", 15_000, id);

      // Bob comes back and both finish the game off-chain, then close cooperatively.
      await bob.start();
      await waitStatus(bob, (s) => s.phase === "Open" && s.myTurn && s.turnNum === "5", 20_000, id);
      await scholarsMate(alice, bob, id, 5);
      await closeBoth(alice, bob, id, hub);
      await expectBalances(stack, [
        [alice, START + STAKE - FEE],
        [bob, START - STAKE - FEE],
        ["host", 2n * FEE],
      ]);
      await expectNoErrors(alice, bob);
    },
    90_000,
  );

  timed(
    "3. challenge that needs a real move -> Bob sees mustMove, moves, the daemon responds -> play resumes",
    async () => {
      stack = await startStack();
      const { alice, bob, id, hub } = await challengeAnsweredByMove(stack);
      // Play resumes off-chain from the responded state, to the end of the game and a cooperative close.
      await playLine(alice, bob, id, SCHOLARS_MATE.slice(2));
      await waitStatus(alice, (s) => s.gameStatus === "white_won", 15_000, id);
      await closeBoth(alice, bob, id, hub);
      await expectBalances(stack, [
        [alice, START + STAKE - FEE],
        [bob, START - STAKE - FEE],
        ["host", 2n * FEE],
      ]);
      await expectNoErrors(alice, bob);
    },
    90_000,
  );

  timed(
    "4. cooldown: a second challenge by the answered challenger is refused by the daemon API, with no transaction",
    async () => {
      stack = await startStack();
      const { alice, id, hub } = await challengeAnsweredByMove(stack);
      const { pub } = hubOf(stack);
      const record = readJson<ChannelRecord>(join(alice.home, "channels", id, "record.json"))!;
      const sessionAddr = record.params.signers[0];

      const before = await hub.channelInfo(id);
      // Anvil mines only when a transaction arrives, so an unchanged block number means no transaction at all. Nothing
      // else can send one in this window: the channel is Open with the game in progress and Alice to move, so neither
      // watchtower has anything to do (no funding, no challenge to answer or time out, no close signatures), and the
      // test sends nothing itself. The nonce checks pin Alice's two senders specifically.
      const blockBefore = await pub.getBlockNumber({ cacheTime: 0 });
      const nonces = async () =>
        Promise.all([pub.getTransactionCount({ address: alice.address }), pub.getTransactionCount({ address: sessionAddr })]);
      const noncesBefore = await nonces();

      await expect(alice.api("POST", "/challenge", { channel: id })).rejects.toThrow(/cooldown/i);

      expect(await pub.getBlockNumber({ cacheTime: 0 })).toBe(blockBefore);
      expect(await nonces()).toEqual(noncesBefore);
      const after = await hub.channelInfo(id);
      expect(after.phase).toBe("Open");
      expect(after.cooldownUntil).toEqual(before.cooldownUntil);
      // The daemon's status reports the cooldown too.
      const st = (await alice.api("GET", `/status?channel=${id}`)) as Status & { cooldown: { meSeconds: number } };
      expect(st.cooldown.meSeconds).toBeGreaterThan(0);
      await expectNoErrors(alice);
    },
    90_000,
  );

  timed(
    "5. unfunded channel -> the watchtower reclaims after fundingDeadline, deposit and fee restored",
    async () => {
      stack = await startStack();
      const alice = await stack.player("alice");
      const bob = await stack.player("bob");
      const { hub } = hubOf(stack);
      // Deterministic "Bob never funds": no gas for his deposit, and his daemon is killed right after accepting.
      const testClient = createTestClient({ mode: "anvil", chain: foundry, transport: http(stack.rpcUrl) });
      await testClient.setBalance({ address: bob.address, value: 0n });

      const offerId = await postOffer(alice);
      await bob.api("POST", "/offers/accept", { offerId });
      await bob.kill("SIGKILL");

      const id = await channelOf(alice);
      await waitFor(async () => (await hub.channelInfo(id)).funded[0], 30_000, "alice's deposit");
      const funded = await hub.channelInfo(id);
      expect(funded.phase).toBe("Funding");
      expect(funded.funded[1]).toBe(false);
      expect(await usdcBalanceOf(stack, alice.address)).toBe(START - DEPOSIT - FEE);

      await stack.increaseTime(FUNDING_WINDOW + 1);
      await waitPhase(hub, id, "Reclaimed", 30_000);
      await waitStatus(alice, (s) => s.phase === "Reclaimed", 15_000, id);
      await expectBalances(stack, [
        [alice, START],
        [bob, START],
        ["host", 0n],
      ]);
      await expectNoErrors(alice);
      expect((await hub.limits()).committedEscrow).toBe(0n);
    },
    90_000,
  );

  timed(
    "6. one daemon, two channels at once: random games vs Bob and Carol, both close with exact balances",
    async () => {
      stack = await startStack();
      const alice = await stack.player("alice");
      const bob = await stack.player("bob");
      const carol = await stack.player("carol");
      const { hub } = hubOf(stack);

      const offer1 = await postOffer(alice);
      await bob.api("POST", "/offers/accept", { offerId: offer1 });
      const idB = await channelOf(bob);
      const offer2 = await postOffer(alice);
      await carol.api("POST", "/offers/accept", { offerId: offer2 });
      const idC = await channelOf(carol);
      expect(idB).not.toBe(idC);
      for (const [p, id] of [[bob, idB], [carol, idC]] as const) {
        await waitStatus(alice, (s) => s.phase === "Open", 30_000, id);
        await waitStatus(p, (s) => s.phase === "Open", 30_000, id);
      }

      // Alice is white (player 0, game 0) in both channels.
      const finish = async (opp: Player, id: Hex, seed: number): Promise<Status["gameStatus"]> => {
        await playRandomGame(alice, opp, { channelId: id, seed, ms: 15_000 });
        const end = await waitStatus(alice, (s) => s.gameStatus !== "playing" && s.gameStatus !== "draw_offered", 15_000, id);
        return end.gameStatus;
      };
      // Seeds picked (by replaying the bot's PRNG against the SDK rules) so that both stake directions settle: the
      // game vs Bob ends in a white (Alice) win after 61 plies, the game vs Carol in a black (Carol) win after 64.
      const [resB, resC] = await Promise.all([finish(bob, idB, 10), finish(carol, idC, 51)]);
      expect([resB, resC]).toEqual(["white_won", "black_won"]);
      await Promise.all([closeBoth(alice, bob, idB, hub), closeBoth(alice, carol, idC, hub)]);

      const delta = (r: Status["gameStatus"]) => (r === "white_won" ? STAKE : r === "black_won" ? -STAKE : 0n);
      await expectBalances(stack, [
        [alice, START - 2n * FEE + delta(resB) + delta(resC)],
        [bob, START - FEE - delta(resB)],
        [carol, START - FEE - delta(resC)],
        ["host", 4n * FEE],
      ]);
      await expectNoErrors(alice, bob, carol);
      console.log(`[dispute] scenario 6 results: vs bob ${resB}, vs carol ${resC}`);
    },
    180_000,
  );

  timed(
    "7. restart in the middle of a dispute: Alice's restarted watchtower adopts a Responded state only the chain carries",
    async () => {
      stack = await startStack();
      const alice = await stack.player("alice");
      const bob = await stack.player("bob");
      const { hub } = hubOf(stack);
      const id = await matchAndOpen(alice, bob);
      await playLine(alice, bob, id, ["e2e4"]);

      await alice.api("POST", "/challenge", { channel: id });
      await waitPhase(hub, id, "Challenged");
      await waitStatus(bob, (s) => (s.challenge as any)?.mustMove === true, 15_000, id);
      // Both daemons go down: Alice mid-dispute (SIGKILL), Bob cleanly, so his session files can be used offline.
      await alice.kill("SIGKILL");
      await bob.kill("SIGTERM");

      // Bob answers offline, straight from his own session files: the move never touches the relay (so neither a
      // live relay delivery nor the relay's rejoin cache can hand it to Alice) -- only the chain carries it.
      const bobDir = join(bob.home, "channels", id);
      const bobRecord = readJson<ChannelRecord>(join(bobDir, "record.json"))!;
      const bobSession = await ChannelSession.open({
        params: bobRecord.params,
        me: bobRecord.me,
        sessionKey: bobRecord.sessionKey,
        domain: { chainId: stack.chainId, hub: stack.hub },
        store: new FileSessionStore(join(bobDir, "session.json")),
      });
      await bobSession.move("e7e5");
      const bobSender = new LocalKeyTxSender(bobRecord.sessionKey, stack.rpcUrl, foundry);
      await hub.respond(bobSender, bobSession.challengeProof());
      await waitPhase(hub, id, "Open");
      expect((await hub.registeredState(id)).turnNum).toBe(2n);
      const responded = (await hub.disputeEvents(id)).filter((e) => e.kind === "Responded");
      expect(responded).toHaveLength(1);

      // Alice restarts alone (Bob still down): her watchtower must adopt turn 2 from the Responded event.
      await alice.start();
      await waitStatus(alice, (s) => s.phase === "Open" && s.turnNum === "2" && s.myTurn, 20_000, id);
      await waitFor(
        () => (readJson<ChannelRecord>(join(alice.home, "channels", id, "record.json"))!.scannedBlock ?? -1n) >= responded[0].blockNumber,
        15_000,
        "alice's dispute scan cursor to pass the Responded event",
      );

      // Bob comes back (his session already holds turn 2) and play resumes off-chain to the end and a close.
      await bob.start();
      await waitStatus(bob, (s) => s.phase === "Open" && s.turnNum === "2" && !s.myTurn, 20_000, id);
      await playLine(alice, bob, id, SCHOLARS_MATE.slice(2));
      await waitStatus(alice, (s) => s.gameStatus === "white_won", 15_000, id);
      await closeBoth(alice, bob, id, hub);
      await expectBalances(stack, [
        [alice, START + STAKE - FEE],
        [bob, START - STAKE - FEE],
        ["host", 2n * FEE],
      ]);
      await expectNoErrors(alice, bob);
    },
    90_000,
  );

  timed(
    "8. challenge on a new-game checkpoint: the side on move in game 1 (Bob) forfeits its stake (spec §4.6)",
    async () => {
      stack = await startStack();
      const alice = await stack.player("alice");
      const bob = await stack.player("bob");
      const { hub } = hubOf(stack);
      const id = await matchAndOpen(alice, bob);
      await scholarsMate(alice, bob, id); // game 0: Alice +stake

      // Alice proposes game 1; Bob countersigns the checkpoint, then goes silent before moving.
      await alice.api("POST", "/next-game", { channel: id });
      await waitStatus(bob, (s) => s.attention === "new-game-proposed", 15_000, id);
      await bob.api("POST", "/next-game", { channel: id });
      await waitStatus(alice, (s) => s.gameIndex === 1 && s.newGame === "none" && !s.myTurn, 15_000, id);
      await bob.kill("SIGKILL");

      await alice.api("POST", "/challenge", { channel: id });
      await waitPhase(hub, id, "Challenged");
      const registered = await hub.registeredState(id);
      expect(registered.gameIndex).toBe(1);
      const onMove = playerOnMove(registered.gameIndex, registered.meta);
      expect(onMove).toBe(1); // game 1: white is player 1 (Bob)

      await stack.increaseTime(TIMEOUT + 1);
      await waitPhase(hub, id, "Finalized");
      await waitStatus(alice, (s) => s.phase === "Finalized", 15_000, id);
      await expectBalances(stack, [
        [alice, START + 2n * STAKE - FEE],
        [bob, START - 2n * STAKE - FEE],
        ["host", 2n * FEE],
      ]);
      await expectNoErrors(alice);
    },
    90_000,
  );

  timed(
    "8b. opponent silent before countersigning the checkpoint: the finished game 0 settles as-is, no game-1 forfeit",
    async () => {
      stack = await startStack();
      const alice = await stack.player("alice");
      const bob = await stack.player("bob");
      const { hub } = hubOf(stack);
      const id = await matchAndOpen(alice, bob);
      await scholarsMate(alice, bob, id); // game 0: Alice +stake; Bob's auto-resign (turn 8) is the terminal state

      // Alice proposes game 1; Bob sees the proposal but never countersigns, and goes silent.
      await alice.api("POST", "/next-game", { channel: id });
      await waitStatus(bob, (s) => s.attention === "new-game-proposed", 15_000, id);
      await bob.kill("SIGKILL");
      const aliceView = await waitStatus(alice, (s) => s.newGame === "proposed_by_me", 5_000, id);
      expect(aliceView.gameIndex).toBe(0);

      // A lone-signed checkpoint is not provable on-chain, so Alice's challenge registers the finished game 0.
      await alice.api("POST", "/challenge", { channel: id });
      await waitPhase(hub, id, "Challenged");
      const registered = await hub.registeredState(id);
      expect(registered.gameIndex).toBe(0);
      expect(registered.turnNum).toBe(8n);
      expect(isGameOver(registered)).toBe(true);

      // Past the deadline Alice's watchtower times out a terminal state: balances as-is (Alice keeps game 0's stake).
      await stack.increaseTime(TIMEOUT + 1);
      await waitPhase(hub, id, "Finalized");
      await waitStatus(alice, (s) => s.phase === "Finalized", 15_000, id);
      expect(await finalizedBy(stack, id)).toBe((await hub.channelParams(id)).signers[0].toLowerCase());
      await expectBalances(stack, [
        [alice, START + STAKE - FEE],
        [bob, START - STAKE - FEE],
        ["host", 2n * FEE],
      ]);
      await expectNoErrors(alice);
    },
    90_000,
  );

  timed(
    "9. pause and lowered caps during play: the game still closes and settles, new offers are refused",
    async () => {
      stack = await startStack();
      const alice = await stack.player("alice");
      const bob = await stack.player("bob");
      const { hub } = hubOf(stack);
      const id = await matchAndOpen(alice, bob);
      await playLine(alice, bob, id, SCHOLARS_MATE.slice(0, 2));
      expect((await hub.limits()).committedEscrow).toBe(2n * (DEPOSIT + FEE));

      await stack.setPaused(true);
      await stack.setLimits(DEPOSIT / 2n, DEPOSIT); // below this channel's deposit and its committed escrow
      await expect(postOffer(alice)).rejects.toThrow(/paused/i);

      await scholarsMate(alice, bob, id, 2);
      await closeBoth(alice, bob, id, hub);
      await expectBalances(stack, [
        [alice, START + STAKE - FEE],
        [bob, START - STAKE - FEE],
        ["host", 2n * FEE],
      ]);
      await expectNoErrors(alice, bob);
      const limits = await hub.limits();
      expect(limits.committedEscrow).toBe(0n);
      expect(limits.paused).toBe(true);
      // Still refused after the settle (paused, not just capped).
      await expect(postOffer(bob)).rejects.toThrow(/paused/i);
    },
    90_000,
  );
});
