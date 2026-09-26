import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ArenaDaemon, initHome, type ArenaConfig } from "../../src/index.js";
import { ANVIL_KEYS, RPC, deployArena, mintUsdc, now } from "../../../sdk/test/helpers/chain.js";
import { MemoryArena } from "./memoryArena.js";

export const START = 10_000_000n;

export type Player = {
  daemon: ArenaDaemon;
  home: string;
  walletKey: Hex;
  address: `0x${string}`;
  client: ReturnType<MemoryArena["client"]>;
};

export async function startPair(opts: { pollMs?: number; bobConfig?: Partial<ArenaConfig> } = {}) {
  const env = await deployArena();
  const arena = new MemoryArena(async () => ({
    rules: env.rules,
    feeRecipient: env.host,
    feePerPlayer: 5_000n,
    fundingWindow: 3600n,
    now: await now(),
  }));
  const config: ArenaConfig = {
    rpcUrl: RPC,
    chainId: env.domain.chainId,
    hub: env.hub,
    usdc: env.usdc,
    rules: env.rules,
    serverUrl: "memory:",
    port: 0,
    maxFeePerPlayer: 10_000n,
    sessionGasWei: 10n ** 16n,
    pollMs: opts.pollMs ?? 100,
  };
  const make = async (walletKey: Hex, overrides: Partial<ArenaConfig> = {}): Promise<Player> => {
    const home = mkdtempSync(join(tmpdir(), "arena-"));
    const own: ArenaConfig = { ...config, ...overrides }; // each daemon gets its own config object
    initHome(home, own, walletKey);
    const address = privateKeyToAccount(walletKey).address;
    await mintUsdc(env.usdc, address, START);
    const client = arena.client();
    const daemon = new ArenaDaemon({ home, config: own, walletKey, lobby: client.lobby, relay: client.relay });
    await daemon.start();
    return { daemon, home, walletKey, address, client };
  };
  const alice = await make(ANVIL_KEYS[1]);
  const bob = await make(ANVIL_KEYS[2], opts.bobConfig);
  return {
    env,
    arena,
    config,
    alice,
    bob,
    cleanup: async () => {
      await alice.daemon.stop();
      await bob.daemon.stop();
    },
  };
}

/** Polls `fn` until it returns a truthy value (or throws after `ms`). */
export async function waitFor<T>(
  fn: () => Promise<T> | T,
  ms = 20_000,
  label = "condition",
): Promise<Exclude<T, false | null | undefined>> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as Exclude<T, false | null | undefined>;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${String(last)}` : ""}`);
}
