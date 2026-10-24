import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { CHAIN_PROFILES, type ChainProfile } from "./chains.js";
import { readJson, writeJsonAtomic } from "./jsonfile.js";
import { selfCommand } from "./version.js";

/** Plan 5.7 (spec §3, §5): the XMTP network the fallback transport uses, copied by `init` from the host's
 *  `/templates` (`xmtp`). `apiUrl` overrides the env's endpoint (tests, a local node); `gatewayHost` is the host's
 *  XMTP Gateway once network fees are enforced. */
export type XmtpConfig = { env: "local" | "dev" | "production"; apiUrl?: string; gatewayHost?: string };

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
  /** Plan 5.6 Task 3 (spec §4.3): the human owner's address -- the only place `arena withdraw` ever sends USDC.
   *  Set by `arena owner set` or `arena init --owner` (first set free; a change needs the current owner's
   *  signature, see `owner.ts`), kept by a re-`init`, and re-read from disk by the daemon on every withdraw. No
   *  daemon API route sets it. Absent until first set. */
  owner?: Address;
  /** Task 3 fix round 1 (I2): goes up by one on every owner change and is part of the message the current owner
   *  signs, so an old signature can never be replayed (A→B→A). Absent = 0. Kept by a re-`init`. */
  ownerNonce?: number;
  /** Plan 5.7: the XMTP fallback transport's network. Absent = no fallback: the daemon uses the host relay alone,
   *  exactly as before. Validated by `loadConfig` (`parseXmtpConfig`). */
  xmtp?: XmtpConfig;
};

const XMTP_ENVS: ReadonlyArray<XmtpConfig["env"]> = ["local", "dev", "production"];

/** An http(s) URL with no embedded credentials, or a throw naming `field`. */
function xmtpUrl(v: unknown, field: string): string {
  if (typeof v !== "string") throw new Error(`${field}: must be a string`);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${field}: must be a valid URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`${field}: must be an http(s) URL`);
  if (u.username !== "" || u.password !== "") throw new Error(`${field}: must not contain credentials`);
  return v;
}

/**
 * Plan 5.7: validates an `xmtp` config value (from `config.json`, or from the host's `/templates` when `init` caches
 * it) and returns a clean copy with only the known fields (an unknown key is dropped, so a host that publishes a
 * newer field does not break an older CLI). The rules are the server's own (`apps/server/src/config.ts`
 * `parseXmtp`), so whatever a host publishes, the CLI accepts: `env` is one of the three; `apiUrl` and
 * `gatewayHost` are http(s) URLs without credentials; a gateway is refused with `env: "local"` (the SDK accepts one
 * only for `dev` and `production`).
 */
export function parseXmtpConfig(x: unknown): XmtpConfig {
  if (typeof x !== "object" || x === null || Array.isArray(x)) throw new Error("xmtp: must be an object");
  const o = x as Record<string, unknown>;
  if (typeof o.env !== "string" || !(XMTP_ENVS as readonly string[]).includes(o.env)) {
    throw new Error(`xmtp.env: must be one of ${XMTP_ENVS.join(", ")}`);
  }
  const out: XmtpConfig = { env: o.env as XmtpConfig["env"] };
  if (o.apiUrl !== undefined) out.apiUrl = xmtpUrl(o.apiUrl, "xmtp.apiUrl");
  if (o.gatewayHost !== undefined) {
    out.gatewayHost = xmtpUrl(o.gatewayHost, "xmtp.gatewayHost");
    if (out.env === "local") throw new Error('xmtp.gatewayHost: is not allowed with env: "local"');
  }
  return out;
}

/** A canonical arena deployment on one chain (final review I2). */
export type KnownDeployment = { name: string; hub: Address; rules: Address; usdc?: Address };

/**
 * Final review I2: the canonical deployments, by chain id -- the addresses usually come from the host's /templates,
 * and a wrong hub is where deposits go.
 * - Plan 6 (spec §2.5, Review Focus 3): on a chain with a built-in profile (`CHAIN_PROFILES`), `arena init`
 *   **refuses** a hub, rules (or USDC, where listed) that differ from the entry here (`pinnedDeploymentRefusals`).
 * - On any other chain it only warns (`knownDeploymentWarnings`), as before.
 *
 * Arc's entries are pinned once each deployment is verified; until then the chain has no entry, and `init` on it
 * only checks the profile's USDC and that the addresses hold code. Never add a placeholder address: an entry here
 * refuses every other hub on its chain.
 */
