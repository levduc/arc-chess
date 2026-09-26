import { randomBytes } from "node:crypto";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { buildParams, offerId as computeOfferId, type MatchEvent } from "@arena/sdk";
import { DaemonError, type ArenaDaemon } from "../src/index.js";
import { now, usdcBalance } from "../../sdk/test/helpers/chain.js";
import { START, startPair, waitFor } from "./helpers/harness.js";

/** Test-only escape hatch: onMatch/records are private/protected, but fix-round tests need to craft events. */
type Internals = { onMatch(m: MatchEvent): Promise<void>; records: { saveOffer(r: unknown): void } };
const internals = (d: ArenaDaemon): Internals => d as unknown as Internals;

const randomNonce = (): Hex => `0x${randomBytes(32).toString("hex")}`;

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

  it("I1: a persistently failing deposit tops up the session key's gas at most once", async () => {
    const pair = await startPair({ pollMs: 50 });
    cleanup = pair.cleanup;
    // A deposit far beyond alice's minted balance: hub.deposit() will keep reverting on every tick.
    const { offerId } = await pair.alice.daemon.createOffer({ deposit: 50_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await pair.bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => pair.alice.daemon.channelIds()[0], 20_000, "match");
    const sessionAddr = pair.alice.daemon.handle(id).sessionSender.address;
    // Wait for the first (and, if the fix holds, only) top-up.
    await waitFor(async () => (await pair.alice.daemon.client.getBalance({ address: sessionAddr })) > 0n, 10_000, "first top-up");
    const first = await pair.alice.daemon.client.getBalance({ address: sessionAddr });
    // Several more ticks at pollMs=50: an unconditional top-up would add sessionGasWei on every one of them.
    await new Promise((r) => setTimeout(r, 1_000));
    const later = await pair.alice.daemon.client.getBalance({ address: sessionAddr });
    expect(later).toBe(first);
    expect(later <= pair.config.sessionGasWei).toBe(true);
  });

  it("I2: rejects a match whose participant/signer indices are swapped", async () => {
    const pair = await startPair();
    cleanup = pair.cleanup;
    const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    const so = (await pair.alice.client.lobby.listOffers()).find((o) => computeOfferId(o.offer) === offerId);
    if (!so) throw new Error("offer not found");
    // Bob accepts this offer under a session key we control, without going through the real lobby round trip,
    // so the only match event bob's daemon ever sees is the crafted (swapped) one below.
    const sessionKey = generatePrivateKey();
    internals(pair.bob.daemon).records.saveOffer({ offerId, offer: so.offer, sessionKey, role: "accepter" });
    const t = await now();
    const terms = { rules: pair.env.rules, feeRecipient: pair.env.host, feePerPlayer: 5_000n, fundingWindow: 3600n };
    const acceptance = { offerId, player: pair.bob.address, signer: privateKeyToAccount(sessionKey).address, nonce: randomNonce() };
    const honest = buildParams(so.offer, acceptance, terms, t);
    // The host swaps which participant/signer sits at index 0 vs 1 — bob is still named, just at the wrong index.
    const swapped = {
      ...honest,
      participants: [honest.participants[1], honest.participants[0]] as const,
      signers: [honest.signers[1], honest.signers[0]] as const,
    };
    await internals(pair.bob.daemon).onMatch({ offerId, params: swapped });
    expect(pair.bob.daemon.channelIds()).toEqual([]);
  });

  it("I3: two match events for one offer open and fund exactly one channel", async () => {
    const pair = await startPair();
    cleanup = pair.cleanup;
    const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    const so = (await pair.alice.client.lobby.listOffers()).find((o) => computeOfferId(o.offer) === offerId);
    if (!so) throw new Error("offer not found");
    const t = await now();
    const terms = { rules: pair.env.rules, feeRecipient: pair.env.host, feePerPlayer: 5_000n, fundingWindow: 3600n };
    const mkEvent = (): MatchEvent => ({
      offerId,
      params: buildParams(
        so.offer,
        { offerId, player: pair.bob.address, signer: privateKeyToAccount(generatePrivateKey()).address, nonce: randomNonce() },
        terms,
        t,
      ),
    });
    const e1 = mkEvent();
    const e2 = mkEvent();
    // Delivered back-to-back with no await between them, as MemoryArena's relay could under a real double-fire.
    await Promise.all([internals(pair.alice.daemon).onMatch(e1), internals(pair.alice.daemon).onMatch(e2)]);
    expect(pair.alice.daemon.channelIds().length).toBe(1);
    const [id] = pair.alice.daemon.channelIds();
    await waitFor(async () => (await pair.alice.daemon.hub.channelInfo(id)).funded[0], 20_000, "alice funded");
    expect(pair.alice.daemon.channelIds().length).toBe(1);
  });

  // R8.4: status()/channels()/wait() themselves, exercised against a real matched-and-funded channel.
  it("R8.4a: status() reports phase, attention and zero cooldown right after a match", async () => {
    const { alice, id } = await matched();
    const status = await alice.daemon.status();
    expect(status.channelId).toBe(id);
    expect(status.phase).toBe("Open");
    expect(status.attention).toBe("your-turn");
    expect(status.cooldown).toEqual({ meSeconds: 0, opponentSeconds: 0 });
  });

  it("R8.4b: wait() resolves your-turn once the opponent's move arrives", async () => {
    const { alice, bob, id } = await matched();
    const waiting = bob.daemon.wait({ timeoutMs: 10_000 });
    await alice.daemon.move(undefined, "e4", { actor: "agent" });
    await expect(waiting).resolves.toEqual({ channelId: id, reason: "your-turn" });
  });

  it("R8.4c: wait() resolves control-changed on a handoff even without new attention", async () => {
    const { alice, bob, id } = await matched();
    // Make it bob's turn, so alice has no `attention` for wait() to notice first.
    await alice.daemon.move(undefined, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob's turn");
    const waiting = alice.daemon.wait({ timeoutMs: 10_000 });
    await alice.daemon.handoff(undefined, "human", "taking over");
    await expect(waiting).resolves.toEqual({ channelId: id, reason: "control-changed" });
  });

  it("R8.4d: wait() times out when the human-controlled channel has no attention and no control change", async () => {
    const { alice, bob, id } = await matched();
    await alice.daemon.move(undefined, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob's turn");
    await alice.daemon.handoff(undefined, "human", "reviewing");
    await bob.daemon.move(id, "e5", { actor: "agent" });
    await waitFor(() => alice.daemon.handle(id).session.isMyTurn(), 5_000, "alice's turn (relay)");
    await expect(alice.daemon.wait({ timeoutMs: 500 })).resolves.toEqual({ channelId: null, reason: "timeout" });
  });
});
