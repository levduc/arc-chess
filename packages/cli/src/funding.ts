import type { Address } from "viem";
import { chainProfile, weiToUsdc6Down, weiToUsdc6Up } from "./chains.js";

/** Plan 5.6 Task 2 (spec §4.1): one channel's dispute-gas reserve plus the gas of the approve/deposit/close
 *  transactions a fund-then-play run makes -- the unit `native.need` is budgeted in, alongside the session key's
 *  own `sessionGasWei`. */
export const FUND_TX_GAS_UNITS = 500_000n;

export type FundingInput = {
  games: bigint;
  stake: bigint;
  deposit?: bigint;
  cap: bigint;
  feePerPlayer: bigint;
  sessionGasWei: bigint;
  feeCeilingWei: bigint;
  usdcHave: bigint;
  nativeHave: bigint;
};

export type Amounts = { have: bigint; need: bigint; shortfall: bigint };

export type FundingNeed = { deposit: bigint; feePerPlayer: bigint; usdc: Amounts; native: Amounts };

/** Plan 6 (spec §2.1): the need on a chain whose gas is USDC (`nativeIsUsdc`): one balance, so the gas is folded into
 *  `usdc` and there is no `native` at all. Fix round 1 (I-5): `usdc.reserved` is the part of `usdc.need` that stays
 *  in the wallet as the gas reserve of the home's other unsettled channels (0 with none). */
export type OneBalanceFundingNeed = { deposit: bigint; feePerPlayer: bigint; usdc: Amounts & { reserved: bigint } };

/** Plan 6: `computeOneBalanceFundingNeed`'s input -- `computeFundingNeed`'s, with the one native balance (wei, 18
 *  decimals) in place of the two balances. Fix round 1 (I-5): `unsettledChannels` is how many channels the home
 *  already has that are not finalized (default 0); each keeps one `sessionGasWei` of reserve. */
export type OneBalanceFundingInput = Omit<FundingInput, "usdcHave" | "nativeHave"> & { balanceWei: bigint; unsettledChannels?: number };

/**
 * Plan 6 fix round 1 (spec §2.1 as amended, audit-daemon I-5): on a `nativeIsUsdc` chain, the one balance (micro-USDC)
 * that opening -- or funding -- one more channel needs, so that it never spends a live channel's refill money:
 *   deposit + fee + ceil((ownGasWei + otherChannels x sessionGasWei + FUND_TX_GAS_UNITS x feeCeilingWei) / 10^12).
 * `ownGasWei` is the session gas this channel still has to receive (a whole `sessionGasWei` before its top-up). The
 * last two terms are `withdrawReserve` of the other channels; the gas is rounded up once, as a sum, so `arena fund`
 * and the daemon's gates agree to the micro-USDC.
 * Live run #2 (f)1: `paidWei` is the gas this channel's own funding transactions already paid (a pass resumed after
 * its approve and top-up), at most `FUND_TX_GAS_UNITS x feeCeilingWei`, the term it came out of. It is rounded UP
 * and taken off separately: on Arc the balance is the native one rounded down, so a wallet that held exactly the
 * first pass's need, less that gas, still meets the resumed need to the micro-USDC.
 */
export function oneBalanceOpenNeed(i: {
  deposit: bigint;
  feePerPlayer: bigint;
  ownGasWei: bigint;
  otherChannels: number;
  sessionGasWei: bigint;
  feeCeilingWei: bigint;
  paidWei?: bigint;
}): bigint {
  if (i.otherChannels < 0 || !Number.isInteger(i.otherChannels)) throw new RangeError("otherChannels must be a non-negative integer");
  const ownTxWei = FUND_TX_GAS_UNITS * i.feeCeilingWei;
  const gasWei = i.ownGasWei + BigInt(i.otherChannels) * i.sessionGasWei + ownTxWei;
  const paid = i.paidWei === undefined || i.paidWei <= 0n ? 0n : i.paidWei < ownTxWei ? i.paidWei : ownTxWei;
  return i.deposit + i.feePerPlayer + weiToUsdc6Up(gasWei) - weiToUsdc6Up(paid);
}

