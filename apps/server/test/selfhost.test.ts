/**
 * Self-host (deploy/host): the config the Docker image builds from its environment and its shipped assets
 * (apps/server/src/selfhost.ts), and the deployments `scripts/build-server.ts` lets an image ship. Pure functions,
 * plus `hostMain` against a stub JSON-RPC server: no Docker, no network.
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionResult, toFunctionSelector, type Address } from "viem";
import { channelHubAbi } from "@arena/sdk";
import { KNOWN_DEPLOYMENTS } from "@arena/cli";
import { parseServerConfig } from "../src/config.js";
import {
  HOST_NETWORKS,
  HostConfigError,
  hostAudit,
  hostDeployments,
  hostMain,
  hostServerConfig,
  hostSettings,
  type HostAssets,
  type HubFacts,
} from "../src/selfhost.js";

const REPO_ROOT = join(import.meta.dirname, "../../..");
const TESTNET_HUB = "0x3D8434455E4258a877a327De3B1201f94A558d38";
const TESTNET_RULES = "0xD3C7eA363A4d734d85abcB243B8D3135746C14Ba";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const MAINNET_HUB = `0x${"5a".repeat(20)}`;
const MAINNET_RULES = `0x${"5b".repeat(20)}`;

const testnetAssets = (): HostAssets => ({
  cli: { package: "arc-chess", version: "0.1.0" },
  deployments: { "5042002": { hub: TESTNET_HUB, rules: TESTNET_RULES, usdc: ARC_USDC, deployBlock: "69112538" } },
  missing: { "5042": "contracts/deployments/5042.json does not exist; the CLI pins no deployment for chain 5042" },
});

/** An image built after the mainnet deploy is pinned (a fake mainnet hub). */
const pinnedMainnetAssets = (): HostAssets => ({
  ...testnetAssets(),
  deployments: {
    ...testnetAssets().deployments,
    "5042": { hub: MAINNET_HUB as Address, rules: MAINNET_RULES as Address, usdc: ARC_USDC, deployBlock: "1234567" },
  },
  missing: {},
});

const HUB: HubFacts = {
  feePerPlayer: 5_000n,
  feeRecipient: `0x${"fe".repeat(20)}` as Address,
  maxDepositPerPlayer: 10_000_000n,
  maxCommittedEscrow: 1_000_000_000n,
};

const env = (extra: Record<string, string | undefined> = {}) => ({ DOMAIN: "arena.operator.dev", ...extra });

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HostConfigError);
    return (err as Error).message;
  }
  throw new Error("expected a HostConfigError");
}

