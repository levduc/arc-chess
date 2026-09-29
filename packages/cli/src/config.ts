import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { readJson, writeJsonAtomic } from "./jsonfile.js";

export type ArenaConfig = {
  rpcUrl: string;
  chainId: number;
  hub: Address;
  usdc: Address;
  rules: Address;
  serverUrl: string;
  port: number;
  maxFeePerPlayer: bigint;
  sessionGasWei: bigint;
  pollMs: number;
  /** I3: max block span per `getLogs` call when scanning dispute events (real RPCs cap the range). */
  logChunkBlocks?: number;
  /** Plan 4.5 Task 10 round 4: the fee ceiling per gas of the wallet's sender (session keys have none: round 5). A replacement
   *  never pays more than max(4 x the node's estimate, this); default the SDK's DEFAULT_FEE_CEILING_WEI. */
  feeCeilingWei?: bigint;
};

/** I3: default `logChunkBlocks` when a config omits it. */
export const DEFAULT_LOG_CHUNK_BLOCKS = 1000;

export function defaultHome(env: NodeJS.ProcessEnv): string {
  return env.ARENA_HOME ?? join(homedir(), ".arena");
}

/** True for a canonical 32-byte id as used on disk: `0x` + exactly 64 lowercase hex characters. */
export function isCanonicalId(id: unknown): id is Hex {
  return typeof id === "string" && /^0x[0-9a-f]{64}$/.test(id);
}

/**
 * C1 (defense in depth): channel and offer ids become path components, so anything that is not a canonical id
 * (`./0x…`, `../wallet`, upper-case hex, …) is refused here instead of being resolved to some file by `join`.
 */
function canonical(id: Hex): Hex {
  if (!isCanonicalId(id)) throw new Error(`not a canonical id (0x + 64 lowercase hex): ${JSON.stringify(String(id)).slice(0, 80)}`);
  return id;
}

export function arenaPaths(home: string) {
  return {
    home,
    config: join(home, "config.json"),
    wallet: join(home, "wallet.json"),
    token: join(home, "token.json"),
    channels: join(home, "channels"),
    offers: join(home, "offers"),
    channelRecord: (id: Hex) => join(home, "channels", canonical(id), "record.json"),
    channelSession: (id: Hex) => join(home, "channels", canonical(id), "session.json"),
    offerRecord: (id: Hex) => join(home, "offers", `${canonical(id)}.json`),
  };
}

/** Creates or updates ARENA_HOME: config is (re)written; the wallet key and API token are created once. */
export function initHome(home: string, cfg: ArenaConfig, walletKey?: Hex): { walletKey: Hex; token: string } {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const paths = arenaPaths(home);
  writeJsonAtomic(paths.config, cfg);
  const existingWallet = readJson<{ key: Hex }>(paths.wallet);
  const key = existingWallet?.key ?? walletKey ?? generatePrivateKey();
  if (!existingWallet) writeJsonAtomic(paths.wallet, { key });
  const existingToken = readJson<{ token: string }>(paths.token);
  const token = existingToken?.token ?? randomBytes(32).toString("hex");
  if (!existingToken) writeJsonAtomic(paths.token, { token });
  return { walletKey: key, token };
}

function required<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`${what} missing: run "arena init" first`);
  return value;
}

export function loadConfig(home: string): ArenaConfig {
  return required(readJson<ArenaConfig>(arenaPaths(home).config), "config");
}

export function loadWalletKey(home: string): Hex {
  return required(readJson<{ key: Hex }>(arenaPaths(home).wallet), "wallet key").key;
}

export function loadToken(home: string): string {
  return required(readJson<{ token: string }>(arenaPaths(home).token), "API token").token;
}
