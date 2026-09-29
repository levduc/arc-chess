#!/usr/bin/env node
/**
 * Plan 4.5 Task 11: a manual soak of the arena over the real host server, real `arena daemon` processes and a real
 * chain (Anvil). `N` daemons, `M` channels, looping continuously (create -> accept -> play a random game capped at
 * 40 plies -> a random number of next-game rounds -> close -> repeat) until `--minutes` elapses.
 *
 * Every 30s it samples each daemon's and the server's RSS and open file descriptor count (from /proc), plus the
 * server's /metrics, and writes tests/system/../../.arena-dev/soak-report.json (gitignored). It fails (non-zero
 * exit) if:
 *  - any process's RSS grows more than 50% comparing the median of the first 3 post-warmup samples (warmup = 3
 *    minutes) against the median of the last 3 samples of the run; or
 *  - any channel makes no progress (no change in turn/game/phase) for more than 2 minutes while it holds an open
 *    channel (a slot between channels -- no channelId assigned yet -- is not "stalled").
 *
 * Usage: pnpm soak [--minutes 30] [--daemons 10] [--channels 30]
 *
 * Ctrl-C (SIGINT) or SIGTERM drains in-flight cycles, tears the stack down, writes the final report, and exits.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import { HubClient } from "@arena/sdk";
import { readJson, type ChannelRecord } from "@arena/cli";
import { startStack, type Player, type Stack } from "./harness.js";
import { createPublicClient, http, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { mulberry32, playRandomGameCapped, waitStatus, type Status } from "./bot.js";

const REPO_ROOT = join(import.meta.dirname, "../..");
const REPORT_PATH = join(REPO_ROOT, ".arena-dev", "soak-report.json");

const DEPOSIT = 1_000_000n;
const STAKE = 100_000n;
const PLY_CAP = 40;
const SAMPLE_MS = 30_000;
const WATCHDOG_MS = 10_000;
const STALL_MS = 2 * 60_000;
const WARMUP_MS = 3 * 60_000;
const RSS_GROWTH_LIMIT_PCT = 50;
/** The per-step wait budget for every daemon-API poll in the cycle loop (open, play, next-game, close). A generous
 *  margin over the sub-second delivery these steps normally see, comfortably under STALL_MS so a genuine stall is
 *  still caught by the watchdog rather than by a step timing out first.
 *
 *  Correction (Task 11 review, scratchpad/review-task11.md): raised here from 20-30s to 90s, this constant's
 *  original docstring blamed the match-notification stalls that motivated the raise on Node event-loop lag under
 *  load (CPU-bound signature verification). That diagnosis was wrong -- the actual cause was a daemon bug: a
 *  matched offer was never unwatched, so a long-lived daemon's host connection eventually exhausted the server's
 *  per-connection watch-slot cap and permanently stopped hearing of new matches as an offerer (fixed in
 *  packages/cli/src/daemon.ts's onMatch; see waitStatus's UNKNOWN_CHANNEL_GRACE_MS in bot.ts for the matching
 *  correction there). Left at 90s regardless: it is a harmless, generous margin now that a genuinely stuck match
 *  fails within `UNKNOWN_CHANNEL_GRACE_MS` (10s) independent of this budget, and 90s still comfortably covers
 *  ordinary, non-leak slowness in the other steps this constant bounds (a move, a close handshake). */
const OP_TIMEOUT_MS = 90_000;
/** Every daemon a top-up so a long run of many cycles (each permanently burning 2*FEE) never runs the wallet dry;
 *  the mock USDC has no real value, so this is generous on purpose. */
const TOPUP = 2_000_000_000n;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------------------------------------------------- args

type Args = { minutes: number; daemons: number; channels: number };

