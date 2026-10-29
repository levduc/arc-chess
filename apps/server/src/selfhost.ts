/**
 * Self-host (`deploy/host`): the host server as its Docker image runs it. The container builds its `ServerConfig` at
 * start from two inputs, never from a hand-written server.json:
 * - its environment (`deploy/host/.env`): the domain, the network, the RPC URLs, the CLI version to advertise and a
 *   few optional settings (`hostSettings`);
 * - the assets the image ships next to the bundle (`scripts/build-server.ts`): the CLI release it advertises by
 *   default, and, per network, the deployment it may serve -- only one that `contracts/deployments/<chainId>.json`
 *   records AND the CLI pins (`KNOWN_DEPLOYMENTS`), with its deploy block (`hostDeployments`).
 * Then it reads the hub's fee and limits for the `audit` text (`hostServerConfig`), and `parseServerConfig` and
 * `startServer` apply every check they apply to any other config (the RPC's chain id first).
 *
 * No key of any kind is read here, or anywhere in the server: the host holds no funds and signs nothing.
 */
import { formatUnits, type Address } from "viem";
import { DEFAULT_LIMITS, parseServerConfig, type Limits, type ServerConfig } from "./config.js";
import { RpcChainReader } from "./chain.js";
import { redactRpcUrls } from "./redact.js";
import { startServer } from "./server.js";

/** The networks a self-hosted host can serve, by the `NETWORK` value that names each. */
export const HOST_NETWORKS = {
  "arc-testnet": {
    chainId: 5042002,
    label: "Arc TESTNET",
    publicRpcUrl: "https://rpc.testnet.arc.io",
    money: "faucet USDC only",
    xmtpEnv: "dev",
  },
  "arc-mainnet": {
    chainId: 5042,
    label: "Arc mainnet",
    publicRpcUrl: "https://rpc.mainnet.arc.io",
    money: "real USDC",
    xmtpEnv: "production",
  },
} as const;

export type HostNetworkName = keyof typeof HOST_NETWORKS;

/** A deployment the image may serve: the pinned addresses and the hub's deploy block (decimal), where the indexer
 *  starts. */
export type HostDeployment = { hub: Address; rules: Address; usdc: Address; deployBlock: string };

/** `share/assets.json` in the image. `deployments` and `missing` are keyed by chain id (decimal); `missing` says why
 *  the image cannot serve a network. */
export type HostAssets = {
  cli: { package: string; version: string };
  deployments: Record<string, HostDeployment>;
  missing: Record<string, string>;
};

