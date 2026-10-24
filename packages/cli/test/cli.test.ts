import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { offerId as computeOfferId, signOffer, toWire, type Offer } from "@arena/sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { deployArena, mintUsdc, RPC, setEthBalance, usdcBalance as readUsdcBalance } from "../../sdk/test/helpers/chain.js";
import { arenaPaths, daemonStartLine, invalidOfferTimeoutReason, loadConfig, loadWalletKey, runCli, writeJsonAtomic } from "../src/index.js";
import { computeFundingNeed, fundMessage } from "../src/funding.js";

function io(home: string, responses: Array<{ status: number; body: unknown }> = [], opts: { chainId?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    // Task 3 fix round 1 (I3): init checks the chain id and the hub/USDC/rules code over the RPC on every run, even
    // with every chain flag explicit. Answered here as a chain (31337 unless `opts.chainId`) on which every address
    // holds code -- never taken from `responses`, never recorded in `calls`. (Tests that need the real check use
    // the real chain: see `fundIo`/`initEmptyWallet` below, and owner.test.ts.)
    let method: unknown;
    try {
      method = (JSON.parse(String(init?.body)) as { method?: unknown }).method;
    } catch {
      method = undefined;
    }
    if (method === "eth_chainId" || method === "eth_getCode") {
      const result = method === "eth_chainId" ? `0x${(opts.chainId ?? 31337).toString(16)}` : "0x6080";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    }
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
    // Final fix wave (K1): the daemon starts at step 2 again, before picking an offer and `fund --offer`.
    expect(t.err.join("\n")).toMatch(/recipe step 2\b/);
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
    const line = daemonStartLine({ apiUrl: "http://127.0.0.1:7010", pid: 4242, wallet: "0xabc123", fallback: "off" });
    const json = JSON.stringify(line);
    expect(json).not.toContain("#token=");
    expect(json).not.toContain("token");
    expect(line).toEqual({
      api: "http://127.0.0.1:7010",
      pid: 4242,
      wallet: "0xabc123",
      board: "http://127.0.0.1:7010/board",
      boardHint: "run: arena board",
      fallback: "off",
    });
  });

  it("Plan 5.7 Task 4: the daemon start line carries the daemon's own fallback (\"xmtp\" or \"off\")", () => {
    expect(daemonStartLine({ apiUrl: "http://127.0.0.1:7010", pid: 1, wallet: "0xabc123", fallback: "xmtp" })).toMatchObject({
      fallback: "xmtp",
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
    // Plan 5.6 Task 2: exactly the same four keys as before --wait-for-* existed -- toMatchObject above would
    // not catch a leaked fifth key (e.g. a stray reached/waitedSeconds).
    expect(Object.keys(printed)).toEqual(["address", "chainId", "usdc", "native"]);
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
    await runCli(mainnetInit, io(home, [], { chainId: 1 }).io);
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
    /** Final fix wave (K1): the server's public `GET /offers` reply, sent as is (already in wire format). */
    offersText?: string;
  } = {},
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith(RPC)) return fetch(url, init); // the real, deployed Anvil chain
    if (url.endsWith("/templates")) return new Response(JSON.stringify(opts.templatesBody ?? []), { status: 200 });
    if (url.endsWith("/offers") && opts.offersText !== undefined) return new Response(opts.offersText, { status: 200 });
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
 *  `init` reads no /templates (final review C1's own `--session-gas-wei` trick, reused here); its chain and code
 *  checks (Task 3 fix round 1, I3) go to the real Anvil chain through `fundIo`. */
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
    fundIo(home).io,
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

  it("Fix round 1 (Important): a hub address with no contract code exits 1, naming the hub and chain", async () => {
    const env = await deployArena();
    // Task 3 fix round 1 (I3): init now refuses a no-code hub itself, even with every chain flag explicit, so a
    // home naming one can only be one written before that (or a hand-edited config.json) -- simulated here by
    // rewriting config.json's hub after a normal init. fund must still refuse it by name.
    const noCodeHub = privateKeyToAccount(generatePrivateKey()).address;
    const { home } = await initEmptyWallet(env, "http://127.0.0.1:3000");
    writeJsonAtomic(arenaPaths(home).config, { ...loadConfig(home), hub: noCodeHub });
    const t = fundIo(home, { templatesBody: CHESS_TEMPLATE() });

    expect(await runCli(["fund", "--games", "3", "--stake", "1"], t.io)).toBe(1);
    expect(t.err.join("\n")).toContain(noCodeHub);
    expect(t.err.join("\n")).toMatch(/no contract code on chain 31337/);
    expect(t.err.join("\n")).toMatch(/arena init/); // tells the agent how to recover
    expect(t.out).toEqual([]); // never prints a feePerPlayer: "0.000000" under-ask
  });

  it("Fix round 1 (Minor): a faucet failure (500) is reported as faucet: \"skipped: ...\", still exit 0", async () => {
    const env = await deployArena();
    const { home } = await initEmptyWallet(env, "http://127.0.0.1:3000");
    let faucetCalls = 0;
    const t = fundIo(home, {
      templatesBody: CHESS_TEMPLATE({ faucet: "http://127.0.0.1:3000/faucet" }),
      faucetHandler: async () => {
        faucetCalls++;
        return { status: 500, body: { error: "faucet exploded" } };
      },
    });

    expect(await runCli(["fund", "--games", "3", "--stake", "1"], t.io)).toBe(0);
    expect(faucetCalls).toBe(1);
    const printed = JSON.parse(t.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(printed)).toEqual(["address", "chainId", "deposit", "feePerPlayer", "usdc", "native", "owner", "faucet", "message"]);
    expect(printed.faucet).toMatch(/^skipped:/);
    expect(printed.faucet as string).toMatch(/faucet exploded|500/);
    // The shortfall still reflects the (unchanged) balances -- a failed top-up never fakes success.
    expect(printed.usdc).toEqual({ have: "0.000000", need: "3.005000", shortfall: "3.005000" });
    expect(printed.native).toEqual({ have: "0.0", need: "0.06", shortfall: "0.06" });
  });
});

/** Final fix wave (K1): one signed offer, as the server's lobby holds it, and its id. */
async function signedOffer(o: { deposit: bigint; stakePerGame: bigint }): Promise<{ id: Hex; so: { offer: Offer; sig: Hex } }> {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const offer: Offer = {
    template: "chess",
    player: privateKeyToAccount(generatePrivateKey()).address,
    signer: account.address,
    deposit: o.deposit,
    stakePerGame: o.stakePerGame,
    challengeTimeout: 900n,
    expiresAt: 4_000_000_000n,
    nonce: `0x${"5a".repeat(32)}`,
  };
  return { id: computeOfferId(offer), so: { offer, sig: await signOffer(key, offer) } };
}

describe("Final fix wave (K1, I2, M10): arena fund --offer, whole-USDC errors, and zero is a usage error", () => {
  it("--offer sizes the ask from that open offer's own deposit and stake (read from the server's /offers, $bigint wire format)", async () => {
    const env = await deployArena();
    const { home, address } = await initEmptyWallet(env);
    const other = await signedOffer({ deposit: 2_000_000n, stakePerGame: 500_000n });
    const chosen = await signedOffer({ deposit: 4_000_000n, stakePerGame: 1_000_000n });
    const offersText = toWire([other.so, { junk: true }, chosen.so]);
    expect(offersText).toContain('"$bigint"'); // the server's own wire format, not plain decimals

    const t = fundIo(home, { templatesBody: CHESS_TEMPLATE(), offersText });
    expect(await runCli(["fund", "--offer", chosen.id.toUpperCase().replace("0X", "0x")], t.io)).toBe(0);
    expect(t.calls.map((c) => c.url)).toContain("http://127.0.0.1:3000/offers");
    const printed = JSON.parse(t.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(printed)).toEqual(["address", "chainId", "offerId", "stakePerGame", "deposit", "feePerPlayer", "usdc", "native", "owner", "message"]);
    expect(printed.offerId).toBe(chosen.id);
    expect(printed.stakePerGame).toBe("1.000000");
    expect(printed.deposit).toBe("4.000000"); // the offer's deposit, in whole USDC -- no conversion by the agent
    expect(printed.usdc).toEqual({ have: "0.000000", need: "4.005000", shortfall: "4.005000" });
    expect(printed.message).toBe(`Please send 4.005000 USDC and 0.06 native gas to ${address} on chain 31337. Also tell me the address to return winnings to.`);

    // --games is optional with --offer, and only shapes the "enough to play" message.
    await mintUsdc(env.usdc, address, 5_000_000n);
    await setEthBalance(address, 10n ** 18n);
    const t2 = fundIo(home, { templatesBody: CHESS_TEMPLATE(), offersText });
    expect(await runCli(["fund", "--offer", chosen.id], t2.io)).toBe(0);
    expect((JSON.parse(t2.out.join("\n")) as { message: string }).message).toBe(
      "This wallet already holds enough to play 4 games at 1.000000 USDC. Tell me the address to return winnings to.",
    );
    const t3 = fundIo(home, { templatesBody: CHESS_TEMPLATE(), offersText });
    expect(await runCli(["fund", "--offer", chosen.id, "--games", "2"], t3.io)).toBe(0);
    const printed3 = JSON.parse(t3.out.join("\n")) as { deposit: string; message: string };
    expect(printed3.deposit).toBe("4.000000");
    expect(printed3.message).toMatch(/^This wallet already holds enough to play 2 games at 1\.000000 USDC\./);
  });

  it("--offer for an offer that is not open any more exits 1 with \"offer <id> is not open any more; run offers again\"", async () => {
    const env = await deployArena();
    const { home } = await initEmptyWallet(env);
    const gone = await signedOffer({ deposit: 4_000_000n, stakePerGame: 1_000_000n });
    const still = await signedOffer({ deposit: 2_000_000n, stakePerGame: 1_000_000n });
    const t = fundIo(home, { templatesBody: CHESS_TEMPLATE(), offersText: toWire([still.so]) });
    expect(await runCli(["fund", "--offer", gone.id], t.io)).toBe(1);
    expect(t.err.join("\n")).toContain(`offer ${gone.id} is not open any more; run offers again`);
    expect(t.out).toEqual([]);
  });

  it("--offer is mutually exclusive with --deposit (and --stake), and must look like an offer id: usage errors (exit 2) before any read", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-cli-fund-")); // no config at all: flags are checked first
    const id = `0x${"ab".repeat(32)}`;
    for (const [args, message] of [
      [["fund", "--offer", id, "--deposit", "10"], "--offer and --deposit are mutually exclusive"],
      [["fund", "--offer", id, "--stake", "1"], "--offer and --stake are mutually exclusive"],
      [["fund", "--offer", "0x1234"], "--offer must be an offer id"],
      [["fund", "--offer", id, "--games", "0"], "--games must be a positive whole number of games"],
    ] as const) {
      const t = fundIo(home);
      expect(await runCli([...args], t.io), args.join(" ")).toBe(2);
      expect(t.err.join("\n")).toContain(message);
      expect(t.calls).toEqual([]);
    }
  });

  it("M10: --games 0 and --stake 0 are usage errors (exit 2), not a later RangeError", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-cli-fund-"));
    for (const [args, message] of [
      [["fund", "--games", "0", "--stake", "1"], "--games must be a positive whole number of games"],
      [["fund", "--games", "2", "--stake", "0"], "--stake must be a positive USDC amount"],
      [["fund", "--games", "2", "--stake", "0.000000"], "--stake must be a positive USDC amount"],
    ] as const) {
      const t = fundIo(home);
      expect(await runCli([...args], t.io), args.join(" ")).toBe(2);
      expect(t.err.join("\n")).toContain(message);
    }
  });

  it("every amount in fund's errors is whole USDC, the cap included -- for --deposit and for an offer above the cap", async () => {
    const env = await deployArena();
    const { home } = await initEmptyWallet(env);

    const t1 = fundIo(home, { templatesBody: CHESS_TEMPLATE() });
    expect(await runCli(["fund", "--games", "3", "--stake", "1", "--deposit", "10000000"], t1.io)).toBe(1);
    const e1 = t1.err.join("\n");
    expect(e1).toContain("deposit must be between the stake and the cap: 1.000000 to 10.000000 USDC (asked for 10000000.000000 USDC) (--deposit takes whole USDC)");

    const big = await signedOffer({ deposit: 20_000_000n, stakePerGame: 1_000_000n });
    const t2 = fundIo(home, { templatesBody: CHESS_TEMPLATE(), offersText: toWire([big.so]) });
    expect(await runCli(["fund", "--offer", big.id], t2.io)).toBe(1);
    const e2 = t2.err.join("\n");
    expect(e2).toContain("deposit must be between the stake and the cap: 1.000000 to 10.000000 USDC (asked for 20.000000 USDC)");
    expect(e2).toContain(`offer ${big.id}'s deposit is outside this host's current cap -- pick another offer`);
    for (const e of [e1, e2]) expect(e).not.toMatch(/\b10000000\b(?!\.)|\b20000000\b/); // never the cap or deposit in base units
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
    expect(Object.keys(printed)).toEqual(["address", "chainId", "usdc", "native", "reached", "waitedSeconds"]);
    expect(printed.reached).toBe(false);
    expect(printed.waitedSeconds as number).toBeGreaterThanOrEqual(5);
  }, 20_000);

  it("funding that arrives mid-wait returns exit 0 with reached:true before the timeout (both thresholds)", async () => {
    const env = await deployArena();
    const { home, address } = await initEmptyWallet(env);
    const t = fundIo(home, { env: { ARENA_WAIT_POLL_MS: "200" } });

    const fundingDone = (async () => {
      await new Promise((r) => setTimeout(r, 1_000));
      await mintUsdc(env.usdc, address, 1_000_000n); // 1 USDC: meets the --wait-for-usdc 1 threshold
      await setEthBalance(address, 10n ** 18n); // 1 ether: meets the --wait-for-native 0.5 threshold
    })();
    const code = await runCli(["wallet", "--wait-for-usdc", "1", "--wait-for-native", "0.5", "--timeout", "15"], t.io);
    await fundingDone; // never leave the mint/setBalance dangling, whatever the outcome above

    expect(code).toBe(0);
    const printed = JSON.parse(t.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(printed)).toEqual(["address", "chainId", "usdc", "native", "reached", "waitedSeconds"]);
    expect(printed.reached).toBe(true);
    expect(typeof printed.waitedSeconds).toBe("number");
    // Detects promptly: the mint/setBalance lands at ~1s with a 200ms poll interval, well inside the 15s
    // --timeout -- an explicit upper bound makes "detects promptly", not just "eventually", part of the test.
    expect(printed.waitedSeconds as number).toBeLessThanOrEqual(10);
    expect(printed.usdc).toBe("1.000000");
    expect(printed.native).toBe("1.0"); // proves --wait-for-native is actually checked, not just accepted
  }, 20_000);

  it("final fix wave (M8): ARENA_WAIT_POLL_MS never polls faster than every 200 ms", async () => {
    const env = await deployArena();
    const { home } = await initEmptyWallet(env);
    const t = fundIo(home, { env: { ARENA_WAIT_POLL_MS: "1" } });
    expect(await runCli(["wallet", "--wait-for-usdc", "1", "--timeout", "2"], t.io)).toBe(2);
    // Two reads (USDC, native) per poll. Unclamped, a 1 ms poll would make hundreds of calls in 2 s; at the 200 ms
    // floor it is at most 2 x (2000 / 200 + 1) = 22.
    const rpcCalls = t.calls.filter((c) => c.url.startsWith(RPC)).length;
    expect(rpcCalls).toBeGreaterThanOrEqual(4);
    expect(rpcCalls).toBeLessThanOrEqual(22);
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

  it("a malformed --wait-for-usdc/--wait-for-native/--timeout exits 1, not the usual usage-error 2 (spec §4.2 reserves 2 for an elapsed timeout)", async () => {
    const env = await deployArena();
    const { home } = await initEmptyWallet(env);

    const t1 = fundIo(home);
    expect(await runCli(["wallet", "--wait-for-usdc", "abc"], t1.io)).toBe(1);

    const t2 = fundIo(home);
    expect(await runCli(["wallet", "--wait-for-native", "abc"], t2.io)).toBe(1);

    const t3 = fundIo(home);
    expect(await runCli(["wallet", "--wait-for-usdc", "1", "--timeout", "abc"], t3.io)).toBe(1);
  });
});

// ------------------------------------------------------------- Plan 6 (spec §2.1): one balance on Arc (wallet, fund)

const ARC_USDC = "0x3600000000000000000000000000000000000000";

/** An Arc home (chain `chainId`, its profile's USDC), written by an explicit-flag init: no /templates, and only the
 *  chain-id and code checks over the RPC, which `io()` answers. */
async function initArcHome(chainId = 5042002) {
  const home = mkdtempSync(join(tmpdir(), "arena-cli-arc-"));
  const args = [
    "init", "--rpc", "http://arc-rpc.test", "--chain-id", String(chainId),
    "--hub", "0x000000000000000000000000000000000000beef", "--usdc", ARC_USDC,
    "--rules", "0x00000000000000000000000000000000000000e5", "--server", "http://127.0.0.1:3000", "--port", "7010",
    "--session-gas-wei", "10000000000000000", // 1e16 wei = 0.01 USDC
    // Fix round 1 (m-3): explicit, so the pinned amounts below do not move with the profile's default ceiling
    // (Task 2). 500,000 x 40 gwei = 0.02 USDC.
    "--fee-ceiling-wei", "40000000000",
  ];
  const t = io(home, [], { chainId });
  expect(await runCli(args, t.io), t.err.join("\n")).toBe(0);
  return home;
}

/** JSON-RPC calls `arcIo` answered, each as its method -- an `eth_call` with its 4-byte selector. */
function arcIo(
  home: string,
  opts: { balanceWei: bigint | (() => bigint); env?: Record<string, string>; faucet?: () => { usdc: bigint; native: bigint } },
) {
  const rpc: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/templates")) {
      return new Response(JSON.stringify(CHESS_TEMPLATE(opts.faucet ? { faucet: "http://127.0.0.1:3000/faucet" } : {})));
    }
    if (url.endsWith("/faucet") && opts.faucet) {
      const f = opts.faucet();
      return new Response(JSON.stringify({ address: "0x", usdc: f.usdc.toString(), native: f.native.toString() }));
    }
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: Array<{ data?: string }> };
    rpc.push(req.method === "eth_call" ? `eth_call ${String(req.params[0]?.data).slice(0, 10)}` : req.method);
    const balance = typeof opts.balanceWei === "function" ? opts.balanceWei() : opts.balanceWei;
    const result =
      req.method === "eth_getBalance"
        ? `0x${balance.toString(16)}`
        : req.method === "eth_call"
          ? `0x${(5_000n).toString(16).padStart(64, "0")}` // the hub's feePerPlayer: 0.005 USDC
          : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
  }) as unknown as typeof fetch;
  return {
    rpc,
    out,
    err,
    io: { env: { ARENA_HOME: home, ...opts.env }, fetch: fetchFn, out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    json: () => JSON.parse(out.join("\n")) as Record<string, unknown>,
  };
}

