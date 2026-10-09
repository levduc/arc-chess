import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import {
  arenaPaths,
  initHome,
  livePidHoldingLock,
  loadConfig,
  loadToken,
  runCli,
  startApi,
  startDaemonProcess,
  withdrawReserve,
  writeJsonAtomic,
  type ArenaConfig,
  type CliIo,
  type DaemonProcess,
} from "../src/index.js";
import { setOwner } from "../src/owner.js";
import { RPC, deployArena, increaseTime, mintUsdc, publicClient, setEthBalance, usdcBalance } from "../../sdk/test/helpers/chain.js";
import { startPair, waitFor } from "./helpers/harness.js";

// Plan 5.6 Task 3 (spec §4.4): `arena withdraw`, end to end against Anvil 8546. Every home here points its host
// at a closed loopback port: a daemon's host connection only retries in the background, and withdraw never needs
// the host -- so the CLI's in-process daemon (and a test's own startDaemonProcess) run for real.
const NOWHERE = "http://127.0.0.1:9";

let cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** A free TCP port on 127.0.0.1, for a daemon whose API the CLI must find through config.json's `port`. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const newAddress = (): Address => privateKeyToAccount(generatePrivateKey()).address;

/** A fresh home against a freshly deployed hub, with a fresh wallet holding `usdc` USDC and 1 native. */
async function walletHome(opts: { usdc?: bigint; port?: number } = {}) {
  const env = await deployArena();
  const walletKey = generatePrivateKey();
  const wallet = privateKeyToAccount(walletKey).address;
  const home = mkdtempSync(join(tmpdir(), "arena-withdraw-"));
  const config: ArenaConfig = {
    rpcUrl: RPC,
    chainId: env.domain.chainId,
    hub: env.hub,
    usdc: env.usdc,
    rules: env.rules,
    serverUrl: NOWHERE,
    port: opts.port ?? 0,
    maxFeePerPlayer: 10_000n,
    sessionGasWei: 10n ** 16n,
    pollMs: 100,
    minChallengeTimeout: 60n,
  };
  initHome(home, config, walletKey);
  await mintUsdc(env.usdc, wallet, opts.usdc ?? 10_000_000n);
  await setEthBalance(wallet, 10n ** 18n);
  return { env, home, wallet };
}

/** A CliIo with the real fetch (recorded), for an agent: no TTY. */
function cliIo(home: string) {
  const out: string[] = [];
  const err: string[] = [];
  const urls: string[] = [];
  const io: CliIo = {
    env: { ARENA_HOME: home },
    fetch: ((url: string, init?: RequestInit) => {
      urls.push(url);
      return fetch(url, init);
    }) as unknown as typeof fetch,
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    stdinIsTTY: false,
    stdoutIsTTY: false,
  };
  return { out, err, urls, io, json: () => JSON.parse(out.join("\n")) as Record<string, unknown> };
}

/** The owner's first set, as an agent would do it (no TTY needed). */
async function firstSet(home: string, owner: Address): Promise<void> {
  await setOwner(home, owner, cliIo(home).io, "arena");
  expect(loadConfig(home).owner).toBe(owner);
}

/** A human at a terminal confirming a change to `owner`. */
function humanAt(home: string, owner: Address): CliIo {
  return { ...cliIo(home).io, stdinIsTTY: true, stdoutIsTTY: true, prompt: async () => owner.slice(-6) };
}

async function startDaemon(home: string): Promise<DaemonProcess> {
  const proc = await startDaemonProcess(home, { log: () => {} });
  cleanups.push(() => proc.stop());
  return proc;
}

