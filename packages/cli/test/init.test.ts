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

describe("arena init --server", () => {
  it("arena init --server fills chain settings from /templates", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const fetchStub = (async (url: string) => {
      expect(url).toBe("http://host.test/templates");
      return new Response(JSON.stringify(templatesResponse()));
    }) as typeof fetch;
    const out: string[] = [];
    const code = await runCli(["init", "--server", "http://host.test"], {
      env: { ARENA_HOME: home },
      fetch: fetchStub,
      out: (s) => out.push(s),
      err: () => undefined,
    });
    expect(code).toBe(0);
    expect(loadConfig(home)).toMatchObject({
      serverUrl: "http://host.test",
      rpcUrl: "http://rpc.test",
      chainId: 31337,
      hub: `0x${"11".repeat(20)}`,
    });
  });

  it("explicit flags override template values", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-init-"));
    const fetchStub = (async () => new Response(JSON.stringify(templatesResponse()))) as typeof fetch;
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
});