const short = (have: bigint, need: bigint): Amounts => ({ have, need, shortfall: need > have ? need - have : 0n });

/** The deposit `fund` sizes for: `min(games x stake, cap)` by default; an explicit one must fall inside `[stake, cap]`. */
function fundingDeposit(i: Pick<FundingInput, "games" | "stake" | "deposit" | "cap">): bigint {
  if (i.games <= 0n || i.stake <= 0n) throw new RangeError("games and stake must be positive");
  const max = i.games * i.stake;
  const deposit = i.deposit ?? (max < i.cap ? max : i.cap);
  // Final fix wave (I2): every amount in this message is whole USDC, like `fund`'s flags and output -- the cap used to
  // print in base units ("(100000000)"), which looked larger than the whole-USDC deposit it was compared with.
  if (deposit < i.stake || deposit > i.cap) {
    throw new RangeError(
      `deposit must be between the stake and the cap: ${formatUsdc6(i.stake)} to ${formatUsdc6(i.cap)} USDC (asked for ${formatUsdc6(deposit)} USDC)`,
    );
  }
  return deposit;
}

/** The gas `fund` budgets for, in native wei: the session key's `sessionGasWei`, plus the wallet's own transactions. */
function fundingGasWei(i: Pick<FundingInput, "sessionGasWei" | "feeCeilingWei">): bigint {
  return i.sessionGasWei + FUND_TX_GAS_UNITS * i.feeCeilingWei;
}

/** Plan 5.6 Task 2 (spec §4.1): works out what `arena fund` should ask the human for -- a pure function of the
 *  chain's current numbers, so it is unit-testable with no RPC at all. `deposit` defaults to `min(games x stake,
 *  cap)`; an explicit one must still fall inside `[stake, cap]`. For a chain whose native gas is a separate asset;
 *  see `computeOneBalanceFundingNeed` for one whose gas is USDC. */
export function computeFundingNeed(i: FundingInput): FundingNeed {
  const deposit = fundingDeposit(i);
  return {
    deposit,
    feePerPlayer: i.feePerPlayer,
    usdc: short(i.usdcHave, deposit + i.feePerPlayer),
    native: short(i.nativeHave, fundingGasWei(i)),
  };
}

/** Plan 6 (spec §2.1, Review Focus 1): `computeFundingNeed` on a `nativeIsUsdc` chain, where USDC and gas are one
 *  balance -- never asked for as two assets. `usdc.need` = deposit + fee + the gas budget converted from 18 to 6
 *  decimals rounded UP; `usdc.have` = the native balance converted rounded DOWN.
 *  Fix round 1 (I-5): `usdc.need` also holds one `sessionGasWei` of reserve per unsettled channel the home already
 *  has (`oneBalanceOpenNeed`, the daemon's own opening gate), shown as `usdc.reserved`. `usdc.have` stays the wallet's
 *  whole balance, the same figure `wallet` prints. */
export function computeOneBalanceFundingNeed(i: OneBalanceFundingInput): OneBalanceFundingNeed {
  const deposit = fundingDeposit(i);
  const open = (otherChannels: number) =>
    oneBalanceOpenNeed({ deposit, feePerPlayer: i.feePerPlayer, ownGasWei: i.sessionGasWei, otherChannels, sessionGasWei: i.sessionGasWei, feeCeilingWei: i.feeCeilingWei });
  const need = open(i.unsettledChannels ?? 0);
  return {
    deposit,
    feePerPlayer: i.feePerPlayer,
    usdc: { ...short(weiToUsdc6Down(i.balanceWei), need), reserved: need - open(0) },
  };
}

/** USDC amounts always print with exactly 6 decimal places (e.g. `100.000000`), unlike `formatUnits`, which
 *  trims trailing zeros -- a fixed width makes balances easy to compare at a glance. Moved here from `cli.ts`
 *  (Plan 5.6 Task 2) so `fund`'s own formatting has no dependency the other way. */
