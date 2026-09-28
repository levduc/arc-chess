/**
 * Plan 4.5 Task 10: chaos over the real host server, real `arena daemon` processes and a real chain (Anvil).
 *
 * - **Crash at any point**: a seeded loop over 12 kill points spread across one channel's life (offer, match,
 *   funding, moves, a challenge, a new game, Close). At each one a seeded side is SIGKILLed after a seeded jitter and
 *   restarted on the same ARENA_HOME; the channel must still finish and settle exact USDC, and no signer may ever have
 *   signed two different states for one turn (or Close for two states).
 * - **RPC faults** (`faultyRpc.ts`): both daemons and the server talk to Anvil through faulty proxies (resets, 500s,
 *   JSON-RPC errors, timeouts; a 2000-block `getLogs` cap; a head whose logs lag 3 blocks). A full game plus a
 *   dispute completes, and the watchtower answers the dispute through the errors.
 * - **Reorgs** (`anvil_reorg`, on the stack's own Anvil only): a `Challenged` event reorged out and re-included, and
 *   deposits reorged out; daemons and the server indexer converge on the chain.
 * - **Server restarts** (same DB file): at the moment of a match (the match is replayed) and mid-game.
 *
 * Every seed is logged; `CHAOS_SEED=<n>` reruns the crash loop (and the fault proxy) with that seed.
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createTestClient,
  http,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { foundry } from "viem/chains";
import {
  CLOSE_TYPES,
  HubClient,
  LocalKeyTxSender,
  ZERO_HASH,
  channelHubAbi,
  fromWire,
  hashState,
  recoverStateSigner,
  type ArenaDomain,
  type Proof,
  type RelayMessage,
  type SessionSnapshot,
  type SignedState,
} from "@arena/sdk";
import { readJson, type ChannelRecord } from "@arena/cli";
import { pickAnvilPort, startStack, usdcBalanceOf, type Player, type Stack } from "./harness.js";
import { mulberry32, waitStatus, type Status } from "./bot.js";
import { startMitm, type Mitm } from "./mitm.js";
import { startFaultyRpc, type FaultyRpc, type Faults } from "./faultyRpc.js";

const SCHOLARS_MATE = ["e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6", "h5f7"];
/** Game 1 (Bob is white): fool's mate, Alice (black) mates on move 4. */
const FOOLS_MATE = ["f2f3", "e7e5", "g2g4", "d8h4"];

const DEPOSIT = 1_000_000n;
const STAKE = 100_000n;
const START = 10_000_000n;
const FEE = 5_000n;
/** Long enough that no dispute here can time out while a daemon restarts or an RPC call is held for 11 s. */
const TIMEOUT = 600;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let stack: Stack | undefined;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await Promise.resolve(c()).catch(() => {});
  await stack?.stop();
  stack = undefined;
}, 60_000);

