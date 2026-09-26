import { afterEach, describe, expect, it } from "vitest";
import { increaseTime } from "../../sdk/test/helpers/chain.js";
import { MAX_FUNDING_WINDOW, RecordStore } from "../src/index.js";
import { startPair, waitFor } from "./helpers/harness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function pair() {
  const p = await startPair();
  cleanups.push(p.cleanup);
  return p;
}

describe("I2: settled channels leave the relay", () => {
  it("a cooperatively closed channel is left on both sides", async () => {
    const { alice, bob } = await pair();
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    await waitFor(async () => (await alice.daemon.status(id)).phase === "Open", 30_000, "open");
    expect(alice.client.rooms()).toContain(id);
    expect(bob.client.rooms()).toContain(id);

    await alice.daemon.move(id, "e4", { actor: "agent", offerDraw: true });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    await bob.daemon.acceptDraw(id, "agent");
    await waitFor(async () => (await alice.daemon.status(id)).attention === "game-over", 5_000, "draw seen");
    await alice.daemon.close(id, "agent");
    await waitFor(async () => (await bob.daemon.status(id)).attention === "close-requested", 5_000, "close requested");
    await bob.daemon.close(id, "agent");

    await waitFor(() => alice.daemon.handle(id).record.finalized && bob.daemon.handle(id).record.finalized, 20_000, "finalized");
    expect(alice.client.rooms()).not.toContain(id);
    expect(bob.client.rooms()).not.toContain(id);
  });
});

describe("I3/M12: offer records do not pile up", () => {
  it("an offer record past expiresAt + the max funding window is pruned and unwatched", async () => {
    const { alice } = await pair();
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    const records = new RecordStore(alice.home);
    expect(records.offer(offerId)).not.toBe(null);
    expect(alice.client.watched()).toContain(offerId);

    // just past expiry, a match made in time could still be funded: kept
    await increaseTime(3600 + 60);
    await alice.daemon.idle();
    await alice.daemon.tick();
    expect(records.offer(offerId)).not.toBe(null);

    await increaseTime(Number(MAX_FUNDING_WINDOW));
    await alice.daemon.idle();
    await alice.daemon.tick();
    expect(records.offer(offerId)).toBe(null);
    expect(alice.client.watched()).not.toContain(offerId);
    expect(alice.client.unwatched()).toEqual([offerId]);
  });

  it("an offer the host refuses leaves no record behind", async () => {
    const { alice } = await pair();
    alice.client.lobby.postOffer = async () => {
      throw new Error("too many open offers from this IP");
    };
    await expect(
      alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n }),
    ).rejects.toThrow(/too many open offers/);
    expect(new RecordStore(alice.home).offers()).toEqual([]);
    expect(alice.client.watched()).toEqual([]);
  });
});
