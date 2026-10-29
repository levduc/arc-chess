import { isIP } from "node:net";
import { basename, isAbsolute } from "node:path";
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

/** Remote agents (testnet): a CLI tarball this host serves itself, at `GET /cli/<basename of path>`, for a CLI that is
 *  not on npm. `path` is the file on this machine (read once at startup, which refuses to start unless its sha256 is
 *  `sha256`); `/templates` publishes its URL and `sha256`. The basename must change whenever the content does: `npx`
 *  reuses an earlier install of the same URL without looking at the new bytes. */
export type CliTarballConfig = { path: string; sha256: string };

/** Plan 5.7 Task 2 (spec §5): the same shape as the CLI's own `XmtpConfig` (packages/cli/src/config.ts), but
 *  defined locally -- `@arena/cli` is only a devDependency of `@arena/server` (used in tests), so the server's
 *  runtime has no dependency on the CLI package. `apiUrl` (tests, local node) and `gatewayHost` (dev and
 *  production, once fees are enforced -- the XMTP SDK accepts a gateway only for those two environments, which
 *  also lets the paid gateway be tested on XMTP's `dev` testnet) are both optional. */
export type XmtpConfig = { env: "local" | "dev" | "production"; apiUrl?: string; gatewayHost?: string };

export type ServerConfig = {
  host: string;
  /** Remote agents (testnet): more addresses to listen on, on the same port, besides `host` (an IP literal each). */
  extraHosts?: string[];
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
  /** Set only when this host serves the CLI tarball itself (see `CliTarballConfig`); needs `cli` and `publicUrl`. */
  cliTarball?: CliTarballConfig;
  /** Plan 5.7 Task 2 (spec §5): set only when this host publishes the XMTP fallback transport; published in
   *  `/templates` the same way. `init` copies it into the daemon's own `config.json`. */
  xmtp?: XmtpConfig;
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
/** Arc mainnet's chain id: XMTP must be its production network there, and the indexer must start at the hub's deploy
 *  block (final review C m-4, m-6). */
const ARC_MAINNET_CHAIN_ID = 5042;
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

// Remote agents: the tarball's file name and the URL it is served at. Both end up in a shell command (`cliCommand`, so
// skill.md), so only characters a shell never treats specially pass: no credentials, query, fragment, space, `$`,
// quote or `;`. The URL check is duplicated in packages/cli/src/version.ts (`TARBALL_URL`), not imported -- the
// server has no runtime dependency on the CLI package.
const CLI_TARBALL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/;
const CLI_TARBALL_URL_RE = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~-]+)*\.tgz$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** The URL a host serves its CLI tarball at: `<publicUrl>/cli/<basename of path>`. */
export function cliTarballUrl(publicUrl: string, tarball: CliTarballConfig): string {
  return `${publicUrl.replace(/\/$/, "")}/cli/${basename(tarball.path)}`;
}

/**
 * The command that runs the CLI from a tarball URL. `--package=<url> arena` installs that one file (the bundle has no
 * dependencies, so the registry is never asked) and runs its `arena` bin. `--prefer-offline`: once installed, npm
 * otherwise re-asks the host for the tarball on every command, and an unreachable host then costs about 70 s of
 * retries per command -- `daemon stop` and `withdraw` included. The URL names one content (its basename changes with
 * it), so the cached copy is never stale. The CLI bakes the same string in (`selfCommand`, packages/cli/src/version.ts).
 */
export function cliTarballCommand(url: string): string {
  return `npx -y --prefer-offline --package=${url} arena`;
}

/** Remote agents: `cliTarball`, or `undefined` when the config carries none. It needs `cli` (the package and version
 *  inside, which `init`'s version gate checks) and `publicUrl` (where agents fetch it from). */
function parseCliTarball(obj: Record<string, unknown>, cli: CliConfig | undefined, publicUrl: string): CliTarballConfig | undefined {
  const raw = obj.cliTarball;
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("cliTarball", "must be an object");
  const r = raw as Record<string, unknown>;
  const path = r.path;
  if (typeof path !== "string" || !isAbsolute(path)) fail("cliTarball.path", "must be an absolute path");
  if (!CLI_TARBALL_NAME_RE.test(basename(path))) fail("cliTarball.path", "must name a .tgz file of letters, digits, '.', '_' and '-' only");
  const sha256 = r.sha256;
  if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) fail("cliTarball.sha256", "must be 64 lowercase hex characters");
  if (cli === undefined) fail("cliTarball", "needs cli: the package name and version the tarball holds");
  if (publicUrl === "") fail("cliTarball", "needs publicUrl: the URL agents fetch it from");
  const tarball = { path, sha256 };
  if (!CLI_TARBALL_URL_RE.test(cliTarballUrl(publicUrl, tarball))) {
    fail("publicUrl", "must be a plain http(s) URL (no credentials, query or special characters) to serve cliTarball");
  }
  return tarball;
}

/** Remote agents: `extraHosts`, or `undefined`. Each an IP literal, none twice, none `host` itself. */
function parseExtraHosts(obj: Record<string, unknown>, host: string): string[] | undefined {
  const raw = obj.extraHosts;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) fail("extraHosts", "must be a list of IP addresses");
  const out: string[] = [];
  for (const h of raw) {
    if (typeof h !== "string" || isIP(h) === 0) fail("extraHosts", "must be a list of IP addresses");
    if (h === host || out.includes(h)) fail("extraHosts", `lists ${h} twice (host included)`);
    out.push(h);
  }
  return out;
}

