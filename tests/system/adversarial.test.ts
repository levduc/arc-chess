/**
 * Plan 4.5 Task 9: adversarial system tests over the real host server, real `arena daemon` processes and a real chain.
 *
 * - **Malicious relay/host** (`mitm.ts`): a daemon's `serverUrl` points at a proxy in front of the real server that
 *   tampers match events, drops/duplicates/delays/replays relay frames, injects forged messages, and rewrites
 *   `/templates`. Only the victim daemon sits behind the proxy (the other side talks to the server directly), so every
 *   tamper reaches exactly one player -- the one under test.
 * - **Malicious opponent** (`peer.ts`): an SDK-only channel member after a real match, which equivocates, signs illegal
 *   moves, withholds its NEW_GAME countersignature, signs Close for the wrong state, spams stale states and griefs
 *   with challenges.
 *
 * Every test asserts, from the chain and from the honest daemon's own persisted session, that the honest daemon never
 * funds or signs anything unsafe, that it surfaces the reason (its log or `lastError`), and -- wherever the game can
 * go on -- that USDC settles exactly per the protocol.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  maxUint256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  HubClient,
  HubRevertError,
  LocalKeyTxSender,
  channelId as computeChannelId,
  encodeMove,
  hashState,
  squareIndex,
  KIND,
  type HubEvent,
  type Params,
  type SessionSnapshot,
  type SignedState,
  type State,
} from "@arena/sdk";
import { loadWalletKey, readJson } from "@arena/cli";
import { artifact, runCli, startStack, usdcBalanceOf, type Player, type PlayerOptions, type Stack } from "./harness.js";
import { playLine, waitStatus, type Status } from "./bot.js";
import { startMitm, type Mitm, type MitmHooks, type WsConn } from "./mitm.js";
import { MaliciousPeer } from "./peer.js";

const SCHOLARS_MATE = ["e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6", "h5f7"];

const DEPOSIT = 1_000_000n;
const STAKE = 100_000n;
const START = 10_000_000n;
const FEE = 5_000n;
const TIMEOUT = 60; // the hub's MIN_TIMEOUT
/**
 * Scenario 7 (final review C1): Alice's session-key dispute gas target, and her refill floor (the same: any spend is
 * refilled). Measured on this harness's Anvil: one respond is admitted at about 2.1-2.7e14 wei (gas limit x
 * maxFeePerGas, at most about 4.4e14 at Anvil's starting base fee) and costs about 2.0-2.4e14. So 5e14 pays for the
 * first respond, and without refills the key could not be admitted for the third.
 */
const SESSION_GAS = 5n * 10n ** 14n;
const FUNDING_WINDOW = 3600; // the harness server config's fundingWindow

let stack: Stack | undefined;
const mitms: Mitm[] = [];
const peers: MaliciousPeer[] = [];
afterEach(async () => {
  for (const p of peers.splice(0)) p.close();
  for (const m of mitms.splice(0)) await m.stop();
  await stack?.stop();
  stack = undefined;
}, 30_000);

