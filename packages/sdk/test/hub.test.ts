import { describe, expect, it } from "vitest";
import { createPublicClient, custom, toEventSelector, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { HUB_EVENT_ABI, HUB_EVENT_KINDS, HubClient, HubRevertError, LocalKeyTxSender, channelHubAbi } from "../src/index.js";
import { ANVIL_KEYS, CHAIN, RPC, deployArena, mintUsdc, usdcBalance } from "./helpers/chain.js";

// Plan 5.6 Task 3: `HubClient.transfer` -- the ERC-20 `transfer` the CLI's owner-locked `arena withdraw` sends
// through the daemon's own wallet sender (the same `write` path `approve` uses).
describe("HubClient.transfer", () => {
  it("moves exactly the amount from the sender to the recipient", async () => {
    const env = await deployArena();
    const sender = new LocalKeyTxSender(ANVIL_KEYS[1], RPC, CHAIN);
    const to = privateKeyToAccount(generatePrivateKey()).address; // a fresh address: balance 0
    await mintUsdc(env.usdc, sender.address, 10_000_000n);
    const hub = new HubClient(env.hub, env.pub);
    const fromBefore = await usdcBalance(env.usdc, sender.address);

    const receipt = await hub.transfer(sender, env.usdc, to, 3_141_592n);

    expect(receipt.status).toBe("success");
    expect(receipt.to?.toLowerCase()).toBe(env.usdc.toLowerCase()); // sent to the token, never to the hub
    expect(await usdcBalance(env.usdc, to)).toBe(3_141_592n);
    expect(await usdcBalance(env.usdc, sender.address)).toBe(fromBefore - 3_141_592n);
  });

  it("a transfer the token refuses surfaces as a named HubRevertError, and moves nothing", async () => {
    const env = await deployArena();
    const sender = new LocalKeyTxSender(ANVIL_KEYS[1], RPC, CHAIN);
    const to = privateKeyToAccount(generatePrivateKey()).address;
    const hub = new HubClient(env.hub, env.pub);
    const have = await usdcBalance(env.usdc, sender.address);

    const err = await hub.transfer(sender, env.usdc, to, have + 1n).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HubRevertError);
    expect((err as HubRevertError).errorName).toBe("ERC20InsufficientBalance");
    expect(await usdcBalance(env.usdc, to)).toBe(0n);
    expect(await usdcBalance(env.usdc, sender.address)).toBe(have);
  });
});

// Plan 6 Task 5 (the Arc testnet rehearsal): Arc's RPC refuses an eth_getLogs whose topic-0 list has more than 10
// entries, even for one block (-32012 "requested range too large", on testnet and mainnet alike). The hub's ABI has
// 15 events; hubEvents' full read must ask for the 7 that carry a channelId and nothing else.
describe("HubClient.hubEvents on an RPC that caps topic-0 lists at 10", () => {
  const HUB = `0x${"ab".repeat(20)}` as const; // a synthetic address: the transport below is the whole "chain"
  /** A transport that answers eth_getLogs like Arc's RPC: refused with more than 10 topics in position 0, else []. */
  function arcLikeClient(seen: unknown[][]): PublicClient {
    return createPublicClient({
      transport: custom({
        async request({ method, params }: { method: string; params?: unknown }) {
          if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
          const filter = (params as Array<{ topics?: unknown[] }>)[0];
          const topic0 = filter.topics?.[0];
          seen.push(Array.isArray(topic0) ? topic0 : [topic0]);
          if (Array.isArray(topic0) && topic0.length > 10) throw Object.assign(new Error("requested range too large"), { code: -32012 });
          return [];
        },
      }),
    }) as PublicClient;
  }

  type AbiEventItem = Extract<(typeof channelHubAbi)[number], { type: "event" }>;
  const abiEvents = channelHubAbi.filter((x): x is AbiEventItem => x.type === "event");

  it("the full read asks for exactly the channel events' selectors, no more than 10", async () => {
    const seen: unknown[][] = [];
    const hub = new HubClient(HUB, arcLikeClient(seen));
    expect(await hub.hubEvents(1n, 1000n)).toEqual([]);
    expect(seen).toHaveLength(1);
    const want = HUB_EVENT_KINDS.map((name) => toEventSelector(abiEvents.find((x) => x.name === name)!));
    expect([...seen[0]].sort()).toEqual([...want].sort());
    expect(seen[0].length).toBeLessThanOrEqual(10);
    // The kinds are exactly the ABI's events that carry a channelId.
    const withChannelId = abiEvents.filter((x) => x.inputs.some((i) => i.name === "channelId")).map((x) => x.name);
    expect([...HUB_EVENT_KINDS].sort()).toEqual([...withChannelId].sort());
    expect(HUB_EVENT_ABI.map((x) => x.name).sort()).toEqual([...HUB_EVENT_KINDS].sort());
  });

  it("a read of every ABI event (15 topics) is what such an RPC refuses", async () => {
    const seen: unknown[][] = [];
    const client = arcLikeClient(seen);
    await expect(client.getContractEvents({ address: HUB, abi: channelHubAbi, fromBlock: 1n, toBlock: 1n })).rejects.toThrow();
    expect(seen[0].length).toBeGreaterThan(10);
  });
});