const XMTP_ENVS = ["local", "dev", "production"] as const;
type XmtpEnv = (typeof XMTP_ENVS)[number];

function isXmtpEnv(v: unknown): v is XmtpEnv {
  return typeof v === "string" && (XMTP_ENVS as readonly string[]).includes(v);
}

/** Validates an `http(s)` URL carrying no embedded credentials (`user:pass@host`), naming `displayName` (defaulting
 *  to `field`) on failure -- same `field`-vs-`displayName` split as `num()`/`bigint()` above, since `obj` here is
 *  already the unwrapped `xmtp` sub-object. */
function httpUrl(obj: Record<string, unknown>, field: string, displayName: string = field): string {
  const v = obj[field];
  if (typeof v !== "string") fail(displayName, "must be a string");
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    fail(displayName, "must be a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") fail(displayName, "must be an http(s) URL");
  if (u.username !== "" || u.password !== "") fail(displayName, "must not contain credentials");
  return v;
}

/** Plan 5.7 Task 2 (spec §5): `xmtp`, or `undefined` when the config carries none. Each violation names the
 *  offending field (`xmtp.env`/`xmtp.apiUrl`/`xmtp.gatewayHost`). */
function parseXmtp(obj: Record<string, unknown>, chainId: number): XmtpConfig | undefined {
  const raw = obj.xmtp;
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("xmtp", "must be an object");
  const r = raw as Record<string, unknown>;

  const envRaw = r.env;
  if (!isXmtpEnv(envRaw)) fail("xmtp.env", `must be one of "local", "dev", "production"`);
  const env = envRaw;
  // Final review C m-6: on Arc mainnet, agents' fallback messages must go over XMTP's production network, never its
  // dev (test) network or a local node.
  if (chainId === ARC_MAINNET_CHAIN_ID && env !== "production") {
    fail("xmtp.env", `must be "production" on Arc mainnet (chainId ${ARC_MAINNET_CHAIN_ID}), not "${env}"`);
  }

  const apiUrl = r.apiUrl === undefined ? undefined : httpUrl(r, "apiUrl", "xmtp.apiUrl");
  const gatewayHost = r.gatewayHost === undefined ? undefined : httpUrl(r, "gatewayHost", "xmtp.gatewayHost");
  // Controller ruling (fix round 1): the XMTP SDK accepts a gateway only for "dev" and "production" -- "local"
  // is the only environment that refuses one, which also lets the paid gateway be tested on XMTP's dev testnet.
  if (gatewayHost !== undefined && env === "local") {
    fail("xmtp.gatewayHost", 'is not allowed with env: "local"');
  }

  return { env, ...(apiUrl !== undefined ? { apiUrl } : {}), ...(gatewayHost !== undefined ? { gatewayHost } : {}) };
}

/** Plain-JSON config (bigints as decimal strings, optional fields defaulted); throws with the offending field name. */
export function parseServerConfig(raw: unknown): ServerConfig {
  const obj = asRecord(raw);

  const host = str(obj, "host", "127.0.0.1");
  const extraHosts = parseExtraHosts(obj, host);
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
  const cliTarball = parseCliTarball(obj, cli, publicUrl);
  const xmtp = parseXmtp(obj, chainId);
  // Plan 5.6 Task 4 (spec §3): derived only when the raw config has no `cliCommand` key at all -- an explicit
  // `cliCommand` always wins over a configured `cli`, even an empty string (`obj.cliCommand !== undefined`, not
  // `str`'s own fallback, so this distinguishes "not given" from "given but falsy"). Remote agents: a tarball this
  // host serves wins over the npm pin, whose package may not be published at all.
  const cliCommand =
    obj.cliCommand !== undefined
      ? str(obj, "cliCommand")
      : cliTarball !== undefined
        ? cliTarballCommand(cliTarballUrl(publicUrl, cliTarball))
        : cli !== undefined
          ? `npx -y ${cli.package}@${cli.version}`
          : "arena";
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
  // Final review C m-4: from block 0, an indexer on Arc mainnet (millions of blocks, 1,000 per chunk, a rate-limited
  // RPC) takes days to catch up, and `/players` and `/api/channels` stay empty meanwhile.
  if (chainId === ARC_MAINNET_CHAIN_ID && !(indexer.startBlock > 0n)) {
    fail("indexer.startBlock", `is required on Arc mainnet (chainId ${ARC_MAINNET_CHAIN_ID}): set it to the hub's deploy block`);
  }

  const limits = parseLimits(obj);
  const trustProxy = bool(obj, "trustProxy", false);
  const devFaucet = bool(obj, "devFaucet", false);

  return {
    host, ...(extraHosts !== undefined ? { extraHosts } : {}), port, publicUrl, rpcUrl, publicRpcUrl, chainId, hub, usdc, rules, dbPath,
    fundingWindow, offerMaxLifetime, defaults, cliCommand, ...(cli !== undefined ? { cli } : {}),
    ...(cliTarball !== undefined ? { cliTarball } : {}),
    ...(xmtp !== undefined ? { xmtp } : {}), audit, indexer, limits, trustProxy, devFaucet,
  };
}
