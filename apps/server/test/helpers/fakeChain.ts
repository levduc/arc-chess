import type { Address, Hex } from "viem";
import type { HubEvent } from "@arena/sdk";
import type { ChainReader, Limits } from "../../src/chain.js";
import { DEFAULT_LIMITS, type ServerConfig } from "../../src/config.js";

/** A fake genesis hash distinct from `FAKE_GENESIS_HASH_B`, for tests of the chain-identity check. */
export const FAKE_GENESIS_HASH: Hex = `0x${"11".repeat(32)}`;
export const FAKE_GENESIS_HASH_B: Hex = `0x${"22".repeat(32)}`;

export class FakeChain implements ChainReader {
  time = 1_000_000n;
  block = 100n;
  fee = { feePerPlayer: 5_000n, feeRecipient: "0x00000000000000000000000000000000000000fe" as Address };
  events: HubEvent[] = [];
  // Task 2 (spec §13): generous defaults so tests that don't care about launch limits are unaffected.
  hubLimits: Limits = { maxDepositPerPlayer: 10_000_000n, maxCommittedEscrow: 10n ** 12n, committedEscrow: 0n, paused: false };
  /** Set to make `limits()` reject, simulating an RPC failure. */
  limitsError: Error | null = null;
  /** Fixed by default; tests of the chain-identity check override this to simulate a different chain instance
   *  (e.g. a redeployed local Anvil) reporting a different genesis hash under the same chain id. */
  genesis: Hex = FAKE_GENESIS_HASH;
  async now() { return this.time; }
  async feeConfig() { return this.fee; }
  async timeoutBounds() { return { min: 60n, max: 86_400n }; }
  async head() { return this.block; }
  async hubEvents(from: bigint, to: bigint) { return this.events.filter((e) => e.blockNumber >= from && e.blockNumber <= to); }
  async limits() {
    if (this.limitsError) throw this.limitsError;
    return this.hubLimits;
  }
  async genesisHash() { return this.genesis; }
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
