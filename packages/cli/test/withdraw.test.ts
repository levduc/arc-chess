import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  createTestClient,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  http,
  LimitExceededRpcError,
  pad,
  toHex,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { foundry } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HubClient,
  TxDroppedError,
  TxReceiptMissingError,
  TxStuckError,
  TxWaitAbortedError,
  rpcTransport,
  type LobbyClient,
  type RelayClient,
} from "@arena/sdk";
import {
  ArenaDaemon,
  DaemonError,
  KNOWN_DEPLOYMENTS,
  MAX_MATCH_RETRIES,
  RecordStore,
  WITHDRAW_UNCONFIRMED_HOLD_MS,
  arenaPaths,
  confirmsTransfer,
  initHome,
  livePidHoldingLock,
  loadConfig,
  loadToken,
  loadWalletKey,
  runCli,
  startApi,
  startDaemonProcess,
  withdrawReserve,
  withdrawWaitError,
  writeJsonAtomic,
  type ArenaConfig,
  type CliIo,
  type DaemonProcess,
  type PendingWithdraw,
} from "../src/index.js";
import { CHAIN_PROFILES, chainProfile, type ChainProfile } from "../src/chains.js";
import { oneBalanceOpenNeed } from "../src/funding.js";
import { ownerChangeMessage, setOwner } from "../src/owner.js";
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

/** A CliIo with the real fetch (recorded). */
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
  };
  return { out, err, urls, io, json: () => JSON.parse(out.join("\n")) as Record<string, unknown> };
}

/** The owner's first set, as an agent would do it (no signature needed). */
async function firstSet(home: string, owner: Address): Promise<void> {
  await setOwner(home, owner, cliIo(home).io, "arena");
  expect(loadConfig(home).owner).toBe(owner);
}

/** The current owner (`currentKey`) signing a change of `home`'s owner to `next`, at `nonce`, then `owner set`. */
async function signedChange(home: string, wallet: Address, currentKey: Hex, next: Address, nonce: number): Promise<void> {
  const current = privateKeyToAccount(currentKey);
  const message = ownerChangeMessage({ wallet, chainId: 31337, currentOwner: current.address, newOwner: next, nonce });
  await setOwner(home, next, cliIo(home).io, "arena", await current.signMessage({ message }));
  expect(loadConfig(home).owner).toBe(next);
}

async function startDaemon(home: string): Promise<DaemonProcess> {
  const proc = await startDaemonProcess(home, { log: () => {} });
  cleanups.push(() => proc.stop());
  return proc;
}

