/**
 * T5b: `scripts/testnet-up.ts` (`pnpm testnet:up` / `testnet:down` / `<dir>/human/pay`). Nothing here touches Arc: the
 * chain-id refusals run against local Anvils (ports 8700-8799) and a stub RPC, and the pay helper runs against a local
 * Anvil through the script's test hook (`ARENA_TESTNET_TEST_OVERRIDE`, honoured only for a loopback Anvil at chain
 * 31337), with a throwaway key in a temporary key file shaped like the real one.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpRequestError, TransactionReceiptNotFoundError, createPublicClient, http, parseUnits, type Address, type Hex, type TransactionReceipt } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { cliTarballCommand, parseServerConfig } from "../../apps/server/src/config.js";
import { startServer, type ArenaServer } from "../../apps/server/src/server.js";
import { FakeChain, testConfig } from "../../apps/server/test/helpers/fakeChain.js";
import {
  CHAIN_ID,
  DEPLOYER,
  PAY_RECEIPT_TIMEOUT_MS,
  FORBIDDEN_PORTS,
  RPC_URL,
  TESTNET_SERVER_LIMITS,
  agentNotes,
  agentPrompt,
  assertChain,
  assertTestnetDir,
  botHomeProblems,
  buildCliTarball,
  buildServerConfig,
  checkPayRequest,
  hideDirRpcs,
  hideUrl,
  holdingsWei,
  hostNetwork,
  hostNotLocal,
  hostProblem,
  hubPinProblem,
  isOurs,
  lanWarning,
  openNeedWei,
  parseDownArgs,
  payUnconfirmed,
  parseUpArgs,
  procStartTime,
  readDeployment,
  redact,
  shownUrl,
  testOverride,
  testnetChildEnv,
  topUpAmount,
  unlessExits,
  waitForPayReceipt,
  writePayWrapper,
} from "../../scripts/testnet-up.js";
import { isRefusalBeforeSend } from "../../scripts/claude-human-watcher.js";
import { freeTcpPort, isPortFree } from "./harness.js";

const REPO_ROOT = join(import.meta.dirname, "../..");
const TSX_BIN = join(REPO_ROOT, "node_modules/.bin/tsx");
const SCRIPT = join(REPO_ROOT, "scripts/testnet-up.ts");
const SERVER_BIN = join(REPO_ROOT, "apps/server/bin/arena-server.mjs");
const CLI_BIN = join(REPO_ROOT, "packages/cli/bin/arena.mjs");
const ANVIL = join(homedir(), ".foundry/bin/anvil");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const tmpRoots: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "arena-testnet-up-"));
  tmpRoots.push(d);
  return d;
}

const anvils: ChildProcess[] = [];
const usedPorts = new Set<number>();

/** A local Anvil at `chainId` on a free port in 8700-8799 (never a port any other suite or stack uses). */
async function startAnvil(chainId: number): Promise<{ url: string; port: number; child: ChildProcess }> {
  for (let port = 8700; port < 8800; port++) {
    if (usedPorts.has(port) || !(await isPortFree(port))) continue;
    usedPorts.add(port);
    const child = spawn(ANVIL, ["--port", String(port), "--chain-id", String(chainId), "--silent"], { stdio: "ignore" });
    anvils.push(child);
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      try {
        await rawRpc(url, "eth_chainId");
        return { url, port, child };
      } catch {
        await sleep(100);
      }
    }
    throw new Error(`anvil on ${port} did not start`);
  }
  throw new Error("no free port in 8700-8799");
}

async function rawRpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "rpc error");
  return body.result;
}

const extraChildren: ChildProcess[] = [];

