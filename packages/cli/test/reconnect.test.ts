import { afterEach, describe, expect, it } from "vitest";
import { startPair, waitFor } from "./helpers/harness.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function openChannel() {
  const pair = await startPair();
  cleanup = pair.cleanup;
  const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
  await pair.bob.daemon.acceptOffer(offerId);
  const id = await waitFor(() => pair.alice.daemon.channelIds()[0], 20_000, "match");
  await waitFor(async () => (await pair.alice.daemon.status(id)).phase === "Open", 30_000, "open");
  return { ...pair, id };
}

describe("relay reconnect", () => {
  it("a move sent while the sender was disconnected is delivered after it reconnects", async () => {
    const { alice, bob, id } = await openChannel();
    alice.client.disconnect();
    await alice.daemon.move(id, "e4", { actor: "agent" }); // relay send fails; state is persisted
    expect(bob.daemon.handle(id).session.latest.state.turnNum).toBe(0n);
    alice.client.reconnect(); // fires onJoined → daemon re-sends its latest
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob receives e4");
  });

  it("re-sent states after a reconnect never set lastError on the receiver", async () => {
    const { alice, bob, id } = await openChannel();
    await alice.daemon.move(id, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    await bob.daemon.move(id, "e5", { actor: "agent" });
    await waitFor(() => alice.daemon.handle(id).session.isMyTurn(), 5_000, "alice turn");
    alice.client.reconnect(); // Alice re-sends e4 (stale for Bob)
    bob.client.reconnect();   // Bob re-sends e5 (duplicate for Alice)
    await new Promise((r) => setTimeout(r, 300));
    expect(alice.daemon.handle(id).lastError).toBeNull();
    expect(bob.daemon.handle(id).lastError).toBeNull();
  });

  it("re-sends its Close signature on reconnect so a lost close still completes", async () => {
    const { alice, bob, id } = await openChannel();
    await alice.daemon.move(id, "e4", { actor: "agent", offerDraw: true });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    await bob.daemon.acceptDraw(id, "agent");
    await waitFor(async () => (await alice.daemon.status(id)).attention === "game-over", 5_000, "draw seen");
    bob.client.disconnect();
    await alice.daemon.close(id, "agent"); // Alice's close message is lost (Bob is disconnected)
    bob.client.reconnect();                 // Bob's re-join replays nothing from Alice…
    alice.client.reconnect();               // …but Alice's re-join re-sends her latest + Close
    await waitFor(async () => (await bob.daemon.status(id)).attention === "close-requested", 5_000, "close requested");
    await bob.daemon.close(id, "agent");
    await waitFor(async () => (await alice.daemon.status(id)).phase === "Finalized", 20_000, "finalized");
  });
});
