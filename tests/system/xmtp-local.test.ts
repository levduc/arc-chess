/**
 * Plan 5.7 Task 3: brings up XMTP's local-node fixture (tests/system/xmtp-local/docker-compose.yml, a pinned
 * copy of xmtp/xmtp-local-node) and confirms it answers. This is the only test that drives the fixture directly;
 * Task 5's own XMTP system tests start it through harness.ts's `startXmtpLocal()`, a thin wrapper around the same
 * compose file.
 *
 * Docker hygiene (plan's Global Constraints): a unique compose project name per run, teardown with `down -v` in
 * `afterAll` so it always runs even if `beforeAll`/the test throws, and three freshly picked host ports -- this
 * never touches 8545/8080/7070, ~/.arena, or .arena-dev/.
 *
 * When `docker info` fails (no Docker, daemon not running), the whole suite is `describe.skip`'d with the reason
 * in the suite title, so it is visible in the test report even though `vitest.config.ts`'s `onConsoleLog` filter
 * (unrelated to this task) would otherwise drop a plain console tag -- the same pattern board.test.ts uses for a
 * missing Chrome.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freeTcpPort } from "./harness.js";

const COMPOSE_FILE = join(import.meta.dirname, "xmtp-local/docker-compose.yml");

/** Returns a human reason when the fixture can't be run here, else null. Checked once at module load, the same
 *  way board.test.ts checks for a missing Chrome -- a synchronous, cheap probe, not a flaky async race. */
function dockerUnavailableReason(): string | null {
  const info = spawnSync("docker", ["info"], { stdio: "ignore" });
  if (info.error) return `docker is not available (${String(info.error.message)})`;
  if (info.status !== 0) return "`docker info` failed (is the Docker daemon running?)";
  const compose = spawnSync("docker", ["compose", "version"], { stdio: "ignore" });
  if (compose.error || compose.status !== 0) return "the `docker compose` plugin is not available";
  return null;
}

const skipReason = dockerUnavailableReason();
if (skipReason) console.log(`[xmtp-local] skipped: ${skipReason}`);
const suite = skipReason ? describe.skip : describe;

suite(skipReason ? `XMTP local-node fixture (SKIPPED: ${skipReason})` : "XMTP local-node fixture", () => {
  // Unique per run (plan's Docker hygiene rule), computed once so beforeAll/afterAll/the test all agree on it.
  const projectName = `arena-xmtp-${process.pid}-${Date.now()}`;
  let ports: { grpc: number; api: number; history: number };

  function compose(args: string[]): SpawnSyncReturns<string> {
    return spawnSync("docker", ["compose", "-p", projectName, "-f", COMPOSE_FILE, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        XMTP_GRPC_PORT: String(ports.grpc),
        XMTP_API_PORT: String(ports.api),
        XMTP_HISTORY_PORT: String(ports.history),
      },
    });
  }

  beforeAll(async () => {
    ports = { grpc: await freeTcpPort(), api: await freeTcpPort(), history: await freeTcpPort() };
    // A cold pull of all five images can take minutes; keep it out of the 120s reachability budget the test
    // itself is held to (the brief's clock covers readiness after `up -d`, not the pull).
    const pull = compose(["pull", "--quiet"]);
    if (pull.status !== 0) throw new Error(`docker compose pull failed (exit ${String(pull.status)}):\n${pull.stderr}`);
    const up = compose(["up", "-d"]);
    if (up.status !== 0) throw new Error(`docker compose up failed (exit ${String(up.status)}):\n${up.stderr}`);
  }, 600_000);

  afterAll(() => {
    // Unconditional teardown: runs even when beforeAll or the test threw partway through. Never prune, never
    // touch anything outside this project's own containers/volumes (Global Constraints).
    compose(["down", "-v"]);
  }, 120_000);

  it(
    "answers on the API port, or accepts a TCP connection on the gRPC port, within 120s",
    async () => {
      const deadline = Date.now() + 120_000;
      let reachable = false;
      let lastHttpErr: unknown;
      while (Date.now() < deadline && !reachable) {
        try {
          const res = await fetch(`http://127.0.0.1:${ports.api}/`, { signal: AbortSignal.timeout(2_000) });
          await res.body?.cancel().catch(() => undefined);
          reachable = true; // node-go's grpc-gateway answering at all (even a 404) means it's up.
        } catch (err) {
          lastHttpErr = err;
        }
        if (!reachable) reachable = await tcpConnects(ports.grpc, 2_000);
        if (!reachable) await sleep(1_000);
      }
      expect(reachable, `fixture never became reachable within 120s (last HTTP error: ${String(lastHttpErr)})`).toBe(true);
    },
    150_000,
  );
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tcpConnects(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