describe("arena withdraw (spec §4.4)", () => {
  it("withdrawReserve is 0 on this native-gas chain (the Plan 6 Arc seam)", () => {
    expect(withdrawReserve()).toBe(0n);
  });

  it("with no owner set: exit 1 naming `owner set`, nothing moves, and no daemon is left running", async () => {
    const { env, home, wallet } = await walletHome();
    const t = cliIo(home);
    expect(await runCli(["withdraw", "--all"], t.io)).toBe(1);
    expect(t.err.join("\n")).toContain("owner set");
    expect(await usdcBalance(env.usdc, wallet)).toBe(10_000_000n);
    expect(livePidHoldingLock(home)).toBeNull();
  });

  it("no running daemon: --amount 3 starts one in-process, sends exactly 3 USDC to the owner, and stops it", async () => {
    const { env, home, wallet } = await walletHome();
    const owner = newAddress();
    await firstSet(home, owner);
    const t = cliIo(home);
    expect(await runCli(["withdraw", "--amount", "3"], t.io), t.err.join("\n")).toBe(0);
    const printed = t.json();
    expect(Object.keys(printed)).toEqual(["to", "amount", "txHash", "usdcAfter"]);
    expect(printed.to).toBe(owner);
    expect(printed.amount).toBe("3.000000");
    expect(printed.usdcAfter).toBe("7.000000");
    expect(printed.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await usdcBalance(env.usdc, owner)).toBe(3_000_000n); // the owner started at 0: the delta is exact
    expect(await usdcBalance(env.usdc, wallet)).toBe(7_000_000n);
    // An ERC-20 transfer from the wallet to the token contract -- never to the hub, never anywhere else.
    const receipt = await publicClient().getTransactionReceipt({ hash: printed.txHash as Hex });
    expect(receipt.from.toLowerCase()).toBe(wallet.toLowerCase());
    expect(receipt.to?.toLowerCase()).toBe(env.usdc.toLowerCase());
    // No API call: the in-process path talks to its daemon directly.
    expect(t.urls.filter((u) => u.includes("/withdraw"))).toEqual([]);
    expect(livePidHoldingLock(home)).toBeNull();
  });

  it("--all moves the whole USDC balance (reserve 0); the native balance pays the gas and nothing else", async () => {
    const { env, home, wallet } = await walletHome({ usdc: 12_345_678n });
    const owner = newAddress();
    await firstSet(home, owner);
    const nativeBefore = await publicClient().getBalance({ address: wallet });
    const t = cliIo(home);
    expect(await runCli(["withdraw", "--all"], t.io), t.err.join("\n")).toBe(0);
    const printed = t.json();
    expect(printed.amount).toBe("12.345678");
    expect(printed.usdcAfter).toBe("0.000000");
    expect(await usdcBalance(env.usdc, owner)).toBe(12_345_678n);
    expect(await usdcBalance(env.usdc, wallet)).toBe(0n);
    const receipt = await publicClient().getTransactionReceipt({ hash: printed.txHash as Hex });
    const nativeAfter = await publicClient().getBalance({ address: wallet });
    expect(nativeBefore - nativeAfter).toBe(receipt.gasUsed * receipt.effectiveGasPrice);
    expect(await publicClient().getBalance({ address: owner })).toBe(0n); // USDC only, never native
    expect(livePidHoldingLock(home)).toBeNull();
  });

  it("refuses --amount 0 and an amount above the balance (exit 1, the latter saying to close open channels); bad flags are usage errors", async () => {
    const { env, home, wallet } = await walletHome();
    const owner = newAddress();
    await firstSet(home, owner);

    for (const zero of ["0", "0.000000"]) {
      const t = cliIo(home);
      expect(await runCli(["withdraw", "--amount", zero], t.io)).toBe(1);
      expect(t.err.join("\n")).toMatch(/greater than 0/);
    }

    const over = cliIo(home);
    expect(await runCli(["withdraw", "--amount", "10.000001"], over.io)).toBe(1);
    expect(over.err.join("\n")).toMatch(/close open channels first/);
    expect(over.err.join("\n")).toContain("10.000000 USDC"); // the withdrawable amount, formatted
    expect(livePidHoldingLock(home)).toBeNull(); // the in-process daemon was stopped despite the refusal

    for (const bad of [["withdraw"], ["withdraw", "--all", "--amount", "1"], ["withdraw", "--amount", "abc"], ["withdraw", "--amount", "1.0000001"]]) {
      expect(await runCli(bad, cliIo(home).io), bad.join(" ")).toBe(2);
    }
    expect(await usdcBalance(env.usdc, owner)).toBe(0n);
    expect(await usdcBalance(env.usdc, wallet)).toBe(10_000_000n);
  });

  it("a hand-edited forbidden owner (the wallet itself) is refused by the daemon, and nothing moves", async () => {
    const { env, home, wallet } = await walletHome();
    writeJsonAtomic(arenaPaths(home).config, { ...loadConfig(home), owner: wallet });
    const t = cliIo(home);
    expect(await runCli(["withdraw", "--amount", "1"], t.io)).toBe(1);
    expect(t.err.join("\n")).toMatch(/cannot be paid/);
    writeJsonAtomic(arenaPaths(home).config, { ...loadConfig(home), owner: env.usdc });
    expect(await runCli(["withdraw", "--amount", "1"], cliIo(home).io)).toBe(1);
    expect(await usdcBalance(env.usdc, wallet)).toBe(10_000_000n);
    expect(livePidHoldingLock(home)).toBeNull();
  });

  it("with a daemon holding the lock, the CLI goes through its API; an owner change is picked up without a restart", async () => {
    const port = await freePort();
    const { env, home, wallet } = await walletHome({ port });
    const first = await startDaemon(home);
    expect(livePidHoldingLock(home)).toBe(process.pid);

    // No owner yet: the daemon's own refusal comes back through the API, naming `owner set`.
    const none = cliIo(home);
    expect(await runCli(["withdraw", "--amount", "1"], none.io)).toBe(1);
    expect(none.err.join("\n")).toContain("owner set");
    expect(none.urls).toEqual([`http://127.0.0.1:${port}/withdraw`]);
    await first.stop();

    // Owner A is recorded before the next daemon starts, so it is in that daemon's own start-time config too: the
    // change to B below is only seen if the daemon really re-reads config.json on every withdraw.
    const ownerA = newAddress();
    await firstSet(home, ownerA);
    const proc = await startDaemon(home);
    const t1 = cliIo(home);
    expect(await runCli(["withdraw", "--amount", "1"], t1.io), t1.err.join("\n")).toBe(0);
    expect(t1.urls).toEqual([`http://127.0.0.1:${port}/withdraw`]);
    expect(t1.json()).toMatchObject({ to: ownerA, amount: "1.000000", usdcAfter: "9.000000" });
    expect(await usdcBalance(env.usdc, ownerA)).toBe(1_000_000n);

    // A human changes the owner (TTY path) while the same daemon keeps running: the next withdraw pays the new one.
    const ownerB = newAddress();
    await setOwner(home, ownerB, humanAt(home, ownerB), "arena");
    const t2 = cliIo(home);
    expect(await runCli(["withdraw", "--amount", "2"], t2.io), t2.err.join("\n")).toBe(0);
    expect(t2.json()).toMatchObject({ to: ownerB, amount: "2.000000", usdcAfter: "7.000000" });
    expect(await usdcBalance(env.usdc, ownerB)).toBe(2_000_000n);
    expect(await usdcBalance(env.usdc, ownerA)).toBe(1_000_000n);
    expect(livePidHoldingLock(home)).toBe(process.pid); // still the test's own daemon: the CLI started none

    // The API itself: no request can name a destination, both actors may withdraw, and a bad body is a 400.
    const token = loadToken(home);
    const post = (body: unknown, actor = "agent") =>
      fetch(`${proc.apiUrl}/withdraw`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-arena-actor": actor },
        body: JSON.stringify(body),
      });
    const attacker = newAddress();
    for (const body of [
      { amount: "1000000", to: attacker },
      { all: true, owner: attacker },
      { all: true, amount: "1" },
      { all: "yes" },
      { amount: 1 },
      { amount: "-1" },
      {},
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await usdcBalance(env.usdc, attacker)).toBe(0n);
    const asHuman = await post({ amount: "500000" }, "human");
    expect(asHuman.status).toBe(200);
    const body = (await asHuman.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ to: ownerB, amount: "500000", usdcAfter: "6500000" }); // base units on the wire
    expect(await usdcBalance(env.usdc, ownerB)).toBe(2_500_000n);
    expect(await usdcBalance(env.usdc, wallet)).toBe(6_500_000n);
  });

  it("fix round I1: a busy config.port fails a no-daemon withdraw cleanly -- exit 1 naming the port, lock released, nothing moved", async () => {
    const port = await freePort();
    const { env, home, wallet } = await walletHome({ port });
    await firstSet(home, newAddress());
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", () => r()));
    cleanups.push(() => new Promise<void>((r) => squatter.close(() => r())));

    const t = cliIo(home);
    expect(await runCli(["withdraw", "--amount", "1"], t.io)).toBe(1);
    expect(t.err.join("\n")).toContain(`127.0.0.1:${port}`);
    expect(t.err.join("\n")).toMatch(/EADDRINUSE/);
    expect(livePidHoldingLock(home)).toBeNull();
    expect(await usdcBalance(env.usdc, wallet)).toBe(10_000_000n);
  });

  it("refuses (exit 1) when another live process holds the lock but serves no API -- it never starts a second daemon", async () => {
    const port = await freePort(); // nothing listens here
    const { env, home, wallet } = await walletHome({ port });
    await firstSet(home, newAddress());
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
    cleanups.push(() => {
      other.kill("SIGKILL");
    });
    expect(other.pid).toBeGreaterThan(0);
    writeFileSync(join(home, "daemon.lock"), JSON.stringify({ pid: other.pid }));
    expect(livePidHoldingLock(home)).toBe(other.pid);

    const t = cliIo(home);
    expect(await runCli(["withdraw", "--amount", "1"], t.io)).toBe(1);
    expect(t.err.join("\n")).toMatch(/cannot be reached/);
    expect(t.urls).toEqual([`http://127.0.0.1:${port}/withdraw`]);
    expect(livePidHoldingLock(home)).toBe(other.pid); // its lock is untouched
    expect(await usdcBalance(env.usdc, wallet)).toBe(10_000_000n);
  });
});

