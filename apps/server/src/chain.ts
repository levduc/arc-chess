import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { foundry } from "viem/chains";
import { HubClient, mockUsdcAbi, type HubEvent } from "@arena/sdk";
import type { ServerConfig } from "./config.js";

export type Limits = {
  maxDepositPerPlayer: bigint;
  maxCommittedEscrow: bigint;
  committedEscrow: bigint;
  paused: boolean;
};

export interface ChainReader {
  now(): Promise<bigint>;
  feeConfig(): Promise<{ feePerPlayer: bigint; feeRecipient: Address }>;
  timeoutBounds(): Promise<{ min: bigint; max: bigint }>;
  head(): Promise<bigint>;
  hubEvents(fromBlock: bigint, toBlock: bigint): Promise<HubEvent[]>;
  /** The hub's current launch limits (spec §13): the two owner-set caps, the live commitment, and the pause
   *  flag. `RpcChainReader` caches this for `LIMITS_CACHE_MS`. */
  limits(): Promise<Limits>;
  /** Block 0's hash -- identifies *this chain instance*, not just its chain id (a chain id like 31337 is shared
   *  by every fresh Anvil/Hardhat node, so it alone cannot tell a redeployed local chain from the one a database
   *  was last opened against). Used at startup to detect a database that belongs to a different chain/deployment
   *  than the one this config points at. */
  genesisHash(): Promise<Hex>;
  /** The hash of the canonical block at `block` (null if there is none) -- the indexer asks before unwinding an
   *  event that vanished from `getLogs`, to tell a reorg from a lagging log index. Optional: without it, a
   *  vanished event is always treated as reorged out. */
  blockHash?(block: bigint): Promise<Hex | null>;
  /** Plan 5.5 Task 1: the RPC's `web3_clientVersion`, read once at server start to help gate the dev faucet (one
   *  of its three required checks: Global Constraints). Never used for anything else -- this never informs chain
   *  logic. */
  clientVersion(): Promise<string>;
}

const NOW_CACHE_MS = 1000;
const LIMITS_CACHE_MS = 5000;

/** The subset of HubClient that RpcChainReader calls; lets tests inject a stub without a real viem client. */
export type HubLike = Pick<HubClient, "feeConfig" | "timeoutBounds" | "blockNumber" | "hubEvents" | "limits">;

/** Reads the chain via viem/HubClient. No accounts, no signing — the server is untrusted plumbing (no keys, no
 *  funds). */
export class RpcChainReader implements ChainReader {
  private readonly client: PublicClient;
  private readonly hub: HubLike;
  private cachedNow: { value: bigint; at: number } | undefined;
  private timeoutBoundsPromise: Promise<{ min: bigint; max: bigint }> | undefined;
  private cachedLimits: { value: Limits; at: number } | undefined;
  private genesisHashPromise: Promise<Hex> | undefined;

  constructor(cfg: Pick<ServerConfig, "rpcUrl" | "chainId" | "hub">, hub?: HubLike) {
    const chain = defineChain({
      id: cfg.chainId,
      name: `arena-${cfg.chainId}`,
      nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    });
    this.client = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
    this.hub = hub ?? new HubClient(cfg.hub, this.client);
  }

  async now(): Promise<bigint> {
    const t = Date.now();
    if (this.cachedNow && t - this.cachedNow.at < NOW_CACHE_MS) return this.cachedNow.value;
    const block = await this.client.getBlock();
    this.cachedNow = { value: block.timestamp, at: t };
    return block.timestamp;
  }

  feeConfig(): Promise<{ feePerPlayer: bigint; feeRecipient: Address }> {
    return this.hub.feeConfig();
  }

  timeoutBounds(): Promise<{ min: bigint; max: bigint }> {
    // immutable on-chain, so memoize forever once fetched -- but a rejection (e.g. RPC down) must not stick
    // around forever, or every future call fails even after the chain recovers
    if (!this.timeoutBoundsPromise) {
      this.timeoutBoundsPromise = this.hub.timeoutBounds().catch((err: unknown) => {
        this.timeoutBoundsPromise = undefined;
        throw err;
      });
    }
    return this.timeoutBoundsPromise;
  }

