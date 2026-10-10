/**
 * Plan 5.6 Task 5 (spec §1 success criterion 1; Review Focus 5): a clean-room install of the packed `arena` CLI
 * tarball, outside the repo, running the whole funded flow against a dev stack with the faucet off, in skill.md's
 * own order (final fix wave, K1): build (or, from the release workflow, the prebuilt `ARENA_CLEAN_ROOM_DIST`) ->
 * pack -> offline install -> empty wallet -> daemon -> `/board` served from the installed package -> pick a house
 * bot's offer -> `fund --offer` reports the shortfall and a message -> the test, acting as the human, sends exactly
 * what was asked for -> `wallet --wait-for-usdc/--wait-for-native` returns (the starting balance) -> `owner set`
 * (and a refused change) -> list the offers again and accept -> 2 games -> close -> the profit and loss against the
 * starting balance -> stop the daemon -> `withdraw --amount 1` and `withdraw --all` with no daemon running (M12) ->
 * exact balances on both sides.
 *
 * The agent and the house bot run ONLY the installed binary (`<prefix>/node_modules/.bin/arena`), under a
 * restricted environment that could not accidentally reach this repo, the live user daemon on :7070, or Anvil/
 * the server on :8545/:8080 (Global Constraints; Rules): `{ HOME: <tmp>/home-<role>, PATH: <node dir>:/usr/bin:
 * /bin }` only -- no `ARENA_HOME`, no `NODE_PATH`, no repo path -- and `cwd` is a work directory outside the
 * repo. The deployer/human side (minting USDC, sending native gas, reading balances) uses plain viem calls
 * against the harness's own stack, exactly as other system tests do.
 *
 * `npm pack`/`npm install` are build tooling, not the CLI under test: they run with the ambient environment so
 * npm can find itself, but `--cache <tmp>/npm-cache` keeps them off the user's own npm cache (Rules). The
 * offline install succeeding is itself the proof that the published bundle carries zero runtime dependencies.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { mockUsdcAbi } from "@arena/sdk";
import { pickMove } from "@arena/cli";
import { ANVIL_KEYS, freeTcpPort, isPortFree, usdcBalanceOf, type Stack, startStack } from "./harness.js";

const REPO_ROOT = join(import.meta.dirname, "../..");
const TSX_BIN = join(REPO_ROOT, "node_modules/.bin/tsx");
const BUILD_SCRIPT = join(REPO_ROOT, "scripts/build-cli.ts");
const RESTRICTED_PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;

type RunResult = { status: number; stdout: string; stderr: string };

function run(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ status: code ?? 1, stdout, stderr }));
  });
}

/** Runs the installed binary exactly as the Rules require: a restricted `{HOME, PATH}` env (no `ARENA_HOME`, no
 *  `NODE_PATH`, no repo path), `cwd` outside the repo. This is the ONLY way this file ever invokes `BIN`. */
function runBin(bin: string, args: string[], home: string, cwd: string): Promise<RunResult> {
  return run(bin, args, { cwd, env: { HOME: home, PATH: RESTRICTED_PATH } });
}

async function runBinJson(bin: string, args: string[], home: string, cwd: string): Promise<any> {
  const res = await runBin(bin, args, home, cwd);
  if (res.status !== 0) {
    throw new Error(`"${[bin, ...args].join(" ")}" failed (exit ${res.status}): ${res.stderr || res.stdout}`);
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`"${[bin, ...args].join(" ")}" did not print JSON on stdout: ${JSON.stringify(res.stdout)}`);
  }
}

/** A long-lived installed-binary child (`daemon` / `bot`): same restricted env as `runBin`, its own process
 *  group (so the whole tree can be killed), and stdout/stderr drained into a small ring buffer so a chatty
 *  child can never block on a full pipe during this test's several-minute run. */
type TrackedChild = { child: ChildProcess; lines: string[] };