describe("hostDeployments (what an image may serve)", () => {
  const readReal = (chainId: number): unknown => {
    try {
      return JSON.parse(readFileSync(join(REPO_ROOT, "contracts/deployments", `${chainId}.json`), "utf8"));
    } catch {
      return null;
    }
  };

  it("from this checkout: Arc testnet ships, at its hub's deploy block; Arc mainnet is missing until its deploy is pinned", () => {
    const { deployments, missing } = hostDeployments({ pins: KNOWN_DEPLOYMENTS, readDeployment: readReal });
    expect(deployments["5042002"]).toEqual({ hub: TESTNET_HUB, rules: TESTNET_RULES, usdc: ARC_USDC, deployBlock: "69112538" });
    expect(deployments["5042002"]!.hub).toBe(KNOWN_DEPLOYMENTS[5042002]!.hub);
    // Today: no contracts/deployments/5042.json and no KNOWN_DEPLOYMENTS[5042]. When Task 6 pins mainnet, this test
    // must be updated together with the pin (and the file must record its deployBlock).
    expect(Object.hasOwn(KNOWN_DEPLOYMENTS, 5042)).toBe(false);
    expect(deployments["5042"]).toBeUndefined();
    expect(missing["5042"]).toContain("contracts/deployments/5042.json does not exist");
    expect(missing["5042"]).toContain("the CLI pins no deployment for chain 5042");
  });

  it("the testnet deploy block is the ECDSA-only hub's, from its broadcast receipt (rehearsal doc, Redeploy #2)", () => {
    const file = JSON.parse(readFileSync(join(REPO_ROOT, "contracts/deployments/5042002.json"), "utf8")) as Record<string, unknown>;
    expect(file.deployBlock).toBe(69_112_538);
  });

  const file = (hub: string, extra: Record<string, unknown> = { deployBlock: 100 }) => ({ channelHub: hub, chessRules: MAINNET_RULES, token: ARC_USDC, ...extra });
  const pin = { hub: MAINNET_HUB, rules: MAINNET_RULES, usdc: ARC_USDC };
  const only5042 = (f: unknown) => (id: number) => (id === 5042 ? f : null);

  it("a mainnet file with no pin, or a pin with no file, ships nothing and says which is missing", () => {
    const noPin = hostDeployments({ pins: {}, readDeployment: only5042(file(MAINNET_HUB)) });
    expect(noPin.deployments["5042"]).toBeUndefined();
    expect(noPin.missing["5042"]).toBe("the CLI pins no deployment for chain 5042 (KNOWN_DEPLOYMENTS in packages/cli/src/config.ts)");
    const noFile = hostDeployments({ pins: { 5042: pin }, readDeployment: () => null });
    expect(noFile.missing["5042"]).toBe("contracts/deployments/5042.json does not exist");
  });

  it("a pinned mainnet file without a deployBlock ships nothing (Deploy.s.sol does not write one)", () => {
    const r = hostDeployments({ pins: { 5042: pin }, readDeployment: only5042(file(MAINNET_HUB, {})) });
    expect(r.deployments["5042"]).toBeUndefined();
    expect(r.missing["5042"]).toMatch(/records no deployBlock/);
  });

  it("a pinned mainnet file with its deployBlock ships", () => {
    const r = hostDeployments({ pins: { 5042: pin }, readDeployment: only5042(file(MAINNET_HUB, { deployBlock: "777" })) });
    expect(r.deployments["5042"]).toEqual({ hub: MAINNET_HUB, rules: MAINNET_RULES, usdc: ARC_USDC, deployBlock: "777" });
    expect(r.missing["5042"]).toBeUndefined();
  });

  it("fails the build when the file and the pin name different contracts, or the deployBlock is malformed", () => {
    expect(() => hostDeployments({ pins: { 5042: pin }, readDeployment: only5042(file(`0x${"99".repeat(20)}`)) })).toThrow(
      /5042\.json's hub 0x9999.* is not the CLI's pinned hub/,
    );
    for (const deployBlock of [0, -1, 1.5, "0x10", "", "12a"]) {
      expect(() => hostDeployments({ pins: { 5042: pin }, readDeployment: only5042(file(MAINNET_HUB, { deployBlock })) })).toThrow(/deployBlock must be/);
    }
  });
});

