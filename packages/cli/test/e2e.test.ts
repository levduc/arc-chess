import { afterEach, describe, expect, it } from "vitest";
import { ArenaDaemon, loadConfig, type ArenaDaemon as Daemon } from "../src/index.js";
import { usdcBalance } from "../../sdk/test/helpers/chain.js";
import { SCHOLARS_MATE } from "../../sdk/test/helpers/fixtures.js";
import { START, startPair, waitFor } from "./helpers/harness.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function playLine(white: Daemon, black: Daemon, id: `0x${string}`, moves: string[]) {
  for (const m of moves) {
    const [mover, other] = white.handle(id).session.isMyTurn() ? [white, black] : [black, white];
    await mover.move(id, m, { actor: "agent" });
    await waitFor(() => other.handle(id).session.latest.state.turnNum === mover.handle(id).session.latest.state.turnNum, 5_000, `relay ${m}`);
  }
}

describe("arena end-to-end (two daemons, Anvil)", () => {
  it("match → game 0 (auto-resign on mate) → game 1 → cooperative close", async () => {
    const pair = await startPair();
    cleanup = pair.cleanup;
    const { alice, bob, env } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    await waitFor(async () => (await alice.daemon.status(id)).phase === "Open", 30_000, "open");

    await playLine(alice.daemon, bob.daemon, id, SCHOLARS_MATE); // Alice (white) mates; Bob's daemon auto-resigns
    await waitFor(async () => (await alice.daemon.status(id)).gameStatus === "white_won", 10_000, "game 0 over");
    expect((await alice.daemon.status(id)).attention).toBe("game-over");

    await alice.daemon.nextGame(id, "agent");
    await waitFor(async () => (await bob.daemon.status(id)).attention === "new-game-proposed", 10_000, "proposal");
    await bob.daemon.nextGame(id, "agent");
    await waitFor(async () => (await bob.daemon.status(id)).myTurn, 10_000, "game 1 starts with Bob as white");

    await playLine(bob.daemon, alice.daemon, id, SCHOLARS_MATE); // Bob mates; Alice auto-resigns
    await waitFor(async () => (await bob.daemon.status(id)).gameStatus === "white_won", 10_000, "game 1 over");

    await alice.daemon.close(id, "agent");
    await waitFor(async () => (await bob.daemon.status(id)).attention === "close-requested", 10_000, "close requested");
    await bob.daemon.close(id, "agent");
    await waitFor(async () => (await alice.daemon.status(id)).phase === "Finalized", 20_000, "finalized");
    expect(await usdcBalance(env.usdc, alice.address)).toBe(START - 5_000n);
    expect(await usdcBalance(env.usdc, bob.address)).toBe(START - 5_000n);
    expect(await usdcBalance(env.usdc, env.host)).toBe(10_000n);
  });

  it("resumes after a daemon restart without re-signing", async () => {
    const pair = await startPair();
    cleanup = pair.cleanup;
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    await waitFor(async () => (await alice.daemon.status(id)).phase === "Open", 30_000, "open");
    await alice.daemon.move(id, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");

    await alice.daemon.stop();
    const restarted = new ArenaDaemon({
      home: alice.home,
      config: loadConfig(alice.home),
      walletKey: alice.walletKey,
      lobby: alice.client.lobby,
      relay: alice.client.relay,
    });
    await restarted.start();
    pair.alice.daemon = restarted;
    expect(restarted.handle(id).session.snapshot().lastSignedTurn).toBe(1n);
    await expect(restarted.move(id, "d4", { actor: "agent" })).rejects.toThrow(/not your turn/);
    await bob.daemon.move(id, "e5", { actor: "agent" });
    await waitFor(() => restarted.handle(id).session.isMyTurn(), 5_000, "alice turn after restart");
    await restarted.move(id, "Nf3", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "relay after restart");
    // Funding was not repeated by the restart.
    expect((await restarted.hub.channelInfo(id)).phase).toBe("Open");
  });

  it("human takes over mid-game and hands back; wait only wakes the agent when it controls", async () => {
    const pair = await startPair();
    cleanup = pair.cleanup;
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    await waitFor(async () => (await alice.daemon.status(id)).phase === "Open", 30_000, "open");

    await alice.daemon.handoff(id, "human", "let me play the opening");
    expect((await alice.daemon.wait({ timeoutMs: 300 })).reason).toBe("timeout");
    await expect(alice.daemon.move(id, "e4", { actor: "agent" })).rejects.toThrow(/human is in control/);
    await alice.daemon.move(id, "e4", { actor: "human" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    await bob.daemon.move(id, "e5", { actor: "agent" });
    await waitFor(() => alice.daemon.handle(id).session.isMyTurn(), 5_000, "alice turn");
    await alice.daemon.handoff(id, "agent", "");
    expect((await alice.daemon.wait({ timeoutMs: 5_000 })).reason).toBe("your-turn");
  });
});
