/**
 * Plan 6 Task 4: the Arc-like harness (ledger ruling, "Task 4 harness").
 *
 * The other CLI/SDK helpers deploy their own MockUSDC, so they never exercise Arc's one balance. This harness:
 * - runs on `arc-anvil --network arc` at chain id 31337, where the 20 gwei base-fee floor holds (a fee under it is
 *   refused with -32003) and the native-USDC proxy at 0x3600...0000 is live (tools/arc-foundry.md points 3-5);
 * - deploys the hub with `token = 0x3600...0000`, so deposits, payouts, gas and the wallet are one balance;
 * - installs a test-only `CHAIN_PROFILES[31337]` with Arc's own values (the 5042 entry's USDC, floor and ceiling), so
 *   the daemon, `wallet`, `fund` and `withdraw` take their one-balance paths. Never 5042 or 5042002 locally: their
 *   `KNOWN_DEPLOYMENTS` pins refuse a local hub.
 * Players are fresh keys funded with `anvil_setBalance` (on arc-anvil that is the one balance: the proxy's `balanceOf`
 * reads it / 10^12). Every test file using this harness is gated on `ON_ARC_ANVIL`: stock anvil has no proxy.
 */
import { readFileSync, mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createWalletClient,
  erc20Abi,
  getAddress,
  http,
  parseTransaction,
  recoverTransactionAddress,
  type Abi,
  type Address,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ArenaDaemon, KNOWN_DEPLOYMENTS, initHome, profileSessionGasWei, type ArenaConfig } from "../../src/index.js";
import { CHAIN_PROFILES, type ChainProfile } from "../../src/chains.js";
import { ANVIL_KEYS, CHAIN, RPC, now, publicClient, setEthBalance } from "../../../sdk/test/helpers/chain.js";
import { MemoryArena } from "../helpers/memoryArena.js";

export const ARC_USDC: Address = "0x3600000000000000000000000000000000000000";
export const GWEI = 10n ** 9n;
/** 10^12 wei of native balance per micro-USDC. */
export const E12 = 10n ** 12n;
export const FEE = 5_000n;
export const DEPOSIT = 1_000_000n;
export const STAKE = 100_000n;

/** Arc mainnet's own profile values (5042), at the local chain id. */
export const ARC_LIKE: ChainProfile = { ...CHAIN_PROFILES[5042], name: "Arc-like (arc-anvil 31337)" };
/** The Arc default: 4 x 2.1M gas x the 40 gwei ceiling = 0.336 USDC per channel. */
export const ARC_SESSION_GAS = profileSessionGasWei(ARC_LIKE);

/** Installs `ARC_LIKE` at 31337; returns its removal. Refuses to overwrite another test's profile or to run with a pin
 *  on 31337 (either would make this harness test something else). */
export function installArcLikeProfile(): () => void {
  if (Object.hasOwn(CHAIN_PROFILES, 31337)) throw new Error("CHAIN_PROFILES[31337] is already set by another test");
  if (Object.hasOwn(KNOWN_DEPLOYMENTS, 31337)) throw new Error("KNOWN_DEPLOYMENTS[31337] is set: the Arc-like harness needs no pin");
  CHAIN_PROFILES[31337] = ARC_LIKE;
  return () => {
    delete CHAIN_PROFILES[31337];
  };
}

// ------------------------------------------------------------------ the RPC recorder (every transaction emitted)

export type EmittedTx = {
  raw: Hex;
  from: Address;
  nonce: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
  /** The node's JSON-RPC error, if it refused the transaction. */
  error?: { code: number; message: string };
};

/** A JSON-RPC pass-through to the test chain that records every `eth_sendRawTransaction` (decoded, with the node's
 *  answer) before anything is mined -- so a transaction the node refuses is seen too, not only the ones that land. The
 *  daemons in these tests point their `rpcUrl` here. */