const times: Array<{ name: string; ms: number }> = [];
afterAll(() => {
  for (const t of times) console.log(`[chaos timing] ${(t.ms / 1000).toFixed(1)}s  ${t.name}`);
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
    await sleep(100);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

async function waitPhase(hub: HubClient, id: Hex, phase: string, ms = 20_000): Promise<void> {
  await waitFor(async () => (await hub.channelInfo(id)).phase === phase, ms, `on-chain phase ${phase}`);
}

/** `waitStatus` that tolerates a failing `/status` (a daemon restarting, or its RPC failing under injected faults). */
async function waitSt(p: Player, pred: (s: Status) => boolean, ms: number, id: Hex, what = "status"): Promise<Status> {
  let last: Status | undefined;
  try {
    return await waitFor(async () => {
      last = (await p.api("GET", `/status?channel=${id}`)) as Status;
      return pred(last) ? last : undefined;
    }, ms, `${p.name}: ${what}`);
  } catch (err) {
    throw new Error(`${String(err)}; last status: ${JSON.stringify(last)}`);
  }
}

/** A GET retried through transient failures (injected RPC faults surface as a 5xx from the daemon API). */
async function getRetry(p: Player, path: string, ms = 30_000): Promise<any> {
  return waitFor(async () => (await p.api("GET", path)) ?? {}, ms, `${p.name} GET ${path}`);
}

async function postOffer(alice: Player): Promise<Hex> {
  const { offerId } = await alice.api("POST", "/offers", {
    deposit: DEPOSIT.toString(),
    stakePerGame: STAKE.toString(),
    challengeTimeout: String(TIMEOUT),
  });
  return offerId as Hex;
}

async function channelOf(p: Player, ms = 30_000): Promise<Hex> {
  return waitFor(async () => {
    const channels = (await p.api("GET", "/channels")) as Array<{ channelId: Hex }>;
    return channels[0]?.channelId;
  }, ms, `${p.name}'s channel`);
}

async function expectBalances(s: Stack, want: Array<[Player | "host", bigint]>): Promise<void> {
  for (const [who, amount] of want) {
    const addr = who === "host" ? s.host : who.address;
    expect(await usdcBalanceOf(s, addr), `${who === "host" ? "host" : who.name}'s USDC`).toBe(amount);
  }
}

async function expectNoErrors(...players: Player[]): Promise<void> {
  for (const p of players) {
    const chs = (await p.api("GET", "/channels")) as Array<{ channelId: Hex; lastError: string | null }>;
    for (const c of chs) expect(c.lastError, `${p.name}'s lastError on ${c.channelId}`).toBeNull();
  }
}

/** Whoever is on move in `id` right now (by white's own view), and the other side. */
async function sides(white: Player, black: Player, id: Hex): Promise<[Player, Player]> {
  const w = (await white.api("GET", `/status?channel=${id}`)) as Status;
  return w.myTurn ? [white, black] : [black, white];
}

/** One move, then waits until the other side holds it. */
async function moveOnce(white: Player, black: Player, id: Hex, move: string, ms = 20_000): Promise<Status> {
  const [mover, other] = await sides(white, black, id);
  const st = (await mover.api("POST", "/move", { move, channel: id })) as Status;
  await waitSt(other, (s) => s.turnNum === st.turnNum || s.gameStatus !== "playing", ms, id, `turn ${st.turnNum}`);
  return st;
}

/** The server indexer's view of a channel (`/api/channels/:id`). */
async function serverChannel(s: Stack, id: Hex): Promise<{ phase: string | null; latest: { turnNum: string } | null }> {
  const res = await fetch(`${s.serverUrl}/api/channels/${id}`);
  if (!res.ok) throw new Error(`/api/channels/${id} -> ${res.status}`);
  return (await res.json()) as { phase: string | null; latest: { turnNum: string } | null };
}

async function serverPlayer(s: Stack, addr: Address): Promise<{ challengesInitiated: number; challengesAnswered: number }> {
  const res = await fetch(`${s.serverUrl}/players/${addr.toLowerCase()}`);
  if (!res.ok) throw new Error(`/players/${addr} -> ${res.status}`);
  return (await res.json()) as { challengesInitiated: number; challengesAnswered: number };
}

async function rpc<T = unknown>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

// ------------------------------------------------------------------------------------------ equivocation check

/**
 * Collects every signed state and Close signature seen for one channel -- from both daemons' `session.json`
 * snapshots (sampled over time), the server's relay cache (its sqlite `relay_cache`), and every relay frame a daemon
 * sent through the MITM -- recovers each signature's signer, and reports any signer that signed two different state
 * hashes for one turnNum, or Close for two different states.
 */
class EquivocationLog {
  private readonly states = new Map<string, Map<Hex, string>>(); // `${signer}|${turn}` -> state hash -> first source
  private readonly closes = new Map<string, Map<Hex, string>>(); // signer -> close state hash -> first source
  private readonly checked = new Map<string, boolean>(); // `${digest}|${sig}` -> recovered to the expected signer
  readonly counts = { sigs: 0, invalid: 0, bySource: {} as Record<string, number> };
  private db: DatabaseSync | undefined;

  constructor(
    private readonly domain: ArenaDomain,
    private readonly channelId: Hex,
    private readonly signers: readonly [Address, Address],
    private readonly dbPath: string,
  ) {}

  private bump(source: string): void {
    const kind = source.split(":")[0];
    this.counts.bySource[kind] = (this.counts.bySource[kind] ?? 0) + 1;
    this.counts.sigs++;
  }

  async addSigned(ss: SignedState | null | undefined, source: string): Promise<void> {
    if (!ss || ss.state.channelId.toLowerCase() !== this.channelId.toLowerCase()) return;
    const hash = hashState(ss.state, this.domain);
    const sigs = [ss.sigA, ss.sigB];
    for (let i = 0; i < 2; i++) {
      const sig = sigs[i];
      if (!sig || sig === "0x") continue;
      const key = `${hash}|${sig}`;
      let ok = this.checked.get(key);
      if (ok === undefined) {
        const who = await recoverStateSigner(ss.state, sig, this.domain).catch(() => null);
        ok = who !== null && who.toLowerCase() === this.signers[i].toLowerCase();
        this.checked.set(key, ok);
        if (!ok) this.counts.invalid++;
      }
      if (!ok) continue;
      this.bump(source);
      const k = `${this.signers[i]}|${ss.state.turnNum}`;
      const m = this.states.get(k) ?? new Map<Hex, string>();
      if (!m.has(hash)) m.set(hash, `${source} (sig ${i === 0 ? "A" : "B"})`);
      this.states.set(k, m);
    }
  }

  async addClose(stateHash: Hex, by: number, sig: Hex, source: string): Promise<void> {
    if (sig === "0x" || (by !== 0 && by !== 1)) return;
    const key = `close:${stateHash}|${sig}`;
    let ok = this.checked.get(key);
    if (ok === undefined) {
      const who = await recoverTypedDataAddress({
        domain: { name: "AgentArena", version: "1", chainId: this.domain.chainId, verifyingContract: this.domain.hub },
        types: CLOSE_TYPES,
        primaryType: "Close",
        message: { channelId: this.channelId, stateHash },
        signature: sig,
      }).catch(() => null);
      ok = who !== null && who.toLowerCase() === this.signers[by].toLowerCase();
      this.checked.set(key, ok);
      if (!ok) this.counts.invalid++;
    }
    if (!ok) return;
    this.bump(source);
    const m = this.closes.get(this.signers[by]) ?? new Map<Hex, string>();
    if (!m.has(stateHash)) m.set(stateHash, source);
    this.closes.set(this.signers[by], m);
  }

  async addSnapshot(snap: SessionSnapshot | null, source: string): Promise<void> {
    if (!snap) return;
    for (const [field, ss] of [
      ["latest", snap.latest],
      ["prev", snap.prev],
      ["pendingCheckpoint", snap.pendingCheckpoint],
      ["incomingCheckpoint", snap.incomingCheckpoint],
      ["closeState", snap.closeState],
    ] as const) {
      await this.addSigned(ss, `${source}.${field}`);
    }
    for (let i = 0; i < 2; i++) {
      const sig = snap.closeSigs[i];
      if (sig === "0x") continue;
      const target = snap.closeSigTargets?.[i];
      const stateHash =
        target && target !== ZERO_HASH ? target : hashState((snap.closeState ?? snap.latest).state, this.domain);
      await this.addClose(stateHash, i, sig, `${source}.closeSigs[${i}]`);
    }
  }

  async addRelay(msg: RelayMessage, source: string): Promise<void> {
    if (msg.channelId?.toLowerCase() !== this.channelId.toLowerCase()) return;
    if (msg.type === "state") await this.addSigned(msg.signed, source);
    else if (msg.type === "close") await this.addClose(msg.close.stateHash, msg.close.by, msg.close.sig, source);
  }

  /** Reads the server's relay cache for this channel (read-only; the server keeps writing it in WAL mode). */
  async addRelayCache(): Promise<void> {
    let rows: Array<{ body: string }>;
    try {
      this.db ??= new DatabaseSync(this.dbPath, { readOnly: true });
      rows = this.db.prepare("SELECT body FROM relay_cache WHERE channel_id = ?").all(this.channelId) as Array<{ body: string }>;
    } catch {
      // busy, or the server is restarting: the next sample gets it
      this.db?.close();
      this.db = undefined;
      return;
    }
    for (const r of rows) await this.addRelay(fromWire<RelayMessage>(r.body), "relayCache");
  }

  async addSessions(players: Player[]): Promise<void> {
    for (const p of players) {
      let snap: SessionSnapshot | null = null;
      try {
        snap = readJson<SessionSnapshot>(join(p.home, "channels", this.channelId, "session.json"));
      } catch {
        continue; // mid-rename: the next sample gets it
      }
      await this.addSnapshot(snap, `session:${p.name}`);
    }
  }

  async addMitmFrames(m: Mitm): Promise<void> {
    for (const c of m.connections) {
      for (const f of c.seen.up as Array<{ type?: string; message?: RelayMessage }>) {
        if (f?.type === "relay" && f.message) await this.addRelay(f.message, `mitm:conn${c.id}`);
      }
    }
  }

  /** On-chain dispute states (Challenged/Responded) are signed states too. */
  async addChain(hub: HubClient): Promise<void> {
    for (const e of await hub.disputeEvents(this.channelId)) await this.addSigned(e.signed, `chain:${e.kind}`);
  }

  /** Distinct (signer, turn) pairs seen. */
  get pairs(): number {
    return this.states.size;
  }

  violations(): string[] {
    const out: string[] = [];
    for (const [k, m] of this.states) {
      if (m.size > 1) out.push(`signer|turn ${k} signed ${m.size} different states: ${[...m].map(([h, s]) => `${h} via ${s}`).join("; ")}`);
    }
    for (const [signer, m] of this.closes) {
      if (m.size > 1) out.push(`${signer} signed Close for ${m.size} states: ${[...m].map(([h, s]) => `${h} via ${s}`).join("; ")}`);
    }
    return out;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }
}

/** Samples `log` from the sessions and the relay cache every `ms` until stopped; `sample()` forces one now. */
function startSampler(log: EquivocationLog, players: Player[], ms = 150): { sample(): Promise<void>; stop(): Promise<void> } {
  let running: Promise<void> = Promise.resolve();
  const once = () => {
    running = running.then(async () => {
      await log.addSessions(players);
      await log.addRelayCache();
    });
    return running;
  };
  const timer = setInterval(() => void once(), ms);
  return {
    sample: once,
    async stop() {
      clearInterval(timer);
      await once();
    },
  };
}

// ------------------------------------------------------------------------------------------------ crash loop

const KILL_POINTS = [
  "after offer",
  "after match",
  "mid-funding",
  "after move 1 (e4)",
  "after move 2 (e5)",
  "after move 3 (Qh5)",
  "while challenged",
  "after the answering move (Nc6)",
  "after the mating move (Qxf7#)",
  "after proposing a new game",
  "after a game-1 move (g4)",
  "after signing Close",
] as const;

function chaosSeeds(): number[] {
  const env = process.env.CHAOS_SEED;
  if (env !== undefined && env !== "") return [Number(env)];
  // Two fixed seeds (a stable regression baseline) plus a fresh one per run (keeps exploring; printed on failure).
  return [1, 2, Date.now() % 1_000_000_007];
}

async function crashLoop(seed: number): Promise<void> {
  console.log(`[chaos] crash loop seed=${seed} (rerun with CHAOS_SEED=${seed})`);
  const rand = mulberry32(seed);
  const s = await startStack();
  stack = s;
  const mitm = await startMitm(s.serverUrl); // pass-through: records every relay frame each daemon sent
  cleanups.push(() => mitm.stop());
  const alice = await s.player("alice", undefined, { serverUrl: mitm.url });
  const bob = await s.player("bob", undefined, { serverUrl: mitm.url });
  const { hub } = hubOf(s);
  const plan: string[] = [];

  let log: EquivocationLog | undefined;
  let sampler: ReturnType<typeof startSampler> | undefined;
  let point = 0;
  /** Kill point `point`: SIGKILL a seeded side after a seeded jitter, restart it at once. */
  const crash = async (): Promise<Player> => {
    const name = KILL_POINTS[point++];
    const victim = rand() < 0.5 ? alice : bob;
    const jitter = Math.floor(rand() ** 2 * 250); // skewed small: most kills land while the daemon is still busy
    plan.push(`${point}. ${name}: kill ${victim.name} after ${jitter} ms`);
    await sleep(jitter);
    await sampler?.sample();
    await victim.kill("SIGKILL");
    await victim.start();
    await sampler?.sample();
    return victim;
  };

  try {
    const offerId = await postOffer(alice);
    await crash(); // 1. after offer
    await bob.api("POST", "/offers/accept", { offerId });
    await crash(); // 2. after match
    const id = await channelOf(bob);
    await channelOf(alice);
    const params = (await hub.channelParams(id)) as { signers: readonly [Address, Address] };
    log = new EquivocationLog({ chainId: s.chainId, hub: s.hub }, id, [params.signers[0], params.signers[1]], s.serverDbPath);
    sampler = startSampler(log, [alice, bob]);

    await waitFor(async () => (await hub.channelInfo(id)).funded[0], 30_000, "alice's deposit");
    await crash(); // 3. mid-funding
    await waitPhase(hub, id, "Open", 30_000);
    await waitSt(alice, (st) => st.phase === "Open", 20_000, id, "Open");
    await waitSt(bob, (st) => st.phase === "Open", 20_000, id, "Open");

    // Game 0: scholar's mate with a challenge in the middle. Before each move, wait until the mover holds the turn
    // before it (a restarted daemon may still be catching up through the relay's re-send).
    const play = async (move: string, turn: number) => {
      await waitSt(alice, (st) => st.turnNum === String(turn - 1), 20_000, id, `turn ${turn - 1}`);
      await waitSt(bob, (st) => st.turnNum === String(turn - 1), 20_000, id, `turn ${turn - 1}`);
      await moveOnce(alice, bob, id, move);
    };
    await play("e2e4", 1);
    await crash(); // 4
    await play("e7e5", 2);
    await crash(); // 5
    await play("d1h5", 3);
    await crash(); // 6
    await waitSt(bob, (st) => st.turnNum === "3" && st.myTurn, 20_000, id, "Bob on move at turn 3");
    await alice.api("POST", "/challenge", { channel: id });
    await waitPhase(hub, id, "Challenged");
    await crash(); // 7. while challenged
    await waitSt(bob, (st) => (st.challenge as { mustMove?: boolean } | null)?.mustMove === true, 20_000, id, "mustMove");
    await bob.api("POST", "/move", { move: "b8c6", channel: id });
    await crash(); // 8. after the answering move (bob's daemon responds right after it; alice's watchtower may race)
    await waitPhase(hub, id, "Open", 30_000);
    await play("f1c4", 5);
    await play("g8f6", 6);
    await play("h5f7", 7); // mate: Bob's daemon auto-resigns (turn 8)
    await crash(); // 9. after the mating move
    await waitSt(alice, (st) => st.gameStatus === "white_won" && st.turnNum === "8", 20_000, id, "game 0 over");
    await waitSt(bob, (st) => st.gameStatus === "white_won" && st.turnNum === "8", 20_000, id, "game 0 over");

    // Game 1: Alice proposes, Bob countersigns; Bob is white.
    await alice.api("POST", "/next-game", { channel: id });
    await crash(); // 10. after proposing a new game
    await waitSt(bob, (st) => st.attention === "new-game-proposed", 20_000, id, "new game proposed");
    await bob.api("POST", "/next-game", { channel: id });
    await waitSt(alice, (st) => (st.gameIndex as number) === 1 && st.newGame === "none", 20_000, id, "game 1 started");
    await waitSt(bob, (st) => (st.gameIndex as number) === 1 && st.newGame === "none", 20_000, id, "game 1 started");
    const g1 = Number((await alice.api("GET", `/status?channel=${id}`)).turnNum);
    await play(FOOLS_MATE[0], g1 + 1);
    await play(FOOLS_MATE[1], g1 + 2);
    await play(FOOLS_MATE[2], g1 + 3);
    await crash(); // 11. after a game-1 move
    await play(FOOLS_MATE[3], g1 + 4); // mate: Bob's daemon auto-resigns
    const end = String(g1 + 5);
    await waitSt(alice, (st) => st.gameStatus === "black_won" && st.turnNum === end, 20_000, id, "game 1 over");
    await waitSt(bob, (st) => st.gameStatus === "black_won" && st.turnNum === end, 20_000, id, "game 1 over");

    // Close: Alice signs, a crash, then Bob signs once he holds Alice's Close signature.
    await alice.api("POST", "/close", { channel: id });
    await crash(); // 12. after signing Close
    await waitSt(bob, (st) => st.opponentWantsToClose === true, 20_000, id, "alice's Close signature");
    await bob.api("POST", "/close", { channel: id });
    await waitPhase(hub, id, "Finalized", 30_000);
    await waitSt(alice, (st) => st.phase === "Finalized", 20_000, id, "Finalized");
    await waitSt(bob, (st) => st.phase === "Finalized", 20_000, id, "Finalized");
    expect(point).toBe(KILL_POINTS.length);

    await expectBalances(s, [
      [alice, START + 2n * STAKE - FEE],
      [bob, START - 2n * STAKE - FEE],
      ["host", 2n * FEE],
    ]);
    await expectNoErrors(alice, bob);

    await sampler.stop();
    await log.addMitmFrames(mitm);
    await log.addChain(hub);
    console.log(
      `[chaos] seed=${seed} equivocation check: ${log.counts.sigs} signatures, ${log.pairs} (signer, turn) pairs, ` +
        `by source ${JSON.stringify(log.counts.bySource)}`,
    );
    expect(log.counts.invalid, "signatures that did not recover to their seat's signer").toBe(0);
    expect(log.violations()).toEqual([]);
    // Coverage: both seats' signatures on every turn of both games, from more than one source.
    expect(log.pairs).toBeGreaterThanOrEqual(Number(end));
    expect(Object.keys(log.counts.bySource).sort()).toEqual(expect.arrayContaining(["chain", "mitm", "relayCache", "session"]));
    console.log(`[chaos] seed=${seed} kill plan:\n  ${plan.join("\n  ")}`);
  } catch (err) {
    const msg = `crash loop failed with CHAOS_SEED=${seed} at kill point ${point}/${KILL_POINTS.length}\n  ${plan.join("\n  ")}`;
    console.error(`[chaos] ${msg}\n--- alice ---\n${alice.logs().slice(-4000)}\n--- bob ---\n${bob.logs().slice(-4000)}`);
    throw new Error(`${msg}\n${String(err)}`);
  } finally {
    await sampler?.stop().catch(() => {});
    log?.close();
  }
}

// --------------------------------------------------------------------------------------------- RPC fault helpers

/** Retries `fn` until it succeeds; `done()` (checked first and after each failure) short-circuits a step whose
 *  effect already happened even though its call reported a failure (e.g. a move persisted and relayed, then a
 *  follow-up RPC read failed). */
async function retry<T>(what: string, fn: () => Promise<T>, done?: () => Promise<boolean>, ms = 60_000): Promise<T | undefined> {
  const end = Date.now() + ms;
  let last: unknown;
  let attempts = 0;
  while (Date.now() < end) {
    if (done && (await done().catch(() => false))) return undefined;
    try {
      attempts++;
      return await fn();
    } catch (err) {
      last = err;
      await sleep(200);
    }
  }
  throw new Error(`${what}: still failing after ${attempts} attempts: ${String(last)}`);
}

// --------------------------------------------------------------------------------------------------- scenarios

describe("chaos (real server, real `arena daemon` processes, real chain)", () => {
  for (const seed of chaosSeeds()) {
    timed(`crash at any point: 12 seeded SIGKILL + restart points, seed ${seed}`, () => crashLoop(seed), 240_000);
  }

  timed(
    "RPC faults: 20% fault rate, 2000-block getLogs cap, lagging head (K=3) on both daemons and the server -> game + dispute settle",
    async () => {
      const seed = process.env.CHAOS_SEED ? Number(process.env.CHAOS_SEED) : Date.now() % 1_000_000_007;
      console.log(`[chaos] rpc-fault seed=${seed} (rerun with CHAOS_SEED=${seed})`);
      // The server's proxy must exist (fault-free) before the server starts: its startup checks the chain identity.
      const anvilPort = await pickAnvilPort();
      const anvilUrl = `http://127.0.0.1:${anvilPort}`;
      const serverRpc = await startFaultyRpc(anvilUrl, { seed: seed + 1, label: "faulty-rpc:server" });
      cleanups.push(() => serverRpc.stop());
      const s = await startStack({ anvilPort, blockTime: 1, serverOverrides: { rpcUrl: serverRpc.url } });
      stack = s;
      const aliceRpc = await startFaultyRpc(s.rpcUrl, { seed, label: "faulty-rpc:alice" });
      const bobRpc = await startFaultyRpc(s.rpcUrl, { seed: seed + 2, label: "faulty-rpc:bob" });
      cleanups.push(() => aliceRpc.stop(), () => bobRpc.stop());
      const alice = await s.player("alice", undefined, { rpcUrl: aliceRpc.url });
      const bob = await s.player("bob", undefined, { rpcUrl: bobRpc.url });
      const { hub, pub } = hubOf(s);
      const proxies: FaultyRpc[] = [aliceRpc, bobRpc, serverRpc];

      // 20% of requests fail: mostly resets and 500s (retried by viem), some JSON-RPC errors (not retried: they reach
      // the daemon), and a few 11 s timeouts. Cap and lag are always on.
      const FAULTS: Faults = {
        methods: { "*": { reset: 0.08, http500: 0.08, rpcError: 0.035, delay: 0.005 } },
        delayMs: 11_000,
        getLogsMaxRange: 2000,
        lagBlocks: 3,
      };
      for (const p of proxies) {
        p.resetStats();
        p.setFaults(FAULTS);
      }
      // What each daemon's /channels reported as lastError while the faults were on.
      const lastErrors = new Map<string, number>();
      let sampling = true;
      const errorSampler = (async () => {
        while (sampling) {
          for (const p of [alice, bob]) {
            try {
              const chs = (await p.api("GET", "/channels")) as Array<{ lastError: string | null }>;
              for (const c of chs) {
                if (!c.lastError) continue;
                const k = `${p.name}: ${c.lastError.slice(0, 60)}`;
                lastErrors.set(k, (lastErrors.get(k) ?? 0) + 1);
              }
            } catch {
              // the API itself failed on a fault: that is the point
            }
          }
          await sleep(250);
        }
      })();

      try {
        const offerId = (await retry("post offer", () => postOffer(alice)))!;
        await retry("accept", () => bob.api("POST", "/offers/accept", { offerId }));
        const id = await channelOf(bob, 60_000);
        await waitSt(alice, (st) => st.phase === "Open", 90_000, id, "Open");
        await waitSt(bob, (st) => st.phase === "Open", 90_000, id, "Open");

        // A fault-tolerant move: done once the mover holds the next turn, whatever the call reported.
        const turnOf = async (p: Player) => Number((await p.api("GET", `/status?channel=${id}`)).turnNum);
        const moveRobust = async (move: string, turn: number) => {
          await waitSt(alice, (st) => st.turnNum === String(turn - 1), 60_000, id, `turn ${turn - 1}`);
          await waitSt(bob, (st) => st.turnNum === String(turn - 1), 60_000, id, `turn ${turn - 1}`);
          const w = (await getRetry(alice, `/status?channel=${id}`)) as Status;
          const mover = w.myTurn ? alice : bob;
          await retry(`move ${move}`, () => mover.api("POST", "/move", { move, channel: id }), async () => (await turnOf(mover)) >= turn);
        };
        await moveRobust("e2e4", 1);
        await moveRobust("e7e5", 2);
        // Bob's copy of turn 2 (prev: turn 1): the stale proof he will challenge with later.
        const bobDir = join(bob.home, "channels", id);
        const oldSnap = readJson<SessionSnapshot>(join(bobDir, "session.json"))!;
        expect(oldSnap.latest.state.turnNum).toBe(2n);
        const staleProof: Proof = { hasPrev: true, prev: oldSnap.prev!, latest: oldSnap.latest };

        // 3000 blocks while Bob's daemon is down: his first scan after the restart spans > 2000 blocks, so it only
        // gets through the capped RPC in chunks. The chain clock moves too (1 s per block), harmlessly: no dispute
        // is pending and the channel is Open.
        // SIGKILL, not SIGTERM: a graceful stop waits for the tick in flight, which a delay fault can hold for
        // several 10 s viem timeouts -- longer than the harness waits for an exit.
        await bob.kill("SIGKILL");
        const testClient = createTestClient({ mode: "anvil", chain: foundry, transport: http(s.rpcUrl) });
        const headBefore = await pub.getBlockNumber({ cacheTime: 0 });
        await testClient.mine({ blocks: 3000 });
        await bob.start();
        const bobRecord = () => readJson<ChannelRecord>(join(bobDir, "record.json"))!;
        await waitFor(() => (bobRecord().scannedBlock ?? 0n) > headBefore + 3000n - 10n, 90_000, "bob's dispute scan past the 3000 mined blocks");

        await moveRobust("d1h5", 3);
        await moveRobust("b8c6", 4);
        await moveRobust("f1c4", 5);

        // The dispute: with his daemon stopped, Bob challenges straight from his session key with the stale turn-2
        // proof (the test's own transaction goes to Anvil directly). No daemon API call follows: Alice's watchtower
        // must answer it, through her faulty RPC, with the newer turn-5 state.
        await waitSt(bob, (st) => st.turnNum === "5", 60_000, id, "turn 5");
        await bob.kill("SIGKILL");
        const faultsBefore = aliceRpc.stats.injected.reset + aliceRpc.stats.injected.http500 + aliceRpc.stats.injected.rpcError;
        const bobSession = new LocalKeyTxSender(bobRecord().sessionKey, s.rpcUrl, foundry);
        await hub.challenge(bobSession, staleProof);
        await waitPhase(hub, id, "Open", 120_000);
        expect((await hub.registeredState(id)).turnNum).toBe(5n);
        const responded = (await hub.disputeEvents(id)).filter((e) => e.kind === "Responded");
        expect(responded).toHaveLength(1);
        const rtx = await pub.getTransaction({ hash: responded[0].transactionHash });
        const signers = (await hub.channelParams(id)).signers;
        const responder = rtx.from.toLowerCase() === signers[0].toLowerCase() ? "alice" : rtx.from.toLowerCase() === signers[1].toLowerCase() ? "bob" : "?";
        expect(responder).toBe("alice"); // her watchtower's session key answered, not the test
        const faultsDuring = aliceRpc.stats.injected.reset + aliceRpc.stats.injected.http500 + aliceRpc.stats.injected.rpcError - faultsBefore;
        console.log(`[chaos] rpc-fault: the stale challenge was answered by ${responder}'s watchtower; ${faultsDuring} faults hit alice's RPC meanwhile`);
        await bob.start();

        await moveRobust("g8f6", 6);
        await moveRobust("h5f7", 7);
        await waitSt(alice, (st) => st.gameStatus === "white_won" && st.turnNum === "8", 60_000, id, "game over");
        await waitSt(bob, (st) => st.gameStatus === "white_won" && st.turnNum === "8", 60_000, id, "game over");
        await retry("alice close", () => alice.api("POST", "/close", { channel: id }));
        await waitSt(bob, (st) => st.opponentWantsToClose === true, 60_000, id, "alice's Close");
        // Bob's close is called once: if its submission fails on a fault, the watchtowers' retry must finish it.
        await bob.api("POST", "/close", { channel: id }).catch((err: unknown) => console.log(`[chaos] rpc-fault: bob's close call failed (${String(err)}); the watchtower retries`));
        await waitPhase(hub, id, "Finalized", 90_000);
        await waitSt(alice, (st) => st.phase === "Finalized", 60_000, id, "Finalized");
        await waitSt(bob, (st) => st.phase === "Finalized", 60_000, id, "Finalized");

        // Faults off, then a few clean watchtower passes before asserting no error is left behind.
        sampling = false;
        await errorSampler;
        for (const p of proxies) p.setFaults({});
        await sleep(1500);
        await expectBalances(s, [
          [alice, START + STAKE - FEE],
          [bob, START - STAKE - FEE],
          ["host", 2n * FEE],
        ]);
        for (const [name, p] of [["alice", aliceRpc], ["bob", bobRpc], ["server", serverRpc]] as const) {
          console.log(`[chaos] rpc-fault ${name} proxy: ${JSON.stringify(p.stats)}`);
        }
        console.log(`[chaos] rpc-fault: lastError values seen while faults were on: ${JSON.stringify([...lastErrors])}`);
        await expectNoErrors(alice, bob);
        // The server indexer, behind its own faulty proxy, still followed the channel to its end.
        await waitFor(async () => (await serverChannel(s, id)).phase === "Finalized", 30_000, "indexer: Finalized");
        await waitFor(async () => (await serverPlayer(s, bob.address)).challengesInitiated === 1, 30_000, "indexer: bob's one challenge");

        for (const p of proxies) {
          expect(p.stats.injected.reset + p.stats.injected.http500 + p.stats.injected.rpcError).toBeGreaterThan(0);
          expect(p.stats.maxGetLogsSpan).toBeLessThanOrEqual(2000);
        }
        expect(aliceRpc.stats.lagged + bobRpc.stats.lagged + serverRpc.stats.lagged).toBeGreaterThan(0);
        expect(lastErrors.size).toBeGreaterThan(0); // the faults reached the daemons, not just viem's retries
      } catch (err) {
        console.error(`[chaos] rpc-fault failed with CHAOS_SEED=${seed}\n--- alice ---\n${alice.logs().slice(-6000)}\n--- bob ---\n${bob.logs().slice(-6000)}`);
        throw err;
      } finally {
        sampling = false;
        await errorSampler;
      }
    },
    420_000,
  );

  timed(
    "reorg: a Challenged event reorged out and re-included -> daemons and the server indexer converge each time",
    async () => {
      const s = await startStack();
      stack = s;
      const alice = await s.player("alice");
      const bob = await s.player("bob");
      const { hub, pub } = hubOf(s);
      const offerId = await postOffer(alice);
      await bob.api("POST", "/offers/accept", { offerId });
      const id = await channelOf(bob);
      await waitSt(alice, (st) => st.phase === "Open", 30_000, id, "Open");
      await waitSt(bob, (st) => st.phase === "Open", 30_000, id, "Open");
      await moveOnce(alice, bob, id, "e2e4");

      const converged = async (phase: string) => {
        await waitPhase(hub, id, phase);
        await waitSt(alice, (st) => st.phase === phase, 20_000, id, phase);
        await waitSt(bob, (st) => st.phase === phase, 20_000, id, phase);
        await waitFor(async () => (await serverChannel(s, id)).phase === phase, 20_000, `indexer: ${phase}`);
      };

      await alice.api("POST", "/challenge", { channel: id });
      await converged("Challenged");
      const [ev] = (await hub.disputeEvents(id)).filter((e) => e.kind === "Challenged");
      const raw = await rpc<Hex>(s.rpcUrl, "eth_getRawTransactionByHash", [ev.transactionHash]);
      const head = await pub.getBlockNumber({ cacheTime: 0 });
      expect(head).toBe(ev.blockNumber); // nothing mined since: a depth-1 reorg drops exactly the challenge
      await rpc(s.rpcUrl, "anvil_reorg", [1, []]);
      expect(await pub.getBlockNumber({ cacheTime: 0 })).toBe(head); // same height, new (empty) block
      await converged("Open");
      expect((await serverPlayer(s, alice.address)).challengesInitiated).toBe(0);

      // Re-included: the same signed transaction, now mined one block later.
      const again = await rpc<Hex>(s.rpcUrl, "eth_sendRawTransaction", [raw]);
      expect(again).toBe(ev.transactionHash);
      await converged("Challenged");
      const [ev2] = (await hub.disputeEvents(id)).filter((e) => e.kind === "Challenged");
      expect(ev2.blockNumber).toBe(head + 1n);
      expect((await serverPlayer(s, alice.address)).challengesInitiated).toBe(1);
      await waitSt(bob, (st) => (st.challenge as { mustMove?: boolean } | null)?.mustMove === true, 20_000, id, "mustMove");

      // Play resumes: Bob's move answers the challenge, the game ends, and the channel closes exactly.
      await bob.api("POST", "/move", { move: "e7e5", channel: id });
      await converged("Open");
      expect((await serverPlayer(s, bob.address)).challengesAnswered).toBe(1);
      await waitSt(alice, (st) => st.turnNum === "2", 20_000, id, "turn 2");
      for (const m of SCHOLARS_MATE.slice(2)) await moveOnce(alice, bob, id, m);
      await waitSt(bob, (st) => st.gameStatus === "white_won" && st.turnNum === "8", 20_000, id, "game over");
      await waitSt(alice, (st) => st.turnNum === "8", 20_000, id, "turn 8");
      await alice.api("POST", "/close", { channel: id });
      await waitSt(bob, (st) => st.opponentWantsToClose === true, 20_000, id, "alice's Close");
      await bob.api("POST", "/close", { channel: id });
      await converged("Finalized");
      await expectBalances(s, [
        [alice, START + STAKE - FEE],
        [bob, START - STAKE - FEE],
        ["host", 2n * FEE],
      ]);
      await expectNoErrors(alice, bob);
    },
    120_000,
  );

  for (const depth of [2, 3]) {
    timed(
      `reorg: the opening deposit reorged out at depth ${depth} -> funding recovers, exactly one deposit each`,
      async () => {
        const s = await startStack();
        stack = s;
        const alice = await s.player("alice");
        const bob = await s.player("bob");
        const { hub, pub } = hubOf(s);
        const offerId = await postOffer(alice);
        await bob.api("POST", "/offers/accept", { offerId });
        const id = await channelOf(bob);
        await waitPhase(hub, id, "Open", 30_000);
        await waitSt(alice, (st) => st.phase === "Open", 20_000, id, "Open");
        await waitSt(bob, (st) => st.phase === "Open", 20_000, id, "Open");
        await waitFor(async () => (await serverChannel(s, id)).phase === "Open", 20_000, "indexer: Open");

        const deposits = async () =>
          pub.getContractEvents({ address: s.hub, abi: channelHubAbi, eventName: "Deposited", args: { channelId: id }, fromBlock: 0n });
        const [, second] = await deposits();
        const head = await pub.getBlockNumber({ cacheTime: 0 });
        expect(head).toBe(second.blockNumber); // the opening deposit is the chain tip
        // What the reorg drops, for the report: depth 2 = Bob's deposit + his session-gas top-up; depth 3 adds his
        // USDC approve.
        const dropped: string[] = [];
        for (let b = head - BigInt(depth) + 1n; b <= head; b++) {
          const block = await pub.getBlock({ blockNumber: b, includeTransactions: true });
          for (const tx of block.transactions) dropped.push(`${b}:${tx.from.slice(0, 8)}->${tx.to?.slice(0, 8)}:${tx.input.slice(0, 10)}`);
        }
        console.log(`[chaos] reorg depth ${depth} drops: ${dropped.join(", ")}`);
        await rpc(s.rpcUrl, "anvil_reorg", [depth, []]);
        const reorged = await hub.channelInfo(id);
        expect(reorged.phase).toBe("Funding");
        expect(reorged.funded).toEqual([true, false]);

        // Bob's watchtower sees the channel back in Funding and deposits again; the server follows.
        await waitPhase(hub, id, "Open", 30_000);
        await waitSt(bob, (st) => st.phase === "Open", 20_000, id, "Open again");
        await waitFor(async () => (await serverChannel(s, id)).phase === "Open", 20_000, "indexer: Open again");
        expect((await deposits()).length).toBe(2);
        expect(await usdcBalanceOf(s, bob.address)).toBe(START - DEPOSIT - FEE);

        await moveOnce(alice, bob, id, "e2e4");
        for (const m of SCHOLARS_MATE.slice(1)) await moveOnce(alice, bob, id, m);
        await waitSt(bob, (st) => st.gameStatus === "white_won" && st.turnNum === "8", 20_000, id, "game over");
        await waitSt(alice, (st) => st.turnNum === "8", 20_000, id, "turn 8");
        await alice.api("POST", "/close", { channel: id });
        await waitSt(bob, (st) => st.opponentWantsToClose === true, 20_000, id, "alice's Close");
        await bob.api("POST", "/close", { channel: id });
        await waitPhase(hub, id, "Finalized", 30_000);
        await waitSt(alice, (st) => st.phase === "Finalized", 20_000, id, "Finalized");
        await waitSt(bob, (st) => st.phase === "Finalized", 20_000, id, "Finalized");
        await waitFor(async () => (await serverChannel(s, id)).phase === "Finalized", 20_000, "indexer: Finalized");
        expect((await deposits()).length).toBe(2);
        await expectBalances(s, [
          [alice, START + STAKE - FEE],
          [bob, START - STAKE - FEE],
          ["host", 2n * FEE],
        ]);
        await expectNoErrors(alice, bob);
      },
      120_000,
    );
  }

  timed(
    "server restart at the moment of a match (the match is replayed) and mid-game (play resumes), then settles",
    async () => {
      const s = await startStack();
      stack = s;
      const mitm = await startMitm(s.serverUrl);
      cleanups.push(() => mitm.stop());
      const alice = await s.player("alice", undefined, { serverUrl: mitm.url });
      const bob = await s.player("bob", undefined, { serverUrl: mitm.url });
      const { hub } = hubOf(s);

      // The match push is lost (dropped) and the server restarts right then: only the replay on re-subscribe can
      // deliver it.
      let dropMatches = true;
      const droppedOn = new Set<number>(); // proxied connections (one per daemon) whose match push was dropped
      mitm.setHooks({
        ws: (frame: { type?: string }, { dir, conn }) => {
          if (dir === "down" && frame?.type === "match" && dropMatches) {
            droppedOn.add(conn.id);
            return { send: [] };
          }
          return undefined;
        },
      });
      const offerId = await postOffer(alice);
      // Bob, the accepter, gets the match in his accept call's HTTP response; Alice, the offerer, only by push.
      await bob.api("POST", "/offers/accept", { offerId });
      await waitFor(() => droppedOn.size >= 1, 10_000, "alice's match push (dropped)");
      await sleep(1000);
      expect(await alice.api("GET", "/channels")).toEqual([]); // she has not seen the match
      const connsBefore = mitm.connections.length;
      dropMatches = false;
      await s.restartServer();
      const id = await channelOf(bob, 30_000);
      expect(await channelOf(alice, 30_000)).toBe(id);
      expect(mitm.connections.length).toBeGreaterThanOrEqual(connsBefore + 2); // both daemons reconnected
      const replayed = mitm.connections.slice(connsBefore).flatMap((c) => c.seen.down).filter((f: any) => f?.type === "match");
      expect(replayed.length).toBeGreaterThanOrEqual(1); // at least Alice's, on her re-subscribe
      await waitPhase(hub, id, "Open", 30_000);
      await waitSt(alice, (st) => st.phase === "Open", 20_000, id, "Open");
      await waitSt(bob, (st) => st.phase === "Open", 20_000, id, "Open");

      await moveOnce(alice, bob, id, "e2e4");
      await moveOnce(alice, bob, id, "e7e5");
      // Mid-game: the server restarts while Alice moves; her move reaches Bob once both are back (her daemon
      // re-sends its latest state on the re-join).
      await Promise.all([s.restartServer(), sleep(50).then(() => alice.api("POST", "/move", { move: "d1h5", channel: id }))]);
      await waitSt(bob, (st) => st.turnNum === "3" && st.myTurn, 30_000, id, "turn 3 after the restart");
      for (const m of SCHOLARS_MATE.slice(3)) await moveOnce(alice, bob, id, m);
      await waitSt(bob, (st) => st.gameStatus === "white_won" && st.turnNum === "8", 20_000, id, "game over");
      await waitSt(alice, (st) => st.turnNum === "8", 20_000, id, "turn 8");
      await alice.api("POST", "/close", { channel: id });
      await waitSt(bob, (st) => st.opponentWantsToClose === true, 20_000, id, "alice's Close");
      await bob.api("POST", "/close", { channel: id });
      await waitPhase(hub, id, "Finalized", 30_000);
      await waitSt(alice, (st) => st.phase === "Finalized", 20_000, id, "Finalized");
      await waitSt(bob, (st) => st.phase === "Finalized", 20_000, id, "Finalized");
      await waitFor(async () => (await serverChannel(s, id)).phase === "Finalized", 20_000, "indexer: Finalized");
      await expectBalances(s, [
        [alice, START + STAKE - FEE],
        [bob, START - STAKE - FEE],
        ["host", 2n * FEE],
      ]);
      await expectNoErrors(alice, bob);
    },
    120_000,
  );
});
