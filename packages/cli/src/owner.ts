import { getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arenaPaths, loadConfig, loadWalletKey, type ArenaConfig } from "./config.js";
import { readJson, writeJsonAtomic } from "./jsonfile.js";
import { RecordStore } from "./records.js";

/**
 * Plan 5.6 Task 3 (spec §4.3): the owner lock.
 *
 * `owner` in `<home>/config.json` is the one address `arena withdraw` ever pays (the hub, through deposits, is
 * the only other place this wallet's USDC goes). The first set is free -- an agent can record the address its
 * human gives it. A change needs a human at a real terminal: stdin and stdout both a TTY, and the last 6
 * characters of the new address typed at a prompt. No daemon API route reads a new owner from a request, and
 * re-running `init` keeps the recorded one.
 *
 * Honesty note (spec §4.3): this stops a confused or prompt-injected agent from redirecting funds through the CLI.
 * It is no defence against code that can read `wallet.json` (or write `config.json`) itself; Plan 6's Circle
 * wallets address that.
 */

/** A malformed command line (exit 2, with the usage text). Lives here, not in `cli.ts`, so `validateOwner` can
 *  throw it without `owner.ts` importing `cli.ts` (which imports this module). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** The exact prompt a human answers to confirm an owner change (Task 3 brief). */
export const OWNER_CONFIRM_PROMPT = "Type the last 6 characters of the new owner address to confirm: ";

/** What the owner rules need from the CLI's I/O -- a structural subset of `CliIo`, so this module never imports
 *  `cli.ts`. Missing TTY flags count as false: only a caller that positively knows it is at a terminal says so. */
export type OwnerIo = {
  err(s: string): void;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  prompt?(question: string): Promise<string>;
};

/** The error `withdraw` gives (CLI and daemon alike) when no owner is recorded. One line, naming `owner set`. */
export function noOwnerMessage(cmd = "arena"): string {
  return (
    "no owner is set, so a withdraw has nowhere to go: ask your human for the address to return funds to, then run " +
    `"${cmd} owner set <address>"`
  );
}

/**
 * Plan 5.6 Task 3 (spec §4.3): `addr` as a checksummed address, or a `UsageError` saying why it cannot be the
 * owner. It must be an EIP-55 checksummed or all-lowercase `0x` + 40 hex address (a mixed-case address whose
 * checksum does not match is a typo, not an address), never the zero address, and never one of `forbidden`
 * (compared case-insensitively): the wallet itself, the hub, the USDC token, the rules contract, and every session
 * key this home holds (`forbiddenOwners`).
 */
export function validateOwner(addr: string, forbidden: Address[]): Address {
  if (typeof addr !== "string" || !isAddress(addr, { strict: true })) {
    throw new UsageError(
      `the owner must be an EIP-55 checksummed or all-lowercase address (0x + 40 hex characters); got ${JSON.stringify(String(addr)).slice(0, 60)}`,
    );
  }
  const owner = getAddress(addr);
  if (owner === zeroAddress) throw new UsageError("the owner cannot be the zero address");
  if (forbidden.some((f) => f.toLowerCase() === owner.toLowerCase())) {
    throw new UsageError(
      `the owner cannot be ${owner}: it is this wallet, the hub, the USDC token, the rules contract or one of this ` +
        "home's session keys -- the owner must be the human's own address",
    );
  }
  return owner;
}

/** The address of every session key this home holds -- channel records and offer records alike (an offer's key
 *  becomes its channel's key). A key that does not parse is skipped: it cannot be anyone's address. */
export function sessionKeyAddresses(home: string): Address[] {
  const records = new RecordStore(home);
  const keys: Hex[] = [...records.channels().map((r) => r.sessionKey), ...records.offers().map((r) => r.sessionKey)];
  const out: Address[] = [];
  for (const key of keys) {
    try {
      out.push(privateKeyToAccount(key).address);
    } catch {
      // not a key at all: nothing to forbid
    }
  }
  return out;
}

/** Every address the owner must never be, besides the zero address (`validateOwner` always refuses that). */
export function forbiddenOwners(home: string, cfg: Pick<ArenaConfig, "hub" | "usdc" | "rules">, wallet: Address): Address[] {
  return [wallet, cfg.hub, cfg.usdc, cfg.rules, ...sessionKeyAddresses(home)];
}

