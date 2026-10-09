import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { deployArena, mintUsdc, RPC, setEthBalance, usdcBalance as readUsdcBalance } from "../../sdk/test/helpers/chain.js";
import { daemonStartLine, invalidOfferTimeoutReason, loadConfig, runCli } from "../src/index.js";
import { computeFundingNeed, fundMessage } from "../src/funding.js";

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

// ------------------------------------------------------------- Plan 5.6 Task 2: fund, wallet --wait-for-* (Anvil)

/** A hybrid `io.fetch`, following the shape of `io()` above: real JSON-RPC calls go to the real, deployed Anvil
 *  chain (so `fund`'s `feePerPlayer` read and both commands' balance reads are genuine), while `/templates` and
 *  `/faucet` are answered by the test -- the same split a real agent machine sees (one real chain, one real
 *  server). Every request URL is recorded in `calls`. */
function fundIo(
  home: string,
  opts: {
    templatesBody?: unknown;
    faucetHandler?: (address: Address) => Promise<{ status: number; body: unknown }>;
    env?: Record<string, string>;
  } = {},
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith(RPC)) return fetch(url, init); // the real, deployed Anvil chain
    if (url.endsWith("/templates")) return new Response(JSON.stringify(opts.templatesBody ?? []), { status: 200 });
    if (url.endsWith("/faucet") && opts.faucetHandler) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { address: Address };
      const r = await opts.faucetHandler(body.address);
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    throw new Error(`fundIo: unexpected URL in test: ${url}`);
  }) as unknown as typeof fetch;
  return {
    calls,
    out,
    err,
    io: { env: { ARENA_HOME: home, ...opts.env }, fetch: fetchFn, out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
  };
}

/** Writes a fresh ARENA_HOME against a real, freshly deployed hub, with a fresh (empty: 0 USDC, 0 native)
 *  wallet -- a random key is never one of Anvil's own pre-funded dev accounts. Every field is explicit, so
 *  `init` itself makes no network call at all (final review C1's own `--session-gas-wei` trick, reused here). */
async function initEmptyWallet(env: { hub: Address; usdc: Address; rules: Address }, server = "http://127.0.0.1:3000") {
  const walletKey = generatePrivateKey();
  const address = privateKeyToAccount(walletKey).address;
  const home = mkdtempSync(join(tmpdir(), "arena-cli-fund-"));
  const code = await runCli(
    [
      "init",
      "--rpc",
      RPC,
      "--chain-id",
      "31337",
      "--hub",
      env.hub,
      "--usdc",
      env.usdc,
      "--rules",
      env.rules,
      "--server",
      server,
      "--port",
      "7010",
      "--session-gas-wei",
      "10000000000000000", // 1e16 wei
      "--wallet-key",
      walletKey,
      "--no-faucet",
    ],
    io(home).io,
  );
  if (code !== 0) throw new Error(`test setup: init failed with code ${code}`);
  return { home, address, walletKey };
}

const CHESS_TEMPLATE = (overrides: Record<string, unknown> = {}) => [
  { id: "chess", version: "1", limits: { maxDepositPerPlayer: "10000000", maxCommittedEscrow: "1000000000000", committedEscrow: "0", paused: false }, ...overrides },
];

