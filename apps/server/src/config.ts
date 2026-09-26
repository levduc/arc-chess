import type { Address } from "viem";

export type Limits = {
  httpPostBurst: number; httpPostPerSec: number; httpGetBurst: number; httpGetPerSec: number;
  wsPerIp: number; wsFrameBurst: number; wsFramePerSec: number; maxFrameBytes: number;
  maxOpenOffersPerPlayer: number; maxWatchedOffers: number; maxJoinsPerConnection: number;
};

export const DEFAULT_LIMITS: Limits = {
  httpPostBurst: 30, httpPostPerSec: 1, httpGetBurst: 120, httpGetPerSec: 10,
  wsPerIp: 16, wsFrameBurst: 200, wsFramePerSec: 20, maxFrameBytes: 64 * 1024,
  maxOpenOffersPerPlayer: 5, maxWatchedOffers: 256, maxJoinsPerConnection: 64,
};

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
  audit: string;
  indexer: { pollMs: number; chunkBlocks: number; startBlock: bigint };
  limits: Limits;
};

// the daemons refuse funding deadlines further out than 7200s (maxFundingWindow); see hub.ts checkMatchParams
const MAX_FUNDING_WINDOW = 7200n;
const MIN_FUNDING_WINDOW = 60n;

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

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

function num(obj: Record<string, unknown>, field: string, fallback?: number): number {
  const v = obj[field];
  if (v === undefined) {
    if (fallback === undefined) fail(field, "is required");
    return fallback;
  }
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  fail(field, "must be a number");
}

function bigint(obj: Record<string, unknown>, field: string, fallback: bigint): bigint {
  const v = obj[field];
  if (v === undefined) return fallback;
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?[0-9]+$/.test(v)) return BigInt(v);
  fail(field, "must be a decimal string or an integer number");
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
    deposit: bigint(defaultsRaw, "defaults.deposit", 1_000_000n),
    stakePerGame: bigint(defaultsRaw, "defaults.stakePerGame", 100_000n),
    challengeTimeout: bigint(defaultsRaw, "defaults.challengeTimeout", 600n),
  };

  const cliCommand = str(obj, "cliCommand", "arena");
  const audit = str(obj, "audit", "unaudited (development build)");

  const indexerRaw = obj.indexer === undefined ? {} : asRecord(obj.indexer);
  const indexer = {
    pollMs: num(indexerRaw, "indexer.pollMs", 2000),
    chunkBlocks: num(indexerRaw, "indexer.chunkBlocks", 1000),
    startBlock: bigint(indexerRaw, "indexer.startBlock", 0n),
  };

  const limits = parseLimits(obj);

  return {
    host, port, publicUrl, rpcUrl, publicRpcUrl, chainId, hub, usdc, rules, dbPath,
    fundingWindow, offerMaxLifetime, defaults, cliCommand, audit, indexer, limits,
  };
}