export function formatUsdc6(amount: bigint): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(7, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -6) || "0"}.${digits.slice(-6)}`;
}

const NATIVE_CEIL4_UNIT = 10n ** 14n; // 1 ether / 10_000: the size of one 4-decimal-place tick.

/** Plan 5.6 Task 2 (spec §4.1, Review Focus 1): the native amount in `fund`'s human `message`, rounded *up* to
 *  4 decimal places so the sentence never asks for less than is actually needed, with trailing zeros trimmed
 *  (`"0.84"`, not `"0.8400"`). Every other native amount in this CLI stays exact (`formatNativeBalance`); only
 *  the message uses this rounded form. */
export function formatNativeCeil4(wei: bigint): string {
  const ticks = (wei + NATIVE_CEIL4_UNIT - 1n) / NATIVE_CEIL4_UNIT; // ceiling division; exact multiples stay exact.
  const whole = ticks / 10_000n;
  const frac = ticks % 10_000n;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(4, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

/** Plan 6 hardening H2 (audit-journey C-1): how a human gets USDC onto each built-in network, from
 *  `docs/superpowers/arc-facts.md`. Mainnet has no faucet; testnet has only Circle's. A profile chain missing here
 *  still gets the wrong-network warning, just no route. */
const USDC_ROUTES: Record<number, string> = {
  5042: "To get USDC onto Arc, use Circle's CCTP bridge from another chain, or an exchange or wallet that supports Arc.",
  5042002: "Arc Testnet's USDC comes from Circle's faucet (https://faucet.circle.com).",
};

/** Plan 6 hardening H2 (audit-journey C-2): the cash-out address a human must give on a chain with a built-in profile
 *  -- one they control on that network. `withdraw` pays it there only, in one irreversible transfer: an exchange
 *  deposit address that does not credit that network, or a smart wallet deployed only on another chain, loses it. */
export function ownerAddressAsk(networkName: string): string {
  return (
    `an address you control on ${networkName} to return winnings to (not an exchange deposit address unless that ` +
    `exchange supports USDC deposits on ${networkName}, and not a smart wallet deployed only on another chain)`
  );
}

/** Plan 5.6 Task 2 (spec §4.1, Review Focus 1): the exact, ready-to-relay sentence `arena fund` prints. Every
 *  variant is pinned character for character in `funding.test.ts` -- a human sends the wrong amount, chain or
 *  token if this is ever ambiguous. Uses the **shortfall** (what is actually missing), not the full need.
 *  Plan 6 hardening H2 (audit-journey C-1, C-2): on a chain with a built-in profile (Arc), the message names the
 *  network, warns that USDC sent on any other network never arrives, says how to get USDC onto it, and asks for an
 *  owner address the human controls on it. Every other chain keeps the text it had, byte for byte. */
export function fundMessage(
  n: FundingNeed | OneBalanceFundingNeed,
  ctx: { address: Address; chainId: number; ownerSet: boolean; games: bigint; stake: bigint },
): string {
  const usdcShort = n.usdc.shortfall > 0n;
  // Plan 6: a one-balance need has no `native`: the sentence then names USDC only.
  const nativeShort = "native" in n && n.native.shortfall > 0n;
  const profile = chainProfile(ctx.chainId);
  let body: string;
  if (usdcShort || nativeShort) {
    const parts: string[] = [];
    if (usdcShort) parts.push(`${formatUsdc6(n.usdc.shortfall)} USDC`);
    if (nativeShort && "native" in n) parts.push(`${formatNativeCeil4(n.native.shortfall)} native gas`);
    if (profile === undefined) {
      body = `Please send ${parts.join(" and ")} to ${ctx.address} on chain ${ctx.chainId}.`;
    } else {
      const name = profile.name;
      const route = USDC_ROUTES[ctx.chainId];
      body =
        `Please send ${parts.join(" and ")} to ${ctx.address} on ${name} (chain id ${ctx.chainId}), on the ${name} network ` +
        "only: USDC sent on Ethereum, Base or any other network will not arrive." +
        (route !== undefined ? ` ${route}` : "") +
        (profile.nativeIsUsdc ? ` Gas on ${name} is paid in USDC, so nothing else is needed.` : "");
    }
  } else {
    body = `This wallet already holds enough to play ${ctx.games} games at ${formatUsdc6(ctx.stake)} USDC.`;
  }
  if (!ctx.ownerSet) {
    const what = profile === undefined ? "the address to return winnings to" : ownerAddressAsk(profile.name);
    body += usdcShort || nativeShort ? ` Also tell me ${what}.` : ` Tell me ${what}.`;
  }
  return body;
}

/** H4 (live run friction 2): whether each built-in network is the real one or a test network, for the disclosure. */
const NETWORK_KINDS: Record<number, string> = {
  5042: "mainnet, real USDC",
  5042002: "a test network",
};

/** H4: the longest stretch of the host's `audit` text the disclosure quotes. */
const AUDIT_QUOTE_MAX = 300;

/**
 * Plan 6 hardening H4 (live run friction 2): what the human is about to fund, in a few sentences an agent can quote
 * before it asks for money -- the network, the hub, the host's own `audit` text from `/templates` (quoted as the
 * host's words, on one line and at most `AUDIT_QUOTE_MAX` characters), the per-player deposit cap and fee per channel,
 * and that withdrawals go only to the owner. Pinned character for character in `funding.test.ts`.
 * Fix round 1 (M6): the cap is the host's figure (`/templates`), so it is said as the host's; the fee is read from the
 * hub. Unicode format characters (`\p{Cf}`: bidi overrides, zero-width joiners) are removed from the quote, so the host's
 * text cannot visually reorder the amount and address that follow it.
 */
export function fundDisclosure(ctx: { chainId: number; hub: Address; audit: string | undefined; cap: bigint; feePerPlayer: bigint; owner: Address | null }): string {
  const profile = chainProfile(ctx.chainId);
  const kind = NETWORK_KINDS[ctx.chainId];
  const network =
    profile === undefined ? `chain ${ctx.chainId}` : `${profile.name} (chain id ${ctx.chainId}${kind !== undefined ? `, ${kind}` : ""})`;
  const audit = ctx.audit?.replace(/\p{Cf}/gu, "").replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim();
  const quoted =
    audit === undefined || audit === ""
      ? "Its host publishes no audit statement."
      : `Its host says: "${audit.length > AUDIT_QUOTE_MAX ? `${audit.slice(0, AUDIT_QUOTE_MAX - 1)}…` : audit}".`;
  const to = ctx.owner === null ? "the owner address you give me" : `the recorded owner, ${ctx.owner}`;
  return (
    `What you are funding: chess games for USDC through the Agent Chess Arena hub ${ctx.hub} on ${network}. ${quoted} ` +
    `The host says each player may deposit at most ${formatUsdc6(ctx.cap)} USDC per channel. The hub charges a fee of ` +
    `${formatUsdc6(ctx.feePerPlayer)} USDC per player per channel, and withdrawals go only to ${to}.`
  );
}

/**
 * Plan 6 hardening H4 (live run friction 1): `fund`'s first field. In the first live run no agent put the ask in its
 * own reply: each ran `fund`, then went straight to `wallet --wait-for-usdc`, and a human sees only the agent's
 * reply, never a command's output. So the output leads with the instruction itself, then the words to relay: the
 * disclosure, then `message`. `waitFirst` (something is short) adds "before you run wallet --wait-for-usdc".
 */
export function tellYourHuman(disclosure: string, message: string, waitFirst: boolean): string {
  return (
    "Tell your human now, in your own reply, word for word" +
    (waitFirst ? ", before you run wallet --wait-for-usdc" : "") +
    ` (they cannot see this command's output): ${disclosure} ${message}`
  );
}