describe("Plan 5.6 Task 2: arena fund", () => {
  it("on an empty wallet: exit 0, deposit = min(games x stake, cap), exact shortfalls and message", async () => {
    const env = await deployArena(); // feePerPlayer 5_000n, maxDepositPerPlayer 10_000_000n (see deployArena)
    const { home, address } = await initEmptyWallet(env);
    const t = fundIo(home, { templatesBody: CHESS_TEMPLATE() });

    expect(await runCli(["fund", "--games", "3", "--stake", "1"], t.io)).toBe(0);
    const printed = JSON.parse(t.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(printed)).toEqual(["address", "chainId", "deposit", "feePerPlayer", "usdc", "native", "owner", "message"]);
    expect(printed.address).toBe(address);
    expect(printed.chainId).toBe(31337);
    expect(printed.deposit).toBe("3.000000"); // 3 x 1 USDC, within the 10 USDC cap
    expect(printed.feePerPlayer).toBe("0.005000"); // proves the eth_call read the real, deployed hub (not "0x")
    expect(printed.usdc).toEqual({ have: "0.000000", need: "3.005000", shortfall: "3.005000" });
    expect(printed.native).toEqual({ have: "0.0", need: "0.06", shortfall: "0.06" }); // 1e16 + 500_000 x 100 gwei
    expect(printed.owner).toBeNull();

    const need = computeFundingNeed({
      games: 3n,
      stake: 1_000_000n,
      cap: 10_000_000n,
      feePerPlayer: 5_000n,
      sessionGasWei: 10_000_000_000_000_000n,
      feeCeilingWei: 100_000_000_000n,
      usdcHave: 0n,
      nativeHave: 0n,
    });
    expect(printed.message).toBe(fundMessage(need, { address, chainId: 31337, ownerSet: false, games: 3n, stake: 1_000_000n }));
  });

  it("--deposit overrides the default; an out-of-range one exits 1 (not the usual usage-error 2)", async () => {
    const env = await deployArena();
    const { home } = await initEmptyWallet(env);

    const t1 = fundIo(home, { templatesBody: CHESS_TEMPLATE() });
    expect(await runCli(["fund", "--games", "3", "--stake", "1", "--deposit", "2"], t1.io)).toBe(0);
    expect((JSON.parse(t1.out.join("\n")) as Record<string, unknown>).deposit).toBe("2.000000");

    // Review Focus 2's sibling for fund: an out-of-range --deposit is "1 on error", not the usual UsageError 2,
    // because it comes from computeFundingNeed's own RangeError, not a flag-syntax mistake.
    const t2 = fundIo(home, { templatesBody: CHESS_TEMPLATE() });
    expect(await runCli(["fund", "--games", "3", "--stake", "1", "--deposit", "0.5"], t2.io)).toBe(1);
    expect(t2.err.join("\n")).toMatch(/deposit must be between the stake and the cap/);
  });

  it("with a server faucet: calls it once when short, re-reads the balances, and reports faucet: {usdc, native}", async () => {
    const env = await deployArena();
    const { home, address } = await initEmptyWallet(env, "http://127.0.0.1:3000");
    let faucetCalls = 0;
    const t = fundIo(home, {
      templatesBody: CHESS_TEMPLATE({ faucet: "http://127.0.0.1:3000/faucet" }),
      faucetHandler: async (addr) => {
        faucetCalls++;
        await mintUsdc(env.usdc, addr, 20_000_000n); // plenty to cover the 3.005 USDC need
        await setEthBalance(addr, 10n ** 18n); // plenty to cover the 0.06 native need
        const usdc = await readUsdcBalance(env.usdc, addr);
        return { status: 200, body: { address: addr, usdc: usdc.toString(), native: (10n ** 18n).toString() } };
      },
    });

    expect(await runCli(["fund", "--games", "3", "--stake", "1"], t.io)).toBe(0);
    expect(faucetCalls).toBe(1); // called exactly once, even though both assets were short
    const printed = JSON.parse(t.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(printed)).toEqual(["address", "chainId", "deposit", "feePerPlayer", "usdc", "native", "owner", "faucet", "message"]);
    expect(printed.faucet).toEqual({ usdc: "20.000000", native: "1.0" }); // formatted as `arena faucet` does
    // Re-read balances after the faucet call: both shortfalls are now gone.
    expect(printed.usdc).toEqual({ have: "20.000000", need: "3.005000", shortfall: "0.000000" });
    expect(printed.native).toEqual({ have: "1.0", need: "0.06", shortfall: "0.0" });
    // A free end-to-end pin of the "already holds enough" message variant.
    expect(printed.message).toBe("This wallet already holds enough to play 3 games at 1.000000 USDC. Tell me the address to return winnings to.");
  });

  it("an unreachable server exits 1, naming the server URL", async () => {
    const env = await deployArena();
    const { home } = await initEmptyWallet(env, "http://127.0.0.1:3000");
    const t = fundIo(home); // no templatesBody handler override needed: /templates throws below
    (t.io as { fetch: typeof fetch }).fetch = (async (url: string) => {
      if (url.endsWith("/templates")) throw new TypeError("fetch failed");
      return fetch(url);
    }) as unknown as typeof fetch;
    expect(await runCli(["fund", "--games", "1", "--stake", "1"], t.io)).toBe(1);
    expect(t.err.join("\n")).toContain("http://127.0.0.1:3000/templates");
  });
});

describe("Plan 5.6 Task 2: arena wallet --wait-for-usdc / --wait-for-native", () => {
  it("times out at exit 2 with reached:false and waitedSeconds >= the --timeout given", async () => {
    const env = await deployArena();
    const { home } = await initEmptyWallet(env);
    const t = fundIo(home, { env: { ARENA_WAIT_POLL_MS: "300" } });

    const code = await runCli(["wallet", "--wait-for-usdc", "1", "--timeout", "5"], t.io);
    expect(code).toBe(2);
    const printed = JSON.parse(t.out.join("\n")) as Record<string, unknown>;
    expect(printed.reached).toBe(false);
    expect(printed.waitedSeconds as number).toBeGreaterThanOrEqual(5);
  }, 20_000);

  it("funding that arrives mid-wait returns exit 0 with reached:true before the timeout", async () => {
    const env = await deployArena();
    const { home, address } = await initEmptyWallet(env);
    const t = fundIo(home, { env: { ARENA_WAIT_POLL_MS: "200" } });

    const mintDone = (async () => {
      await new Promise((r) => setTimeout(r, 1_000));
      await mintUsdc(env.usdc, address, 1_000_000n); // 1 USDC: meets the --wait-for-usdc 1 threshold
    })();
    const code = await runCli(["wallet", "--wait-for-usdc", "1", "--timeout", "15"], t.io);
    await mintDone; // never leave the mint dangling, whatever the outcome above

    expect(code).toBe(0);
    const printed = JSON.parse(t.out.join("\n")) as Record<string, unknown>;
    expect(printed.reached).toBe(true);
    expect(typeof printed.waitedSeconds).toBe("number");
    expect(printed.usdc).toBe("1.000000");
  }, 20_000);

  it("--timeout above 3600s exits 1 naming the maximum, for --wait-for-usdc and --wait-for-native alike", async () => {
    const env = await deployArena();
    const { home } = await initEmptyWallet(env);

    const t1 = fundIo(home);
    expect(await runCli(["wallet", "--wait-for-usdc", "1", "--timeout", "3601"], t1.io)).toBe(1);
    expect(t1.err.join("\n")).toMatch(/3600/);

    const t2 = fundIo(home);
    expect(await runCli(["wallet", "--wait-for-native", "0.5", "--timeout", "3601"], t2.io)).toBe(1);
    expect(t2.err.join("\n")).toMatch(/3600/);
  });
});
