import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  HubClient,
  INITIAL_META,
  LocalKeyTxSender,
  STATUS,
  channelId,
  fenOf,
  initialState,
  isGameOver,
  mover,
  rpcTransport,
  statusOf,
  withStatus,
} from "@arena/sdk";
import type { HubEvent, Params, State } from "@arena/sdk";
import { watchHtml } from "../src/docs.js";
import { RpcChainReader } from "../src/chain.js";
import { INDEXER_UNREADABLE_POLLS, Indexer, playerStats } from "../src/indexer.js";
import { Relay } from "../src/relay.js";
import { SqliteRepo, type ChannelRow, type Repo } from "../src/repo.js";
import { startServer, type ArenaServer, type Metrics } from "../src/server.js";
import { FakeChain, testConfig } from "./helpers/fakeChain.js";
import { makeChannelFixture, rawStateAt } from "./helpers/channel.js";
import { ANVIL_KEYS, CHAIN, RPC, deployArena, mintUsdc } from "../../../packages/sdk/test/helpers/chain.js";

const noopLog = () => {};

let server: ArenaServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("Indexer.poll and Indexer.apply", () => {
  it("builds channel rows from events and advances the cursor in chunks", async () => {
    const cfg = testConfig({ indexer: { pollMs: 0, chunkBlocks: 10, startBlock: 0n } });
    const repo = new SqliteRepo(":memory:");
    const chain = new FakeChain();
    const fx = makeChannelFixture(cfg);

    const created: HubEvent = {
      blockNumber: 5n, logIndex: 0, channelId: fx.id, kind: "ChannelCreated", params: fx.params,
    };
    const dep0: HubEvent = {
      blockNumber: 6n, logIndex: 0, channelId: fx.id, kind: "Deposited", player: 0, amount: fx.params.deposit,
    };
    const dep1: HubEvent = {
      blockNumber: 7n, logIndex: 0, channelId: fx.id, kind: "Deposited", player: 1, amount: fx.params.deposit,
    };
    const opened: HubEvent = { blockNumber: 7n, logIndex: 1, channelId: fx.id, kind: "Opened" };
    const finalized: HubEvent = {
      blockNumber: 30n,
      logIndex: 0,
      channelId: fx.id,
      kind: "Finalized",
      balanceA: 900_000n,
      balanceB: 1_100_000n,
      fee: 10_000n,
    };
    chain.events = [created, dep0, dep1, opened, finalized];
    chain.block = 35n;

    const indexer = new Indexer(repo, chain, cfg, noopLog);
    await indexer.poll();

    const row = repo.channelRow(fx.id);
    expect(row?.phase).toBe("Finalized");
    expect(row?.balances).toEqual([900_000n, 1_100_000n]);
    expect(repo.cursor()).toBe(35n);
    repo.close();
  });

  it("keeps the cursor before a failing chunk and retries next poll", async () => {
    const cfg = testConfig({ indexer: { pollMs: 0, chunkBlocks: 10, startBlock: 0n } });
    const repo = new SqliteRepo(":memory:");
    const chain = new FakeChain();
    chain.block = 25n;
    // H3: "rpc down" is no refusal of the range, so the poll stops at once, with no probe of the range's other events
    // and no split (H1's split is for a refusal only, below).
    let failures = 1;
    const realHubEvents = chain.hubEvents.bind(chain);
    chain.hubEvents = async (from: bigint, to: bigint) => {
      if (from === 10n && failures > 0) {
        failures--;
        throw new Error("rpc down");
      }
      return realHubEvents(from, to);
    };
    const logs: string[] = [];
    const indexer = new Indexer(repo, chain, cfg, (l) => logs.push(l));

    await indexer.poll();
    expect(repo.cursor()).toBe(9n); // chunk [0,9] committed; chunk [10,19] failed and was not committed
    expect(logs.some((l) => l.includes("indexer:") && l.includes("rpc down"))).toBe(true);

    await indexer.poll(); // retries chunk [10,19] (now succeeds), then [20,25]
    expect(repo.cursor()).toBe(25n);
    repo.close();
  });

  it("re-reads the trailing 32 blocks: an event a lagging RPC hid is found on the next poll, once (M4)", async () => {
    const cfg = testConfig({ indexer: { pollMs: 0, chunkBlocks: 10, startBlock: 0n } });
    const repo = new SqliteRepo(":memory:");
    const chain = new FakeChain();
    const fx = makeChannelFixture(cfg);
    const created: HubEvent = { blockNumber: 95n, logIndex: 0, channelId: fx.id, kind: "ChannelCreated", params: fx.params };
    const challenged: HubEvent = {
      blockNumber: 96n, logIndex: 0, channelId: fx.id, kind: "Challenged", challenger: 0, turnNum: 1n, deadline: 1_000n,
      signed: { state: rawStateAt(fx, 1n), sigA: "0x", sigB: "0x" },
    };
    chain.events = [created, challenged];
    chain.block = 100n;
    let hide = true;
    const real = chain.hubEvents.bind(chain);
    chain.hubEvents = async (from: bigint, to: bigint) => (await real(from, to)).filter((e) => !(hide && e.blockNumber >= 95n));
    const indexer = new Indexer(repo, chain, cfg, noopLog);

    await indexer.poll();
    expect(repo.cursor()).toBe(100n);
    expect(repo.channelRow(fx.id)).toBe(null); // missed: the RPC's log index lagged its reported head

    hide = false;
    chain.block = 101n;
    await indexer.poll();
    expect(repo.cursor()).toBe(101n); // the rescan never moved the cursor back
    expect(repo.channelRow(fx.id)?.challenges).toEqual([1, 0]);

    chain.block = 102n;
    await indexer.poll(); // the same blocks are re-read again: nothing is applied twice
    expect(repo.channelRow(fx.id)?.challenges).toEqual([1, 0]);
    repo.close();
  });

  describe("Plan 4.5 Task 10: reorgs inside the rescan window", () => {
    const h = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
    function reorgFixture() {
      const cfg = testConfig({ indexer: { pollMs: 0, chunkBlocks: 10, startBlock: 0n } });
      const repo = new SqliteRepo(":memory:");
      const chain = new FakeChain();
      const fx = makeChannelFixture(cfg);
      const at = (block: bigint, hash: Hex, logIndex = 0) => ({ blockNumber: block, logIndex, channelId: fx.id, blockHash: hash });
      for (const b of [90n, 91n, 92n, 96n]) chain.hashes.set(b, h(Number(b)));
      const created: HubEvent = { ...at(90n, h(90)), kind: "ChannelCreated", params: fx.params };
      const dep0: HubEvent = { ...at(91n, h(91)), kind: "Deposited", player: 0, amount: fx.params.deposit };
      const dep1: HubEvent = { ...at(92n, h(92)), kind: "Deposited", player: 1, amount: fx.params.deposit };
      const opened: HubEvent = { ...at(92n, h(92), 1), kind: "Opened" };
      const challenge = (block: bigint, hash: Hex): HubEvent => ({
        ...at(block, hash), kind: "Challenged", challenger: 0, turnNum: 1n, deadline: 1_000n,
        signed: { state: rawStateAt(fx, 1n), sigA: "0x", sigB: "0x" },
      });
      chain.events = [created, dep0, dep1, opened, challenge(96n, h(96))];
      chain.block = 100n;
      return { cfg, repo, chain, fx, challenge, indexer: new Indexer(repo, chain, cfg, noopLog) };
    }

    it("a Challenged event reorged out rolls the row back to Open; re-included a block later it counts once", async () => {
      const { repo, chain, fx, challenge, indexer } = reorgFixture();
      await indexer.poll();
      expect(repo.channelRow(fx.id)?.phase).toBe("Challenged");
      expect(repo.channelRow(fx.id)?.challenges).toEqual([1, 0]);

      // Reorged out: block 96 replaced by an empty one.
      chain.events = chain.events.filter((e) => e.kind !== "Challenged");
      chain.hashes.set(96n, h(0x96_01));
      await indexer.poll();
      expect(repo.channelRow(fx.id)?.phase).toBe("Open");
      expect(repo.channelRow(fx.id)?.challenges).toEqual([0, 0]);
      expect(repo.channelRow(fx.id)?.registered).toBe(null);

      // Re-included: the same transaction mined at block 101. Before the fix this read Challenged with [2, 0].
      chain.hashes.set(101n, h(101));
      chain.events = [...chain.events, challenge(101n, h(101))];
      chain.block = 101n;
      await indexer.poll();
      expect(repo.channelRow(fx.id)?.phase).toBe("Challenged");
      expect(repo.channelRow(fx.id)?.challenges).toEqual([1, 0]);
      await indexer.poll(); // re-read again: still counted once
      expect(repo.channelRow(fx.id)?.challenges).toEqual([1, 0]);
      repo.close();
    });

    it("an event a lagging log index stops returning is not unwound while its block is still canonical", async () => {
      const { repo, chain, fx, indexer } = reorgFixture();
      await indexer.poll();
      const all = chain.events;
      chain.events = all.filter((e) => e.kind !== "Challenged"); // block 96 unchanged: only the log index lags
      await indexer.poll();
      expect(repo.channelRow(fx.id)?.phase).toBe("Challenged");
      chain.events = all;
      await indexer.poll();
      expect(repo.channelRow(fx.id)?.challenges).toEqual([1, 0]);
      repo.close();
    });

    it("a reorg that drops the channel's creation deletes the row; beyond the window nothing is unwound", async () => {
      const { repo, chain, fx, indexer } = reorgFixture();
      await indexer.poll();
      chain.events = [];
      for (const b of [90n, 91n, 92n, 96n]) chain.hashes.set(b, h(Number(b) + 0x1000));
      await indexer.poll();
      expect(repo.channelRow(fx.id)).toBe(null);
      expect(repo.reorgWatch()).toEqual([]);

      // A second life, then the window moves 40 blocks on: its entries are final and pruned.
      const again = reorgFixture();
      await again.indexer.poll();
      again.chain.block = 140n;
      await again.indexer.poll(); // the cursor moves to 140
      await again.indexer.poll(); // this poll's window starts at 109: every entry is behind it
      expect(again.repo.channelRow(again.fx.id)?.undo).toEqual([]);
      expect(again.repo.reorgWatch()).toEqual([]);
      again.chain.events = [];
      again.chain.block = 141n;
      await again.indexer.poll();
      expect(again.repo.channelRow(again.fx.id)?.phase).toBe("Challenged"); // older than the window: final
      repo.close();
      again.repo.close();
    });
  });

  it("counts challenges, answers and a timeout loss", () => {
    const cfg = testConfig();
    const repo = new SqliteRepo(":memory:");
    const chain = new FakeChain();
    const fx = makeChannelFixture(cfg);
    const indexer = new Indexer(repo, chain, cfg, noopLog);

    indexer.apply({ blockNumber: 1n, logIndex: 0, channelId: fx.id, kind: "ChannelCreated", params: fx.params });
    indexer.apply({ blockNumber: 2n, logIndex: 0, channelId: fx.id, kind: "Opened" });

    // player 1 is on move in this registered state (gameIndex odd, side unchanged from initial = WHITE)
    const stateA: State = { ...rawStateAt(fx, 1n), gameIndex: 1 };
    expect(mover(stateA)).toBe(1);
    const challenge1: HubEvent = {
      blockNumber: 3n,
      logIndex: 0,
      channelId: fx.id,
      kind: "Challenged",
      challenger: 0,
      turnNum: 1n,
      deadline: 1_000n,
      signed: { state: stateA, sigA: "0x", sigB: "0x" },
    };
    indexer.apply(challenge1);

    const stateB: State = { ...rawStateAt(fx, 2n) };
    const responded: HubEvent = {
      blockNumber: 4n,
      logIndex: 0,
      channelId: fx.id,
      kind: "Responded",
      turnNum: 2n,
      signed: { state: stateB, sigA: "0x", sigB: "0x" },
    };
    indexer.apply(responded);
    // re-applying an already-folded-in event must be a no-op (idempotency under a re-read chunk)
    indexer.apply(responded);

    // player 0 is on move in this registered state (gameIndex even, side WHITE)
    const stateC: State = { ...rawStateAt(fx, 3n), gameIndex: 2 };
    expect(mover(stateC)).toBe(0);
    const challenge2: HubEvent = {
      blockNumber: 5n,
      logIndex: 0,
      channelId: fx.id,
      kind: "Challenged",
      challenger: 1,
      turnNum: 3n,
      deadline: 2_000n,
      signed: { state: stateC, sigA: "0x", sigB: "0x" },
    };
    indexer.apply(challenge2);

    const finalized: HubEvent = {
      blockNumber: 6n,
      logIndex: 0,
      channelId: fx.id,
      kind: "Finalized",
      balanceA: 1_050_000n,
      balanceB: 950_000n,
      fee: 10_000n,
    };
    indexer.apply(finalized);
    indexer.apply(finalized); // idempotent re-apply

    const row = repo.channelRow(fx.id)!;
    expect(row.challenges).toEqual([1, 1]);
    // Only one Responded event occurred, crediting the non-challenger (player 1) of the first challenge.
    expect(row.answered).toEqual([0, 1]);
    expect(row.timeoutLoser).toBe(0); // challenge2's registered state (player 0 on move) was never answered
    expect(row.phase).toBe("Finalized");
    repo.close();
  });

  it("a Finalized after a Challenged on a finished game is not a timeout loss", () => {
    const cfg = testConfig();
    const repo = new SqliteRepo(":memory:");
    const chain = new FakeChain();
    const fx = makeChannelFixture(cfg);
    const indexer = new Indexer(repo, chain, cfg, noopLog);

    indexer.apply({ blockNumber: 1n, logIndex: 0, channelId: fx.id, kind: "ChannelCreated", params: fx.params });
    indexer.apply({ blockNumber: 2n, logIndex: 0, channelId: fx.id, kind: "Opened" });

    const finishedState: State = { ...rawStateAt(fx, 4n), meta: withStatus(INITIAL_META, STATUS.WHITE_WON) };
    expect(isGameOver(finishedState)).toBe(true);
    indexer.apply({
      blockNumber: 3n,
      logIndex: 0,
      channelId: fx.id,
      kind: "Challenged",
      challenger: 1,
      turnNum: 4n,
      deadline: 1_000n,
      signed: { state: finishedState, sigA: "0x", sigB: "0x" },
    });
    indexer.apply({
      blockNumber: 4n, logIndex: 0, channelId: fx.id, kind: "Finalized", balanceA: 1n, balanceB: 1n, fee: 0n,
    });

    const row = repo.channelRow(fx.id)!;
    expect(row.timeoutLoser).toBe(null);
    expect(row.phase).toBe("Finalized");
    repo.close();
  });

  it("ChannelCreated for an existing row is a no-op; an event for an unknown channel is ignored", () => {
    const cfg = testConfig();
    const repo = new SqliteRepo(":memory:");
    const chain = new FakeChain();
    const fx = makeChannelFixture(cfg);
    const indexer = new Indexer(repo, chain, cfg, noopLog);

    indexer.apply({ blockNumber: 1n, logIndex: 0, channelId: fx.id, kind: "ChannelCreated", params: fx.params });
    indexer.apply({ blockNumber: 1n, logIndex: 1, channelId: fx.id, kind: "Opened" });
    indexer.apply({ blockNumber: 2n, logIndex: 0, channelId: fx.id, kind: "ChannelCreated", params: fx.params });
    expect(repo.channelRow(fx.id)?.phase).toBe("Open"); // the second ChannelCreated did not reset it to Funding

    const unknown = ("0x" + "ee".repeat(32)) as Hex;
    indexer.apply({ blockNumber: 1n, logIndex: 0, channelId: unknown, kind: "Opened" });
    expect(repo.channelRow(unknown)).toBe(null);
    repo.close();
  });

  it("logs a warning when the persisted cursor is ahead of the chain head (fix-round item 2)", async () => {
    // The scenario that motivated this: a database's indexer cursor survives a chain reset (e.g. a local Anvil
    // restarted from block 0 for a fresh deployment) and ends up recorded at a block number the new chain has
    // not reached yet. `chunkRanges(from, head, ...)` with `from > head` returns no ranges, so `poll` would
    // otherwise do nothing every tick with no signal that anything is wrong.
    const cfg = testConfig({ indexer: { pollMs: 0, chunkBlocks: 10, startBlock: 0n } });
    const repo = new SqliteRepo(":memory:");
    repo.setCursor(500n);
    const chain = new FakeChain();
    chain.block = 10n; // head is far behind the persisted cursor
    const logs: string[] = [];
    const indexer = new Indexer(repo, chain, cfg, (l) => logs.push(l));

    await indexer.poll();

    expect(logs.some((l) => /cursor/i.test(l) && /500/.test(l) && /10/.test(l))).toBe(true);
    expect(repo.cursor()).toBe(500n); // unchanged: nothing was indexed, and the stale cursor was not disturbed
    repo.close();
  });

  it("does not warn when the cursor is at or behind the chain head", async () => {
    const cfg = testConfig({ indexer: { pollMs: 0, chunkBlocks: 10, startBlock: 0n } });
    const repo = new SqliteRepo(":memory:");
    repo.setCursor(5n);
    const chain = new FakeChain();
    chain.block = 10n;
    const logs: string[] = [];
    const indexer = new Indexer(repo, chain, cfg, (l) => logs.push(l));

    await indexer.poll();

    expect(logs.some((l) => /ahead of the chain head/i.test(l))).toBe(false);
    repo.close();
  });
});

