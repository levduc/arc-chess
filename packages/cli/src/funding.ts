import type { Address } from "viem";

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

const short = (have: bigint, need: bigint): Amounts => ({ have, need, shortfall: need > have ? need - have : 0n });

/** Plan 5.6 Task 2 (spec §4.1): works out what `arena fund` should ask the human for -- a pure function of the
 *  chain's current numbers, so it is unit-testable with no RPC at all. `deposit` defaults to `min(games x stake,
 *  cap)`; an explicit one must still fall inside `[stake, cap]`. */
export function computeFundingNeed(i: FundingInput): FundingNeed {
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
  return {
    deposit,
    feePerPlayer: i.feePerPlayer,
    usdc: short(i.usdcHave, deposit + i.feePerPlayer),
    native: short(i.nativeHave, i.sessionGasWei + FUND_TX_GAS_UNITS * i.feeCeilingWei),
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
  n: FundingNeed,
  ctx: { address: Address; chainId: number; ownerSet: boolean; games: bigint; stake: bigint },
): string {
  const usdcShort = n.usdc.shortfall > 0n;
  const nativeShort = n.native.shortfall > 0n;
  let body: string;
  if (usdcShort || nativeShort) {
    const parts: string[] = [];
    if (usdcShort) parts.push(`${formatUsdc6(n.usdc.shortfall)} USDC`);
    if (nativeShort) parts.push(`${formatNativeCeil4(n.native.shortfall)} native gas`);
    body = `Please send ${parts.join(" and ")} to ${ctx.address} on chain ${ctx.chainId}.`;
  } else {
    body = `This wallet already holds enough to play ${ctx.games} games at ${formatUsdc6(ctx.stake)} USDC.`;
  }
  if (!ctx.ownerSet) {
    body += usdcShort || nativeShort ? " Also tell me the address to return winnings to." : " Tell me the address to return winnings to.";
  }
  return body;
}
