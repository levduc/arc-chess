import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KNOWN_DEPLOYMENTS, loadConfig, runCli } from "../src/index.js";

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
  const withCode = new Set((opts.withCode ?? [`0x${"11".repeat(20)}`, `0x${"33".repeat(20)}`]).map((a) => a.toLowerCase()));
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
      ["http://rpc.test", "eth_getCode"],
      ["http://rpc.test", "eth_getCode"],
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

  it("fails when an adopted hub or rules address has no code", async () => {
    for (const missing of ["hub", "rules"] as const) {
      const home = mkdtempSync(join(tmpdir(), "arena-init-"));
      const { fetchStub } = stubFetch({ withCode: missing === "hub" ? [`0x${"33".repeat(20)}`] : [`0x${"11".repeat(20)}`] });
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

  it("with every chain setting (and --session-gas-wei) explicit, makes no network call and prints no trust line", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const fetchStub = (async () => {
      throw new Error("no network call expected: every chain-setting flag is explicit");
    }) as typeof fetch;
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
});
