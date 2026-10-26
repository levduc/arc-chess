import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHAIN_PROFILES, WEI_PER_USDC_UNIT, chainProfile, weiToUsdc6Down, weiToUsdc6Up, type ChainProfile } from "../src/chains.js";
import { KNOWN_DEPLOYMENTS, pinnedDeploymentRefusals, type KnownDeployment } from "../src/config.js";

const ARC_USDC = "0x3600000000000000000000000000000000000000";

describe("Plan 6 (spec §2): the built-in chain profiles", () => {
  it("CHAIN_PROFILES is exactly the spec's: Arc (5042) and Arc Testnet (5042002), and nothing else", () => {
    expect(CHAIN_PROFILES).toEqual({
      5042: { name: "Arc", usdc: ARC_USDC, nativeIsUsdc: true, minFeePerGas: 20_000_000_000n, feeCeilingWei: 40_000_000_000n },
      5042002: { name: "Arc Testnet", usdc: ARC_USDC, nativeIsUsdc: true, minFeePerGas: 20_000_000_000n, feeCeilingWei: 40_000_000_000n },
    });
  });

  it("chainProfile: Arc's two chains have one; anvil 31337 and any other chain have none", () => {
    expect(chainProfile(5042)?.name).toBe("Arc");
    expect(chainProfile(5042002)?.name).toBe("Arc Testnet");
    for (const id of [31337, 1, 0, 5041, 5042001]) expect(chainProfile(id)).toBeUndefined();
  });
});

describe("Plan 6 (spec §2.1): native wei (18 decimals) to USDC base units (6 decimals)", () => {
  it("10^12 wei is one USDC base unit", () => {
    expect(WEI_PER_USDC_UNIT).toBe(10n ** 12n);
  });

  it("rounds a balance DOWN: 1 wei, 10^12 - 1, 10^12, 10^12 + 1 (and 0)", () => {
    expect(weiToUsdc6Down(0n)).toBe(0n);
    expect(weiToUsdc6Down(1n)).toBe(0n);
    expect(weiToUsdc6Down(10n ** 12n - 1n)).toBe(0n);
    expect(weiToUsdc6Down(10n ** 12n)).toBe(1n);
    expect(weiToUsdc6Down(10n ** 12n + 1n)).toBe(1n);
  });

  it("rounds a need or a reserve UP: 1 wei, 10^12 - 1, 10^12, 10^12 + 1 (and 0)", () => {
    expect(weiToUsdc6Up(0n)).toBe(0n);
    expect(weiToUsdc6Up(1n)).toBe(1n);
    expect(weiToUsdc6Up(10n ** 12n - 1n)).toBe(1n);
    expect(weiToUsdc6Up(10n ** 12n)).toBe(1n);
    expect(weiToUsdc6Up(10n ** 12n + 1n)).toBe(2n);
  });

  it("refuses a negative amount", () => {
    expect(() => weiToUsdc6Down(-1n)).toThrow(RangeError);
    expect(() => weiToUsdc6Up(-1n)).toThrow(RangeError);
  });
});