describe("Plan 6 (spec §2.1, Review Focus 1): one balance on a nativeIsUsdc chain", () => {
  it("wallet prints {address, chainId, usdc}: the native balance / 10^12, rounded down -- one eth_getBalance, no balanceOf", async () => {
    for (const chainId of [5042, 5042002]) {
      const home = await initArcHome(chainId);
      const t = arcIo(home, { balanceWei: 1_234_567_890_123_456_789n });
      expect(await runCli(["wallet"], t.io), t.err.join("\n")).toBe(0);
      expect(t.rpc).toEqual(["eth_getBalance"]);
      const printed = t.json();
      expect(Object.keys(printed)).toEqual(["address", "chainId", "usdc"]);
      expect(printed).toMatchObject({ chainId, usdc: "1.234567" });
    }
  });

  it("wallet rounds a sub-micro-USDC remainder down: 10^12 - 1 wei is 0.000000, 10^12 + 1 wei is 0.000001", async () => {
    const home = await initArcHome();
    for (const [wei, shown] of [[10n ** 12n - 1n, "0.000000"], [10n ** 12n, "0.000001"], [10n ** 12n + 1n, "0.000001"], [1n, "0.000000"]] as const) {
      const t = arcIo(home, { balanceWei: wei });
      expect(await runCli(["wallet"], t.io)).toBe(0);
      expect(t.json().usdc, String(wei)).toBe(shown);
    }
  });

  it("wallet --wait-for-usdc waits on the one balance; --wait-for-native is refused (exit 1) with no read", async () => {
    const home = await initArcHome();
    let polls = 0;
    const t = arcIo(home, { balanceWei: () => (++polls >= 2 ? 2n * 10n ** 18n : 10n ** 18n), env: { ARENA_WAIT_POLL_MS: "200" } });
    expect(await runCli(["wallet", "--wait-for-usdc", "1.5", "--timeout", "10"], t.io), t.err.join("\n")).toBe(0);
    const printed = t.json();
    expect(Object.keys(printed)).toEqual(["address", "chainId", "usdc", "reached", "waitedSeconds"]);
    expect(printed).toMatchObject({ usdc: "2.000000", reached: true });
    expect(t.rpc).toEqual(["eth_getBalance", "eth_getBalance"]); // one read per poll

    const n = arcIo(home, { balanceWei: 10n ** 18n });
    expect(await runCli(["wallet", "--wait-for-native", "0.5", "--timeout", "5"], n.io)).toBe(1);
    expect(n.err.join("\n")).toMatch(/--wait-for-native does not apply on Arc Testnet: its gas is paid in USDC.*--wait-for-usdc/);
    expect(n.rpc).toEqual([]);
    expect(n.out).toEqual([]);
  });

  it("fund folds the gas into usdc.need, prints no native, and its message asks for USDC only", async () => {
    const home = await initArcHome();
    const address = privateKeyToAccount(loadWalletKey(home)).address;

    const t = arcIo(home, { balanceWei: 0n });
    expect(await runCli(["fund", "--games", "3", "--stake", "1"], t.io), t.err.join("\n")).toBe(0);
    const printed = t.json();
    expect(Object.keys(printed)).toEqual(["address", "chainId", "deposit", "feePerPlayer", "usdc", "owner", "message"]);
    expect(printed.deposit).toBe("3.000000");
    expect(printed.feePerPlayer).toBe("0.005000");
    // 3 + 0.005 + ceil((1e16 session gas + 500,000 x 40 gwei) / 10^12) = 3.005 + 0.03; no other channel, nothing reserved
    expect(printed.usdc).toEqual({ have: "0.000000", need: "3.035000", shortfall: "3.035000", reserved: "0.000000" });
    expect(printed.message).toBe(
      `Please send 3.035000 USDC to ${address} on chain 5042002. Also tell me the address to return winnings to.`,
    );
    // The one balance is the native one: no USDC balanceOf (0x70a08231) at all.
    expect(t.rpc.filter((m) => m.startsWith("eth_call 0x70a08231"))).toEqual([]);
    expect(t.rpc.filter((m) => m === "eth_getBalance")).toHaveLength(1);

    // Part of it already there: have is the native balance rounded down; the shortfall is the rest.
    const part = arcIo(home, { balanceWei: 1_500_000_000_000_000_001n });
    expect(await runCli(["fund", "--games", "3", "--stake", "1"], part.io)).toBe(0);
    expect(part.json().usdc).toEqual({ have: "1.500000", need: "3.035000", shortfall: "1.535000", reserved: "0.000000" });
    expect(part.json().message).toBe(`Please send 1.535000 USDC to ${address} on chain 5042002. Also tell me the address to return winnings to.`);

    // Enough: nothing to send.
    const enough = arcIo(home, { balanceWei: 3_035_000n * 10n ** 12n });
    expect(await runCli(["fund", "--games", "3", "--stake", "1"], enough.io)).toBe(0);
    expect(enough.json().usdc).toEqual({ have: "3.035000", need: "3.035000", shortfall: "0.000000", reserved: "0.000000" });
    expect(enough.json().message).toBe("This wallet already holds enough to play 3 games at 1.000000 USDC. Tell me the address to return winnings to.");
  });

  it("fix round 1 (I-5): fund keeps one session gas per unfinalized channel of the home in need, as usdc.reserved; have stays the balance", async () => {
    const home = await initArcHome();
    const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
    const save = (channelId: Hex, finalized: boolean) => writeJsonAtomic(arenaPaths(home).channelRecord(channelId), { channelId, finalized });
    save(id(1), false);
    save(id(2), false);
    save(id(3), true); // finalized: no refill left to pay for

    // Exactly the old need (3.035) is in the wallet, but 2 x 0.01 of it belongs to the two unsettled channels.
    const t = arcIo(home, { balanceWei: 3_035_000n * 10n ** 12n });
    expect(await runCli(["fund", "--games", "3", "--stake", "1"], t.io), t.err.join("\n")).toBe(0);
    expect(t.json().usdc).toEqual({ have: "3.035000", need: "3.055000", shortfall: "0.020000", reserved: "0.020000" });
    expect(t.json().message).toMatch(/^Please send 0\.020000 USDC to 0x[0-9a-fA-F]{40} on chain 5042002\./);
  });

  it("fix round 1 (m-6): on a one-balance chain, fund's faucet report is {usdc} only", async () => {
    const home = await initArcHome();
    let funded = false;
    const t = arcIo(home, {
      balanceWei: () => (funded ? 10n * 10n ** 18n : 0n),
      faucet: () => {
        funded = true;
        return { usdc: 10_000_000n, native: 10n * 10n ** 18n };
      },
    });
    expect(await runCli(["fund", "--games", "3", "--stake", "1"], t.io), t.err.join("\n")).toBe(0);
    const printed = t.json();
    expect(printed.faucet).toEqual({ usdc: "10.000000" });
    expect(Object.keys(printed)).toEqual(["address", "chainId", "deposit", "feePerPlayer", "usdc", "owner", "faucet", "message"]);
    expect(printed.usdc).toEqual({ have: "10.000000", need: "3.035000", shortfall: "0.000000", reserved: "0.000000" });
  });
});