describe("hostSettings (the container's environment)", () => {
  it("defaults: Arc testnet, the public RPC for both reading and publishing (with a warning), the image's CLI version", () => {
    const s = hostSettings(env(), testnetAssets());
    expect(s).toMatchObject({
      network: "arc-testnet",
      chainId: 5042002,
      publicUrl: "https://arena.operator.dev",
      rpcUrl: "https://rpc.testnet.arc.io",
      publicRpcUrl: "https://rpc.testnet.arc.io",
      cli: { package: "arc-chess", version: "0.1.0" },
      operator: "not named",
      trustProxy: false,
      port: 3000,
      dbPath: "/data/arena.sqlite",
      indexer: { pollMs: 3_000, chunkBlocks: 10_000 },
    });
    expect(s.xmtp).toBeUndefined();
    expect(s.warnings.join("\n")).toMatch(/RPC_URL is Arc TESTNET's public RPC .* Set RPC_URL to a dedicated RPC/);
  });

  it("a keyed RPC_URL is never what gets published: PUBLIC_RPC_URL defaults to the network's public RPC", () => {
    const s = hostSettings(env({ RPC_URL: "https://arc-testnet.provider.example/v2/SECRETKEY" }), testnetAssets());
    expect(s.rpcUrl).toBe("https://arc-testnet.provider.example/v2/SECRETKEY");
    expect(s.publicRpcUrl).toBe("https://rpc.testnet.arc.io");
    expect(s.warnings).toEqual([]);
    const raw = hostServerConfig(s, HUB);
    expect(raw.publicRpcUrl).toBe("https://rpc.testnet.arc.io");
    expect(JSON.stringify({ ...raw, rpcUrl: undefined })).not.toContain("SECRETKEY");
  });

  it("an RPC_URL that is the public one written differently still warns", () => {
    expect(hostSettings(env({ RPC_URL: "https://rpc.testnet.arc.io/" }), testnetAssets()).warnings.join()).toMatch(/public RPC/);
  });

  it("PUBLIC_RPC_URL: credentials are refused, a path or query warns (it is published)", () => {
    expect(refusal(() => hostSettings(env({ PUBLIC_RPC_URL: "https://user:pw@rpc.example.org" }), testnetAssets()))).toMatch(/PUBLIC_RPC_URL must not contain/);
    const s = hostSettings(env({ RPC_URL: "https://rpc.example.org", PUBLIC_RPC_URL: "https://rpc.example.org/v2/abc" }), testnetAssets());
    expect(s.warnings.join()).toMatch(/PUBLIC_RPC_URL has a path or query/);
    expect(refusal(() => hostSettings(env({ RPC_URL: "ftp://rpc.example.org" }), testnetAssets()))).toMatch(/RPC_URL must be an http\(s\) URL/);
  });

  it("M-3: PUBLIC_RPC_URL may not be RPC_URL (the place for a keyed URL), unless both are the network's public RPC", () => {
    const keyed = "https://arc.provider.example.net/v2/SECRETKEY";
    for (const pub of [keyed, keyed.replace("arc.provider", "ARC.PROVIDER")]) {
      expect(refusal(() => hostSettings(env({ RPC_URL: keyed, PUBLIC_RPC_URL: pub }), testnetAssets()))).toMatch(/^PUBLIC_RPC_URL is RPC_URL: it is published to every agent/);
    }
    const both = hostSettings(env({ RPC_URL: "https://rpc.testnet.arc.io", PUBLIC_RPC_URL: "https://rpc.testnet.arc.io/" }), testnetAssets());
    expect(both.publicRpcUrl).toBe("https://rpc.testnet.arc.io/");
  });

  it("DOMAIN is required, a bare host name, and not the example value", () => {
    expect(refusal(() => hostSettings({}, testnetAssets()))).toMatch(/^DOMAIN is required/);
    expect(refusal(() => hostSettings({ DOMAIN: "  " }, testnetAssets()))).toMatch(/^DOMAIN is required/);
    for (const bad of ["https://arena.example.org", "arena.example.org:443", "arena.example.org/x", "-bad.org", "a b.org"]) {
      expect(refusal(() => hostSettings({ DOMAIN: bad }, testnetAssets()))).toMatch(/^DOMAIN must be a bare host name/);
    }
    // M-4: every RFC 2606 / 6761 example name, the README's own `arena.example.org` included; `localhost` stays allowed.
    for (const reserved of ["arena.example.com", "example.org", "arena.example.org", "x.example.net", "arena.test", "host.example", "a.invalid"]) {
      expect(refusal(() => hostSettings({ DOMAIN: reserved }, testnetAssets()))).toMatch(/a reserved example name: set it to your own host name/);
    }
    expect(hostSettings({ DOMAIN: "localhost" }, testnetAssets()).publicUrl).toBe("https://localhost");
    expect(hostSettings({ DOMAIN: "Arena.Operator.Dev" }, testnetAssets()).publicUrl).toBe("https://arena.operator.dev");
    expect(hostSettings({ DOMAIN: "example.org.operator.dev" }, testnetAssets()).publicUrl).toBe("https://example.org.operator.dev");
  });

  it("PUBLIC_URL: https with an optional port; plain http only on loopback; no path, query or credentials", () => {
    expect(hostSettings(env({ DOMAIN: "localhost", PUBLIC_URL: "https://localhost:8781" }), testnetAssets()).publicUrl).toBe("https://localhost:8781");
    expect(hostSettings(env({ PUBLIC_URL: "http://127.0.0.1:8781/" }), testnetAssets()).publicUrl).toBe("http://127.0.0.1:8781");
    expect(refusal(() => hostSettings(env({ PUBLIC_URL: "http://arena.example.org" }), testnetAssets()))).toMatch(/PUBLIC_URL must be https/);
    for (const bad of ["https://arena.example.org/arena", "https://arena.example.org/?x=1", "https://u:p@arena.example.org"]) {
      expect(refusal(() => hostSettings(env({ PUBLIC_URL: bad }), testnetAssets()))).toMatch(/PUBLIC_URL must be a bare origin/);
    }
  });

  it("NETWORK=arc-mainnet is refused while the image ships no pinned mainnet deployment, naming what is missing", () => {
    const msg = refusal(() => hostSettings(env({ NETWORK: "arc-mainnet" }), testnetAssets()));
    expect(msg).toMatch(/^NETWORK=arc-mainnet: this image cannot serve Arc mainnet \(chain 5042\) yet: contracts\/deployments\/5042\.json does not exist/);
    expect(msg).toMatch(/use arc-testnet$/);
    expect(refusal(() => hostSettings(env({ NETWORK: "mainnet" }), testnetAssets()))).toMatch(/^NETWORK must be "arc-testnet" or "arc-mainnet"/);
  });

  it("NETWORK=arc-mainnet with a pinned deployment: the mainnet RPC, its deploy block, and XMTP production with a gateway only", () => {
    const s = hostSettings(env({ NETWORK: "arc-mainnet" }), pinnedMainnetAssets());
    expect(s).toMatchObject({ chainId: 5042, rpcUrl: "https://rpc.mainnet.arc.io", publicRpcUrl: "https://rpc.mainnet.arc.io" });
    expect(s.deployment.hub).toBe(MAINNET_HUB);
    expect(refusal(() => hostSettings(env({ NETWORK: "arc-mainnet", XMTP: "on" }), pinnedMainnetAssets()))).toMatch(/needs XMTP_GATEWAY_HOST/);
    const x = hostSettings(env({ NETWORK: "arc-mainnet", XMTP: "on", XMTP_GATEWAY_HOST: "https://gw.example.org" }), pinnedMainnetAssets());
    expect(x.xmtp).toEqual({ env: "production", gatewayHost: "https://gw.example.org" });
    // The server's own Arc-mainnet checks (startBlock, xmtp production) pass on what this builds.
    const cfg = parseServerConfig(hostServerConfig(x, HUB));
    expect(cfg.indexer.startBlock).toBe(1_234_567n);
    expect(cfg.xmtp).toEqual({ env: "production", gatewayHost: "https://gw.example.org" });
  });

  it("XMTP on testnet is its dev network, with an optional gateway; off ignores a gateway (with a warning)", () => {
    expect(hostSettings(env({ XMTP: "on" }), testnetAssets()).xmtp).toEqual({ env: "dev" });
    expect(hostSettings(env({ XMTP: "ON", XMTP_GATEWAY_HOST: "https://gw.example.org" }), testnetAssets()).xmtp).toEqual({ env: "dev", gatewayHost: "https://gw.example.org" });
    const off = hostSettings(env({ XMTP_GATEWAY_HOST: "https://gw.example.org" }), testnetAssets());
    expect(off.xmtp).toBeUndefined();
    expect(off.warnings.join()).toMatch(/XMTP_GATEWAY_HOST is set but XMTP is off/);
    expect(refusal(() => hostSettings(env({ XMTP: "yes" }), testnetAssets()))).toMatch(/^XMTP must be "on" or "off"/);
  });

  it("ARENA_CLI_VERSION overrides the image's version; it must be plain x.y.z", () => {
    expect(hostSettings(env({ ARENA_CLI_VERSION: "0.2.3" }), testnetAssets()).cli).toEqual({ package: "arc-chess", version: "0.2.3" });
    for (const bad of ["latest", "0.1", "^0.1.0", "0.1.0-rc.1"]) {
      expect(refusal(() => hostSettings(env({ ARENA_CLI_VERSION: bad }), testnetAssets()))).toMatch(/^ARENA_CLI_VERSION must be a plain x\.y\.z/);
    }
  });

  it("HOST_OPERATOR: up to 40 plain characters, quoted in the audit text", () => {
    expect(hostSettings(env({ HOST_OPERATOR: "Lev's arena (lev@example.org)" }), testnetAssets()).operator).toBe("Lev's arena (lev@example.org)");
    for (const bad of ["x".repeat(41), "a‮b", "line\nbreak", "<b>"]) {
      expect(refusal(() => hostSettings(env({ HOST_OPERATOR: bad }), testnetAssets()))).toMatch(/^HOST_OPERATOR must be/);
    }
  });

  it("SERVER_LIMITS, INDEXER_POLL_MS, INDEXER_CHUNK_BLOCKS and TRUST_PROXY", () => {
    const s = hostSettings(
      env({ SERVER_LIMITS: '{"maxOpenOffersPerIp": 10, "wsPerIp": 32}', INDEXER_POLL_MS: "5000", INDEXER_CHUNK_BLOCKS: "2000", TRUST_PROXY: "true" }),
      testnetAssets(),
    );
    expect(s.limits.maxOpenOffersPerIp).toBe(10);
    expect(s.limits.wsPerIp).toBe(32);
    expect(s.limits.httpGetBurst).toBe(120);
    expect(s.indexer).toEqual({ pollMs: 5000, chunkBlocks: 2000 });
    expect(s.trustProxy).toBe(true);
    expect(refusal(() => hostSettings(env({ SERVER_LIMITS: '{"nope": 1}' }), testnetAssets()))).toMatch(/unknown limit "nope"/);
    expect(refusal(() => hostSettings(env({ SERVER_LIMITS: '{"wsPerIp": 0}' }), testnetAssets()))).toMatch(/wsPerIp must be a positive whole number/);
    expect(refusal(() => hostSettings(env({ SERVER_LIMITS: "[1]" }), testnetAssets()))).toMatch(/SERVER_LIMITS must be a JSON object/);
    expect(refusal(() => hostSettings(env({ INDEXER_CHUNK_BLOCKS: "0" }), testnetAssets()))).toMatch(/INDEXER_CHUNK_BLOCKS must be a whole number/);
    expect(refusal(() => hostSettings(env({ TRUST_PROXY: "1" }), testnetAssets()))).toMatch(/TRUST_PROXY must be/);
  });
});

describe("hostServerConfig (what the server runs with)", () => {
  it("passes the server's own validation: the pinned CLI command, the deploy block, no faucet, no tarball", () => {
    const cfg = parseServerConfig(hostServerConfig(hostSettings(env({ TRUST_PROXY: "true" }), testnetAssets()), HUB));
    expect(cfg).toMatchObject({
      host: "0.0.0.0",
      port: 3000,
      publicUrl: "https://arena.operator.dev",
      chainId: 5042002,
      hub: TESTNET_HUB,
      rules: TESTNET_RULES,
      usdc: ARC_USDC,
      dbPath: "/data/arena.sqlite",
      cliCommand: "npx -y arc-chess@0.1.0",
      cli: { package: "arc-chess", version: "0.1.0" },
      trustProxy: true,
      devFaucet: false,
    });
    expect(cfg.indexer.startBlock).toBe(69_112_538n);
    expect(cfg.cliTarball).toBeUndefined();
    expect(cfg.xmtp).toBeUndefined();
  });

  it("the audit text: unaudited, the operator, the network, the shared hub's limits -- at most 300 characters", () => {
    const s = hostSettings(env({ HOST_OPERATOR: "Example Arena Co." }), testnetAssets());
    expect(hostAudit(s, HUB)).toBe(
      "unaudited; self-hosted arena host, operator: Example Arena Co.; Arc TESTNET, faucet USDC only. Shared hub: " +
        "its fee goes to the hub's fee recipient, not to this host, and its limits (10 USDC deposit per player, 1000 USDC " +
        "total escrow) are the same on every host",
    );
    // `fund` quotes at most 300 characters of it (packages/cli/src/funding.ts): the longest operator and large limits fit.
    for (const network of Object.keys(HOST_NETWORKS) as Array<keyof typeof HOST_NETWORKS>) {
      const audit = hostAudit({ network, operator: "W".repeat(40) }, { ...HUB, maxDepositPerPlayer: 123_456_789_000_000n, maxCommittedEscrow: 987_654_321_000_000n });
      expect(audit.length).toBeLessThanOrEqual(300);
    }
    expect(hostAudit({ network: "arc-mainnet", operator: "x" }, HUB)).toContain("Arc mainnet, real USDC");
  });
});

// ------------------------------------------------------------------------------------------ hostMain

/** A JSON-RPC stub answering as an Arc testnet node with the hub's fee and limits; counts what it is asked. */
async function stubRpc(chainId = 5042002): Promise<{ url: string; calls: string[]; close(): Promise<void> }> {
  const calls: string[] = [];
  const results: Record<string, `0x${string}`> = {};
  const fn = (functionName: string, result: unknown) =>
    encodeFunctionResult({ abi: channelHubAbi, functionName: functionName as never, result: result as never });
  const values: Array<[string, unknown]> = [
    ["feePerPlayer", 5_000n],
    ["feeRecipient", `0x${"fe".repeat(20)}`],
    ["maxDepositPerPlayer", 2_000_000n],
    ["maxCommittedEscrow", 50_000_000n],
    ["committedEscrow", 0n],
    ["paused", false],
  ];
  for (const [name, value] of values) results[toFunctionSelector(`${name}()`)] = fn(name, value);
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const reqs = JSON.parse(body) as { id: number; method: string; params: unknown[] } | Array<{ id: number; method: string; params: unknown[] }>;
      const one = (r: { id: number; method: string; params: unknown[] }) => {
        calls.push(r.method);
        if (r.method === "eth_chainId") return { jsonrpc: "2.0", id: r.id, result: `0x${chainId.toString(16)}` };
        if (r.method === "eth_blockNumber") return { jsonrpc: "2.0", id: r.id, result: "0x100" };
        if (r.method === "eth_call") {
          const data = (r.params[0] as { data: string }).data.slice(0, 10);
          return { jsonrpc: "2.0", id: r.id, result: results[data] ?? "0x" };
        }
        return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "not in this stub" } };
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(reqs) ? reqs.map(one) : one(reqs)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

describe("hostMain (the image's entry point)", () => {
  let lines: string[] = [];
  const stubs: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    lines = [];
    for (const s of stubs.splice(0)) await s.close();
  });
  const captureLog = () => vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));

  it("refuses NETWORK=arc-mainnet before any RPC call, and exits 1", async () => {
    const rpc = await stubRpc(5042);
    stubs.push(rpc);
    captureLog();
    const code = await hostMain(["print-config"], env({ NETWORK: "arc-mainnet", RPC_URL: rpc.url }), testnetAssets());
    expect(code).toBe(1);
    expect(rpc.calls).toEqual([]);
    expect(JSON.parse(lines[0]!).msg).toMatch(/^refusing to start: NETWORK=arc-mainnet: this image cannot serve Arc mainnet/);
  });

  it("print-config: checks both RPCs' chain id, reads the hub, prints the config with the keyed RPC_URL redacted", async () => {
    const rpc = await stubRpc();
    stubs.push(rpc);
    captureLog();
    const code = await hostMain(
      ["print-config"],
      env({ RPC_URL: `${rpc.url}/v2/SECRETKEY`, PUBLIC_RPC_URL: `${rpc.url}/`, HOST_OPERATOR: "tester" }),
      testnetAssets(),
    );
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).not.toContain("SECRETKEY");
    const printed = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    expect(printed.rpcUrl).toBe(rpc.url);
    expect(printed.publicRpcUrl).toBe(`${rpc.url}/`);
    expect(printed.cliCommand).toBe("npx -y arc-chess@0.1.0");
    expect(printed.indexer).toMatchObject({ startBlock: "69112538" });
    expect(printed.audit).toBe(
      "unaudited; self-hosted arena host, operator: tester; Arc TESTNET, faucet USDC only. Shared hub: its fee goes to " +
        "the hub's fee recipient, not to this host, and its limits (2 USDC deposit per player, 50 USDC total escrow) are the same on every host",
    );
    expect(rpc.calls.filter((m) => m === "eth_chainId").length).toBeGreaterThanOrEqual(2);
  });

  it("refuses an RPC_URL that serves another chain, without quoting its key", async () => {
    const rpc = await stubRpc(5042);
    stubs.push(rpc);
    captureLog();
    const code = await hostMain(["print-config"], env({ RPC_URL: `${rpc.url}/v2/SECRETKEY` }), testnetAssets());
    expect(code).toBe(1);
    const text = lines.join("\n");
    expect(text).not.toContain("SECRETKEY");
    expect(text).toMatch(/RPC_URL \(http:\/\/127\.0\.0\.1:\d+\) serves chain 5042, but NETWORK=arc-testnet is chain 5042002/);
  });

  it("refuses an unknown command and a bad setting with exit codes 2 and 1", async () => {
    captureLog();
    expect(await hostMain(["serve-forever"], env(), testnetAssets())).toBe(2);
    expect(await hostMain([], {}, testnetAssets())).toBe(1);
    expect(lines.at(-1)).toMatch(/refusing to start: DOMAIN is required/);
  });
});
