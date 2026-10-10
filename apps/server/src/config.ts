import type { Address } from "viem";

export type Limits = {
  httpPostBurst: number; httpPostPerSec: number; httpGetBurst: number; httpGetPerSec: number;
  wsPerIp: number; wsFrameBurst: number; wsFramePerSec: number; maxFrameBytes: number;
  maxOpenOffersPerIp: number; maxWatchedOffers: number; maxJoinsPerConnection: number;
};

/**
 * Final review m8: `wsFrameBurst`/`wsFramePerSec` are per connection, and one daemon sends every channel's relay
 * traffic (moves, re-sends after each join, close signatures) over its one connection. At the old 200 / 20 a busy
 * daemon tripped the limit, and the server closes the socket on a trip (1008), so the reconnect-and-re-send cycle
 * turned into a reconnect storm that blacked out match delivery (Task 11 soak). The soak needed 2000 / 200; the
 * defaults are twice that. The per-IP caps (`wsPerIp`, the HTTP buckets, `maxOpenOffersPerIp`) are unchanged.
 */
export const DEFAULT_LIMITS: Limits = {
  httpPostBurst: 30, httpPostPerSec: 1, httpGetBurst: 120, httpGetPerSec: 10,
  wsPerIp: 16, wsFrameBurst: 4000, wsFramePerSec: 400, maxFrameBytes: 64 * 1024,
  maxOpenOffersPerIp: 5, maxWatchedOffers: 256, maxJoinsPerConnection: 64,
};

/** Plan 5.6 Task 4 (spec §3): a published, pinned CLI version this host advertises in `/templates`, so an agent
 *  always installs and runs an exact version instead of `@latest`. `minVersion` (when set) is the floor `init`
 *  refuses below; `version` is the one the derived `cliCommand` and skill.md's Install step actually pin to. */
export type CliConfig = { package: string; version: string; minVersion?: string };

export type ServerConfig = {
  host: string;
  port: number;
  publicUrl: string;
  rpcUrl: string;
  publicRpcUrl: string;
  chainId: number;
  hub: Address; usdc: Address; rules: Address;
  dbPath: string;
  fundingWindow: bigint;
  offerMaxLifetime: bigint;
  defaults: { deposit: bigint; stakePerGame: bigint; challengeTimeout: bigint };
  cliCommand: string;
  /** Set only when this host pins a published CLI (see `CliConfig`); published in `/templates` the same way. */
  cli?: CliConfig;
  audit: string;
  indexer: { pollMs: number; chunkBlocks: number; startBlock: bigint };
  limits: Limits;
  /** Behind a reverse proxy: key per-IP limits on the right-most `X-Forwarded-For` entry, not the socket peer
   *  (which is then the proxy itself). Never enable it on a directly exposed server: clients could spoof it. */
  trustProxy: boolean;
  /** Plan 5.5 Task 1: opts into the dev-only `/faucet` route. This alone never enables it -- `startServer` also
   *  requires `chainId === 31337` and the RPC's `web3_clientVersion` to start with `anvil/`, checked once at
   *  startup, so a config carrying this by mistake on a real chain still serves 404 (Global Constraints). */
  devFaucet: boolean;
};

/** Anvil's chain id: the only chain where the development `audit` default is allowed. */
const ANVIL_CHAIN_ID = 31337;
const DEV_AUDIT = "unaudited (development build)";

// the daemons refuse funding deadlines further out than 7200s (maxFundingWindow); see hub.ts checkMatchParams
const MAX_FUNDING_WINDOW = 7200n;
const MIN_FUNDING_WINDOW = 60n;

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// Plan 5.6 Task 4 (spec §3): npm package-name syntax (lowercase, optionally `@scope/name`) and plain `x.y.z`
// semver. Duplicated from `packages/cli/src/version.ts`'s own `SEMVER`, not imported -- `@arena/cli` is only a
// devDependency of `@arena/server` (used in tests), so the server's runtime has no dependency on the CLI package.
const CLI_PACKAGE_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const CLI_SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** Orders two strings already matched against `CLI_SEMVER_RE`. */
function compareCliSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = CLI_SEMVER_RE.exec(a)!;
  const pb = CLI_SEMVER_RE.exec(b)!;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Thrown when a config field is missing or malformed; the message leads with the field name (e.g. `/hub/`). */