describe("arena withdraw (spec §4.4)", () => {
  it("withdrawReserve is 0 on anvil 31337, which has no chain profile -- whatever its channels and gas (Plan 6)", () => {
    expect(chainProfile(31337)).toBeUndefined();
    for (const unsettledChannels of [0, 1, 3]) {
      expect(
        withdrawReserve({ profile: chainProfile(31337), unsettledChannels, sessionGasWei: 10n ** 16n, feeCeilingWei: 100_000_000_000n }),
      ).toBe(0n);
    }
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

  it("a hand-edited forbidden owner -- the wallet, the USDC token, the hub, the rules or a session key -- is refused by the daemon, and nothing moves", async () => {
    const { env, home, wallet } = await walletHome();
    // A settled (and swept) channel record in this home, holding a session key.
    const sessionKey = generatePrivateKey();
    const channelId = `0x${randomBytes(32).toString("hex")}` as Hex;
    writeJsonAtomic(arenaPaths(home).channelRecord(channelId), { channelId, sessionKey, me: 0, finalized: true, swept: true });
    const forbidden: Array<[string, Address]> = [
      ["the wallet", wallet],
      ["the USDC token", env.usdc],
      ["the hub", env.hub],
      ["the rules contract", env.rules],
      ["a session key", privateKeyToAccount(sessionKey).address],
    ];
    for (const [what, owner] of forbidden) {
      writeJsonAtomic(arenaPaths(home).config, { ...loadConfig(home), owner });
      const t = cliIo(home);
      expect(await runCli(["withdraw", "--amount", "1"], t.io), what).toBe(1);
      expect(t.err.join("\n"), what).toMatch(/cannot be paid/);
      expect(livePidHoldingLock(home), what).toBeNull();
    }
    expect(await usdcBalance(env.usdc, wallet)).toBe(10_000_000n);
  });

  it("fix round M2: withdraw takes no destination -- --to, a bare address or any other flag is a usage error, and nothing moves", async () => {
    const { env, home, wallet } = await walletHome();
    const owner = newAddress();
    await firstSet(home, owner);
    const evil = newAddress();
    for (const args of [
      ["withdraw", "--all", "--to", evil],
      ["withdraw", "--amount", "1", "--to", evil],
      ["withdraw", evil, "--all"],
      ["withdraw", "--all", evil],
      ["withdraw", "--amount", "1", "--channel", `0x${"ab".repeat(32)}`],
      ["withdraw", "--all", "--offer-draw"],
    ]) {
      const t = cliIo(home);
      expect(await runCli(args, t.io), args.join(" ")).toBe(2);
      expect(t.err.join("\n"), args.join(" ")).toContain("withdraw always pays the recorded owner; it takes no destination");
      expect(t.urls, args.join(" ")).toEqual([]);
    }
    expect(await usdcBalance(env.usdc, evil)).toBe(0n);
    expect(await usdcBalance(env.usdc, owner)).toBe(0n);
    expect(await usdcBalance(env.usdc, wallet)).toBe(10_000_000n);
    expect(livePidHoldingLock(home)).toBeNull();
  });

  it("fix rounds M3 and 4 (N4): a token whose transfer returns false emits no Transfer log -- a 502, never reported as sent", async () => {
    const { home, wallet } = await walletHome();
    // A stand-in "USDC" (set with anvil_setCode): balanceOf(...) answers 10 USDC, every other call -- transfer
    // included -- returns one zero word (false) without reverting, and nothing ever moves.
    //   PUSH1 0 CALLDATALOAD PUSH1 0xe0 SHR DUP1 PUSH4 balanceOf EQ PUSH1 0x15 JUMPI   (selector dispatch)
    //   PUSH1 0x20 PUSH1 0 RETURN                                                      (32 zero bytes: false)
    //   JUMPDEST PUSH4 10_000_000 PUSH1 0 MSTORE PUSH1 0x20 PUSH1 0 RETURN             (the balance)
    const fakeUsdc = newAddress();
    const anvil = createTestClient({ mode: "anvil", chain: foundry, transport: http(RPC) });
    const code = ["600035", "60e01c", "80", "6370a08231", "14", "6015", "57", "60206000f3", "5b", "6300989680", "600052", "60206000f3"];
    await anvil.setCode({ address: fakeUsdc, bytecode: `0x${code.join("")}` });
    writeJsonAtomic(arenaPaths(home).config, { ...loadConfig(home), usdc: fakeUsdc });
    const owner = newAddress();
    await firstSet(home, owner);

    const t = cliIo(home);
    expect(await runCli(["withdraw", "--amount", "3"], t.io)).toBe(1);
    expect(t.err.join("\n")).toMatch(/could not confirm the transfer in tx 0x[0-9a-f]{64}; check it before retrying/);
    expect(t.out).toEqual([]); // no {to, amount, txHash, usdcAfter}: nothing claims it was sent
    expect(livePidHoldingLock(home)).toBeNull();
    // The transfer really was mined as a success -- that is exactly what must not be trusted on its own -- and its
    // receipt holds no log at all.
    const tx = /tx (0x[0-9a-f]{64})/.exec(t.err.join("\n"))?.[1] as Hex;
    const receipt = await publicClient().getTransactionReceipt({ hash: tx });
    expect(receipt.status).toBe("success");
    expect(receipt.from.toLowerCase()).toBe(wallet.toLowerCase());
    expect(receipt.to?.toLowerCase()).toBe(fakeUsdc.toLowerCase());
    expect(receipt.logs).toEqual([]);
  });

  it("fix round 4 (N4): USDC reaching the wallet in the transfer's own block cannot fail a withdraw -- balances decide nothing", async () => {
    const { env, home } = await walletHome();
    const owner = newAddress();
    await firstSet(home, owner);
    const proc = await startDaemon(home);
    // The chain as the daemon reads it when 5 USDC (a settlement payout, a top-up) reaches the wallet in the transfer's
    // own block: every balance read at a block after `start` shows it. Across that block the balance then goes up by
    // 2 instead of down by 3, which fix round 1's balance-delta check (M3) took for a transfer that never happened.
    const daemon = proc.daemon as unknown as { usdcBalance(usdc: Address, blockNumber?: bigint): Promise<bigint> };
    const real = daemon.usdcBalance.bind(daemon);
    const start = await publicClient().getBlockNumber();
    const spy = vi.spyOn(daemon, "usdcBalance").mockImplementation(async (usdc, blockNumber) => {
      const at = blockNumber ?? (await publicClient().getBlockNumber());
      const balance = await real(usdc, blockNumber);
      return at > start ? balance + 5_000_000n : balance;
    });
    cleanups.push(() => spy.mockRestore());

    const sent = await proc.daemon.withdraw({ amount: 3_000_000n });
    const receipt = await publicClient().getTransactionReceipt({ hash: sent.txHash });
    expect(receipt.blockNumber).toBe(start + 1n); // the block the inflow is modelled in
    expect(sent).toMatchObject({ to: owner, amount: 3_000_000n, usdcAfter: 12_000_000n }); // 10 - 3 + 5, as read
    expect(await usdcBalance(env.usdc, owner)).toBe(3_000_000n); // the owner started at 0: the delta is exact
  });

  it("fix round 4 (N4): a confirmed transfer whose balance cannot be read afterwards is a success -- usdcAfter null, and a note", async () => {
    const port = await freePort();
    const { env, home, wallet } = await walletHome({ port });
    const owner = newAddress();
    await firstSet(home, owner);
    const proc = await startDaemon(home);
    // The first read (the withdrawable balance) goes through; every one after the transfer fails, as on an RPC blip.
    const daemon = proc.daemon as unknown as { usdcBalance(usdc: Address): Promise<bigint> };
    const real = daemon.usdcBalance.bind(daemon);
    let reads = 0;
    const spy = vi
      .spyOn(daemon, "usdcBalance")
      .mockImplementation((usdc) => (++reads === 1 ? real(usdc) : Promise.reject(new Error("RPC blip"))));
    cleanups.push(() => spy.mockRestore());

    // Through the API (the daemon holds the lock), so the null crosses the wire and the CLI's own check.
    const t = cliIo(home);
    expect(await runCli(["withdraw", "--amount", "2"], t.io), t.err.join("\n")).toBe(0);
    expect(t.urls).toEqual([`http://127.0.0.1:${port}/withdraw`]);
    const printed = t.json();
    expect(Object.keys(printed)).toEqual(["to", "amount", "txHash", "usdcAfter"]);
    expect(printed).toMatchObject({ to: owner, amount: "2.000000", usdcAfter: null });
    expect(t.err).toEqual([`note: sent in tx ${String(printed.txHash)}; the balance could not be read`]);
    expect(reads).toBe(2);
    expect(await usdcBalance(env.usdc, owner)).toBe(2_000_000n);
    expect(await usdcBalance(env.usdc, wallet)).toBe(8_000_000n);
  });

  it("fix round M1: open offers are reported as a note on stderr (a warning, not a refusal); the JSON keeps its four keys", async () => {
    const { env, home } = await walletHome();
    const owner = newAddress();
    await firstSet(home, owner);
    const offerId = `0x${randomBytes(32).toString("hex")}` as Hex;
    writeJsonAtomic(arenaPaths(home).offerRecord(offerId), {
      offerId,
      offer: { expiresAt: 2n ** 40n },
      sessionKey: generatePrivateKey(),
      role: "offerer",
    });
    const t = cliIo(home);
    expect(await runCli(["withdraw", "--amount", "1"], t.io), t.err.join("\n")).toBe(0);
    expect(Object.keys(t.json())).toEqual(["to", "amount", "txHash", "usdcAfter"]);
    expect(t.err.join("\n")).toMatch(new RegExp(`^note: this wallet still has 1 open offer\\(s\\) \\(${offerId}\\)`));
    expect(await usdcBalance(env.usdc, owner)).toBe(1_000_000n);
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
    const keyA = generatePrivateKey();
    const ownerA = privateKeyToAccount(keyA).address;
    await firstSet(home, ownerA);
    const proc = await startDaemon(home);
    const t1 = cliIo(home);
    expect(await runCli(["withdraw", "--amount", "1"], t1.io), t1.err.join("\n")).toBe(0);
    expect(t1.urls).toEqual([`http://127.0.0.1:${port}/withdraw`]);
    expect(t1.json()).toMatchObject({ to: ownerA, amount: "1.000000", usdcAfter: "9.000000" });
    expect(await usdcBalance(env.usdc, ownerA)).toBe(1_000_000n);

    // The owner changes (signed by A) while the same daemon keeps running: the next withdraw pays the new one.
    const ownerB = newAddress();
    await signedChange(home, wallet, keyA, ownerB, 0);
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

  it("fix round M1: a match arriving while a withdraw is in flight waits for the next pass; a deferred match holds the next withdraw up (409)", async () => {
    const pair = await startPair();
    cleanups.push(() => pair.cleanup());
    const bob = pair.bob.daemon as unknown as { withdrawing: boolean; retryMatches: Map<Hex, unknown> };
    const owner = newAddress();
    await firstSet(pair.bob.home, owner);

    // Bob's withdraw is "in flight" while the host matches his accept: the match is deferred, not handled.
    const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    bob.withdrawing = true;
    await pair.bob.daemon.acceptOffer(offerId);
    await waitFor(() => bob.retryMatches.has(offerId), 20_000, "bob's deferred match");
    await waitFor(() => pair.alice.daemon.channelIds().length === 1, 20_000, "alice's channel");
    await new Promise((r) => setTimeout(r, 500)); // several main passes (pollMs 100): each one defers it again
    expect(pair.bob.daemon.channelIds()).toEqual([]);
    expect(bob.retryMatches.has(offerId)).toBe(true);

    // The next withdraw starts in the same synchronous step the first one "ends" in: it sets `withdrawing` again
    // before any pass can run, so the match stays deferred -- and the 409 names it.
    bob.withdrawing = false;
    const refused = pair.bob.daemon.withdraw({ amount: 1n });
    await expect(refused).rejects.toMatchObject({ code: 409 });
    await expect(refused).rejects.toThrow(offerId);
    expect(await usdcBalance(pair.env.usdc, owner)).toBe(0n);

    // With no withdraw in flight, the next pass handles the match: Bob's channel opens and funds as usual.
    const id = await waitFor(() => pair.bob.daemon.channelIds()[0], 20_000, "bob's channel after the withdraw");
    expect(id).toBe(pair.alice.daemon.channelIds()[0]);
    await waitFor(async () => (await pair.bob.daemon.hub.channelInfo(id)).phase === "Open", 30_000, "open");
  });

  /** The daemon internals the N3 tests drive: a match handed to `onMatch` as the host would push it. */
  type MatchInternals = { withdrawing: boolean; retryMatches: Map<Hex, unknown>; onMatch(m: unknown): Promise<void> };
  const randomId = () => `0x${randomBytes(32).toString("hex")}` as Hex;

  it("fix round 4 (N3): a deferred match for an offer this home never posted holds no withdraw up; one for its own offer does", async () => {
    const { env, home } = await walletHome();
    const owner = newAddress();
    await firstSet(home, owner);
    const proc = await startDaemon(home);
    const d = proc.daemon as unknown as MatchInternals;

    // The host pushes a match for an offer this home never posted while a withdraw is in flight: it is deferred like
    // any other (the deferral comes before onMatch's own record check).
    const stranger = randomId();
    d.withdrawing = true;
    await d.onMatch({ offerId: stranger, params: {} });
    expect(d.retryMatches.has(stranger)).toBe(true);
    d.withdrawing = false;
    // The next withdraw starts before any main pass can drop it -- its 409 check runs synchronously here, as there is
    // no channel to read -- and goes through.
    const sent = await proc.daemon.withdraw({ amount: 1_000_000n });
    expect(sent.to).toBe(owner);
    expect(await usdcBalance(env.usdc, owner)).toBe(1_000_000n);
    await waitFor(() => !d.retryMatches.has(stranger), 20_000, "the stranger's match dropped by a main pass");

    // The very same sequence for an offer this home did post (its record is on disk) is refused, naming the offer
    // and saying what to do if it persists.
    const own = randomId();
    writeJsonAtomic(arenaPaths(home).offerRecord(own), {
      offerId: own,
      offer: { expiresAt: 2n ** 40n },
      sessionKey: generatePrivateKey(),
      role: "offerer",
    });
    d.withdrawing = true;
    await d.onMatch({ offerId: own, params: {} });
    d.withdrawing = false;
    const refused = proc.daemon.withdraw({ amount: 1_000_000n });
    await expect(refused).rejects.toMatchObject({ code: 409 });
    await expect(refused).rejects.toThrow(`offer ${own} was matched`);
    await expect(refused).rejects.toThrow(/funding window has closed\. If this persists, restart the daemon once no channel is live \(otherwise tell your human\)\.$/);
    expect(await usdcBalance(env.usdc, owner)).toBe(1_000_000n);
  });

  it("fix round 4 (N3): a match that fails on every pass holds withdraws up only until MAX_MATCH_RETRIES drops it, logged once", async () => {
    const { env, home } = await walletHome(); // pollMs 100: a main pass, and so a retry, every 100 ms
    const owner = newAddress();
    await firstSet(home, owner);
    // This home's own offer, but its record is corrupt: every attempt to handle its match throws (readJson).
    const offerId = randomId();
    mkdirSync(arenaPaths(home).offers, { recursive: true, mode: 0o700 });
    writeFileSync(arenaPaths(home).offerRecord(offerId), "{ not json");
    const logs: string[] = [];
    const proc = await startDaemonProcess(home, { log: (l) => logs.push(l) });
    cleanups.push(() => proc.stop());
    const d = proc.daemon as unknown as MatchInternals;

    await d.onMatch({ offerId, params: {} }); // the first failure: retried on the next pass
    expect(d.retryMatches.has(offerId)).toBe(true);
    const refused = proc.daemon.withdraw({ amount: 1_000_000n });
    await expect(refused).rejects.toMatchObject({ code: 409 });
    await expect(refused).rejects.toThrow(offerId);
    await expect(refused).rejects.toThrow("If this persists, restart the daemon once no channel is live (otherwise tell your human).");

    const givingUp = () => logs.filter((l) => l.startsWith(`giving up on the match for offer ${offerId}`));
    await waitFor(() => givingUp().length > 0, 30_000, "the capped match given up");
    expect(givingUp()[0]).toContain(`after ${MAX_MATCH_RETRIES} failed attempts`);
    expect(logs.filter((l) => l.startsWith("match handling failed"))).toHaveLength(MAX_MATCH_RETRIES - 1);
    await new Promise((r) => setTimeout(r, 500)); // several more passes: it stays dropped, and is logged once
    expect(d.retryMatches.has(offerId)).toBe(false);
    expect(givingUp()).toHaveLength(1);

    const sent = await proc.daemon.withdraw({ amount: 1_000_000n });
    expect(sent.to).toBe(owner);
    expect(await usdcBalance(env.usdc, owner)).toBe(1_000_000n);
  });
});

describe("confirmsTransfer: the receipt check behind withdraw (fix round 4, N4/N5)", () => {
  const TOKEN = newAddress();
  const WALLET = newAddress();
  const OWNER = newAddress();
  const OTHER = newAddress();
  const AMOUNT = 3_000_000n;
  const want = { token: TOKEN, from: WALLET, to: OWNER, amount: AMOUNT };
  let logIndex = 0;
  const log = (address: Address, topics: Hex[], data: Hex): Log =>
    ({
      address,
      topics,
      data,
      blockHash: `0x${"aa".repeat(32)}`,
      blockNumber: 7n,
      logIndex: logIndex++,
      transactionHash: `0x${"bb".repeat(32)}`,
      transactionIndex: 0,
      removed: false,
    }) as Log;
  /** An ERC-20 Transfer(from, to, value) emitted by `emitter`. */
  const transfer = (emitter: Address, from: Address, to: Address, value: bigint): Log =>
    log(emitter, encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }) as Hex[], encodeAbiParameters([{ type: "uint256" }], [value]));

  it("accepts exactly Transfer(wallet -> owner, amount) from the configured token, whatever else the receipt holds", () => {
    expect(confirmsTransfer([transfer(TOKEN, WALLET, OWNER, AMOUNT)], want)).toBe(true);
    // USDC reaching the wallet in the same receipt (or block) changes nothing.
    expect(confirmsTransfer([transfer(TOKEN, OTHER, WALLET, 5_000_000n), transfer(TOKEN, WALLET, OWNER, AMOUNT)], want)).toBe(true);
    // Addresses compare case-insensitively.
    const lower = { token: TOKEN.toLowerCase() as Address, from: WALLET.toLowerCase() as Address, to: OWNER.toLowerCase() as Address, amount: AMOUNT };
    expect(confirmsTransfer([transfer(TOKEN, WALLET, OWNER, AMOUNT)], lower)).toBe(true);
  });

  it("refuses no log, another emitter, another party, another amount, and an ERC-721 Transfer", () => {
    const erc721 = log(
      TOKEN,
      [...(encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: WALLET, to: OWNER } }) as Hex[]), pad(toHex(AMOUNT))],
      "0x",
    );
    for (const [what, logs] of [
      ["no log (a transfer that returned false)", []],
      ["the right event from another contract", [transfer(OTHER, WALLET, OWNER, AMOUNT)]],
      ["to someone else", [transfer(TOKEN, WALLET, OTHER, AMOUNT)]],
      ["from someone else", [transfer(TOKEN, OTHER, OWNER, AMOUNT)]],
      ["the reverse direction", [transfer(TOKEN, OWNER, WALLET, AMOUNT)]],
      ["less", [transfer(TOKEN, WALLET, OWNER, AMOUNT - 1n)]],
      ["more", [transfer(TOKEN, WALLET, OWNER, AMOUNT + 1n)]],
      ["the amount split in two", [transfer(TOKEN, WALLET, OWNER, 1_000_000n), transfer(TOKEN, WALLET, OWNER, 2_000_000n)]],
      ["an ERC-721 Transfer (tokenId indexed)", [erc721]],
      ["only an inflow", [transfer(TOKEN, OTHER, WALLET, AMOUNT)]],
    ] as Array<[string, Log[]]>) {
      expect(confirmsTransfer(logs, want), what).toBe(false);
    }
  });
});

