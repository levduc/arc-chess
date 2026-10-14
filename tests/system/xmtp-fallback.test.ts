/**
 * Plan 5.7 Task 5: the XMTP fallback end to end -- real `arena daemon` processes, the real host server, a real chain
 * (Anvil), the real `@xmtp/node-sdk` (installed once per run with `arena xmtp enable`) and XMTP's local node in Docker
 * (Task 3's pinned fixture, through harness.ts's `startXmtpLocal`).
 *
 * 1. Kill the host mid-game (success criterion 1): both daemons switch to XMTP, finish the game over it, close
 *    cooperatively (exactly one successful `closeCooperative` on chain) and settle exact USDC; after a server restart
 *    a new channel is back on the relay.
 * 2. A flapping host (down, up, down) mid-game: the game completes.
 * 3. A third party's XMTP client DMs a daemon's session key a valid-looking message: it is dropped (its status's
 *    `xmtpDropped`, read before the channel finalizes) and the game is unaffected.
 * 4. A daemon restarted while its channel is on XMTP: it exits promptly on stop, resumes over XMTP from its DB --
 *    the opponent's move made while it was down included -- and its inbox still has one installation.
 * Scenarios 1-4 also assert, on chain, that no challenge, respond or timeout was sent at all (the outage was carried
 * by XMTP alone), and scenario 1 that a finalized channel's XMTP DB is deleted (I-1, m-1). A channel's XMTP client
 * starts only once the daemon sees it Open on chain (I-1), which `waitRegistered` waits for.
 * 5. XMTP off: a pair without `xmtp` behaves as today -- `fallback: "off"`, never `transport: "xmtp"` -- and with the
 *    host down the chain path (challenge, respond) still carries the game.
 *
 * Every XMTP SDK call the test itself makes (the third party, the inbox-state reads) runs in a short-lived child
 * process (`helper.mjs`, written at run time), so no native XMTP client ever lives in the vitest worker.
 *
 * When Docker is unavailable the suite is skipped, with the reason in its title (and a tagged console line).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, decodeFunctionData, http, type Address, type Hex, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { HubClient, channelHubAbi, toWire, type SessionSnapshot } from "@arena/sdk";
import { readJson, type ChannelRecord } from "@arena/cli";
import {
  dockerUnavailableReason,
  hasLockFile,
  installXmtpSdk,
  runCli,
  startStack,
  startXmtpLocal,
  usdcBalanceOf,
  type Player,
  type Stack,
  type XmtpLocal,
  type XmtpSdkInstall,
} from "./harness.js";
import { waitStatus, type Status } from "./bot.js";

/** Spec §2 (`packages/cli/src/xmtp/fallback.ts`): a channel whose host relay has not been up this long sends via XMTP. */
const HOST_DOWN_GRACE_MS = 3000;
/** Each move over XMTP, from `/move` to the other side holding it. The local node is real; allow for its latency. */
const XMTP_MOVE_MS = 30_000;

const SCHOLARS_MATE = ["e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6", "h5f7"];
const DEPOSIT = 1_000_000n;
const STAKE = 100_000n;
const START = 10_000_000n;
const FEE = 5_000n;
/** Long enough that no dispute here can time out by itself; scenario 5's challenge is answered at once. */
const TIMEOUT = 600;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const skipReason = dockerUnavailableReason();
if (skipReason) console.log(`[xmtp-fallback] SKIPPED: ${skipReason}`);
const suite = skipReason ? describe.skip : describe;

// ------------------------------------------------------------------------------------------------- run fixtures

let xmtp: XmtpLocal | undefined;
let sdk: XmtpSdkInstall | undefined;
let helperDir: string | undefined;
let stack: Stack | undefined;

/** Measured times, printed at the end of the file (the Task 5 report quotes them). */
const measures: Array<{ scenario: string; what: string; ms: number }> = [];
function measure(scenario: string, what: string, ms: number): void {
  measures.push({ scenario, what, ms });
}