class FieldError extends Error {
  constructor(
    readonly field: string,
    detail: string,
  ) {
    super(`${field}: ${detail}`);
  }
}

function fail(field: string, detail: string): never {
  throw new FieldError(field, detail);
}

function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("config", "must be an object");
  return raw as Record<string, unknown>;
}

function str(obj: Record<string, unknown>, field: string, fallback?: string): string {
  const v = obj[field];
  if (v === undefined) {
    if (fallback === undefined) fail(field, "is required");
    return fallback;
  }
  if (typeof v !== "string") fail(field, "must be a string");
  return v;
}

function address(obj: Record<string, unknown>, field: string): Address {
  const v = obj[field];
  if (typeof v !== "string" || !ADDR_RE.test(v)) fail(field, "must be a 0x-prefixed 40-hex-char address");
  return v as Address;
}

/**
 * Fix round 1 (M3): `field` is the bare key looked up on `obj` (which may already be an unwrapped sub-object,
 * e.g. `defaultsRaw.deposit`, not `defaultsRaw["defaults.deposit"]` -- the latter never exists, so a dotted
 * `field` here silently always fell through to `fallback`). `displayName` (defaulting to `field`) is what
 * `fail()` names, so a caller whose `obj` is a sub-object can still pass the full dotted path for error
 * messages (e.g. `num(defaultsRaw, "deposit", 2000, "defaults.deposit")`).
 */
function num(obj: Record<string, unknown>, field: string, fallback?: number, displayName: string = field): number {
  const v = obj[field];
  if (v === undefined) {
    if (fallback === undefined) fail(displayName, "is required");
    return fallback;
  }
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  fail(displayName, "must be a number");
}

function bool(obj: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const v = obj[field];
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") fail(field, "must be true or false");
  return v;
}

/** Fix round 1 (M3): same `field`-vs-`displayName` split as `num()` above, and for the same reason. */
function bigint(obj: Record<string, unknown>, field: string, fallback: bigint, displayName: string = field): bigint {
  const v = obj[field];
  if (v === undefined) return fallback;
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?[0-9]+$/.test(v)) return BigInt(v);
  fail(displayName, "must be a decimal string or an integer number");
}

// these feed RateLimiter token buckets directly; zero or negative breaks refill math and makes take() nonsensical
const RATE_LIMIT_FIELDS: Array<keyof Limits> = [
  "httpPostBurst",
  "httpPostPerSec",
  "httpGetBurst",
  "httpGetPerSec",
  "wsFrameBurst",
  "wsFramePerSec",
];

function parseLimits(obj: Record<string, unknown>): Limits {
  const raw = obj.limits;
  if (raw === undefined) return { ...DEFAULT_LIMITS };
  const r = asRecord(raw);
  const out = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof Limits>) {
    out[key] = num(r, key, DEFAULT_LIMITS[key]);
  }
  for (const key of RATE_LIMIT_FIELDS) {
    if (!(out[key] > 0)) fail(`limits.${key}`, "must be positive");
  }
  return out;
}

/** Plan 5.6 Task 4 (spec §3): `cli`, or `undefined` when the config carries none. Each violation names the
 *  offending field (`cli.package`/`cli.version`/`cli.minVersion`). */
function parseCli(obj: Record<string, unknown>): CliConfig | undefined {
  const raw = obj.cli;
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("cli", "must be an object");
  const r = raw as Record<string, unknown>;

  const pkg = r.package;
  if (typeof pkg !== "string") fail("cli.package", "is required and must be a string");
  if (pkg.length > 214 || !CLI_PACKAGE_RE.test(pkg)) {
    fail("cli.package", "must be a valid npm package name (lowercase, optionally scoped as @scope/name), at most 214 characters");
  }

  const version = r.version;
  if (typeof version !== "string") fail("cli.version", "is required and must be a string");
  if (!CLI_SEMVER_RE.test(version)) fail("cli.version", "must be a plain x.y.z version");

  if (r.minVersion === undefined) return { package: pkg, version };
  const minVersion = r.minVersion;
  if (typeof minVersion !== "string") fail("cli.minVersion", "must be a string");
  if (!CLI_SEMVER_RE.test(minVersion)) fail("cli.minVersion", "must be a plain x.y.z version");
  if (compareCliSemver(minVersion, version) > 0) fail("cli.minVersion", `must be <= cli.version (${version})`);
  return { package: pkg, version, minVersion };
}

