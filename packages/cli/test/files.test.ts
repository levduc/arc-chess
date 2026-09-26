import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { ChannelSession, type ArenaDomain, type Params } from "@arena/sdk";
import {
  FileSessionStore,
  RecordStore,
  arenaPaths,
  initHome,
  loadConfig,
  loadToken,
  loadWalletKey,
  readJson,
  writeJsonAtomic,
  type ArenaConfig,
} from "../src/index.js";
import { privateKeyToAccount } from "viem/accounts";

const CFG: ArenaConfig = {
  rpcUrl: "http://127.0.0.1:8546",
  chainId: 31337,
  hub: "0x000000000000000000000000000000000000beef",
  usdc: "0x000000000000000000000000000000000000cafe",
  rules: "0x00000000000000000000000000000000000000e5",
  serverUrl: "http://127.0.0.1:3000",
  port: 7001,
  maxFeePerPlayer: 10_000n,
  sessionGasWei: 10n ** 16n,
  pollMs: 1000,
};

const home = () => mkdtempSync(join(tmpdir(), "arena-"));
const mode = (p: string) => statSync(p).mode & 0o777;

describe("files", () => {
  it("writes JSON atomically with 0600 and round-trips bigints", () => {
    const dir = home();
    const p = join(dir, "x", "v.json");
    writeJsonAtomic(p, { n: 5n, s: "a" });
    expect(readJson(p)).toEqual({ n: 5n, s: "a" });
    expect(mode(p)).toBe(0o600);
    expect(readJson(join(dir, "missing.json"))).toBeNull();
  });

  it("initialises a home with config, wallet key and token (0600) and reloads them", () => {
    const dir = home();
    const { walletKey, token } = initHome(dir, CFG);
    const paths = arenaPaths(dir);
    expect(loadConfig(dir)).toEqual(CFG);
    expect(loadWalletKey(dir)).toBe(walletKey);
    expect(loadToken(dir)).toBe(token);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    for (const f of [paths.config, paths.wallet, paths.token]) expect(mode(f)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    // Re-init keeps the existing wallet key and token.
    expect(initHome(dir, { ...CFG, port: 7002 })).toEqual({ walletKey, token });
    expect(loadConfig(dir).port).toBe(7002);
  });

  it("persists session snapshots so ChannelSession.open resumes", async () => {
    const dir = home();
    const keys = [generatePrivateKey(), generatePrivateKey()] as const;
    const params: Params = {
      participants: ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000b2"],
      signers: [privateKeyToAccount(keys[0]).address, privateKeyToAccount(keys[1]).address],
      rules: CFG.rules,
      feeRecipient: "0x00000000000000000000000000000000000000f6",
      feePerPlayer: 5_000n,
      deposit: 1_000_000n,
      stakePerGame: 100_000n,
      challengeTimeout: 600n,
      fundingDeadline: 2_000_000_000n,
      salt: `0x${"22".repeat(32)}`,
    };
    const domain: ArenaDomain = { chainId: 31337, hub: CFG.hub };
    const path = join(dir, "channels", "c", "session.json");
    const a = await ChannelSession.open({ params, me: 0, sessionKey: keys[0], domain, store: new FileSessionStore(path) });
    await a.move("e2e4");
    expect(mode(path)).toBe(0o600);
    const again = await ChannelSession.open({ params, me: 0, sessionKey: keys[0], domain, store: new FileSessionStore(path) });
    expect(again.latest).toEqual(a.latest);
    expect(again.snapshot().lastSignedTurn).toBe(1n);
  });

  it("stores channel and offer records", () => {
    const dir = home();
    const rs = new RecordStore(dir);
    const rec = {
      channelId: `0x${"33".repeat(32)}` as const,
      params: {} as Params,
      me: 0 as const,
      sessionKey: generatePrivateKey(),
      offerId: `0x${"44".repeat(32)}` as const,
      createdBlock: 7n,
      controller: "agent" as const,
      note: "",
      finalized: false,
    };
    rs.saveChannel(rec);
    expect(rs.channels()).toEqual([rec]);
    expect(rs.channel(rec.channelId)).toEqual(rec);
    const off = { offerId: rec.offerId, offer: {} as never, sessionKey: rec.sessionKey, role: "offerer" as const };
    rs.saveOffer(off);
    expect(rs.offer(rec.offerId)).toEqual(off);
    expect(rs.offers()).toHaveLength(1);
    rs.removeOffer(rec.offerId);
    expect(rs.offer(rec.offerId)).toBeNull();
  });
});
