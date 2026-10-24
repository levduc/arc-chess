import { describe, expect, it } from "vitest";
import {
  computeFundingNeed,
  computeOneBalanceFundingNeed,
  formatNativeCeil4,
  oneBalanceOpenNeed,
  fundDisclosure,
  fundMessage,
  tellYourHuman,
  FUND_TX_GAS_UNITS,
  type FundingInput,
  type OneBalanceFundingInput,
} from "../src/funding.js";

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

// Plan 6 (spec §2.1, Review Focus 1): on a chain whose gas is USDC (Arc), one balance and one ask.
describe("computeOneBalanceFundingNeed (nativeIsUsdc)", () => {
  const ONE: OneBalanceFundingInput = {
    games: 3n,
    stake: 1_000_000n,
    cap: 10_000_000n,
    feePerPlayer: 5_000n,
    sessionGasWei: 10_000_000_000_000_000n, // 1e16 wei = 0.01 USDC
    feeCeilingWei: 100_000_000_000n, // 500_000 x 100 gwei = 5e16 wei = 0.05 USDC
    balanceWei: 0n,
  };

  it("usdc.need = deposit + fee + ceil((sessionGasWei + 500,000 x feeCeiling) / 10^12); there is no native", () => {
    const n = computeOneBalanceFundingNeed(ONE);
    expect(n.deposit).toBe(3_000_000n);
    expect(n.usdc).toEqual({ have: 0n, need: 3_000_000n + 5_000n + 60_000n, shortfall: 3_065_000n, reserved: 0n });
    expect("native" in n).toBe(false);
    expect(Object.keys(n)).toEqual(["deposit", "feePerPlayer", "usdc"]);
  });

  it("at Arc's own numbers: 0.336 USDC of session gas (4 x 2.1M x 40 gwei) plus 0.02 USDC for the wallet's transactions", () => {
    const n = computeOneBalanceFundingNeed({ ...ONE, sessionGasWei: 4n * 2_100_000n * 40_000_000_000n, feeCeilingWei: 40_000_000_000n });
    expect(n.usdc.need).toBe(3_005_000n + 336_000n + 20_000n);
  });

  it("the gas rounds UP to the next micro-USDC and the balance rounds DOWN, so the ask is never short", () => {
    const tiny = { ...ONE, sessionGasWei: 1n, feeCeilingWei: 0n };
    expect(computeOneBalanceFundingNeed(tiny).usdc.need).toBe(3_005_001n); // 1 wei of gas -> 1 micro-USDC
    expect(computeOneBalanceFundingNeed({ ...tiny, sessionGasWei: 10n ** 12n }).usdc.need).toBe(3_005_001n);
    expect(computeOneBalanceFundingNeed({ ...tiny, sessionGasWei: 10n ** 12n + 1n }).usdc.need).toBe(3_005_002n);
    expect(computeOneBalanceFundingNeed({ ...ONE, balanceWei: 10n ** 12n - 1n }).usdc.have).toBe(0n);
    expect(computeOneBalanceFundingNeed({ ...ONE, balanceWei: 10n ** 12n + 1n }).usdc.have).toBe(1n);
    // Exactly the need, in wei: covered, nothing short.
    const exact = computeOneBalanceFundingNeed({ ...ONE, balanceWei: 3_065_000n * 10n ** 12n });
    expect(exact.usdc.shortfall).toBe(0n);
    expect(computeOneBalanceFundingNeed({ ...ONE, balanceWei: 3_065_000n * 10n ** 12n - 1n }).usdc.shortfall).toBe(1n);
  });

  it("fix round 1 (I-5): each unsettled channel of the home adds one sessionGasWei of reserve to need, shown as reserved; have stays the balance", () => {
    const one = computeOneBalanceFundingNeed({ ...ONE, unsettledChannels: 1, balanceWei: 2n * 10n ** 18n });
    expect(one.usdc).toEqual({ have: 2_000_000n, need: 3_075_000n, shortfall: 1_075_000n, reserved: 10_000n });
    expect(computeOneBalanceFundingNeed({ ...ONE, unsettledChannels: 3 }).usdc).toMatchObject({ need: 3_095_000n, reserved: 30_000n });
    // At Arc's numbers, one live channel adds its whole 0.336 USDC refill.
    const arc = { ...ONE, sessionGasWei: 4n * 2_100_000n * 40_000_000_000n, feeCeilingWei: 40_000_000_000n };
    expect(computeOneBalanceFundingNeed({ ...arc, unsettledChannels: 1 }).usdc.reserved).toBe(336_000n);
    expect(() => computeOneBalanceFundingNeed({ ...ONE, unsettledChannels: -1 })).toThrow(RangeError);
  });

  it("fix round 1: oneBalanceOpenNeed rounds the gas up once, as a sum -- the figure the daemon's opening gates use", () => {
    const base = { deposit: 1_000_000n, feePerPlayer: 5_000n, sessionGasWei: 10n ** 12n + 1n, feeCeilingWei: 0n };
    expect(oneBalanceOpenNeed({ ...base, ownGasWei: base.sessionGasWei, otherChannels: 0 })).toBe(1_005_002n); // ceil(1e12 + 1)
    expect(oneBalanceOpenNeed({ ...base, ownGasWei: base.sessionGasWei, otherChannels: 1 })).toBe(1_005_003n); // ceil(2e12 + 2), not 2 + 2
    expect(oneBalanceOpenNeed({ ...base, ownGasWei: 0n, otherChannels: 1 })).toBe(1_005_002n); // the key is already topped up
    expect(oneBalanceOpenNeed({ ...base, ownGasWei: 0n, otherChannels: 0 })).toBe(1_005_000n);
    // The same sum as computeOneBalanceFundingNeed's need, so `fund`'s ask always passes the daemon's gate.
    const n = computeOneBalanceFundingNeed({ ...ONE, sessionGasWei: base.sessionGasWei, feeCeilingWei: 0n, unsettledChannels: 1 });
    expect(n.usdc.need).toBe(oneBalanceOpenNeed({ deposit: n.deposit, feePerPlayer: ONE.feePerPlayer, ownGasWei: base.sessionGasWei, otherChannels: 1, sessionGasWei: base.sessionGasWei, feeCeilingWei: 0n }));
    expect(() => oneBalanceOpenNeed({ ...base, ownGasWei: 0n, otherChannels: 0.5 })).toThrow(RangeError);
  });

  it("the deposit rules are computeFundingNeed's own", () => {
    expect(computeOneBalanceFundingNeed({ ...ONE, games: 20n }).deposit).toBe(10_000_000n);
    expect(computeOneBalanceFundingNeed({ ...ONE, deposit: 2_000_000n }).deposit).toBe(2_000_000n);
    expect(() => computeOneBalanceFundingNeed({ ...ONE, deposit: ONE.stake - 1n })).toThrow(RangeError);
    expect(() => computeOneBalanceFundingNeed({ ...ONE, deposit: ONE.cap + 1n })).toThrow(RangeError);
    expect(() => computeOneBalanceFundingNeed({ ...ONE, games: 0n })).toThrow(RangeError);
  });

  // Plan 6 hardening H2 (audit-journey C-1, C-2): pinned character for character. On Arc the message names the network
  // and its chain id, warns that USDC sent on any other network never arrives, says how to get USDC onto Arc, and
  // asks for an owner address the human controls on Arc.
  const ARC_SEND =
    "Please send 3.065000 USDC to 0x00000000000000000000000000000000000000Aa on Arc (chain id 5042), on the Arc network " +
    "only: USDC sent on Ethereum, Base or any other network will not arrive. To get USDC onto Arc, use Circle's CCTP " +
    "bridge from another chain, or an exchange or wallet that supports Arc. Gas on Arc is paid in USDC, so nothing else " +
    "is needed.";
  const ARC_OWNER =
    "an address you control on Arc to return winnings to (not an exchange deposit address unless that exchange " +
    "supports USDC deposits on Arc, and not a smart wallet deployed only on another chain).";

  it("fundMessage names USDC only -- never native gas -- and, on Arc, the network, the wrong-network warning and the way in", () => {
    const n = computeOneBalanceFundingNeed(ONE);
    const ctx = { address: ADDRESS, chainId: 5042, games: ONE.games, stake: ONE.stake };
    expect(fundMessage(n, { ...ctx, ownerSet: false })).toBe(`${ARC_SEND} Also tell me ${ARC_OWNER}`);
    expect(fundMessage(n, { ...ctx, ownerSet: true })).toBe(ARC_SEND);
    const covered = computeOneBalanceFundingNeed({ ...ONE, balanceWei: 10n * 10n ** 18n }); // 10 USDC
    expect(fundMessage(covered, { ...ctx, ownerSet: true })).toBe("This wallet already holds enough to play 3 games at 1.000000 USDC.");
    expect(fundMessage(covered, { ...ctx, ownerSet: false })).toBe(
      `This wallet already holds enough to play 3 games at 1.000000 USDC. Tell me ${ARC_OWNER}`,
    );
    // Never "native", never a bare "on chain 5042".
    for (const m of [fundMessage(n, { ...ctx, ownerSet: false }), fundMessage(covered, { ...ctx, ownerSet: false })]) {
      expect(m).not.toMatch(/native|on chain 5042/);
    }
  });

  it("fundMessage on Arc Testnet names it, and its one way in is Circle's faucet", () => {
    const n = computeOneBalanceFundingNeed(ONE);
    expect(fundMessage(n, { address: ADDRESS, chainId: 5042002, ownerSet: false, games: ONE.games, stake: ONE.stake })).toBe(
      "Please send 3.065000 USDC to 0x00000000000000000000000000000000000000Aa on Arc Testnet (chain id 5042002), on the " +
        "Arc Testnet network only: USDC sent on Ethereum, Base or any other network will not arrive. Arc Testnet's USDC " +
        "comes from Circle's faucet (https://faucet.circle.com). Gas on Arc Testnet is paid in USDC, so nothing else is " +
        "needed. Also tell me an address you control on Arc Testnet to return winnings to (not an exchange deposit " +
        "address unless that exchange supports USDC deposits on Arc Testnet, and not a smart wallet deployed only on " +
        "another chain).",
    );
  });
});