/** Plain-JSON config (bigints as decimal strings, optional fields defaulted); throws with the offending field name. */
export function parseServerConfig(raw: unknown): ServerConfig {
  const obj = asRecord(raw);

  const host = str(obj, "host", "127.0.0.1");
  const port = num(obj, "port", 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) fail("port", "must be an integer between 0 and 65535");
  const publicUrl = str(obj, "publicUrl", "");
  const rpcUrl = str(obj, "rpcUrl");
  const publicRpcUrl = str(obj, "publicRpcUrl", "");
  const chainId = num(obj, "chainId");

  const hub = address(obj, "hub");
  const usdc = address(obj, "usdc");
  const rules = address(obj, "rules");

  const dbPath = str(obj, "dbPath", ":memory:");

  const fundingWindow = bigint(obj, "fundingWindow", 3600n);
  if (fundingWindow < MIN_FUNDING_WINDOW || fundingWindow > MAX_FUNDING_WINDOW) {
    fail("fundingWindow", `must be between ${MIN_FUNDING_WINDOW} and ${MAX_FUNDING_WINDOW} seconds`);
  }

  const offerMaxLifetime = bigint(obj, "offerMaxLifetime", 86_400n);

  const defaultsRaw = obj.defaults === undefined ? {} : asRecord(obj.defaults);
  const defaults = {
    // Fix round 1 (M3): looked up by the bare key on `defaultsRaw` (already unwrapped); the dotted name is only
    // for the error message, via `bigint()`'s `displayName` parameter.
    deposit: bigint(defaultsRaw, "deposit", 1_000_000n, "defaults.deposit"),
    stakePerGame: bigint(defaultsRaw, "stakePerGame", 100_000n, "defaults.stakePerGame"),
    // Final review I4: daemons refuse a challengeTimeout under 900 s by default, so the published default matches.
    challengeTimeout: bigint(defaultsRaw, "challengeTimeout", 900n, "defaults.challengeTimeout"),
  };

  const cli = parseCli(obj);
  // Plan 5.6 Task 4 (spec §3): derived only when the raw config has no `cliCommand` key at all -- an explicit
  // `cliCommand` always wins over a configured `cli`, even an empty string (`obj.cliCommand !== undefined`, not
  // `str`'s own fallback, so this distinguishes "not given" from "given but falsy").
  const cliCommand = obj.cliCommand !== undefined ? str(obj, "cliCommand") : cli !== undefined ? `npx -y ${cli.package}@${cli.version}` : "arena";
  // Final review m21: `audit` is published in /templates. Outside a local Anvil chain it must be set, and must not be
  // the development default: the mainnet value states the truth (e.g. "unaudited; guarded launch, caps X/Y").
  const local = chainId === ANVIL_CHAIN_ID;
  const audit = str(obj, "audit", local ? DEV_AUDIT : undefined);
  if (!local && audit === DEV_AUDIT) fail("audit", `must describe this deployment, not the development default "${DEV_AUDIT}"`);

  const indexerRaw = obj.indexer === undefined ? {} : asRecord(obj.indexer);
  // Fix round 1 (M3): same bare-key-lookup/dotted-display split as `defaults` above.
  const indexer = {
    pollMs: num(indexerRaw, "pollMs", 2000, "indexer.pollMs"),
    chunkBlocks: num(indexerRaw, "chunkBlocks", 1000, "indexer.chunkBlocks"),
    startBlock: bigint(indexerRaw, "startBlock", 0n, "indexer.startBlock"),
  };

  const limits = parseLimits(obj);
  const trustProxy = bool(obj, "trustProxy", false);
  const devFaucet = bool(obj, "devFaucet", false);

  return {
    host, port, publicUrl, rpcUrl, publicRpcUrl, chainId, hub, usdc, rules, dbPath,
    fundingWindow, offerMaxLifetime, defaults, cliCommand, ...(cli !== undefined ? { cli } : {}), audit, indexer, limits, trustProxy, devFaucet,
  };
}