  head(): Promise<bigint> {
    return this.hub.blockNumber();
  }

  /** Cached for `LIMITS_CACHE_MS` (spec §13): the lobby calls this on every post/accept, and the launch limits
   *  change rarely, so there is no reason to hit the RPC on every request. A rejection (e.g. RPC down) is not
   *  cached -- the caller sees it and the lobby turns it into a 503, never a silent stale read. */
  async limits(): Promise<Limits> {
    const t = Date.now();
    if (this.cachedLimits && t - this.cachedLimits.at < LIMITS_CACHE_MS) return this.cachedLimits.value;
    const value = await this.hub.limits();
    this.cachedLimits = { value, at: t };
    return value;
  }

  hubEvents(fromBlock: bigint, toBlock: bigint): Promise<HubEvent[]> {
    return this.hub.hubEvents(fromBlock, toBlock);
  }

  async blockHash(block: bigint): Promise<Hex | null> {
    const b = await this.client.getBlock({ blockNumber: block }).catch((err: unknown) => {
      if (err instanceof Error && err.name === "BlockNotFoundError") return null;
      throw err;
    });
    return b?.hash ?? null;
  }

  clientVersion(): Promise<string> {
    return this.client.request({ method: "web3_clientVersion" });
  }

  /** Immutable once the chain exists, so memoized forever like `timeoutBounds` -- with the same un-stick-on-
   *  rejection behavior for a transient RPC failure. */
  genesisHash(): Promise<Hex> {
    if (!this.genesisHashPromise) {
      this.genesisHashPromise = this.client
        .getBlock({ blockNumber: 0n })
        .then((block) => block.hash)
        .catch((err: unknown) => {
          this.genesisHashPromise = undefined;
          throw err;
        });
    }
    return this.genesisHashPromise;
  }
}

/** Plan 5.5 Task 1: 100 USDC (6 decimals), the fixed amount every `/faucet` request mints. */
export const FAUCET_USDC_AMOUNT = 100_000_000n;
/** The native balance `/faucet` guarantees at least: 1 ETH (never lowered if already higher). */
export const FAUCET_MIN_NATIVE_WEI = 10n ** 18n;

/**
 * Plan 5.5 Task 1: funds `to` on a local Anvil chain -- 100 USDC minted via MockUSDC's `mint`, sent with
 * `eth_sendTransaction` from Anvil's unlocked `eth_accounts[0]` (never a private key held by this process), and
 * the native balance raised to at least `FAUCET_MIN_NATIVE_WEI` via `anvil_setBalance` (read first; never
 * lowered). Waits for the mint's receipt before reading balances back.
 *
 * Deliberately a free function, not a `ChainReader` method: only ever called after `startServer`'s three-way
 * guard has confirmed this chain *is* Anvil's 31337, so `FakeChain`-backed tests (every other route) never need
 * to stub it, and the guard's own disabled-path tests never reach a real RPC.
 */
export async function fundFromFaucet(rpcUrl: string, usdc: Address, to: Address): Promise<{ usdc: bigint; native: bigint }> {
  const transport = http(rpcUrl);
  const pub = createPublicClient({ chain: foundry, transport });
  const wallet = createWalletClient({ chain: foundry, transport });
  const test = createTestClient({ mode: "anvil", chain: foundry, transport });

  const [from] = await wallet.getAddresses();
  const hash = await wallet.sendTransaction({
    account: from,
    chain: foundry,
    to: usdc,
    data: encodeFunctionData({ abi: mockUsdcAbi, functionName: "mint", args: [to, FAUCET_USDC_AMOUNT] }),
  });
  await pub.waitForTransactionReceipt({ hash });

  const currentNative = await pub.getBalance({ address: to });
  if (currentNative < FAUCET_MIN_NATIVE_WEI) {
    await test.setBalance({ address: to, value: FAUCET_MIN_NATIVE_WEI });
  }

  const [usdcBalance, native] = await Promise.all([
    pub.readContract({ address: usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [to] }),
    pub.getBalance({ address: to }),
  ]);
  return { usdc: usdcBalance, native };
}
