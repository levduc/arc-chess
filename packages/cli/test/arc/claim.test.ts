/**
 * Audit M1 on arc-anvil, against Circle's FiatToken proxy at 0x3600...0000 and its real blocklist (blacklister: anvil
 * dev account 7, tools/arc-foundry.md point 5): `claim()` pays the caller only.
 *
 * Arc refuses a blocklisted address's own transactions, so the redirect the audit found needs a blocklisted *contract*
 * wallet whose clean owner, or a relayer, pays the gas: the wallet is then `msg.sender` at the hub. Here such a wallet
 * is owed a refund. While it is blocklisted, its claim reverts at the token ("Blocked address") and the old
 * `claim(address)` redirect does not exist, so the funds stay in the hub. Once it is unblocked, its claim pays the
 * wallet itself.
 * Skipped on stock anvil (no native-USDC proxy there): `pnpm test:arc` runs it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createWalletClient, encodeFunctionData, getAddress, http, keccak256, parseAbi, toHex, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { channelHubAbi, channelId, encodeParams, type Params } from "@arena/sdk";
import { CHAIN, ON_ARC_ANVIL, RPC, increaseTime, now, publicClient, setEthBalance } from "../../../sdk/test/helpers/chain.js";
import { ARC_USDC, DEPOSIT, E12, FEE, STAKE, deployArcHub, nativeOf, newAddress } from "./harness.js";

/** Anvil dev account 7: the blacklister of arc-anvil's USDC proxy (`blacklister()`). */
const BLACKLISTER_KEY = "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356" as const;
const usdcAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function blacklist(address)",
  "function unBlacklist(address)",
  "function isBlacklisted(address) view returns (bool)",
]);
const oldClaimAbi = parseAbi(["function claim(address to)"]);
const walletArtifact = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../../contracts/out/ContractWallet.sol/ContractWallet.json"), "utf8"),
) as { abi: Abi; bytecode: { object: Hex } };

async function setBlocklisted(who: Address, on: boolean): Promise<void> {
  const blacklister = createWalletClient({ account: privateKeyToAccount(BLACKLISTER_KEY), chain: CHAIN, transport: http(RPC) });
  const hash = await blacklister.writeContract({ address: ARC_USDC, abi: usdcAbi, functionName: on ? "blacklist" : "unBlacklist", args: [who] });
  expect((await publicClient().waitForTransactionReceipt({ hash })).status).toBe("success");
  expect(await publicClient().readContract({ address: ARC_USDC, abi: usdcAbi, functionName: "isBlacklisted", args: [who] })).toBe(on);
}

describe.skipIf(!ON_ARC_ANVIL)("audit M1 (arc-anvil): claim() pays the caller only, so a blocklisted payee's owed stays in the hub", () => {
  it("a blocklisted contract wallet cannot redirect its owed; once unblocked, its claim pays the wallet itself", async () => {
    const env = await deployArcHub();
    const ownerAccount = privateKeyToAccount(generatePrivateKey());
    await setEthBalance(ownerAccount.address, 10n ** 18n); // 1 USDC, for gas
    const owner = createWalletClient({ account: ownerAccount, chain: CHAIN, transport: http(RPC) });
    const deployed = await publicClient().waitForTransactionReceipt({
      hash: await owner.deployContract({ abi: walletArtifact.abi, bytecode: walletArtifact.bytecode.object, args: [ownerAccount.address] }),
    });
    const wallet = getAddress(deployed.contractAddress!);
    const owed = DEPOSIT + FEE;
    await setEthBalance(wallet, owed * E12); // exactly its deposit and fee, in the one balance

    const exec = async (target: Address, data: Hex) => {
      const hash = await owner.writeContract({ address: wallet, abi: walletArtifact.abi, functionName: "exec", args: [target, data] });
      const receipt = await publicClient().waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe("success");
      return receipt;
    };
    const simulateExec = (target: Address, data: Hex) =>
      publicClient().simulateContract({ account: ownerAccount.address, address: wallet, abi: walletArtifact.abi, functionName: "exec", args: [target, data] });

    // The wallet funds a channel whose other side never deposits; after the funding deadline the refund is reclaimed
    // while the wallet is blocklisted, so it is deferred to owed.
    const p: Params = {
      participants: [wallet, newAddress()],
      signers: [newAddress(), newAddress()],
      rules: env.rules,
      feeRecipient: env.feeRecipient,
      feePerPlayer: FEE,
      deposit: DEPOSIT,
      stakePerGame: STAKE,
      challengeTimeout: 600n,
      fundingDeadline: (await now()) + 3_600n,
      salt: keccak256(toHex("audit M1")),
    };
    await exec(ARC_USDC, encodeFunctionData({ abi: usdcAbi, functionName: "approve", args: [env.hub, owed] }));
    await exec(env.hub, encodeFunctionData({ abi: channelHubAbi, functionName: "deposit", args: [encodeParams(p)] }));
    expect(await nativeOf(wallet)).toBe(0n);
    await increaseTime(3_601);
    await setBlocklisted(wallet, true);
    const reclaimed = await publicClient().waitForTransactionReceipt({
      hash: await owner.writeContract({ address: env.hub, abi: channelHubAbi, functionName: "reclaim", args: [channelId(CHAIN.id, env.hub, p)] }),
    });
    expect(reclaimed.status).toBe("success");
    const deferred = await publicClient().getContractEvents({ address: env.hub, abi: channelHubAbi, eventName: "PayoutDeferred", blockHash: reclaimed.blockHash });
    expect(deferred.map((l) => l.args)).toEqual([{ to: wallet, amount: owed }]);
    const owedOf = (who: Address) => publicClient().readContract({ address: env.hub, abi: channelHubAbi, functionName: "owed", args: [who] });
    expect(await owedOf(wallet)).toBe(owed);

    // While blocklisted: claim() can pay only the wallet, and Circle's token refuses it.
    const claimData = encodeFunctionData({ abi: channelHubAbi, functionName: "claim" });
    await expect(simulateExec(env.hub, claimData)).rejects.toThrow(/Blocked address/);
    // The redirect is gone: claim(address) does not exist on the hub. (On the hub before M1 this call succeeded.)
    const fresh = newAddress();
    await expect(simulateExec(env.hub, encodeFunctionData({ abi: oldClaimAbi, functionName: "claim", args: [fresh] }))).rejects.toThrow();
    expect(await owedOf(wallet)).toBe(owed);
    expect(await nativeOf(env.hub)).toBe(owed * E12); // the funds stay frozen in the hub
    expect(await nativeOf(fresh)).toBe(0n);

    // Unblocked, the wallet's claim pays the wallet itself, in full.
    await setBlocklisted(wallet, false);
    const claimed = await exec(env.hub, claimData);
    const logs = await publicClient().getContractEvents({ address: env.hub, abi: channelHubAbi, eventName: "Claimed", blockHash: claimed.blockHash });
    expect(logs.map((l) => l.args)).toEqual([{ from: wallet, to: wallet, amount: owed }]);
    expect(await owedOf(wallet)).toBe(0n);
    expect(await nativeOf(wallet)).toBe(owed * E12);
    expect(await nativeOf(env.hub)).toBe(0n);
  });
});
