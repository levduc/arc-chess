import type { Address } from "viem";
import { weiToUsdc6Down, weiToUsdc6Up } from "./chains.js";

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
 *  `usdc` and there is no `native` at all. */
export type OneBalanceFundingNeed = { deposit: bigint; feePerPlayer: bigint; usdc: Amounts };

/** Plan 6: `computeOneBalanceFundingNeed`'s input -- `computeFundingNeed`'s, with the one native balance (wei, 18
 *  decimals) in place of the two balances. */
export type OneBalanceFundingInput = Omit<FundingInput, "usdcHave" | "nativeHave"> & { balanceWei: bigint };

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
 *  decimals rounded UP; `usdc.have` = the native balance converted rounded DOWN. */
export function computeOneBalanceFundingNeed(i: OneBalanceFundingInput): OneBalanceFundingNeed {
  const deposit = fundingDeposit(i);
  return {
    deposit,
    feePerPlayer: i.feePerPlayer,
    usdc: short(weiToUsdc6Down(i.balanceWei), deposit + i.feePerPlayer + weiToUsdc6Up(fundingGasWei(i))),
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

/** Plan 5.6 Task 2 (spec §4.1, Review Focus 1): the exact, ready-to-relay sentence `arena fund` prints. Every
 *  variant is pinned character for character in `funding.test.ts` -- a human sends the wrong amount, chain or
 *  token if this is ever ambiguous. Uses the **shortfall** (what is actually missing), not the full need. */
export function fundMessage(
  n: FundingNeed | OneBalanceFundingNeed,
  ctx: { address: Address; chainId: number; ownerSet: boolean; games: bigint; stake: bigint },
): string {
  const usdcShort = n.usdc.shortfall > 0n;
  // Plan 6: a one-balance need has no `native`: the sentence then names USDC only.
  const nativeShort = "native" in n && n.native.shortfall > 0n;
  let body: string;
  if (usdcShort || nativeShort) {
    const parts: string[] = [];
    if (usdcShort) parts.push(`${formatUsdc6(n.usdc.shortfall)} USDC`);
    if (nativeShort && "native" in n) parts.push(`${formatNativeCeil4(n.native.shortfall)} native gas`);
    body = `Please send ${parts.join(" and ")} to ${ctx.address} on chain ${ctx.chainId}.`;
  } else {
    body = `This wallet already holds enough to play ${ctx.games} games at ${formatUsdc6(ctx.stake)} USDC.`;
  }
  if (!ctx.ownerSet) {
    body += usdcShort || nativeShort ? " Also tell me the address to return winnings to." : " Tell me the address to return winnings to.";
  }
  return body;
}
