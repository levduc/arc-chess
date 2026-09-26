import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { initHome, startDaemonProcess, type ArenaConfig, type ArenaDaemon, type DaemonProcess } from "@arena/cli";
import { startServer, type ArenaServer } from "../src/server.js";
import { testConfig } from "./helpers/fakeChain.js";
import { ANVIL_KEYS, CHAIN, RPC, deployArena, mintUsdc, usdcBalance } from "../../../packages/sdk/test/helpers/chain.js";
import { SCHOLARS_MATE } from "../../../packages/sdk/test/helpers/fixtures.js";

const START = 10_000_000n;

/** Copied from packages/cli/test/e2e.test.ts (import paths differ; this is intentionally not shared code). */
async function playLine(white: ArenaDaemon, black: ArenaDaemon, id: Hex, moves: string[]): Promise<void> {
  for (const m of moves) {
    const [mover, other] = white.handle(id).session.isMyTurn() ? [white, black] : [black, white];
    await mover.move(id, m, { actor: "agent" });
    await waitFor(
      () => other.handle(id).session.latest.state.turnNum === mover.handle(id).session.latest.state.turnNum,
      5_000,
      `relay ${m}`,
    );
  }
}

async function getJson<T>(url: string): Promise<T> {
  return (await fetch(url)).json() as Promise<T>;
}

/** Polls `fn` until it returns a truthy value (or throws after `ms`). */
async function waitFor<T>(fn: () => Promise<T> | T, ms = 20_000, label = "condition"): Promise<Exclude<T, false | null | undefined>> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as Exclude<T, false | null | undefined>;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${String(last)}` : ""}`);
}

let server: ArenaServer | undefined;
let procs: DaemonProcess[] = [];

afterEach(async () => {
  for (const p of procs) {
    try {
      await p.stop();
    } catch {
      // one failed stop must not leave the other daemons or the server running
    }
  }
  procs = [];
  await server?.close();
  server = undefined;
});

/** Whether the server's relay cache holds `sender`'s state at `turnNum` for channel `id`. */
function cachedTurn(id: Hex, sender: 0 | 1, turnNum: bigint): boolean {
  return server!.repo
    .cachedRelay(id)
    .some((e) => e.sender === sender && e.message.type === "state" && e.message.signed.state.turnNum === turnNum);
}

type Env = Awaited<ReturnType<typeof deployArena>>;

/** Deploys fresh contracts on the shared Anvil (port 8546) and starts a real server against them, with a real
 *  `RpcChainReader` (no `chain` dep — this is the point of this suite). */
async function setupServer(): Promise<Env> {
  const env = await deployArena();
  server = await startServer(
    testConfig({
      rpcUrl: RPC,
      chainId: CHAIN.id,
      hub: env.hub,
      usdc: env.usdc,
      rules: env.rules,
      indexer: { pollMs: 200, chunkBlocks: 50, startBlock: 0n },
    }),
  );
  return env;
}

/** Provisions one ARENA_HOME, mints it starting USDC, and starts a real daemon process talking to `server`. */
async function makePlayer(env: Env, key: Hex): Promise<{ proc: DaemonProcess; home: string; address: Hex }> {
  const home = mkdtempSync(join(tmpdir(), "arena-e2e-"));
  const address = privateKeyToAccount(key).address;
  await mintUsdc(env.usdc, address, START);
  const config: ArenaConfig = {
    rpcUrl: RPC,
    chainId: CHAIN.id,
    hub: env.hub,
    usdc: env.usdc,
    rules: env.rules,
    serverUrl: server!.url,
    port: 0,
    maxFeePerPlayer: 10_000n,
    sessionGasWei: 10n ** 16n,
    pollMs: 200,
    logChunkBlocks: 50,
  };
  initHome(home, config, key);
  const proc = await startDaemonProcess(home, { host: { minBackoffMs: 50, maxBackoffMs: 500 } });
  procs.push(proc);
  return { proc, home, address };
}