export const KNOWN_DEPLOYMENTS: Record<number, KnownDeployment> = {
  // 5042: Arc mainnet -- pinned by Plan 6 Task 6, after the gated mainnet deploy (contracts/deployments/5042.json).
  // 5042002: Arc Testnet -- pinned by Plan 6 Task 5, after the testnet deploy (contracts/deployments/5042002.json).
};

/**
 * Plan 6 (spec §2.5, Review Focus 3): why `init` must refuse `addresses` on `chainId` -- empty when it may go on.
 * Only for a chain with a built-in profile (any other chain gets `knownDeploymentWarnings`):
 * - a USDC other than the profile's is always refused, even before the chain's deployment is pinned;
 * - once `table` pins the chain, a hub or rules (or a listed USDC) other than the pinned one is refused.
 * The check runs on the resolved addresses, so it holds whether they came from /templates or from explicit flags.
 */
export function pinnedDeploymentRefusals(
  chainId: number,
  addresses: { hub: Address; rules: Address; usdc: Address },
  opts: { profiles?: Record<number, ChainProfile>; table?: Record<number, KnownDeployment> } = {},
): string[] {
  const profiles = opts.profiles ?? CHAIN_PROFILES;
  const table = opts.table ?? KNOWN_DEPLOYMENTS;
  if (!Object.hasOwn(profiles, chainId)) return [];
  const profile = profiles[chainId];
  const out: string[] = [];
  const wrongUsdc = profile.usdc.toLowerCase() !== addresses.usdc.toLowerCase();
  if (wrongUsdc) out.push(`usdc ${addresses.usdc} is not ${profile.name}'s USDC ${profile.usdc}`);
  const known = Object.hasOwn(table, chainId) ? table[chainId] : undefined;
  if (known) {
    for (const field of ["hub", "rules", "usdc"] as const) {
      const want = known[field];
      if (field === "usdc" && wrongUsdc) continue; // already refused against the profile, above
      if (want !== undefined && want.toLowerCase() !== addresses[field].toLowerCase()) {
        out.push(`${field} ${addresses[field]} is not the pinned ${known.name} ${field} ${want}`);
      }
    }
  }
  return out;
}

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
  // Final fix wave (M5): the command an agent can actually type back -- the pinned npx form in the bundle.
  if (value === null) throw new Error(`${what} missing: run "${selfCommand()} init" first`);
  return value;
}

/**
 * Plan 5.7 (m-7): `config.json` as `loadConfig` returns it, plus what was wrong with its `xmtp`, if anything. Only
 * `xmtp` is validated here, and only when present -- every other field loads exactly as before. An invalid `xmtp` (a
 * hand edit, or a value a newer CLI wrote) is dropped from the returned config rather than refused: the XMTP fallback
 * is optional, and refusing would stop every command, `arena daemon` and its watchtower included. `init` stays strict
 * (it validates with `parseXmtpConfig` itself). The file is not rewritten.
 */
export function readConfig(home: string): { config: ArenaConfig; xmtpProblem: string | null } {
  const cfg = required(readJson<ArenaConfig>(arenaPaths(home).config), "config");
  if (cfg.xmtp === undefined) return { config: cfg, xmtpProblem: null };
  try {
    cfg.xmtp = parseXmtpConfig(cfg.xmtp);
    return { config: cfg, xmtpProblem: null };
  } catch (err) {
    delete cfg.xmtp;
    const why = err instanceof Error ? err.message : String(err);
    return { config: cfg, xmtpProblem: `config.json's xmtp is invalid (${why}), so the XMTP fallback is off; re-run init to refresh it` };
  }
}

/** Problems `loadConfig` has already warned about with its default sink: once per process each. */
const warnedConfigProblems = new Set<string>();

/** Loads `config.json` (see `readConfig`). An invalid `xmtp` is dropped with one warning: to `opts.warn` when given,
 *  else to stderr, once per process. */
export function loadConfig(home: string, opts: { warn?: (line: string) => void } = {}): ArenaConfig {
  const { config, xmtpProblem } = readConfig(home);
  if (xmtpProblem !== null) {
    if (opts.warn) opts.warn(`warning: ${xmtpProblem}`);
    else if (!warnedConfigProblems.has(xmtpProblem)) {
      warnedConfigProblems.add(xmtpProblem);
      process.stderr.write(`warning: ${xmtpProblem}\n`);
    }
  }
  return config;
}

export function loadWalletKey(home: string): Hex {
  return required(readJson<{ key: Hex }>(arenaPaths(home).wallet), "wallet key").key;
}

export function loadToken(home: string): string {
  return required(readJson<{ token: string }>(arenaPaths(home).token), "API token").token;
}