afterEach(async () => {
  await stack?.stop();
  stack = undefined;
}, 60_000);

afterAll(async () => {
  for (const m of measures) console.log(`[xmtp-fallback timing] ${m.scenario}: ${m.what} ${(m.ms / 1000).toFixed(2)}s`);
  const downErr = await xmtp?.stop();
  if (downErr) console.log(`[xmtp-fallback] ${downErr}`);
  sdk?.remove();
  if (helperDir) rmSync(helperDir, { recursive: true, force: true });
}, 180_000);

// ------------------------------------------------------------------------------------------- the XMTP helper

/** Run in its own process by `helper()`: `inbox <address>` prints the address's inbox id and its installation count
 *  (the SDK's own inbox state, read from the network with no client); `stranger <dbDir> <peer> <textFile>` creates a
 *  fresh third-party client (a random key) and DMs `peer` the file's text. */
const HELPER_SOURCE = `
import { readFileSync } from "node:fs";
import { join } from "node:path";
const [mode, ...args] = process.argv.slice(2);
const sdk = await import(process.env.XMTP_SDK_URL);
const viem = await import(process.env.VIEM_URL);
const apiUrl = process.env.XMTP_API_URL;
const identifierOf = (a) => ({ identifier: a.toLowerCase(), identifierKind: sdk.IdentifierKind.Ethereum });
const done = (o) => { process.stdout.write(JSON.stringify(o) + "\\n"); process.exit(0); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (mode === "inbox") {
  const backend = await sdk.createBackend({ env: "local", apiUrl });
  const inboxId = await sdk.getInboxIdForIdentifier(backend, identifierOf(args[0]));
  if (!inboxId) done({ inboxId: null, installations: 0 });
  const [state] = await sdk.Client.fetchInboxStates([inboxId], backend);
  done({ inboxId, installations: state?.installations?.length ?? 0 });
} else if (mode === "stranger") {
  const [dbDir, peer, textFile] = args;
  const accounts = await import(process.env.VIEM_ACCOUNTS_URL);
  const account = accounts.privateKeyToAccount(accounts.generatePrivateKey());
  const signer = {
    type: "EOA",
    getIdentifier: () => identifierOf(account.address),
    signMessage: async (m) => viem.hexToBytes(await account.signMessage({ message: m })),
  };
  const client = await sdk.Client.create(signer, {
    env: "local",
    apiUrl,
    dbPath: join(dbDir, "stranger.db3"),
    dbEncryptionKey: crypto.getRandomValues(new Uint8Array(32)),
    disableDeviceSync: true,
  });
  const deadline = Date.now() + 30000;
  let dm;
  for (;;) {
    try {
      dm = await client.conversations.createDmWithIdentifier(identifierOf(peer));
      break;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await sleep(1000);
    }
  }
  const messageId = await dm.sendText(readFileSync(textFile, "utf8"));
  done({ sent: true, address: account.address, inboxId: client.inboxId, messageId });
} else {
  throw new Error("unknown mode " + mode);
}
`;

function helperEnv(): NodeJS.ProcessEnv {
  if (!xmtp || !sdk) throw new Error("the XMTP fixtures are not up");
  const viemDir = dirname(createRequire(import.meta.url).resolve("viem/package.json"));
  return {
    ...process.env,
    XMTP_API_URL: xmtp.apiUrl,
    XMTP_SDK_URL: pathToFileURL(join(sdk.sdkDir, "node_modules/@xmtp/node-sdk/dist/index.js")).href,
    VIEM_URL: pathToFileURL(join(viemDir, "_esm/index.js")).href,
    VIEM_ACCOUNTS_URL: pathToFileURL(join(viemDir, "_esm/accounts/index.js")).href,
  };
}