/** A setting the operator must fix; the message names the environment variable. */
export class HostConfigError extends Error {}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const NPM_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * Build time (`scripts/build-server.ts`): the deployments an image may serve, one per `HOST_NETWORKS` entry. A network
 * ships only when `readDeployment(chainId)` (the parsed `contracts/deployments/<chainId>.json`, or null when there is
 * none) AND `pins[chainId]` (the CLI's `KNOWN_DEPLOYMENTS`) both exist, and the file records a `deployBlock`;
 * otherwise `missing` says what is absent. A file and a pin that name different contracts, or a malformed
 * `deployBlock`, fail the build: agents' `init` refuses any hub but the pinned one.
 */
export function hostDeployments(o: {
  pins: Record<number, { hub?: string; rules?: string; usdc?: string }>;
  readDeployment: (chainId: number) => unknown;
}): { deployments: Record<string, HostDeployment>; missing: Record<string, string> } {
  const deployments: Record<string, HostDeployment> = {};
  const missing: Record<string, string> = {};
  for (const net of Object.values(HOST_NETWORKS)) {
    const id = net.chainId;
    const file = o.readDeployment(id);
    const pin = Object.hasOwn(o.pins, id) ? o.pins[id] : undefined;
    const absent = [
      ...(file === null || file === undefined ? [`contracts/deployments/${id}.json does not exist`] : []),
      ...(pin === undefined ? [`the CLI pins no deployment for chain ${id} (KNOWN_DEPLOYMENTS in packages/cli/src/config.ts)`] : []),
    ];
    if (absent.length > 0) {
      missing[String(id)] = absent.join("; ");
      continue;
    }
    const r = (typeof file === "object" ? file : {}) as Record<string, unknown>;
    const addr = (field: string): Address => {
      const v = r[field];
      if (typeof v !== "string" || !ADDRESS_RE.test(v)) throw new Error(`contracts/deployments/${id}.json: ${field} is not an address`);
      return v as Address;
    };
    const d = { hub: addr("channelHub"), rules: addr("chessRules"), usdc: addr("token") };
    for (const field of ["hub", "rules", "usdc"] as const) {
      const want = pin![field];
      if (want === undefined || want.toLowerCase() !== d[field].toLowerCase()) {
        throw new Error(`contracts/deployments/${id}.json's ${field} ${d[field]} is not the CLI's pinned ${field} ${String(want)}: every agent's init would refuse this host`);
      }
    }
    const block = r.deployBlock;
    if (block === undefined) {
      missing[String(id)] = `contracts/deployments/${id}.json records no deployBlock (the hub's deploy block, from its broadcast receipt)`;
      continue;
    }
    if (!((typeof block === "number" && Number.isSafeInteger(block) && block > 0) || (typeof block === "string" && /^[1-9][0-9]*$/.test(block)))) {
      throw new Error(`contracts/deployments/${id}.json: deployBlock must be a positive whole block number`);
    }
    deployments[String(id)] = { ...d, deployBlock: String(block) };
  }
  return { deployments, missing };
}

/** Everything `hostServerConfig` needs that does not come from the chain: the validated environment. */
export type HostSettings = {
  network: HostNetworkName;
  chainId: number;
  deployment: HostDeployment;
  publicUrl: string;
  rpcUrl: string;
  publicRpcUrl: string;
  cli: { package: string; version: string };
  operator: string;
  xmtp?: { env: "dev" | "production"; gatewayHost?: string };
  limits: Limits;
  indexer: { pollMs: number; chunkBlocks: number };
  trustProxy: boolean;
  port: number;
  dbPath: string;
  /** Not fatal, but worth a line in the log. */
  warnings: string[];
};

type Env = Record<string, string | undefined>;

/** `env[name]` trimmed, or undefined when unset or empty (compose passes an unset `${VAR}` as ""). */
function setting(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v === undefined || v === "" ? undefined : v;
}

function fail(detail: string): never {
  throw new HostConfigError(detail);
}

/** RFC 2606 / RFC 6761 names no real host has: example.com/.net/.org and the .test, .example and .invalid TLDs.
 *  (`localhost` stays allowed: the local e2e stack serves it.) */
function isReservedName(domain: string): boolean {
  return (
    ["example.com", "example.net", "example.org"].some((d) => domain === d || domain.endsWith(`.${d}`)) ||
    ["test", "example", "invalid"].some((tld) => domain === tld || domain.endsWith(`.${tld}`))
  );
}

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function httpUrl(name: string, raw: string, opts: { noCredentials?: boolean } = {}): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    fail(`${name} must be a URL, e.g. https://rpc.example.com`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") fail(`${name} must be an http(s) URL`);
  if (opts.noCredentials && (u.username !== "" || u.password !== "")) fail(`${name} must not contain a user name or password: it is published`);
  return u;
}

function positiveInt(name: string, raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) fail(`${name} must be a whole number from 1 to ${max}`);
  return Number(raw);
}

function parseLimitsSetting(raw: string | undefined): Limits {
  if (raw === undefined) return { ...DEFAULT_LIMITS };
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    fail(`SERVER_LIMITS must be a JSON object, e.g. {"maxOpenOffersPerIp": 10}`);
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) fail("SERVER_LIMITS must be a JSON object");
  const out = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(o)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, k)) fail(`SERVER_LIMITS: unknown limit ${JSON.stringify(k)} (known: ${Object.keys(DEFAULT_LIMITS).join(", ")})`);
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) fail(`SERVER_LIMITS: ${k} must be a positive whole number`);
    out[k as keyof Limits] = v;
  }
  return out;
}

