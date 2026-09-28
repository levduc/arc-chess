import { createPublicClient, defineChain, http, type Address, type Hex, type PublicClient } from "viem";
import { HubClient, type HubEvent } from "@arena/sdk";
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