describe("H1 (review m-11): the indexer never wedges on one oversized event", () => {
  /** A channel opened at blocks 5-7, challenged at block 15 with a 100 KB junk signature, and finalized at block 40;
   *  `extra` lands in the challenge's own block. The chain's RPC refuses any response holding that signature for a
   *  range of more than one block -- or, with `alone`, for any range that does not exclude the dispute events. */
  function oversized(opts: { alone: boolean }) {
    const cfg = testConfig({ indexer: { pollMs: 0, chunkBlocks: 10, startBlock: 0n } });
    const repo = new SqliteRepo(":memory:");
    const chain = new FakeChain();
    const fx = makeChannelFixture(cfg);
    const other = makeChannelFixture(cfg);
    const at = (id: Hex, block: bigint, logIndex = 0) => ({ blockNumber: block, logIndex, channelId: id });
    const junk = `0x${"01".repeat(100_000)}` as Hex;
    chain.events = [
      { ...at(fx.id, 5n), kind: "ChannelCreated", params: fx.params },
      { ...at(fx.id, 6n), kind: "Deposited", player: 0, amount: fx.params.deposit },
      { ...at(fx.id, 7n), kind: "Deposited", player: 1, amount: fx.params.deposit },
      { ...at(fx.id, 7n, 1), kind: "Opened" },
      {
        ...at(fx.id, 15n), kind: "Challenged", challenger: 1, turnNum: 1n, deadline: 1_000n,
        signed: { state: rawStateAt(fx, 1n), sigA: junk, sigB: "0x" },
      },
      // Another channel created in the challenge's own block: its row must not be lost with the junk.
      { ...at(other.id, 15n, 1), kind: "ChannelCreated", params: other.params },
      { ...at(fx.id, 40n), kind: "Finalized", balanceA: 900_000n, balanceB: 1_100_000n, fee: 10_000n },
    ] as HubEvent[];
    chain.block = 45n;
    const refused: Array<[bigint, bigint]> = [];
    const realHubEvents = chain.hubEvents.bind(chain);
    chain.hubEvents = async (from: bigint, to: bigint, o?: { kinds?: readonly HubEvent["kind"][] }) => {
      const events = (await realHubEvents(from, to)).filter((e) => o?.kinds === undefined || o.kinds.includes(e.kind));
      const big = events.some((e) => (e.kind === "Challenged" || e.kind === "Responded") && e.signed.sigA.length > 10_000);
      if (big && (opts.alone || to > from)) {
        refused.push([from, to]);
        throw new Error("query returned more than the maximum response size");
      }
      return events;
    };
    const logs: string[] = [];
    return { cfg, repo, chain, fx, other, refused, logs, indexer: new Indexer(repo, chain, cfg, (l) => logs.push(l)) };
  }

  it("a chunk refused for one large event is split; the event is read alone and indexed", async () => {
    const { repo, fx, refused, indexer } = oversized({ alone: false });
    await indexer.poll();
    expect(refused.length).toBeGreaterThan(0); // [10,19] came back too large at first
    expect(repo.channelRow(fx.id)?.challenges).toEqual([0, 1]); // read on its own
    expect(repo.channelRow(fx.id)?.phase).toBe("Finalized");
    expect(repo.cursor()).toBe(45n);
    expect(indexer.skippedBlocks()).toEqual([]);
  });

  it("a block refused even alone has only its dispute events skipped, after INDEXER_UNREADABLE_POLLS polls; the rest is indexed", async () => {
    const { repo, fx, other, logs, indexer } = oversized({ alone: true });
    for (let i = 1; i < INDEXER_UNREADABLE_POLLS; i++) {
      await indexer.poll();
      expect(repo.cursor()).toBe(14n); // [0,14] read; held before block 15
      expect(indexer.skippedBlocks()).toEqual([]);
    }
    // Before H1 the cursor stayed at 9 for good: the creation in block 15 and the settlement at 40 were never seen.
    await indexer.poll();
    expect(indexer.skippedBlocks()).toEqual([15n]);
    expect(logs.some((l) => /skipping the Challenged\/Responded events of block 15/.test(l))).toBe(true);
    expect(repo.channelRow(other.id)).not.toBeNull(); // the block's other events were applied
    expect(repo.channelRow(fx.id)?.challenges).toEqual([0, 0]); // only the dispute event is lost
    expect(repo.channelRow(fx.id)?.phase).toBe("Finalized");
    expect(repo.cursor()).toBe(45n);
  });

  it("final review C m-3: /metrics reports the skipped block, and says a skip is permanent", async () => {
    const { cfg, chain, fx } = oversized({ alone: true });
    server = await startServer(cfg, { chain });
    const skipped = async () => /^arena_indexer_skipped_blocks (\d+)$/m.exec(await (await fetch(`${server!.url}/metrics`)).text())?.[1];
    expect(await skipped()).toBe("0");
    for (let i = 0; i < INDEXER_UNREADABLE_POLLS; i++) await server.indexer.poll();
    expect(server.indexer.skippedBlocks()).toEqual([15n]);
    expect(await skipped()).toBe("1");
    expect(server.repo.channelRow(fx.id)?.challenges).toEqual([0, 0]);
    const text = await (await fetch(`${server.url}/metrics`)).text();
    expect(text).toMatch(/^# HELP arena_indexer_skipped_blocks .*since this process started.*A skip is permanent/m);
  });

  it("an RPC that refuses every read (down) never skips a block, and keeps the cursor", async () => {
    const { repo, chain, indexer } = oversized({ alone: false });
    await indexer.poll();
    const cursor = repo.cursor();
    chain.block = 60n;
    chain.hubEvents = async () => {
      throw new Error("fetch failed");
    };
    for (let i = 0; i < INDEXER_UNREADABLE_POLLS + 2; i++) await indexer.poll();
    expect(indexer.skippedBlocks()).toEqual([]);
    expect(repo.cursor()).toBe(cursor);
  });
});

describe("H3 fix round 1 (review I2): H1's probes, when the RPC refuses the probe too", () => {
  /** A chain whose RPC answers every hub-event read -- the read and the probe of the range's other events alike --
   *  with Arc's refusal, as a node that refuses the range itself (not its content) would. */
  function refusesEverything(chunkBlocks: number) {
    const cfg = testConfig({ indexer: { pollMs: 0, chunkBlocks, startBlock: 0n } });
    const repo = new SqliteRepo(":memory:");
    const chain = new FakeChain();
    chain.block = 45n;
    const reads: Array<{ from: bigint; to: bigint; probe: boolean }> = [];
    chain.hubEvents = async (from: bigint, to: bigint, o?: { kinds?: readonly HubEvent["kind"][] }) => {
      reads.push({ from, to, probe: o?.kinds !== undefined });
      throw Object.assign(new Error("requested range too large"), { code: -32012 });
    };
    const logs: string[] = [];
    return { repo, chain, reads, logs, indexer: new Indexer(repo, chain, cfg, (l) => logs.push(l)) };
  }

  it("a multi-block range: the probe is refused too, so the range is neither split nor counted", async () => {
    const { repo, reads, logs, indexer } = refusesEverything(10);
    for (let i = 0; i <= INDEXER_UNREADABLE_POLLS; i++) await indexer.poll();
    expect(reads.filter((r) => r.probe).length).toBe(INDEXER_UNREADABLE_POLLS + 1); // probed once a poll
    expect(reads.every((r) => r.from === 0n && r.to === 9n)).toBe(true); // never a half
    expect(indexer.skippedBlocks()).toEqual([]);
    expect(repo.cursor()).toBeNull();
    expect(logs.every((l) => /^indexer: .*requested range too large/.test(l))).toBe(true);
    // Final review C m-2: the wedge says what to change.
    expect(logs).toHaveLength(INDEXER_UNREADABLE_POLLS + 1);
    for (const l of logs) {
      expect(l).toMatch(
        /^indexer: the RPC refuses blocks 0-9 even without their dispute events \(requested range too large\): it likely caps getLogs ranges below indexer\.chunkBlocks \(10\); lower indexer\.chunkBlocks/,
      );
    }
    repo.close();
  });

  it("final review C m-2: a probe that is rate-limited, not refused, keeps the plain message (no chunkBlocks hint)", async () => {
    const { repo, chain, logs, indexer } = refusesEverything(10);
    chain.hubEvents = async (_from: bigint, _to: bigint, o?: { kinds?: readonly HubEvent["kind"][] }) => {
      if (o?.kinds !== undefined) throw Object.assign(new Error("rate limit exceeded"), { code: -32005 });
      throw Object.assign(new Error("requested range too large"), { code: -32012 });
    };
    await indexer.poll();
    expect(logs).toEqual(["indexer: requested range too large"]);
    expect(indexer.skippedBlocks()).toEqual([]);
    repo.close();
  });

  it("a single block: the probe of its other events is refused too, so it is never counted toward a skip", async () => {
    const { repo, reads, logs, indexer } = refusesEverything(1);
    for (let i = 0; i <= INDEXER_UNREADABLE_POLLS; i++) await indexer.poll();
    expect(reads.filter((r) => r.probe).length).toBe(INDEXER_UNREADABLE_POLLS + 1);
    expect(reads.every((r) => r.from === 0n && r.to === 0n)).toBe(true);
    expect(indexer.skippedBlocks()).toEqual([]);
    expect(logs.some((l) => /retried next poll|skipping/.test(l))).toBe(false); // never counted
    expect(repo.cursor()).toBeNull();
    repo.close();
  });
});

describe("H3: a rate-limited RPC never splits a range nor skips a block", () => {
  /** A fake RPC behind viem's real HTTP transport: head 45, no events. While `limited`, every full read (the 7 hub
   *  events in one query) is answered `answer`; a single-kind read -- H1's probe of a range's other events -- is
   *  always served, as an intermittently rate-limited RPC may serve it. */
  function rateLimitedChain(answer: "-32005" | "429") {
    const cfg = testConfig({ indexer: { pollMs: 0, chunkBlocks: 10, startBlock: 0n } });
    const state = { limited: true, limitNext: 0 };
    const fullReads: Array<[bigint, bigint]> = [];
    let probes = 0;
    const fetchFn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: Array<{ fromBlock: Hex; toBlock: Hex; topics: unknown[] }> };
      const reply = (body: object) => new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, ...body }), { headers: { "content-type": "application/json" } });
      if (req.method === "eth_blockNumber") return reply({ result: "0x2d" });
      if (req.method !== "eth_getLogs") throw new Error(`unexpected ${req.method}`);
      const f = req.params[0];
      if (!Array.isArray(f.topics[0])) {
        probes++;
        return reply({ result: [] });
      }
      fullReads.push([BigInt(f.fromBlock), BigInt(f.toBlock)]);
      if (!state.limited && state.limitNext === 0) return reply({ result: [] });
      if (state.limitNext > 0) state.limitNext--;
      if (answer === "429") return new Response("Too Many Requests", { status: 429 });
      return reply({ error: { code: -32005, message: "rate limit exceeded" } });
    };
    const client = createPublicClient({ transport: rpcTransport("http://rpc.invalid", { fetchFn, retryDelay: 1 }) }) as PublicClient;
    const chain = new RpcChainReader(cfg, new HubClient(cfg.hub, client));
    const repo = new SqliteRepo(":memory:");
    const logs: string[] = [];
    return { state, fullReads, probes: () => probes, repo, logs, indexer: new Indexer(repo, chain, cfg, (l) => logs.push(l)) };
  }

  for (const answer of ["-32005", "429"] as const) {
    it(`${answer}: retried on the same range, uncounted -- no probe, no split, no skip -- then read once it is served`, async () => {
      const { state, fullReads, probes, repo, logs, indexer } = rateLimitedChain(answer);
      for (let i = 0; i <= INDEXER_UNREADABLE_POLLS; i++) await indexer.poll();
      // Before H3 each poll probed the range, split it down to block 0 and counted it: skipped at the third poll.
      expect(indexer.skippedBlocks()).toEqual([]);
      expect(probes()).toBe(0);
      expect(fullReads.length).toBeGreaterThan(0);
      expect(fullReads.every(([f, t]) => f === 0n && t === 9n)).toBe(true); // the whole first chunk, every time
      expect(repo.cursor()).toBeNull();
      expect(logs.some((l) => l.startsWith("indexer:") && (answer === "429" ? /HTTP request failed/ : /Request exceeds defined limit/).test(l))).toBe(true);
      state.limited = false;
      await indexer.poll();
      expect(repo.cursor()).toBe(45n);
      expect(indexer.skippedBlocks()).toEqual([]);
      repo.close();
    });
  }

  it("the transport itself rides out a short limit: a read refused on its first attempts is served within the poll", async () => {
    const { state, fullReads, repo, logs, indexer } = rateLimitedChain("-32005");
    Object.assign(state, { limited: false, limitNext: 3 });
    await indexer.poll();
    expect(fullReads.slice(0, 4)).toEqual(Array(4).fill([0n, 9n])); // retried by rpcTransport, not by the next poll
    expect(repo.cursor()).toBe(45n);
    expect(logs).toEqual([]);
    repo.close();
  });
});

