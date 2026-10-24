/**
 * Plan 6 Task 4 (spec §1 criterion 2, §2.2, §2.6, §3): money on arc-anvil through the Arc-like harness (./harness.ts),
 * where the hub's token is the native-USDC proxy and gas is paid from the same balance.
 * - A full game and a cooperative close, and a dispute (challenge, respond, timeout), each settle with exact balances:
 *   every wallet and session key is reconciled to the wei from receipts (`gasUsed x effectiveGasPrice`, since an Arc
 *   gas deduction emits no log), with the payouts from the hub's own `Finalized` event.
 * - Session gas: the top-up's gas limit is at least the node's estimate (`topUpGasLimit` of it), never assumed to be
 *   above 21,000; the sweep returns the key's balance to the wallet.
 * - A payout to a blocklisted address lands in `owed` (arc-anvil's USDC proxy has a working blocklist: its blacklister
 *   is anvil dev account 7, tools/arc-foundry.md point 5), and can be claimed once the address is unblocked.
 * - The floor, on the fees emitted: no transaction the daemons sent here, refused ones included, was under 20 gwei.
 * Skipped on stock anvil (no native-USDC proxy there): `pnpm test:arc` runs it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HubClient, LocalKeyTxSender, SerialTxSender, channelHubAbi } from "@arena/sdk";
import { topUpGasLimit } from "../../src/index.js";
import { SCHOLARS_MATE } from "../../../sdk/test/helpers/fixtures.js";
import { ARC_FLOOR_WEI, CHAIN, ON_ARC_ANVIL, RPC, increaseTime, publicClient } from "../../../sdk/test/helpers/chain.js";
import { waitFor } from "../helpers/harness.js";
import {
  ARC_SESSION_GAS,
  ARC_USDC,
  DEPOSIT,
  E12,
  FEE,
  STAKE,
  gasPaid,
  installArcLikeProfile,
  minedFrom,
  nativeOf,
  sentTo,
  startArcPair,
  startRpcRecorder,
  usdcOf,
  type ArcPlayer,
} from "./harness.js";

const START = 5n * 10n ** 18n; // 5 USDC per wallet
/** Anvil dev account 7: the blacklister of arc-anvil's USDC proxy (`blacklister()`). */
const BLACKLISTER_KEY = "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356" as const;
const blocklistAbi = parseAbi([
  "function blacklister() view returns (address)",
  "function blacklist(address)",
  "function unBlacklist(address)",
  "function isBlacklisted(address) view returns (bool)",
]);

async function setBlocklisted(who: Address, on: boolean): Promise<void> {
  const blacklister = createWalletClient({ account: privateKeyToAccount(BLACKLISTER_KEY), chain: CHAIN, transport: http(RPC) });
  const hash = await blacklister.writeContract({ address: ARC_USDC, abi: blocklistAbi, functionName: on ? "blacklist" : "unBlacklist", args: [who] });
  expect((await publicClient().waitForTransactionReceipt({ hash })).status).toBe("success");
  expect(await publicClient().readContract({ address: ARC_USDC, abi: blocklistAbi, functionName: "isBlacklisted", args: [who] })).toBe(on);
}

/** The hub's `Finalized` event for `id`: the payouts the hub itself computed. */
async function finalizedOf(hub: Address, id: Hex) {
  const logs = await publicClient().getContractEvents({ address: hub, abi: channelHubAbi, eventName: "Finalized", args: { channelId: id }, fromBlock: 0n });
  expect(logs).toHaveLength(1);
  const { balanceA, balanceB, fee } = logs[0].args as { balanceA: bigint; balanceB: bigint; fee: bigint };
  return { balanceA, balanceB, fee, hash: logs[0].transactionHash };
}

/**
 * Reconciles one player to the wei over blocks (`after`, latest]: the wallet paid the deposit and fee, received the
 * payout, sent the session key its top-ups, got the sweep back, and paid every transaction's gas; the key holds its
 * top-ups less its own gas and the sweep. The proxy's ERC-20 view is the wallet's balance / 10^12.
 */
