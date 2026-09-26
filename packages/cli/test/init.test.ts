import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, runCli } from "../src/index.js";

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
 *  contracts are the addresses in `withCode`. Every request URL is recorded in `calls`. */
function stubFetch(opts: { templates?: unknown; chainId?: number; withCode?: string[] } = {}) {
  const calls: Array<{ url: string; method?: string }> = [];
  const withCode = new Set((opts.withCode ?? [`0x${"11".repeat(20)}`, `0x${"33".repeat(20)}`]).map((a) => a.toLowerCase()));
  const fetchStub = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/templates")) {
      calls.push({ url });
      return new Response(JSON.stringify(opts.templates ?? templatesResponse()));
    }
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    calls.push({ url, method: req.method });
    const result =
      req.method === "eth_chainId"
        ? `0x${(opts.chainId ?? 31337).toString(16)}`
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

  it("with every chain setting explicit, makes no network call and prints no trust line", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const fetchStub = (async () => {
      throw new Error("no network call expected: every chain-setting flag is explicit");
    }) as typeof fetch;
    const out: string[] = [];
    const code = await runCli(
      ["init", "--server", "http://host.test", "--rpc", "http://rpc.test", "--chain-id", "31337",
        "--hub", `0x${"11".repeat(20)}`, "--usdc", `0x${"22".repeat(20)}`, "--rules", `0x${"33".repeat(20)}`],
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
});