function spawnBin(bin: string, args: string[], home: string, cwd: string): TrackedChild {
  const child = spawn(bin, args, {
    cwd,
    env: { HOME: home, PATH: RESTRICTED_PATH },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const t: TrackedChild = { child, lines: [] };
  const drain = (stream: NodeJS.ReadableStream | null) => {
    if (!stream) return;
    let buf = "";
    stream.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        t.lines.push(buf.slice(0, idx));
        if (t.lines.length > 200) t.lines.shift();
        buf = buf.slice(idx + 1);
      }
    });
  };
  drain(child.stdout);
  drain(child.stderr);
  return t;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls `fn()` until it returns a non-undefined value, or throws with `label` after `timeoutMs`. */
async function waitFor<T>(label: string, timeoutMs: number, fn: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (err) {
      lastErr = err;
    }
    await sleep(150);
  }
  throw new Error(`${label}: timed out after ${timeoutMs}ms${lastErr ? ` (last error: ${String(lastErr)})` : ""}`);
}

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERMs (then SIGKILLs after a grace period) `t`'s whole process group; a no-op if it already exited. */
async function stopTracked(t: TrackedChild): Promise<void> {
  if (t.child.pid === undefined || t.child.exitCode !== null || t.child.signalCode !== null) return;
  const pid = t.child.pid;
  const exited = new Promise<void>((resolvePromise) => t.child.once("exit", () => resolvePromise()));
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // already gone
  }
  await Promise.race([exited, sleep(5_000)]);
  if (t.child.exitCode === null && t.child.signalCode === null) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
    await exited;
  }
}