afterEach(() => {
  for (const c of extraChildren.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
});

afterAll(() => {
  for (const a of anvils) if (a.exitCode === null && a.signalCode === null) a.kill("SIGKILL");
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------- arguments

describe("testnet:up arguments", () => {
  it("defaults: port 8090, two bots of 2.5 USDC, deposit 1, stake 0.1, .arena-testnet", () => {
    const a = parseUpArgs([]);
    expect(a).toEqual({
      port: 8090,
      host: "127.0.0.1",
      allowLan: false,
      rpc: "https://rpc.testnet.arc.io",
      publicRpc: "https://rpc.testnet.arc.io",
      houseBots: 2,
      botUsdc: "2.5",
      botDeposit: "1",
      botStake: "0.1",
      xmtpBots: false,
      limits: {},
      dir: join(REPO_ROOT, ".arena-testnet"),
    });
  });

  it("takes every flag", () => {
    const a = parseUpArgs([
      "--port", "8095", "--host", "100.70.62.92", "--rpc", "https://example.invalid/arc-testnet/KEY", "--public-rpc", "https://example.invalid/public",
      "--house-bots", "4", "--bot-usdc", "1.25", "--bot-deposit", "0.5", "--bot-stake", "0.05",
      "--bot-timeout", "300", "--xmtp-bots", "--allow-lan", "--limits", '{"maxOpenOffersPerIp": 10, "wsPerIp": 40}', "--start-block", "68000000",
      "--dir", "/tmp/x",
    ]);
    expect(a).toEqual({
      port: 8095, host: "100.70.62.92", allowLan: true, rpc: "https://example.invalid/arc-testnet/KEY", publicRpc: "https://example.invalid/public", houseBots: 4,
      botUsdc: "1.25", botDeposit: "0.5", botStake: "0.05", botTimeout: 300, xmtpBots: true,
      limits: { maxOpenOffersPerIp: 10, wsPerIp: 40 }, startBlock: 68_000_000n, dir: "/tmp/x",
    });
    expect(parseUpArgs(["--bot-usdc", "0"]).botUsdc).toBe("0"); // 0: fund nothing
  });

  it("refuses every reserved port, whatever the reason it is reserved", () => {
    for (const p of [8545, 8080, 7070, 8546, 8650, 8651, 8652, 8653, 8660, 8760]) {
      expect(FORBIDDEN_PORTS.has(p)).toBe(true);
      expect(() => parseUpArgs(["--port", String(p)])).toThrow(/reserved/);
    }
  });

  it("refuses malformed, out-of-range and unknown arguments", () => {
    expect(() => parseUpArgs(["--port", "80"])).toThrow(/between/);
    expect(() => parseUpArgs(["--port", "x"])).toThrow(/whole number/);
    expect(() => parseUpArgs(["--house-bots", "11"])).toThrow(/between 0 and 10/);
    expect(() => parseUpArgs(["--bot-usdc", "3.000001"])).toThrow(/at most 3/);
    expect(() => parseUpArgs(["--bot-usdc", "1.1234567"])).toThrow(/6 decimal/);
    expect(() => parseUpArgs(["--bot-stake", "0"])).toThrow(/greater than 0/);
    expect(() => parseUpArgs(["--start-block", "-1"])).toThrow(/block number/);
    expect(() => parseUpArgs(["--house-bot", "1"])).toThrow(/unknown argument/);
    expect(() => parseUpArgs(["--port"])).toThrow(/needs a value/);
    expect(() => parseUpArgs(["--rpc", "rpc.testnet.arc.io"])).toThrow(/must be a URL/);
    expect(() => parseUpArgs(["--public-rpc", "ftp://x"])).toThrow(/--public-rpc must be an http\(s\) URL/);
    expect(() => parseUpArgs(["--limits", "{"])).toThrow(/JSON object/);
    expect(() => parseUpArgs(["--limits", "[1]"])).toThrow(/JSON object/);
    expect(() => parseUpArgs(["--limits", '{"maxOffers": 3}'])).toThrow(/unknown server limit "maxOffers"/);
    expect(() => parseUpArgs(["--limits", '{"wsPerIp": 0}'])).toThrow(/positive whole number/);
    expect(() => parseUpArgs(["--limits", '{"wsPerIp": 1.5}'])).toThrow(/positive whole number/);
    expect(() => parseUpArgs(["--rpc", "ws://127.0.0.1:1"])).toThrow(/http\(s\) URL/);
  });

  it("remote agents: --host takes loopback and Tailscale; a LAN only with --allow-lan; never a public address", () => {
    for (const ok of ["127.0.0.1", "127.0.0.2", "100.70.62.92", "100.64.0.0", "100.127.255.255"]) {
      expect(hostProblem(ok), ok).toBeNull();
      expect(parseUpArgs(["--host", ok]).host).toBe(ok);
    }
    // Fix round 1 (I-1): RFC 1918 is plain, unauthenticated http on a shared network -- the owner's explicit choice only.
    for (const lan of ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.254", "192.168.50.102"]) {
      expect(hostProblem(lan), lan).toMatch(
        new RegExp(`^--host ${lan.replace(/\./g, "\\.")} is a LAN address: over a LAN everything this stack serves .* anyone on that network can replace the CLI the agents run .* pass --allow-lan to accept that$`),
      );
      expect(() => parseUpArgs(["--host", lan]), lan).toThrow(/is a LAN address/);
      expect(hostProblem(lan, true), lan).toBeNull();
      expect(parseUpArgs(["--host", lan, "--allow-lan"])).toMatchObject({ host: lan, allowLan: true });
    }
    for (const bad of ["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.1", "192.169.0.1", "11.0.0.1", "169.254.1.1", "224.0.0.1", "255.255.255.255"]) {
      for (const allowLan of [false, true]) {
        expect(hostProblem(bad, allowLan), bad).toMatch(/is not a private address: only loopback \(127\.0\.0\.0\/8\) and Tailscale \(100\.64\.0\.0\/10\) are allowed, and with --allow-lan/);
      }
      expect(() => parseUpArgs(["--host", bad, "--allow-lan"]), bad).toThrow(/is not a private address/);
    }
    expect(() => parseUpArgs(["--host", "0.0.0.0", "--allow-lan"])).toThrow(/every interface, public ones included/);
    for (const bad of ["::1", "fd7a:115c:a1e0::1", "localhost", "my-box.tailnet.ts.net", "100.70.62.092", "100.70.62", ""]) {
      expect(() => parseUpArgs(["--host", bad]), bad).toThrow(/--host must be an IPv4 address|needs a value/);
    }
  });

  const IFACES = {
    lo: [{ address: "127.0.0.1", family: "IPv4" }],
    tailscale0: [{ address: "100.70.62.92", family: "IPv4" }, { address: "fd7a::1", family: "IPv6" }],
    wwan0: [{ address: "100.80.1.2", family: "IPv4" }], // a carrier's CGNAT address, in the same 100.64/10 range
    enp0s31f6: [{ address: "192.168.50.102", family: "IPv4" }],
  } as unknown as Parameters<typeof hostNotLocal>[1];

  it("remote agents: --host must be one of this machine's addresses (loopback always is)", () => {
    expect(hostNotLocal("100.70.62.92", IFACES)).toBeNull();
    expect(hostNotLocal("127.0.0.5", IFACES)).toBeNull();
    expect(hostNotLocal("100.70.62.93", IFACES)).toBe(
      "refusing: --host 100.70.62.93 is not an address of this machine (its IPv4 addresses: 127.0.0.1, 100.70.62.92, 100.80.1.2, 192.168.50.102). Nothing was started",
    );
  });

  it("fix round 1 (I-1): a 100.64/10 address counts as the tailnet only on a tailscale* interface; elsewhere it needs --allow-lan", () => {
    expect(hostNetwork("127.0.0.1", IFACES)).toBe("loopback");
    expect(hostNetwork("100.70.62.92", IFACES)).toBe("tailnet");
    expect(hostNetwork("100.80.1.2", IFACES)).toBe("lan");
    expect(hostNetwork("192.168.50.102", IFACES)).toBe("lan");
    expect(hostNotLocal("100.80.1.2", IFACES)).toMatch(
      /^refusing: --host 100\.80\.1\.2 is on wwan0, not a Tailscale interface: a 100\.64\.0\.0\/10 address there is a carrier's CGNAT address, not your tailnet, .* pass --allow-lan to accept that\. Nothing was started$/,
    );
    expect(hostNotLocal("100.80.1.2", IFACES, true)).toBeNull();
    expect(hostNotLocal("192.168.50.102", IFACES, true)).toBeNull();
  });

  it("fix round 1 (I-1): --allow-lan's warning says the CLI can be replaced, that the sha256 cannot catch it, and what to use instead", () => {
    const w = lanWarning("192.168.50.102").join("\n");
    expect(w).toContain("WARNING (--allow-lan): agents reach this stack at 192.168.50.102, on a LAN, over plain, unauthenticated http.");
    expect(w).toContain("Anyone on that network can rewrite skill.md, /templates and the CLI tarball");
    expect(w).toContain("skill.md's sha256 cannot catch it: it arrives over the same channel");
    expect(w).toContain("--host $(tailscale ip -4)");
  });

  it("down: --withdraw and --dir only", () => {
    expect(parseDownArgs([])).toEqual({ withdraw: false, settleSeconds: 120, dir: join(REPO_ROOT, ".arena-testnet") });
    expect(parseDownArgs(["--withdraw", "--settle-seconds", "0", "--dir", "/tmp/y"])).toEqual({ withdraw: true, settleSeconds: 0, dir: "/tmp/y" });
    expect(() => parseDownArgs(["--settle-seconds", "4000"])).toThrow(/between 0 and 3600/);
    expect(() => parseDownArgs(["--force"])).toThrow(/unknown argument/);
  });

  it("top-ups reach the target and never exceed it", () => {
    const usdc = (s: string) => parseUnits(s, 18);
    expect(topUpAmount(0n, usdc("2.5"))).toBe("2.5");
    expect(topUpAmount(usdc("1"), usdc("2.5"))).toBe("1.5");
    expect(topUpAmount(usdc("2.5"), usdc("2.5"))).toBeNull();
    expect(topUpAmount(usdc("3"), usdc("2.5"))).toBeNull(); // never takes money back, never adds above
    expect(topUpAmount(usdc("2.4995"), usdc("2.5"))).toBeNull(); // dust
    expect(topUpAmount(usdc("1") + 1n, usdc("2.5"))).toBe("1.5"); // rounded up to 6 decimals: never short
    expect(topUpAmount(usdc("1") - 1n, usdc("2.5"))).toBe("1.500001");
  });
});

// ------------------------------------------------------------------------------------------- chain id

describe("the chain-id refusal", () => {
  let stub: Server;
  let stubUrl: string;
  let answer: unknown = "0x4cef52";

  beforeAll(async () => {
    stub = createHttpServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: answer }));
      });
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
    const addr = stub.address();
    stubUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => new Promise<void>((r) => stub.close(() => r())));

  it("accepts Arc testnet (0x4cef52) and nothing else; mainnet is refused by name", async () => {
    answer = "0x4cef52";
    await expect(assertChain(stubUrl)).resolves.toBeUndefined();
    answer = "0x13b2"; // 5042, Arc mainnet
    await expect(assertChain(stubUrl)).rejects.toThrow(/Arc MAINNET \(chain 5042\)/);
    for (const other of ["0x7a69", "0x1", "0x4cef53", "0x0"]) {
      answer = other;
      await expect(assertChain(stubUrl)).rejects.toThrow(/refusing: .* is chain \d+, not Arc testnet/);
    }
    for (const bad of [null, 5042002, "4cef52", "0x", "garbage"]) {
      answer = bad;
      await expect(assertChain(stubUrl)).rejects.toThrow(/malformed eth_chainId/);
    }
  });

  it("refuses to even ask for mainnet: an expected chain of 5042 is itself refused", async () => {
    answer = "0x13b2";
    await expect(assertChain(stubUrl, 5042)).rejects.toThrow(/never runs against Arc MAINNET/);
  });

  it("an unreachable RPC is a refusal, not a crash", async () => {
    await expect(assertChain("http://127.0.0.1:1")).rejects.toThrow(/refusing: cannot read eth_chainId/);
  });

  /** Runs `testnet:up` itself against `rpcUrl` (`--rpc`). */
  function runUp(rpcUrl: string, dir: string, port: number) {
    return spawnSync(TSX_BIN, [SCRIPT, "--rpc", rpcUrl, "--public-rpc", rpcUrl, "--port", String(port), "--house-bots", "0", "--dir", dir], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
  }

  it(
    "testnet:up refuses Anvil (31337) and a chain claiming 5042, before it creates or starts anything",
    async () => {
      for (const [chainId, re] of [
        [31337, /refusing: .* is chain 31337, not Arc testnet/],
        [5042, /Arc MAINNET \(chain 5042\)/],
      ] as const) {
        const anvil = await startAnvil(chainId);
        const dir = join(tmpRoot(), "state");
        const port = await freeTcpPort(); // ephemeral: never a reserved one
        expect(await isPortFree(port)).toBe(true);
        const r = runUp(anvil.url, dir, port);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(re);
        expect(existsSync(dir)).toBe(false); // nothing created
        expect(await isPortFree(port)).toBe(true); // nothing started
        anvil.child.kill("SIGKILL");
      }
    },
    90_000,
  );

  it(
    "a chain that does answer 5042002 but holds no deployment is refused at the code check, still touching nothing",
    async () => {
      const anvil = await startAnvil(CHAIN_ID);
      const dir = join(tmpRoot(), "state");
      const port = await freeTcpPort();
      const r = runUp(anvil.url, dir, port);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/refusing: the hub 0x[0-9a-fA-F]{40} holds no code/);
      expect(existsSync(dir)).toBe(false);
      expect(await isPortFree(port)).toBe(true);
      anvil.child.kill("SIGKILL");
    },
    60_000,
  );

  it("the test hook only ever points at a loopback Anvil at 31337", () => {
    expect(testOverride({})).toBeUndefined();
    expect(() => testOverride({ ARENA_TESTNET_TEST_OVERRIDE: "{" })).toThrow(/not JSON/);
    expect(() => testOverride({ ARENA_TESTNET_TEST_OVERRIDE: JSON.stringify({ rpcUrl: RPC_URL }) })).toThrow(/loopback/);
    expect(() => testOverride({ ARENA_TESTNET_TEST_OVERRIDE: JSON.stringify({ rpcUrl: "http://10.0.0.1:8545" }) })).toThrow(/loopback/);
    for (const chainId of [5042, 5042002, 1, undefined]) {
      expect(() => testOverride({ ARENA_TESTNET_TEST_OVERRIDE: JSON.stringify({ rpcUrl: "http://127.0.0.1:8701", chainId, keyFile: "/k" }) })).toThrow(
        /must be 31337/,
      );
    }
    // m-1: no keyFile, no hook -- it never falls back to the real key file.
    expect(() => testOverride({ ARENA_TESTNET_TEST_OVERRIDE: JSON.stringify({ rpcUrl: "http://127.0.0.1:8701", chainId: 31337 }) })).toThrow(
      /keyFile is required: the hook never opens the real key file/,
    );
    expect(testOverride({ ARENA_TESTNET_TEST_OVERRIDE: JSON.stringify({ rpcUrl: "http://127.0.0.1:8701", chainId: 31337, keyFile: "/k" }) })).toEqual({
      rpcUrl: "http://127.0.0.1:8701/",
      chainId: 31337,
      keyFile: "/k",
    });
  });

  it("messages show an RPC's scheme and host only: a provider key in the path never appears", () => {
    expect(shownUrl("https://arc-testnet.example/v2/SECRETKEY")).toBe("https://arc-testnet.example/…");
    expect(shownUrl("https://arc-testnet.example/?apikey=SECRETKEY")).toBe("https://arc-testnet.example/…");
    expect(shownUrl("https://rpc.testnet.arc.io")).toBe("https://rpc.testnet.arc.io");
    expect(shownUrl("not a url")).toBe("(an RPC URL)");
  });

  it("a registered --rpc is hidden in any message, viem's own included", () => {
    const keyed = "https://arc-testnet.example/v2/SECRETKEY";
    hideUrl(keyed);
    hideUrl(RPC_URL); // the public one is never hidden
    const viemLike = `HTTP request failed.\n\nURL: ${keyed}\nRequest body: {"method":"eth_getCode"}\n\nVersion: viem@2.56.8`;
    expect(redact(viemLike)).not.toContain("SECRETKEY");
    expect(redact(viemLike)).toContain("URL: https://arc-testnet.example/…");
    expect(redact(`see ${RPC_URL}`)).toBe(`see ${RPC_URL}`);
  });

  it("follow-up 3: down hides the RPCs its directory's server and bot homes use", () => {
    const dir = tmpRoot();
    mkdirSync(join(dir, "house-bots", "house-1"), { recursive: true });
    mkdirSync(join(dir, "house-bots", "house-2"), { recursive: true });
    writeFileSync(join(dir, "server.json"), JSON.stringify({ rpcUrl: "https://keyed.example/v2/SERVERKEY" }));
    writeFileSync(join(dir, "house-bots", "house-1", "config.json"), JSON.stringify({ rpcUrl: "https://other.example/?k=BOTKEY" }));
    writeFileSync(join(dir, "house-bots", "house-2", "config.json"), "{not json"); // skipped, not fatal
    hideDirRpcs(dir);
    const tail = "error: HTTP request failed. URL: https://keyed.example/v2/SERVERKEY ... URL: https://other.example/?k=BOTKEY";
    expect(redact(tail)).not.toMatch(/SERVERKEY|BOTKEY/);
    expect(redact(tail)).toContain("URL: https://keyed.example/…");
  });

  it("an unreachable keyed RPC is refused without quoting its key", async () => {
    await expect(assertChain("http://127.0.0.1:1/v2/SECRETKEY")).rejects.toThrow(/^(?!.*SECRETKEY).*cannot read eth_chainId from http:\/\/127\.0\.0\.1:1\/…/s);
  });
});

