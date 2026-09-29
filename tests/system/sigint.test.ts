/**
 * Regression test for a CRITICAL fix-round finding: Node's default disposition for a signal that reaches a
 * process with no listener registered for it is to terminate immediately, without ever emitting 'exit' -- so
 * the harness's original `process.on("exit", ...)` backstop alone never ran on a plain SIGINT/SIGTERM, and every
 * detached Anvil/server/daemon child (each its own process group, by design, so `stop()`/`kill()`/`restart()`
 * can target one independently) was left orphaned.
 *
 * Verified two ways before writing this test:
 *  - A plain `node script.mts` with only a `process.on("exit", ...)` handler, sent a raw SIGINT to its own pid:
 *    the process died immediately, the handler never ran, and a detached child it had spawned was orphaned
 *    (reparented to pid 1, still listening on its port).
 *  - Routing the script through the `tsx` *CLI* (`node_modules/.bin/tsx script.ts`) does **not** reproduce this:
 *    tsx's CLI is itself a supervisor process that forks a worker to actually run the script, and shutting the
 *    supervisor down ends up gracefully signaling the worker in a way that *does* trigger the worker's 'exit'
 *    handler -- masking the exact bug under test. So this test avoids the `tsx` CLI and instead runs the worker
 *    script directly under plain `node`, using tsx's `register()` API (the same pattern
 *    `packages/cli/bin/arena.mjs` uses) so there is exactly one process: the one whose signal handling is
 *    actually being tested.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPortFree } from "./harness.js";

const HARNESS_PATH = join(import.meta.dirname, "harness.ts");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let child: ChildProcess | undefined;
let scriptDir: string | undefined;
afterEach(async () => {
  if (child && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(child.pid, "SIGKILL"); // not spawned detached here: a plain single-process kill
    } catch {
      // already gone
    }
  }
  child = undefined;
  if (scriptDir) {
    rmSync(scriptDir, { recursive: true, force: true });
    scriptDir = undefined;
  }
}, 20_000);

/** Reads lines from `target`'s stdout until `predicate` matches a parsed JSON line, racing against early exit. */
async function waitForJsonLine(target: ChildProcess, predicate: (o: Record<string, unknown>) => boolean, ms: number): Promise<Record<string, unknown>> {
  let buf = "";
  const found = new Promise<Record<string, unknown>>((resolvePromise, reject) => {
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (predicate(parsed)) {
            target.stdout?.removeListener("data", onData);
            resolvePromise(parsed);
            return;
          }
        } catch {
          // not JSON (or not the line we want): ignore
        }
      }
    };
    target.stdout?.on("data", onData);
    target.once("exit", (code, signal) => reject(new Error(`process exited before the expected line (code=${code} signal=${signal})`)));
  });
  return Promise.race([
    found,
    sleep(ms).then(() => {
      throw new Error(`timed out after ${ms}ms waiting for a matching JSON line on stdout`);
    }),
  ]);
}

describe("harness SIGINT/SIGTERM backstop", () => {
  it(
    "a raw SIGINT to the single process running startStack() still tears down Anvil",
    async () => {
      // Placed under tests/system (not a bare /tmp dir) so this script's bare `import "tsx/esm/api"` resolves
      // against the workspace's own node_modules, the same way any file in this package would.
      scriptDir = mkdtempSync(join(import.meta.dirname, ".tmp-sigint-"));
      const script = join(scriptDir, "run.mjs");
      writeFileSync(
        script,
        [
          `import { register } from "tsx/esm/api";`,
          `register();`,
          `const { startStack } = await import(${JSON.stringify(HARNESS_PATH)});`,
          `const stack = await startStack();`,
          `console.log(JSON.stringify({ ready: true, anvilPort: Number(new URL(stack.rpcUrl).port) }));`,
          `await new Promise(() => {});`, // keep running until signaled
        ].join("\n"),
      );

      // Deliberately NOT detached: this is one plain Node process, exactly the scenario under test (a raw
      // SIGINT delivered straight to it, no process group involved).
      child = spawn("node", [script], { stdio: ["ignore", "pipe", "inherit"] });
      const ready = await waitForJsonLine(child, (o) => o.ready === true, 30_000);
      const anvilPort = ready.anvilPort as number;
      expect(await isPortFree(anvilPort)).toBe(false); // Anvil is really up, in its own (detached) process group

      const pid = child.pid;
      expect(pid).toBeDefined();
      const exited = new Promise<void>((resolvePromise) => child!.once("exit", () => resolvePromise()));
      process.kill(pid!, "SIGINT");
      await Promise.race([
        exited,
        sleep(15_000).then(() => {
          throw new Error("script did not exit within 15s of a raw SIGINT -- the signal handler did not run");
        }),
      ]);

      const end = Date.now() + 10_000;
      let free = false;
      while (Date.now() < end && !free) {
        free = await isPortFree(anvilPort);
        if (!free) await sleep(200);
      }
      expect(free).toBe(true); // Anvil (a detached child, its own process group) was torn down by the handler
    },
    70_000,
  );
});
