import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { daemonStartLine, invalidOfferTimeoutReason, loadConfig, runCli } from "../src/index.js";

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
  "--session-gas-wei", "10000000000000000", // explicit: no RPC call for the default (final review C1)
];

describe("arena CLI", () => {
  it("M1: a generic command names the daemon port and the recipe step to fix it, instead of a bare fetch error", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-cli-"));
    await runCli(INIT, io(home).io);
    const t = io(home);
    (t.io as { fetch: typeof fetch }).fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await runCli(["offers"], t.io)).toBe(1);
    expect(t.err.join("\n")).toMatch(/127\.0\.0\.1:7010/);
    expect(t.err.join("\n")).toMatch(/arena daemon/);
    expect(t.err.join("\n")).toMatch(/recipe step 2/);
  });

  it("init writes the home", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-cli-"));
    const t = io(home);
    expect(await runCli(INIT, t.io)).toBe(0);
    expect(loadConfig(home).port).toBe(7010);
    expect(loadConfig(home).maxFeePerPlayer).toBe(10_000n);
  });

  it("final fix wave I1: init leaves auto-return on by default; --auto-return-on-challenge false turns it off", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-cli-"));
    expect(await runCli(INIT, io(home).io)).toBe(0);
    expect(loadConfig(home).autoReturnOnChallenge).toBeUndefined(); // the default: on
    expect(await runCli([...INIT, "--auto-return-on-challenge", "false"], io(home).io)).toBe(0);
    expect(loadConfig(home).autoReturnOnChallenge).toBe(false);
    const bad = io(home);
    expect(await runCli([...INIT, "--auto-return-on-challenge", "no"], bad.io)).toBe(2);
    expect(bad.err.join("\n")).toMatch(/must be true or false/);
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

    // Plan 5 Task 1: arena offer omits challengeTimeout unless --timeout is given -- the daemon applies its own
    // minChallengeTimeoutOf(config) default (POST /offers), not a value baked into the CLI.
    await runCli(["offer", "--deposit", "1.5", "--stake", "0.1"], t.io);
    expect(JSON.parse(String(t.calls.at(-1)!.init.body))).toEqual({
      deposit: "1500000",
      stakePerGame: "100000",
    });
    await runCli(["offer", "--deposit", "1.5", "--stake", "0.1", "--timeout", "1800"], t.io);
    expect(JSON.parse(String(t.calls.at(-1)!.init.body))).toEqual({
      deposit: "1500000",
      stakePerGame: "100000",
      challengeTimeout: "1800",
    });
    await runCli(["wait", "--timeout", "30"], t.io);
    expect(t.calls.at(-1)!.url).toBe("http://127.0.0.1:7010/wait?timeout=30");
    await runCli(["handoff", "human", "--note", "look"], t.io);
    expect(JSON.parse(String(t.calls.at(-1)!.init.body))).toEqual({ to: "human", note: "look" });
  });

  it("final fix wave M1: arena board mints a one-time code from the daemon and prints it in the fragment, never the token", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-cli-"));
    await runCli(INIT, io(home).io);
    const t = io(home, [{ status: 200, body: { code: "Zm9vYmFyYmF6cXV4MTIzNA" } }]);
    expect(await runCli(["board"], t.io)).toBe(0);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].url).toBe("http://127.0.0.1:7010/board/code");
    expect(t.calls[0].init.method).toBe("POST");
    expect(new Headers(t.calls[0].init.headers).get("content-type")).toBe("application/json");
    const token = new Headers(t.calls[0].init.headers).get("authorization")?.replace(/^Bearer /, "");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(t.out).toEqual(["http://127.0.0.1:7010/board#code=Zm9vYmFyYmF6cXV4MTIzNA"]);
    expect(t.out.join("\n")).not.toContain(token);

    // With no daemon to mint a code, it fails with a hint instead of printing a link.
    const down = io(home);
    (down.io as { fetch: typeof fetch }).fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await runCli(["board"], down.io)).toBe(1);
    expect(down.out).toEqual([]);
    expect(down.err.join("\n")).toMatch(/arena daemon/);
  });

  it("Plan 5 Task 2 fix round, CRITICAL 1: the daemon start line never carries the token fragment", () => {
    const line = daemonStartLine({ apiUrl: "http://127.0.0.1:7010", pid: 4242, wallet: "0xabc123" });
    const json = JSON.stringify(line);
    expect(json).not.toContain("#token=");
    expect(json).not.toContain("token");
    expect(line).toEqual({
      api: "http://127.0.0.1:7010",
      pid: 4242,
      wallet: "0xabc123",
      board: "http://127.0.0.1:7010/board",
      boardHint: "run: arena board",
    });
  });

  it("fix round I5: arena sweep maps to POST /sweep and prints a note when channels remain", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-cli-"));
    await runCli(INIT, io(home).io);
    const t = io(home, [{ status: 200, body: { results: [{ channelId: "0xaa", swept: "0x64" }], remaining: 2 } }]);
    expect(await runCli(["sweep"], t.io)).toBe(0);
    const c = t.calls.at(-1)!;
    expect(c.url).toBe("http://127.0.0.1:7010/sweep");
    expect(c.init.method).toBe("POST");
    expect(JSON.parse(String(c.init.body))).toEqual({}); // no --channel given
    expect(t.err.some((l) => /note: 2 channel\(s\) still need sweeping/.test(l))).toBe(true);

    const t2 = io(home, [{ status: 200, body: { results: [], remaining: 0 } }]);
    expect(await runCli(["sweep", "--channel", "0xab"], t2.io)).toBe(0);
    expect(JSON.parse(String(t2.calls.at(-1)!.init.body))).toEqual({ channel: "0xab" });
    expect(t2.err).toEqual([]); // nothing left: no note printed
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

  it("Plan 5.5 Task 1: arena wallet reads USDC and native balances directly over RPC, with no daemon call", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-cli-"));
    await runCli(INIT, io(home).io);
    const usdcHex = `0x${(100_000_000n).toString(16).padStart(64, "0")}`; // 100 USDC, 6 decimals
    const nativeHex = `0x${(10n ** 18n).toString(16)}`; // exactly 1 ETH
    const t = io(home, [
      { status: 200, body: { jsonrpc: "2.0", id: 1, result: usdcHex } }, // eth_call (balanceOf)
      { status: 200, body: { jsonrpc: "2.0", id: 1, result: nativeHex } }, // eth_getBalance
    ]);
    expect(await runCli(["wallet"], t.io)).toBe(0);
    expect(t.calls).toHaveLength(2);
    expect(JSON.parse(String(t.calls[0].init.body)).method).toBe("eth_call");
    expect(t.calls[0].url).toBe("http://127.0.0.1:8546"); // cfg.rpcUrl from INIT, not the daemon
    expect(JSON.parse(String(t.calls[1].init.body)).method).toBe("eth_getBalance");
    const printed = JSON.parse(t.out.join("\n")) as Record<string, unknown>;
    expect(printed).toMatchObject({ chainId: 31337, usdc: "100.000000", native: "1.0" });
    expect(printed.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("Plan 5.5 Task 1: arena faucet POSTs to the server and prints its result, or fails clearly", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-cli-"));
    await runCli(INIT, io(home).io);
    const t = io(home, [{ status: 200, body: { address: "0xabc", usdc: "100000000", native: "1000000000000000000" } }]);
    expect(await runCli(["faucet"], t.io)).toBe(0);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].url).toBe("http://127.0.0.1:3000/faucet"); // cfg.serverUrl from INIT
    expect(t.calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(t.calls[0].init.body))).toMatchObject({ address: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/) });
    // M2: formatted like `arena wallet`, not the server's raw base-unit strings.
    expect(JSON.parse(t.out.join("\n"))).toEqual({ address: "0xabc", usdc: "100.000000", native: "1.0" });

    // A server with no faucet (404): a clear, specific message, not a raw status.
    const notDev = io(home, [{ status: 404, body: { error: "not found" } }]);
    expect(await runCli(["faucet"], notDev.io)).toBe(1);
    expect(notDev.err.join("\n")).toMatch(/server advertises no faucet/);

    // M2: a 429 reports the server's own retryAfterSeconds, not just a bare error.
    const limited = io(home, [{ status: 429, body: { error: "rate limited", retryAfterSeconds: 345 } }]);
    expect(await runCli(["faucet"], limited.io)).toBe(1);
    expect(limited.err.join("\n")).toMatch(/rate limited/);
    expect(limited.err.join("\n")).toMatch(/retry in 345s/);

    // Unreachable server: fails clearly, doesn't throw.
    const down = io(home);
    (down.io as { fetch: typeof fetch }).fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await runCli(["faucet"], down.io)).toBe(1);
    expect(down.err.join("\n")).toMatch(/cannot reach/);
  });

  it("M2: arena faucet reports a malformed success amount instead of crashing", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-cli-"));
    await runCli(INIT, io(home).io);
    const t = io(home, [{ status: 200, body: { address: "0xabc", usdc: "not-a-number", native: "1000000000000000000" } }]);
    expect(await runCli(["faucet"], t.io)).toBe(1);
    expect(t.err.join("\n")).toMatch(/malformed amount/);
  });

  it("Plan 5.5 Task 2: arena bot refuses a non-31337 chain without --allow-real-chain, before touching the daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-cli-"));
    const mainnetInit = INIT.map((v) => (v === "31337" ? "1" : v));
    await runCli(mainnetInit, io(home).io);
    expect(loadConfig(home).chainId).toBe(1);

    const refused = io(home);
    // No responses queued: if this reached startDaemonProcess (an RPC call) or io.fetch at all, the stub below
    // would throw on an empty queue instead of this returning the clear usage error.
    (refused.io as { fetch: typeof fetch }).fetch = (async () => {
      throw new Error("must not reach the network");
    }) as unknown as typeof fetch;
    expect(await runCli(["bot"], refused.io)).toBe(2);
    expect(refused.err.join("\n")).toMatch(/refusing to run "arena bot".*chain 1.*--allow-real-chain/s);
  });

  it("fix round (minor 5): arena bot validates --timeout like the other flags, before touching the daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-cli-"));
    await runCli(INIT, io(home).io); // chain 31337: passes the chain check, so --timeout's own validation is reached
    for (const bad of ["abc", "-1", "1.5", "", "60s"]) {
      const t = io(home);
      (t.io as { fetch: typeof fetch }).fetch = (async () => {
        throw new Error("must not reach the network");
      }) as unknown as typeof fetch;
      expect(await runCli(["bot", "--timeout", bad], t.io)).toBe(2);
      expect(t.err.join("\n")).toMatch(/--timeout must be a non-negative integer/);
    }
  });

  it("fix round (minor 5): invalidOfferTimeoutReason checks --timeout against the larger of the hub's MIN_TIMEOUT and minChallengeTimeout, and the hub's MAX_TIMEOUT", () => {
    const bounds = { min: 60n, max: 604_800n };
    // Below the hub's own minimum.
    expect(invalidOfferTimeoutReason(30n, bounds, 60n)).toMatch(/below the minimum of 60s/);
    // At the hub's minimum, but below this daemon's own (larger) floor.
    expect(invalidOfferTimeoutReason(100n, bounds, 900n)).toMatch(/below the minimum of 900s/);
    // Exactly at the floor: fine.
    expect(invalidOfferTimeoutReason(900n, bounds, 900n)).toBeNull();
    // Comfortably within bounds: fine.
    expect(invalidOfferTimeoutReason(3_600n, bounds, 900n)).toBeNull();
    // Exactly at the hub's maximum: fine.
    expect(invalidOfferTimeoutReason(604_800n, bounds, 60n)).toBeNull();
    // Above the hub's maximum.
    expect(invalidOfferTimeoutReason(604_801n, bounds, 60n)).toMatch(/above the hub's maximum of 604800s/);
  });
});