describe("playerStats", () => {
  it("aggregates across channels, case-insensitively, and counts games from the relay cache", () => {
    const cfg = testConfig();
    const repo = new SqliteRepo(":memory:");
    const metrics: Metrics = { wsConnections: 0, relayMessages: 0, indexerBlock: null, indexerLag: null };
    const relay = new Relay(repo, cfg, metrics, noopLog);
    const X = "0xAbCd000000000000000000000000000000000042" as Address;
    const other = (n: number) => `0x${n.toString().padStart(40, "0")}` as Address;

    function baseRow(id: Hex, participants: readonly [Address, Address]): ChannelRow {
      return {
        channelId: id,
        params: { ...makeChannelFixture(cfg).params, participants },
        phase: "Open",
        createdBlock: 1n,
        challenges: [0, 0],
        answered: [0, 0],
        pendingChallenger: null,
        registered: null,
        timeoutLoser: null,
        balances: null,
      };
    }

    const id1 = ("0x" + "11".repeat(32)) as Hex;
    const row1: ChannelRow = { ...baseRow(id1, [X, other(1)]), phase: "Open", challenges: [2, 0], answered: [1, 0] };
    const id2 = ("0x" + "22".repeat(32)) as Hex;
    const row2: ChannelRow = {
      ...baseRow(id2, [other(2), X]),
      phase: "Finalized",
      challenges: [0, 1],
      answered: [0, 2],
      timeoutLoser: 1,
      balances: [10n, 20n],
    };
    const id3 = ("0x" + "33".repeat(32)) as Hex;
    const row3: ChannelRow = {
      ...baseRow(id3, [X, other(3)]), phase: "Reclaimed", challenges: [1, 0], answered: [0, 0],
    };
    const idOther = ("0x" + "44".repeat(32)) as Hex;
    const rowOther: ChannelRow = baseRow(idOther, [other(4), other(5)]);

    for (const r of [row1, row2, row3, rowOther]) repo.saveChannelRow(r);

    const cachedState = { ...initialState(id1, row1.params), gameIndex: 1, turnNum: 3n };
    repo.cacheRelay(id1, 0, { type: "state", channelId: id1, signed: { state: cachedState, sigA: "0x", sigB: "0x" } });
    // row2 and row3 have no cached relay state: they contribute 0 games.

    const stats = playerStats(repo, relay, "0xabcd000000000000000000000000000000000042" as Address);
    expect(stats.channels).toBe(3);
    expect(stats.open).toBe(1);
    expect(stats.finalized).toBe(1);
    expect(stats.reclaimed).toBe(1);
    expect(stats.challengesInitiated).toBe(4); // 2 + 1 + 1
    expect(stats.challengesAnswered).toBe(3); // 1 + 2 + 0
    expect(stats.timeoutsLost).toBe(1); // row2's timeoutLoser (1) matches X's index (1) in that channel
    expect(stats.games).toBe(2); // row1: gameIndex 1 + (turnNum>0 ? 1 : 0) = 2; rows 2/3: 0
    repo.close();
  });
});

