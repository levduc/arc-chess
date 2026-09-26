import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, runCli } from "../src/index.js";

function io(home: string, responses: Array<{ status: number; body: unknown }> = []) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { calls, out, err, io: { env: { ARENA_HOME: home }, fetch: fetchFn, out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

const INIT = [
  "init", "--rpc", "http://127.0.0.1:8546", "--chain-id", "31337",
  "--hub", "0x000000000000000000000000000000000000beef", "--usdc", "0x000000000000000000000000000000000000cafe",
  "--rules", "0x00000000000000000000000000000000000000e5", "--server", "http://127.0.0.1:3000", "--port", "7010",
];

describe("arena CLI", () => {
  it("init writes the home", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-cli-"));
    const t = io(home);
    expect(await runCli(INIT, t.io)).toBe(0);
    expect(loadConfig(home).port).toBe(7010);
    expect(loadConfig(home).maxFeePerPlayer).toBe(10_000n);
  });

  it("maps commands to API calls with the token and agent actor", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-cli-"));
    const t = io(home);
    await runCli(INIT, t.io);
    expect(await runCli(["move", "e4", "--offer-draw", "--channel", "0xab"], t.io)).toBe(0);
    const c = t.calls.at(-1)!;
    expect(c.url).toBe("http://127.0.0.1:7010/move");
    expect(c.init.method).toBe("POST");
    expect(JSON.parse(String(c.init.body))).toEqual({ move: "e4", offerDraw: true, channel: "0xab" });
    const headers = new Headers(c.init.headers);
    expect(headers.get("authorization")).toMatch(/^Bearer [0-9a-f]{64}$/);
    expect(headers.get("x-arena-actor")).toBe("agent");

    await runCli(["offer", "--deposit", "1.5", "--stake", "0.1"], t.io);
    expect(JSON.parse(String(t.calls.at(-1)!.init.body))).toEqual({
      deposit: "1500000",
      stakePerGame: "100000",
      challengeTimeout: "600",
    });
    await runCli(["wait", "--timeout", "30"], t.io);
    expect(t.calls.at(-1)!.url).toBe("http://127.0.0.1:7010/wait?timeout=30");
    await runCli(["handoff", "human", "--note", "look"], t.io);
    expect(JSON.parse(String(t.calls.at(-1)!.init.body))).toEqual({ to: "human", note: "look" });
  });

  it("reports API errors and usage errors", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-cli-"));
    const t = io(home, [{ status: 409, body: { error: "not your turn" } }]);
    await runCli(INIT, io(home).io);
    expect(await runCli(["move", "e4"], t.io)).toBe(1);
    expect(t.err.join("\n")).toContain("not your turn");
    expect(await runCli(["frobnicate"], t.io)).toBe(2);
    expect(await runCli(["move"], t.io)).toBe(2);
  });

  it("rejects USDC amounts with more than 6 decimals, negative or malformed ones as usage errors", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-cli-"));
    await runCli(INIT, io(home).io);
    const t = io(home);
    for (const [deposit, stake] of [["1.0000001", "0.1"], ["1", "0.1234567"], ["-1", "0.1"], ["1", "-0.1"], ["1e6", "0.1"], ["1.", "0.1"], [".5", "0.1"], ["abc", "0.1"]]) {
      expect(await runCli(["offer", "--deposit", deposit, "--stake", stake], t.io)).toBe(2);
    }
    expect(t.calls).toHaveLength(0); // nothing reached the daemon
    expect(t.err.join("\n")).toMatch(/at most 6 decimal places/);
    expect(await runCli(["offer", "--deposit", "1.123456", "--stake", "0"], t.io)).toBe(0);
    expect(JSON.parse(String(t.calls.at(-1)!.init.body))).toMatchObject({ deposit: "1123456", stakePerGame: "0" });
  });
});
