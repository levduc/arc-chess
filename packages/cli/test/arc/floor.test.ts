/**
 * Plan 6 Task 4 (spec §2.3, §3; audit-daemon I-4, I-6): the 20 gwei fee floor on arc-anvil at chain id 31337.
 * - The node refuses a transaction whose `maxFeePerGas` is under the floor, with -32003. Real Arc drops it silently
 *   instead (arc-facts.md); arc-anvil models the floor but not the silence (tools/arc-foundry.md point 3).
 * - A `SerialTxSender` handed an estimate under the floor (a lagging RPC, a clamped replacement) emits a transaction
 *   the node refuses when it has no floor, and the same send pays the floor and lands when it has the profile's.
 * - The daemon's wallet and session-key senders carry the Arc-like profile's floor.
 * Every transaction is checked as emitted (the RPC recorder in ./harness.ts), refused ones included. The daemons'
 * own emitted fees, over a whole game and dispute, are asserted in ./settlement.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseError, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { LocalKeyTxSender, NO_FEE_CEILING, SerialTxSender, type TrackerClient } from "@arena/sdk";
import { ArenaDaemon } from "../../src/index.js";
import { ARC_FLOOR_WEI, CHAIN, ON_ARC_ANVIL, publicClient, setEthBalance } from "../../../sdk/test/helpers/chain.js";
import { GWEI, arcHome, deployArcHub, installArcLikeProfile, nativeOf, newAddress, startRpcRecorder } from "./harness.js";

const codeOf = (err: unknown): number | undefined =>
  err instanceof BaseError ? (err.walk((e) => typeof (e as { code?: unknown }).code === "number") as { code?: number } | null)?.code : undefined;

/** The chain's reads, but an `estimateFeesPerGas` that answers `maxFeePerGas`: a node whose estimate lags the floor. */
function lowEstimateReader(maxFeePerGas: bigint): TrackerClient {
  const pub = publicClient();
  return {
    getTransactionReceipt: pub.getTransactionReceipt.bind(pub),
    getTransaction: pub.getTransaction.bind(pub),
    getTransactionCount: pub.getTransactionCount.bind(pub),
    estimateGas: pub.estimateGas.bind(pub),
    getBalance: pub.getBalance.bind(pub),
    estimateFeesPerGas: (async () => ({ maxFeePerGas, maxPriorityFeePerGas: 1n * GWEI })) as TrackerClient["estimateFeesPerGas"],
  };
}

describe.skipIf(!ON_ARC_ANVIL)("Plan 6 Task 4 (arc-anvil): the 20 gwei floor", () => {
  let uninstall: () => void;
  let recorder: Awaited<ReturnType<typeof startRpcRecorder>>;
  beforeAll(async () => {
    uninstall = installArcLikeProfile();
    recorder = await startRpcRecorder();
  });
  afterAll(async () => {
    uninstall?.();
    await recorder?.close();
  });

  it("arc-anvil at 31337 refuses a transaction under the floor with -32003, and mines nothing", async () => {
    expect((await publicClient().getBlock()).baseFeePerGas).toBe(ARC_FLOOR_WEI);
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    await setEthBalance(account.address, 10n ** 18n);
    const raw = await account.signTransaction({
      chainId: CHAIN.id,
      type: "eip1559",
      to: newAddress(),
      value: 1n,
      gas: 21_000n,
      nonce: 0,
      maxFeePerGas: ARC_FLOOR_WEI - 1n,
      maxPriorityFeePerGas: 1n,
    });
    const sent = publicClient().sendRawTransaction({ serializedTransaction: raw });
    await expect(sent).rejects.toThrow(/max fee per gas less than block base fee/);
    expect(codeOf(await sent.catch((e: unknown) => e))).toBe(-32003);
    expect(await publicClient().getTransactionCount({ address: account.address, blockTag: "pending" })).toBe(0);
    expect(await nativeOf(account.address)).toBe(10n ** 18n);
  });

  it("a sender handed an estimate under the floor: without minFeePerGas arc-anvil refuses what it emits; with the floor it pays 20 gwei and lands", async () => {
    const send = async (minFeePerGas: bigint) => {
      const key = generatePrivateKey();
      const address = privateKeyToAccount(key).address;
      await setEthBalance(address, 10n ** 18n);
      const sender = new SerialTxSender(new LocalKeyTxSender(key, recorder.url, CHAIN), lowEstimateReader(10n * GWEI), { minFeePerGas });
      const outcome = await sender.send({ to: newAddress(), data: "0x", value: 1n, gas: 21_000n }).then(
        (hash: Hex) => ({ hash }),
        (err: unknown) => ({ err }),
      );
      return { address, outcome, emitted: recorder.emitted.filter((t) => t.from === address) };
    };

    // No floor: 10 gwei goes out, and the node refuses it (on real Arc it would vanish without an error).
    const bare = await send(0n);
    expect(bare.emitted).toHaveLength(1);
    expect(bare.emitted[0].maxFeePerGas).toBe(10n * GWEI);
    expect(bare.emitted[0].error?.code).toBe(-32003);
    expect("err" in bare.outcome && codeOf(bare.outcome.err)).toBe(-32003);
    expect(await publicClient().getTransactionCount({ address: bare.address })).toBe(0);

    // The profile's floor: the same estimate goes out at 20 gwei, the priority fee within it, and is mined.
    const floored = await send(ARC_FLOOR_WEI);
    expect(floored.emitted).toHaveLength(1);
    expect(floored.emitted[0].maxFeePerGas).toBe(ARC_FLOOR_WEI);
    expect(floored.emitted[0].maxPriorityFeePerGas!).toBeLessThanOrEqual(ARC_FLOOR_WEI);
    expect(floored.emitted[0].error).toBeUndefined();
    expect("hash" in floored.outcome).toBe(true);
    const receipt = await publicClient().waitForTransactionReceipt({ hash: (floored.outcome as { hash: Hex }).hash });
    expect(receipt.status).toBe("success");
    expect(receipt.effectiveGasPrice).toBeGreaterThanOrEqual(ARC_FLOOR_WEI);
  });

  it("a daemon on the Arc-like profile floors its wallet and every session-key sender at 20 gwei", async () => {
    const env = await deployArcHub();
    const h = await arcHome(env, recorder.url, 10n ** 18n);
    const d = new ArenaDaemon({ home: h.home, config: h.config, walletKey: h.walletKey, lobby: {} as never, relay: {} as never });
    expect(d.wallet.minFeePerGas).toBe(ARC_FLOOR_WEI);
    expect(d.wallet.feeCeiling).toBe(40n * GWEI);
    const session = (d as unknown as { sessionSenderFor(k: Hex): SerialTxSender }).sessionSenderFor(generatePrivateKey());
    expect(session.minFeePerGas).toBe(ARC_FLOOR_WEI);
    expect(session.feeCeiling).toBe(NO_FEE_CEILING);
  });
});