// ------------------------------------------------------------------ Plan 6 (spec §2.1, Review Focus 1): the reserve

describe("Plan 6: withdrawReserve on a nativeIsUsdc chain", () => {
  const ARC = chainProfile(5042)!;
  const ARC_SESSION_GAS = 4n * 2_100_000n * ARC.feeCeilingWei; // init's default at Arc's 40 gwei: 0.336 USDC
  const reserve = (unsettledChannels: number, o: Partial<{ sessionGasWei: bigint; feeCeilingWei: bigint; profile: ChainProfile | undefined }> = {}) =>
    withdrawReserve({
      profile: "profile" in o ? o.profile : ARC,
      unsettledChannels,
      sessionGasWei: o.sessionGasWei ?? ARC_SESSION_GAS,
      feeCeilingWei: o.feeCeilingWei ?? ARC.feeCeilingWei,
    });

  it("0, 1 and 3 unsettled channels: channels x sessionGasWei + 500,000 x feeCeiling, in micro-USDC", () => {
    expect(reserve(0)).toBe(20_000n); // 500,000 x 40 gwei = 0.02 USDC: the wallet's own transactions
    expect(reserve(1)).toBe(356_000n); // + 0.336 USDC of session gas
    expect(reserve(3)).toBe(1_028_000n); // + 3 x 0.336
    expect(reserve(0, { profile: chainProfile(5042002) })).toBe(20_000n); // Arc Testnet: the same
  });

  it("converts 18 to 6 decimals rounding UP, so the reserve is never short by a fraction of a micro-USDC", () => {
    expect(reserve(1, { sessionGasWei: 1n, feeCeilingWei: 0n })).toBe(1n);
    expect(reserve(1, { sessionGasWei: 10n ** 12n - 1n, feeCeilingWei: 0n })).toBe(1n);
    expect(reserve(1, { sessionGasWei: 10n ** 12n, feeCeilingWei: 0n })).toBe(1n);
    expect(reserve(1, { sessionGasWei: 10n ** 12n + 1n, feeCeilingWei: 0n })).toBe(2n);
    expect(reserve(3, { sessionGasWei: 10n ** 12n + 1n, feeCeilingWei: 0n })).toBe(4n); // 3e12 + 3 wei
    expect(reserve(0, { sessionGasWei: 1n, feeCeilingWei: 0n })).toBe(0n);
  });

  it("0 on a chain without a profile, or with one whose gas is not USDC -- whatever the channels", () => {
    expect(withdrawReserve()).toBe(0n);
    expect(reserve(3, { profile: undefined })).toBe(0n);
    expect(reserve(3, { profile: { ...ARC, nativeIsUsdc: false } })).toBe(0n);
  });

  it("refuses a negative or fractional channel count", () => {
    expect(() => reserve(-1)).toThrow(RangeError);
    expect(() => reserve(0.5)).toThrow(RangeError);
  });
});