// ------------------------------------------------------------------------------------------ server config

describe("the server config", () => {
  it("is Arc testnet, the deployments file's contracts, no faucet, XMTP dev, local only", () => {
    const deployment = readDeployment();
    const file = JSON.parse(readFileSync(join(REPO_ROOT, "contracts/deployments/5042002.json"), "utf8")) as Record<string, string>;
    expect(deployment.hub.toLowerCase()).toBe(file.channelHub!.toLowerCase());
    const raw = buildServerConfig({
      dir: "/x/.arena-testnet",
      port: 8090,
      rpcUrl: "https://keyed.example/v2/SECRETKEY",
      publicRpcUrl: RPC_URL,
      deployment,
      limits: { maxDepositPerPlayer: 2_000_000n, maxCommittedEscrow: 50_000_000n, feePerPlayer: 5_000n },
      startBlock: 68_879_000n,
      cliCommand: "/x/.arena-testnet/bin/arena",
      deposit: "1",
      stake: "0.1",
    });
    expect(raw).not.toHaveProperty("faucet");
    // It is exactly what the server itself accepts.
    const cfg = parseServerConfig(JSON.parse(JSON.stringify(raw)));
    expect(cfg.chainId).toBe(5042002);
    expect(cfg.hub.toLowerCase()).toBe(file.channelHub!.toLowerCase());
    expect(cfg.rules.toLowerCase()).toBe(file.chessRules!.toLowerCase());
    expect(cfg.usdc.toLowerCase()).toBe(file.token!.toLowerCase());
    expect(cfg.devFaucet).toBe(false);
    expect(cfg.xmtp).toEqual({ env: "dev" });
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(8090);
    expect(cfg.publicUrl).toBe("http://127.0.0.1:8090");
    // m-10: the host's own (keyed) RPC stays private; /templates publishes publicRpcUrl.
    expect(cfg.rpcUrl).toBe("https://keyed.example/v2/SECRETKEY");
    expect(cfg.publicRpcUrl).toBe("https://rpc.testnet.arc.io");
    expect(cfg.cliCommand).toBe("/x/.arena-testnet/bin/arena");
    expect(cfg.dbPath).toBe("/x/.arena-testnet/server.sqlite");
    expect(cfg.indexer.startBlock).toBe(68_879_000n);
    expect(cfg.defaults).toEqual({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 900n });
    expect(cfg.audit).toMatch(/^unaudited; Arc TESTNET/);
    expect(cfg.audit).toMatch(/2 USDC deposit per player, 50 USDC total committed escrow; fee 0.005 USDC/);
    expect(cfg.trustProxy).toBe(false);
    // I-2: per-IP limits sized for a loopback-only server shared by ~10 bots and ~20 agents.
    expect(cfg.limits).toMatchObject(TESTNET_SERVER_LIMITS);
    expect(cfg.limits.maxOpenOffersPerIp).toBeGreaterThanOrEqual(30);
    expect(cfg.limits.wsPerIp).toBeGreaterThanOrEqual(64);
    expect(cfg.limits.httpPostPerSec).toBeGreaterThanOrEqual(20);
  });

  it("--limits overrides the testnet limits, and the rest stay the server's defaults", () => {
    const raw = buildServerConfig({
      dir: "/x",
      port: 8090,
      rpcUrl: RPC_URL,
      publicRpcUrl: RPC_URL,
      deployment: readDeployment(),
      limits: { maxDepositPerPlayer: 2_000_000n, maxCommittedEscrow: 50_000_000n, feePerPlayer: 5_000n },
      serverLimits: { maxOpenOffersPerIp: 7, maxFrameBytes: 32_768 },
      startBlock: 1n,
      cliCommand: "arena",
      deposit: "1",
      stake: "0.1",
    });
    const cfg = parseServerConfig(JSON.parse(JSON.stringify(raw)));
    expect(cfg.limits.maxOpenOffersPerIp).toBe(7);
    expect(cfg.limits.maxFrameBytes).toBe(32_768);
    expect(cfg.limits.wsPerIp).toBe(TESTNET_SERVER_LIMITS.wsPerIp);
    expect(cfg.limits.maxJoinsPerConnection).toBe(64); // the server's own default
  });

  it("remote agents: --host listens on 127.0.0.1 and the private address, publishes the latter, and serves the CLI tarball", () => {
    const common = {
      dir: "/x/.arena-testnet",
      port: 8700,
      rpcUrl: RPC_URL,
      publicRpcUrl: RPC_URL,
      deployment: readDeployment(),
      limits: { maxDepositPerPlayer: 2_000_000n, maxCommittedEscrow: 50_000_000n, feePerPlayer: 5_000n },
      startBlock: 1n,
      deposit: "1",
      stake: "0.1",
    };
    const sha256 = "ab".repeat(32);
    const cli = { path: "/x/.arena-testnet/cli/arena-cli-0.1.0-0123456789abcdef.tgz", sha256, package: "@arena/cli", version: "0.1.0" };
    const cfg = parseServerConfig(JSON.parse(JSON.stringify(buildServerConfig({ ...common, host: "100.70.62.92", cli }))));
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.extraHosts).toEqual(["100.70.62.92"]);
    expect(cfg.publicUrl).toBe("http://100.70.62.92:8700");
    expect(cfg.cli).toEqual({ package: "@arena/cli", version: "0.1.0" });
    expect(cfg.cliTarball).toEqual({ path: cli.path, sha256 });
    expect(cfg.cliCommand).toBe("npx -y --prefer-offline --package=http://100.70.62.92:8700/cli/arena-cli-0.1.0-0123456789abcdef.tgz arena");
    expect(cfg.audit).toMatch(/served on 100\.70\.62\.92 \(a private network\) and 127\.0\.0\.1\./);
    // Per-IP limits are unchanged by --host.
    expect(cfg.limits).toMatchObject(TESTNET_SERVER_LIMITS);
    // Without --host: 127.0.0.1 only, as before, and the tarball on that address.
    const local = parseServerConfig(JSON.parse(JSON.stringify(buildServerConfig({ ...common, cli }))));
    expect(local.extraHosts).toBeUndefined();
    expect(local.publicUrl).toBe("http://127.0.0.1:8700");
    expect(local.cliCommand).toBe("npx -y --prefer-offline --package=http://127.0.0.1:8700/cli/arena-cli-0.1.0-0123456789abcdef.tgz arena");
    expect(local.audit).toMatch(/served on 127\.0\.0\.1\. Hub limits/);
  });

  it("m-11: the deployments file must match the CLI's pinned Arc-testnet deployment", () => {
    const d = readDeployment();
    const pinned = { 5042002: { name: "Arc Testnet", hub: d.hub, rules: d.rules, usdc: d.usdc } };
    expect(hubPinProblem(d, pinned)).toBeNull();
    const other = { 5042002: { name: "Arc Testnet", hub: "0x9fcFBAC9FE8Dd64fB4602FB30A1583114Cef6893" as Address, rules: d.rules } };
    expect(hubPinProblem(d, other)).toMatch(/does not match the Arc testnet deployment the CLI pins .*hub .* is not the pinned Arc Testnet hub/);
    // Today's files agree (both are read at run time: a redeploy changes both).
    expect(hubPinProblem(d)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------ house bots

describe("house bots", () => {
  const usdc = (x: string) => parseUnits(x, 18);
  const gas = usdc("0.336");

  it("I-3: a restart mid-game counts the escrow and the session gas, so it pays nothing for them", () => {
    // 2.5 at the start: 1.005 went to the deposit and fee, 0.336 to the session key.
    const wallet = usdc("1.159");
    const midGame = [{ channelId: "0x01", phase: "Open", gameStatus: "playing", balances: { me: "1.000000" }, swept: null }];
    const held = holdingsWei(wallet, midGame, gas, usdc("1"));
    expect(held).toBe(usdc("2.495"));
    // Counting only the wallet re-paid 1.341; now only the fee that left the system (0.005) is due.
    expect(topUpAmount(wallet, usdc("2.5"))).toBe("1.341");
    expect(topUpAmount(held, usdc("2.5"))).toBe("0.005");
    // A bot up 0.3 in its channel is above target: nothing.
    expect(topUpAmount(holdingsWei(wallet, [{ ...midGame[0]!, balances: { me: "1.300000" } }], gas, usdc("1")), usdc("2.5"))).toBeNull();
  });

  it("I-3: settled channels count only their unswept gas", () => {
    const chans = [
      { phase: "Finalized", balances: { me: "1.200000" }, swept: true }, // paid out to the wallet, gas swept back
      { phase: "Finalized", balances: { me: "0.800000" }, swept: null }, // paid out, gas still on its session key
      { phase: "Reclaimed", balances: { me: "1.000000" }, swept: "dust" },
    ];
    expect(holdingsWei(usdc("2"), chans, gas, usdc("1"))).toBe(usdc("2") + gas);
  });

  it("follow-up 1: a channel still in None counts nothing: its deposit is still in the wallet", () => {
    // Matched, not yet created on chain: the genesis balances say 1.0, but that 1.0 is the wallet's own.
    const matched = [{ channelId: "0x04", phase: "None", balances: { me: "1.000000" }, swept: null }];
    expect(holdingsWei(usdc("1.2"), matched, gas, usdc("1"))).toBe(usdc("1.2"));
    expect(topUpAmount(holdingsWei(usdc("1.2"), matched, gas, usdc("1")), usdc("2.5"))).toBe("1.3");
  });

  it("follow-up 2: a degraded channel errs upward -- a full deposit and its session gas count as held", () => {
    const degraded = [{ channelId: "0x05", degraded: true }];
    expect(holdingsWei(usdc("1.159"), degraded, gas, usdc("1"))).toBe(usdc("1.159") + usdc("1") + gas);
    // So a restart with a channel the daemon cannot load never pays that channel's deposit again.
    expect(topUpAmount(holdingsWei(usdc("1.159"), degraded, gas, usdc("1")), usdc("2.5"))).toBe("0.005");
  });

  it("m-6: one more offer needs deposit + fee + session gas + the other channels' reserve (the CLI's own math)", () => {
    const base = { deposit6: 1_000_000n, feePerPlayer6: 5_000n, sessionGasWei: gas, feeCeilingWei: 40_000_000_000n };
    // 1 + 0.005 + ceil((0.336 + 500k gas x 40 gwei = 0.02) / 1e12) = 1.361
    expect(openNeedWei({ ...base, otherChannels: 0 })).toBe(usdc("1.361"));
    expect(openNeedWei({ ...base, otherChannels: 1 })).toBe(usdc("1.697"));
  });

  it("I-1: a --bot-timeout below an existing home's floor is refused before anything starts", () => {
    const hub = "0x9b8Bc44f261D09C94cA17b7b0281DD706f76bA41" as Address;
    const bounds = { min: 60n, max: 86_400n };
    const homes = [
      { name: "house-1", hub, minChallengeTimeout: 900n },
      { name: "house-2", hub, minChallengeTimeout: 300n },
    ];
    const low = botHomeProblems(homes, { hub, botTimeout: 300, bounds });
    expect(low.refusals).toHaveLength(1);
    expect(low.refusals[0]).toMatch(/house-1 was created with a 900 s minimum challenge timeout.*--bot-timeout 300 would stop it/);
    expect(botHomeProblems(homes, { hub, botTimeout: 900, bounds }).refusals).toEqual([]);
    // The converse: no flag, but a home made with 300 posts 300 s offers -- a note, not a refusal.
    const none = botHomeProblems(homes, { hub, bounds });
    expect(none.refusals).toEqual([]);
    expect(none.notes).toEqual([expect.stringMatching(/house-2 posts 300 s offers/)]);
    expect(botHomeProblems([], { hub, botTimeout: 30, bounds }).refusals[0]).toMatch(/outside the hub's 60-86400 s/);
    expect(botHomeProblems([{ name: "house-1", hub: DEPLOYER, minChallengeTimeout: 900n }], { hub, bounds }).refusals[0]).toMatch(
      /house-1 is bound to hub/,
    );
  });

  it("I-1: a bot that exits during startup fails the wait; one that keeps running does not", async () => {
    const dies = spawn(process.execPath, ["-e", "process.exit(2)"], { stdio: "ignore" });
    extraChildren.push(dies);
    await expect(unlessExits(dies, "house bot house-1", sleep(5_000))).rejects.toThrow(
      /house bot house-1 exited while testnet:up was starting \(code=2/,
    );
    // Already exited: refused at once.
    await expect(unlessExits(dies, "house bot house-1", Promise.resolve(1))).rejects.toThrow(/code=2/);
    const lives = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    extraChildren.push(lives);
    await expect(unlessExits(lives, "house bot house-2", sleep(200).then(() => "ok"))).resolves.toBe("ok");
  });

  it("remote agents: the notes under the message -- the network, Node 24, funding from this machine or the faucet, a cash-out line", () => {
    const remote = agentNotes({ publicUrl: "http://100.70.62.92:8090", network: "tailnet", payPath: "/x/.arena-testnet/human/pay" }).join("\n");
    expect(remote).toContain("The agent's machine must reach http://100.70.62.92:8090: it must be on your tailnet.");
    expect(remote).toContain("Node 24 or newer");
    expect(remote).toContain("/x/.arena-testnet/human/pay <its address> <usdc>   (runs on THIS machine; at most 3 per call)");
    expect(remote).toContain("https://faucet.circle.com (choose Arc Testnet) or any Arc-testnet wallet");
    expect(remote).toContain("My Arc testnet address for cash-out is 0x<your address>.");
    expect(remote).toContain("withdraw pays only that owner");
    const local = agentNotes({ publicUrl: "http://127.0.0.1:8090", network: "loopback", payPath: "/x/human/pay" }).join("\n");
    expect(local).toContain("The agent must run on THIS machine: the server listens on loopback only (rerun with --host <your Tailscale IP>");
    const lan = agentNotes({ publicUrl: "http://192.168.50.102:8090", network: "lan", payPath: "/x/human/pay" }).join("\n");
    expect(lan).toContain("it must be on this LAN (see the warning about --allow-lan)");
  });

  it("m-9: the agent prompt names skill.md, its own ARENA_HOME and its own port", () => {
    const p = agentPrompt("http://127.0.0.1:8090", "0.1", 8101);
    expect(p).toBe(
      "Go to http://127.0.0.1:8090 and use your money to play 5 $0.10 games with whoever is available. " +
        "Follow http://127.0.0.1:8090/skill.md; run every arena command with ARENA_HOME=$PWD/arena-home, and pass --port 8101 to arena init.",
    );
  });
});

// -------------------------------------------------------------------------------------------- CLI tarball

describe("remote agents: the CLI tarball the stack serves", () => {
  let server: ArenaServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it(
    "is built once per code, served by the server, and runs from npx with nothing of this repo -- naming itself by the server's own command",
    async () => {
      const root = tmpRoot();
      const port = await freeTcpPort();
      const publicUrl = `http://127.0.0.1:${port}`;
      const served = await buildCliTarball(join(root, "stack"), publicUrl);
      const cliVersion: string = JSON.parse(readFileSync(join(import.meta.dirname, "../../packages/cli/package.json"), "utf8")).version;
      expect(served.path).toMatch(new RegExp(`/cli/arena-cli-${cliVersion.replace(/\./g, "\\.")}-[0-9a-f]{16}\\.tgz$`));
      expect(served).toMatchObject({ package: "@arena/cli", version: cliVersion });
      expect(readdirSync(join(root, "stack", "cli"))).toEqual([served.path.split("/").at(-1)]);
      // The same code and URL give the same tarball: a restart serves the same URL, so agents' installs stay current.
      expect(await buildCliTarball(join(root, "stack"), publicUrl)).toEqual(served);

      const cfg = parseServerConfig(
        JSON.parse(
          JSON.stringify(
            buildServerConfig({
              dir: join(root, "stack"),
              port,
              rpcUrl: RPC_URL,
              publicRpcUrl: RPC_URL,
              deployment: readDeployment(),
              limits: { maxDepositPerPlayer: 2_000_000n, maxCommittedEscrow: 50_000_000n, feePerPlayer: 5_000n },
              startBlock: 1n,
              cli: served,
              deposit: "1",
              stake: "0.1",
            }),
          ),
        ),
      );
      const chain = new FakeChain();
      chain.rpcChainId = CHAIN_ID;
      server = await startServer({ ...testConfig(), ...cfg, dbPath: ":memory:", indexer: { ...cfg.indexer, pollMs: 0 } }, { chain });
      const [t] = (await (await fetch(`${publicUrl}/templates`)).json()) as Array<{ cliTarball: { url: string; sha256: string } }>;
      expect(t!.cliTarball).toEqual({ url: `${publicUrl}/cli/${served.path.split("/").at(-1)}`, sha256: served.sha256 });
      expect(cfg.cliCommand).toBe(cliTarballCommand(t!.cliTarball.url));

      // An agent's machine: a fresh HOME (no npm cache), Node's own directory and the system's on PATH, no
      // ARENA_HOME, a cwd outside the repo, and a registry nobody answers -- the install needs none.
      const home = join(root, "agent-home");
      const work = join(root, "agent-work");
      mkdirSync(home);
      mkdirSync(work);
      const env = {
        HOME: home,
        PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`,
        npm_config_registry: "http://127.0.0.1:9/",
        npm_config_update_notifier: "false",
      };
      const [cmd, ...cmdArgs] = cfg.cliCommand.split(" ");
      // Asynchronous: the server answering it runs in this very process.
      const agent = (args: string[]) =>
        new Promise<{ status: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
          const child = spawn(cmd!, [...cmdArgs, ...args], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
          child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
          const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
          child.once("error", reject);
          child.once("close", (status) => {
            clearTimeout(timer);
            resolvePromise({ status, stdout, stderr });
          });
        });
      const version = await agent(["--version"]);
      expect(version.status, version.stderr).toBe(0);
      expect(version.stdout.trim()).toBe(cliVersion);
      // Its own messages name the server's command, never the placeholder npm package.
      const usage = await agent([]);
      expect(usage.stderr).toContain(`usage: ${cfg.cliCommand} <command>`);
      const wallet = await agent(["wallet"]);
      expect(wallet.stderr).toContain(`run "${cfg.cliCommand} init" first`);
      expect(`${usage.stderr}${wallet.stderr}`).not.toContain("@arena/cli@");
      // Installed from the URL, into npx's own cache under the agent's HOME.
      const installed = readdirSync(join(home, ".npm", "_npx"));
      expect(installed).toHaveLength(1);
      expect(existsSync(join(home, ".npm", "_npx", installed[0]!, "node_modules", "@arena", "cli", "board", "index.html"))).toBe(true);

      // With the host down, the installed copy still runs at once (--prefer-offline): no 70 s of npm retries.
      await server.close();
      server = undefined;
      const started = Date.now();
      const offline = await agent(["--version"]);
      expect(offline.status, offline.stderr).toBe(0);
      expect(Date.now() - started).toBeLessThan(15_000);
    },
    300_000,
  );
});

// --------------------------------------------------------------------------------------------- pay helper

describe("the pay helper", () => {
  let anvil: { url: string; port: number; child: ChildProcess };
  let pub: ReturnType<typeof createPublicClient>;
  let key: Hex;
  let sender: Address;
  let root: string;
  let keyFile: string;
  let payPath: string;
  /** Every byte any pay run printed, checked for the key at the end. */
  const printed: string[] = [];

  /** `a` with the case of its first letter flipped: still an address, but its EIP-55 checksum no longer holds. */
  const typo = (a: string) => {
    const i = [...a].findIndex((ch, j) => j > 1 && /[a-fA-F]/.test(ch));
    const ch = a[i]!;
    return a.slice(0, i) + (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()) + a.slice(i + 1);
  };
  const setBalance = (a: Address, usdc: string) => rawRpc(anvil.url, "anvil_setBalance", [a, `0x${parseUnits(usdc, 18).toString(16)}`]);
  const nonceOf = (a: Address) => pub.getTransactionCount({ address: a, blockTag: "pending" });

  function writeKeyFile(path: string, shape: "array" | "object", withPrefix: boolean, mode = 0o600): void {
    const entry = { address: sender, public_key: "0x04", private_key: withPrefix ? key : key.slice(2) };
    const body = shape === "array" ? { schema_version: 1, success: true, data: [entry], errors: [], warnings: [] } : { data: entry };
    writeFileSync(path, JSON.stringify(body));
    chmodSync(path, mode);
  }

  function runPay(args: string[], override: Record<string, unknown> = { rpcUrl: anvil.url, chainId: 31337, keyFile }) {
    const r = spawnSync(payPath, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ARENA_TESTNET_TEST_OVERRIDE: JSON.stringify(override) },
      encoding: "utf8",
      timeout: 60_000,
    });
    printed.push(r.stdout, r.stderr);
    return r;
  }

  beforeAll(async () => {
    anvil = await startAnvil(31337);
    pub = createPublicClient({ transport: http(anvil.url) });
    key = generatePrivateKey();
    sender = privateKeyToAccount(key).address;
    await setBalance(sender, "10");
    root = tmpRoot();
    keyFile = join(root, "deployer.json");
    writeKeyFile(keyFile, "array", false);
    payPath = writePayWrapper(join(root, "state"));
  }, 30_000);

  it(
    "sends, waits for the receipt and prints the tx hash and explorer link",
    async () => {
      const to = privateKeyToAccount(generatePrivateKey()).address;
      const r = runPay([to, "1.5"]);
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout.trim().split("\n").at(-1)!) as Record<string, string | boolean>;
      expect(out.sent).toBe(true);
      expect(out.status).toBe("success");
      expect(out.to).toBe(to);
      expect(out.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(out.explorer).toBe(`https://explorer.testnet.arc.io/tx/${out.txHash}`);
      expect(await pub.getBalance({ address: to })).toBe(parseUnits("1.5", 18));
      const tx = await pub.getTransaction({ hash: out.txHash as Hex });
      expect(tx.maxFeePerGas).toBeGreaterThanOrEqual(20_000_000_000n); // Arc's floor
      expect(tx.gas).toBe(21_000n);
    },
    60_000,
  );

  it(
    "final wave C add-on (live run #2): a receipt read that fails is retried, not taken for the end of the wait",
    async () => {
      // A loopback proxy in front of Anvil whose first two receipt reads fail the way a load-balanced RPC's do. Before,
      // viem's waitForTransactionReceipt gave up at the first one and pay said "no receipt within 180s".
      let receiptReads = 0;
      const proxy = createHttpServer((req, res) => {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString("utf8")));
        req.on("end", () => {
          const msg = JSON.parse(body) as { id: number; method: string };
          if (msg.method === "eth_getTransactionReceipt" && ++receiptReads <= 2) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "header not found" } }));
            return;
          }
          void fetch(anvil.url, { method: "POST", headers: { "content-type": "application/json" }, body }).then(async (r) => {
            res.writeHead(r.status, { "content-type": "application/json" });
            res.end(await r.text());
          });
        });
      });
      await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
      try {
        const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
        const to = privateKeyToAccount(generatePrivateKey()).address;
        // Not spawnSync: the proxy runs on this process's event loop.
        const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
          const c = spawn(payPath, [to, "0.5"], {
            cwd: REPO_ROOT,
            env: { ...process.env, ARENA_TESTNET_TEST_OVERRIDE: JSON.stringify({ rpcUrl: url, chainId: 31337, keyFile }) },
          });
          let stdout = "";
          let stderr = "";
          c.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
          c.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
          c.once("exit", (status) => resolve({ status, stdout, stderr }));
        });
        printed.push(r.stdout, r.stderr);
        expect(r.status, r.stderr).toBe(0);
        expect(receiptReads).toBeGreaterThanOrEqual(3);
        const out = JSON.parse(r.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
        expect(out).toMatchObject({ sent: true, status: "success", to });
        expect(r.stderr).not.toMatch(/no receipt/);
        expect(await pub.getBalance({ address: to })).toBe(parseUnits("0.5", 18));
      } finally {
        await new Promise<void>((r) => proxy.close(() => r()));
      }
    },
    90_000,
  );

  it(
    "final review C N-2: a failed send that one lookup cannot find says to check the explorer before paying again",
    async () => {
      // The proxy refuses the send itself and forwards everything else, so the 3 s lookup really finds nothing.
      const proxy = createHttpServer((req, res) => {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString("utf8")));
        req.on("end", () => {
          const msg = JSON.parse(body) as { id: number; method: string };
          if (msg.method === "eth_sendRawTransaction") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Transaction creation failed." } }));
            return;
          }
          void fetch(anvil.url, { method: "POST", headers: { "content-type": "application/json" }, body }).then(async (r) => {
            res.writeHead(r.status, { "content-type": "application/json" });
            res.end(await r.text());
          });
        });
      });
      await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
      try {
        const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
        const to = privateKeyToAccount(generatePrivateKey()).address;
        const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
          const c = spawn(payPath, [to, "0.5"], {
            cwd: REPO_ROOT,
            env: { ...process.env, ARENA_TESTNET_TEST_OVERRIDE: JSON.stringify({ rpcUrl: url, chainId: 31337, keyFile }) },
          });
          let stdout = "";
          let stderr = "";
          c.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
          c.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
          c.once("exit", (status) => resolve({ status, stdout, stderr }));
        });
        printed.push(r.stdout, r.stderr);
        expect(r.status).toBe(1);
        const hash = /0x[0-9a-f]{64}/.exec(r.stderr)?.[0];
        expect(hash).toBeDefined();
        expect(r.stderr).toContain(
          `the send failed (-32000 "Transaction creation failed."), and ${hash} was not found 3 s later, but it may still land: ` +
            `check https://explorer.testnet.arc.io/tx/${hash} before paying again`,
        );
        expect(r.stderr).not.toMatch(/is not on the chain/);
        expect(await pub.getBalance({ address: to })).toBe(0n);
      } finally {
        await new Promise<void>((r) => proxy.close(() => r()));
      }
    },
    90_000,
  );

  it(
    "refuses more than 3 USDC, and a bad amount or recipient, before sending anything",
    async () => {
      const to = privateKeyToAccount(generatePrivateKey()).address;
      const before = await nonceOf(sender);
      for (const [args, re] of [
        [[to, "3.000001"], /at most 3 USDC per call/],
        [[to, "100"], /at most 3 USDC per call/],
        [[to, "0"], /greater than 0/],
        [[to, "1e3"], /at most 6 decimal places/],
        [[to, "-1"], /at most 6 decimal places/],
        [["0x1234", "1"], /is not an address/],
        // m-2: a mixed-case address with one wrong-case letter fails its checksum: refused, not paid.
        [[typo(to), "1"], /invalid checksum/],
        [["0x0000000000000000000000000000000000000000", "1"], /zero address/],
        [[sender, "1"], /deployer itself/],
        [[to], /usage: pay/],
      ] as const) {
        const r = runPay([...args]);
        expect(r.status, `${args.join(" ")}: ${r.stderr}`).not.toBe(0);
        expect(r.stderr).toMatch(re);
      }
      expect(await nonceOf(sender)).toBe(before);
      expect(await pub.getBalance({ address: to })).toBe(0n);
    },
    120_000,
  );

  it(
    "refuses to take the deployer under 2 USDC",
    async () => {
      await setBalance(sender, "4");
      const to = privateKeyToAccount(generatePrivateKey()).address;
      const before = await nonceOf(sender);
      const refused = runPay([to, "2.5"]); // 4 - 2.5 - gas < 2
      expect(refused.status).toBe(1);
      expect(refused.stderr).toMatch(/holds 4 USDC; sending 2.5 would leave it under 2 USDC/);
      const edge = runPay([to, "2"]); // 4 - 2 - gas < 2 too: the worst-case gas counts
      expect(edge.status).toBe(1);
      expect(await nonceOf(sender)).toBe(before);
      const ok = runPay([to, "1.9"]);
      expect(ok.status, ok.stderr).toBe(0);
      expect(await pub.getBalance({ address: to })).toBe(parseUnits("1.9", 18));
      await setBalance(sender, "10");
    },
    90_000,
  );

  it(
    "refuses while the deployer has a pending transaction (another sender is using the key)",
    async () => {
      await rawRpc(anvil.url, "evm_setAutomine", [false]);
      try {
        await rawRpc(anvil.url, "anvil_impersonateAccount", [sender]);
        await rawRpc(anvil.url, "eth_sendTransaction", [{ from: sender, to: sender, value: "0x1" }]);
        await rawRpc(anvil.url, "anvil_stopImpersonatingAccount", [sender]);
        const r = runPay([privateKeyToAccount(generatePrivateKey()).address, "1"]);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/pending transaction \(nonce latest \d+, pending \d+\)/);
      } finally {
        await rawRpc(anvil.url, "evm_mine");
        await rawRpc(anvil.url, "evm_setAutomine", [true]);
      }
    },
    60_000,
  );

  it(
    "reads the key file's object shape and a 0x-prefixed key too",
    async () => {
      const objFile = join(root, "deployer-object.json");
      writeKeyFile(objFile, "object", true);
      const to = privateKeyToAccount(generatePrivateKey()).address;
      const r = runPay([to, "0.25"], { rpcUrl: anvil.url, chainId: 31337, keyFile: objFile });
      expect(r.status, r.stderr).toBe(0);
      expect(await pub.getBalance({ address: to })).toBe(parseUnits("0.25", 18));
    },
    60_000,
  );

  it(
    "refuses a key file others can read, and a key that is not its address's",
    async () => {
      const loose = join(root, "deployer-loose.json");
      writeKeyFile(loose, "array", false, 0o644);
      const to = privateKeyToAccount(generatePrivateKey()).address;
      const r = runPay([to, "1"], { rpcUrl: anvil.url, chainId: 31337, keyFile: loose });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/readable by others \(mode 644\)/);

      const wrong = join(root, "deployer-wrong.json");
      writeFileSync(wrong, JSON.stringify({ data: [{ address: to, private_key: key.slice(2) }] }));
      chmodSync(wrong, 0o600);
      const w = runPay([privateKeyToAccount(generatePrivateKey()).address, "1"], { rpcUrl: anvil.url, chainId: 31337, keyFile: wrong });
      expect(w.status).toBe(1);
      expect(w.stderr).toMatch(/does not belong to its address/);
    },
    60_000,
  );

  it(
    "never sends to any chain but the expected one: the hook refuses Arc ids, and an Anvil answering 5042 is refused",
    async () => {
      const to = privateKeyToAccount(generatePrivateKey()).address;
      for (const chainId of [5042002, 5042]) {
        const r = runPay([to, "1"], { rpcUrl: anvil.url, chainId, keyFile });
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/must be 31337/);
      }
      const noChain = runPay([to, "1"], { rpcUrl: anvil.url, keyFile });
      expect(noChain.status).toBe(1);
      expect(noChain.stderr).toMatch(/chainId must be 31337/);
      // m-1: without its own keyFile the hook is refused; it never falls back to the real key file.
      const noKey = runPay([to, "1"], { rpcUrl: anvil.url, chainId: 31337 });
      expect(noKey.status).toBe(1);
      expect(noKey.stderr).toMatch(/keyFile is required/);

      const mainnetLike = await startAnvil(5042);
      const senderBefore = await createPublicClient({ transport: http(mainnetLike.url) }).getTransactionCount({ address: sender });
      const m = runPay([to, "1"], { rpcUrl: mainnetLike.url, chainId: 31337, keyFile });
      expect(m.status).toBe(1);
      expect(m.stderr).toMatch(/Arc MAINNET \(chain 5042\)/);
      expect(await createPublicClient({ transport: http(mainnetLike.url) }).getTransactionCount({ address: sender })).toBe(senderBefore);
      mainnetLike.child.kill("SIGKILL");
    },
    90_000,
  );

  it("never prints the key, never writes it under the state dir, never puts it in the wrapper", () => {
    expect(printed.length).toBeGreaterThan(10);
    const hex = key.slice(2).toLowerCase();
    for (const chunk of printed) expect(chunk.toLowerCase()).not.toContain(hex);
    const wrapper = readFileSync(payPath, "utf8");
    expect(wrapper.toLowerCase()).not.toContain(hex);
    expect(wrapper).toMatch(/testnet-up\.ts' pay "\$@"/);
    const stateDir = join(root, "state");
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const f of walk(stateDir)) expect(readFileSync(f, "utf8").toLowerCase()).not.toContain(hex);
  });

  it("final review C m-8: the helper is <dir>/human/pay, never in bin/ (the agent's PATH); an old bin/pay becomes a stub", () => {
    const d = join(root, "moved");
    mkdirSync(join(d, "bin"), { recursive: true });
    const oldPay = join(d, "bin", "pay");
    writeFileSync(oldPay, "#!/bin/sh\nexec true pay \"$@\"\n", { mode: 0o700 });
    const arena = join(d, "bin", "arena");
    writeFileSync(arena, "#!/bin/sh\n", { mode: 0o700 });

    const path = writePayWrapper(d);
    expect(path).toBe(join(d, "human", "pay"));
    expect(readFileSync(path, "utf8")).toMatch(/testnet-up\.ts' pay "\$@"/);
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(statSync(join(d, "human")).mode & 0o077).toBe(0);
    // bin/ (beside the arena wrapper) holds no way to pay: the stub only says where the helper went.
    const stub = readFileSync(oldPay, "utf8");
    expect(stub).not.toContain("testnet-up.ts");
    expect(stub).not.toContain(" pay ");
    const r = spawnSync(oldPay, ["0x" + "11".repeat(20), "1"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr.trim()).toBe(`pay moved: run ${path} instead (the human's helper is kept off the agent's PATH)`);
    expect(readdirSync(join(d, "bin")).sort()).toEqual(["arena", "pay"]);

    // A fresh directory gets no bin/pay at all.
    const fresh = join(root, "fresh");
    writePayWrapper(fresh);
    expect(existsSync(join(fresh, "bin", "pay"))).toBe(false);
  });

  it("the wrapper passes the stack's own --rpc only when it is not the public one", () => {
    const d = join(root, "rpc-wrapper");
    expect(readFileSync(writePayWrapper(d), "utf8")).not.toContain("--rpc");
    expect(readFileSync(writePayWrapper(d, "https://example.invalid/arc"), "utf8")).toMatch(/ pay --rpc 'https:\/\/example\.invalid\/arc' "\$@"/);
  });

  describe("final wave C add-on (live run #2): the receipt wait runs its full deadline, and an open outcome never reads as unsent", () => {
    const HASH = `0x${"ab".repeat(32)}` as Hex;
    const receipt = { status: "success" } as TransactionReceipt;
    const rateLimited = () => new HttpRequestError({ url: "https://rpc.testnet.arc.io", status: 429, body: { method: "eth_getTransactionReceipt" } });
    /** A fake clock: `sleep` only moves `now`, so 180 s of waiting take no time. */
    function fakeClock() {
      let t = 0;
      return { now: () => t, sleep: async (ms: number) => void (t += ms), get t() { return t; } };
    }
    function fakePub(answer: (read: number, t: number) => TransactionReceipt | Error, clock: { now(): number }) {
      const reads: number[] = [];
      return {
        reads,
        getTransactionReceipt: async () => {
          reads.push(clock.now());
          const a = answer(reads.length, clock.now());
          if (a instanceof Error) throw a;
          return a;
        },
      };
    }

    it("a rate-limited RPC is read again until a receipt comes, even 170 s in (the live run gave up at ~33 s)", async () => {
      const clock = fakeClock();
      const pub = fakePub((_n, t) => (t < 170_000 ? rateLimited() : receipt), clock);
      const got = await waitForPayReceipt(pub, HASH, PAY_RECEIPT_TIMEOUT_MS, clock);
      expect(got.receipt).toBe(receipt);
      expect(clock.t).toBeGreaterThanOrEqual(170_000);
      // backs off 2, 4, 8, then 10 s between failed reads, never more
      const gaps = pub.reads.slice(1).map((t, i) => t - pub.reads[i]!);
      expect(gaps.slice(0, 4)).toEqual([2_000, 4_000, 8_000, 10_000]);
      expect(Math.max(...gaps)).toBe(10_000);
    });

    it("gives up only at the deadline, with a read made at the deadline itself and the last reason", async () => {
      const clock = fakeClock();
      const pub = fakePub(() => rateLimited(), clock);
      const got = await waitForPayReceipt(pub, HASH, PAY_RECEIPT_TIMEOUT_MS, clock);
      expect(got).toEqual({ receipt: null, why: expect.stringMatching(/^the RPC is rate-limiting \(HTTP 429\)$/) });
      expect(pub.reads.at(-1)).toBe(PAY_RECEIPT_TIMEOUT_MS);
      expect(PAY_RECEIPT_TIMEOUT_MS).toBe(180_000);
    });

    it("a receipt not there yet is polled every 2 s; another failure says its receipt could not be read", async () => {
      const clock = fakeClock();
      const notYet = new TransactionReceiptNotFoundError({ hash: HASH });
      const pub = fakePub((n) => (n < 4 ? notYet : receipt), clock);
      expect((await waitForPayReceipt(pub, HASH, PAY_RECEIPT_TIMEOUT_MS, clock)).receipt).toBe(receipt);
      expect(pub.reads).toEqual([0, 2_000, 4_000, 6_000]);

      const clock2 = fakeClock();
      const odd = Object.assign(new Error("header not found"), { code: -32000 });
      const got = await waitForPayReceipt(fakePub(() => odd, clock2), HASH, 30_000, clock2);
      expect(got).toEqual({ receipt: null, why: expect.stringMatching(/^its receipt could not be read \(/) });
      expect(clock2.t).toBe(30_000);
    });

    it("an open outcome names the hash and its explorer link, says to check before paying again, and never says unsent", () => {
      const to = "0x00000000000000000000000000000000000000b1" as Address;
      for (const sentKnown of [true, false]) {
        const out = payUnconfirmed({ hash: HASH, to, wei: parseUnits("1.25", 18), sentKnown, why: "the RPC is rate-limiting (HTTP 429)", timeoutMs: 180_000 });
        expect(out.stderr).toContain(HASH);
        expect(out.stderr).toContain(`https://explorer.testnet.arc.io/tx/${HASH}`);
        expect(out.stderr).toMatch(/check .* before paying again\n$/);
        expect(out.stderr).toContain(sentKnown ? "It was sent and may have landed" : "It may have been sent and may have landed");
        expect(out.stderr).toContain("within 180s (the RPC is rate-limiting (HTTP 429))");
        // The watcher retries only a refusal before sending: an open outcome is never paid again.
        expect(isRefusalBeforeSend(out.stderr)).toBe(false);
        const json = JSON.parse(out.stdout) as Record<string, unknown>;
        expect(json).toMatchObject({ sent: sentKnown ? true : "unknown", confirmed: false, status: "pending", txHash: HASH, usdc: "1.25", to });
        expect(json.sent).not.toBe(false);
      }
    });
  });

  it("checkPayRequest refuses the hub, rules and USDC contracts as recipients", () => {
    const d = readDeployment();
    for (const a of [d.hub, d.rules, d.usdc]) expect(() => checkPayRequest(a, "1", d, DEPLOYER)).toThrow(/refusing: .* is the/);
    expect(() => checkPayRequest(DEPLOYER, "1", d, DEPLOYER)).toThrow(/deployer itself/);
    expect(checkPayRequest(sender.toLowerCase(), "2.5", d, DEPLOYER)).toEqual({ to: sender, wei: parseUnits("2.5", 18) });
  });
});

// ------------------------------------------------------------------------------------------- child environment

describe("final review C m-9: every child gets an allowlisted environment", () => {
  const KEY_SHAPED = `0x${"11".repeat(32)}`;
  it("keeps PATH, the real HOME and the bot's ARENA_HOME; drops secrets and everything not on the allowlist", () => {
    const parent = {
      PATH: "/usr/bin",
      HOME: "/home/op",
      LANG: "C.UTF-8",
      NODE_OPTIONS: "--max-old-space-size=2048",
      ARENA_DEPLOYER_KEY: KEY_SHAPED,
      ALCHEMY_API_KEY: "abc",
      ARENA_TESTNET_TEST_OVERRIDE: '{"rpcUrl":"http://127.0.0.1:1","chainId":31337,"keyFile":"/k"}',
      SOMETHING_ELSE: "1",
    };
    expect(testnetChildEnv("/x/house-1", parent)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/op",
      LANG: "C.UTF-8",
      NODE_OPTIONS: "--max-old-space-size=2048",
      ARENA_HOME: "/x/house-1",
    });
    // The server and the pay helper: no ARENA_HOME at all.
    expect(testnetChildEnv(undefined, parent)).not.toHaveProperty("ARENA_HOME");
    expect(testnetChildEnv(undefined, { PATH: "/usr/bin" }).HOME).toBe(homedir());
  });

  it("no spawn in testnet-up or the human watcher passes this process's whole environment", () => {
    for (const f of ["scripts/testnet-up.ts", "scripts/claude-human-watcher.ts"]) {
      const src = readFileSync(join(REPO_ROOT, f), "utf8");
      expect(src).not.toMatch(/\.\.\.process\.env\b/);
      expect(src).not.toMatch(/env: [^,}]*\?\? process\.env/);
      // Every spawn names its env.
      for (const call of src.match(/\bspawn(?:Sync)?\([^;]*?\{[^;]*?\}\)/gs) ?? []) expect(call).toMatch(/\benv\b/);
    }
  });
});