/** Letters, digits, spaces and a little punctuation, at most 40: the operator's name is quoted in every agent's
 *  funding ask, whose quote of the `audit` text stops at 300 characters. */
const OPERATOR_RE = /^[\p{L}\p{N} .,'&@()_:/+-]{1,40}$/u;

/**
 * The validated environment, or a `HostConfigError` naming the variable to fix. Reads only `env` and `assets`:
 * - `DOMAIN` (required): the host name Caddy gets a certificate for. `PUBLIC_URL` (optional, default
 *   `https://<DOMAIN>`): what skill.md and /templates name; plain http only on loopback (the local test stack).
 * - `NETWORK`: `arc-testnet` (default) or `arc-mainnet`, which is refused until the image ships a pinned mainnet
 *   deployment (`assets.missing` says what is absent).
 * - `RPC_URL`: what the server reads the chain through, never published (it may carry a provider key). Default: the
 *   network's public RPC, which rate-limits per IP (a warning). `PUBLIC_RPC_URL`: what /templates hands every agent;
 *   default the network's public RPC, never `RPC_URL`.
 * - `ARENA_CLI_VERSION` (default `assets.cli.version`): the published CLI version skill.md and /templates pin.
 * - `HOST_OPERATOR`: who runs this host, quoted in the `audit` text. `XMTP` (`on`|`off`, default off),
 *   `XMTP_GATEWAY_HOST` (required on mainnet with XMTP on). `SERVER_LIMITS` (JSON overrides of the per-IP limits),
 *   `INDEXER_POLL_MS`, `INDEXER_CHUNK_BLOCKS`, `TRUST_PROXY` (`true` only behind the compose file's Caddy).
 */
export function hostSettings(env: Env, assets: HostAssets): HostSettings {
  const warnings: string[] = [];

  const networkRaw = setting(env, "NETWORK") ?? "arc-testnet";
  if (!Object.hasOwn(HOST_NETWORKS, networkRaw)) fail(`NETWORK must be "arc-testnet" or "arc-mainnet", not ${JSON.stringify(networkRaw).slice(0, 40)}`);
  const network = networkRaw as HostNetworkName;
  const net = HOST_NETWORKS[network];
  const id = String(net.chainId);
  const deployment = Object.hasOwn(assets.deployments, id) ? assets.deployments[id] : undefined;
  if (deployment === undefined) {
    fail(
      `NETWORK=${network}: this image cannot serve ${net.label} (chain ${id}) yet: ${assets.missing[id] ?? "it ships no deployment for it"}. ` +
        "Agents' CLI refuses a hub it does not pin, so a host can serve only a network whose deployment a release pins: use arc-testnet",
    );
  }

  const domainRaw = setting(env, "DOMAIN");
  if (domainRaw === undefined) fail("DOMAIN is required: the host name your DNS points at this machine, e.g. arena.example.org");
  const domain = domainRaw.toLowerCase();
  if (!HOSTNAME_RE.test(domain)) fail(`DOMAIN must be a bare host name (no https://, port or path), not ${JSON.stringify(domainRaw).slice(0, 80)}`);
  if (isReservedName(domain)) fail(`DOMAIN is ${domain}, a reserved example name: set it to your own host name in .env`);

  const publicRaw = setting(env, "PUBLIC_URL") ?? `https://${domain}`;
  const pub = httpUrl("PUBLIC_URL", publicRaw);
  if (pub.protocol === "http:" && !LOOPBACK_HOSTS.has(pub.hostname)) fail("PUBLIC_URL must be https (Caddy serves it); plain http is only for a loopback test stack");
  if (pub.username !== "" || pub.password !== "" || pub.search !== "" || pub.hash !== "" || pub.pathname !== "/") {
    fail("PUBLIC_URL must be a bare origin like https://arena.example.org (no path, query or credentials)");
  }
  const publicUrl = pub.origin;

  const rpcUrl = setting(env, "RPC_URL") ?? net.publicRpcUrl;
  if (httpUrl("RPC_URL", rpcUrl).href === new URL(net.publicRpcUrl).href) {
    warnings.push(
      `RPC_URL is ${net.label}'s public RPC (${net.publicRpcUrl}), which rate-limits per IP: the indexer and the lobby slow ` +
        "down under load. Set RPC_URL to a dedicated RPC (it is never published)",
    );
  }
  const publicRpcUrl = setting(env, "PUBLIC_RPC_URL") ?? net.publicRpcUrl;
  const pubRpc = httpUrl("PUBLIC_RPC_URL", publicRpcUrl, { noCredentials: true });
  // RPC_URL is the one place for a keyed URL; publishing it would hand the key to every agent.
  if (pubRpc.href === new URL(rpcUrl).href && pubRpc.href !== new URL(net.publicRpcUrl).href) {
    fail(
      "PUBLIC_RPC_URL is RPC_URL: it is published to every agent in /templates, and RPC_URL is where a keyed URL goes. " +
        "Leave PUBLIC_RPC_URL empty for the network's public RPC, or set it to an RPC without a key",
    );
  }
  if (pubRpc.pathname !== "/" || pubRpc.search !== "") {
    warnings.push("PUBLIC_RPC_URL has a path or query: it is published to every agent in /templates, so make sure it carries no API key");
  }

  const version = setting(env, "ARENA_CLI_VERSION") ?? assets.cli.version;
  if (!SEMVER_RE.test(version)) fail(`ARENA_CLI_VERSION must be a plain x.y.z version of ${assets.cli.package} on npm`);
  if (!NPM_NAME_RE.test(assets.cli.package)) fail(`the image's CLI package name ${JSON.stringify(assets.cli.package)} is not an npm package name (a build problem)`);

  const operator = setting(env, "HOST_OPERATOR") ?? "not named";
  if (!OPERATOR_RE.test(operator)) fail("HOST_OPERATOR must be at most 40 letters, digits, spaces and .,'&@()_:/+- characters");

  const xmtpRaw = (setting(env, "XMTP") ?? "off").toLowerCase();
  if (xmtpRaw !== "on" && xmtpRaw !== "off") fail(`XMTP must be "on" or "off"`);
  const gatewayRaw = setting(env, "XMTP_GATEWAY_HOST");
  let xmtp: HostSettings["xmtp"];
  if (xmtpRaw === "on") {
    if (gatewayRaw !== undefined) httpUrl("XMTP_GATEWAY_HOST", gatewayRaw, { noCredentials: true });
    if (net.xmtpEnv === "production" && gatewayRaw === undefined) {
      fail("XMTP=on on Arc mainnet needs XMTP_GATEWAY_HOST: XMTP's production network charges fees, paid through a gateway (deploy/xmtp-gateway)");
    }
    xmtp = { env: net.xmtpEnv, ...(gatewayRaw !== undefined ? { gatewayHost: gatewayRaw } : {}) };
  } else if (gatewayRaw !== undefined) {
    warnings.push("XMTP_GATEWAY_HOST is set but XMTP is off: it is ignored");
  }

  const trustRaw = (setting(env, "TRUST_PROXY") ?? "false").toLowerCase();
  if (trustRaw !== "true" && trustRaw !== "false") fail(`TRUST_PROXY must be "true" or "false"`);

  return {
    network,
    chainId: net.chainId,
    deployment,
    publicUrl,
    rpcUrl,
    publicRpcUrl,
    cli: { package: assets.cli.package, version },
    operator,
    ...(xmtp !== undefined ? { xmtp } : {}),
    limits: parseLimitsSetting(setting(env, "SERVER_LIMITS")),
    // 3 s and 10,000-block chunks: the Arc testnet rehearsal's indexer settings on the public RPC (its getLogs serves
    // 10,000 blocks), so a new host catches up from the deploy block in minutes, not hours.
    indexer: {
      pollMs: positiveInt("INDEXER_POLL_MS", setting(env, "INDEXER_POLL_MS"), 3_000, 600_000),
      chunkBlocks: positiveInt("INDEXER_CHUNK_BLOCKS", setting(env, "INDEXER_CHUNK_BLOCKS"), 10_000, 100_000),
    },
    trustProxy: trustRaw === "true",
    port: positiveInt("PORT", setting(env, "PORT"), 3000, 65_535),
    dbPath: setting(env, "DB_PATH") ?? "/data/arena.sqlite",
    warnings,
  };
}

/** What `hostMain` reads from the hub at start: the limits for the `audit` text, the fee for the log. */
export type HubFacts = { feePerPlayer: bigint; feeRecipient: Address; maxDepositPerPlayer: bigint; maxCommittedEscrow: bigint };

/** The `audit` text /templates publishes, which every agent's `fund` quotes to its human (at most 300 characters,
 *  after the hub, network, cap and fee it states itself): that the contracts are unaudited, who runs this host, the
 *  network, and that the hub is the shared one -- its fee goes to the hub's fee recipient whichever host matched the
 *  channel, and its limits (read at server start) are every host's. */
export function hostAudit(s: Pick<HostSettings, "network" | "operator">, hub: Pick<HubFacts, "maxDepositPerPlayer" | "maxCommittedEscrow">): string {
  const net = HOST_NETWORKS[s.network];
  const usdc = (v: bigint) => formatUnits(v, 6);
  return (
    `unaudited; self-hosted arena host, operator: ${s.operator}; ${net.label}, ${net.money}. Shared hub: its fee goes ` +
    `to the hub's fee recipient, not to this host, and its limits (${usdc(hub.maxDepositPerPlayer)} USDC deposit per ` +
    `player, ${usdc(hub.maxCommittedEscrow)} USDC total escrow) are the same on every host`
  );
}

/** The raw server config (as server.json would hold it) for `s`, with the hub's limits in its `audit`. */
export function hostServerConfig(s: HostSettings, hub: HubFacts): Record<string, unknown> {
  return {
    // Every interface of the container: Caddy reaches it over the compose network. No port of it is published.
    host: "0.0.0.0",
    port: s.port,
    publicUrl: s.publicUrl,
    rpcUrl: s.rpcUrl,
    publicRpcUrl: s.publicRpcUrl,
    chainId: s.chainId,
    hub: s.deployment.hub,
    usdc: s.deployment.usdc,
    rules: s.deployment.rules,
    dbPath: s.dbPath,
    cli: s.cli,
    ...(s.xmtp !== undefined ? { xmtp: s.xmtp } : {}),
    audit: hostAudit(s, hub),
    indexer: { ...s.indexer, startBlock: s.deployment.deployBlock },
    limits: s.limits,
    trustProxy: s.trustProxy,
    devFaucet: false,
  };
}

function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
}

