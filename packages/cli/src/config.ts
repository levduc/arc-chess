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
  /** Native balance (wei; on Arc, native gas is USDC) each channel's session key is kept at for dispute
   *  transactions. `arena init` derives the default from the chain (`defaultSessionGasWei`, final review C1). */
  sessionGasWei: bigint;
  /** Final review C1: while a channel is Open or Challenged, a session key below this is refilled from the wallet up
   *  to `sessionGasWei`. Default: half of `sessionGasWei` (`sessionGasFloorOf`). */
  sessionGasFloor?: bigint;
  pollMs: number;
  /** I3: max block span per `getLogs` call when scanning dispute events (real RPCs cap the range). */
  logChunkBlocks?: number;
  /** Plan 4.5 Task 10 round 4: the fee ceiling per gas of the wallet's sender (session keys have none: round 5). A replacement
   *  never pays more than max(4 x the node's estimate, this); default the SDK's DEFAULT_FEE_CEILING_WEI. */
  feeCeilingWei?: bigint;
  /** Final review I4: the shortest `challengeTimeout` (seconds) this daemon offers, accepts or funds; default
   *  `DEFAULT_MIN_CHALLENGE_TIMEOUT`. A missed challenge deadline can roll a channel back to an old state, so a
   *  window of a minute (the hub's own minimum) is too short for a daemon that may restart or lose its RPC. */
  minChallengeTimeout?: bigint;
  /** Final fix wave (I1): while a human holds a seat that must move under a challenge, the daemon hands the seat
   *  back to the agent once `autoReturnSecondsOf(challengeTimeout)` or less is left, so a forfeit never depends on
   *  a human who walked away. Default true; `arena init --auto-return-on-challenge false` turns it off. */
  autoReturnOnChallenge?: boolean;
};

/** A canonical arena deployment on one chain (final review I2). */
export type KnownDeployment = { name: string; hub: Address; rules: Address; usdc?: Address };

/**
 * Final review I2: the canonical deployments, by chain id. `arena init` warns loudly when the hub, rules (or USDC,
 * where listed) it is about to use on a listed chain differ from these -- the addresses usually come from the
 * host's /templates, and a wrong hub is where deposits go.
 *
 * TODO(Plan 6): add Arc mainnet (and Arc Testnet, if used) once the contracts are deployed and verified. Until then
 * the table is empty and init only checks that the addresses hold code.
 */
export const KNOWN_DEPLOYMENTS: Record<number, KnownDeployment> = {};

/** The warnings for `addresses` on `chainId` against `table` (empty for a chain it does not list). */
export function knownDeploymentWarnings(
  chainId: number,
  addresses: { hub: Address; rules: Address; usdc: Address },
  table: Record<number, KnownDeployment> = KNOWN_DEPLOYMENTS,
): string[] {
  const known = table[chainId];
  if (!known) return [];
  const out: string[] = [];
  for (const field of ["hub", "rules", "usdc"] as const) {
    const want = known[field];
    if (want !== undefined && want.toLowerCase() !== addresses[field].toLowerCase()) {
      out.push(
        `WARNING: ${field} ${addresses[field]} is not the canonical ${known.name} ${field} ${want}. ` +
          "Deposits go to the hub this config names: do not fund this wallet unless you know why they differ.",
      );
    }
  }
  return out;
}

/** I3: default `logChunkBlocks` when a config omits it. */
export const DEFAULT_LOG_CHUNK_BLOCKS = 1000;

/** Final review I4: default `minChallengeTimeout`, and the `challengeTimeout` an offer gets when none is given. */
export const DEFAULT_MIN_CHALLENGE_TIMEOUT = 900n;

/** Final review C1: the gas one respond is budgeted at -- the heaviest measured respond is about 1.86M gas (Plan 4.5
 *  Task 4), plus a margin. */
export const RESPOND_GAS_BUDGET = 2_100_000n;
/** Final review C1: how many worst-case dispute transactions (respond, its fee-bumped replacements, a timeout) the
 *  default `sessionGasWei` pays for at the fee cap. */
export const SESSION_GAS_RESPONDS = 4n;

/**
 * Final review C1: the default `sessionGasWei`, k * G_respond * F_cap, where F_cap = max(the wallet's fee ceiling,
 * 4 x the network's current gas price). EIP-1559 admission needs `balance >= gas * maxFeePerGas`, not only the
 * actual cost, so a key funded for one respond at today's price cannot even send one in a fee spike.
 */
export function defaultSessionGasWei(feeCeilingWei: bigint, networkGasPrice: bigint): bigint {
  const fourX = 4n * networkGasPrice;
  const feeCap = fourX > feeCeilingWei ? fourX : feeCeilingWei;
  return SESSION_GAS_RESPONDS * RESPOND_GAS_BUDGET * feeCap;
}

/** The config's `sessionGasFloor`, or its default: half of `sessionGasWei`. */
export function sessionGasFloorOf(cfg: ArenaConfig): bigint {
  return cfg.sessionGasFloor ?? cfg.sessionGasWei / 2n;
}

/** The config's `minChallengeTimeout`, or its default (configs written before it existed lack it). */
export function minChallengeTimeoutOf(cfg: ArenaConfig): bigint {
  return cfg.minChallengeTimeout ?? DEFAULT_MIN_CHALLENGE_TIMEOUT;
}

/** The config's `autoReturnOnChallenge`, or its default: on. */
export function autoReturnOnChallengeOf(cfg: ArenaConfig): boolean {
  return cfg.autoReturnOnChallenge ?? true;
}

/** Final fix wave (I1): how many seconds before a challenge's deadline the daemon hands a human-held seat that must
 *  move back to the agent: `max(60, challengeTimeout / 3)` -- the whole window for the hub's 60 s minimum, 300 s
 *  for the 900 s default. */
export function autoReturnSecondsOf(challengeTimeout: bigint): number {
  return Math.max(60, Math.floor(Number(challengeTimeout) / 3));
}

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