describe("H4: fundDisclosure and tellYourHuman (live run frictions 1 and 2)", () => {
  const HUB = "0x9b8Bc44f261D09C94cA17b7b0281DD706f76bA41" as const;
  const OWNER = "0x840d6f90dd12A713CC5F1fb6EAbBF99e0E74A7E0" as const;
  const AUDIT = "unaudited; Arc TESTNET test stack, faucet USDC only";
  const base = { hub: HUB, audit: AUDIT, cap: 2_000_000n, feePerPlayer: 5_000n, owner: null };

  it("names the network and whether it is real, the hub, the host's audit text, the cap, the fee and the owner rule", () => {
    expect(fundDisclosure({ ...base, chainId: 5042002 })).toBe(
      "What you are funding: chess games for USDC through the Agent Chess Arena hub 0x9b8Bc44f261D09C94cA17b7b0281DD706f76bA41 " +
        'on Arc Testnet (chain id 5042002, a test network). Its host says: "unaudited; Arc TESTNET test stack, faucet USDC only". ' +
        // Fix round 1 (M6): the cap is the host's figure, said as the host's; the fee is the hub's.
        "The host says each player may deposit at most 2.000000 USDC per channel. The hub charges a fee of 0.005000 USDC " +
        "per player per channel, and withdrawals go only to the owner address you give me.",
    );
    expect(fundDisclosure({ ...base, chainId: 5042, owner: OWNER })).toContain(
      "on Arc (chain id 5042, mainnet, real USDC). Its host says:",
    );
    expect(fundDisclosure({ ...base, chainId: 5042, owner: OWNER })).toMatch(
      /and withdrawals go only to the recorded owner, 0x840d6f90dd12A713CC5F1fb6EAbBF99e0E74A7E0\.$/,
    );
    expect(fundDisclosure({ ...base, chainId: 31337 })).toContain("hub 0x9b8Bc44f261D09C94cA17b7b0281DD706f76bA41 on chain 31337. Its host says:");
  });

  it("an absent or blank audit says so; the host's text is folded onto one line and capped at 300 characters", () => {
    expect(fundDisclosure({ ...base, chainId: 5042002, audit: undefined })).toContain("Its host publishes no audit statement. The host says each player");
    expect(fundDisclosure({ ...base, chainId: 5042002, audit: " \n " })).toContain("Its host publishes no audit statement.");
    // Fix round 1 (M6): bidi overrides and other format characters are removed, so the quote cannot reorder what follows.
    expect(fundDisclosure({ ...base, chainId: 5042002, audit: "safe\u202E\u2066 text\u200B\u0085" })).toContain('Its host says: "safe text".');
    expect(fundDisclosure({ ...base, chainId: 5042002, audit: "\u202E\u200F" })).toContain("Its host publishes no audit statement.");
    expect(fundDisclosure({ ...base, chainId: 5042002, audit: "line one\n\tline\u0007two " })).toContain('Its host says: "line one line two".');
    const long = fundDisclosure({ ...base, chainId: 5042002, audit: "x".repeat(400) });
    expect(long).toContain(`Its host says: "${"x".repeat(299)}…".`);
    expect(long).not.toContain("x".repeat(300));
  });

  it("tellYourHuman leads with the instruction, then the disclosure and the ask; with a shortfall it comes before the wait", () => {
    expect(tellYourHuman("D.", "Please send 1 USDC.", true)).toBe(
      "Tell your human now, in your own reply, word for word, before you run wallet --wait-for-usdc " +
        "(they cannot see this command's output): D. Please send 1 USDC.",
    );
    expect(tellYourHuman("D.", "This wallet already holds enough.", false)).toBe(
      "Tell your human now, in your own reply, word for word (they cannot see this command's output): D. This wallet already holds enough.",
    );
  });
});
