/**
 * Plan 5.5 Task 3: a scripted "agent" (no LLM) that follows skill.md's recipe literally, through the real CLI
 * wrapper (`<dir>/bin/arena`, see `scripts/dev-up.ts`'s `writeArenaWrapper`), against a dev-up-like stack with
 * two house bots (`arena bot`, see `packages/cli/src/bot.ts`). It never reaches into daemon internals: every
 * step is a CLI invocation, exactly like a real agent's Bash tool would run.
 *
 * Uses `startStack()` plus `arena bot` children directly, per the brief's own fallback ("if the harness can't
 * easily start dev:up") -- `startStack()` gives in-process control over the stack (fund amounts, teardown,
 * direct chain reads for the exact-accounting assertion) that driving a second `tsx scripts/dev-up.ts` process
 * would need its own plumbing to get at.
 *
 * Command parsing: `RECIPE_COMMANDS` below is a pinned copy of the commands skill.md's recipe documents, each a
 * literal substring with `<wrapper>` standing in for `cfg.cliCommand`. Every one is asserted present in the
 * actually-served `/skill.md` (so the pin can never silently drift from the real doc), and the test's own play
 * loop runs the same command shapes -- with real arguments -- through the wrapper binary.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPublicClient, http, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { channelHubAbi } from "@arena/sdk";
import { loadWalletKey, pickMove } from "@arena/cli";
import { writeArenaWrapper } from "./claude-sandbox.js";
import { CLI_BIN, freeTcpPort, isPortFree, runCli, usdcBalanceOf, type Stack, startStack } from "./harness.js";

const REPO_ROOT = join(import.meta.dirname, "../..");

/** A pinned copy of the commands skill.md's recipe documents, `<wrapper>` standing in for `cfg.cliCommand`.
 *  Checked against the actually-served doc below, so this list can never silently drift from the real one. */
function recipeCommands(wrapper: string): string[] {
  return [
    `${wrapper} init --server`,
    `${wrapper} fund --offer <offerId>`,
    `${wrapper} fund --games N --stake X`,
    `${wrapper} wallet --wait-for-usdc`,
    `${wrapper} owner set`,
    `${wrapper} daemon`,
    `${wrapper} channels`,
    `${wrapper} wallet`,
    `${wrapper} offers`,
    `${wrapper} accept <offerId>`,
    `${wrapper} offer --deposit`,
    `${wrapper} wait --channel <channelId>`,
    `${wrapper} status --channel <channelId>`,
    `${wrapper} move <SAN> --channel <channelId>`,
    `${wrapper} next-game --channel <channelId>`,
    `${wrapper} close --channel <channelId>`,
    `${wrapper} challenge`,
    `${wrapper} withdraw --all`,
  ];
}

/** Runs one command through `wrapperPath` (never `node CLI_BIN` directly -- this is what proves the wrapper
 *  itself, not just the underlying CLI, is what skill.md's recipe actually runs). */
function runWrapper(wrapperPath: string, args: string[], home: string): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(wrapperPath, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ARENA_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ stdout, stderr, status: code ?? 1 }));
  });
}

async function runWrapperJson(wrapperPath: string, args: string[], home: string): Promise<any> {
  const res = await runWrapper(wrapperPath, args, home);
  if (res.status !== 0) {
    throw new Error(`"${[wrapperPath, ...args].join(" ")}" failed (exit ${res.status}): ${res.stderr || res.stdout}`);
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`"${[wrapperPath, ...args].join(" ")}" did not print JSON on stdout: ${JSON.stringify(res.stdout)}`);
  }
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

type HouseBot = { home: string; address: Address; child: ChildProcess };

/** Starts one `arena bot` child exactly like `scripts/dev-up.ts` does: funded 100 USDC + native, `init`-ed, then
 *  spawned as a long-lived `node CLI_BIN bot` process (default `--deposit 10 --stake 1 --offers 1`, matching the
 *  real `pnpm dev:up`'s house bots -- the stake the one-sentence prompt means by "$1 games"). */
