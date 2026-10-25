import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteRepo } from "../src/repo.js";
import { startServer, type ArenaServer } from "../src/server.js";
import { FakeChain, testConfig, FAKE_GENESIS_HASH, FAKE_GENESIS_HASH_B } from "./helpers/fakeChain.js";

/** Fix-round item 2: a database recorded against one chain/deployment must never be silently reused against
 *  another. The scenario that motivated this: `pnpm dev:up` reusing `.arena-dev/server.sqlite` against a freshly
 *  redeployed local chain left the indexer's persisted cursor pointing past the new chain's head, and the
 *  indexer then silently indexed nothing (see indexer.test.ts's cursor-ahead-of-head coverage). Chain id alone
 *  cannot catch this -- every fresh local Anvil reuses chain id 31337 -- so this also checks the hub address and
 *  the chain's own genesis hash. */
describe("startServer: chain/deployment identity check", () => {
  let dbPath: string;
  let server: ArenaServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
  });

  it("records identity on first start and accepts a matching restart against the same database", async () => {
    dbPath = join(tmpdir(), `arena-identity-${randomBytes(8).toString("hex")}.sqlite`);
    const cfg = testConfig({ dbPath, chainId: 31337, hub: "0x00000000000000000000000000000000000000a1" });
    const chain = new FakeChain();
    chain.genesis = FAKE_GENESIS_HASH;

    server = await startServer(cfg, { chain });
    expect(server.repo.identity()).toEqual({ chainId: 31337, hub: cfg.hub.toLowerCase(), genesisHash: FAKE_GENESIS_HASH });
    await server.close();
    server = undefined;

    // A second start against the very same database, with the same chain identity, must succeed.
    server = await startServer(cfg, { chain });
    expect(server.repo.identity()).toEqual({ chainId: 31337, hub: cfg.hub.toLowerCase(), genesisHash: FAKE_GENESIS_HASH });
  });

  it("refuses to start when the recorded genesis hash differs (same chain id and hub)", async () => {
    dbPath = join(tmpdir(), `arena-identity-${randomBytes(8).toString("hex")}.sqlite`);
    const cfg = testConfig({ dbPath, chainId: 31337, hub: "0x00000000000000000000000000000000000000a1" });

    const first = new FakeChain();
    first.genesis = FAKE_GENESIS_HASH;
    server = await startServer(cfg, { chain: first });
    await server.close();
    server = undefined;

    // Same config, same chain id and hub -- but the chain itself reports a different genesis hash, as a
    // redeployed local Anvil would (a chain reset, e.g. `pnpm dev:up` run again).
    const second = new FakeChain();
    second.genesis = FAKE_GENESIS_HASH_B;
    await expect(startServer(cfg, { chain: second })).rejects.toThrow(/another chain\/deployment/i);
  });

  it("refuses to start when the recorded hub address differs (same chain id and genesis hash)", async () => {
    dbPath = join(tmpdir(), `arena-identity-${randomBytes(8).toString("hex")}.sqlite`);
    const chain = new FakeChain();
    chain.genesis = FAKE_GENESIS_HASH;

    const cfgA = testConfig({ dbPath, chainId: 31337, hub: "0x00000000000000000000000000000000000000a1" });
    server = await startServer(cfgA, { chain });
    await server.close();
    server = undefined;

    const cfgB = testConfig({ dbPath, chainId: 31337, hub: "0x00000000000000000000000000000000000000b2" });
    await expect(startServer(cfgB, { chain })).rejects.toThrow(/another chain\/deployment/i);
  });

  it("final review C m-5: refuses to start when the RPC serves another chain id, before recording anything", async () => {
    dbPath = join(tmpdir(), `arena-identity-${randomBytes(8).toString("hex")}.sqlite`);
    // A mainnet config pointed at a testnet RPC whose URL carries a provider key.
    const cfg = testConfig({ dbPath, chainId: 5042, rpcUrl: "https://rpc.example/v2/SECRETKEY123" });
    const chain = new FakeChain();
    chain.rpcChainId = 5042002;
    const err = await startServer(cfg, { chain }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/^rpcUrl serves chain id 5042002, but this config's chainId is 5042: point rpcUrl at an RPC of chain 5042, or fix chainId/);
    expect(err?.message).not.toContain("SECRETKEY123");
    const repo = new SqliteRepo(dbPath);
    expect(repo.identity()).toBeNull(); // nothing recorded against the wrong chain
    repo.close();

    // The same config against an RPC of its own chain starts.
    chain.rpcChainId = 5042;
    server = await startServer(cfg, { chain });
    expect(server.repo.identity()?.chainId).toBe(5042);
  });

  it("final review C m-5: refuses to start when the RPC's chain id cannot be read", async () => {
    dbPath = join(tmpdir(), `arena-identity-${randomBytes(8).toString("hex")}.sqlite`);
    const chain = new FakeChain();
    chain.chainId = async () => {
      throw new Error("fetch failed");
    };
    await expect(startServer(testConfig({ dbPath }), { chain })).rejects.toThrow(
      /^could not read the RPC's chain id \(eth_chainId\) to check it against chainId 31337: fetch failed/,
    );
  });
});