async function reconcile(p: ArcPlayer, key: Address, after: bigint, payout: bigint) {
  const txs = await minedFrom([p.address, key], after);
  const walletTxs = txs.filter((t) => t.from.toLowerCase() === p.address.toLowerCase());
  const keyTxs = txs.filter((t) => t.from.toLowerCase() === key.toLowerCase());
  const topUps = sentTo(walletTxs, p.address, key);
  const swept = sentTo(keyTxs, key, p.address);
  const wallet = await nativeOf(p.address);
  const keyLeft = await nativeOf(key);
  expect(wallet).toBe(START - (DEPOSIT + FEE) * E12 + payout * E12 - topUps + swept - gasPaid(walletTxs));
  expect(keyLeft).toBe(topUps - swept - gasPaid(keyTxs));
  expect(await usdcOf(p.address)).toBe(wallet / E12);
  return { walletTxs, keyTxs, topUps, swept, wallet, keyLeft };
}

describe.skipIf(!ON_ARC_ANVIL)("Plan 6 Task 4 (arc-anvil): games, disputes and payouts settle exactly on one balance", () => {
  let uninstall: () => void;
  let recorder: Awaited<ReturnType<typeof startRpcRecorder>>;
  const cleanups: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    uninstall = installArcLikeProfile();
    recorder = await startRpcRecorder();
  });
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });
  afterAll(async () => {
    uninstall?.();
    await recorder?.close();
  });

  /** A matched, funded, Open channel between fresh Arc-like wallets; `start` is the block before anything was sent. */
  async function opened() {
    const start = await publicClient().getBlockNumber();
    const pair = await startArcPair(recorder.url, START);
    cleanups.push(pair.cleanup);
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: DEPOSIT, stakePerGame: STAKE, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(async () => {
      const [a, b] = [alice.daemon.channelIds(), bob.daemon.channelIds()];
      return a.length === 1 && b.length === 1 && a[0] === b[0] ? a[0] : null;
    }, 20_000, "match");
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Open", 30_000, "open");
    const keys = { alice: alice.daemon.handle(id).sessionSender.address, bob: bob.daemon.handle(id).sessionSender.address };
    return { ...pair, id, start, keys };
  }

  async function closeBoth(alice: ArcPlayer, bob: ArcPlayer, id: Hex) {
    await alice.daemon.close(id, "agent");
    await waitFor(async () => (await bob.daemon.status(id)).attention === "close-requested", 10_000, "close requested");
    await bob.daemon.close(id, "agent");
  }

  it("a full game and a cooperative close: both wallets and keys reconcile to the wei; top-up gas >= the estimate; the sweep comes home", async () => {
    const { env, alice, bob, id, start, keys } = await opened();
    // Scholar's mate: Alice (player 0) has White and wins the game.
    for (const [i, m] of SCHOLARS_MATE.entries()) {
      const mover = i % 2 === 0 ? alice : bob;
      const other = i % 2 === 0 ? bob : alice;
      await mover.daemon.move(id, m, { actor: "agent" });
      if (i < SCHOLARS_MATE.length - 1) await waitFor(() => other.daemon.handle(id).session.isMyTurn(), 5_000, `move ${i + 1} seen`);
    }
    await waitFor(async () => (await bob.daemon.status(id)).attention === "game-over", 5_000, "mate seen");
    await closeBoth(alice, bob, id);
    await waitFor(() => alice.daemon.handle(id).record.finalized && bob.daemon.handle(id).record.finalized, 30_000, "finalized");
    await waitFor(() => alice.daemon.handle(id).record.swept === true && bob.daemon.handle(id).record.swept === true, 30_000, "both swept");

    const fin = await finalizedOf(env.hub, id);
    expect(fin).toMatchObject({ balanceA: DEPOSIT + STAKE, balanceB: DEPOSIT - STAKE, fee: 2n * FEE });
    const a = await reconcile(alice, keys.alice, start, fin.balanceA);
    const b = await reconcile(bob, keys.bob, start, fin.balanceB);
    expect(await nativeOf(env.feeRecipient)).toBe(2n * FEE * E12);
    expect(await nativeOf(env.hub)).toBe(0n); // nothing left in escrow
    // Total wealth: each side's wallet + key moved by exactly -fee +/- stake - all its gas.
    expect(a.wallet + a.keyLeft).toBe(START - FEE * E12 + STAKE * E12 - gasPaid([...a.walletTxs, ...a.keyTxs]));
    expect(b.wallet + b.keyLeft).toBe(START - FEE * E12 - STAKE * E12 - gasPaid([...b.walletTxs, ...b.keyTxs]));

    for (const [p, r, key] of [[alice, a, keys.alice], [bob, b, keys.bob]] as const) {
      // Session gas: one top-up of the whole sessionGasWei, its limit topUpGasLimit(the node's estimate) >= the estimate.
      const topUps = r.walletTxs.filter((t) => t.to?.toLowerCase() === key.toLowerCase());
      expect(topUps).toHaveLength(1);
      expect(topUps[0]).toMatchObject({ value: ARC_SESSION_GAS, status: "success" });
      const estimate = await publicClient().estimateGas({ account: p.address, to: key, value: ARC_SESSION_GAS });
      expect(topUps[0].gas).toBeGreaterThanOrEqual(estimate);
      expect(topUps[0].gas).toBe(topUpGasLimit(estimate));
      expect(topUps[0].gasUsed).toBeLessThanOrEqual(topUps[0].gas);
      // The sweep: the key's one transaction, its whole balance less the reserve, back to the wallet.
      const record = p.daemon.handle(id).record;
      expect(r.keyTxs).toHaveLength(1);
      expect(r.keyTxs[0]).toMatchObject({ hash: record.sweptTx, value: record.sweptAmount, status: "success" });
      expect(r.keyTxs[0].to?.toLowerCase()).toBe(p.address.toLowerCase());
      expect(r.swept).toBe(record.sweptAmount);
      expect(r.keyLeft).toBeLessThan(ARC_SESSION_GAS / 100n); // only the unspent fee headroom stays on the key
    }
  });

  it("a dispute -- challenge, respond, then timeout -- settles exactly, every dispute transaction paid from the keys' USDC", async () => {
    const { env, alice, bob, id, start, keys } = await opened();
    const hub = alice.daemon.hub;
    // 1. Alice moves and challenges on Bob's turn; Bob's move answers it on-chain (respond, from his session key).
    await alice.daemon.move(id, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob's turn");
    await alice.daemon.challenge(id, "agent");
    expect((await hub.channelInfo(id)).phase).toBe("Challenged");
    await bob.daemon.move(id, "e5", { actor: "agent" });
    await waitFor(async () => (await hub.channelInfo(id)).phase === "Open", 20_000, "responded");
    expect((await hub.registeredState(id)).turnNum).toBe(2n);
    // 2. Alice's agent then goes silent on her move: Bob challenges, and his watchtower times her out past the deadline.
    await waitFor(() => alice.daemon.handle(id).session.isMyTurn(), 5_000, "alice's turn");
    await bob.daemon.challenge(id, "agent");
    expect((await hub.channelInfo(id)).phase).toBe("Challenged");
    await increaseTime(601);
    await waitFor(async () => (await hub.channelInfo(id)).phase === "Finalized", 30_000, "timed out");
    await waitFor(() => alice.daemon.handle(id).record.finalized && bob.daemon.handle(id).record.finalized, 20_000, "finalized");
    await waitFor(() => alice.daemon.handle(id).record.swept === true && bob.daemon.handle(id).record.swept === true, 30_000, "both swept");

    const events = await hub.disputeEvents(id);
    expect(events.map((e) => e.kind).sort()).toEqual(["Challenged", "Challenged", "Responded"]);
    const fin = await finalizedOf(env.hub, id);
    expect(fin).toMatchObject({ balanceA: DEPOSIT - STAKE, balanceB: DEPOSIT + STAKE, fee: 2n * FEE }); // Alice timed out
    const a = await reconcile(alice, keys.alice, start, fin.balanceA);
    const b = await reconcile(bob, keys.bob, start, fin.balanceB);
    expect(await nativeOf(env.feeRecipient)).toBe(2n * FEE * E12);
    expect(await nativeOf(env.hub)).toBe(0n);
    // Every dispute transaction came from a session key: Alice's challenge; Bob's respond, challenge and timeout.
    const senderOf = async (hash: Hex) => (await publicClient().getTransaction({ hash })).from.toLowerCase();
    const [first, second] = events.filter((e) => e.kind === "Challenged").sort((x, y) => Number(x.blockNumber - y.blockNumber));
    expect(await senderOf(first.transactionHash)).toBe(keys.alice.toLowerCase());
    expect(await senderOf(second.transactionHash)).toBe(keys.bob.toLowerCase());
    expect(await senderOf(events.find((e) => e.kind === "Responded")!.transactionHash)).toBe(keys.bob.toLowerCase());
    expect(await senderOf(fin.hash)).toBe(keys.bob.toLowerCase()); // the timeout
    expect(a.keyTxs.length).toBeGreaterThanOrEqual(2); // the challenge and the sweep
    expect(b.keyTxs.length).toBeGreaterThanOrEqual(4); // respond, challenge, timeout and the sweep
    expect(gasPaid(b.keyTxs)).toBeGreaterThan(0n);
  });

  it("a payout to a blocklisted wallet lands in owed (PayoutDeferred); the other side and the fee are paid; it is claimable once unblocked", async () => {
    const blacklister = await publicClient().readContract({ address: ARC_USDC, abi: blocklistAbi, functionName: "blacklister" });
    expect(blacklister).toBe(privateKeyToAccount(BLACKLISTER_KEY).address); // arc-anvil's proxy: dev account 7
    const { env, alice, bob, id, start, keys } = await opened();
    await alice.daemon.move(id, "e4", { actor: "agent", offerDraw: true });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob's turn");
    await bob.daemon.acceptDraw(id, "agent");
    await waitFor(async () => (await alice.daemon.status(id)).attention === "game-over", 5_000, "draw seen");
    await alice.daemon.close(id, "agent");
    await waitFor(async () => (await bob.daemon.status(id)).attention === "close-requested", 10_000, "close requested");
    // Bob's wallet is blocklisted: it can neither send nor receive. His own close submission fails (arc-anvil refuses a
    // blocklisted sender outright); his signature still reaches Alice, whose daemon submits the close.
    await setBlocklisted(bob.address, true);
    await bob.daemon.close(id, "agent").catch(() => undefined);
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Finalized", 30_000, "finalized by Alice");

    const fin = await finalizedOf(env.hub, id);
    expect(fin).toMatchObject({ balanceA: DEPOSIT, balanceB: DEPOSIT, fee: 2n * FEE });
    const receipt = await publicClient().getTransactionReceipt({ hash: fin.hash });
    expect(receipt.from.toLowerCase()).toBe(alice.address.toLowerCase());
    const deferred = await publicClient().getContractEvents({ address: env.hub, abi: channelHubAbi, eventName: "PayoutDeferred", blockHash: receipt.blockHash });
    expect(deferred.map((l) => l.args)).toEqual([{ to: bob.address, amount: DEPOSIT }]);
    expect(await alice.daemon.hub.owed(bob.address)).toBe(DEPOSIT);
    expect(await nativeOf(env.hub)).toBe(DEPOSIT * E12); // the hub holds exactly what it owes
    expect(await nativeOf(env.feeRecipient)).toBe(2n * FEE * E12);
    await waitFor(() => alice.daemon.handle(id).record.swept === true, 30_000, "alice swept");
    await reconcile(alice, keys.alice, start, fin.balanceA); // Alice is paid in full, to the wei

    // Unblocked, Bob claims what he is owed. His daemon is stopped first, so its session-key sweep (which cannot reach
    // a blocklisted wallet, and backs off) cannot land in the middle of this balance check.
    await bob.daemon.stop();
    await setBlocklisted(bob.address, false);
    const before = await nativeOf(bob.address);
    const claimer = new SerialTxSender(new LocalKeyTxSender(bob.walletKey, RPC, CHAIN));
    const claim = await new HubClient(env.hub, publicClient()).claim(claimer, bob.address);
    expect(claim.status).toBe("success");
    expect(await alice.daemon.hub.owed(bob.address)).toBe(0n);
    expect(await nativeOf(bob.address)).toBe(before + DEPOSIT * E12 - claim.gasUsed * claim.effectiveGasPrice);
    expect(await nativeOf(env.hub)).toBe(0n);
  });

  it("the floor, on the fees emitted: every transaction the daemons sent in this file paid at least 20 gwei", () => {
    expect(recorder.emitted.length).toBeGreaterThan(20);
    for (const t of recorder.emitted) {
      expect(t.gasPrice).toBeUndefined(); // EIP-1559 throughout
      expect(t.maxFeePerGas!).toBeGreaterThanOrEqual(ARC_FLOOR_WEI);
      expect(t.maxPriorityFeePerGas!).toBeLessThanOrEqual(t.maxFeePerGas!);
      expect(t.error?.code).not.toBe(-32003);
      // The only refusals: transactions to or from the wallet blocklisted above.
      if (t.error) expect(t.error.message).toMatch(/blocklisted/);
    }
  });
});