/** Runs `body` with a USDC-gas profile for 31337, so the daemon's reserve and its gates apply. Anvil's gas stays
 *  native, and the daemon reads the ERC-20 balance: only the arithmetic and the refusals are under test here (Task 4
 *  covers arc-anvil). Every daemon in this process sees the profile while `body` runs. */
async function asOneBalance<T>(usdc: Address, body: () => Promise<T>): Promise<T> {
  CHAIN_PROFILES[31337] = { name: "Local USDC-gas", usdc, nativeIsUsdc: true, minFeePerGas: 1n, feeCeilingWei: 40_000_000_000n };
  try {
    return await body();
  } finally {
    delete CHAIN_PROFILES[31337];
  }
}
// No feeCeilingWei in these configs. A daemon built before the profile is set (`startPair`, then `asOneBalance`) has
// the wallet sender's default, 100 gwei: 500,000 x 100 gwei = 0.05 USDC.
const NO_CHANNEL_RESERVE = 50_000n;
// Plan 6 Task 2: one built while it is set (the CLI's in-process withdraw) takes the profile's 40 gwei ceiling
// (`feeCeilingOf`): 500,000 x 40 gwei = 0.02 USDC.
const PROFILE_NO_CHANNEL_RESERVE = 20_000n;

describe("Plan 6: withdraw keeps the reserve on a nativeIsUsdc chain (a test-only profile for anvil 31337)", () => {

  it("with no channel: --amount above balance - reserve is refused naming the reserve; --all moves balance - reserve", async () => {
    const { env, home, wallet } = await walletHome();
    const owner = newAddress();
    await firstSet(home, owner);
    await asOneBalance(env.usdc, async () => {
      const over = cliIo(home);
      expect(await runCli(["withdraw", "--amount", "10"], over.io)).toBe(1);
      const why = over.err.join("\n");
      expect(why).toContain("10.000000 USDC is more than this wallet can withdraw (9.980000 USDC)");
      expect(why).toContain("0.020000 USDC of it is the gas reserve, which always stays in the wallet");
      expect(why).toContain("gas on Local USDC-gas is paid in USDC, for the session gas of 0 unsettled channel(s)");
      expect(why).toMatch(/close open channels first/);
      expect(await usdcBalance(env.usdc, owner)).toBe(0n);

      const all = cliIo(home);
      expect(await runCli(["withdraw", "--all"], all.io), all.err.join("\n")).toBe(0);
      expect(all.json().amount).toBe("9.980000");
      expect(all.json().usdcAfter).toBe("0.020000");
      expect(await usdcBalance(env.usdc, owner)).toBe(10_000_000n - PROFILE_NO_CHANNEL_RESERVE);
      expect(await usdcBalance(env.usdc, wallet)).toBe(PROFILE_NO_CHANNEL_RESERVE);

      // Only the reserve is left: nothing to withdraw, and the message says why.
      const empty = cliIo(home);
      expect(await runCli(["withdraw", "--all"], empty.io)).toBe(1);
      expect(empty.err.join("\n")).toContain("nothing to withdraw: this wallet holds 0.020000 USDC -- 0.020000 USDC of it is the gas reserve");
      const one = cliIo(home);
      expect(await runCli(["withdraw", "--amount", "0.000001"], one.io)).toBe(1);
      expect(one.err.join("\n")).toContain("0.000001 USDC is more than this wallet can withdraw (0.000000 USDC) -- 0.020000 USDC");
    });
    expect(livePidHoldingLock(home)).toBeNull();
  });

  it("with one open channel: the reserve adds that channel's whole sessionGasWei, and drops it again once it is finalized", async () => {
    const pair = await startPair();
    cleanups.push(() => pair.cleanup());
    const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await pair.bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => pair.bob.daemon.channelIds()[0], 20_000, "bob's channel");
    await waitFor(async () => (await pair.bob.daemon.hub.channelInfo(id)).phase === "Open", 30_000, "open");
    const owner = newAddress();
    await firstSet(pair.bob.home, owner);
    const balance = await usdcBalance(pair.env.usdc, pair.bob.address);
    // 1 x 1e16 (the harness's sessionGasWei) + 500,000 x 100 gwei = 6e16 wei = 0.06 USDC.
    const reserve = 60_000n;
    await asOneBalance(pair.env.usdc, async () => {
      const refused = pair.bob.daemon.withdraw({ amount: balance - reserve + 1n });
      await expect(refused).rejects.toMatchObject({ code: 400 });
      await expect(refused).rejects.toThrow("0.060000 USDC of it is the gas reserve");
      await expect(refused).rejects.toThrow("for the session gas of 1 unsettled channel(s)");

      const r = await pair.bob.daemon.withdraw({ all: true });
      expect(r.amount).toBe(balance - reserve);
    });
    expect(await usdcBalance(pair.env.usdc, owner)).toBe(balance - reserve);
    expect(await usdcBalance(pair.env.usdc, pair.bob.address)).toBe(reserve);

    // Fix round 1 (m-2): a finalized channel no longer counts -- the reserve is back to the 0-channel figure.
    await pair.alice.daemon.move(id, "e4", { actor: "agent", offerDraw: true });
    await waitFor(() => pair.bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob's turn");
    await pair.bob.daemon.acceptDraw(id, "agent");
    await waitFor(async () => (await pair.alice.daemon.status(id)).attention === "game-over", 5_000, "draw seen");
    await pair.alice.daemon.close(id, "agent");
    await waitFor(async () => (await pair.bob.daemon.status(id)).attention === "close-requested", 5_000, "close requested");
    await pair.bob.daemon.close(id, "agent");
    await waitFor(() => pair.bob.daemon.handle(id).record.finalized, 20_000, "finalized");
    const after = await usdcBalance(pair.env.usdc, pair.bob.address);
    expect(after).toBeGreaterThan(reserve); // the deposit came back
    await asOneBalance(pair.env.usdc, async () => {
      const refused = pair.bob.daemon.withdraw({ amount: after - NO_CHANNEL_RESERVE + 1n });
      await expect(refused).rejects.toThrow("0.050000 USDC of it is the gas reserve");
      await expect(refused).rejects.toThrow("for the session gas of 0 unsettled channel(s)");
      expect((await pair.bob.daemon.withdraw({ all: true })).amount).toBe(after - NO_CHANNEL_RESERVE);
    });
    expect(await usdcBalance(pair.env.usdc, pair.bob.address)).toBe(NO_CHANNEL_RESERVE);
  });
});

