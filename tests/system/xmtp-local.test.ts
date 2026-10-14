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
 *
 * Which port actually answers HTTP, verified empirically (2026-10-13) against the running container's own log
 * lines, not assumed from the port numbers' names: node-go logs "serving http" on its container port 5555 (the
 * `XMTP_GRPC_PORT`-mapped port) and "serving grpc" on its container port 5556 (the `XMTP_API_PORT`-mapped port)
 * -- i.e. the port named "grpc" is the one a plain HTTP GET actually gets a response from, and the port named
 * "api" never answers HTTP at all (confirmed over 40s of polling: consistently no response). The env var names
 * are kept exactly as specified (they're just upstream's own 5555/5556 numbers); this test checks HTTP against
 * `ports.grpc` and falls back to a raw TCP connect against `ports.api` accordingly, so the HTTP check is a real
 * readiness signal rather than one that can never succeed. A bare TCP connect-success is a weak signal on its
 * own here -- Docker's userland proxy accepts the TCP handshake on a published port immediately on `up -d`,
 * before the containerized process has bound anything -- which is exactly why the HTTP check (a real response,
 * not just a completed handshake) is tried first and given the whole 120s budget before falling back to it.
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
    "answers HTTP on the port node-go actually serves it on, or accepts a TCP connection on the gRPC port, within 120s",
    async () => {
      const deadline = Date.now() + 120_000;
      let reachable = false;
      let lastHttpErr: unknown;
      while (Date.now() < deadline && !reachable) {
        try {
          // See the suite-level comment: node-go's real HTTP response is on the `grpc`-named port.
          const res = await fetch(`http://127.0.0.1:${ports.grpc}/`, { signal: AbortSignal.timeout(2_000) });
          await res.body?.cancel().catch(() => undefined);
          reachable = true; // an actual HTTP response (even a 404) means node-go itself answered, not just the proxy.
        } catch (err) {
          lastHttpErr = err;
        }
        // Weak fallback only: a successful TCP connect on the grpc-only port can be Docker's userland proxy
        // accepting the handshake before node-go has bound anything (see suite comment) -- it's checked only
        // because the HTTP probe above already has the whole 120s budget to find the real signal first.
        if (!reachable) reachable = await tcpConnects(ports.api, 2_000);
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
