import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  getAddress,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { mockUsdcAbi, type ArenaDomain } from "../../src/index.js";
import { ANVIL_PORT } from "../global-setup.js";

export const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
export const CHAIN = foundry;

/** Anvil default accounts 0 (deployer), 1 (alice), 2 (bob), 3 (host). */
export const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const satisfies readonly Hex[];

const OUT = resolve(import.meta.dirname, "../../../../contracts/out");

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(resolve(OUT, `${name}.sol/${name}.json`), "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

export function publicClient(): PublicClient {
  return createPublicClient({ chain: CHAIN, transport: http(RPC) });
}

const deployer = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS[0]), chain: CHAIN, transport: http(RPC) });
const testClient = createTestClient({ mode: "anvil", chain: CHAIN, transport: http(RPC) });

async function deploy(name: string, args: unknown[]): Promise<Address> {
  const a = artifact(name);
  const hash = await deployer.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
  const receipt = await publicClient().waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`deploy ${name} failed`);
  return getAddress(receipt.contractAddress);
}

/** Deploys a fresh MockUSDC, ChessRules and ChannelHub (fee 5000 per player, max 1e6, host = account 3). */
export async function deployArena() {
  const host = privateKeyToAccount(ANVIL_KEYS[3]).address;
  const usdc = await deploy("MockUSDC", []);
  const rules = await deploy("ChessRules", []);
  const hub = await deploy("ChannelHub", [usdc, deployer.account.address, host, 5_000n, 1_000_000n]);
  const domain: ArenaDomain = { chainId: CHAIN.id, hub };
  return { pub: publicClient(), usdc, rules, hub, host, domain };
}

export async function mintUsdc(usdc: Address, to: Address, amount: bigint): Promise<void> {
  const hash = await deployer.writeContract({ address: usdc, abi: mockUsdcAbi, functionName: "mint", args: [to, amount] });
  await publicClient().waitForTransactionReceipt({ hash });
}

export function usdcBalance(usdc: Address, who: Address): Promise<bigint> {
  return publicClient().readContract({ address: usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [who] });
}

export async function increaseTime(seconds: number): Promise<void> {
  await testClient.increaseTime({ seconds });
  await testClient.mine({ blocks: 1 });
}

export async function setEthBalance(who: Address, wei: bigint): Promise<void> {
  await testClient.setBalance({ address: who, value: wei });
}

export async function now(): Promise<bigint> {
  return (await publicClient().getBlock()).timestamp;
}
