/**
 * Self-host house bot (deploy/host/bots/house-bot.sh): `node /app/bot-run.mjs <command> [args...]` runs the command
 * with its stdout and stderr redacted of the bot's RPC URLs (`redactUrls`), line by line. The CLI quotes its RPC URL
 * verbatim in its errors, and a provider URL can carry an API key, so nothing the bot prints reaches `docker compose
 * logs` (or a pasted issue) with it. The RPC URLs are `BOT_RPC_URL` and the `rpcUrl` recorded in
 * `$ARENA_HOME/config.json`, read when the command starts.
 *
 * Signals (SIGTERM from `docker compose stop`, SIGINT, SIGHUP) are passed to the command, and this process exits with
 * its exit code -- or 128 + the signal's number when a signal ended it -- so the bot still shuts down cleanly.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { redactUrls } from "./redact.js";

type Env = Record<string, string | undefined>;

/** The URLs to redact for `env`: BOT_RPC_URL, and the rpcUrl of ARENA_HOME's config.json when there is one. */
export function botRpcUrls(env: Env): string[] {
  const urls = [env.BOT_RPC_URL ?? ""];
  if (env.ARENA_HOME !== undefined && env.ARENA_HOME !== "") {
    try {
      const cfg = JSON.parse(readFileSync(join(env.ARENA_HOME, "config.json"), "utf8")) as { rpcUrl?: unknown };
      if (typeof cfg.rpcUrl === "string") urls.push(cfg.rpcUrl);
    } catch {
      // no config yet (a first start), or one this cannot read: BOT_RPC_URL alone
    }
  }
  return urls.filter((u) => u !== "");
}

/** Copies `from` to `to` a line at a time, each line through `redact`; the last partial line once `from` ends. */
function pipeRedacted(from: NodeJS.ReadableStream, to: NodeJS.WritableStream, redact: (s: string) => string): Promise<void> {
  return new Promise((resolve) => {
    let pending = "";
    from.setEncoding("utf8");
    from.on("data", (chunk: string) => {
      pending += chunk;
      const end = pending.lastIndexOf("\n");
      if (end < 0) return;
      to.write(redact(pending.slice(0, end + 1)));
      pending = pending.slice(end + 1);
    });
    from.on("end", () => {
      if (pending !== "") to.write(redact(pending));
      resolve();
    });
  });
}

export async function botRun(argv: string[], env: Env): Promise<number> {
  if (argv.length === 0) {
    process.stderr.write("bot-run: usage: bot-run <command> [args...]\n");
    return 2;
  }
  const urls = botRpcUrls(env);
  const redact = (s: string) => redactUrls(s, urls);
  const child = spawn(argv[0]!, argv.slice(1), { stdio: ["inherit", "pipe", "pipe"], env: env as NodeJS.ProcessEnv });
  const forward = (sig: NodeJS.Signals) => () => void child.kill(sig);
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, forward(sig));
  const piped = Promise.all([pipeRedacted(child.stdout!, process.stdout, redact), pipeRedacted(child.stderr!, process.stderr, redact)]);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; failed?: true }>((resolve) => {
    child.once("error", (err) => {
      process.stderr.write(`bot-run: cannot run ${argv[0]}: ${redact(err.message)}\n`);
      resolve({ code: 127, signal: null, failed: true });
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  // A command that never started has no output to wait for.
  if (exit.failed !== true) await piped;
  if (exit.code !== null) return exit.code;
  return 128 + (exit.signal !== null ? (constants.signals[exit.signal] ?? 0) : 0);
}