describe("arena end-to-end (two real daemon processes, real host server, Anvil)", () => {
  it(
    "two daemons over the real server: match → 3 games → cooperative close → balances, fee and reputation",
    async () => {
      const env = await setupServer();
      const alice = await makePlayer(env, ANVIL_KEYS[1]);
      const bob = await makePlayer(env, ANVIL_KEYS[2]);

      const { offerId } = await alice.proc.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
      await bob.proc.daemon.acceptOffer(offerId);
      const id = await waitFor(() => alice.proc.daemon.channelIds()[0], 20_000, "match");
      await waitFor(async () => (await alice.proc.daemon.status(id)).phase === "Open", 30_000, "open");

      // Game 0: Alice (the offerer) is white and mates; Bob's daemon auto-resigns.
      await playLine(alice.proc.daemon, bob.proc.daemon, id, SCHOLARS_MATE);
      await waitFor(async () => (await alice.proc.daemon.status(id)).gameStatus === "white_won", 10_000, "game 0 over");

      await alice.proc.daemon.nextGame(id, "agent");
      await waitFor(async () => (await bob.proc.daemon.status(id)).attention === "new-game-proposed", 10_000, "proposal 1");
      await bob.proc.daemon.nextGame(id, "agent");
      await waitFor(async () => (await bob.proc.daemon.status(id)).myTurn, 10_000, "game 1 starts with Bob as white");

      // Game 1: Bob (the accepter) is white and mates; Alice's daemon auto-resigns.
      await playLine(bob.proc.daemon, alice.proc.daemon, id, SCHOLARS_MATE);
      await waitFor(async () => (await bob.proc.daemon.status(id)).gameStatus === "white_won", 10_000, "game 1 over");

      await bob.proc.daemon.nextGame(id, "agent");
      await waitFor(async () => (await alice.proc.daemon.status(id)).attention === "new-game-proposed", 10_000, "proposal 2");
      await alice.proc.daemon.nextGame(id, "agent");
      await waitFor(async () => (await alice.proc.daemon.status(id)).myTurn, 10_000, "game 2 starts with Alice as white");

      // Game 2: Alice is white and mates again.
      await playLine(alice.proc.daemon, bob.proc.daemon, id, SCHOLARS_MATE);
      await waitFor(async () => (await alice.proc.daemon.status(id)).gameStatus === "white_won", 10_000, "game 2 over");

      await alice.proc.daemon.close(id, "agent");
      await waitFor(async () => (await bob.proc.daemon.status(id)).attention === "close-requested", 10_000, "close requested");
      await bob.proc.daemon.close(id, "agent");
      await waitFor(async () => (await alice.proc.daemon.status(id)).phase === "Finalized", 20_000, "finalized");

      // Alice won games 0 and 2 (+100_000 net), Bob won game 1 (-100_000 net); each pays a 5_000 fee.
      expect(await usdcBalance(env.usdc, alice.address)).toBe(START + 100_000n - 5_000n);
      expect(await usdcBalance(env.usdc, bob.address)).toBe(START - 100_000n - 5_000n);
      expect(await usdcBalance(env.usdc, env.host)).toBe(10_000n);

      type PlayerStats = { finalized: number; games: number; channels: number };
      await waitFor(
        async () => (await getJson<PlayerStats>(`${server!.url}/players/${alice.address}`)).finalized === 1,
        20_000,
        "reputation finalized",
      );
      const aliceStats = await getJson<PlayerStats>(`${server!.url}/players/${alice.address}`);
      expect(aliceStats.games).toBe(3);
      expect(aliceStats.channels).toBe(1);

      const channelInfo = await getJson<{ phase: string }>(`${server!.url}/api/channels/${id}`);
      expect(channelInfo.phase).toBe("Finalized");
    },
    120_000,
  );

  it(
    "relay drop mid-game: moves made during the outage are delivered after reconnect",
    async () => {
      const env = await setupServer();
      const alice = await makePlayer(env, ANVIL_KEYS[1]);
      const bob = await makePlayer(env, ANVIL_KEYS[2]);

      const { offerId } = await alice.proc.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
      await bob.proc.daemon.acceptOffer(offerId);
      const id = await waitFor(() => alice.proc.daemon.channelIds()[0], 20_000, "match");
      await waitFor(async () => (await alice.proc.daemon.status(id)).phase === "Open", 30_000, "open");

      await alice.proc.daemon.move(id, "e4", { actor: "agent" });
      await waitFor(() => bob.proc.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");

      server!.dropConnections();
      // Wait for Bob's own client to observe the drop (its "close" handler clears the host connection's nonce)
      // before moving, so `relay.send` deterministically fails ("relay not connected") instead of racing the
      // socket teardown and sometimes going out over the still-open connection.
      await waitFor(() => !bob.proc.host.connected(), 5_000, "bob sees the drop");
      // `move()` still records the move locally even though the relay send fails: it is delivered later via
      // reconnect + replay (onJoined's resend), not by any manual retry here.
      await bob.proc.daemon.move(id, "e5", { actor: "agent" });

      await waitFor(() => alice.proc.daemon.handle(id).session.isMyTurn(), 20_000, "alice turn after reconnect");
      await alice.proc.daemon.move(id, "Nf3", { actor: "agent" });
      await waitFor(() => bob.proc.daemon.handle(id).session.isMyTurn(), 10_000, "bob turn after Nf3");

      await waitFor(
        () => alice.proc.daemon.handle(id).lastError === null && bob.proc.daemon.handle(id).lastError === null,
        10_000,
        "lastError clears on both sides",
      );
    },
    60_000,
  );

  it(
    "receiver offline while the sender auto-resigns and proposes the next game: it catches up with no chain step",
    async () => {
      const env = await setupServer();
      const alice = await makePlayer(env, ANVIL_KEYS[1]);
      const bob = await makePlayer(env, ANVIL_KEYS[2]);
      const host = { host: { minBackoffMs: 50, maxBackoffMs: 500 } };

      const { offerId } = await alice.proc.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
      await bob.proc.daemon.acceptOffer(offerId);
      const id = await waitFor(() => alice.proc.daemon.channelIds()[0], 20_000, "match");
      await waitFor(async () => (await alice.proc.daemon.status(id)).phase === "Open", 30_000, "open");

      // Everything up to the mating move is played live.
      await playLine(alice.proc.daemon, bob.proc.daemon, id, SCHOLARS_MATE.slice(0, -1));
      // Bob goes offline, so the mate reaches him only through the relay cache once he is back; Alice mates and
      // then goes offline herself before Bob can answer it.
      await bob.proc.stop();
      await alice.proc.daemon.move(id, SCHOLARS_MATE[SCHOLARS_MATE.length - 1], { actor: "agent" });
      const mate = alice.proc.daemon.handle(id).session.latest.state.turnNum;
      await waitFor(() => cachedTurn(id, 0, mate), 5_000, "mate cached");
      await alice.proc.stop();

      // Bob (the sender) comes back and stays connected: his daemon auto-resigns at mate+1 and he immediately
      // proposes the next game at mate+2, while Alice (the receiver) is offline for both.
      const bob2 = await startDaemonProcess(bob.home, host);
      procs.push(bob2);
      await waitFor(async () => (await bob2.daemon.status(id)).gameStatus === "white_won", 20_000, "bob auto-resigns");
      await waitFor(() => cachedTurn(id, 1, mate + 1n), 5_000, "resignation cached");
      await bob2.daemon.nextGame(id, "agent");
      await waitFor(() => cachedTurn(id, 1, mate + 2n), 5_000, "checkpoint cached");

      // Alice reconnects: the relay replays the resignation, then the checkpoint, so she sees the proposal.
      const alice2 = await startDaemonProcess(alice.home, host);
      procs.push(alice2);
      await waitFor(
        async () => (await alice2.daemon.status(id)).attention === "new-game-proposed",
        20_000,
        "alice sees the proposal",
      );
      expect(alice2.daemon.handle(id).lastError).toBeNull();
      const info = await alice2.daemon.hub.channelInfo(id);
      expect(info.phase).toBe("Open");
      expect(info.hasRegistered).toBe(false); // nobody had to challenge

      await alice2.daemon.nextGame(id, "agent");
      await waitFor(() => bob2.daemon.handle(id).session.isMyTurn(), 10_000, "game 1 starts with Bob as white");
    },
    120_000,
  );

  it(
    "offline offerer: a match made while the offerer's daemon is down is replayed when it restarts",
    async () => {
      const env = await setupServer();
      const alice = await makePlayer(env, ANVIL_KEYS[1]);
      const bob = await makePlayer(env, ANVIL_KEYS[2]);

      const { offerId } = await alice.proc.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
      await alice.proc.stop();

      await bob.proc.daemon.acceptOffer(offerId); // the server matches even though the offerer is offline

      const restartedAlice = await startDaemonProcess(alice.home, { host: { minBackoffMs: 50, maxBackoffMs: 500 } });
      procs.push(restartedAlice);

      const id = await waitFor(() => restartedAlice.daemon.channelIds()[0], 60_000, "match replayed on restart");
      await waitFor(async () => (await restartedAlice.daemon.status(id)).phase === "Open", 60_000, "alice open");
      await waitFor(async () => (await bob.proc.daemon.status(id)).phase === "Open", 60_000, "bob open");
    },
    90_000,
  );

  it("refuses a second daemon on the same ARENA_HOME", async () => {
    const env = await setupServer();
    const alice = await makePlayer(env, ANVIL_KEYS[1]);

    await expect(startDaemonProcess(alice.home, { host: { minBackoffMs: 50, maxBackoffMs: 500 } })).rejects.toThrow(
      /another arena daemon/,
    );

    // The first process is still healthy: a real API call succeeds, and its host connection is up.
    await expect(alice.proc.daemon.listOffers()).resolves.toBeInstanceOf(Array);
    await waitFor(() => alice.proc.host.connected(), 5_000, "alice host still connected");
  });
});