export async function startRpcRecorder(): Promise<{ url: string; emitted: EmittedTx[]; close(): Promise<void> }> {
  const emitted: EmittedTx[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let answer: string;
        let status = 200;
        try {
          const upstream = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body });
          status = upstream.status;
          answer = await upstream.text();
          await record(body, answer);
        } catch (err) {
          status = 502;
          answer = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: `recorder: ${String(err)}` } });
        }
        res.writeHead(status, { "content-type": "application/json" });
        res.end(answer);
      })();
    });
  });
  type Rpc = { id?: unknown; method?: string; params?: unknown[] };
  type Reply = { id?: unknown; error?: { code: number; message: string } };
  async function record(body: string, answer: string): Promise<void> {
    const reqs = ([] as Rpc[]).concat(JSON.parse(body) as Rpc | Rpc[]);
    if (!reqs.some((r) => r.method === "eth_sendRawTransaction")) return;
    const replies = ([] as Reply[]).concat(JSON.parse(answer) as Reply | Reply[]);
    for (const r of reqs) {
      if (r.method !== "eth_sendRawTransaction") continue;
      const raw = r.params![0] as Hex;
      const tx = parseTransaction(raw);
      const reply = replies.find((x) => x.id === r.id);
      emitted.push({
        raw,
        from: await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized }),
        nonce: tx.nonce!,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        gasPrice: tx.gasPrice,
        ...(reply?.error ? { error: { code: reply.error.code, message: reply.error.message } } : {}),
      });
    }
  }
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    emitted,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

// ------------------------------------------------------------------ the hub on the native-USDC proxy

const OUT = resolve(import.meta.dirname, "../../../../contracts/out");
function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(resolve(OUT, `${name}.sol/${name}.json`), "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}
const deployer = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS[0]), chain: CHAIN, transport: http(RPC) });

async function deploy(name: string, args: unknown[]): Promise<Address> {
  const a = artifact(name);
  const hash = await deployer.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
  const receipt = await publicClient().waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`deploy ${name} failed`);
  return getAddress(receipt.contractAddress);
}

export type ArcEnv = { hub: Address; rules: Address; feeRecipient: Address };

/** ChessRules and a ChannelHub whose token is the native-USDC proxy (fee 0.005 USDC per player, deposit cap 10 USDC).
 *  The fee recipient is a fresh address, so its balance is exactly the fees this hub paid it. */
export async function deployArcHub(): Promise<ArcEnv> {
  const feeRecipient = newAddress();
  const rules = await deploy("ChessRules", []);
  const hub = await deploy("ChannelHub", [ARC_USDC, deployer.account.address, feeRecipient, FEE, 1_000_000n, 10_000_000n, 10n ** 12n]);
  return { hub, rules, feeRecipient };
}

export const newAddress = (): Address => privateKeyToAccount(generatePrivateKey()).address;

/** The one balance, in wei (18 decimals): the source of truth. */
export const nativeOf = (who: Address): Promise<bigint> => publicClient().getBalance({ address: who });
/** The same balance through the ERC-20 proxy (6 decimals). */
export const usdcOf = (who: Address): Promise<bigint> =>
  publicClient().readContract({ address: ARC_USDC, abi: erc20Abi, functionName: "balanceOf", args: [who] });

// ------------------------------------------------------------------ homes and daemons

export function arcConfig(env: ArcEnv, rpcUrl: string, extra: Partial<ArenaConfig> = {}): ArenaConfig {
  return {
    rpcUrl,
    chainId: CHAIN.id,
    hub: env.hub,
    usdc: ARC_USDC,
    rules: env.rules,
    serverUrl: "memory:",
    port: 0,
    maxFeePerPlayer: 10_000n,
    sessionGasWei: ARC_SESSION_GAS, // what `init` writes on a profile chain
    pollMs: 100,
    minChallengeTimeout: 60n,
    // No feeCeilingWei: the daemon takes the profile's 40 gwei (feeCeilingOf).
    ...extra,
  };
}

