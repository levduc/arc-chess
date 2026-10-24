/**
 * T5b: `scripts/testnet-up.ts` (`pnpm testnet:up` / `testnet:down` / `<dir>/bin/pay`). Nothing here touches Arc: the
 * chain-id refusals run against local Anvils (ports 8700-8799) and a stub RPC, and the pay helper runs against a local
 * Anvil through the script's test hook (`ARENA_TESTNET_TEST_OVERRIDE`, honoured only for a loopback Anvil at chain
 * 31337), with a throwaway key in a temporary key file shaped like the real one.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, http, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseServerConfig } from "../../apps/server/src/config.js";
import {
  CHAIN_ID,
  DEPLOYER,
  FORBIDDEN_PORTS,
  RPC_URL,
  assertChain,
  buildServerConfig,
  checkPayRequest,
  isOurs,
  parseDownArgs,
  parseUpArgs,
  procStartTime,
  readDeployment,
  testOverride,
  topUpAmount,
  writePayWrapper,
} from "../../scripts/testnet-up.js";
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
      rpc: "https://rpc.testnet.arc.io",
      houseBots: 2,
      botUsdc: "2.5",
      botDeposit: "1",
      botStake: "0.1",
      xmtpBots: false,
      dir: join(REPO_ROOT, ".arena-testnet"),
    });
  });

  it("takes every flag", () => {
    const a = parseUpArgs([
      "--port", "8095", "--rpc", "https://example.invalid/arc-testnet", "--house-bots", "4", "--bot-usdc", "1.25", "--bot-deposit", "0.5", "--bot-stake", "0.05",
      "--bot-timeout", "300", "--xmtp-bots", "--start-block", "68000000", "--dir", "/tmp/x",
    ]);
    expect(a).toEqual({
      port: 8095, rpc: "https://example.invalid/arc-testnet", houseBots: 4, botUsdc: "1.25", botDeposit: "0.5", botStake: "0.05", botTimeout: 300, xmtpBots: true,
      startBlock: 68_000_000n, dir: "/tmp/x",
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
    expect(() => parseUpArgs(["--rpc", "ws://127.0.0.1:1"])).toThrow(/http\(s\) URL/);
  });

  it("down: --withdraw and --dir only", () => {
    expect(parseDownArgs([])).toEqual({ withdraw: false, dir: join(REPO_ROOT, ".arena-testnet") });
    expect(parseDownArgs(["--withdraw", "--dir", "/tmp/y"])).toEqual({ withdraw: true, dir: "/tmp/y" });
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
    return spawnSync(TSX_BIN, [SCRIPT, "--rpc", rpcUrl, "--port", String(port), "--house-bots", "0", "--dir", dir], {
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
    for (const chainId of [5042, 5042002, 1]) {
      expect(() => testOverride({ ARENA_TESTNET_TEST_OVERRIDE: JSON.stringify({ rpcUrl: "http://127.0.0.1:8701", chainId }) })).toThrow(
        /may only be 31337/,
      );
    }
    expect(testOverride({ ARENA_TESTNET_TEST_OVERRIDE: JSON.stringify({ rpcUrl: "http://127.0.0.1:8701", chainId: 31337 }) })).toEqual({
      rpcUrl: "http://127.0.0.1:8701/",
      chainId: 31337,
    });
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
      rpcUrl: RPC_URL,
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
    expect(cfg.rpcUrl).toBe("https://rpc.testnet.arc.io");
    expect(cfg.publicRpcUrl).toBe("https://rpc.testnet.arc.io");
    expect(cfg.cliCommand).toBe("/x/.arena-testnet/bin/arena");
    expect(cfg.dbPath).toBe("/x/.arena-testnet/server.sqlite");
    expect(cfg.indexer.startBlock).toBe(68_879_000n);
    expect(cfg.defaults).toEqual({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 900n });
    expect(cfg.audit).toMatch(/^unaudited; Arc TESTNET/);
    expect(cfg.audit).toMatch(/2 USDC deposit per player, 50 USDC total committed escrow; fee 0.005 USDC/);
    expect(cfg.trustProxy).toBe(false);
  });
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
        expect(r.stderr).toMatch(/may only be 31337/);
      }
      const noChain = runPay([to, "1"], { rpcUrl: anvil.url, keyFile });
      expect(noChain.status).toBe(1);
      expect(noChain.stderr).toMatch(/must set chainId 31337 for pay/);

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

  it("the wrapper passes the stack's own --rpc only when it is not the public one", () => {
    const d = join(root, "rpc-wrapper");
    expect(readFileSync(writePayWrapper(d), "utf8")).not.toContain("--rpc");
    expect(readFileSync(writePayWrapper(d, "https://example.invalid/arc"), "utf8")).toMatch(/ pay --rpc 'https:\/\/example\.invalid\/arc' "\$@"/);
  });

  it("checkPayRequest refuses the hub, rules and USDC contracts as recipients", () => {
    const d = readDeployment();
    for (const a of [d.hub, d.rules, d.usdc]) expect(() => checkPayRequest(a, "1", d, DEPLOYER)).toThrow(/refusing: .* is the/);
    expect(() => checkPayRequest(DEPLOYER, "1", d, DEPLOYER)).toThrow(/deployer itself/);
    expect(checkPayRequest(sender.toLowerCase(), "2.5", d, DEPLOYER)).toEqual({ to: sender, wei: parseUnits("2.5", 18) });
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
  });

  it(
    "stops only the recorded pids that are still ours, and leaves a reused pid alone",
    async () => {
      const dir = tmpRoot();
      mkdirSync(dir, { recursive: true });
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
