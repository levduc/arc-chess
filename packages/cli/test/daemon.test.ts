import { afterEach, describe, expect, it } from "vitest";
import { DaemonError } from "../src/index.js";
import { usdcBalance } from "../../sdk/test/helpers/chain.js";
import { START, startPair, waitFor } from "./helpers/harness.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function matched() {
  const pair = await startPair();
  cleanup = pair.cleanup;
  const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
  const listed = await pair.bob.daemon.listOffers();
  expect(listed.map((o) => o.offerId)).toContain(offerId);
  await pair.bob.daemon.acceptOffer(offerId);
  const id = await waitFor(async () => {
    const [a, b] = [pair.alice.daemon.channelIds(), pair.bob.daemon.channelIds()];
    return a.length === 1 && b.length === 1 && a[0] === b[0] ? a[0] : null;
  }, 20_000, "match");
  await waitFor(async () => (await pair.alice.daemon.hub.channelInfo(id)).phase === "Open", 20_000, "funding");
  return { ...pair, id };
}

describe("ArenaDaemon core", () => {
  it("matches, funds in order, and opens the channel", async () => {
    const { alice, bob, env, id } = await matched();
    expect(await usdcBalance(env.usdc, alice.address)).toBe(START - 1_000_000n - 5_000n);
    expect(await usdcBalance(env.usdc, bob.address)).toBe(START - 1_000_000n - 5_000n);
    expect(alice.daemon.handle(id).record.me).toBe(0);
    expect(bob.daemon.handle(id).record.me).toBe(1);
  });

  it("relays moves between daemons and enforces turn order", async () => {
    const { alice, bob, id } = await matched();
    await expect(bob.daemon.move(undefined, "e7e5", { actor: "agent" })).rejects.toThrow(DaemonError);
    await alice.daemon.move(undefined, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob's turn");
    await bob.daemon.move(id, "e5", { actor: "agent" });
    await waitFor(() => alice.daemon.handle(id).session.isMyTurn(), 5_000, "alice's turn");
  });

  it("rejects agent moves while a human is in control", async () => {
    const { alice } = await matched();
    await alice.daemon.handoff(undefined, "human", "checking a line");
    await expect(alice.daemon.move(undefined, "e4", { actor: "agent" })).rejects.toThrow(/human is in control/);
    await alice.daemon.move(undefined, "e4", { actor: "human" });
    await alice.daemon.handoff(undefined, "agent", "");
    await expect(alice.daemon.move(undefined, "d4", { actor: "human" })).rejects.toThrow(/agent is in control|not your turn/);
  });

  it("rejects a mismatched match without funding", async () => {
    // Bob's daemon expects a different rules contract, so the host's match must be ignored by Bob.
    const pair = await startPair({ bobConfig: { rules: "0x00000000000000000000000000000000000000e5" } });
    cleanup = pair.cleanup;
    const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await pair.bob.daemon.acceptOffer(offerId);
    await waitFor(() => pair.alice.daemon.channelIds().length === 1, 20_000, "alice match");
    await new Promise((r) => setTimeout(r, 500));
    expect(pair.bob.daemon.channelIds()).toEqual([]);
  });
});
