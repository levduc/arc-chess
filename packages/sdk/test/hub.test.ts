import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { HubClient, HubRevertError, LocalKeyTxSender } from "../src/index.js";
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
