import type { Address } from "viem";
import type { HubEvent } from "@arena/sdk";
import type { ChainReader } from "../../src/chain.js";
import { DEFAULT_LIMITS, type ServerConfig } from "../../src/config.js";

export class FakeChain implements ChainReader {
  time = 1_000_000n;
  block = 100n;
  fee = { feePerPlayer: 5_000n, feeRecipient: "0x00000000000000000000000000000000000000fe" as Address };
  events: HubEvent[] = [];
  async now() { return this.time; }
  async feeConfig() { return this.fee; }
  async timeoutBounds() { return { min: 60n, max: 86_400n }; }
  async head() { return this.block; }
  async hubEvents(from: bigint, to: bigint) { return this.events.filter((e) => e.blockNumber >= from && e.blockNumber <= to); }
}

export function testConfig(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: "127.0.0.1", port: 0, publicUrl: "", rpcUrl: "http://127.0.0.1:8546", publicRpcUrl: "", chainId: 31337,
    hub: "0x00000000000000000000000000000000000000a1", usdc: "0x00000000000000000000000000000000000000a2",
    rules: "0x00000000000000000000000000000000000000a3", dbPath: ":memory:", fundingWindow: 3600n, offerMaxLifetime: 86_400n,
    defaults: { deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n }, cliCommand: "arena",
    audit: "unaudited (development build)", indexer: { pollMs: 0, chunkBlocks: 1000, startBlock: 0n }, limits: DEFAULT_LIMITS, trustProxy: false,
    ...over,
  };
}
