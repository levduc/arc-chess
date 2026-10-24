/**
 * Plan 6 hardening H3 (rate-limit resilience): Arc's public RPC answers a modest load with `-32005 "rate limit
 * exceeded"` or an HTTP 429 (Arc testnet rehearsal §8.2). The daemon must ride that out without mistaking it for
 * anything else -- above all, never for a refused range (spec §12 item 18): a skip on a rate limit would hide a
 * dispute event.
 */
import { createPublicClient, type Hex, type PublicClient } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { HubClient, ZERO_HASH, rpcTransport } from "@arena/sdk";
import type { ArenaDaemon } from "../src/index.js";
import { UNREADABLE_BLOCK_PASSES } from "../src/daemon.js";
import { RPC } from "../../sdk/test/helpers/chain.js";
import { startPair, waitFor } from "./helpers/harness.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function matched() {
  const pair = await startPair();
  cleanup = pair.cleanup;
  const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
  await pair.bob.daemon.acceptOffer(offerId);
  const id = await waitFor(async () => {
    const [a, b] = [pair.alice.daemon.channelIds(), pair.bob.daemon.channelIds()];
    return a.length === 1 && b.length === 1 && a[0] === b[0] ? a[0] : null;
  }, 20_000, "match");
  await waitFor(async () => (await pair.alice.daemon.hub.channelInfo(id)).phase === "Open", 20_000, "funding");
  return { ...pair, id };
}

/** Stops the daemon's periodic passes, so a test drives every scan itself. */
async function parked(daemon: ArenaDaemon) {
  clearInterval((daemon as unknown as { timer?: NodeJS.Timeout }).timer);
  await daemon.idle();
}

/**
 * Routes `daemon`'s dispute-event reads through viem's real HTTP transport (`rpcTransport`, retries shortened) over a
 * fake fetch in front of Anvil. While `limited`, every `eth_getLogs` for channel `id`'s events is answered `answer`.
 * The scan's probe -- the same query for the zero channel id -- is always served, as an intermittently rate-limited
 * RPC may serve it.
 */
function rateLimitScan(daemon: ArenaDaemon, hub: Hex, id: Hex, answer: "-32005" | "429") {
  const state = { limited: true, reads: [] as Array<[bigint, bigint]>, probes: 0 };
  const fetchFn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: Array<{ fromBlock: Hex; toBlock: Hex; topics?: unknown[] }> };
    if (req.method === "eth_getLogs") {
      const f = req.params[0];
      const topic1 = String(f.topics?.[1] ?? "").toLowerCase();
      if (topic1 === ZERO_HASH) state.probes++;
      else if (topic1 === id.toLowerCase()) {
        state.reads.push([BigInt(f.fromBlock), BigInt(f.toBlock)]);
        if (state.limited) {
          if (answer === "429") return new Response("Too Many Requests", { status: 429 });
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32005, message: "rate limit exceeded" } }), {
            headers: { "content-type": "application/json" },
          });
        }
      }
    }
    return fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: init?.body });
  };
  const client = createPublicClient({ transport: rpcTransport(RPC, { fetchFn, retryDelay: 1 }) }) as PublicClient;
  const fake = new HubClient(hub, client);
  daemon.hub.disputeEvents = fake.disputeEvents.bind(fake);
  return state;
}

describe("H3: a rate-limited dispute scan never splits a range nor skips a block", () => {
  for (const answer of ["-32005", "429"] as const) {
    it(`${answer}: the same range is read again on the next pass, uncounted and unprobed; then it is read`, async () => {
      const { alice, env, id } = await matched();
      await parked(alice.daemon);
      const l = alice.daemon.handle(id);
      const state = rateLimitScan(alice.daemon, env.hub, id, answer);
      const scan = () => (alice.daemon as unknown as { scanDisputes(l: unknown): Promise<void> }).scanDisputes(l);
      const before = l.record.scannedBlock;
      const head = await alice.daemon.hub.blockNumber();
      for (let i = 0; i <= UNREADABLE_BLOCK_PASSES; i++) await scan();
      // Before H3 each pass probed the range, split it down to one block and counted it: skipped at the third pass.
      expect(l.record.skippedEventBlocks).toBeUndefined();
      expect(l.unreadableBlock).toBeNull();
      expect(state.probes).toBe(0);
      expect(state.reads.length).toBeGreaterThan(0);
      expect(state.reads.every(([, to]) => to >= head)).toBe(true); // never a lower half
      expect(new Set(state.reads.map(([from]) => from)).size).toBe(1); // never an upper half
      expect(l.record.scannedBlock).toBe(before);
      expect(l.lastError).toMatch(answer === "429" ? /^events: HTTP request failed/ : /^events: Request exceeds defined limit/);
      state.limited = false;
      await scan();
      expect(l.lastError).toBeNull();
      expect(l.record.scannedBlock).toBeGreaterThanOrEqual(head);
      expect(l.record.skippedEventBlocks).toBeUndefined();
    });
  }
});
