import { afterEach, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { deployArena, RPC, setEthBalance, usdcBalance } from "../../../packages/sdk/test/helpers/chain.js";
import { FAUCET_MIN_NATIVE_WEI, FAUCET_USDC_AMOUNT } from "../src/chain.js";
import { startServer, type ArenaServer } from "../src/server.js";
import { FakeChain, testConfig } from "./helpers/fakeChain.js";

let server: ArenaServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function freshAddress(): `0x${string}` {
  return privateKeyToAccount(generatePrivateKey()).address;
}

// `contentType: null` sends the request with no content-type header at all; omitting the argument (not passing
// `undefined`, which a JS default parameter treats the same as omission) sends "application/json".
function postFaucet(url: string, address: string, contentType: string | null = "application/json") {
  return fetch(`${url}/faucet`, {
    method: "POST",
    headers: contentType === null ? {} : { "content-type": contentType },
    body: JSON.stringify({ address }),
  });
}

describe("dev faucet guard (stub chain)", () => {
  it("404s when devFaucet is false", async () => {
    server = await startServer(testConfig({ devFaucet: false }), { chain: new FakeChain() });
    const res = await postFaucet(server.url, freshAddress());
    expect(res.status).toBe(404);
  });

  it("404s when chainId is not 31337, even with devFaucet true and an Anvil-shaped clientVersion", async () => {
    server = await startServer(testConfig({ devFaucet: true, chainId: 1 }), { chain: new FakeChain() });
    const res = await postFaucet(server.url, freshAddress());
    expect(res.status).toBe(404);
  });

  it("404s when the RPC's clientVersion is not Anvil's, even with devFaucet true and chainId 31337", async () => {
    const chain = new FakeChain();
    chain.version = "Geth/v1.13.0-stable";
    server = await startServer(testConfig({ devFaucet: true, chainId: 31337 }), { chain });
    const res = await postFaucet(server.url, freshAddress());
    expect(res.status).toBe(404);
  });

  it("404s when the clientVersion RPC call fails, even with devFaucet true and chainId 31337", async () => {
    const chain = new FakeChain();
    chain.clientVersion = async () => {
      throw new Error("rpc down");
    };
    server = await startServer(testConfig({ devFaucet: true, chainId: 31337 }), { chain });
    const res = await postFaucet(server.url, freshAddress());
    expect(res.status).toBe(404);
  });

  it("/templates advertises faucet only when the guard is fully satisfied", async () => {
    server = await startServer(testConfig({ devFaucet: false }), { chain: new FakeChain() });
    const disabled = (await (await fetch(`${server.url}/templates`)).json()) as Array<{ faucet?: string }>;
    expect(disabled[0].faucet).toBeUndefined();
    await server.close();

    server = await startServer(testConfig({ devFaucet: true, chainId: 31337 }), { chain: new FakeChain() });
    const enabled = (await (await fetch(`${server.url}/templates`)).json()) as Array<{ faucet?: string }>;
    expect(enabled[0].faucet).toBe(`${server.url}/faucet`);
  });

  it("415s a non-JSON content-type and 400s a malformed or missing address, without ever reaching the RPC", async () => {
    server = await startServer(testConfig({ devFaucet: true, chainId: 31337 }), { chain: new FakeChain() });
    const noType = await postFaucet(server.url, freshAddress(), null);
    expect(noType.status).toBe(415);
    const textType = await postFaucet(server.url, freshAddress(), "text/plain");
    expect(textType.status).toBe(415);

    const badAddr = await postFaucet(server.url, "not-an-address");
    expect(badAddr.status).toBe(400);
    const missing = await fetch(`${server.url}/faucet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
  });
});

describe("dev faucet funding (real Anvil)", () => {
  it("mints 100 USDC and raises native to at least 10 ETH, waits for the receipt, and rejects a repeat within 10 minutes", async () => {
    const env = await deployArena();
    server = await startServer(testConfig({ rpcUrl: RPC, chainId: 31337, hub: env.hub, usdc: env.usdc, rules: env.rules, devFaucet: true }));
    const to = freshAddress();

    const res = await postFaucet(server.url, to);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { address: string; usdc: string; native: string };
    expect(body.address).toBe(getAddress(to));
    expect(body.usdc).toBe(FAUCET_USDC_AMOUNT.toString());
    expect(BigInt(body.native)).toBeGreaterThanOrEqual(FAUCET_MIN_NATIVE_WEI);

    // Actually landed on chain, not just reported.
    expect(await usdcBalance(env.usdc, to)).toBe(FAUCET_USDC_AMOUNT);

    // A second request for the same address within the cooldown is refused with the time left.
    const again = await postFaucet(server.url, to);
    expect(again.status).toBe(429);
    const againBody = (await again.json()) as { error: string; retryAfterSeconds: number };
    expect(againBody.retryAfterSeconds).toBeGreaterThan(0);
    expect(againBody.retryAfterSeconds).toBeLessThanOrEqual(600);
  });

  it("never lowers an already-higher native balance", async () => {
    const env = await deployArena();
    server = await startServer(testConfig({ rpcUrl: RPC, chainId: 31337, hub: env.hub, usdc: env.usdc, rules: env.rules, devFaucet: true }));
    const to = freshAddress();
    // Above FAUCET_MIN_NATIVE_WEI (10 ETH): the faucet must leave this exactly as-is, not raise or lower it.
    const twentyEth = 20n * 10n ** 18n;
    await setEthBalance(to, twentyEth);

    const res = await postFaucet(server.url, to);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { native: string };
    expect(BigInt(body.native)).toBe(twentyEth);
  });

  it("a request from a different address is funded independently (no cross-address rate limiting)", async () => {
    const env = await deployArena();
    server = await startServer(testConfig({ rpcUrl: RPC, chainId: 31337, hub: env.hub, usdc: env.usdc, rules: env.rules, devFaucet: true }));
    const a = freshAddress();
    const b = freshAddress();
    expect((await postFaucet(server.url, a)).status).toBe(200);
    expect((await postFaucet(server.url, b)).status).toBe(200);
  });
});