describe("withdraw never starves a pending deposit (Review Focus 4)", () => {
  it("POST /withdraw answers 409 naming the channel while it awaits this wallet's deposit, and proceeds once its window closes", async () => {
    const pair = await startPair();
    cleanups.push(() => pair.cleanup());
    // Alice offers, then goes away before she can fund: Bob accepts, so Bob (player 1) holds a channel in phase
    // None that still awaits his own deposit -- he deposits the moment Alice's lands. (`wantsToFund` is false for
    // him right now: only "fund on this tick" -- which is why the 409 must not use it.)
    const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await pair.alice.daemon.stop();
    await pair.bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => pair.bob.daemon.channelIds()[0], 20_000, "bob's match");
    expect(pair.bob.daemon.handle(id).record.me).toBe(1);
    expect((await pair.bob.daemon.hub.channelInfo(id)).phase).toBe("None");

    const owner = newAddress();
    await firstSet(pair.bob.home, owner);
    const token = loadToken(pair.bob.home);
    const api = await startApi(pair.bob.daemon, { port: 0, token });
    cleanups.push(() => {
      api.server.close();
    });
    const post = (body: unknown) =>
      fetch(`${api.url}/withdraw`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-arena-actor": "agent" },
        body: JSON.stringify(body),
      });

    for (const body of [{ all: true }, { amount: "1" }]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain(id);
      expect(error).toMatch(/awaits this wallet's deposit/);
    }
    expect(await usdcBalance(pair.env.usdc, owner)).toBe(0n);

    // A match still being turned into a channel counts too (it is about to await a deposit).
    const claiming = (pair.bob.daemon as unknown as { claiming: Set<Hex> }).claiming;
    const inFlight = `0x${"ab".repeat(32)}` as Hex;
    claiming.add(inFlight);
    await increaseTime(3601); // past the channel's funding deadline: that channel no longer holds a withdraw up...
    const stillClaiming = await post({ amount: "1" });
    expect(stillClaiming.status).toBe(409);
    const { error } = (await stillClaiming.json()) as { error: string };
    expect(error).toContain(inFlight);
    expect(error).not.toContain(id);
    claiming.delete(inFlight);

    // ...and with nothing pending, the withdraw goes through.
    const ok = await post({ amount: "1000000" });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await usdcBalance(pair.env.usdc, owner)).toBe(1_000_000n);
  });
});
