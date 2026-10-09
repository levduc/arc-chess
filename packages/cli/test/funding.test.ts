import { describe, expect, it } from "vitest";
import { computeFundingNeed, formatNativeCeil4, fundMessage, FUND_TX_GAS_UNITS, type FundingInput } from "../src/funding.js";

const ADDRESS = "0x00000000000000000000000000000000000000Aa" as const;
const CHAIN_ID = 31337;

const BASE: FundingInput = {
  games: 3n,
  stake: 1_000_000n,
  cap: 10_000_000n,
  feePerPlayer: 5_000n,
  sessionGasWei: 10_000_000_000_000_000n,
  feeCeilingWei: 100_000_000_000n,
  usdcHave: 0n,
  nativeHave: 0n,
};

describe("computeFundingNeed", () => {
  it("defaults deposit to min(games x stake, cap)", () => {
    expect(computeFundingNeed(BASE).deposit).toBe(3_000_000n); // 3 x 1_000_000 < cap
    expect(computeFundingNeed({ ...BASE, games: 20n }).deposit).toBe(10_000_000n); // 20 x 1_000_000 > cap
  });

  it("uses an explicit deposit within [stake, cap] as is", () => {
    expect(computeFundingNeed({ ...BASE, deposit: 2_000_000n }).deposit).toBe(2_000_000n);
    expect(computeFundingNeed({ ...BASE, deposit: BASE.stake }).deposit).toBe(BASE.stake);
    expect(computeFundingNeed({ ...BASE, deposit: BASE.cap }).deposit).toBe(BASE.cap);
  });

  it("throws RangeError for an explicit deposit below the stake or above the cap", () => {
    expect(() => computeFundingNeed({ ...BASE, deposit: BASE.stake - 1n })).toThrow(RangeError);
    expect(() => computeFundingNeed({ ...BASE, deposit: BASE.cap + 1n })).toThrow(RangeError);
  });

  it("usdc.need is deposit + feePerPlayer", () => {
    const n = computeFundingNeed(BASE);
    expect(n.usdc.need).toBe(n.deposit + BASE.feePerPlayer);
  });

  it("native.need is sessionGasWei + FUND_TX_GAS_UNITS x feeCeilingWei", () => {
    const n = computeFundingNeed(BASE);
    expect(n.native.need).toBe(BASE.sessionGasWei + FUND_TX_GAS_UNITS * BASE.feeCeilingWei);
  });

  it("shortfall is max(0, need - have) per asset", () => {
    const n = computeFundingNeed(BASE); // usdcHave = nativeHave = 0
    expect(n.usdc.shortfall).toBe(n.usdc.need);
    expect(n.native.shortfall).toBe(n.native.need);

    const covered = computeFundingNeed({ ...BASE, usdcHave: BASE.cap * 10n, nativeHave: BASE.sessionGasWei + FUND_TX_GAS_UNITS * BASE.feeCeilingWei + 1n });
    expect(covered.usdc.shortfall).toBe(0n);
    expect(covered.native.shortfall).toBe(0n);
  });

  it("throws RangeError when games or stake is <= 0", () => {
    expect(() => computeFundingNeed({ ...BASE, games: 0n })).toThrow(RangeError);
    expect(() => computeFundingNeed({ ...BASE, games: -1n })).toThrow(RangeError);
    expect(() => computeFundingNeed({ ...BASE, stake: 0n })).toThrow(RangeError);
    expect(() => computeFundingNeed({ ...BASE, stake: -1n })).toThrow(RangeError);
  });
});

describe("formatNativeCeil4", () => {
  it("rounds up to 4 decimal places and trims trailing zeros, never rounding down", () => {
    expect(formatNativeCeil4(840_000_000_000_000_000n)).toBe("0.84");
    expect(formatNativeCeil4(840_000_000_000_000_001n)).toBe("0.8401");
    expect(formatNativeCeil4(0n)).toBe("0");
    expect(formatNativeCeil4(10n ** 18n)).toBe("1");
  });
});

describe("fundMessage", () => {
  const stake10at1 = { games: 10n, stake: 1_000_000n };

  it("both short, owner unset", () => {
    const n = computeFundingNeed({ ...BASE, usdcHave: 0n, nativeHave: 0n });
    const withShort = { ...n, usdc: { ...n.usdc, shortfall: 10_010_000n }, native: { ...n.native, shortfall: 890_000_000_000_000_000n } };
    expect(fundMessage(withShort, { address: ADDRESS, chainId: CHAIN_ID, ownerSet: false, games: BASE.games, stake: BASE.stake })).toBe(
      "Please send 10.010000 USDC and 0.89 native gas to 0x00000000000000000000000000000000000000Aa on chain 31337. Also tell me the address to return winnings to.",
    );
  });

  it("only USDC short, owner set", () => {
    const n = computeFundingNeed(BASE);
    const withShort = { ...n, usdc: { ...n.usdc, shortfall: 10_010_000n }, native: { ...n.native, shortfall: 0n } };
    expect(fundMessage(withShort, { address: ADDRESS, chainId: CHAIN_ID, ownerSet: true, games: BASE.games, stake: BASE.stake })).toBe(
      "Please send 10.010000 USDC to 0x00000000000000000000000000000000000000Aa on chain 31337.",
    );
  });

  it("only native short, owner set", () => {
    const n = computeFundingNeed(BASE);
    const withShort = { ...n, usdc: { ...n.usdc, shortfall: 0n }, native: { ...n.native, shortfall: 890_000_000_000_000_000n } };
    expect(fundMessage(withShort, { address: ADDRESS, chainId: CHAIN_ID, ownerSet: true, games: BASE.games, stake: BASE.stake })).toBe(
      "Please send 0.89 native gas to 0x00000000000000000000000000000000000000Aa on chain 31337.",
    );
  });

  it("nothing short, owner set", () => {
    const n = computeFundingNeed(BASE);
    const covered = { ...n, usdc: { ...n.usdc, shortfall: 0n }, native: { ...n.native, shortfall: 0n } };
    expect(fundMessage(covered, { address: ADDRESS, chainId: CHAIN_ID, ownerSet: true, ...stake10at1 })).toBe(
      "This wallet already holds enough to play 10 games at 1.000000 USDC.",
    );
  });

  it("nothing short, owner unset", () => {
    const n = computeFundingNeed(BASE);
    const covered = { ...n, usdc: { ...n.usdc, shortfall: 0n }, native: { ...n.native, shortfall: 0n } };
    expect(fundMessage(covered, { address: ADDRESS, chainId: CHAIN_ID, ownerSet: false, ...stake10at1 })).toBe(
      "This wallet already holds enough to play 10 games at 1.000000 USDC. Tell me the address to return winnings to.",
    );
  });
});
