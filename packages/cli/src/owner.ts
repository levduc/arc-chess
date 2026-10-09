import { createPublicClient, getAddress, http, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arenaPaths, loadConfig, loadWalletKey, type ArenaConfig } from "./config.js";
import { readJson, writeJsonAtomic } from "./jsonfile.js";
import { RecordStore } from "./records.js";

/**
 * Plan 5.6 Task 3 (spec §4.3): the owner lock.
 *
 * `owner` in `<home>/config.json` is the one address `arena withdraw` ever pays (the hub, through deposits, is
 * the only other place this wallet's USDC goes). The first set is free -- an agent can record the address its
 * human gives it. A change needs the **current owner's signature** (EIP-191 `personal_sign`) over
 * `ownerChangeMessage`, which binds the wallet, the chain, both owners and `ownerNonce` -- something no agent can
 * produce. (Fix round 1, I2: the first design's interactive-terminal gate was faked by `script`/`unbuffer`/`expect`
 * in one shell line, so it was removed outright rather than kept as a fallback.) No daemon API route reads a new
 * owner from a request, and re-running `init` keeps the recorded owner and its nonce.
 *
 * Honesty note (spec §4.3): this stops a confused or prompt-injected agent from redirecting funds through the CLI
 * or the daemon API. It is no defence against code that can read `wallet.json` or edit `config.json` by hand --
 * which is also the only recovery when the owner cannot sign. Plan 6's Circle wallets address the key-file side.
 */

/** A malformed command line (exit 2, with the usage text). Lives here, not in `cli.ts`, so `validateOwner` can
 *  throw it without `owner.ts` importing `cli.ts` (which imports this module). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** What the owner rules need from the CLI's I/O -- a structural subset of `CliIo`, so this module never imports
 *  `cli.ts`. */
export type OwnerIo = {
  out(s: string): void;
  err(s: string): void;
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

/** `config.json`'s `ownerNonce`: 0 when absent; anything but a non-negative safe integer is refused (a junk nonce
 *  must never quietly become 0, which would re-open old signatures to replay). */
export function ownerNonceOf(cfg: { ownerNonce?: unknown }): number {
  const n = cfg.ownerNonce ?? 0;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    throw new Error(`config.json's ownerNonce is not a non-negative integer (${JSON.stringify(n)?.slice(0, 40)})`);
  }
  return n;
}

/**
 * Fix round 1 (I2, spec §4.3): the exact text the current owner signs (EIP-191 `personal_sign`) to approve an owner
 * change -- lines joined by `\n`, no trailing newline. It binds the wallet (so a signature for one home never works
 * on another), the chain, both owners and `ownerNonce` (which goes up by one on every change, so A→B→A can never be
 * replayed back to B).
 */
export function ownerChangeMessage(p: { wallet: Address; chainId: number; currentOwner: Address; newOwner: Address; nonce: number }): string {
  return [
    "arena owner change",
    `wallet: ${getAddress(p.wallet)}`,
    `chain: ${p.chainId}`,
    `current owner: ${getAddress(p.currentOwner)}`,
    `new owner: ${getAddress(p.newOwner)}`,
    `nonce: ${p.nonce}`,
  ].join("\n");
}

/** True if `signature` is `address`'s signature over `message`, checked with viem's `verifyMessage` over `rpcUrl`
 *  -- an EOA, an ERC-1271 contract wallet, or a counterfactual ERC-6492 one. Throws if it cannot tell (the RPC is
 *  down and the signature does not recover to the address either). */
export async function verifyOwnerSignature(rpcUrl: string, address: Address, message: string, signature: Hex): Promise<boolean> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return client.verifyMessage({ address, message, signature });
}

/**
 * The owner rules' first step (spec §4.3), shared by `owner set` and `init --owner`: validates `requested` (an
 * invalid or forbidden address is a plain `Error`, exit 1 -- a refusal, not the usage error's 2) and says what
 * recording it would be, given the `current` owner (null if none): a **first** set, the **same** owner again
 * (case-insensitive; a no-op), or a **change** -- which only `setOwner` can make, and only with a signature.
 */