/** Runs the helper once, bounded; resolves its JSON result line. */
function helper(args: string[], timeoutMs = 60_000): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", [join(helperDir!, "helper.mjs"), ...args], { env: helperEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const line = out.trim().split("\n").at(-1);
      if (code === 0 && line) {
        try {
          resolvePromise(JSON.parse(line) as Record<string, unknown>);
          return;
        } catch {
          // fall through
        }
      }
      reject(new Error(`helper ${args[0]} failed (code=${code} signal=${signal}):\n${err.slice(-2000)}\n${out.slice(-1000)}`));
    });
  });
}

async function installationsOf(address: Address): Promise<{ inboxId: string | null; installations: number }> {
  const r = await helper(["inbox", address]);
  return { inboxId: (r.inboxId as string | null) ?? null, installations: Number(r.installations) };
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

async function waitPhase(hub: HubClient, id: Hex, phase: string, ms = 30_000): Promise<void> {
  await waitFor(async () => (await hub.channelInfo(id)).phase === phase, ms, `on-chain phase ${phase}`);
}

async function status(p: Player, id: Hex): Promise<Status & { transport: string; lastError: string | null; xmtpDropped: number }> {
  return (await p.api("GET", `/status?channel=${id}`)) as Status & { transport: string; lastError: string | null; xmtpDropped: number };
}

/** A stack whose server publishes `xmtp` (env local, the fixture's apiUrl), and two players whose daemons run with
 *  the fallback on: each home's `xmtp/sdk` is a symlink to this run's one install. */
async function xmtpStack(): Promise<{ s: Stack; alice: Player; bob: Player }> {
  if (!xmtp || !sdk) throw new Error("the XMTP fixtures are not up");
  const s = await startStack({ serverOverrides: { xmtp: { env: "local", apiUrl: xmtp.apiUrl } } });
  stack = s;
  const alice = await s.player("alice", undefined, { xmtpSdkDir: sdk.sdkDir });
  const bob = await s.player("bob", undefined, { xmtpSdkDir: sdk.sdkDir });
  for (const p of [alice, bob]) await expectFallback(p, "xmtp");
  return { s, alice, bob };
}

/** The daemon's start line (stdout, captured by the harness) says `fallback: <want>`. Checked first, so a broken SDK
 *  install fails here, plainly, rather than as a transport timeout later. */
async function expectFallback(p: Player, want: "xmtp" | "off"): Promise<void> {
  const line = await waitFor(
    () => p.logs().split("\n").find((l) => l.startsWith("{") && l.includes('"fallback"')),
    10_000,
    `${p.name}'s start line`,
  );
  expect(JSON.parse(line).fallback, `${p.name}'s start line: ${line}\n${p.logs().slice(-3000)}`).toBe(want);
}

/** Alice offers, Bob accepts, both daemons see the channel Open, on the relay. */
async function matchAndOpen(alice: Player, bob: Player): Promise<Hex> {
  const { offerId } = await alice.api("POST", "/offers", {
    deposit: DEPOSIT.toString(),
    stakePerGame: STAKE.toString(),
    challengeTimeout: String(TIMEOUT),
  });
  await bob.api("POST", "/offers/accept", { offerId });
  const before = new Set<Hex>();
  const id = await waitFor(async () => {
    const chs = (await bob.api("GET", "/channels")) as Array<{ channelId: Hex; phase: string }>;
    return chs.find((c) => !before.has(c.channelId) && c.phase !== "Finalized")?.channelId;
  }, 30_000, "bob's channel");
  await waitStatus(alice, (st) => st.phase === "Open", 30_000, id);
  await waitStatus(bob, (st) => st.phase === "Open", 30_000, id);
  await waitTransport([alice, bob], id, "relay", 20_000);
  return id;
}

/** Waits until every player's status for `id` shows `transport === want`; returns how long that took. */
async function waitTransport(players: Player[], id: Hex, want: string, ms: number): Promise<number> {
  const t0 = Date.now();
  for (const p of players) {
    let last: string | undefined;
    await waitFor(async () => {
      last = (await status(p, id)).transport;
      return last === want;
    }, Math.max(1, ms - (Date.now() - t0)), `${p.name}: transport ${want} (last: ${last})`);
  }
  return Date.now() - t0;
}

/** Waits until both players' session keys have registered with XMTP (their channel clients started), so a host
 *  outage from here on has an XMTP side to fall back to. Returns the installation counts. */
async function waitRegistered(signers: readonly Address[], ms = 90_000): Promise<number[]> {
  const counts: number[] = [];
  for (const a of signers) {
    const r = await waitFor(async () => {
      const st = await installationsOf(a);
      return st.inboxId ? st : undefined;
    }, ms, `${a}'s XMTP inbox`);
    counts.push(r.installations);
  }
  return counts;
}

/** The channel's session signers, from a daemon's own record. */
async function signersOf(p: Player, id: Hex): Promise<readonly [Address, Address]> {
  const record = await waitFor(() => readJson<ChannelRecord>(join(p.home, "channels", id, "record.json")), 20_000, `${p.name}'s record`);
  return [record.params.signers[0], record.params.signers[1]];
}

/** K5: a player's own session signer for the channel, by its own seat in its own record (never by position). */
async function ownSignerOf(p: Player, id: Hex): Promise<Address> {
  const record = await waitFor(() => readJson<ChannelRecord>(join(p.home, "channels", id, "record.json")), 20_000, `${p.name}'s record`);
  return record.params.signers[record.me];
}

/** I-1, m-1: once finalized, a channel's XMTP DB files are deleted from the player's home. */
async function expectXmtpDbPurged(p: Player, id: Hex): Promise<void> {
  const dbDir = join(p.home, "xmtp", "db");
  const left = () => (existsSync(dbDir) ? readdirSync(dbDir).filter((n) => n.startsWith(`${id.toLowerCase()}.db3`)) : []);
  await waitFor(() => left().length === 0, 20_000, `${p.name}'s XMTP DB for ${id} deleted (left: ${left().join(", ")})`);
}

/** One move by whoever is on move (white's view), then waits until the other side holds it. Returns the latency. */
async function move(white: Player, black: Player, id: Hex, m: string, ms = XMTP_MOVE_MS): Promise<number> {
  const w = await status(white, id);
  const [mover, other] = w.myTurn ? [white, black] : [black, white];
  const t0 = Date.now();
  const st = (await mover.api("POST", "/move", { move: m, channel: id })) as Status;
  await waitStatus(other, (s) => s.turnNum === st.turnNum || s.gameStatus !== "playing", ms, id);
  return Date.now() - t0;
}

async function playMoves(scenario: string, via: string, white: Player, black: Player, id: Hex, moves: string[]): Promise<void> {
  for (const m of moves) measure(scenario, `move ${m} over ${via}`, await move(white, black, id, m));
}

/** Scholar's mate is on the board: both sides agree white won (Bob's daemon auto-resigns the mated position). */
async function expectWhiteWon(alice: Player, bob: Player, id: Hex, ms = XMTP_MOVE_MS): Promise<void> {
  await waitStatus(bob, (st) => st.gameStatus === "white_won" && st.turnNum === "8", ms, id);
  await waitStatus(alice, (st) => st.gameStatus === "white_won" && st.turnNum === "8", ms, id);
}

/** Cooperative close from both sides (over whatever transport is up), then Finalized on chain and in both daemons. */
async function closeBoth(alice: Player, bob: Player, id: Hex, hub: HubClient, ms = XMTP_MOVE_MS): Promise<number> {
  const t0 = Date.now();
  await alice.api("POST", "/close", { channel: id });
  await waitStatus(bob, (st) => st.opponentWantsToClose === true, ms, id);
  await bob.api("POST", "/close", { channel: id });
  await waitPhase(hub, id, "Finalized", ms);
  await waitStatus(alice, (st) => st.phase === "Finalized", 20_000, id);
  await waitStatus(bob, (st) => st.phase === "Finalized", 20_000, id);
  return Date.now() - t0;
}

/** Ruling 3: exactly one successful `closeCooperative` -- one `Finalized` event for the channel, emitted by a
 *  successful `closeCooperative` transaction, and no other successful `closeCooperative` on the hub in this stack.
 *  K2: and not one `challenge`, `respond` or `timeout` transaction on the hub in this stack, successful or not: the
 *  outage was carried off-chain, over XMTP, never by the chain path. */
async function expectOneCloseCooperative(s: Stack, id: Hex): Promise<void> {
  const { pub } = hubOf(s);
  const logs = await pub.getContractEvents({ address: s.hub, abi: channelHubAbi, eventName: "Finalized", args: { channelId: id }, fromBlock: 0n });
  expect(logs).toHaveLength(1);
  const finalTx = await pub.getTransaction({ hash: logs[0].transactionHash });
  expect(decodeFunctionData({ abi: channelHubAbi, data: finalTx.input }).functionName).toBe("closeCooperative");
  let ok = 0;
  const disputes: string[] = [];
  const latest = await pub.getBlockNumber();
  for (let n = 0n; n <= latest; n++) {
    const block = await pub.getBlock({ blockNumber: n, includeTransactions: true });
    for (const tx of block.transactions) {
      if (tx.to?.toLowerCase() !== s.hub.toLowerCase()) continue;
      let fn: string;
      try {
        fn = decodeFunctionData({ abi: channelHubAbi, data: tx.input }).functionName;
      } catch {
        continue;
      }
      if (fn === "challenge" || fn === "respond" || fn === "timeout") disputes.push(`${fn} ${tx.hash}`);
      if (fn !== "closeCooperative") continue;
      if ((await pub.getTransactionReceipt({ hash: tx.hash })).status === "success") ok++;
    }
  }
  expect(ok, "successful closeCooperative transactions").toBe(1);
  expect(disputes, "challenge/respond/timeout transactions on the hub (the outage must not reach the chain)").toEqual([]);
}

async function expectSettled(s: Stack, alice: Player, bob: Player): Promise<void> {
  expect(await usdcBalanceOf(s, alice.address), "alice's USDC").toBe(START + STAKE - FEE);
  expect(await usdcBalanceOf(s, bob.address), "bob's USDC").toBe(START - STAKE - FEE);
  expect(await usdcBalanceOf(s, s.host), "host's USDC").toBe(2n * FEE);
}

async function expectNoErrors(...players: Player[]): Promise<void> {
  for (const p of players) {
    const chs = (await p.api("GET", "/channels")) as Array<{ channelId: Hex; lastError: string | null }>;
    for (const c of chs) expect(c.lastError, `${p.name}'s lastError on ${c.channelId}`).toBeNull();
  }
}

/** Stops the host server (SIGTERM by default; SIGKILL for a crash) and waits until both daemons send this channel
 *  via XMTP. Returns the switch time, measured from the server's exit. */
async function hostDown(s: Stack, players: Player[], id: Hex, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<number> {
  await s.stopServer(signal);
  const ms = await waitTransport(players, id, "xmtp", HOST_DOWN_GRACE_MS + 10_000);
  expect(ms).toBeLessThanOrEqual(HOST_DOWN_GRACE_MS + 10_000);
  return ms;
}

/** Restarts the host server and waits until both daemons send this channel via the relay again. */
async function hostUp(s: Stack, players: Player[], id: Hex): Promise<number> {
  await s.restartServer();
  return waitTransport(players, id, "relay", 30_000);
}

// ---------------------------------------------------------------------------------------------------- scenarios

suite(skipReason ? `XMTP fallback (SKIPPED: ${skipReason})` : "XMTP fallback over XMTP's local node", () => {
  beforeAll(async () => {
    helperDir = mkdtempSync(join(tmpdir(), "arena-xmtp-helper-"));
    writeFileSync(join(helperDir, "helper.mjs"), HELPER_SOURCE);
    // The fixture and the one real SDK install of this run, side by side (both are minutes on a cold machine).
    const [x, i] = await Promise.allSettled([startXmtpLocal(), installXmtpSdk()]);
    if (x.status === "fulfilled") xmtp = x.value;
    if (i.status === "fulfilled") sdk = i.value;
    if (x.status === "rejected") throw x.reason;
    if (i.status === "rejected") throw i.reason;
    measure("setup", "XMTP local node up -d", xmtp!.timings.upMs);
    measure("setup", "XMTP local node ready after up", xmtp!.timings.readyMs);
    measure("setup", "arena xmtp enable (one real install)", sdk!.ms);
  }, 900_000);

  it(
    "1. kill the host mid-game: both switch to XMTP, finish, close cooperatively and settle; a new channel is back on the relay",
    async () => {
      const name = "1 kill the host";
      const { s, alice, bob } = await xmtpStack();
      const { hub } = hubOf(s);
      // I-2: `arena xmtp status` reports what the RUNNING daemon loaded.
      const st = await runCli(["xmtp", "status"], alice.home, { timeoutMs: 60_000 });
      expect(st.status, st.stderr).toBe(0);
      expect(JSON.parse(st.stdout.trim().split("\n").at(-1) as string)).toMatchObject({ enabled: true, env: "local", daemon: "xmtp" });
      const id = await matchAndOpen(alice, bob);
      expect(await waitRegistered(await signersOf(bob, id))).toEqual([1, 1]);

      await playMoves(name, "the relay", alice, bob, id, SCHOLARS_MATE.slice(0, 4));
      // Killed outright (a crash, no graceful close): the daemons see the sockets drop and nothing else.
      measure(name, "switch to XMTP after the server was SIGKILLed", await hostDown(s, [alice, bob], id, "SIGKILL"));
      await playMoves(name, "XMTP", alice, bob, id, SCHOLARS_MATE.slice(4));
      await expectWhiteWon(alice, bob, id);
      measure(name, "cooperative close over XMTP (to Finalized)", await closeBoth(alice, bob, id, hub));
      await expectOneCloseCooperative(s, id);
      await expectSettled(s, alice, bob);
      await expectNoErrors(alice, bob);
      // I-1, m-1: the finalized channel's XMTP client is closed and its DB deleted, on both sides.
      for (const p of [alice, bob]) await expectXmtpDbPurged(p, id);

      // The site is back: a new match is made through it, and its channel sends via the relay.
      await s.restartServer();
      const id2 = await waitFor(() => matchAndOpen(alice, bob), 90_000, "a new channel after the restart");
      expect(id2).not.toBe(id);
      expect((await status(alice, id2)).transport).toBe("relay");
      expect((await status(bob, id2)).transport).toBe("relay");
    },
    300_000,
  );

  it(
    "2. a flapping host (down, up, down) mid-game: the game completes and settles",
    async () => {
      const name = "2 flapping host";
      const { s, alice, bob } = await xmtpStack();
      const { hub } = hubOf(s);
      const id = await matchAndOpen(alice, bob);
      await waitRegistered(await signersOf(bob, id));

      await playMoves(name, "the relay", alice, bob, id, SCHOLARS_MATE.slice(0, 2));
      measure(name, "switch to XMTP (first outage)", await hostDown(s, [alice, bob], id));
      await playMoves(name, "XMTP", alice, bob, id, SCHOLARS_MATE.slice(2, 3));
      measure(name, "back on the relay after the restart", await hostUp(s, [alice, bob], id));
      await playMoves(name, "the relay", alice, bob, id, SCHOLARS_MATE.slice(3, 4));
      measure(name, "switch to XMTP (second outage)", await hostDown(s, [alice, bob], id));
      await playMoves(name, "XMTP", alice, bob, id, SCHOLARS_MATE.slice(4));
      await expectWhiteWon(alice, bob, id);
      measure(name, "cooperative close over XMTP (to Finalized)", await closeBoth(alice, bob, id, hub));
      await expectOneCloseCooperative(s, id);
      await expectSettled(s, alice, bob);
      await expectNoErrors(alice, bob);
    },
    300_000,
  );

  it(
    "3. a third party DMs a daemon's session key a valid-looking message: dropped, and the game is unaffected",
    async () => {
      const name = "3 third-party sender";
      const { s, alice, bob } = await xmtpStack();
      const { hub } = hubOf(s);
      const id = await matchAndOpen(alice, bob);
      const signers = await signersOf(bob, id);
      await waitRegistered(signers);
      const bobSigner = await ownSignerOf(bob, id); // K5: Bob's own seat, from his record

      await playMoves(name, "the relay", alice, bob, id, SCHOLARS_MATE.slice(0, 2));
      await hostDown(s, [alice, bob], id);
      // One move each way over XMTP first: Bob's client has then found Alice's inbox, so the stranger is *known*.
      await playMoves(name, "XMTP", alice, bob, id, SCHOLARS_MATE.slice(2, 4));

      // The most valid-looking message there is: the channel's real latest state, validly signed by Bob's opponent,
      // re-sent in the arena's own XMTP framing from a third party's inbox.
      const snapshot = readJson<SessionSnapshot>(join(bob.home, "channels", id, "session.json"));
      expect(snapshot?.latest).toBeTruthy();
      const text = toWire({ arena: 1, msg: { type: "state", channelId: id, signed: snapshot!.latest } });
      const textFile = join(helperDir!, `stranger-${id}.txt`);
      writeFileSync(textFile, text);
      const strangerDb = mkdtempSync(join(helperDir!, "stranger-db-"));
      expect((await status(bob, id)).xmtpDropped).toBe(0);
      const t0 = Date.now();
      const sent = await helper(["stranger", strangerDb, bobSigner, textFile], 90_000);
      expect(sent.sent).toBe(true);
      // K3: the drop, from Bob's status (read before the channel finalizes).
      const dropped = await waitFor(async () => (await status(bob, id)).xmtpDropped, 30_000, "bob's xmtpDropped");
      measure(name, "stranger's message sent to its drop counted", Date.now() - t0);
      expect(dropped).toBeGreaterThan(0);
      expect((await status(bob, id)).lastError).toBeNull();

      await playMoves(name, "XMTP", alice, bob, id, SCHOLARS_MATE.slice(4));
      await expectWhiteWon(alice, bob, id);
      await closeBoth(alice, bob, id, hub);
      await expectOneCloseCooperative(s, id);
      await expectSettled(s, alice, bob);
      await expectNoErrors(alice, bob);
    },
    300_000,
  );

  it(
    "4. a daemon restarted while its channel is on XMTP: prompt exit, resumes over XMTP, still one installation",
    async () => {
      const name = "4 restart mid-fallback";
      const { s, alice, bob } = await xmtpStack();
      const { hub } = hubOf(s);
      const id = await matchAndOpen(alice, bob);
      const signers = await signersOf(bob, id);
      expect(await waitRegistered(signers)).toEqual([1, 1]);

      await playMoves(name, "the relay", alice, bob, id, SCHOLARS_MATE.slice(0, 2));
      await hostDown(s, [alice, bob], id);
      await playMoves(name, "XMTP", alice, bob, id, SCHOLARS_MATE.slice(2, 4));

      // Bob stops mid-fallback: node-sdk 6.1.0's Client.close() runs on stop (bounded), and the exit is the check.
      const t0 = Date.now();
      await bob.kill("SIGTERM");
      const exitMs = Date.now() - t0;
      measure(name, "bob's daemon exit after SIGTERM", exitMs);
      expect(exitMs).toBeLessThan(10_000);
      // A clean shutdown, not a signal death: exit code 0, and the home lock released (its last step).
      expect(bob.exitStatus?.()).toEqual({ code: 0, signal: null });
      expect(hasLockFile(bob.home)).toBe(false);

      // Alice moves while Bob is down: it can only reach him over XMTP, from his DM's history, once he is back.
      const moverStatus = (await alice.api("POST", "/move", { move: SCHOLARS_MATE[4], channel: id })) as Status;
      await sleep(2_000);
      const t1 = Date.now();
      await bob.start();
      await expectFallback(bob, "xmtp");
      await waitStatus(bob, (st) => st.turnNum === moverStatus.turnNum, 60_000, id);
      measure(name, "bob restarted to holding alice's move made while he was down", Date.now() - t1);
      await waitTransport([bob], id, "xmtp", HOST_DOWN_GRACE_MS + 10_000);

      await playMoves(name, "XMTP", alice, bob, id, SCHOLARS_MATE.slice(5));
      await expectWhiteWon(alice, bob, id);
      await closeBoth(alice, bob, id, hub);
      await expectOneCloseCooperative(s, id);
      await expectSettled(s, alice, bob);
      await expectNoErrors(alice, bob);
      // Review Focus 5: the restarted client resumed from its DB -- no new installation on either inbox.
      expect(await waitRegistered(signers)).toEqual([1, 1]);
    },
    300_000,
  );

  it(
    "5. XMTP off: fallback off, never transport xmtp; with the host down the chain path carries the game",
    async () => {
      const name = "5 XMTP off";
      const s = await startStack();
      stack = s;
      const { hub } = hubOf(s);
      const alice = await s.player("alice");
      const bob = await s.player("bob");
      for (const p of [alice, bob]) await expectFallback(p, "off");
      const id = await matchAndOpen(alice, bob);
      await playMoves(name, "the relay", alice, bob, id, SCHOLARS_MATE.slice(0, 1));

      await s.stopServer();
      const seen = new Set<string>();
      await waitFor(async () => {
        const [a, b] = [await status(alice, id), await status(bob, id)];
        seen.add(a.transport).add(b.transport);
        return a.transport === "none" && b.transport === "none";
      }, HOST_DOWN_GRACE_MS + 10_000, "transport none on both");
      // Bob's move has no transport to go by: Alice never sees it off-chain.
      const bobMove = (await bob.api("POST", "/move", { move: SCHOLARS_MATE[1], channel: id })) as Status;
      for (let i = 0; i < 20; i++) {
        const a = await status(alice, id);
        seen.add(a.transport);
        expect(a.turnNum).toBe("1");
        await sleep(250);
      }
      // The chain path: Bob challenges with his move; Alice's watchtower sees it, she answers, her daemon responds.
      const t0 = Date.now();
      await bob.api("POST", "/challenge", { channel: id });
      await waitStatus(alice, (st) => st.phase === "Challenged" && (st.challenge as any)?.mustMove === true, 30_000, id);
      expect((await status(alice, id)).turnNum).toBe(bobMove.turnNum);
      await alice.api("POST", "/move", { move: SCHOLARS_MATE[2], channel: id });
      await waitPhase(hub, id, "Open");
      await waitStatus(bob, (st) => st.phase === "Open" && st.turnNum === "3" && st.myTurn, 30_000, id);
      measure(name, "challenge to the answered move held by both (chain only)", Date.now() - t0);
      for (const p of [alice, bob]) seen.add((await status(p, id)).transport);
      expect([...seen]).not.toContain("xmtp");
      expect(alice.logs()).not.toMatch(/xmtp:/);
      expect(bob.logs()).not.toMatch(/xmtp:/);

      await hostUp(s, [alice, bob], id);
      await playMoves(name, "the relay", alice, bob, id, SCHOLARS_MATE.slice(3));
      await expectWhiteWon(alice, bob, id);
      await closeBoth(alice, bob, id, hub);
      await expectSettled(s, alice, bob);
      await expectNoErrors(alice, bob);
    },
    240_000,
  );
});