// -------------------------------------------------------------------------------------------- testnet:down

describe("testnet:down", () => {
  /** A long-lived stand-in whose command line names `args` (node -e keeps them in /proc/<pid>/cmdline). */
  function standIn(args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
    const c = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)", ...args], {
      env,
      stdio: "ignore",
    });
    extraChildren.push(c);
    return c;
  }

  async function startTimeOf(c: ChildProcess): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const t = procStartTime(c.pid!);
      if (t !== null) return t;
      await sleep(20);
    }
    throw new Error("no start time");
  }

  function runDown(dir: string) {
    return spawnSync(TSX_BIN, [SCRIPT, "down", "--dir", dir], { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000 });
  }

  /** What testnet:up leaves in a directory it made: its marker and an Arc-testnet state.json. */
  function markAsTestnetDir(dir: string, chainId = CHAIN_ID): void {
    writeFileSync(join(dir, ".arena-testnet-marker"), "test\n");
    writeFileSync(join(dir, "state.json"), JSON.stringify({ chainId }));
  }

  it("isOurs checks start time, command line and (for a bot) its ARENA_HOME", async () => {
    const dir = tmpRoot();
    const config = join(dir, "server.json");
    const srv = standIn([SERVER_BIN, "--config", config]);
    const home = join(dir, "house-bots", "house-1");
    const bot = standIn([CLI_BIN, "bot", "--allow-real-chain"], { ...process.env, ARENA_HOME: home });
    const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
    extraChildren.push(sleeper);
    const st = await startTimeOf(srv);
    const bt = await startTimeOf(bot);
    const zt = await startTimeOf(sleeper);
    expect(isOurs("server", { pid: srv.pid!, startTime: st, config })).toBe(true);
    expect(isOurs("server", { pid: srv.pid!, startTime: st, config: join(dir, "other.json") })).toBe(false);
    expect(isOurs("server", { pid: srv.pid!, startTime: `${st}1`, config })).toBe(false); // a reused pid
    expect(isOurs("server", { pid: sleeper.pid!, startTime: zt, config })).toBe(false);
    expect(isOurs("bot", { pid: bot.pid!, startTime: bt, home })).toBe(true);
    expect(isOurs("bot", { pid: bot.pid!, startTime: bt, home: join(dir, "house-bots", "house-2") })).toBe(false);
    expect(isOurs("bot", { pid: srv.pid!, startTime: st, home })).toBe(false);
    expect(isOurs("up", { pid: sleeper.pid!, startTime: zt })).toBe(false);
    expect(isOurs("server", { pid: 999_999_999, startTime: "1", config })).toBe(false);
    // m-8: with a --dir, the config or home must sit under it.
    expect(isOurs("server", { pid: srv.pid!, startTime: st, config }, dir)).toBe(true);
    expect(isOurs("server", { pid: srv.pid!, startTime: st, config }, join(dir, "house-bots"))).toBe(false);
    expect(isOurs("bot", { pid: bot.pid!, startTime: bt, home }, dir)).toBe(true);
    expect(isOurs("bot", { pid: bot.pid!, startTime: bt, home }, tmpRoot())).toBe(false);
  });

  it("m-8: refuses a directory testnet:up did not make for Arc testnet (dev-up's .arena-dev has the same layout)", async () => {
    const dir = tmpRoot();
    const home = join(dir, "house-bots", "house-1");
    const bot = standIn([CLI_BIN, "bot"], { ...process.env, ARENA_HOME: home });
    writeFileSync(join(dir, "pids.json"), JSON.stringify({ bots: [{ name: "house-1", home, pid: bot.pid, startTime: await startTimeOf(bot) }] }));
    expect(() => assertTestnetDir(dir)).toThrow(/was not made by testnet:up/);
    const unmarked = runDown(dir);
    expect(unmarked.status).toBe(1);
    expect(unmarked.stderr).toMatch(/refusing: .* was not made by testnet:up/);
    markAsTestnetDir(dir, 31337);
    const anvilDir = runDown(dir);
    expect(anvilDir.status).toBe(1);
    expect(anvilDir.stderr).toMatch(/state.json is for chain 31337, not Arc testnet/);
    expect(bot.exitCode).toBeNull(); // never signalled
    expect(existsSync(join(dir, "pids.json"))).toBe(true);
  });

  it(
    "stops only the recorded pids that are still ours, and leaves a reused pid alone",
    async () => {
      const dir = tmpRoot();
      mkdirSync(dir, { recursive: true });
      markAsTestnetDir(dir);
      const config = join(dir, "server.json");
      const home = join(dir, "house-bots", "house-1");
      const srv = standIn([SERVER_BIN, "--config", config]);
      const bot = standIn([CLI_BIN, "bot", "--allow-real-chain"], { ...process.env, ARENA_HOME: home });
      // A process that took over a recorded pid's number would not match; stand in for it with an unrelated one.
      const stranger = spawn("sleep", ["60"], { stdio: "ignore" });
      extraChildren.push(stranger);
      const srvExit = new Promise<void>((r) => srv.once("exit", () => r()));
      const botExit = new Promise<void>((r) => bot.once("exit", () => r()));
      writeFileSync(
        join(dir, "pids.json"),
        JSON.stringify({
          server: { pid: srv.pid, startTime: await startTimeOf(srv), config },
          bots: [
            { name: "house-1", home, pid: bot.pid, startTime: await startTimeOf(bot) },
            { name: "house-2", home: join(dir, "house-bots", "house-2"), pid: stranger.pid, startTime: await startTimeOf(stranger) },
          ],
        }),
      );
      const r = runDown(dir);
      expect(r.status, r.stderr).toBe(0);
      await Promise.all([srvExit, botExit]);
      expect(r.stderr).toMatch(new RegExp(`stopping house bot house-1 \\(pid ${bot.pid}\\)`));
      expect(r.stderr).toMatch(new RegExp(`stopping server \\(pid ${srv.pid}\\)`));
      expect(r.stderr).toMatch(new RegExp(`pid ${stranger.pid} is no longer house bot house-2: left alone`));
      expect(stranger.exitCode).toBeNull(); // still running
      expect(existsSync(join(dir, "pids.json"))).toBe(false);
      // A second down has nothing to do.
      const again = runDown(dir);
      expect(again.status).toBe(0);
      expect(again.stderr).not.toMatch(/stopping/);
    },
    60_000,
  );
});