/** A fresh home on `env` whose wallet (a fresh key) holds exactly `wei` of the one balance. */
export async function arcHome(env: ArcEnv, rpcUrl: string, wei: bigint, extra: Partial<ArenaConfig> = {}) {
  const walletKey = generatePrivateKey();
  const address = privateKeyToAccount(walletKey).address;
  const home = mkdtempSync(join(tmpdir(), "arena-arc-"));
  const config = arcConfig(env, rpcUrl, extra);
  initHome(home, config, walletKey);
  await setEthBalance(address, wei);
  return { home, walletKey, address, config };
}

export type ArcPlayer = Awaited<ReturnType<typeof arcHome>> & { daemon: ArenaDaemon };

/** Alice and Bob, each a fresh wallet holding `wei`, with daemons on a fresh Arc hub. The profile must be installed
 *  first: a daemon reads its floor and its fee ceiling when it is built. */
export async function startArcPair(rpcUrl: string, wei: bigint) {
  if (!Object.hasOwn(CHAIN_PROFILES, CHAIN.id)) throw new Error("install the Arc-like profile before building daemons");
  const env = await deployArcHub();
  const arena = new MemoryArena(async () => ({
    rules: env.rules,
    feeRecipient: env.feeRecipient,
    feePerPlayer: FEE,
    fundingWindow: 3600n,
    now: await now(),
  }));
  const make = async (): Promise<ArcPlayer & { client: ReturnType<MemoryArena["client"]> }> => {
    const h = await arcHome(env, rpcUrl, wei);
    const client = arena.client();
    const daemon = new ArenaDaemon({ home: h.home, config: h.config, walletKey: h.walletKey, lobby: client.lobby, relay: client.relay });
    await daemon.start();
    return { ...h, daemon, client };
  };
  const alice = await make();
  const bob = await make();
  return {
    env,
    arena,
    alice,
    bob,
    cleanup: async () => {
      await alice.daemon.stop();
      await bob.daemon.stop();
    },
  };
}

// ------------------------------------------------------------------ exact accounting from receipts

export type MinedTx = {
  hash: Hex;
  from: Address;
  to: Address | null;
  value: bigint;
  gas: bigint;
  maxFeePerGas?: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  status: "success" | "reverted";
  blockNumber: bigint;
};

/** Every transaction mined in blocks (`after`, latest] whose sender is one of `from`, with its receipt. On Arc the gas
 *  a transaction pays comes out of the same USDC balance and emits no log (arc-facts.md), so exact balances are
 *  reconciled from these: `gasUsed x effectiveGasPrice` each, reverted ones included. */
export async function minedFrom(from: Address[], after: bigint): Promise<MinedTx[]> {
  const pub = publicClient();
  const want = new Set(from.map((a) => a.toLowerCase()));
  const latest = await pub.getBlockNumber();
  const out: MinedTx[] = [];
  for (let n = after + 1n; n <= latest; n++) {
    const block = await pub.getBlock({ blockNumber: n, includeTransactions: true });
    for (const tx of block.transactions) {
      if (!want.has(tx.from.toLowerCase())) continue;
      const r = await pub.getTransactionReceipt({ hash: tx.hash });
      out.push({
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        value: tx.value,
        gas: tx.gas,
        maxFeePerGas: tx.maxFeePerGas,
        gasUsed: r.gasUsed,
        effectiveGasPrice: r.effectiveGasPrice,
        status: r.status,
        blockNumber: n,
      });
    }
  }
  return out;
}

export const gasPaid = (txs: MinedTx[]): bigint => txs.reduce((s, t) => s + t.gasUsed * t.effectiveGasPrice, 0n);
/** The value `from` sent `to` in successful transactions (a reverted one moves no value). */
export const sentTo = (txs: MinedTx[], from: Address, to: Address): bigint =>
  txs
    .filter((t) => t.status === "success" && t.from.toLowerCase() === from.toLowerCase() && t.to?.toLowerCase() === to.toLowerCase())
    .reduce((s, t) => s + t.value, 0n);
