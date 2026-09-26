import { createPublicClient, defineChain, http, type Address, type PublicClient } from "viem";
import { HubClient, type HubEvent } from "@arena/sdk";
import type { ServerConfig } from "./config.js";

export interface ChainReader {
  now(): Promise<bigint>;
  feeConfig(): Promise<{ feePerPlayer: bigint; feeRecipient: Address }>;
  timeoutBounds(): Promise<{ min: bigint; max: bigint }>;
  head(): Promise<bigint>;
  hubEvents(fromBlock: bigint, toBlock: bigint): Promise<HubEvent[]>;
}

const NOW_CACHE_MS = 1000;

/** Reads the chain via viem/HubClient. No accounts, no signing — the server is untrusted plumbing (no keys, no
 *  funds). */
export class RpcChainReader implements ChainReader {
  private readonly client: PublicClient;
  private readonly hub: HubClient;
  private cachedNow: { value: bigint; at: number } | undefined;
  private timeoutBoundsPromise: Promise<{ min: bigint; max: bigint }> | undefined;

  constructor(cfg: Pick<ServerConfig, "rpcUrl" | "chainId" | "hub">) {
    const chain = defineChain({
      id: cfg.chainId,
      name: `arena-${cfg.chainId}`,
      nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    });
    this.client = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
    this.hub = new HubClient(cfg.hub, this.client);
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
    // immutable on-chain, so memoize forever once fetched
    if (!this.timeoutBoundsPromise) this.timeoutBoundsPromise = this.hub.timeoutBounds();
    return this.timeoutBoundsPromise;
  }

  head(): Promise<bigint> {
    return this.hub.blockNumber();
  }

  hubEvents(fromBlock: bigint, toBlock: bigint): Promise<HubEvent[]> {
    return this.hub.hubEvents(fromBlock, toBlock);
  }
}
