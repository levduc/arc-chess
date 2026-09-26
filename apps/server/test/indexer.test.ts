import { afterEach, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
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
  statusOf,
  withStatus,
} from "@arena/sdk";
import type { HubEvent, Params, State } from "@arena/sdk";
import { watchHtml } from "../src/docs.js";
import { Indexer, playerStats } from "../src/indexer.js";
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
    let failNext = true;
    const realHubEvents = chain.hubEvents.bind(chain);
    chain.hubEvents = async (from: bigint, to: bigint) => {
      if (from === 10n && failNext) {
        failNext = false;
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