export function classifyOwner(
  current: string | null,
  requested: string,
  forbidden: Address[],
): { owner: Address; kind: "first" | "same" | "change" } {
  let owner: Address;
  try {
    owner = validateOwner(requested, forbidden);
  } catch (err) {
    if (err instanceof UsageError) throw new Error(err.message);
    throw err;
  }
  if (current === null) return { owner, kind: "first" };
  return { owner, kind: current.toLowerCase() === owner.toLowerCase() ? "same" : "change" };
}

/**
 * `arena owner set <addr> [--signature 0x…]` (spec §4.3). A first set is recorded at once, and the same owner again
 * is a no-op. A change is recorded only with `signature`: the current owner's EIP-191 signature over
 * `ownerChangeMessage(wallet, chain, current, new, ownerNonce)`, verified over `cfg.rpcUrl`; it then records the
 * new owner and `ownerNonce + 1`. Without `signature`, it prints `{messageToSign, signer, command}` on stdout --
 * `command` built from `cmd` (Task 4 passes the pinned `npx` form) -- and refuses (exit 1). A malformed or wrong
 * signature is refused too, and the owner and nonce stay as they were. Only `owner` and `ownerNonce` change; every
 * other config field is written back as read. A running daemon needs no restart: it re-reads `owner` on every
 * withdraw.
 */
export async function setOwner(home: string, addr: string, io: OwnerIo, cmd: string, signature?: string): Promise<void> {
  const cfg = loadConfig(home);
  const wallet = privateKeyToAccount(loadWalletKey(home)).address;
  const current = readRecordedOwner(home);
  const { owner, kind } = classifyOwner(current, addr, forbiddenOwners(home, cfg, wallet));
  const path = arenaPaths(home).config;
  if (kind === "same") return;
  if (kind === "first") {
    writeJsonAtomic(path, { ...cfg, owner });
    return;
  }
  // A change. `current` is non-null here; if it is not an address at all, nobody can sign for it.
  if (current === null || !isAddress(current, { strict: false })) {
    throw new Error(
      `the recorded owner ${JSON.stringify(current)?.slice(0, 60)} is not an address, so nobody can sign a change: only a hand edit of ${path} can fix it`,
    );
  }
  const currentOwner = getAddress(current);
  const nonce = ownerNonceOf(cfg);
  const message = ownerChangeMessage({ wallet, chainId: cfg.chainId, currentOwner, newOwner: owner, nonce });
  if (signature === undefined) {
    io.out(JSON.stringify({ messageToSign: message, signer: currentOwner, command: `${cmd} owner set ${owner} --signature <signature>` }, null, 2));
    throw new Error(
      `the owner is already set to ${currentOwner}: changing it needs that owner's signature. Ask your human to sign ` +
        "messageToSign (printed above) with the current owner's wallet (EIP-191 personal_sign), then run the command with it",
    );
  }
  if (!/^0x([0-9a-fA-F]{2})+$/.test(signature)) {
    throw new Error("--signature must be the 0x-prefixed hex signature; the owner is unchanged");
  }
  let valid: boolean;
  try {
    valid = await verifyOwnerSignature(cfg.rpcUrl, currentOwner, message, signature as Hex);
  } catch (err) {
    throw new Error(
      `could not verify the signature over ${cfg.rpcUrl} (${err instanceof Error ? err.message.split("\n")[0] : String(err)}); the owner is unchanged`,
    );
  }
  if (!valid) {
    throw new Error(
      `that is not ${currentOwner}'s signature over this change (nonce ${nonce}): the owner is unchanged. Run ` +
        `"${cmd} owner set ${owner}" without --signature for the exact message to sign`,
    );
  }
  // Re-read right before writing: the write-back carries config.json as it is now, and the change is refused if
  // the owner or nonce moved while the signature was being checked (it was verified against the old ones).
  const now = loadConfig(home);
  if (readRecordedOwner(home) !== current || ownerNonceOf(now) !== nonce) {
    throw new Error("the owner changed while this command was running: run it again");
  }
  writeJsonAtomic(path, { ...now, owner, ownerNonce: nonce + 1 });
}