// ------------------------------------------------------------------ Plan 6 fix round 1 (I-5, m-1, m-2)

/** Alice and Bob with one Open channel A between them; Bob's wallet then holds exactly `bobHolds` USDC (the rest went
 *  to his owner) and has an owner set. Fees: 0.005 USDC per player; sessionGasWei 1e16 (0.01 USDC). */
async function pairWithOpenChannel(bobHolds: bigint) {
  const pair = await startPair();
  cleanups.push(() => pair.cleanup());
  const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
  await pair.bob.daemon.acceptOffer(offerId);
  const a = await waitFor(() => pair.bob.daemon.channelIds()[0], 20_000, "channel A");
  await waitFor(async () => (await pair.bob.daemon.hub.channelInfo(a)).phase === "Open", 30_000, "A open");
  await firstSet(pair.bob.home, newAddress());
  const balance = await usdcBalance(pair.env.usdc, pair.bob.address);
  await pair.bob.daemon.withdraw({ amount: balance - bobHolds });
  expect(await usdcBalance(pair.env.usdc, pair.bob.address)).toBe(bobHolds);
  return { ...pair, a };
}

// With channel A unsettled, a new channel needs d + 0.005 fee + ceil((1e16 own session gas + 1e16 for A + 500,000 x
// 100 gwei) / 10^12) = d + 0.075 USDC. At 2 USDC, the largest deposit Bob can open is 1.925.
const HOLDS = 2_000_000n;
const MAX_DEPOSIT = 1_925_000n;