const times: Array<{ name: string; ms: number }> = [];
afterAll(() => {
  for (const t of times) console.log(`[adversarial timing] ${(t.ms / 1000).toFixed(1)}s  ${t.name}`);
});
function timed(name: string, fn: () => Promise<void>, ms = 120_000): void {
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

async function mitmFor(s: Stack, hooks: MitmHooks = {}): Promise<Mitm> {
  const m = await startMitm(s.serverUrl, hooks);
  mitms.push(m);
  return m;
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

async function waitPhase(hub: HubClient, id: Hex, phase: string, ms = 20_000): Promise<void> {
  await waitFor(async () => (await hub.channelInfo(id)).phase === phase, ms, `on-chain phase ${phase}`);
}

async function postOffer(p: Player): Promise<Hex> {
  const { offerId } = await p.api("POST", "/offers", {
    deposit: DEPOSIT.toString(),
    stakePerGame: STAKE.toString(),
    challengeTimeout: String(TIMEOUT),
  });
  return offerId as Hex;
}

async function channelIds(p: Player): Promise<Hex[]> {
  return ((await p.api("GET", "/channels")) as Array<{ channelId: Hex }>).map((c) => c.channelId);
}

async function matchAndOpen(alice: Player, bob: Player): Promise<Hex> {
  const offerId = await postOffer(alice);
  await bob.api("POST", "/offers/accept", { offerId });
  const id = await waitFor(async () => (await channelIds(bob))[0], 20_000, "bob's channel");
  await waitStatus(alice, (s) => s.phase === "Open", 30_000, id);
  await waitStatus(bob, (s) => s.phase === "Open", 30_000, id);
  return id;
}

async function closeBoth(a: Player, b: Player, id: Hex, hub: HubClient): Promise<void> {
  const aStatus = (await a.api("GET", `/status?channel=${id}`)) as Status;
  await waitStatus(b, (s) => s.turnNum === aStatus.turnNum, 20_000, id);
  await a.api("POST", "/close", { channel: id });
  await waitStatus(b, (s) => s.opponentWantsToClose === true, 20_000, id);
  await b.api("POST", "/close", { channel: id });
  await waitPhase(hub, id, "Finalized");
  await waitStatus(a, (s) => s.phase === "Finalized", 20_000, id);
  await waitStatus(b, (s) => s.phase === "Finalized", 20_000, id);
}

async function expectBalances(s: Stack, want: Array<[Player | MaliciousPeer | "host", bigint, string]>): Promise<void> {
  for (const [who, amount, label] of want) {
    const addr = who === "host" ? s.host : who.address;
    expect(await usdcBalanceOf(s, addr), `${label}'s USDC`).toBe(amount);
  }
}

async function expectNoErrors(...players: Player[]): Promise<void> {
  for (const p of players) {
    const chs = (await p.api("GET", "/channels")) as Array<{ channelId: Hex; lastError: string | null }>;
    for (const c of chs) expect(c.lastError, `${p.name}'s lastError on ${c.channelId}`).toBeNull();
  }
}

async function lastErrorOf(p: Player, id: Hex): Promise<string | null> {
  const chs = (await p.api("GET", "/channels")) as Array<{ channelId: Hex; lastError: string | null }>;
  return chs.find((c) => c.channelId === id)?.lastError ?? null;
}

function snapshotOf(p: Player, id: Hex): SessionSnapshot {
  return readJson<SessionSnapshot>(join(p.home, "channels", id, "session.json"))!;
}

async function allHubEvents(s: Stack): Promise<HubEvent[]> {
  const { hub } = hubOf(s);
  return hub.hubEvents(0n, await hub.blockNumber());
}

/** Every on-chain deposit, with the depositing wallet (from the channel's ChannelCreated params). */
async function deposits(s: Stack): Promise<Array<{ channelId: Hex; player: 0 | 1; wallet: string }>> {
  const events = await allHubEvents(s);
  const params = new Map<Hex, Params>();
  for (const e of events) if (e.kind === "ChannelCreated") params.set(e.channelId, e.params);
  return events
    .filter((e): e is Extract<HubEvent, { kind: "Deposited" }> => e.kind === "Deposited")
    .map((e) => ({ channelId: e.channelId, player: e.player, wallet: params.get(e.channelId)!.participants[e.player].toLowerCase() }));
}

/** The only deposits on-chain are the two honest ones into channel `id`, by exactly `players` (index order). */
async function expectOnlyDeposits(s: Stack, id: Hex, players: Array<{ address: Address }>): Promise<void> {
  expect(await deposits(s)).toEqual(players.map((p, i) => ({ channelId: id, player: i, wallet: p.address.toLowerCase() })));
}

const RANDOM_SIG = (): Hex => `0x${"11".repeat(32)}${"22".repeat(32)}1b` as Hex;

/** The match-event tamper hook: every server->daemon `match` frame, and every `POST /offers/:id/accept` response
 *  (the accepter's copy of the match), for an offer in `tampers` has its params rewritten. Persistent per offer: a
 *  later replay of the same match (every reconnect re-subscribes) is tampered the same way. */
function matchTamper(tampers: Map<string, (p: Params) => Params>): MitmHooks {
  return {
    ws: (frame, { dir }) => {
      if (dir !== "down" || frame.type !== "match") return undefined;
      const fn = tampers.get(String(frame.event?.offerId).toLowerCase());
      return fn ? { send: [{ ...frame, event: { ...frame.event, params: fn(frame.event.params) } }] } : undefined;
    },
    http: ({ method, path, status, body }) => {
      if (method !== "POST" || status !== 200 || !/^\/offers\/0x[0-9a-fA-F]{64}\/accept$/.test(path)) return undefined;
      const b = body as { offerId?: string; params?: Params };
      const fn = b.offerId ? tampers.get(b.offerId.toLowerCase()) : undefined;
      return fn && b.params ? { ...b, params: fn(b.params) } : undefined;
    },
  };
}

// ============================================================================================================
// Malicious relay / host
// ============================================================================================================

describe("malicious relay/host (MITM proxy between the daemon and the real server)", () => {
  timed("0. a transparent proxy changes nothing: a full game and cooperative close settle exactly", async () => {
    stack = await startStack();
    const m = await mitmFor(stack);
    const alice = await stack.player("alice", undefined, { serverUrl: m.url });
    const bob = await stack.player("bob");
    const { hub } = hubOf(stack);
    const id = await matchAndOpen(alice, bob);
    await playLine(alice, bob, id, SCHOLARS_MATE);
    await waitStatus(alice, (s) => s.gameStatus === "white_won", 15_000, id);
    await closeBoth(alice, bob, id, hub);
    await expectBalances(stack, [
      [alice, START + STAKE - FEE, "alice"],
      [bob, START - STAKE - FEE, "bob"],
      ["host", 2n * FEE, "host"],
    ]);
    await expectNoErrors(alice, bob);
    await expectOnlyDeposits(stack, id, [alice, bob]);
    expect(m.stats.frames.down).toBeGreaterThan(0);
    expect(m.stats.frames.up).toBeGreaterThan(0);
    expect(m.stats.httpRequests).toBeGreaterThan(0);
    expect(m.stats.modified + m.stats.dropped + m.stats.injected).toBe(0);
  });

  timed(
    "1. every tampered match field is refused before any deposit: no Deposited from the victim, reason logged",
    async () => {
      stack = await startStack();
      const tampers = new Map<string, (p: Params) => Params>();
      const m = await mitmFor(stack, matchTamper(tampers));
      const { hub } = hubOf(stack);
      const alice = await stack.player("alice", undefined, { serverUrl: m.url }); // offerer, behind the proxy
      const bob = await stack.player("bob"); // honest accepter, direct
      const attacker = privateKeyToAccount(generatePrivateKey()).address;
      let beyondDayParams: Params | undefined;

      // Offerer-side cases: Alice is participants[0] and deposits first, so each of these is a deposit she must refuse.
      const cases: Array<{ name: string; reason: RegExp; fn: (p: Params) => Params }> = [
        { name: "deposit", reason: /amounts differ from the agreed offer/, fn: (p) => ({ ...p, deposit: p.deposit * 2n }) },
        {
          name: "her signer",
          reason: /params do not name this player's session key/,
          fn: (p) => ({ ...p, signers: [attacker, p.signers[1]] }),
        },
        {
          name: "her participant",
          reason: /params do not name this player's wallet/,
          fn: (p) => ({ ...p, participants: [attacker, p.participants[1]] }),
        },
        { name: "feeRecipient", reason: /unexpected fee recipient/, fn: (p) => ({ ...p, feeRecipient: attacker }) },
        {
          // Beyond the hub's own 1-day MAX_FUNDING_WINDOW: the daemon refuses it first (it was "matched after the
          // offer expired": the deadline is past expiresAt + the daemon's 2 h window), and the hub would too (below).
          name: "fundingDeadline beyond 1 day",
          reason: /matched after the offer expired/,
          fn: (p) => (beyondDayParams = { ...p, fundingDeadline: p.fundingDeadline + 2n * 86_400n }),
        },
        {
          name: "fundingDeadline already past",
          reason: /unexpected funding deadline/,
          fn: (p) => ({ ...p, fundingDeadline: p.fundingDeadline - BigInt(FUNDING_WINDOW) - 1n }),
        },
        {
          name: "swapped participant order",
          reason: /params do not name this player's wallet/,
          fn: (p) => ({
            ...p,
            participants: [p.participants[1], p.participants[0]],
            signers: [p.signers[1], p.signers[0]],
          }),
        },
      ];
      for (const c of cases) {
        const offerId = await postOffer(alice);
        tampers.set(offerId, c.fn);
        const before = (await channelIds(bob)).length;
        await bob.api("POST", "/offers/accept", { offerId });
        await waitFor(async () => (await channelIds(bob)).length > before, 15_000, `bob's channel (${c.name})`);
        await waitFor(() => alice.logs().includes(`ignoring match for offer ${offerId}`), 15_000, `alice refusing (${c.name})`);
        const line = alice.logs().split("\n").find((l) => l.includes(`ignoring match for offer ${offerId}`))!;
        expect(line, c.name).toMatch(c.reason);
      }
      expect(m.stats.modified).toBeGreaterThanOrEqual(cases.length);

      // The hub itself also refuses a deadline beyond its 1-day MAX_FUNDING_WINDOW (checked by simulation only).
      const aliceWallet = new LocalKeyTxSender(loadWalletKey(alice.home), stack.rpcUrl, foundry);
      const hubErr = await hub.deposit(aliceWallet, beyondDayParams!).catch((e: unknown) => e);
      expect(hubErr).toBeInstanceOf(HubRevertError);
      expect((hubErr as HubRevertError).errorName).toBe("InvalidParams");

      // A few watchtower ticks later: still nothing. Alice opened no channel and deposited nothing, and Bob (who got
      // the honest match) never deposits either -- he funds only after participants[0].
      await new Promise((r) => setTimeout(r, 1_000));
      expect(await channelIds(alice)).toEqual([]);
      expect(await deposits(stack)).toEqual([]);
    },
    180_000,
  );

  timed(
    "1b. accepter behind the proxy: a tampered accept response (and match replay) is refused, and a substituted " +
      "opponent is refused even after the attacker funds the substituted channel",
    async () => {
      stack = await startStack();
      const tampers = new Map<string, (p: Params) => Params>();
      const m = await mitmFor(stack, matchTamper(tampers));
      const { hub } = hubOf(stack);
      const carol = await stack.player("carol"); // honest offerer, direct
      const dave = await stack.player("dave", undefined, { serverUrl: m.url }); // accepter, behind the proxy

      // (a) The accepter's match arrives as the HTTP accept response and again as a WS replay: both are tampered.
      const offerA = await postOffer(carol);
      tampers.set(offerA, (p) => ({ ...p, deposit: p.deposit + 1n }));
      await dave.api("POST", "/offers/accept", { offerId: offerA });
      await waitFor(() => dave.logs().includes(`ignoring match for offer ${offerA}`), 15_000, "dave refusing (a)");
      expect(dave.logs()).toMatch(new RegExp(`ignoring match for offer ${offerA}: amounts differ from the agreed offer`));

      // (b) The host substitutes the offerer (participants[0]/signers[0]) with an attacker, who then funds that
      // channel first -- exactly the funding order Dave's watchtower waits for. Dave knows whose offer he accepted.
      const attackerKey = generatePrivateKey();
      const attackerSigner = privateKeyToAccount(generatePrivateKey()).address;
      const attacker = privateKeyToAccount(attackerKey).address;
      await stack.fund(attacker);
      let substituted: Params | undefined;
      const offerB = await postOffer(carol);
      tampers.set(offerB, (p) => (substituted = { ...p, participants: [attacker, p.participants[1]], signers: [attackerSigner, p.signers[1]] }));
      await dave.api("POST", "/offers/accept", { offerId: offerB });
      await waitFor(() => substituted, 15_000, "the substituted match");
      const attackerWallet = new LocalKeyTxSender(attackerKey, stack.rpcUrl, foundry);
      await hub.approve(attackerWallet, stack.usdc, maxUint256);
      await hub.deposit(attackerWallet, substituted!);
      const subId = computeChannelId(stack.chainId, stack.hub, substituted!);
      expect((await hub.channelInfo(subId)).funded).toEqual([true, false]);
      await waitFor(() => dave.logs().includes(`ignoring match for offer ${offerB}`), 15_000, "dave refusing (b)");
      expect(dave.logs()).toMatch(new RegExp(`ignoring match for offer ${offerB}: params do not name the expected opponent's wallet`));

      // Several of Dave's watchtower ticks (200 ms) later, Dave has deposited into nothing at all.
      await new Promise((r) => setTimeout(r, 1_500));
      expect(await channelIds(dave)).toEqual([]);
      const deps = await deposits(stack);
      expect(deps.filter((d) => d.wallet === dave.address.toLowerCase())).toEqual([]);
      expect((await hub.channelInfo(subId)).funded).toEqual([true, false]);
      expect(m.stats.httpRewritten).toBeGreaterThanOrEqual(2);
    },
    120_000,
  );

  timed(
    "2. tampered salt: funding is redirected to a channel only the victim and her real opponent can use, and is " +
      "reclaimed in full after the funding deadline",
    async () => {
      // Ruling: a salt swap is NOT unsafe. The salt only feeds the channel id; every other field (both wallets, both
      // session keys, amounts, fee, deadline) is still checked by checkMatchParams, and the offerer cannot check the
      // salt itself (it is derived from the accepter's nonce). So the victim funds channel X' instead of the host's
      // X: a channel whose participants are exactly her and her real opponent, with her own session key -- nobody
      // else can deposit into it, sign in it or take anything from it. Her opponent waits on X for her deposit, which
      // never comes, so neither channel opens; after the funding deadline her watchtower reclaims X' in full. The
      // cost is griefing (funds locked for the funding window, a few transactions of gas), the same as an opponent
      // who never funds -- not a loss.
      stack = await startStack();
      const tampers = new Map<string, (p: Params) => Params>();
      const m = await mitmFor(stack, matchTamper(tampers));
      const { hub } = hubOf(stack);
      const alice = await stack.player("alice", undefined, { serverUrl: m.url });
      const bob = await stack.player("bob");
      const offerId = await postOffer(alice);
      const salt = `0x${"5a".repeat(32)}` as Hex;
      let tampered: Params | undefined;
      tampers.set(offerId, (p) => (tampered = { ...p, salt }));
      await bob.api("POST", "/offers/accept", { offerId });
      const realId = await waitFor(async () => (await channelIds(bob))[0], 15_000, "bob's channel");
      const xId = await waitFor(async () => (await channelIds(alice))[0], 15_000, "alice's channel");
      expect(xId).not.toBe(realId);
      expect(xId).toBe(computeChannelId(stack.chainId, stack.hub, tampered!));
      await waitFor(async () => (await hub.channelInfo(xId)).funded[0], 15_000, "alice's deposit into X'");
      const onChain = await hub.channelParams(xId);
      expect(onChain.participants.map((a) => a.toLowerCase())).toEqual([alice.address.toLowerCase(), bob.address.toLowerCase()]);
      expect(onChain.salt).toBe(salt);
      expect(await usdcBalanceOf(stack, alice.address)).toBe(START - DEPOSIT - FEE);
      // Bob never deposits anywhere: into the real channel he waits for Alice, and X' is not his.
      await new Promise((r) => setTimeout(r, 1_000));
      expect((await hub.channelInfo(realId)).phase).toBe("None");
      expect((await hub.channelInfo(xId)).funded).toEqual([true, false]);

      await stack.increaseTime(FUNDING_WINDOW + 1);
      await waitPhase(hub, xId, "Reclaimed");
      await waitStatus(alice, (s) => s.phase === "Reclaimed", 15_000, xId);
      await expectBalances(stack, [
        [alice, START, "alice"],
        [bob, START, "bob"],
        ["host", 0n, "host"],
      ]);
      expect((await hub.limits()).committedEscrow).toBe(0n);
      const deps = await deposits(stack);
      expect(deps).toEqual([{ channelId: xId, player: 0, wallet: alice.address.toLowerCase() }]);
    },
  );

  timed(
    "3. drop, duplicate and delay/reorder relay frames over a whole game: it completes and closes after reconnects",
    async () => {
      stack = await startStack();
      const { hub } = hubOf(stack);
      let relayDown = 0;
      let relayUp = 0;
      const DROP_DOWN = new Set([3, 8]);
      const DROP_UP = new Set([5]);
      const m = await mitmFor(stack, {
        ws: (frame, { dir, conn }) => {
          if (frame.type !== "relay") return undefined;
          const n = dir === "down" ? ++relayDown : ++relayUp;
          if ((dir === "down" ? DROP_DOWN : DROP_UP).has(n)) {
            // Dropped. Nothing retransmits a lost relay message on a live connection, so the attacker also cuts the
            // connection a moment later: the daemon reconnects, re-joins (the server replays the other side's cached
            // messages) and re-sends its own latest state and Close (onJoined).
            setTimeout(() => conn.kill(), 200);
            return { send: [] };
          }
          // Everything else is duplicated, and every other down frame is held back 250 ms: a frame that follows it
          // closely (the server's catch-up replay after each re-join is a burst) overtakes it -- a reorder.
          return dir === "down" ? { send: [frame, frame], delayMs: n % 2 === 1 ? 250 : 0 } : { send: [frame, frame] };
        },
      });
      // Both daemons behind the proxy (each on its own connection through it).
      const alice = await stack.player("alice", undefined, { serverUrl: m.url });
      const bob = await stack.player("bob", undefined, { serverUrl: m.url });
      const id = await matchAndOpen(alice, bob);
      await playLine(alice, bob, id, SCHOLARS_MATE, 30_000);
      await waitStatus(alice, (s) => s.gameStatus === "white_won", 30_000, id);
      await waitStatus(bob, (s) => s.gameStatus === "white_won", 30_000, id);
      const aStatus = (await alice.api("GET", `/status?channel=${id}`)) as Status;
      await waitStatus(bob, (s) => s.turnNum === aStatus.turnNum, 30_000, id);
      await alice.api("POST", "/close", { channel: id });
      await waitStatus(bob, (s) => s.opponentWantsToClose === true, 30_000, id);
      await bob.api("POST", "/close", { channel: id });
      await waitPhase(hub, id, "Finalized", 30_000);
      await waitStatus(alice, (s) => s.phase === "Finalized", 30_000, id);
      await waitStatus(bob, (s) => s.phase === "Finalized", 30_000, id);
      await expectBalances(stack, [
        [alice, START + STAKE - FEE, "alice"],
        [bob, START - STAKE - FEE, "bob"],
        ["host", 2n * FEE, "host"],
      ]);
      await expectNoErrors(alice, bob);
      await expectOnlyDeposits(stack, id, [alice, bob]);
      console.log(`[adversarial] drop/dup/reorder stats: ${JSON.stringify(m.stats)}`);
      expect(`${alice.logs()}\n${bob.logs()}`).toMatch(/host: reconnecting in \d+ ms/);
      expect(m.stats.dropped).toBe(DROP_DOWN.size + DROP_UP.size);
      // Each drop cuts its connection; two drops can land on the same connection before the cut, so a cut may cover both.
      expect(m.stats.killed).toBeGreaterThanOrEqual(2);
      expect(m.stats.killed).toBeLessThanOrEqual(DROP_DOWN.size + DROP_UP.size);
      expect(m.stats.duplicated).toBeGreaterThan(10);
      expect(m.stats.delayed).toBeGreaterThan(5);
      expect(m.stats.reordered).toBeGreaterThan(0);
      expect(m.connections.length).toBeGreaterThan(2);
    },
  );

  timed("4. replayed old relay states are treated as stale: no lastError storm, nothing re-signed", async () => {
    stack = await startStack();
    const { hub } = hubOf(stack);
    const m = await mitmFor(stack);
    const alice = await stack.player("alice", undefined, { serverUrl: m.url });
    const bob = await stack.player("bob");
    const id = await matchAndOpen(alice, bob);
    await playLine(alice, bob, id, SCHOLARS_MATE.slice(0, 5)); // turn 5, Bob to move
    const conn = m.connections.at(-1)!;
    const recorded = conn.seen.down.filter((f: any) => f.type === "relay"); // Bob's turns 2 and 4, as delivered
    expect(recorded.length).toBeGreaterThanOrEqual(2);
    const before = snapshotOf(alice, id);
    const upBefore = conn.seen.up.length;
    for (let i = 0; i < 50; i++) for (const f of recorded) conn.inject(f, "down");
    // Poll while the replays are processed: lastError never flips, the daemon answers promptly, nothing changes.
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      expect(await lastErrorOf(alice, id)).toBeNull();
      expect(Date.now() - t0).toBeLessThan(1_000);
      await new Promise((r) => setTimeout(r, 100));
    }
    const after = snapshotOf(alice, id);
    expect(after.lastSignedTurn).toBe(before.lastSignedTurn);
    expect(hashState(after.latest.state, { chainId: stack.chainId, hub: stack.hub })).toBe(
      hashState(before.latest.state, { chainId: stack.chainId, hub: stack.hub }),
    );
    expect(conn.seen.up.slice(upBefore).filter((f: any) => f.type === "relay")).toEqual([]);
    expect(m.stats.injected).toBe(50 * recorded.length);
    // The game goes on normally afterwards.
    await playLine(alice, bob, id, SCHOLARS_MATE.slice(5));
    await waitStatus(alice, (s) => s.gameStatus === "white_won", 15_000, id);
    await closeBoth(alice, bob, id, hub);
    await expectBalances(stack, [
      [alice, START + STAKE - FEE, "alice"],
      [bob, START - STAKE - FEE, "bob"],
      ["host", 2n * FEE, "host"],
    ]);
    await expectNoErrors(alice, bob);
    await expectOnlyDeposits(stack, id, [alice, bob]);
  });

  timed(
    "5. forged state and forged Close (random signatures, a Close for a non-terminal state) are rejected, and no " +
      "signature goes out in response",
    async () => {
      stack = await startStack();
      const { hub } = hubOf(stack);
      const domain = { chainId: stack.chainId, hub: stack.hub };
      const m = await mitmFor(stack);
      const alice = await stack.player("alice", undefined, { serverUrl: m.url });
      const bob = await stack.player("bob");
      const id = await matchAndOpen(alice, bob);
      await playLine(alice, bob, id, ["e2e4"]); // turn 1, Bob to move
      const conn: WsConn = m.connections.at(-1)!;
      const snap0 = snapshotOf(alice, id);
      const upRelays = () => conn.seen.up.filter((f: any) => f.type === "relay").length;
      const up0 = upRelays();

      // (a) Bob's "move" e7e5, exactly the canonical successor, but with a random signature.
      const forgedState = await (async () => {
        const { successor, parseMove } = await import("@arena/sdk");
        const prev = snap0.latest.state;
        const r = successor(prev, parseMove(prev, "e7e5"), (readJson<{ params: Params }>(join(alice.home, "channels", id, "record.json"))!).params);
        if (!r.ok) throw new Error(r.reason);
        return { ...r.next, prevHash: hashState(prev, domain) } as State;
      })();
      conn.inject({ type: "relay", message: { type: "state", channelId: id, signed: { state: forgedState, sigA: "0x", sigB: RANDOM_SIG() } } });
      await waitFor(async () => (await lastErrorOf(alice, id)) === "missing or invalid opponent signature", 10_000, "forged state refused");

      // (b) A Close "from Bob" for the current, non-terminal state.
      conn.inject({
        type: "relay",
        message: { type: "close", channelId: id, close: { stateHash: hashState(snap0.latest.state, domain), by: 1, sig: RANDOM_SIG() } },
      });
      await waitFor(
        async () => (await lastErrorOf(alice, id)) === "close signature for a state that is not a finished game",
        10_000,
        "non-terminal close refused",
      );
      const snap1 = snapshotOf(alice, id);
      expect(snap1.latest.state.turnNum).toBe(1n);
      expect(snap1.lastSignedTurn).toBe(1n);
      expect(snap1.closeSigs).toEqual(["0x", "0x"]);
      expect(upRelays()).toBe(up0);

      // The real game goes on: Bob's real move clears the error; scholar's mate ends it (Bob's daemon auto-resigns).
      await playLine(alice, bob, id, SCHOLARS_MATE.slice(1));
      await waitStatus(alice, (s) => s.gameStatus === "white_won" && s.lastError === null, 15_000, id);
      const terminal = snapshotOf(alice, id).latest.state;
      expect(terminal.turnNum).toBe(8n);

      // (c) A Close for the terminal state, with a random signature.
      const up1 = upRelays();
      conn.inject({
        type: "relay",
        message: { type: "close", channelId: id, close: { stateHash: hashState(terminal, domain), by: 1, sig: RANDOM_SIG() } },
      });
      await waitFor(async () => (await lastErrorOf(alice, id)) === "invalid close signature", 10_000, "forged close refused");
      const st = (await alice.api("GET", `/status?channel=${id}`)) as Status;
      expect(st.opponentWantsToClose).toBe(false);
      expect(st.closing).toBe(false);
      expect(snapshotOf(alice, id).closeSigs).toEqual(["0x", "0x"]);
      expect(upRelays()).toBe(up1);
      expect((await hub.channelInfo(id)).phase).toBe("Open");

      await closeBoth(alice, bob, id, hub);
      await expectBalances(stack, [
        [alice, START + STAKE - FEE, "alice"],
        [bob, START - STAKE - FEE, "bob"],
        ["host", 2n * FEE, "host"],
      ]);
      await expectNoErrors(alice, bob);
      await expectOnlyDeposits(stack, id, [alice, bob]);
    },
  );

  timed(
    "6. tampered /templates at init: a hub with no code fails init; another real ChannelHub passes the code check " +
      "and is shown in the trust output (the known trust boundary, spec §12 item 21)",
    async () => {
      stack = await startStack();
      const { pub } = hubOf(stack);
      let hubOverride: Address | undefined;
      const m = await mitmFor(stack, {
        http: ({ path, body }) =>
          path === "/templates" && hubOverride && Array.isArray(body)
            ? body.map((t: Record<string, unknown>) => (t.id === "chess" ? { ...t, hub: hubOverride } : t))
            : undefined,
      });
      // runCli is asynchronous: the proxy serving `/templates` runs in this very process.
      const init = (home: string) => runCli(["init", "--server", m.url, "--port", "7999"], home);
      const dir = mkdtempSync(join(tmpdir(), "arena-adv-init-"));
      try {
        // (a) An address with no contract code: init's RPC verification fails and nothing is adopted.
        hubOverride = privateKeyToAccount(generatePrivateKey()).address;
        const a = await init(join(dir, "a"));
        expect(a.status).toBe(1);
        expect(a.stderr).toMatch(new RegExp(`hub ${hubOverride} has no contract code on chain ${stack.chainId}`));

        // (b) A second, real ChannelHub deployed by an attacker who owns it and takes its fees. It holds code on the
        // right chain, so init's check passes: init can only prove the addresses are real contracts, not that they
        // are the genuine arena deployment. The printed summary shows the tampered hub and the trust line tells the
        // user to verify it -- this is the documented trust boundary of `init --server` (spec §12 item 21).
        const attackerKey = generatePrivateKey();
        const attacker = privateKeyToAccount(attackerKey);
        await stack.fund(attacker.address, 0n);
        const wallet = createWalletClient({ account: attacker, chain: foundry, transport: http(stack.rpcUrl) });
        const hubArt = artifact("ChannelHub");
        const hash = await wallet.deployContract({
          abi: hubArt.abi,
          bytecode: hubArt.bytecode,
          args: [stack.usdc, attacker.address, attacker.address, 5_000n, 1_000_000n, 10_000_000n, 10n ** 12n],
          chain: foundry,
          account: attacker,
        });
        const evilHub = getAddress((await pub.waitForTransactionReceipt({ hash })).contractAddress!);
        hubOverride = evilHub;
        const b = await init(join(dir, "b"));
        expect(b.status, b.stderr).toBe(0);
        const summary = JSON.parse(b.stdout) as { hub: string; trust?: string };
        expect(summary.hub).toBe(evilHub);
        expect(summary.hub).not.toBe(stack.hub);
        expect(summary.trust).toMatch(new RegExp(`come from ${m.url.replace(/[.]/g, "\\.")}; verify them against a source you trust`));
        expect(m.stats.httpRewritten).toBe(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

// ============================================================================================================
// Malicious opponent (SDK-only peer)
// ============================================================================================================

/** Alice (an honest daemon) offers; the malicious peer accepts through the real lobby, both fund, the peer joins the
 *  real relay. Alice is participants[0] (white in game 0); the peer is participants[1]. */
async function peerMatch(
  s: Stack,
  aliceServerUrl?: string,
  aliceOptions: PlayerOptions = {},
): Promise<{ alice: Player; peer: MaliciousPeer; id: Hex }> {
  const alice = await s.player("alice", undefined, { ...aliceOptions, ...(aliceServerUrl ? { serverUrl: aliceServerUrl } : {}) });
  const peer = await MaliciousPeer.create(s);
  peers.push(peer);
  const offerId = await postOffer(alice);
  await peer.accept(offerId);
  const id = peer.channelId;
  await waitFor(async () => (await channelIds(alice)).includes(id), 20_000, "alice's channel");
  await peer.fund();
  await waitStatus(alice, (st) => st.phase === "Open", 30_000, id);
  await peer.connect();
  return { alice, peer, id };
}

/** Alice (white) plays `uci` through her daemon; the peer's session then holds it. */
async function aliceMoves(alice: Player, peer: MaliciousPeer, id: Hex, uci: string): Promise<void> {
  const st = (await alice.api("POST", "/move", { move: uci, channel: id })) as Status;
  await peer.waitTurn(BigInt(st.turnNum));
}

/** The peer (black) plays `uci` honestly; Alice's daemon then holds it. */
async function peerMoves(alice: Player, peer: MaliciousPeer, id: Hex, uci: string): Promise<SignedState> {
  const signed = await peer.move(uci);
  await waitStatus(alice, (st) => st.turnNum === signed.state.turnNum.toString(), 15_000, id);
  return signed;
}

/** Plays scholar's mate from `fromPly` (alternating Alice/peer), and the peer resigns the mated position (turn 8). */
async function scholarsMateVsPeer(alice: Player, peer: MaliciousPeer, id: Hex, fromPly = 0): Promise<void> {
  for (let i = fromPly; i < SCHOLARS_MATE.length; i++) {
    if (i % 2 === 0) await aliceMoves(alice, peer, id, SCHOLARS_MATE[i]);
    else await peerMoves(alice, peer, id, SCHOLARS_MATE[i]);
  }
  const resign = await peer.resign();
  await waitStatus(alice, (st) => st.turnNum === resign.state.turnNum.toString() && st.gameStatus === "white_won", 15_000, id);
}

/** Cooperative close between Alice (via her daemon API) and the peer (its honest session's Close). */
async function closeWithPeer(alice: Player, peer: MaliciousPeer, id: Hex, hub: HubClient): Promise<void> {
  await alice.api("POST", "/close", { channel: id });
  await waitFor(() => peer.session.snapshot().closeSigs[0] !== "0x", 15_000, "the peer holding alice's close");
  peer.sendClose(await peer.session.signClose());
  await waitPhase(hub, id, "Finalized");
  await waitStatus(alice, (st) => st.phase === "Finalized", 20_000, id);
}

async function expectAliceWonGame0(s: Stack, alice: Player, peer: MaliciousPeer): Promise<void> {
  await expectBalances(s, [
    [alice, START + STAKE - FEE, "alice"],
    [peer, START - STAKE - FEE, "peer"],
    ["host", 2n * FEE, "host"],
  ]);
  await expectOnlyDeposits(s, peer.channelId, [alice, peer]);
}

describe("malicious opponent (SDK-only peer on the real relay)", () => {
  timed("0. an honest SDK peer plays a real game with a daemon and closes: exact settlement", async () => {
    stack = await startStack();
    const { hub } = hubOf(stack);
    const { alice, peer, id } = await peerMatch(stack);
    await scholarsMateVsPeer(alice, peer, id);
    await closeWithPeer(alice, peer, id, hub);
    await expectAliceWonGame0(stack, alice, peer);
    await expectNoErrors(alice);
    expect(peer.receiveErrors).toEqual([]);
  });

  timed(
    "1. equivocation: two signed states for the same turn -- the daemon builds on one only, and answers the peer's " +
      "on-chain challenge with the other by its newer state",
    async () => {
      stack = await startStack();
      const { hub, pub } = hubOf(stack);
      const domain = { chainId: stack.chainId, hub: stack.hub };
      const m = await mitmFor(stack); // transparent: records every frame Alice sends
      const { alice, peer, id } = await peerMatch(stack, m.url);
      await aliceMoves(alice, peer, id, "e2e4");
      const turn1 = peer.session.snapshot().latest; // Alice-signed turn 1

      const a = await peer.move("e7e5"); // version A, through the peer's own session
      const b = await peer.signRaw(peer.craft(turn1.state, "d7d5")); // version B of the same turn, signed raw
      peer.sendState(b);
      await waitFor(async () => (await lastErrorOf(alice, id)) === "conflicting state for turn 2", 10_000, "equivocation surfaced");
      const hA = hashState(a.state, domain);
      const hB = hashState(b.state, domain);
      expect(hA).not.toBe(hB);
      expect(hashState(snapshotOf(alice, id).latest.state, domain)).toBe(hA);

      // Alice plays on: on top of A (the only turn-2 state she accepted).
      await alice.api("POST", "/move", { move: "d1h5", channel: id });
      const snap = snapshotOf(alice, id);
      expect(snap.lastSignedTurn).toBe(3n);
      expect(snap.latest.state.prevHash).toBe(hA);
      expect(hashState(snap.prev!.state, domain)).toBe(hA);
      const serialized = JSON.stringify(snap, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      expect(serialized).not.toContain(b.sigB.slice(2));

      // The peer registers B on-chain (it is a supported state: its own signature over the successor of Alice's
      // turn 1). Alice's watchtower answers with her turn 3 -- built on A -- and never adopts B.
      await peer.challenge({ hasPrev: true, prev: turn1, latest: b });
      await waitPhase(hub, id, "Open");
      expect((await hub.registeredState(id)).turnNum).toBe(3n);
      const responded = (await hub.disputeEvents(id)).filter((e) => e.kind === "Responded");
      expect(responded).toHaveLength(1);
      expect(hashState(responded[0].signed.state, domain)).toBe(hashState(snap.latest.state, domain));
      const tx = await pub.getTransaction({ hash: responded[0].transactionHash });
      expect(tx.from.toLowerCase()).toBe((await hub.channelParams(id)).signers[0].toLowerCase());

      // Every state Alice's daemon ever sent over the relay (seen at the proxy) extends A's chain, never B.
      const sentByAlice = m.connections
        .flatMap((c) => c.seen.up)
        .filter((f: any) => f.type === "relay" && f.message.type === "state")
        .map((f: any) => f.message.signed as SignedState);
      expect(sentByAlice.length).toBeGreaterThan(0);
      for (const s of sentByAlice) expect(s.state.prevHash).not.toBe(hB);
      expect(snapshotOf(alice, id).lastSignedTurn).toBe(3n);

      // The game goes on from A and settles exactly.
      await peer.waitTurn(3n);
      await scholarsMateVsPeer(alice, peer, id, 3);
      await closeWithPeer(alice, peer, id, hub);
      await expectAliceWonGame0(stack, alice, peer);
      await expectNoErrors(alice);
    },
  );

  timed(
    "2. illegal but correctly signed moves (a stake-shifting state, an illegal chess move) are rejected; the hub " +
      "refuses them too; Alice's balance is unaffected",
    async () => {
      stack = await startStack();
      const { hub } = hubOf(stack);
      const { alice, peer, id } = await peerMatch(stack);
      await aliceMoves(alice, peer, id, "e2e4");
      const turn1 = peer.session.snapshot().latest;

      // (a) A legal move whose balances quietly move one stake to the peer.
      const legal = peer.craft(turn1.state, "e7e5");
      const shifted = await peer.signRaw({ ...legal, balanceA: legal.balanceA - STAKE, balanceB: legal.balanceB + STAKE });
      peer.sendState(shifted);
      await waitFor(async () => (await lastErrorOf(alice, id)) === "state does not match the rules", 10_000, "shifted balances refused");

      // (b) An illegal chess move (a pawn three squares), signed correctly.
      const illegalMove = encodeMove(squareIndex("e7"), squareIndex("e4"), 0, KIND.NORMAL);
      const illegal = await peer.signRaw({ ...legal, move: illegalMove });
      peer.sendState(illegal);
      await waitFor(async () => /^illegal: /.test((await lastErrorOf(alice, id)) ?? ""), 10_000, "illegal move refused");

      const snap = snapshotOf(alice, id);
      expect(snap.latest.state.turnNum).toBe(1n);
      expect(snap.lastSignedTurn).toBe(1n);
      const st = (await alice.api("GET", `/status?channel=${id}`)) as Status;
      expect(st.myTurn).toBe(false);
      expect(st.balances).toEqual({ me: "1.000000", opponent: "1.000000" });

      // The hub refuses to register the stake-shifting state as well.
      const err = await peer.challenge({ hasPrev: true, prev: turn1, latest: shifted }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HubRevertError);
      expect((err as HubRevertError).errorName).toBe("InvalidTransition");
      expect((await hub.channelInfo(id)).phase).toBe("Open");

      // The peer plays legally after all; the game ends normally and settles exactly.
      await scholarsMateVsPeer(alice, peer, id, 1);
      await closeWithPeer(alice, peer, id, hub);
      await expectAliceWonGame0(stack, alice, peer);
      await expectNoErrors(alice);
    },
  );

  timed(
    "3. withheld NEW_GAME countersignature: opponent-silent, then challenge -> timeout settles game 0 as-is",
    async () => {
      stack = await startStack();
      const { hub } = hubOf(stack);
      const { alice, peer, id } = await peerMatch(stack);
      await scholarsMateVsPeer(alice, peer, id);
      await alice.api("POST", "/next-game", { channel: id });
      await waitStatus(alice, (st) => st.newGame === "proposed_by_me", 10_000, id);
      await waitFor(() => peer.session.snapshot().incomingCheckpoint !== null, 10_000, "the peer holding the proposal");
      // The peer never countersigns. Past one challengeTimeout of chain time without progress, Alice is told.
      await stack.increaseTime(TIMEOUT + 1);
      const silent = await waitStatus(alice, (st) => st.attention === "opponent-silent", 15_000, id);
      expect((silent.suggestedActions as string[])[0]).toMatch(/^arena challenge/);

      await alice.api("POST", "/challenge", { channel: id });
      await waitPhase(hub, id, "Challenged");
      const registered = await hub.registeredState(id);
      expect(registered.turnNum).toBe(8n); // game 0's terminal state (the peer's resignation)
      expect(registered.gameIndex).toBe(0);
      await stack.increaseTime(TIMEOUT + 1);
      await waitPhase(hub, id, "Finalized");
      await waitStatus(alice, (st) => st.phase === "Finalized", 15_000, id);
      await expectAliceWonGame0(stack, alice, peer);
      await expectNoErrors(alice);
    },
  );

  timed("4. Close signatures for the wrong state are rejected; only the right one settles", async () => {
    stack = await startStack();
    const { hub } = hubOf(stack);
    const domain = { chainId: stack.chainId, hub: stack.hub };
    const { alice, peer, id } = await peerMatch(stack);
    await scholarsMateVsPeer(alice, peer, id);
    const snap = peer.session.snapshot();
    const terminal = snap.latest.state; // turn 8
    const mated = snap.prev!.state; // turn 7: Alice's mating move, not a finished game

    // (a) A Close over the previous (non-final) state, claiming that state.
    peer.sendClose(await peer.closeRaw(mated));
    await waitFor(async () => (await lastErrorOf(alice, id)) === "close signature is for a different state", 10_000, "(a) refused");
    // (b) Claims the terminal state's hash, but the signature is over turn 7.
    peer.sendClose(await peer.closeRaw(mated, hashState(terminal, domain)));
    await waitFor(async () => (await lastErrorOf(alice, id)) === "invalid close signature", 10_000, "(b) refused");
    // (c) A *state* signature (not a Close intent) over the terminal state.
    const stateSig = (await peer.signRaw(terminal)).sigB;
    peer.sendClose({ stateHash: hashState(terminal, domain), by: 1, sig: stateSig });
    await waitFor(async () => {
      const st = (await alice.api("GET", `/status?channel=${id}`)) as Status;
      return st.lastError === "invalid close signature" && st.opponentWantsToClose === false;
    }, 10_000, "(c) refused");
    expect(snapshotOf(alice, id).closeSigs).toEqual(["0x", "0x"]);

    // Alice signs her own Close; the peer answers with a wrong one again -- still nothing settles.
    await alice.api("POST", "/close", { channel: id });
    peer.sendClose(await peer.closeRaw(mated, hashState(terminal, domain)));
    await waitFor(async () => (await lastErrorOf(alice, id)) === "invalid close signature", 10_000, "(d) refused");
    await new Promise((r) => setTimeout(r, 500));
    expect((await hub.channelInfo(id)).phase).toBe("Open");
    expect(snapshotOf(alice, id).closeSigs[1]).toBe("0x");

    await closeWithPeer(alice, peer, id, hub);
    await expectAliceWonGame0(stack, alice, peer);
    await expectNoErrors(alice);
  });

  timed("5. a spam of valid but stale states: lastError stays null and the daemon keeps responding", async () => {
    stack = await startStack();
    const { hub } = hubOf(stack);
    const domain = { chainId: stack.chainId, hub: stack.hub };
    const m = await mitmFor(stack); // transparent: counts what actually reaches Alice's daemon
    const { alice, peer, id } = await peerMatch(stack, m.url);
    for (let i = 0; i < 5; i++) {
      if (i % 2 === 0) await aliceMoves(alice, peer, id, SCHOLARS_MATE[i]);
      else await peerMoves(alice, peer, id, SCHOLARS_MATE[i]);
    }
    // Alice holds turn 5; the peer's own turns 2 and 4 are valid, signed, and stale. 150 of them (under the server's
    // per-connection frame burst, so the relay forwards them all rather than cutting the peer off).
    const before = snapshotOf(alice, id);
    const stale = [...peer.sent];
    const deliveredBefore = m.connections
      .flatMap((c) => c.seen.down)
      .filter((f: any) => f.type === "relay" && f.message.signed?.state.turnNum < 5n).length;
    expect(stale.map((s) => s.state.turnNum)).toEqual([2n, 4n]);
    const t0 = Date.now();
    for (let i = 0; i < 150; i++) peer.sendState(stale[i % stale.length]);
    let maxLatency = 0;
    for (let i = 0; i < 15; i++) {
      const s0 = Date.now();
      const st = (await alice.api("GET", `/status?channel=${id}`)) as Status;
      maxLatency = Math.max(maxLatency, Date.now() - s0);
      expect(st.lastError).toBeNull();
      await new Promise((r) => setTimeout(r, 100));
    }
    const delivered = () =>
      m.connections.flatMap((c) => c.seen.down).filter((f: any) => f.type === "relay" && f.message.signed?.state.turnNum < 5n).length;
    await waitFor(() => delivered() - deliveredBefore >= 150, 15_000, "all 150 stale states delivered to alice");
    console.log(`[adversarial] stale spam: max /status latency ${maxLatency} ms over ${Date.now() - t0} ms`);
    expect(maxLatency).toBeLessThan(1_000);
    expect(peer.serverErrors).toEqual([]);
    const after = snapshotOf(alice, id);
    expect(after.lastSignedTurn).toBe(before.lastSignedTurn);
    expect(hashState(after.latest.state, domain)).toBe(hashState(before.latest.state, domain));

    // Alice still plays promptly, and the game settles exactly.
    await scholarsMateVsPeer(alice, peer, id, 5);
    await closeWithPeer(alice, peer, id, hub);
    await expectAliceWonGame0(stack, alice, peer);
    await expectNoErrors(alice);
  });

  timed(
    "6. griefing challenges: each is answered by Alice's watchtower, and a repeat within the cooldown is refused on-chain",
    async () => {
      stack = await startStack();
      const { hub, pub } = hubOf(stack);
      const { alice, peer, id } = await peerMatch(stack);
      await aliceMoves(alice, peer, id, "e2e4");
      await peerMoves(alice, peer, id, "e7e5");
      await aliceMoves(alice, peer, id, "d1h5"); // Alice holds turn 3; the peer is on move
      const aliceSession = (await hub.channelParams(id)).signers[0].toLowerCase();

      const grief = async (staleTurn: bigint, answeredTurn: bigint, round: number) => {
        // A stale challenge from the peer's own session key: its own move at `staleTurn` (older than Alice's latest),
        // proven by Alice's signed state before it.
        const latest = peer.sent.find((x) => x.state.turnNum === staleTurn)!;
        const prev = peer.received(staleTurn - 1n)!;
        await peer.challenge({ hasPrev: true, prev, latest });
        await waitPhase(hub, id, "Open");
        const reg = await hub.registeredState(id);
        expect(reg.turnNum).toBe(answeredTurn);
        const responded = (await hub.disputeEvents(id)).filter((e) => e.kind === "Responded");
        expect(responded).toHaveLength(round);
        const tx = await pub.getTransaction({ hash: responded[round - 1].transactionHash });
        expect(tx.from.toLowerCase()).toBe(aliceSession);
        // Immediately again: the answered challenger is in cooldown for one challengeTimeout.
        const info = await hub.channelInfo(id);
        expect(info.cooldownUntil[1]).toBeGreaterThan(0n);
        const again = await peer.challenge(peer.session.challengeProof()).catch((e: unknown) => e);
        expect(again).toBeInstanceOf(HubRevertError);
        expect((again as HubRevertError).errorName).toBe("InCooldown");
        expect((await hub.channelInfo(id)).phase).toBe("Open");
        expect((await hub.disputeEvents(id)).filter((e) => e.kind === "Challenged")).toHaveLength(round);
      };

      // Round 1: the peer challenges with its own turn 2 (stale against Alice's 3).
      await grief(2n, 3n, 1);
      // After the cooldown, round 2: the peer moves (turn 4), Alice answers (turn 5), the peer challenges with 4.
      await stack.increaseTime(TIMEOUT + 1);
      await peerMoves(alice, peer, id, "b8c6");
      await aliceMoves(alice, peer, id, "f1c4");
      await grief(4n, 5n, 2);
      await expectNoErrors(alice);

      // The game finishes off-chain and settles exactly; Alice paid only gas for the griefing.
      await scholarsMateVsPeer(alice, peer, id, 5);
      await closeWithPeer(alice, peer, id, hub);
      await expectAliceWonGame0(stack, alice, peer);
      await expectNoErrors(alice);
    },
  );

  timed(
    "7. final review C1: forced responds drain Alice's session key; it is refilled each time, and a later stale challenge is still answered",
    async () => {
      stack = await startStack();
      const { hub, pub } = hubOf(stack);
      const { alice, peer, id } = await peerMatch(stack, undefined, { sessionGasWei: SESSION_GAS, sessionGasFloor: SESSION_GAS });
      const aliceSession = (await hub.channelParams(id)).signers[0];
      const sessionBalance = () => pub.getBalance({ address: aliceSession });
      await waitFor(async () => (await sessionBalance()) === SESSION_GAS, 20_000, "the funding top-up");
      await aliceMoves(alice, peer, id, "e2e4");
      await peerMoves(alice, peer, id, "e7e5");
      await aliceMoves(alice, peer, id, "d1h5"); // Alice holds turn 3; the peer is on move

      const forceRespond = async (staleTurn: bigint, answeredTurn: bigint, round: number) => {
        const latest = peer.sent.find((x) => x.state.turnNum === staleTurn)!;
        const prev = peer.received(staleTurn - 1n)!;
        await peer.challenge({ hasPrev: true, prev, latest });
        await waitPhase(hub, id, "Open", 30_000);
        expect((await hub.registeredState(id)).turnNum).toBe(answeredTurn);
        const responded = (await hub.disputeEvents(id)).filter((e) => e.kind === "Responded");
        expect(responded).toHaveLength(round);
        const tx = await pub.getTransaction({ hash: responded[round - 1].transactionHash });
        const receipt = await pub.getTransactionReceipt({ hash: responded[round - 1].transactionHash });
        expect(tx.from.toLowerCase()).toBe(aliceSession.toLowerCase());
        console.log(
          `[adversarial] C1 round ${round}: respond gas limit ${tx.gas}, maxFeePerGas ${tx.maxFeePerGas}, gasUsed ${receipt.gasUsed}, effectiveGasPrice ${receipt.effectiveGasPrice}, admission ${tx.gas * (tx.maxFeePerGas ?? 0n)}, cost ${receipt.gasUsed * receipt.effectiveGasPrice}`,
        );
        // The respond spent from the key; Alice's watchtower refills it back to exactly sessionGasWei.
        await waitFor(async () => (await sessionBalance()) === SESSION_GAS, 20_000, `the refill after round ${round}`);
      };

      await forceRespond(2n, 3n, 1);
      await stack.increaseTime(TIMEOUT + 1); // the peer's cooldown
      await peerMoves(alice, peer, id, "b8c6");
      await aliceMoves(alice, peer, id, "f1c4");
      await forceRespond(4n, 5n, 2);
      await stack.increaseTime(TIMEOUT + 1);
      await peerMoves(alice, peer, id, "g8f6");
      await aliceMoves(alice, peer, id, "e1e2");
      // The later stale challenge: without the refills, the key could no longer pay for this respond.
      await forceRespond(6n, 7n, 3);
      await expectNoErrors(alice);
      // The daemon logs each refill once its receipt wait returns, which can trail the balance the test reads.
      const refills = () => alice.logs().split("\n").filter((l) => /refilled the session key's dispute gas/.test(l)).length;
      await waitFor(() => refills() >= 3, 10_000, "three refill log lines");
    },
  );
});

