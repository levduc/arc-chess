/**
 * Plan 5.7 Task 3: brings up XMTP's local-node fixture (tests/system/xmtp-local/docker-compose.yml, a pinned
 * copy of xmtp/xmtp-local-node) and confirms it answers. Task 5's XMTP system tests and dev-up start the same fixture
 * through harness.ts's `startXmtpLocal()`, and so does this test (final fix wave, m-6): every `docker compose` call
 * is then bounded and asynchronous (a wedged Docker daemon cannot block the event loop, so the hook timeouts still
 * fire), the three host ports are distinct, and a killed run is still taken down by the harness's `exit` backstop.
 *
 * Docker hygiene (plan's Global Constraints): a unique compose project name per run, teardown with `down -v` in
 * `afterAll` (which runs even if `beforeAll`/the test throws; `startXmtpLocal` also takes down a failed start
 * itself), and three freshly picked host ports -- this never touches 8545/8080/7070, ~/.arena, or .arena-dev/.
 *
 * When Docker is unavailable (the harness's bounded `dockerUnavailableReason`), the whole suite is `describe.skip`'d
 * with the reason in the suite title, so it is visible in the test report even though `vitest.config.ts`'s
 * `onConsoleLog` filter would otherwise drop a plain console tag -- the same pattern board.test.ts uses for a
 * missing Chrome.
 *
 * Which port actually answers HTTP, verified empirically (2026-10-13) against the running container's own log
 * lines, not assumed from the port numbers' names: node-go logs "serving http" on its container port 5555 (the
 * `XMTP_GRPC_PORT`-mapped port) and "serving grpc" on its container port 5556 (the `XMTP_API_PORT`-mapped port)
 * -- i.e. the port named "grpc" is the one a plain HTTP GET actually gets a response from, and the port named
 * "api" never answers HTTP at all. The env var names are kept exactly as specified (they're just upstream's own
 * 5555/5556 numbers).
 *
 * Readiness is a real HTTP response on `ports.grpc` and nothing else (`startXmtpLocal` polls it for up to 120 s):
 * Docker's userland proxy accepts a TCP handshake on a published host port the instant `up -d` returns, before
 * node-go has bound anything inside the container, so a TCP connect is never a readiness signal.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerUnavailableReason, startXmtpLocal, type XmtpLocal } from "./harness.js";

const skipReason = dockerUnavailableReason();
if (skipReason) console.log(`[xmtp-local] skipped: ${skipReason}`);
const suite = skipReason ? describe.skip : describe;

suite(skipReason ? `XMTP local-node fixture (SKIPPED: ${skipReason})` : "XMTP local-node fixture", () => {
  let fixture: XmtpLocal | undefined;

  beforeAll(async () => {
    // A cold pull of all five images can take minutes (bounded by `upTimeoutMs`); the 120 s readiness budget the
    // brief holds the fixture to starts after `up -d` returns.
    fixture = await startXmtpLocal({ project: `arena-xmtp-${process.pid}-${Date.now()}`, readyTimeoutMs: 120_000 });
  }, 780_000);

  afterAll(async () => {
    // Unconditional, bounded teardown (`down -v` of this project only). Never prune, never touch anything else.
    const err = await fixture?.stop();
    if (err) throw new Error(err);
  }, 150_000);

  it("answers HTTP on the port node-go actually serves it on, within 120s of up", async () => {
    const f = fixture as XmtpLocal;
    expect(f.timings.readyMs).toBeLessThanOrEqual(120_000);
    expect(new Set([f.ports.grpc, f.ports.api, f.ports.history]).size).toBe(3);
    // Asked again here: an actual HTTP response (even a 404) means node-go itself answered, not just the proxy.
    const res = await fetch(`http://127.0.0.1:${f.ports.grpc}/`, { signal: AbortSignal.timeout(5_000) });
    await res.body?.cancel().catch(() => undefined);
    expect(res.status).toBeGreaterThanOrEqual(100);
    expect(f.apiUrl).toBe(`http://127.0.0.1:${f.ports.api}`);
  }, 30_000);
});