describe("cli-clean-room: installing the packed CLI tarball outside the repo runs the funded flow end to end", () => {
  let stack: Stack | undefined;
  let tmp: string | undefined;
  let agentDaemon: TrackedChild | undefined;
  let houseBot: TrackedChild | undefined;

  afterEach(async () => {
    if (agentDaemon) await stopTracked(agentDaemon);
    agentDaemon = undefined;
    if (houseBot) await stopTracked(houseBot);
    houseBot = undefined;
    if (stack) await stack.stop();
    stack = undefined;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }, 30_000);

  it(
    "builds, packs, installs offline, funds, plays 2 games against a house bot, and withdraws to the owner",
    async () => {
      tmp = mkdtempSync(join(tmpdir(), "cli-clean-room-"));
      const prefixDir = join(tmp, "prefix");
      const npmCacheDir = join(tmp, "npm-cache");
      const workDir = join(tmp, "work");
      mkdirSync(workDir, { recursive: true });

      // --- Step 1: the bundle under test. Final fix wave (M2): the release workflow passes the dist it just built
      // with --release (ARENA_CLEAN_ROOM_DIST), so the artifact it publishes is the one installed and run here;
      // without it, a dev build into <tmp>/dist. ---
      const prebuilt = process.env.ARENA_CLEAN_ROOM_DIST;
      let distDir: string;
      if (prebuilt) {
        distDir = resolve(REPO_ROOT, prebuilt);
        console.log(`[cli-clean-room] installing the prebuilt bundle in ${distDir}`);
      } else {
        distDir = join(tmp, "dist");
        // A hermetic base env for the build itself (never the installed binary): the ambient shell must not change
        // the default manifest (package name/license/repository) this test relies on.
        const buildEnv = { ...process.env };
        delete buildEnv.ARENA_CLI_PACKAGE;
        delete buildEnv.ARENA_CLI_LICENSE;
        delete buildEnv.ARENA_CLI_REPOSITORY;
        const buildRes = await run(TSX_BIN, [BUILD_SCRIPT, "--out", distDir], { cwd: REPO_ROOT, env: buildEnv });
        if (buildRes.status !== 0) throw new Error(`build-cli failed (${buildRes.status}): ${buildRes.stderr}`);
      }

      // --- Step 2: pack it ---
      const packRes = await run("npm", ["pack", distDir, "--pack-destination", tmp], { cwd: tmp, env: process.env });
      if (packRes.status !== 0) throw new Error(`npm pack failed (${packRes.status}): ${packRes.stderr}`);
      const tarballName = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
      if (!tarballName) throw new Error(`npm pack produced no .tgz in ${tmp}: ${packRes.stdout}`);
      const tarball = join(tmp, tarballName);

      // --- Step 3: install offline, with a cache that is never the user's own (Rules) ---
      const installRes = await run(
        "npm",
        ["install", "--prefix", prefixDir, "--offline", "--no-audit", "--no-fund", "--cache", npmCacheDir, tarball],
        { cwd: tmp, env: process.env },
      );
      // Offline mode succeeding is itself the proof the published bundle has zero runtime dependencies.
      if (installRes.status !== 0) throw new Error(`npm install --offline failed (${installRes.status}): ${installRes.stderr}`);

      const BIN = join(prefixDir, "node_modules/.bin/arena");

      // --- Step 4/5: BIN --version prints the version from packages/cli/package.json ---
      const cliPkg = JSON.parse(readFileSync(join(REPO_ROOT, "packages/cli/package.json"), "utf8")) as { version: string };
      const homeVersion = mkdtempSync(join(tmp, "home-version-"));
      const versionRes = await runBin(BIN, ["--version"], homeVersion, workDir);
      expect(versionRes.status).toBe(0);
      expect(versionRes.stdout.trim()).toBe(cliPkg.version);

      // --- Step 6: start the stack, dev faucet off (the default), automine replaced by 1s blocks so dispute/
      // funding deadlines and offer expiry track wall-clock time (same choice agent-recipe.test.ts makes) ---
      stack = await startStack({ blockTime: 1 });
      console.log(`[cli-clean-room] stack up: server=${stack.serverUrl} rpc=${stack.rpcUrl}`);

      const pub = createPublicClient({ chain: foundry, transport: http(stack.rpcUrl) });
      const deployer = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS[0]), chain: foundry, transport: http(stack.rpcUrl) });

      // --- Step 7: one house bot, running the installed binary, under its own HOME ---
      const homeBot = mkdtempSync(join(tmp, "home-bot-"));
      const botKey = generatePrivateKey();
      const botAddress = privateKeyToAccount(botKey).address;
      const botPort = await freeTcpPort();
      const botInit = await runBinJson(
        BIN,
        ["init", "--server", stack.serverUrl, "--no-faucet", "--wallet-key", botKey, "--port", String(botPort)],
        homeBot,
        workDir,
      );
      expect((botInit.wallet as string).toLowerCase()).toBe(botAddress.toLowerCase());
      await stack.fund(botAddress, 100_000_000n); // 100 USDC + native gas, same as the harness's other house bots
      houseBot = spawnBin(BIN, ["bot", "--deposit", "10", "--stake", "1", "--offers", "1"], homeBot, workDir);

      // --- Step 8: the agent, also the installed binary ---
      const homeAgent = mkdtempSync(join(tmp, "home-agent-"));
      const agentPort = await freeTcpPort();
      const agentInit = await runBinJson(BIN, ["init", "--server", stack.serverUrl, "--port", String(agentPort)], homeAgent, workDir);
      const agentAddress = agentInit.wallet as Address;

      // --- Step 9: start the agent's daemon (skill.md step 2), before picking an offer and funding ---
      agentDaemon = spawnBin(BIN, ["daemon"], homeAgent, workDir);
      await waitFor("agent daemon health", 15_000, async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${agentPort}/health`, { signal: AbortSignal.timeout(1_000) });
          return res.ok ? true : undefined;
        } catch {
          return undefined;
        }
      });

      // Review Focus 5: /board served from the daemon of the INSTALLED package -- proves api.ts's
      // import.meta.url-relative BOARD_DIR resolves correctly through npm's bin symlink into node_modules.
      const boardRes = await fetch(`http://127.0.0.1:${agentPort}/board`, { signal: AbortSignal.timeout(5_000) });
      expect(boardRes.status).toBe(200);
      expect(boardRes.headers.get("content-type")).toContain("text/html");
      const boardHtml = await boardRes.text();
      expect(boardHtml.length).toBeGreaterThan(0);
      expect(boardHtml).toContain("<html");

      // --- Step 10: pick the house bot's standing offer (skill.md step 3), but do not accept it yet ---
      type OfferRow = { offerId: Hex; offer: { player: Address; deposit: string; stakePerGame: string } };
      const offers = await waitFor<OfferRow[]>("house bot's offer visible to the agent's own daemon", 30_000, async () => {
        const list = (await runBinJson(BIN, ["offers"], homeAgent, workDir)) as OfferRow[];
        return list.some((o) => o.offer.player.toLowerCase() === botAddress.toLowerCase()) ? list : undefined;
      });
      const picked = offers.find((o) => o.offer.player.toLowerCase() === botAddress.toLowerCase())!;
      expect(picked.offer.deposit).toBe("10000000"); // base units, as `offers` prints them

      // --- Step 11: fund --offer (skill.md step 4), with the daemon up: the offer's own deposit, in whole USDC ---
      const fundResult = await runBinJson(BIN, ["fund", "--offer", picked.offerId], homeAgent, workDir);
      expect(fundResult.offerId).toBe(picked.offerId.toLowerCase());
      expect(fundResult.deposit).toBe("10.000000");
      expect(fundResult.stakePerGame).toBe("1.000000");
      expect(Number(fundResult.usdc.shortfall)).toBeGreaterThan(0);
      expect(Number(fundResult.native.shortfall)).toBeGreaterThan(0);
      expect(fundResult.message).toContain(agentAddress);
      expect(fundResult.message).toContain("USDC");
      expect(fundResult.message).toContain("on chain 31337");
      expect(fundResult.message).toContain("Also tell me the address to return winnings to.");

      // --- acting as the human: the deployer sends exactly usdc.need and native.need ---
      const usdcNeed = parseUnits(fundResult.usdc.need, 6);
      const nativeNeed = parseUnits(fundResult.native.need, 18);
      const mintHash = await deployer.writeContract({
        address: stack.usdc,
        abi: mockUsdcAbi,
        functionName: "mint",
        args: [agentAddress, usdcNeed],
        chain: foundry,
        account: deployer.account,
      });
      await pub.waitForTransactionReceipt({ hash: mintHash });
      const sendHash = await deployer.sendTransaction({ to: agentAddress, value: nativeNeed, chain: foundry, account: deployer.account });
      await pub.waitForTransactionReceipt({ hash: sendHash });

      // The recipe's wait, in --timeout 100 chunks, while the daemon runs.
      const waitResult = await runBinJson(
        BIN,
        ["wallet", "--wait-for-usdc", fundResult.usdc.need, "--wait-for-native", fundResult.native.need, "--timeout", "100"],
        homeAgent,
        workDir,
      );
      expect(waitResult.reached).toBe(true);
      // The starting balance for the report (skill.md step 4): the wallet's usdc when the wait reports reached:true.
      const startingUsdc = parseUnits(waitResult.usdc as string, 6);
      expect(startingUsdc).toBe(usdcNeed);

      // --- Step 12: negative checks, and the owner ---
      const withdrawNoOwner = await runBin(BIN, ["withdraw", "--all"], homeAgent, workDir);
      expect(withdrawNoOwner.status).toBe(1);

      const humanKey = generatePrivateKey();
      const humanAddress = privateKeyToAccount(humanKey).address;
      const ownerSetResult = await runBinJson(BIN, ["owner", "set", humanAddress], homeAgent, workDir);
      expect((ownerSetResult.owner as string).toLowerCase()).toBe(humanAddress.toLowerCase());

      const otherAddress = privateKeyToAccount(generatePrivateKey()).address;
      // Spec §4.3 (amended after the Task 3 review): a change needs the current owner's signature, not a TTY --
      // without --signature this refuses (exit 1) and the owner stays exactly as it was.
      const ownerChangeAttempt = await runBin(BIN, ["owner", "set", otherAddress], homeAgent, workDir);
      expect(ownerChangeAttempt.status).toBe(1);
      expect(ownerChangeAttempt.stdout).toContain("messageToSign");
      const ownerAfter = await runBinJson(BIN, ["owner"], homeAgent, workDir);
      expect((ownerAfter.owner as string).toLowerCase()).toBe(humanAddress.toLowerCase());

      // --- Step 13: list the offers again, then accept (skill.md step 5) ---
      const relisted = (await runBinJson(BIN, ["offers"], homeAgent, workDir)) as OfferRow[];
      const chosen = relisted.find((o) => o.offerId === picked.offerId);
      expect(chosen).toBeDefined(); // the house bot reposts only once matched, and nothing else accepts here
      await runBinJson(BIN, ["accept", chosen!.offerId], homeAgent, workDir);

      const channelId = await waitFor<Hex>("channel to appear after accept", 15_000, async () => {
        const list = (await runBinJson(BIN, ["channels"], homeAgent, workDir)) as Array<{ channelId?: Hex; degraded?: true }>;
        const c = list.find((row) => !("degraded" in row));
        return c?.channelId;
      });
      await waitFor("channel funded (phase Open)", 30_000, async () => {
        const s = await runBinJson(BIN, ["status", "--channel", channelId], homeAgent, workDir);
        return s.phase === "Open" ? true : undefined;
      });
      console.log(`[cli-clean-room] channel ${channelId} open with house bot ${botAddress}`);

      // --- play 2 games; any legal-move chooser is fine, and resigning game 2 is fine (brief step 10) ---
      const GAMES_TO_PLAY = 2;
      const RESIGN_GAME_INDEX = 1;
      const MAX_PLY_PER_GAME = 60;
      const deadline = Date.now() + 6 * 60_000;
      let lastGameIndexSeen = -1;
      let plyInCurrentGame = 0;
      // Each finished game's result for this agent (1 win, 0 draw, -1 loss), for the profit-and-loss check below.
      const results: Array<-1 | 0 | 1> = [];

      while (true) {
        if (Date.now() > deadline) throw new Error("cli-clean-room's play loop exceeded its 6-minute budget");
        await runBinJson(BIN, ["wait", "--channel", channelId, "--timeout", "20"], homeAgent, workDir);
        const status = await runBinJson(BIN, ["status", "--channel", channelId], homeAgent, workDir);
        if (status.phase === "Finalized") break;
        if (status.gameIndex !== lastGameIndexSeen) {
          lastGameIndexSeen = status.gameIndex;
          plyInCurrentGame = 0;
        }
        switch (status.attention) {
          case "your-turn": {
            plyInCurrentGame++;
            if (status.gameIndex === RESIGN_GAME_INDEX || plyInCurrentGame > MAX_PLY_PER_GAME) {
              await runBinJson(BIN, ["resign", "--channel", channelId], homeAgent, workDir);
            } else {
              const uci = pickMove(status.fen);
              await runBinJson(BIN, ["move", uci, "--channel", channelId], homeAgent, workDir);
            }
            break;
          }
          case "game-over": {
            if (results.length <= status.gameIndex) {
              results.push(status.gameStatus === "draw" ? 0 : status.gameStatus === `${status.color}_won` ? 1 : -1);
            }
            if (results.length < GAMES_TO_PLAY) {
              await runBinJson(BIN, ["next-game", "--channel", channelId], homeAgent, workDir);
            } else {
              await runBinJson(BIN, ["close", "--channel", channelId], homeAgent, workDir);
            }
            break;
          }
          case "close-requested":
            await runBinJson(BIN, ["close", "--channel", channelId], homeAgent, workDir);
            break;
          case "new-game-proposed":
            await runBinJson(BIN, ["next-game", "--channel", channelId], homeAgent, workDir);
            break;
          default:
            break; // opponent-silent / session-gas-low / human-must-move / null: never expected on this happy path
        }
      }
      expect(results).toHaveLength(GAMES_TO_PLAY);
      expect(results[RESIGN_GAME_INDEX]).toBe(-1); // the forced resignation is always a loss
      console.log(`[cli-clean-room] channel Finalized after ${results.length} games; results=${JSON.stringify(results)}`);

      // --- Step 14: the report (skill.md step 7): the change against the starting balance from the wait ---
      const walletAfterClose = await runBinJson(BIN, ["wallet"], homeAgent, workDir);
      const agentUsdcAfterClose = await usdcBalanceOf(stack, agentAddress);
      expect(parseUnits(walletAfterClose.usdc as string, 6)).toBe(agentUsdcAfterClose);
      const feePerPlayer = parseUnits(fundResult.feePerPlayer as string, 6);
      const stake = parseUnits(fundResult.stakePerGame as string, 6);
      const expectedDelta = results.reduce((sum, r) => sum + BigInt(r) * stake, 0n) - feePerPlayer;
      expect(agentUsdcAfterClose - startingUsdc).toBe(expectedDelta);

      // --- Step 15: cash out with no daemon running (M12): stop the agent's daemon first, so withdraw runs the
      // installed bundle's in-process daemon under the home lock -- after a close, the path an agent that has
      // stopped its daemon takes. ---
      const agentDaemonPid = agentDaemon.child.pid;
      await stopTracked(agentDaemon);
      await waitFor("the agent's daemon to exit", 15_000, async () => (!isAlive(agentDaemonPid) ? true : undefined));
      expect(await isPortFree(agentPort)).toBe(true);

      const humanUsdcBeforeWithdraw = await usdcBalanceOf(stack, humanAddress);
      const withdrawOne = await runBinJson(BIN, ["withdraw", "--amount", "1"], homeAgent, workDir);
      expect((withdrawOne.to as string).toLowerCase()).toBe(humanAddress.toLowerCase());
      expect(withdrawOne.amount).toBe("1.000000");
      expect(parseUnits(withdrawOne.usdcAfter as string, 6)).toBe(agentUsdcAfterClose - 1_000_000n);
      const withdrawAll = await runBinJson(BIN, ["withdraw", "--all"], homeAgent, workDir);
      expect((withdrawAll.to as string).toLowerCase()).toBe(humanAddress.toLowerCase());
      const withdrawnRest = parseUnits(withdrawAll.amount as string, 6);
      expect(withdrawnRest).toBe(agentUsdcAfterClose - 1_000_000n);
      expect(withdrawAll.usdcAfter).toBe("0.000000");
      const humanUsdcAfterWithdraw = await usdcBalanceOf(stack, humanAddress);
      expect(humanUsdcAfterWithdraw - humanUsdcBeforeWithdraw).toBe(agentUsdcAfterClose); // 1 + the rest, exactly
      const walletAfterWithdraw = await runBinJson(BIN, ["wallet"], homeAgent, workDir);
      expect(walletAfterWithdraw.usdc).toBe("0.000000");
      // Each in-process daemon stopped again, releasing the port it bound.
      expect(await isPortFree(agentPort)).toBe(true);

      // --- the house bot's own daemon never got stuck (no lastError on this channel) ---
      const botStatus = await runBinJson(BIN, ["status", "--channel", channelId], homeBot, workDir);
      expect(botStatus.lastError).toBeNull();
      expect(botStatus.phase).toBe("Finalized");

      // --- nothing left running (brief step 1): stop everything this test started right here (not just in
      // afterEach), then assert every pid is actually gone and every port is free. ---
      const pidsToConfirmDead: number[] = [];
      if (agentDaemonPid !== undefined) pidsToConfirmDead.push(agentDaemonPid); // stopped above, before the withdraws
      if (houseBot.child.pid !== undefined) pidsToConfirmDead.push(houseBot.child.pid);
      const serverPid = stack.server.pid;
      const anvilPid = stack.anvil.pid;
      if (serverPid !== undefined) pidsToConfirmDead.push(serverPid);
      if (anvilPid !== undefined) pidsToConfirmDead.push(anvilPid);
      const anvilPort = Number(new URL(stack.rpcUrl).port);
      const serverPort = Number(new URL(stack.serverUrl).port);

      await stopTracked(agentDaemon); // a no-op: already stopped before the withdraws
      await stopTracked(houseBot);
      await stack.stop();

      await waitFor("every process this test started to exit", 15_000, async () =>
        pidsToConfirmDead.every((pid) => !isAlive(pid)) ? true : undefined,
      );
      for (const pid of pidsToConfirmDead) expect(isAlive(pid)).toBe(false);
      expect(await isPortFree(anvilPort)).toBe(true);
      expect(await isPortFree(serverPort)).toBe(true);
      expect(await isPortFree(agentPort)).toBe(true);
      expect(await isPortFree(botPort)).toBe(true);

      // Clear the outer variables so afterEach's own (idempotent) teardown is a no-op on the success path.
      agentDaemon = undefined;
      houseBot = undefined;
      stack = undefined;
    },
    10 * 60_000,
  );
});