describe("Plan 6 fix round 1 (I-5): on a nativeIsUsdc chain, opening a channel never spends the other channels' reserve", () => {
  it("createOffer refuses (409) a deposit the wallet could only fund out of the reserve, naming the reserve and the shortfall", async () => {
    const pair = await pairWithOpenChannel(HOLDS);
    await asOneBalance(pair.env.usdc, async () => {
      const offersBefore = new RecordStore(pair.bob.home).offers().length;
      const refused = pair.bob.daemon.createOffer({ deposit: MAX_DEPOSIT + 1n, stakePerGame: 100_000n, challengeTimeout: 600n });
      await expect(refused).rejects.toMatchObject({ code: 409 });
      await expect(refused).rejects.toThrow(
        "cannot post this offer: this wallet holds 2.000000 USDC, 0.000001 USDC short of the 2.000001 USDC this channel needs",
      );
      await expect(refused).rejects.toThrow("the 0.060000 USDC gas reserve that always stays in the wallet");
      await expect(refused).rejects.toThrow("for the session gas of 1 other unsettled channel(s)");
      expect(new RecordStore(pair.bob.home).offers().length).toBe(offersBefore); // nothing recorded, nothing posted

      await expect(pair.bob.daemon.createOffer({ deposit: MAX_DEPOSIT, stakePerGame: 100_000n, challengeTimeout: 600n })).resolves.toMatchObject({
        offerId: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      });
    });
  });

  it("acceptOffer refuses (409) the same way, before signing anything", async () => {
    const pair = await pairWithOpenChannel(HOLDS);
    await asOneBalance(pair.env.usdc, async () => {
      const big = await pair.alice.daemon.createOffer({ deposit: MAX_DEPOSIT + 1n, stakePerGame: 100_000n, challengeTimeout: 600n });
      const refused = pair.bob.daemon.acceptOffer(big.offerId);
      await expect(refused).rejects.toMatchObject({ code: 409 });
      await expect(refused).rejects.toThrow("cannot accept this offer: this wallet holds 2.000000 USDC, 0.000001 USDC short");
      await expect(refused).rejects.toThrow("0.060000 USDC gas reserve");
      expect(new RecordStore(pair.bob.home).offer(big.offerId)).toBeNull(); // no acceptance recorded or sent

      const fits = await pair.alice.daemon.createOffer({ deposit: MAX_DEPOSIT, stakePerGame: 100_000n, challengeTimeout: 600n });
      await expect(pair.bob.daemon.acceptOffer(fits.offerId)).resolves.toBeUndefined();
    });
  });

  it("fund() sends neither the approve, the top-up nor the deposit while short; it backs off, and funds once the wallet can", async () => {
    const pair = await pairWithOpenChannel(HOLDS);
    await asOneBalance(pair.env.usdc, async () => {
      // Bob offers exactly what 2 USDC can open, then holds 1 micro-USDC less: as the offerer, he deposits first.
      const { offerId } = await pair.bob.daemon.createOffer({ deposit: MAX_DEPOSIT, stakePerGame: 100_000n, challengeTimeout: 600n });
      await pair.bob.daemon.withdraw({ amount: 1n });
      await pair.alice.daemon.acceptOffer(offerId);
      const b = await waitFor(() => pair.bob.daemon.channelIds().find((id) => id !== pair.a), 20_000, "channel B");
      const handle = pair.bob.daemon.handle(b);
      // Plan 6 Task 4: the back-off too -- fund() sets it one block read after lastError (see arc-fees.test.ts).
      await waitFor(() => handle.lastError?.startsWith("funding: ") && handle.fundBlockedUntil !== null, 20_000, "the funding refusal");
      expect(handle.lastError).toContain("this wallet holds 1.999999 USDC, 0.000001 USDC short of the 2.000000 USDC this channel needs");
      expect(handle.lastError).toContain("the 0.060000 USDC gas reserve");
      expect(handle.fundBlockedUntil).not.toBeNull();
      // Nothing went out: no top-up, no approve, no deposit.
      expect(await publicClient().getBalance({ address: handle.sessionSender.address })).toBe(0n);
      const allowance = await publicClient().readContract({
        address: pair.env.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [pair.bob.address, pair.env.hub],
      });
      expect(allowance).toBe(0n);
      expect((await pair.bob.daemon.hub.channelInfo(b)).phase).toBe("None");
      expect(await usdcBalance(pair.env.usdc, pair.bob.address)).toBe(HOLDS - 1n);

      // The micro-USDC arrives; once the back-off has passed in chain time, B funds and opens.
      await mintUsdc(pair.env.usdc, pair.bob.address, 1n);
      await increaseTime(31);
      await waitFor(async () => (await pair.bob.daemon.hub.channelInfo(b)).phase === "Open", 30_000, "B open");
      expect(handle.lastError ?? "").not.toMatch(/^funding:/);
      // B took its deposit, fee and top-up; A's reserve (and the wallet-gas term) is still in the wallet.
      expect(await usdcBalance(pair.env.usdc, pair.bob.address)).toBe(HOLDS - MAX_DEPOSIT - 5_000n);
    });
  });

  it("on anvil 31337 (no profile) nothing changes: the same short wallet offers, accepts and funds as before", async () => {
    const pair = await pairWithOpenChannel(HOLDS);
    const offered = await pair.bob.daemon.createOffer({ deposit: MAX_DEPOSIT + 1n, stakePerGame: 100_000n, challengeTimeout: 600n });
    expect(offered.offerId).toMatch(/^0x[0-9a-f]{64}$/);
    const theirs = await pair.alice.daemon.createOffer({ deposit: 1_995_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await pair.bob.daemon.acceptOffer(theirs.offerId); // 1.995 + 0.005 fee = all of Bob's 2 USDC
    const b = await waitFor(() => pair.bob.daemon.channelIds().find((id) => id !== pair.a), 20_000, "channel B");
    await waitFor(async () => (await pair.bob.daemon.hub.channelInfo(b)).phase === "Open", 30_000, "B open");
    expect(await usdcBalance(pair.env.usdc, pair.bob.address)).toBe(0n);
  });
});

describe("live run #2 (f)1: a funding pass resumed after its approve and top-up needs only what is still to be spent", () => {
  it("the deposit stopped by a rate limit: the next pass credits the gas already paid and deposits -- no second ask for it", async () => {
    const pair = await startPair();
    cleanups.push(() => pair.cleanup());
    const bob = pair.bob.daemon;
    // Bob holds exactly what `fund` asks for one channel and nothing else: deposit + fee + ceil((session gas + 500,000 x
    // his 100 gwei ceiling) / 10^12) -- 1.065 USDC.
    const deposit = 1_000_000n;
    const ask = oneBalanceOpenNeed({ deposit, feePerPlayer: 5_000n, ownGasWei: 10n ** 16n, otherChannels: 0, sessionGasWei: 10n ** 16n, feeCeilingWei: bob.wallet.feeCeiling });
    expect(ask).toBe(1_065_000n);
    await firstSet(pair.bob.home, newAddress());
    await bob.withdraw({ amount: (await usdcBalance(pair.env.usdc, pair.bob.address)) - ask });
    await asOneBalance(pair.env.usdc, async () => {
      // Arc's one balance, on anvil: what the wallet pays in native (the top-up's value and every gas) leaves its USDC too.
      // The ERC-20 reads as the native balance does on Arc, rounded down: less ceil(native spent / 10^12).
      const nativeAtStart = await publicClient().getBalance({ address: pair.bob.address });
      const daemon = bob as unknown as { usdcBalance(usdc: Address): Promise<bigint> };
      const real = daemon.usdcBalance.bind(daemon);
      const spy = vi.spyOn(daemon, "usdcBalance").mockImplementation(async (usdc) => {
        const spent = nativeAtStart - (await publicClient().getBalance({ address: pair.bob.address }));
        return (await real(usdc)) - (spent + 10n ** 12n - 1n) / 10n ** 12n;
      });
      cleanups.push(() => spy.mockRestore());
      // The rehearsal's rate limit: the approve and the top-up went out, then the deposit's first try failed.
      const realDeposit = bob.hub.deposit.bind(bob.hub);
      let refusedOnce = false;
      bob.hub.deposit = async (...args: Parameters<typeof realDeposit>) => {
        if (!refusedOnce) {
          refusedOnce = true;
          throw new LimitExceededRpcError(new Error("rate limit exceeded"));
        }
        return realDeposit(...args);
      };
      const { offerId } = await bob.createOffer({ deposit, stakePerGame: 100_000n, challengeTimeout: 600n });
      await pair.alice.daemon.acceptOffer(offerId);
      const id = await waitFor(() => bob.channelIds()[0], 20_000, "the channel");
      // Before: the next pass needed the whole 0.05 wallet-gas term again, backed off "… USDC short of the 1.055000 USDC
      // this channel needs", and only a second ask to the human could fund it.
      await waitFor(async () => (await bob.hub.channelInfo(id)).phase === "Open", 30_000, `the channel to open (${bob.handle(id).lastError})`);
      expect(refusedOnce).toBe(true);
      const record = bob.handle(id).record;
      expect(record.fundingGasPaid).toBeGreaterThan(0n); // the approve's and the top-up's gas, from their receipts
      expect(new RecordStore(pair.bob.home).channel(id)?.fundingGasPaid).toBe(record.fundingGasPaid); // on disk
      expect(bob.handle(id).lastError ?? "").not.toMatch(/^funding:/);
    });
  });
});

describe("Plan 6 fix round 1 (m-2): which channels the reserve counts", () => {
  it("counts unfinalized channels, live or only on disk, once each; never a finalized or degraded one, nor the one being funded", async () => {
    const { home } = await walletHome();
    const d = new ArenaDaemon({
      home,
      config: loadConfig(home),
      walletKey: loadWalletKey(home),
      lobby: {} as LobbyClient,
      relay: {} as RelayClient,
    }) as unknown as {
      live: Map<Hex, { record: { channelId: Hex; finalized: boolean } }>;
      degraded: Map<string, string>;
      unsettledChannelCount(exclude?: Hex): number;
    };
    const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
    const save = (channelId: Hex, finalized: boolean) => writeJsonAtomic(arenaPaths(home).channelRecord(channelId), { channelId, finalized });
    expect(d.unsettledChannelCount()).toBe(0);
    save(id(1), false); // on disk only, not finalized: counted
    save(id(2), true); // finalized: not counted
    save(id(3), false); // degraded: never watched, so never refilled
    d.degraded.set(id(3), "does not match this hub");
    save(id(4), false); // live and on disk: counted once
    d.live.set(id(4), { record: { channelId: id(4), finalized: false } });
    d.live.set(id(5), { record: { channelId: id(5), finalized: true } }); // live but finalized: not counted
    d.live.set(id(6), { record: { channelId: id(6), finalized: false } }); // live, not yet on disk: counted
    mkdirSync(join(arenaPaths(home).channels, "not-a-channel"), { recursive: true }); // unreadable: skipped
    expect(d.unsettledChannelCount()).toBe(3);
    expect(d.unsettledChannelCount(id(4))).toBe(2); // the channel being funded is not one of the others
    expect(d.unsettledChannelCount(id(2))).toBe(3); // excluding a channel that is not counted changes nothing
  });
});

describe("Plan 6 fix round 1 (m-1): the daemon re-checks the pin when it starts", () => {
  it("refuses to start on a profiled chain whose config.json names another USDC, or a hub other than the pinned one", async () => {
    const { env, home } = await walletHome();
    const owner = newAddress();
    await firstSet(home, owner);
    // A USDC other than the profile's (as a hand-edited config.json, or one written before a correction, would hold).
    await asOneBalance(newAddress(), async () => {
      const refusal = (await startDaemonProcess(home, { log: () => {} }).catch((e: unknown) => e)) as Error;
      expect(refusal.message).toMatch(
        /^refusing to start on Local USDC-gas \(chain 31337\): .*config\.json names contracts this CLI does not accept there: usdc 0x[0-9a-fA-F]{40} is not Local USDC-gas's USDC/,
      );
      // Final fix wave B (I-2): addressed to the human; the agent is never told to edit config.json or move homes.
      expect(refusal.message).toMatch(
        /\. Tell your human: this daemon's config names contracts the CLI does not pin for chain 31337 \(most likely this home was set up by another CLI release\); they decide what happens next\. Do not edit config\.json yourself, and do not start a new ARENA_HOME while a channel of this one is unsettled: the CLI release that set it up can still settle its channels and withdraw \(withdraw needs this daemon too\)$/,
      );
      expect(refusal.message).not.toMatch(/Restore|restore the|move to a fresh|with "arena init"/);
      expect(livePidHoldingLock(home)).toBeNull(); // the lock is released
      // The CLI's in-process daemon (withdraw) is refused the same way, and nothing moves.
      const t = cliIo(home);
      expect(await runCli(["withdraw", "--all"], t.io)).toBe(1);
      expect(t.err.join("\n")).toMatch(/refusing to start on Local USDC-gas/);
      expect(await usdcBalance(env.usdc, owner)).toBe(0n);
    });
    // The profile's USDC, but the chain's deployment is pinned to another hub.
    await asOneBalance(env.usdc, async () => {
      const other = newAddress();
      KNOWN_DEPLOYMENTS[31337] = { name: "Local", hub: other, rules: env.rules };
      try {
        await expect(startDaemonProcess(home, { log: () => {} })).rejects.toThrow(`hub ${env.hub} is not the pinned Local hub ${other}`);
      } finally {
        delete KNOWN_DEPLOYMENTS[31337];
      }
      // The pinned deployment itself (or no pin): it starts.
      const proc = await startDaemon(home);
      expect(proc.daemon.wallet.address).toMatch(/^0x/);
    });
    // Without a profile, a table entry alone never stops a daemon (unprofiled chains only ever warn, at init).
    KNOWN_DEPLOYMENTS[31337] = { name: "Local", hub: newAddress(), rules: env.rules };
    try {
      for (const c of cleanups.splice(0)) await c();
      const proc = await startDaemon(home);
      expect(proc.daemon.wallet.address).toMatch(/^0x/);
    } finally {
      delete KNOWN_DEPLOYMENTS[31337];
    }
  });
});

// ------------------------------------------------------------------ H1 (audit-daemon M-6): explicit wait errors

describe("H1 (audit-daemon M-6): a transfer whose wait ended without a receipt is never a bare 500", () => {
  const OWNER = "0x00000000000000000000000000000000000000a5" as Address;
  const H1 = `0x${"11".repeat(32)}` as Hex;
  const H2 = `0x${"22".repeat(32)}` as Hex;

  it("withdrawWaitError: 502 naming every hash and 'check ... before retrying' for a missing receipt, a stuck or a dropped transfer; 503 when stopping", () => {
    const cases: Array<[unknown, number, RegExp]> = [
      [new TxReceiptMissingError(H1, 7n, 3), 502, /was mined \(tx 0x1{64}, block 7\) but its receipt could not be read/],
      [new TxStuckError([H1, H2], false, 3), 502, /is still pending \(tx 0x1{64}, 0x2{64}\); it may still land/],
      [new TxDroppedError(H2, 3), 502, /\(tx 0x2{64}\) is no longer known to the RPC/],
      [new TxWaitAbortedError([H1], 3), 503, /the daemon is stopping: .*\(tx 0x1{64}\) was sent and may still land/],
    ];
    for (const [err, code, text] of cases) {
      const mapped = withdrawWaitError(err, 3_000_000n, OWNER) as DaemonError;
      expect(mapped).toBeInstanceOf(DaemonError);
      expect(mapped.code).toBe(code);
      expect(mapped.message).toMatch(text);
      expect(mapped.message).toContain(`the transfer of 3.000000 USDC to ${OWNER}`);
      expect(mapped.message).toMatch(/check the owner's balance, an explorer or "arena wallet" before retrying: a retry can pay the owner twice/);
      expect(mapped.hashes?.length).toBeGreaterThan(0); // Final fix wave B (I-1): answered as the body's `hashes`
    }
    const other = new Error("socket hang up");
    expect(withdrawWaitError(other, 1n, OWNER)).toBe(other); // anything else, with nothing sent, unchanged
    // Final fix wave B (I-1): the same error with a transaction sent during the withdraw is a 502 naming it.
    const sent = withdrawWaitError(other, 1n, OWNER, [H2]) as DaemonError;
    expect([sent.code, sent.hashes]).toEqual([502, [H2]]);
    expect(sent.message).toMatch(/may have been sent \(tx 0x2{64}\), but could not be confirmed \(socket hang up\); check/);
  });

  it("withdraw() answers 502 with the hash when the transfer's receipt went missing (in-process daemon)", async () => {
    const pair = await startPair();
    cleanups.push(pair.cleanup);
    await firstSet(pair.alice.home, newAddress());
    pair.alice.daemon.hub.transfer = async () => {
      throw new TxReceiptMissingError(H1, 9n, 0);
    };
    const err = (await pair.alice.daemon.withdraw({ amount: 1_000_000n }).catch((e: unknown) => e)) as DaemonError;
    expect(err).toBeInstanceOf(DaemonError);
    expect(err.code).toBe(502);
    expect(err.message).toMatch(/was mined \(tx 0x1{64}, block 9\) but its receipt could not be read; check/);
  });
});

// ------------------------------------------------------------------ Final fix wave B (I-1): a sent, unconfirmed withdraw

/**
 * Routes `daemon`'s USDC transfer (`hub.transfer`) through viem's real HTTP transport (`rpcTransport`, retries shortened)
 * over a fake fetch in front of Anvil that answers every `eth_getTransactionReceipt` with an HTTP 429 -- the rate limit
 * Arc's public RPC answers (rehearsal §8.2) -- while it lets the simulate through. The send itself goes out through the
 * daemon's own wallet sender, on Anvil, and is mined at once: only its receipt cannot be read.
 */
function rateLimitedReceipts(daemon: ArenaDaemon) {
  const state = { receiptReads: 0 };
  const fetchFn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init?.body)) as { method: string };
    if (req.method === "eth_getTransactionReceipt") {
      state.receiptReads++;
      return new Response("Too Many Requests", { status: 429 });
    }
    return fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: init?.body });
  };
  const client = createPublicClient({ transport: rpcTransport(RPC, { fetchFn, retryDelay: 1 }) }) as PublicClient;
  const fake = new HubClient(daemon.hub.hub, client);
  const real = daemon.hub.transfer.bind(daemon.hub);
  daemon.hub.transfer = fake.transfer.bind(fake);
  return { state, restore: () => void (daemon.hub.transfer = real) };
}