describe("Plan 6 (spec §2.5, Review Focus 3): pinnedDeploymentRefusals", () => {
  const HUB = `0x${"11".repeat(20)}` as const;
  const RULES = `0x${"33".repeat(20)}` as const;
  const OTHER = `0x${"44".repeat(20)}` as const;
  const arc = (table: Record<number, KnownDeployment> = {}) => (addrs: { hub: `0x${string}`; rules: `0x${string}`; usdc: `0x${string}` }, chainId = 5042) =>
    pinnedDeploymentRefusals(chainId, addrs, { table });

  it("a chain without a profile is never refused here, even one the table lists (it only warns, as before)", () => {
    const table: Record<number, KnownDeployment> = { 31337: { name: "test chain", hub: OTHER, rules: OTHER, usdc: OTHER } };
    expect(pinnedDeploymentRefusals(31337, { hub: HUB, rules: RULES, usdc: HUB }, { table })).toEqual([]);
  });

  it("on Arc, a USDC other than the profile's is refused, even before a deployment is pinned", () => {
    for (const chainId of [5042, 5042002]) {
      const refusals = arc()({ hub: HUB, rules: RULES, usdc: OTHER }, chainId);
      expect(refusals).toEqual([`usdc ${OTHER} is not ${chainProfile(chainId)!.name}'s USDC ${ARC_USDC}`]);
    }
  });

  it("on Arc with no pinned deployment, the profile's USDC (any case) and any hub and rules pass", () => {
    expect(arc()({ hub: HUB, rules: RULES, usdc: ARC_USDC })).toEqual([]);
    expect(arc()({ hub: HUB, rules: RULES, usdc: ARC_USDC.toUpperCase().replace("0X", "0x") as `0x${string}` })).toEqual([]);
  });

  it("on Arc with a pinned deployment, a hub or rules other than the pinned one is refused; the pinned ones (any case) pass", () => {
    const pinned = arc({ 5042: { name: "Arc", hub: HUB, rules: RULES } });
    expect(pinned({ hub: HUB, rules: RULES, usdc: ARC_USDC })).toEqual([]);
    expect(pinned({ hub: HUB.toUpperCase().replace("0X", "0x") as `0x${string}`, rules: RULES, usdc: ARC_USDC })).toEqual([]);
    expect(pinned({ hub: OTHER, rules: RULES, usdc: ARC_USDC })).toEqual([`hub ${OTHER} is not the pinned Arc hub ${HUB}`]);
    expect(pinned({ hub: HUB, rules: OTHER, usdc: ARC_USDC })).toEqual([`rules ${OTHER} is not the pinned Arc rules ${RULES}`]);
    expect(pinned({ hub: OTHER, rules: OTHER, usdc: OTHER })).toEqual([
      `usdc ${OTHER} is not Arc's USDC ${ARC_USDC}`,
      `hub ${OTHER} is not the pinned Arc hub ${HUB}`,
      `rules ${OTHER} is not the pinned Arc rules ${RULES}`,
    ]);
    // A pin on one Arc chain says nothing about the other.
    expect(pinned({ hub: OTHER, rules: OTHER, usdc: ARC_USDC }, 5042002)).toEqual([]);
  });

  it("a profile passed in is used instead of the built-in table", () => {
    const profiles: Record<number, ChainProfile> = {
      31337: { name: "Local", usdc: HUB, nativeIsUsdc: true, minFeePerGas: 1n, feeCeilingWei: 1n },
    };
    expect(pinnedDeploymentRefusals(31337, { hub: HUB, rules: RULES, usdc: OTHER }, { profiles, table: {} })).toEqual([
      `usdc ${OTHER} is not Local's USDC ${HUB}`,
    ]);
  });
});

describe("Plan 6 Task 5: the pinned Arc deployments match contracts/deployments/<chainId>.json", () => {
  it("KNOWN_DEPLOYMENTS[5042002] is the committed testnet deployment, with the profile's USDC", () => {
    const file = join(import.meta.dirname, "../../../contracts/deployments/5042002.json");
    const deployed = JSON.parse(readFileSync(file, "utf8")) as { channelHub: string; chessRules: string; token: string };
    const pinned = KNOWN_DEPLOYMENTS[5042002];
    expect(pinned.name).toBe(chainProfile(5042002)!.name);
    expect(pinned.hub).toBe(deployed.channelHub);
    expect(pinned.rules).toBe(deployed.chessRules);
    expect(pinned.usdc).toBe(deployed.token);
    expect(pinned.usdc).toBe(chainProfile(5042002)!.usdc);
    // A pinned deployment refuses nothing of its own.
    expect(pinnedDeploymentRefusals(5042002, { hub: deployed.channelHub as `0x${string}`, rules: deployed.chessRules as `0x${string}`, usdc: ARC_USDC })).toEqual([]);
  });
});