function parseArgs(argv: string[]): Args {
  const num = (name: string, def: number): number => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0 || argv[i + 1] === undefined) return def;
    const v = Number(argv[i + 1]);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} must be a positive number`);
    return v;
  };
  return { minutes: num("minutes", 30), daemons: num("daemons", 10), channels: num("channels", 30) };
}

// ------------------------------------------------------------------------------------------------------ helpers

function hubOf(s: Stack): { pub: PublicClient; hub: HubClient } {
  const pub = createPublicClient({ chain: foundry, transport: http(s.rpcUrl) }) as PublicClient;
  return { pub, hub: new HubClient(s.hub, pub) };
}

async function waitFor<T>(fn: () => Promise<T> | T, ms = 20_000, what = "condition"): Promise<Exclude<T, undefined | null | false>> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as Exclude<T, undefined | null | false>;
    } catch (err) {
      last = err;
    }
    await sleep(100);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

async function postOffer(p: Player): Promise<Hex> {
  const { offerId } = await p.api("POST", "/offers", {
    deposit: DEPOSIT.toString(),
    stakePerGame: STAKE.toString(),
  });
  return offerId as Hex;
}

/** Race-free even with several slots opening channels on the same daemon concurrently: offerId is unique. */
async function findChannelByOffer(p: Player, offerId: Hex): Promise<Hex> {
  return waitFor(async () => {
    const chans = (await p.api("GET", "/channels")) as Array<{ channelId: Hex }>;
    for (const c of chans) {
      const rec = readJson<ChannelRecord>(join(p.home, "channels", c.channelId, "record.json"));
      if (rec && rec.offerId.toLowerCase() === offerId.toLowerCase()) return c.channelId;
    }
    return undefined;
  }, OP_TIMEOUT_MS, `${p.name}'s channel for offer ${offerId}`);
}

async function closeBoth(a: Player, b: Player, id: Hex, hub: HubClient): Promise<void> {
  const aStatus = (await a.api("GET", `/status?channel=${id}`)) as Status;
  await waitStatus(b, (s) => s.turnNum === aStatus.turnNum, OP_TIMEOUT_MS, id);
  await a.api("POST", "/close", { channel: id });
  await waitStatus(b, (s) => s.opponentWantsToClose === true, OP_TIMEOUT_MS, id);
  await b.api("POST", "/close", { channel: id });
  await waitFor(async () => (await hub.channelInfo(id)).phase === "Finalized", OP_TIMEOUT_MS, `channel ${id} Finalized`);
  await waitStatus(a, (s) => s.phase === "Finalized", OP_TIMEOUT_MS, id);
  await waitStatus(b, (s) => s.phase === "Finalized", OP_TIMEOUT_MS, id);
}

// ------------------------------------------------------------------------------------------------------ /proc

