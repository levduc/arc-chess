import type { Address } from "viem";

/**
 * Plan 6 (spec §2): what this CLI knows about a chain, built in and keyed by chain id. It is never taken from the
 * host: `/templates` may name a chain, but never what that chain's USDC is, or whether its gas is USDC.
 * - `usdc`: the only USDC address `init` accepts on this chain.
 * - `nativeIsUsdc`: the native balance (18 decimals) and the ERC-20 USDC (6 decimals) are ONE balance, so gas is
 *   paid in USDC. `wallet`, `fund` and `withdraw` then count a single USDC amount.
 * - `minFeePerGas`: the base-fee floor; the mempool silently drops a transaction below it.
 * - `feeCeilingWei`: the default fee ceiling on this chain.
 */
export type ChainProfile = { name: string; usdc: Address; nativeIsUsdc: boolean; minFeePerGas: bigint; feeCeilingWei: bigint };
export const CHAIN_PROFILES: Record<number, ChainProfile> = {
  5042:    { name: "Arc",         usdc: "0x3600000000000000000000000000000000000000", nativeIsUsdc: true, minFeePerGas: 20_000_000_000n, feeCeilingWei: 40_000_000_000n },
  5042002: { name: "Arc Testnet", usdc: "0x3600000000000000000000000000000000000000", nativeIsUsdc: true, minFeePerGas: 20_000_000_000n, feeCeilingWei: 40_000_000_000n },
};

/** The built-in profile of `chainId`, or undefined for a chain without one (anvil 31337, and every chain today's
 *  behaviour applies to unchanged). Own keys only. */
export function chainProfile(chainId: number): ChainProfile | undefined {
  return Object.hasOwn(CHAIN_PROFILES, chainId) ? CHAIN_PROFILES[chainId] : undefined;
}

/** 10^12: native wei (18 decimals) per USDC base unit (6 decimals), on a `nativeIsUsdc` chain. */
export const WEI_PER_USDC_UNIT = 10n ** 12n;

/** A native (18-decimal) amount in USDC base units (6 decimals), rounded DOWN: what a balance can actually pay.
 *  The ERC-20 `balanceOf` truncates the same way. */
export function weiToUsdc6Down(wei: bigint): bigint {
  if (wei < 0n) throw new RangeError("a native amount cannot be negative");
  return wei / WEI_PER_USDC_UNIT;
}

/** A native (18-decimal) amount in USDC base units (6 decimals), rounded UP: what a need or a reserve must cover,
 *  so it is never short by a fraction of a micro-USDC. */
export function weiToUsdc6Up(wei: bigint): bigint {
  if (wei < 0n) throw new RangeError("a native amount cannot be negative");
  return (wei + WEI_PER_USDC_UNIT - 1n) / WEI_PER_USDC_UNIT;
}