const HASH_RE = /0x[0-9a-f]{64}/;

describe("Final fix wave B (I-1): a withdraw that was sent and whose receipt read failed is never answered 'retry'", () => {
  it("through the API: a 502 naming the hash, never H3's 503; the next withdraw finds it landed and sends nothing; the one after sends", async () => {
    const port = await freePort();
    const { env, home } = await walletHome({ port });
    const owner = newAddress();
    await firstSet(home, owner);
    const proc = await startDaemon(home);
    const limited = rateLimitedReceipts(proc.daemon);
    const post = (body: unknown) =>
      fetch(`${proc.apiUrl}/withdraw`, {
        method: "POST",
        headers: { authorization: `Bearer ${loadToken(home)}`, "content-type": "application/json", "x-arena-actor": "agent" },
        body: JSON.stringify(body),
      });
    const res = await post({ amount: "3000000" });
    // Before: 503 "the RPC is rate-limiting (HTTP 429): wait a few seconds, then retry", with no hash.
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; hashes: Hex[] };
    expect(limited.state.receiptReads).toBeGreaterThan(0);
    expect(body.hashes).toHaveLength(1);
    const [hash] = body.hashes as [Hex];
    expect(body.error).toBe(
      `the transfer of 3.000000 USDC to ${owner} may have been sent (tx ${hash}), but could not be confirmed (the RPC is ` +
        `rate-limiting (HTTP 429)); check the owner's balance, an explorer or "arena wallet" before retrying: a retry can pay ` +
        "the owner twice",
    );
    expect(body.error).not.toMatch(/then retry/);
    // It did go out (Anvil mined it), and the wallet's sender still holds it.
    expect(await usdcBalance(env.usdc, owner)).toBe(3_000_000n);
    expect((await publicClient().getTransactionReceipt({ hash })).status).toBe("success");
    expect(existsSync(arenaPaths(home).withdrawPending)).toBe(true);

    // The agent retries anyway, the RPC serving again: refused, saying it landed -- the owner is not paid twice.
    limited.restore();
    const again = cliIo(home);
    expect(await runCli(["withdraw", "--amount", "3"], again.io)).toBe(1);
    expect(again.err.join("\n")).toMatch(
      new RegExp(`^error: an earlier withdraw of 3\\.000000 USDC to ${owner} landed \\(tx ${hash}, block \\d+\\): the owner has been paid, so nothing was sent now`),
    );
    expect(again.out).toEqual([]);
    expect(await usdcBalance(env.usdc, owner)).toBe(3_000_000n);
    expect(existsSync(arenaPaths(home).withdrawPending)).toBe(false);
    // Resolved: the next withdraw sends.
    const third = cliIo(home);
    expect(await runCli(["withdraw", "--amount", "3"], third.io), third.err.join("\n")).toBe(0);
    expect(await usdcBalance(env.usdc, owner)).toBe(6_000_000n);
  });

  it("the CLI prints the hash; with no daemon left running, the in-process daemon of the next withdraw still holds it back", async () => {
    const port = await freePort();
    const { env, home } = await walletHome({ port });
    const owner = newAddress();
    await firstSet(home, owner);
    const proc = await startDaemon(home);
    rateLimitedReceipts(proc.daemon);
    const t = cliIo(home);
    expect(await runCli(["withdraw", "--amount", "2"], t.io)).toBe(1);
    const printed = t.err.join("\n");
    expect(printed).toMatch(new RegExp(`^error: the transfer of 2\\.000000 USDC to ${owner} may have been sent \\(tx 0x[0-9a-f]{64}\\)`));
    expect(printed).toContain("a retry can pay the owner twice");
    const hash = HASH_RE.exec(printed)![0];
    expect(await usdcBalance(env.usdc, owner)).toBe(2_000_000n);
    await proc.stop();
    expect(livePidHoldingLock(home)).toBeNull();

    // Before: a fresh in-process daemon tracked nothing and sent the transfer again, at the next nonce.
    const retry = cliIo(home);
    expect(await runCli(["withdraw", "--amount", "2"], retry.io)).toBe(1);
    expect(retry.err.join("\n")).toContain(`landed (tx ${hash}, block`);
    expect(await usdcBalance(env.usdc, owner)).toBe(2_000_000n);
    expect(livePidHoldingLock(home)).toBeNull();
    const next = cliIo(home);
    expect(await runCli(["withdraw", "--amount", "2"], next.io), next.err.join("\n")).toBe(0);
    expect(await usdcBalance(env.usdc, owner)).toBe(4_000_000n);
  });

  it("an unconfirmed transfer that may still land holds withdraws back until its nonce is used or its hold is over; a failed check is a 503", async () => {
    const { env, home, wallet } = await walletHome();
    const owner = newAddress();
    await firstSet(home, owner);
    const proc = await startDaemon(home);
    const path = arenaPaths(home).withdrawPending;
    const unknown = `0x${randomBytes(32).toString("hex")}` as Hex; // never sent: no receipt, unknown to the node
    const pending = (p: Partial<PendingWithdraw>) =>
      writeJsonAtomic(path, { to: owner, amount: 1_000_000n, at: Date.now(), txs: [{ hash: unknown, nonce: 0 }], ...p } satisfies PendingWithdraw);
    expect(await publicClient().getTransactionCount({ address: wallet })).toBe(0);

    // Nonce 0 is still free: it may land. Refused, nothing sent, kept.
    pending({});
    const held = (await proc.daemon.withdraw({ amount: 1_000_000n }).catch((e: unknown) => e)) as DaemonError;
    expect([held.code, held.hashes]).toEqual([409, [unknown]]);
    expect(held.message).toMatch(
      new RegExp(`^an earlier withdraw of 1\\.000000 USDC to ${owner} was sent \\d+ s ago \\(tx ${unknown}\\) and is not confirmed: it may still land, so nothing was sent now`),
    );
    expect(await usdcBalance(env.usdc, owner)).toBe(0n);
    expect(existsSync(path)).toBe(true);

    // A read that fails is a 503 naming it, and nothing is sent.
    const realReceipt = proc.daemon.client.getTransactionReceipt.bind(proc.daemon.client);
    proc.daemon.client.getTransactionReceipt = (async () => {
      throw new LimitExceededRpcError(new Error("rate limit exceeded"));
    }) as typeof realReceipt;
    const unread = (await proc.daemon.withdraw({ amount: 1_000_000n }).catch((e: unknown) => e)) as DaemonError;
    expect([unread.code, unread.hashes]).toEqual([503, [unknown]]);
    expect(unread.message).toMatch(/could not be checked \(-32005 "rate limit exceeded"\): nothing was sent now; retry in a few seconds$/);
    proc.daemon.client.getTransactionReceipt = realReceipt;

    // Past its hold: cleared, and this withdraw sends (at nonce 0, which a transfer still pending there would share).
    pending({ at: Date.now() - WITHDRAW_UNCONFIRMED_HOLD_MS - 1 });
    expect((await proc.daemon.withdraw({ amount: 1_000_000n })).amount).toBe(1_000_000n);
    expect(existsSync(path)).toBe(false);
    expect(await usdcBalance(env.usdc, owner)).toBe(1_000_000n);

    // Its nonce (0) is now used by another transaction: it can never land. Cleared, and this withdraw sends.
    pending({});
    expect((await proc.daemon.withdraw({ amount: 1_000_000n })).amount).toBe(1_000_000n);
    expect(existsSync(path)).toBe(false);
    expect(await usdcBalance(env.usdc, owner)).toBe(2_000_000n);

    // With its nonce unknown, only its hold ends it.
    pending({ txs: [{ hash: unknown }] });
    expect(((await proc.daemon.withdraw({ amount: 1_000_000n }).catch((e: unknown) => e)) as DaemonError).code).toBe(409);
    expect(await usdcBalance(env.usdc, owner)).toBe(2_000_000n);
  });
});