async function startHouseBot(stack: Stack, dir: string, name: string): Promise<HouseBot> {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  await stack.fund(address, 100_000_000n); // 100 USDC, same as dev-up's fundAccount
  const home = mkdtempSync(join(dir, `house-${name}-`));
  const apiPort = await freeTcpPort();
  const init = await runCli(
    ["init", "--server", stack.serverUrl, "--wallet-key", key, "--port", String(apiPort), "--poll-ms", "300"],
    home,
  );
  if (init.status !== 0) throw new Error(`house bot ${name} init failed:\n${init.stderr || init.stdout}`);
  const child = spawn("node", [CLI_BIN, "bot"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ARENA_HOME: home },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { home, address, child };
}

async function stopHouseBot(bot: HouseBot): Promise<void> {
  if (bot.child.pid === undefined || bot.child.exitCode !== null || bot.child.signalCode !== null) return;
  const exited = new Promise<void>((resolvePromise) => bot.child.once("exit", () => resolvePromise()));
  try {
    process.kill(-bot.child.pid, "SIGTERM");
  } catch {
    // already gone
  }
  await Promise.race([exited, sleep(5_000)]);
  if (bot.child.exitCode === null && bot.child.signalCode === null) {
    try {
      process.kill(-bot.child.pid, "SIGKILL");
    } catch {
      // already gone
    }
    await exited;
  }
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

describe("agent-recipe: a scripted agent follows skill.md end to end", () => {
  let stack: Stack | undefined;
  let dir: string | undefined;
  const houseBots: HouseBot[] = [];
  let agentDaemon: ChildProcess | undefined;

  afterEach(async () => {
    if (agentDaemon && agentDaemon.pid !== undefined && agentDaemon.exitCode === null && agentDaemon.signalCode === null) {
      try {
        process.kill(-agentDaemon.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    agentDaemon = undefined;
    await Promise.all(houseBots.map((b) => stopHouseBot(b)));
    houseBots.length = 0;
    if (stack) await stack.stop();
    stack = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }, 30_000);

  it(
    "inits with auto-fund, starts the daemon, funds for a house bot's offer with fund --offer, accepts it, plays 3 games (resigning game 2), closes, and settles with exact accounting against the starting balance",
    async () => {
      const GAMES_TO_PLAY = 3;
      dir = mkdtempSync(join(tmpdir(), "agent-recipe-"));
      const wrapperPath = writeArenaWrapper(dir, CLI_BIN);
      // Final review I1: automine freezes chain time between transactions (startStack's own default, and never
      // changed -- about 70 other system tests depend on it). This test's whole point is the recipe a real dev
      // stack serves, so it opts into the same --block-time 1 dev-up itself now runs with: silence detection,
      // challenge/funding deadlines and offer expiry all need chain time to actually track wall-clock time.
      // The dev faucet must be on for `arena init` to auto-fund a brand-new wallet, exactly like a real dev stack.
      stack = await startStack({ blockTime: 1, serverOverrides: { cliCommand: wrapperPath, devFaucet: true } });

      console.log(`[agent-recipe] stack up: server=${stack.serverUrl} rpc=${stack.rpcUrl}`);
      houseBots.push(await startHouseBot(stack, dir, "1"));
      houseBots.push(await startHouseBot(stack, dir, "2"));
      await waitFor("house bots' offers visible in the lobby", 30_000, async () => {
        const res = await fetch(`${stack!.serverUrl}/offers`);
        if (!res.ok) return undefined;
        const list = (await res.json()) as Array<{ offer?: { player?: string } }>;
        const seen = new Set(list.map((o) => o.offer?.player?.toLowerCase()));
        return houseBots.every((b) => seen.has(b.address.toLowerCase())) ? true : undefined;
      });

      // --- "parses the commands from the served skill.md": a pinned copy, checked against the real doc ---
      const skillText = await (await fetch(`${stack.serverUrl}/skill.md`)).text();
      for (const cmd of recipeCommands(wrapperPath)) expect(skillText).toContain(cmd);

      console.log("[agent-recipe] house bots ready; recipe commands validated against the served skill.md");

      // --- Step 1: init (auto-funds from the dev faucet) ---
      const agentHome = mkdtempSync(join(dir, "agent-"));
      const agentPort = await freeTcpPort();
      const initSummary = await runWrapperJson(wrapperPath, ["init", "--server", stack.serverUrl, "--port", String(agentPort)], agentHome);
      // native: "10.0" since FAUCET_MIN_NATIVE_WEI is 10 ETH (raised from 1 ETH, fix round 1 controller add).
      expect(initSummary.faucet).toEqual({ usdc: "100.000000", native: "10.0" });
      const agentAddress = privateKeyToAccount(loadWalletKey(agentHome)).address;
      const balanceAfterInit = await usdcBalanceOf(stack, agentAddress);
      expect(balanceAfterInit).toBe(100_000_000n); // exactly the faucet's 100 USDC; the wallet started at 0

      // --- Step 2: start the daemon, keep it running (final fix wave, K1: before picking an offer and funding) ---
      agentDaemon = spawn(wrapperPath, ["daemon"], {
        cwd: REPO_ROOT,
        env: { ...process.env, ARENA_HOME: agentHome },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      await waitFor("agent daemon health", 15_000, async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${agentPort}/health`, { signal: AbortSignal.timeout(1_000) });
          return res.ok ? true : undefined;
        } catch {
          return undefined;
        }
      });

      // --- sanity check: wallet balance (folded into skill.md's fund step; kept here as a direct balance read) ---
      const walletBefore = await runWrapperJson(wrapperPath, ["wallet"], agentHome);
      // Final review I3: wallet reports whole-USDC decimals (e.g. "100.000000"), not base units -- assert the
      // shape, not just this one value, so the units claim in skill.md's recipe is actually tested.
      const WHOLE_USDC = /^[0-9]+\.[0-9]{6}$/;
      const BASE_UNITS = /^[0-9]+$/;
      expect(walletBefore.usdc).toMatch(WHOLE_USDC);
      expect(walletBefore.usdc).toBe("100.000000");

      // --- Step 3: pick a house bot's standing offer, but do not accept it yet ---
      type OfferRow = { offerId: Hex; offer: { player: Address; deposit: string; stakePerGame: string } };
      const offers = (await runWrapperJson(wrapperPath, ["offers"], agentHome)) as OfferRow[];
      expect(offers.length).toBeGreaterThanOrEqual(2);
      // Final review I3: offers reports USDC in base units (6 decimals), not whole-USDC decimals.
      for (const o of offers) {
        expect(o.offer.stakePerGame).toMatch(BASE_UNITS);
        expect(o.offer.deposit).toMatch(BASE_UNITS);
      }
      const picked = offers.find((o) => o.offer.stakePerGame === "1000000");
      expect(picked).toBeDefined();

      // --- Step 4: fund --offer (the daemon is up), wait, note the starting balance, record the owner ---
      const fundResult = await runWrapperJson(wrapperPath, ["fund", "--offer", picked!.offerId], agentHome);
      expect(fundResult.offerId).toBe(picked!.offerId.toLowerCase());
      expect(fundResult.stakePerGame).toBe("1.000000"); // the offer's own stake, in whole USDC
      expect(fundResult.deposit).toBe("10.000000"); // the house bot's deposit, converted for the agent
      // init's faucet (100 USDC + 10 native) already covers the offer's deposit plus the fee and the gas reserve.
      expect(fundResult.usdc.shortfall).toBe("0.000000");
      expect(fundResult.native.shortfall).toBe("0.0"); // native amounts are ether decimals, not 6-dp USDC
      expect(fundResult.owner).toBeNull();
      // Nothing is short, so the recipe needs no wait -- run it anyway, with the daemon up, as the agent would after
      // a shortfall: it must return at once with reached:true and the same balance fund reported.
      const waitResult = await runWrapperJson(
        wrapperPath,
        ["wallet", "--wait-for-usdc", fundResult.usdc.need, "--wait-for-native", fundResult.native.need, "--timeout", "100"],
        agentHome,
      );
      expect(waitResult.reached).toBe(true);
      expect(waitResult.usdc).toBe(fundResult.usdc.have);
      // The starting balance for step 7's report: fund's usdc.have (nothing was short).
      const startingUsdc = parseUnits(fundResult.usdc.have as string, 6);
      expect(startingUsdc).toBe(balanceAfterInit);
      const humanAddress = privateKeyToAccount(generatePrivateKey()).address;
      const ownerSetResult = await runWrapperJson(wrapperPath, ["owner", "set", humanAddress], agentHome);
      expect(ownerSetResult.owner.toLowerCase()).toBe(humanAddress.toLowerCase());

      // --- Step 5: list the offers again, then accept (if the funded one is gone, another, funded again) ---
      const relisted = (await runWrapperJson(wrapperPath, ["offers"], agentHome)) as OfferRow[];
      let chosen = relisted.find((o) => o.offerId === picked!.offerId);
      if (!chosen) {
        chosen = relisted.find((o) => o.offer.stakePerGame === "1000000");
        expect(chosen).toBeDefined();
        const again = await runWrapperJson(wrapperPath, ["fund", "--offer", chosen!.offerId], agentHome);
        expect(again.usdc.shortfall).toBe("0.000000");
      }
      const houseBot = houseBots.find((b) => b.address.toLowerCase() === chosen!.offer.player.toLowerCase());
      expect(houseBot).toBeDefined();
      await runWrapperJson(wrapperPath, ["accept", chosen!.offerId], agentHome);

      const channelId = await waitFor<Hex>("channel to appear after accept", 15_000, async () => {
        const list = (await runWrapperJson(wrapperPath, ["channels"], agentHome)) as Array<{ channelId?: Hex; degraded?: true }>;
        const c = list.find((c) => !("degraded" in c));
        return c?.channelId;
      });
      const openedStatus = await waitFor<{ balances: { me: string; opponent: string } }>("channel funded (phase Open)", 30_000, async () => {
        const s = await runWrapperJson(wrapperPath, ["status", "--channel", channelId], agentHome);
        return s.phase === "Open" ? s : undefined;
      });
      // Final review I3: channels/status balances are whole-USDC decimals too, like wallet -- never base units.
      expect(openedStatus.balances.me).toMatch(WHOLE_USDC);
      expect(openedStatus.balances.opponent).toMatch(WHOLE_USDC);
      console.log(`[agent-recipe] channel ${channelId} open with house bot ${houseBot!.address}`);

      // --- Step 6: the play loop -- 3 games at $1, always resigning game index 1 ("game 2") ---
      const RESIGN_GAME_INDEX = 1;
      const MAX_PLY_PER_GAME = 60;
      const rng = (() => {
        let a = 0x5eed;
        return () => {
          a = (a + 0x6d2b79f5) >>> 0;
          let t = a;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      })();
      const results: Array<-1 | 0 | 1> = [];
      let plyInCurrentGame = 0;
      let lastGameIndexSeen = -1;
      const deadline = Date.now() + 8 * 60_000;

      while (true) {
        if (Date.now() > deadline) {
          throw new Error(`agent-recipe play loop exceeded its 8-minute budget; results so far: ${JSON.stringify(results)}`);
        }
        await runWrapperJson(wrapperPath, ["wait", "--channel", channelId, "--timeout", "20"], agentHome);
        const status = await runWrapperJson(wrapperPath, ["status", "--channel", channelId], agentHome);
        if (status.phase === "Finalized") break;
        if (status.gameIndex !== lastGameIndexSeen) {
          lastGameIndexSeen = status.gameIndex;
          plyInCurrentGame = 0;
        }
        switch (status.attention) {
          case "your-turn": {
            plyInCurrentGame++;
            if (status.gameIndex === RESIGN_GAME_INDEX || plyInCurrentGame > MAX_PLY_PER_GAME) {
              await runWrapperJson(wrapperPath, ["resign", "--channel", channelId], agentHome);
            } else {
              const uci = pickMove(status.fen, rng);
              await runWrapperJson(wrapperPath, ["move", uci, "--channel", channelId], agentHome);
            }
            break;
          }
          case "game-over": {
            if (results.length <= status.gameIndex) {
              const result: -1 | 0 | 1 = status.gameStatus === "draw" ? 0 : status.gameStatus === `${status.color}_won` ? 1 : -1;
              results.push(result);
              console.log(`[agent-recipe] game ${status.gameIndex} over: ${status.gameStatus} (my color ${status.color}) -> result ${result}`);
            }
            if (results.length < GAMES_TO_PLAY) {
              await runWrapperJson(wrapperPath, ["next-game", "--channel", channelId], agentHome);
            } else {
              await runWrapperJson(wrapperPath, ["close", "--channel", channelId], agentHome);
            }
            break;
          }
          case "close-requested": {
            await runWrapperJson(wrapperPath, ["close", "--channel", channelId], agentHome);
            break;
          }
          case "new-game-proposed": {
            // The house bot never proposes on its own (Plan 5.5 Task 2), but agree defensively if it ever does.
            await runWrapperJson(wrapperPath, ["next-game", "--channel", channelId], agentHome);
            break;
          }
          default:
            break; // opponent-silent / session-gas-low / human-must-move / null: never expected on this happy path
        }
      }

      console.log(`[agent-recipe] channel Finalized; results=${JSON.stringify(results)}`);

      // --- Step 7: settled -- check the wallet again, and report against step 4's starting balance ---
      expect(results).toHaveLength(GAMES_TO_PLAY);
      expect(results[RESIGN_GAME_INDEX]).toBe(-1); // the forced resignation is always a loss

      const walletAfter = await runWrapperJson(wrapperPath, ["wallet"], agentHome);
      const balanceAfterClose = await usdcBalanceOf(stack, agentAddress);

      const pub = createPublicClient({ chain: foundry, transport: http(stack.rpcUrl) });
      const feePerPlayer = (await pub.readContract({ address: stack.hub, abi: channelHubAbi, functionName: "feePerPlayer" })) as bigint;
      const stakePerGame = 1_000_000n; // $1, matches the accepted offer's stakePerGame
      const expectedDelta = results.reduce((sum, r) => sum + BigInt(r) * stakePerGame, 0n) - feePerPlayer;
      const actualDelta = balanceAfterClose - startingUsdc;
      // The report's own number: the wallet's usdc now (as `wallet` prints it) minus the starting balance.
      expect(parseUnits(walletAfter.usdc as string, 6) - startingUsdc).toBe(actualDelta);
      // Exact USDC accounting (Ruling 5): wallet delta = sum(game results * stake) - fee. Gas on this dev chain
      // is paid in native ETH, a separate token from USDC (unlike Arc, where gas is USDC too, per skill.md) --
      // it never touches this balance, so it needs no separate term here.
      expect(actualDelta).toBe(expectedDelta);
      expect(walletAfter.usdc).not.toBe(walletBefore.usdc); // sanity: the formatted wallet output moved too

      // --- Step 8: ask to withdraw now; withdraw --all (the daemon is still running, so this goes through its
      // API, not the in-process-daemon fallback) -- the owner's USDC delta must equal exactly what was withdrawn,
      // and the agent's own wallet must end at zero (the dev reserve is 0). ---
      const ownerBalanceBeforeWithdraw = await usdcBalanceOf(stack, humanAddress);
      const withdrawResult = await runWrapperJson(wrapperPath, ["withdraw", "--all"], agentHome);
      expect(withdrawResult.to.toLowerCase()).toBe(humanAddress.toLowerCase());
      const withdrawnAmount = parseUnits(withdrawResult.amount as string, 6);
      expect(withdrawnAmount).toBe(balanceAfterClose); // --all drains the whole wallet; dev reserve is 0
      const ownerBalanceAfterWithdraw = await usdcBalanceOf(stack, humanAddress);
      expect(ownerBalanceAfterWithdraw - ownerBalanceBeforeWithdraw).toBe(withdrawnAmount);
      const walletAfterWithdraw = await runWrapperJson(wrapperPath, ["wallet"], agentHome);
      expect(walletAfterWithdraw.usdc).toBe("0.000000");

      // --- the house bot's own daemon never got stuck (no lastError on this channel) ---
      const botStatus = await runCli(["status", "--channel", channelId], houseBot!.home);
      expect(botStatus.status).toBe(0);
      const botStatusJson = JSON.parse(botStatus.stdout);
      expect(botStatusJson.lastError).toBeNull();
      expect(botStatusJson.phase).toBe("Finalized");

      // --- nothing left running (I3): stop the agent daemon, every house bot and the whole stack right here (not
      // just in afterEach), then assert every pid this test started is actually gone, and both ports free up.
      // afterEach stays as the safety net for a failure earlier in the test, not the thing this asserts. ---
      const pidsToConfirmDead: number[] = [];
      if (agentDaemon.pid !== undefined) pidsToConfirmDead.push(agentDaemon.pid);
      for (const b of houseBots) if (b.child.pid !== undefined) pidsToConfirmDead.push(b.child.pid);
      const serverPid = stack.server.pid;
      const anvilPid = stack.anvil.pid;
      if (serverPid !== undefined) pidsToConfirmDead.push(serverPid);
      if (anvilPid !== undefined) pidsToConfirmDead.push(anvilPid);
      const anvilPort = Number(new URL(stack.rpcUrl).port);
      const serverPort = Number(new URL(stack.serverUrl).port);

      agentDaemon.kill("SIGTERM");
      await Promise.all(houseBots.map((b) => stopHouseBot(b)));
      await stack.stop();

      await waitFor("every process this test started to exit", 15_000, async () =>
        pidsToConfirmDead.every((pid) => !isAlive(pid)) ? true : undefined,
      );
      for (const pid of pidsToConfirmDead) expect(isAlive(pid)).toBe(false);
      expect(await isPortFree(anvilPort)).toBe(true);
      expect(await isPortFree(serverPort)).toBe(true);

      // Clear the outer variables so afterEach's own (idempotent) teardown is a no-op on the success path.
      agentDaemon = undefined;
      houseBots.length = 0;
      stack = undefined;
    },
    10 * 60_000,
  );
});
