import { randomBytes } from "node:crypto";
import { erc20Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { HubClient, HubRevertError, LocalKeyTxSender, buildParams, offerId as computeOfferId, type MatchEvent } from "@arena/sdk";
import { DaemonError, type ArenaDaemon } from "../src/index.js";
import { CHAIN, RPC, increaseTime, now, setLimits, usdcBalance } from "../../sdk/test/helpers/chain.js";
import { START, startPair, waitFor } from "./helpers/harness.js";

/** Test-only escape hatch: onMatch/records are private/protected, but fix-round tests need to craft events. */
type Internals = {
  onMatch(m: MatchEvent): Promise<void>;
  records: { saveOffer(r: unknown): void };
  opts: { log?: (line: string) => void };
};
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

  it("final review I2: approves exactly deposit + fee per funding, never an unlimited allowance", async () => {
    const pair = await startPair();
    cleanup = pair.cleanup;
    const { alice, bob, env } = pair;
    const allowance = (owner: Hex) =>
      alice.daemon.client.readContract({ address: env.usdc, abi: erc20Abi, functionName: "allowance", args: [owner, env.hub] });
    // Alice already holds a larger allowance of her own: the daemon approves nothing and uses only what it needs.
    await alice.daemon.hub.approve(new LocalKeyTxSender(alice.walletKey, RPC, CHAIN), env.usdc, 3_000_000n);
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Open", 20_000, "funding");
    expect(await allowance(bob.address)).toBe(0n); // approved exactly 1_000_000 + 5_000, all of it spent
    expect(await allowance(alice.address)).toBe(3_000_000n - 1_005_000n); // the exact remainder of her own approval
  });

  it("C2 (Plan 4.5 Task 11 fix round): unwatches an offer once it is matched, on both sides", async () => {
    // The load-bearing fix for the watched-offer leak: a matched offer must free its watch slot on both the
    // offerer's and the accepter's host connection, or a long-lived daemon eventually hits the host's
    // per-connection watch cap and goes permanently deaf to new matches as an offerer (Task 11 report).
    const pair = await startPair();
    cleanup = pair.cleanup;
    const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    expect(pair.alice.client.watched()).toContain(offerId);
    await pair.bob.daemon.acceptOffer(offerId);
    expect(pair.bob.client.watched()).toContain(offerId);
    await waitFor(
      () => pair.alice.daemon.channelIds().length === 1 && pair.bob.daemon.channelIds().length === 1,
      20_000,
      "match",
    );
    expect(pair.alice.client.watched()).not.toContain(offerId);
    expect(pair.alice.client.unwatched()).toContain(offerId);
    expect(pair.bob.client.watched()).not.toContain(offerId);
    expect(pair.bob.client.unwatched()).toContain(offerId);
  });

  it("C2: a replayed match event for an offer that already has a channel also unwatches it", async () => {
    // Covers onMatch's "recorded" and "existing" early-return paths (a retried/duplicate match event), which the
    // main success path's unwatch call never reaches.
    const { alice, id } = await matched();
    const offerId = alice.daemon.handle(id).record.offerId;
    expect(alice.client.watched()).not.toContain(offerId); // already unwatched by the first, real match
    // Force alice's `watched` set to include it again (simulating a stale re-subscribe, e.g. from onHello after
    // a reconnect replaying an old `watch()` call this fix is meant to have prevented in the first place).
    alice.client.lobby.watch([offerId]);
    expect(alice.client.watched()).toContain(offerId);
    await internals(alice.daemon).onMatch({ offerId, params: alice.daemon.handle(id).record.params });
    expect(alice.client.watched()).not.toContain(offerId);
  });

  it("C2: a lobby subscribe refusal is visible in status and blocks new offers/accepts", async () => {
    const pair = await startPair();
    cleanup = pair.cleanup;
    // Before any refusal: createOffer/acceptOffer work, and no channel carries a lobbyError.
    const { offerId: firstOfferId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await pair.bob.daemon.acceptOffer(firstOfferId);
    const id = await waitFor(() => pair.alice.daemon.channelIds()[0], 20_000, "match");
    expect((await pair.alice.daemon.status(id)).lobbyError).toBeNull();

    pair.alice.client.refuseWatch("too many watched offers");
    // Sticky and visible: every channel's status now carries it, with a suggested restart, and new offers/accepts
    // are refused (503) instead of silently returning 200 while match delivery is actually broken.
    const status = await pair.alice.daemon.status(id);
    expect(status.lobbyError).toBe("too many watched offers");
    expect(status.suggestedActions[0]).toMatch(/restart this daemon.*too many watched offers/);
    await expect(
      pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n }),
    ).rejects.toThrow(/too many watched offers/);
    const { offerId: secondOfferId } = await pair.bob.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await expect(pair.alice.daemon.acceptOffer(secondOfferId)).rejects.toThrow(/too many watched offers/);
  });

  it("I1 (Plan 4.5 Task 11 fix round): channels()/status() never refresh a Finalized channel from chain again", async () => {
    const { alice, bob, id } = await matched();
    await alice.daemon.move(id, "e4", { actor: "agent", offerDraw: true });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    await bob.daemon.acceptDraw(id, "agent");
    await waitFor(async () => (await alice.daemon.status(id)).attention === "game-over", 5_000, "draw seen");
    await alice.daemon.close(id, "agent");
    await waitFor(async () => (await bob.daemon.status(id)).attention === "close-requested", 5_000, "close requested");
    await bob.daemon.close(id, "agent");
    await waitFor(() => alice.daemon.handle(id).record.finalized, 20_000, "finalized");

    const find = async () => {
      const c = (await alice.daemon.channels()).find((c) => c.channelId === id);
      if (!c || !("phase" in c)) throw new Error("expected a ChannelStatus for the finalized channel");
      return c;
    };
    expect((await find()).phase).toBe("Finalized");
    // `refreshChain` always replaces `ChannelHandle.chain` with a fresh object; if `channels()` skips it for a
    // Finalized channel (the fix), the reference itself never changes -- a direct, black-box-proof check, unlike
    // comparing ChannelStatus fields (cooldown is floor-clamped at 0 once past due, so a second, real chain read
    // would not visibly change the API response even if it happened).
    const chainBefore = alice.daemon.handle(id).chain;
    await increaseTime(3600);
    await find();
    expect(alice.daemon.handle(id).chain).toBe(chainBefore);
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
    // Raise the hub's per-player cap (spec §13) above this deposit, so the revert this test drives comes from
    // alice's insufficient USDC balance, not from the launch-limit check createOffer now applies up front.
    await setLimits(pair.env.hub, 100_000_000n, 10n ** 12n);
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

  it("Plan 4.5 Task 9: the accepter refuses a match that substitutes the offerer (wallet and session key)", async () => {
    const pair = await startPair();
    cleanup = pair.cleanup;
    const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    const so = (await pair.alice.client.lobby.listOffers()).find((o) => computeOfferId(o.offer) === offerId);
    if (!so) throw new Error("offer not found");
    // Bob accepted alice's offer (the record is what acceptOffer stores); the only match he sees is the host's
    // substituted one below, which names an impostor (wallet and session key) in the offerer's seat.
    const sessionKey = generatePrivateKey();
    internals(pair.bob.daemon).records.saveOffer({ offerId, offer: so.offer, sessionKey, role: "accepter" });
    const t = await now();
    const terms = { rules: pair.env.rules, feeRecipient: pair.env.host, feePerPlayer: 5_000n, fundingWindow: 3600n };
    const acceptance = { offerId, player: pair.bob.address, signer: privateKeyToAccount(sessionKey).address, nonce: randomNonce() };
    const impostorOffer = { ...so.offer, player: privateKeyToAccount(generatePrivateKey()).address, signer: privateKeyToAccount(generatePrivateKey()).address };
    const substituted = buildParams(impostorOffer, acceptance, terms, t);
    const logs: string[] = [];
    internals(pair.bob.daemon).opts.log = (l: string) => logs.push(l);
    await internals(pair.bob.daemon).onMatch({ offerId, params: substituted });
    expect(pair.bob.daemon.channelIds()).toEqual([]);
    expect(logs.join("\n")).toMatch(/ignoring match for offer .*: params do not name the expected opponent's wallet/);
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

describe("watchtower", () => {
  it("answers a stale challenge automatically", async () => {
    const { alice, bob, id } = await matched();
    await alice.daemon.move(undefined, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    const stale = alice.daemon.handle(id).session.challengeProof(); // turn 1
    await bob.daemon.move(undefined, "e5", { actor: "agent" });
    await waitFor(() => alice.daemon.handle(id).session.isMyTurn(), 5_000, "alice turn");
    const bobSessionAddr = bob.daemon.handle(id).sessionSender.address;
    // R9/3a: stop Alice's own daemon first, so only Bob's watchtower is left running to answer the
    // challenge below — Alice's own self-correcting respond (from her own up-to-date session) cannot be
    // the one resolving it.
    await alice.daemon.stop();
    // A misbehaving Alice registers the stale state (sent directly, bypassing her stopped daemon); Bob's
    // watchtower must answer with turn 2.
    // (A client of its own: a stopped daemon's HubClient aborts its receipt waits.)
    await new HubClient(alice.daemon.hub.hub, alice.daemon.client).challenge(alice.daemon.handle(id).sessionSender, stale);
    await waitFor(async () => (await bob.daemon.hub.channelInfo(id)).phase === "Open", 20_000, "respond");
    expect((await bob.daemon.hub.registeredState(id)).turnNum).toBe(2n);
    const responded = (await bob.daemon.hub.disputeEvents(id)).find((e) => e.kind === "Responded");
    expect(responded).toBeDefined();
    // Confirm it was Bob's session key that sent the Responded transaction (spec §3.1 / R9-I1).
    const tx = await bob.daemon.client.getTransaction({ hash: responded!.transactionHash });
    expect(tx.from.toLowerCase()).toBe(bobSessionAddr.toLowerCase());
  });

  /** Alice challenges on Bob's turn and stops; returns Bob's daemon with `hub.respond` replaced by `patch`, and a
   *  capture of Bob's daemon log. Shared by the respond-failure tests below (Plan 4.5 Task 8 and its review). */
  async function bobMustRespond(patch: (original: ArenaDaemon["hub"]["respond"]) => ArenaDaemon["hub"]["respond"]) {
    const m = await matched();
    const { alice, bob, id } = m;
    await alice.daemon.move(undefined, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    await alice.daemon.challenge(undefined, "agent"); // Bob must move
    await alice.daemon.stop(); // only Bob's daemon from here, so each race below is the one the test stages
    // Bob's own dispute pass would answer the challenge concurrently with his move (it runs independently of the
    // main pass since the Task 10 review): switched off so the race each test stages is the only one.
    (bob.daemon as unknown as { watchDispute: () => Promise<boolean> }).watchDispute = async () => false;
    // A dispute pass already in flight when it was switched off still holds the channel, and the move path's respond
    // skips a channel the dispute pass holds (Plan 4.5 Task 10 round 4): let it finish first.
    await waitFor(() => !bob.daemon.handle(id).disputeBusy, 10_000, "bob's dispute pass in flight finishes");
    const hub = bob.daemon.hub;
    hub.respond = patch(hub.respond.bind(hub));
    const logs: string[] = [];
    (bob.daemon as unknown as { opts: { log?: (line: string) => void } }).opts.log = (line) => logs.push(line);
    return { ...m, hub, logs };
  }

  it("losing the race to answer a challenge someone else already answered leaves no lastError, but logs it (Plan 4.5 Task 8)", async () => {
    // Both watchtowers answer the same challenge once both hold Bob's move (his own right after the move, Alice's
    // on her next tick): the other respond lands between Bob's phase check and his own respond, which reverts
    // WrongPhase. Staged here by landing an identical respond just before the daemon's own.
    const { bob, id, hub, logs } = await bobMustRespond((original) => async (sender, proof) => {
      await original(sender, proof); // "the other watchtower" wins
      return original(sender, proof); // the daemon's own call, now against an Open channel
    });
    await bob.daemon.move(undefined, "e5", { actor: "agent" });
    expect((await hub.channelInfo(id)).phase).toBe("Open");
    expect((await hub.registeredState(id)).turnNum).toBe(2n);
    expect(bob.daemon.handle(id).lastError).toBeNull();
    expect(logs.some((l) => /already answered \(registered turn 2, ours 2\).*WrongPhase/.test(l))).toBe(true);
  });

  it("a respond that fails while the channel is still Challenged sets lastError (review: negative case)", async () => {
    const { bob, id, hub } = await bobMustRespond(() => async () => {
      throw new HubRevertError("BadSignature", new Error("stubbed revert"));
    });
    await bob.daemon.move(undefined, "e5", { actor: "agent" });
    expect((await hub.channelInfo(id)).phase).toBe("Challenged");
    expect(bob.daemon.handle(id).lastError).toBe("respond: hub reverted: BadSignature");
  });

  it("a respond failure that is not a hub revert sets lastError even if the channel is Open again (review)", async () => {
    const { bob, id, hub } = await bobMustRespond((original) => async (sender, proof) => {
      await original(sender, proof); // the challenge does get answered...
      throw new Error("socket hang up"); // ...but this daemon's own send failed in transport: its problem to report
    });
    await bob.daemon.move(undefined, "e5", { actor: "agent" });
    expect((await hub.channelInfo(id)).phase).toBe("Open");
    expect(bob.daemon.handle(id).lastError).toBe("respond: socket hang up");
  });

  it("times out a silent opponent and never times out itself", async () => {
    const { alice, bob, env, id } = await matched();
    await alice.daemon.move(undefined, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    await bob.daemon.stop();
    bob.client.disconnect();
    await alice.daemon.challenge(undefined, "agent");
    // Bob is on move in the registered state. Alice's watchtower must not have called timeout before the deadline.
    await new Promise((r) => setTimeout(r, 500));
    expect((await alice.daemon.hub.channelInfo(id)).phase).toBe("Challenged");
    await increaseTime(601);
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Finalized", 20_000, "timeout");
    expect(await usdcBalance(env.usdc, alice.address)).toBe(START - 5_000n + 100_000n);
    // R9/3b (flake fix): `hub.timeout()` only resolves once the daemon's own client has fetched a receipt for
    // its transaction, one RPC round trip after Anvil mines it and flips the on-chain phase to "Finalized".
    // This test's independent `channelInfo` poll above can observe that on-chain flip inside that round trip,
    // before the daemon's own call returns and sets `record.finalized` — the sync assignment right after
    // narrows this window to one RPC, it cannot close it. Wait for the flag rather than asserting it instantly.
    await waitFor(() => alice.daemon.handle(id).record.finalized, 5_000, "record.finalized");
  });

  it("does not time out a challenge in which it is on move", async () => {
    const { alice, bob, id } = await matched();
    await alice.daemon.move(undefined, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    await alice.daemon.challenge(undefined, "agent"); // Bob must move
    await alice.daemon.stop(); // only Bob's watchtower runs from here
    await increaseTime(601);
    // R9/3b: an explicit tick() is a no-op if the periodic timer's own tick is already in flight; wait for
    // idle() first and check the per-channel pass counter actually moved, so each tick() below is known to
    // have run a full watch() pass past the deadline rather than being silently swallowed.
    await bob.daemon.idle();
    let before = bob.daemon.handle(id).disputePasses; // a Challenged channel is the dispute pass's
    await bob.daemon.tick();
    expect(bob.daemon.handle(id).disputePasses).toBeGreaterThan(before);
    await bob.daemon.idle();
    before = bob.daemon.handle(id).disputePasses;
    await bob.daemon.tick();
    expect(bob.daemon.handle(id).disputePasses).toBeGreaterThan(before);
    // Bob is on move in the registered state and past the deadline: calling timeout would forfeit Bob's stake.
    expect((await bob.daemon.hub.channelInfo(id)).phase).toBe("Challenged");
    expect((await bob.daemon.status(id)).challenge?.mustMove).toBe(true);
  });

  it("does not time out when our own local state lags behind a registered state we are on move in", async () => {
    const { alice, bob, id } = await matched();
    // Simulate a session that cannot repair itself from on-chain dispute events (e.g. a store/verification
    // failure while behind), so Bob's local `latest` stays stuck at turn 0 no matter how many ticks run.
    const session = bob.daemon.handle(id).session;
    session.ingestOnChain = () => Promise.reject(new Error("simulated ingest failure"));
    bob.client.disconnect(); // Bob also never receives Alice's move over the relay
    await alice.daemon.move(undefined, "e4", { actor: "agent" }); // turn 1; Bob (black) is on move there
    await alice.daemon.challenge(undefined, "agent"); // registers turn 1 on-chain
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Challenged", 20_000, "challenge");
    // Bob is on move in the registered state and silent: Alice's own watchtower would legitimately call
    // timeout() once the deadline passes. Stop her daemon so only Bob's watchtower runs from here — this
    // test is about Bob's on-move invariant, not a race against Alice's own (correct) timeout call.
    await alice.daemon.stop();
    await increaseTime(601);
    await bob.daemon.idle();
    let before = bob.daemon.handle(id).disputePasses; // a Challenged channel is the dispute pass's
    await bob.daemon.tick();
    expect(bob.daemon.handle(id).disputePasses).toBeGreaterThan(before);
    await bob.daemon.idle();
    before = bob.daemon.handle(id).disputePasses;
    await bob.daemon.tick();
    expect(bob.daemon.handle(id).disputePasses).toBeGreaterThan(before);
    // Bob's local view never caught up (ingest keeps failing), but the registered state has him on move:
    // his watchtower must never call timeout on itself, even though it is well past the deadline.
    expect(session.isMyTurn()).toBe(false); // still stuck at turn 0, not bob's local turn
    expect((await bob.daemon.hub.channelInfo(id)).phase).toBe("Challenged");
    // R9/4: the always-failing event was never marked processed, so it is retried (and never skipped).
    expect(bob.daemon.handle(id).processedEvents).toBe(0);
    expect(bob.daemon.handle(id).lastError).toMatch(/^ingest:/);
  });

  it("calls timeout in its favour once a stale challenge can no longer be answered past the deadline (I2)", async () => {
    // Both periodic timers are parked (pollMs far beyond the test's lifetime), so every phase transition
    // below — including funding — is driven by an explicit tick(); nothing can race ahead and auto-respond
    // to the misbehaving challenge before we choose to, which is what this regression needs to be airtight.
    const pair = await startPair({ pollMs: 3_600_000 });
    cleanup = pair.cleanup;
    const { alice, bob, env } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    await alice.daemon.idle(); // let the match event's own fire-and-forget tick (if any) finish first
    await alice.daemon.tick(); // alice (offerer) deposits
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).funded[0], 20_000, "alice funded");
    await bob.daemon.idle();
    await bob.daemon.tick(); // bob (accepter) deposits now that funded[0] is true
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Open", 20_000, "open");

    await alice.daemon.move(undefined, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    const stale = bob.daemon.handle(id).session.challengeProof(); // turn 1: Bob (black) is on move there
    await bob.daemon.move(undefined, "e5", { actor: "agent" });
    await waitFor(() => alice.daemon.handle(id).session.isMyTurn(), 5_000, "alice turn"); // both now at turn 2

    // A misbehaving Bob registers his own stale (turn 1) state on-chain. Alice now holds a newer state
    // (turn 2 > registered's 1), but with both periodic timers parked nothing answers it until the
    // explicit tick() below — so the deadline passes for certain before anyone gets a chance to respond.
    await bob.daemon.hub.challenge(bob.daemon.handle(id).sessionSender, stale);
    await increaseTime(601);
    await alice.daemon.idle();
    const before = alice.daemon.handle(id).disputePasses; // past the deadline: the dispute pass times it out
    await alice.daemon.tick();
    expect(alice.daemon.handle(id).disputePasses).toBeGreaterThan(before);
    // Past the deadline, respond() would revert (DeadlinePassed): Alice's watchtower must fall back to
    // timeout(), which succeeds because Bob (the opponent) was on move in the registered (stale) state.
    expect((await alice.daemon.hub.channelInfo(id)).phase).toBe("Finalized");
    expect(await usdcBalance(env.usdc, alice.address)).toBe(START - 5_000n + 100_000n);
    expect(alice.daemon.handle(id).record.finalized).toBe(true);
  });

  it("reclaims a deposit when the counterparty never funds", async () => {
    const pair = await startPair();
    cleanup = pair.cleanup;
    await pair.bob.daemon.stop(); // Bob matches but will never deposit
    const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await pair.bob.daemon.acceptOffer(offerId); // records Bob's acceptance; Bob's daemon is stopped so no funding
    const id = await waitFor(() => pair.alice.daemon.channelIds()[0], 20_000, "alice match");
    await waitFor(async () => (await pair.alice.daemon.hub.channelInfo(id)).phase === "Funding", 20_000, "alice funded");
    await increaseTime(3601);
    await waitFor(async () => (await pair.alice.daemon.hub.channelInfo(id)).phase === "Reclaimed", 20_000, "reclaim");
    expect(await usdcBalance(pair.env.usdc, pair.alice.address)).toBe(START);
  });
});