describe("HTTP routes", () => {
  it("GET /players/:address and /api/channels/:id render decimal strings; bad address 400; unknown channel 404",
    async () => {
    server = await startServer(testConfig(), { chain: new FakeChain() });
    const cfg = server.config;
    const fx = makeChannelFixture(cfg);

    const row: ChannelRow = {
      channelId: fx.id,
      params: fx.params,
      phase: "Open",
      createdBlock: 7n,
      challenges: [1, 0],
      answered: [0, 0],
      pendingChallenger: null,
      registered: null,
      timeoutLoser: null,
      balances: null,
    };
    server.repo.saveChannelRow(row);

    const cachedState = { ...initialState(fx.id, fx.params), gameIndex: 0, turnNum: 2n };
    server.repo.cacheRelay(fx.id, 0, {
      type: "state",
      channelId: fx.id,
      signed: { state: cachedState, sigA: "0x", sigB: "0x" },
    });

    const playerRes = await fetch(`${server.url}/players/${fx.params.participants[0]}`);
    expect(playerRes.status).toBe(200);
    const playerBody = await playerRes.json();
    expect(playerBody).toEqual({
      address: fx.params.participants[0].toLowerCase(),
      channels: 1,
      open: 1,
      finalized: 0,
      reclaimed: 0,
      games: 1, // gameIndex 0 + (turnNum 2n > 0 ? 1 : 0)
      challengesInitiated: 1,
      challengesAnswered: 0,
      timeoutsLost: 0,
    });

    const badAddrRes = await fetch(`${server.url}/players/not-an-address`);
    expect(badAddrRes.status).toBe(400);

    const channelRes = await fetch(`${server.url}/api/channels/${fx.id}`);
    expect(channelRes.status).toBe(200);
    const channelBody = (await channelRes.json()) as any;
    expect(channelBody.channelId).toBe(fx.id.toLowerCase());
    expect(channelBody.phase).toBe("Open");
    expect(channelBody.stakePerGame).toBe(fx.params.stakePerGame.toString());
    expect(channelBody.deposit).toBe(fx.params.deposit.toString());
    expect(channelBody.createdBlock).toBe("7");
    expect(channelBody.latest).toEqual({
      turnNum: "2",
      gameIndex: 0,
      fen: fenOf(cachedState),
      balanceA: cachedState.balanceA.toString(),
      balanceB: cachedState.balanceB.toString(),
      status: statusOf(cachedState),
    });

    // valid hex32 but unknown to both the indexer and the relay cache
    const unknown = ("0x" + "99".repeat(32)) as Hex;
    expect((await fetch(`${server.url}/api/channels/${unknown}`)).status).toBe(404);
    // not hex32 at all
    expect((await fetch(`${server.url}/api/channels/not-a-channel`)).status).toBe(400);
  });

  it("a settled channel keeps its games count and final state after its relay cache is pruned (I6)", async () => {
    server = await startServer(testConfig(), { chain: new FakeChain() });
    const fx = makeChannelFixture(server.config, server.repo);
    const last = { ...initialState(fx.id, fx.params), gameIndex: 2, turnNum: 9n };
    const signed = { state: last, sigA: "0x" as Hex, sigB: "0x" as Hex };
    server.repo.cacheRelay(fx.id, 0, { type: "state", channelId: fx.id, signed });

    server.indexer.apply({ blockNumber: 1n, logIndex: 0, channelId: fx.id, kind: "ChannelCreated", params: fx.params });
    server.indexer.apply({ blockNumber: 2n, logIndex: 0, channelId: fx.id, kind: "Opened" });
    server.indexer.apply({
      blockNumber: 3n, logIndex: 0, channelId: fx.id, kind: "Finalized", balanceA: 1n, balanceB: 2n, fee: 0n,
    });
    const row = server.repo.channelRow(fx.id);
    expect(row?.games).toBe(3); // gameIndex 2 + the current game, which has moves
    expect(row?.finalState).toEqual(signed);

    // a day later, the next poll prunes the cache; not before
    await server.indexer.poll();
    expect(server.repo.cachedRelay(fx.id)).toHaveLength(1);
    const dayLater = Date.now() + 86_400_000 + 1_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(dayLater);
    try {
      await server.indexer.poll();
    } finally {
      spy.mockRestore();
    }
    expect(server.repo.cachedRelay(fx.id)).toEqual([]);

    const stats = (await (await fetch(`${server.url}/players/${fx.params.participants[0]}`)).json()) as any;
    expect(stats.games).toBe(3);
    const channel = (await (await fetch(`${server.url}/api/channels/${fx.id}`)).json()) as any;
    expect(channel.phase).toBe("Finalized");
    expect(channel.latest).toMatchObject({ turnNum: "9", gameIndex: 2, fen: fenOf(last) });
  });

  it("GET /watch/:id serves HTML that polls /api/channels/:id and escapes the id", async () => {
    server = await startServer(testConfig(), { chain: new FakeChain() });
    const id = ("0x" + "77".repeat(32)) as Hex;
    const res = await fetch(`${server.url}/watch/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("/api/channels/");
    expect(body).toContain(id.slice(0, 10));

    // direct unit check: watchHtml must escape a malicious id and must not let it break out of <script>
    const evil = "<script>alert(1)</script>" as Hex;
    const html = watchHtml(evil);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("</script>alert"); // no raw close-tag break-out inside the inline <script>
  });
});

describe("Indexer against a real chain (Anvil)", () => {
  it("follows a real channel on Anvil", async () => {
    const env = await deployArena();
    const cfg = testConfig({ rpcUrl: RPC, chainId: CHAIN.id, hub: env.hub, usdc: env.usdc, rules: env.rules });
    server = await startServer(cfg); // real RpcChainReader (deps.chain omitted)

    const alice = new LocalKeyTxSender(ANVIL_KEYS[1], RPC, CHAIN);
    const bob = new LocalKeyTxSender(ANVIL_KEYS[2], RPC, CHAIN);
    const hub = new HubClient(env.hub, env.pub);
    const START = 10_000_000n;
    for (const who of [alice, bob]) {
      await mintUsdc(env.usdc, who.address, START);
      await hub.approve(who, env.usdc, 2n ** 255n);
    }
    const sessionA = privateKeyToAccount(ANVIL_KEYS[1]).address;
    const sessionB = privateKeyToAccount(ANVIL_KEYS[2]).address;
    const params: Params = {
      participants: [alice.address, bob.address],
      signers: [sessionA, sessionB],
      rules: env.rules,
      feeRecipient: env.host,
      feePerPlayer: 5_000n,
      deposit: 1_000_000n,
      stakePerGame: 100_000n,
      challengeTimeout: 600n,
      fundingDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      salt: ("0x" + "ab".repeat(32)) as Hex,
    };
    await hub.deposit(alice, params);
    await hub.deposit(bob, params);

    await server.indexer.poll();

    const cid = channelId(cfg.chainId, cfg.hub, params);
    const row = server.repo.channelRow(cid);
    expect(row?.phase).toBe("Open");

    const stats = (await (await fetch(`${server.url}/players/${alice.address}`)).json()) as any;
    expect(stats.channels).toBe(1);
  });
});