/**
 * Reads the `owner` currently recorded in `<home>/config.json`: `null` when there is no config or no owner in it,
 * otherwise the raw value as a string (any non-null value counts as "set", even a junk one -- so it can only be
 * replaced through the change rule). Throws if config.json exists but cannot be read: a caller about to rewrite
 * config.json must not take "unreadable" for "no owner" and silently drop the lock.
 */
export function readRecordedOwner(home: string): string | null {
  const path = arenaPaths(home).config;
  let cfg: { owner?: unknown } | null;
  try {
    cfg = readJson<{ owner?: unknown }>(path);
  } catch (err) {
    throw new Error(
      `cannot read ${path} (${err instanceof Error ? err.message.split("\n")[0] : String(err)}), so cannot tell whether an ` +
        "owner is recorded in it: fix or remove it first",
    );
  }
  const raw = cfg?.owner;
  if (raw === undefined || raw === null) return null;
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

/**
 * The owner rules (spec §4.3), shared by `owner set` and `init --owner`: the owner to record for `requested`,
 * given the `current` one (null if none). Every refusal is a plain `Error` (exit 1, never the usage error's 2):
 * - an invalid or forbidden address is refused;
 * - **first set** (`current` null): allowed, TTY or not;
 * - the **same** address again (case-insensitive): a no-op, `changed: false`, no TTY needed;
 * - a **change**: only with stdin and stdout both a TTY and a prompt to ask with, and only once the human types the
 *   new address's last 6 characters (case-insensitive, surrounding whitespace ignored). Otherwise refused with
 *   "the owner is already set; ask your human to run `<cmd> owner set <address>` in their own terminal".
 */
export async function decideOwner(
  current: string | null,
  requested: string,
  forbidden: Address[],
  io: OwnerIo,
  cmd: string,
): Promise<{ owner: Address; changed: boolean }> {
  let owner: Address;
  try {
    owner = validateOwner(requested, forbidden);
  } catch (err) {
    // A refused owner is a refusal (exit 1), not a malformed command line (exit 2): the brief pins exit 1.
    if (err instanceof UsageError) throw new Error(err.message);
    throw err;
  }
  if (current === null) return { owner, changed: true };
  if (current.toLowerCase() === owner.toLowerCase()) return { owner, changed: false };
  if (io.stdinIsTTY !== true || io.stdoutIsTTY !== true || typeof io.prompt !== "function") {
    throw new Error(`the owner is already set; ask your human to run \`${cmd} owner set ${owner}\` in their own terminal`);
  }
  io.err(`changing the owner from ${current} to ${owner}`);
  const typed = await io.prompt(OWNER_CONFIRM_PROMPT);
  if (typeof typed !== "string" || typed.trim().toLowerCase() !== owner.slice(-6).toLowerCase()) {
    throw new Error(`that is not the last 6 characters of ${owner}: the owner is unchanged (still ${current})`);
  }
  return { owner, changed: true };
}

/**
 * `arena owner set <addr>` (spec §4.3): applies `decideOwner` against this home's config.json, wallet and session
 * keys, and records the result (only `owner` changes; every other config field is written back as read). A
 * running daemon needs no restart: it re-reads `owner` from config.json on every withdraw.
 */
export async function setOwner(home: string, addr: string, io: OwnerIo, cmd: string): Promise<void> {
  const cfg = loadConfig(home);
  const wallet = privateKeyToAccount(loadWalletKey(home)).address;
  const current = readRecordedOwner(home);
  const { owner, changed } = await decideOwner(current, addr, forbiddenOwners(home, cfg, wallet), io, cmd);
  if (!changed) return;
  // Re-read right before writing, so the write-back carries config.json as it is now, not as it was before the
  // (possibly slow, human-paced) prompt above -- and refuse if the owner itself moved in the meantime, since the
  // rule above was decided against the old one.
  if (readRecordedOwner(home) !== current) throw new Error("the owner changed while this command was running: run it again");
  writeJsonAtomic(arenaPaths(home).config, { ...loadConfig(home), owner });
}