/** Startup reads are retried this many times, the wait doubling from `STARTUP_RETRY_FIRST_MS`: a public RPC that
 *  rate-limits (HTTP 429, -32005) usually answers a few seconds later, and a refusal costs a container restart. */
const STARTUP_ATTEMPTS = 5;
const STARTUP_RETRY_FIRST_MS = 3_000;

async function withRetries<T>(what: string, fn: () => Promise<T>, onRetry: (line: string) => void): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= STARTUP_ATTEMPTS) throw err;
      const waitMs = STARTUP_RETRY_FIRST_MS * 2 ** (attempt - 1);
      onRetry(`${what} failed (attempt ${attempt} of ${STARTUP_ATTEMPTS}), retrying in ${waitMs / 1000}s: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/** `eth_chainId` of `url`, as a number. */
async function rpcChainId(url: string): Promise<number> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown };
  if (typeof body.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.result)) throw new Error("a malformed eth_chainId answer");
  return Number(BigInt(body.result));
}

/**
 * The image's entry point. `hostMain([], env, assets)` builds the config and runs the server until SIGTERM;
 * `hostMain(["print-config"], ...)` prints the config it would run (RPC URLs shown as their scheme and host) and exits.
 * Every error and log line goes through `redactRpcUrls`: a provider URL can carry an API key.
 */
export async function hostMain(argv: string[], env: Env, assets: HostAssets): Promise<number> {
  const mode = argv[0] ?? "serve";
  if (mode !== "serve" && mode !== "print-config") {
    log("error", `unknown command ${JSON.stringify(mode).slice(0, 40)}: the image runs "serve" (the default) or "print-config"`);
    return 2;
  }
  let s: HostSettings;
  try {
    s = hostSettings(env, assets);
  } catch (err) {
    if (!(err instanceof HostConfigError)) throw err;
    log("error", `refusing to start: ${err.message}`);
    return 1;
  }
  const redact = (text: string) => redactRpcUrls(text, s);
  const errText = (err: unknown) => redact(err instanceof Error ? err.message : String(err));
  for (const w of s.warnings) log("warn", w);

  // The chain id of both RPCs before anything else: a wrong RPC_URL would otherwise surface as a confusing hub read,
  // and a wrong PUBLIC_RPC_URL would be handed to every agent.
  const chain = new RpcChainReader({ rpcUrl: s.rpcUrl, chainId: s.chainId, hub: s.deployment.hub });
  for (const [name, url] of [["RPC_URL", s.rpcUrl], ["PUBLIC_RPC_URL", s.publicRpcUrl]] as const) {
    if (name === "PUBLIC_RPC_URL" && url === s.rpcUrl) continue;
    let got: number;
    try {
      got = await withRetries(`eth_chainId on ${name}`, () => (name === "RPC_URL" ? chain.chainId() : rpcChainId(url)), (l) => log("warn", redact(l)));
    } catch (err) {
      log("error", `refusing to start: cannot read eth_chainId from ${name} (${redact(url)}): ${errText(err)}. The RPC may be down or rate-limiting: the container restarts and retries`);
      return 1;
    }
    if (got !== s.chainId) {
      log("error", `refusing to start: ${name} (${redact(url)}) serves chain ${got}, but NETWORK=${s.network} is chain ${s.chainId}`);
      return 1;
    }
  }

  let hub: HubFacts;
  try {
    // One after the other, not at once: six calls in parallel are what trips a public RPC's per-IP limit.
    const fee = await withRetries("reading the hub's fee", () => chain.feeConfig(), (l) => log("warn", redact(l)));
    const limits = await withRetries("reading the hub's limits", () => chain.limits(), (l) => log("warn", redact(l)));
    hub = { ...fee, maxDepositPerPlayer: limits.maxDepositPerPlayer, maxCommittedEscrow: limits.maxCommittedEscrow };
  } catch (err) {
    log("error", `refusing to start: cannot read the hub ${s.deployment.hub}'s fee and limits: ${errText(err)}`);
    return 1;
  }

  let cfg: ServerConfig;
  try {
    cfg = parseServerConfig(hostServerConfig(s, hub));
  } catch (err) {
    log("error", `refusing to start: ${errText(err)}`);
    return 1;
  }

  if (mode === "print-config") {
    const shown = { ...cfg, rpcUrl: redact(cfg.rpcUrl), publicRpcUrl: cfg.publicRpcUrl };
    console.log(JSON.stringify(shown, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2));
    return 0;
  }

  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer(cfg, { chain });
  } catch (err) {
    log("error", `refusing to start: ${errText(err)}`);
    return 1;
  }
  log("info", "listening", {
    url: server.url,
    network: s.network,
    chainId: s.chainId,
    hub: s.deployment.hub,
    feePerPlayer: formatUnits(hub.feePerPlayer, 6),
    feeRecipient: hub.feeRecipient,
    cli: `${s.cli.package}@${s.cli.version}`,
    rpc: redact(s.rpcUrl),
    publicRpc: s.publicRpcUrl,
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log("info", "shutting down", { signal });
    try {
      await server.close();
      process.exit(0);
    } catch (err) {
      log("error", "shutdown failed", { error: errText(err) });
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  return 0;
}