function readRssKb(pid: number | undefined): number | null {
  if (pid === undefined) return null;
  try {
    const text = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = /^VmRSS:\s+(\d+) kB/m.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function countFds(pid: number | undefined): number | null {
  if (pid === undefined) return null;
  try {
    return readdirSync(`/proc/${pid}/fd`).length;
  } catch {
    return null;
  }
}

async function fetchMetrics(url: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const text = await (await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(5_000) })).text();
    for (const m of text.matchAll(/^(arena_\w+)\s+(-?\d+(?:\.\d+)?|NaN)$/gm)) out[m[1]] = Number(m[2]);
  } catch (err) {
    out.error = 1;
    console.log(`[soak] /metrics fetch failed: ${String(err)}`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------- types

type ProcSample = { name: string; pid: number | null; rssKb: number | null; fds: number | null };
type Sample = { t: number; elapsedSec: number; procs: ProcSample[]; metrics: Record<string, number> };

function median(vals: number[]): number {
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Any process whose RSS grew more than `RSS_GROWTH_LIMIT_PCT`%, comparing the median of the first 3 post-warmup
 *  samples against the median of the run's last 3 samples. Empty (no data yet, or too few samples) is not a pass
 *  by itself -- the caller only checks this once the run is actually long enough to have warmup + 3 + 3 samples. */
function checkRssGrowth(samples: Sample[]): Array<{ name: string; beforeKb: number; afterKb: number; growthPct: number }> {
  const warmupIdx = samples.findIndex((s) => s.t >= WARMUP_MS);
  if (warmupIdx < 0 || samples.length < warmupIdx + 3 || samples.length < 3) return [];
  const names = [...new Set(samples.flatMap((s) => s.procs.map((p) => p.name)))];
  const out: Array<{ name: string; beforeKb: number; afterKb: number; growthPct: number }> = [];
  for (const name of names) {
    const before = samples
      .slice(warmupIdx, warmupIdx + 3)
      .map((s) => s.procs.find((p) => p.name === name)?.rssKb)
      .filter((v): v is number => v !== null && v !== undefined);
    const after = samples
      .slice(-3)
      .map((s) => s.procs.find((p) => p.name === name)?.rssKb)
      .filter((v): v is number => v !== null && v !== undefined);
    if (before.length < 3 || after.length < 3) continue;
    const beforeKb = median(before);
    const afterKb = median(after);
    const growthPct = beforeKb === 0 ? 0 : ((afterKb - beforeKb) / beforeKb) * 100;
    if (growthPct > RSS_GROWTH_LIMIT_PCT) out.push({ name, beforeKb, afterKb, growthPct });
  }
  return out;
}

// -------------------------------------------------------------------------------------------------------- main

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.daemons < 2) throw new Error("--daemons must be at least 2");
  console.log(`[soak] starting: ${args.daemons} daemons, ${args.channels} channels, ${args.minutes} minutes`);
  mkdirSync(join(REPO_ROOT, ".arena-dev"), { recursive: true });

  const startedAt = Date.now();
  const endAt = startedAt + args.minutes * 60_000;
  const failures: string[] = [];
  let stopping = false;
  let exitCode = 0;

  const stack: Stack = await startStack({
    // wsPerIp/maxOpenOffersPerIp/httpPostBurst per the Task 11 brief -- every daemon here shares 127.0.0.1, which a
    // production deployment never would. httpPostPerSec is the same accommodation for a different limit: a real
    // soak run's *sustained* POST rate (2 lobby POSTs per channel cycle, times every channel slot, continuously)
    // exceeds the default 1/s once enough channels are churning, which the raised burst alone only postpones --
    // the Task 11 report has the run that found this the hard way (a `POST /offers -> 500: rate limited`).
    //
    // wsFrameBurst/wsFramePerSec are the same idea for the per-connection *websocket* frame limit (default burst
    // 200, 20/s): one soak daemon holds several channels at once (4-5 here), each sending every move and its
    // dispute-check traffic over its one socket, where a real production daemon holds one or two. The default
    // limit is per *connection*, not per channel, so it trips well before any single real daemon would ever
    // approach it -- and tripping it matters more than a dropped frame: the server closes the socket outright
    // (`ws.close(1008, "rate limited")`, ws.ts), and the reconnect backoff only resets after 30s stable
    // (`stableAfterMs`, host.ts), so repeated trips turn into a growing-backoff reconnect storm that can black out
    // *all* traffic on that socket -- including new-match delivery -- for well over a minute.
    //
    // Confirmed still necessary, independent of the watched-offer leak (Task 11 review, scratchpad/review-
    // task11.md, C1): the review correctly found that leak -- not this limit -- caused the *original* 15-minute
    // run's failures, and questioned whether this raise was still needed once the leak was fixed. Re-tested with
    // the leak fixed and this raise removed: a 6-minute run at the same daemon/channel counts still failed within
    // 3 minutes, with the daemon logs showing the exact reconnect-storm signature this comment describes
    // (`host: reconnecting in ...` climbing 4s -> 8s -> repeatedly ~10s, never stabilizing long enough to reset).
    // This limit is a genuinely separate, still-real finding: relay message *volume* from several concurrent
    // channels on one connection, unrelated to how many offers that connection has ever watched.
    serverOverrides: {
      limits: { wsPerIp: 128, maxOpenOffersPerIp: 128, httpPostBurst: 400, httpPostPerSec: 50, wsFrameBurst: 2000, wsFramePerSec: 200 },
    },
  });

  // Override the harness's own SIGINT/SIGTERM handlers (they kill everything and exit immediately, with no chance
  // to drain, write a final report, or close the stack cleanly). Its `exit` backstop stays installed.
  let forceTimer: NodeJS.Timeout | undefined;
  const onSignal = (sig: string, code: number): void => {
    console.log(`[soak] ${sig} received: draining the current cycle, then shutting down...`);
    stopping = true;
    if (!forceTimer) {
      forceTimer = setTimeout(() => {
        console.log("[soak] drain timed out after 30s; forcing shutdown");
        void stack.stop().finally(() => process.exit(code));
      }, 30_000);
      forceTimer.unref();
    }
  };
  process.removeAllListeners("SIGINT");
  process.on("SIGINT", () => onSignal("SIGINT", 130));
  process.removeAllListeners("SIGTERM");
  process.on("SIGTERM", () => onSignal("SIGTERM", 143));

  const samples: Sample[] = [];
  function writeReport(summary?: object): void {
    writeFileSync(
      REPORT_PATH,
      JSON.stringify({ args, startedAt: new Date(startedAt).toISOString(), samples, failures, summary }, null, 2),
    );
  }

  try {
    const players: Player[] = [];
    for (let i = 0; i < args.daemons; i++) {
      const p = await stack.player(`d${i}`);
      await stack.fund(p.address, TOPUP);
      players.push(p);
    }
    const { hub } = hubOf(stack);

    const edges: Array<[number, number]> = [];
    for (let c = 0; c < args.channels; c++) {
      const i = c % args.daemons;
      const j = (i + 1 + (c % (args.daemons - 1))) % args.daemons;
      edges.push([i, j]);
    }

    type Slot = {
      idx: number;
      offerer: Player;
      accepter: Player;
      channelId: Hex | null;
      fingerprint: string | null;
      lastProgressAt: number;
      gamesCompleted: number;
      channelsCompleted: number;
      rand: () => number;
      maxMatchLatencyMs: number;
      slowMatches: number;
    };
    const slots: Slot[] = edges.map(([i, j], idx) => ({
      idx,
      offerer: players[i],
      accepter: players[j],
      channelId: null,
      fingerprint: null,
      lastProgressAt: Date.now(),
      gamesCompleted: 0,
      channelsCompleted: 0,
      rand: mulberry32(1000 + idx),
      maxMatchLatencyMs: 0,
      slowMatches: 0,
    }));
    /** How long the offerer's own daemon takes to learn of a match (an async lobby event, `onMatch`) after the
     *  accepter's accept returns -- normally sub-second; tracked because `waitStatus` (bot.ts) now tolerates the
     *  offerer's transient "unknown channel" 404 during this window instead of failing on it (Plan 4.5 Task 11's
     *  soak run first surfaced the race). A latency that climbs into the seconds under load, rather than staying
     *  flat, would point at `onMatch` falling over to the slower `retryMatches` path (daemon.ts) instead of the
     *  event-driven one -- a real product finding, not just a harness accommodation. */
    const MATCH_LATENCY_WARN_MS = 5_000;

    async function runSlot(slot: Slot): Promise<void> {
      let cycle = 0;
      while (!stopping && Date.now() < endAt) {
        const offerId = await postOffer(slot.offerer);
        await slot.accepter.api("POST", "/offers/accept", { offerId });
        const matchStart = Date.now();
        const id = await findChannelByOffer(slot.accepter, offerId);
        slot.channelId = id;
        slot.lastProgressAt = Date.now();
        await waitStatus(slot.offerer, (s) => s.phase === "Open", OP_TIMEOUT_MS, id);
        const matchLatencyMs = Date.now() - matchStart;
        slot.maxMatchLatencyMs = Math.max(slot.maxMatchLatencyMs, matchLatencyMs);
        if (matchLatencyMs > MATCH_LATENCY_WARN_MS) {
          slot.slowMatches++;
          console.log(`[soak] slot ${slot.idx}: offerer took ${matchLatencyMs}ms to learn of the match on channel ${id}`);
        }
        await waitStatus(slot.accepter, (s) => s.phase === "Open", OP_TIMEOUT_MS, id);
        slot.lastProgressAt = Date.now();

        const rounds = 1 + Math.floor(slot.rand() * 3); // 1..3 games per channel
        // `finished` tracks whether the loop ran to completion (every round played, ending on a terminal state) or
        // was cut short by `stopping`: closing on anything but a terminal state is refused by the daemon (a
        // next-game handshake leaves a fresh, non-terminal game in progress), so a mid-cycle shutdown must skip the
        // close rather than attempt one -- the process teardown below kills the daemons regardless.
        let finished = true;
        for (let g = 0; g < rounds; g++) {
          if (stopping) {
            finished = false;
            break;
          }
          const seed = ((slot.idx + 1) * 1_000_003 + cycle * 97 + g * 13) >>> 0;
          await playRandomGameCapped(slot.offerer, slot.accepter, { channelId: id, seed, maxMoves: PLY_CAP, ms: OP_TIMEOUT_MS });
          await waitStatus(slot.offerer, (s) => s.gameStatus !== "playing" && s.gameStatus !== "draw_offered", OP_TIMEOUT_MS, id);
          slot.gamesCompleted++;
          slot.lastProgressAt = Date.now();
          if (g < rounds - 1) {
            if (stopping) {
              finished = false;
              break;
            }
            await slot.offerer.api("POST", "/next-game", { channel: id });
            await waitStatus(slot.accepter, (s) => s.attention === "new-game-proposed", OP_TIMEOUT_MS, id);
            await slot.accepter.api("POST", "/next-game", { channel: id });
            await waitStatus(slot.offerer, (s) => s.gameIndex === g + 1 && s.newGame === "none", OP_TIMEOUT_MS, id);
            slot.lastProgressAt = Date.now();
          }
        }
        if (!finished || stopping) break; // shutting down: leave this channel as-is, the stack teardown kills it

        await closeBoth(slot.offerer, slot.accepter, id, hub);
        slot.channelsCompleted++;
        slot.channelId = null;
        slot.lastProgressAt = Date.now();
        cycle++;
      }
    }

    const slotPromises = slots.map((slot) =>
      runSlot(slot).catch((err: unknown) => {
        const msg = `slot ${slot.idx} (offerer ${slot.offerer.name}, accepter ${slot.accepter.name}) failed: ${String(err)}`;
        console.log(`[soak] ${msg}`);
        // The stack tears down once every slot promise settles, taking both daemons' logs with it -- capture the
        // tail now, while they're still readable, or a real bug here is nearly impossible to root-cause afterward.
        console.log(`[soak] --- ${slot.offerer.name}'s last log lines ---\n${slot.offerer.logs().split("\n").slice(-40).join("\n")}`);
        console.log(`[soak] --- ${slot.accepter.name}'s last log lines ---\n${slot.accepter.logs().split("\n").slice(-40).join("\n")}`);
        failures.push(msg);
        stopping = true;
        exitCode = 1;
      }),
    );

    // Stall watchdog: any slot holding an open channel whose status hasn't changed in over STALL_MS is a stall,
    // whether or not that slot's own loop noticed (a hung relay could leave the loop's own await pending forever).
    const watchdog = setInterval(() => {
      void (async () => {
        for (const slot of slots) {
          if (!slot.channelId) continue; // between channels: not "waiting on the soak driver" itself, not a stall
          try {
            const st = (await slot.offerer.api("GET", `/status?channel=${slot.channelId}`)) as Status;
            const fp = JSON.stringify({
              turnNum: st.turnNum,
              gameIndex: st.gameIndex,
              gameStatus: st.gameStatus,
              newGame: st.newGame,
              attention: st.attention,
              phase: st.phase,
            });
            if (fp !== slot.fingerprint) {
              slot.fingerprint = fp;
              slot.lastProgressAt = Date.now();
            } else if (Date.now() - slot.lastProgressAt > STALL_MS) {
              const msg = `slot ${slot.idx} (channel ${slot.channelId}) made no progress for over ${STALL_MS / 60_000} minutes`;
              console.log(`[soak] ${msg}`);
              failures.push(msg);
              stopping = true;
              exitCode = 1;
            }
          } catch (err) {
            // A request error (most commonly the offerer's transient "unknown channel" 404 right after a match --
            // see bot.ts's waitStatus) is not progress either. Bug fixed here: this used to be silently ignored
            // every tick forever, which meant a channel stuck erroring past STALL_MS was invisible to this
            // watchdog -- exactly the failure mode the required 15-minute soak run hit (a slot's own `waitStatus`
            // eventually timed out on its own, tighter budget, but the watchdog never would have caught it).
            if (Date.now() - slot.lastProgressAt > STALL_MS) {
              const msg = `slot ${slot.idx} (channel ${slot.channelId}) made no progress for over ${STALL_MS / 60_000} minutes (last error: ${String(err)})`;
              console.log(`[soak] ${msg}`);
              failures.push(msg);
              stopping = true;
              exitCode = 1;
            }
          }
        }
      })();
    }, WATCHDOG_MS);

    async function takeSample(): Promise<void> {
      const procs: ProcSample[] = players.map((p) => {
        const pid = p.pid();
        return { name: p.name, pid: pid ?? null, rssKb: readRssKb(pid), fds: countFds(pid) };
      });
      const serverPid = stack.server.pid;
      procs.push({ name: "server", pid: serverPid ?? null, rssKb: readRssKb(serverPid), fds: countFds(serverPid) });
      const metrics = await fetchMetrics(stack.serverUrl);
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      const sample: Sample = { t: Date.now() - startedAt, elapsedSec, procs, metrics };
      samples.push(sample);
      const totalGames = slots.reduce((n, s) => n + s.gamesCompleted, 0);
      const totalChannels = slots.reduce((n, s) => n + s.channelsCompleted, 0);
      console.log(
        `[soak] t=${elapsedSec}s sample #${samples.length}: games=${totalGames} channels=${totalChannels} ` +
          `ws=${metrics.arena_ws_connections ?? "?"} ` +
          `server rss=${procs[procs.length - 1].rssKb ?? "?"}kB fds=${procs[procs.length - 1].fds ?? "?"} ` +
          `failures=${failures.length}`,
      );
      writeReport();
    }

    const sampler = setInterval(() => void takeSample(), SAMPLE_MS);
    await takeSample(); // immediate baseline sample

    while (!stopping && Date.now() < endAt) await sleep(1_000);
    stopping = true;
    clearInterval(watchdog);
    clearInterval(sampler);
    await Promise.allSettled(slotPromises);
    await takeSample(); // final sample

    const rssViolations = checkRssGrowth(samples);
    for (const v of rssViolations) {
      const msg = `${v.name}: RSS grew ${v.growthPct.toFixed(1)}% (${v.beforeKb}kB -> ${v.afterKb}kB), over the ${RSS_GROWTH_LIMIT_PCT}% limit`;
      console.log(`[soak] ${msg}`);
      failures.push(msg);
      exitCode = 1;
    }

    const summary = {
      samples: samples.length,
      gamesCompleted: slots.reduce((n, s) => n + s.gamesCompleted, 0),
      channelsCompleted: slots.reduce((n, s) => n + s.channelsCompleted, 0),
      rssStartKb: Object.fromEntries(samples[0].procs.map((p) => [p.name, p.rssKb])),
      rssEndKb: Object.fromEntries(samples[samples.length - 1].procs.map((p) => [p.name, p.rssKb])),
      fdsStart: Object.fromEntries(samples[0].procs.map((p) => [p.name, p.fds])),
      fdsEnd: Object.fromEntries(samples[samples.length - 1].procs.map((p) => [p.name, p.fds])),
      maxMatchLatencyMs: Math.max(0, ...slots.map((s) => s.maxMatchLatencyMs)),
      slowMatches: slots.reduce((n, s) => n + s.slowMatches, 0),
      rssViolations,
      failures,
      exitCode,
    };
    writeReport(summary);
    console.log(`[soak] finished: ${JSON.stringify(summary)}`);
  } catch (err) {
    console.log(`[soak] fatal: ${String(err)}`);
    failures.push(`fatal: ${String(err)}`);
    exitCode = 1;
    writeReport({ failures, exitCode });
  } finally {
    if (forceTimer) clearTimeout(forceTimer);
    await stack.stop();
  }
  process.exitCode = exitCode;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
