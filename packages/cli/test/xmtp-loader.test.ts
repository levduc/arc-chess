import { existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { Address, Hex } from "viem";
import { keccak256, recoverMessageAddress, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { XMTP_SDK_VERSION, loadXmtpSdk, xmtpSdkNodeModules } from "../src/xmtp/loader.js";
import {
  NOT_THE_PEER,
  UNDETERMINED,
  createNodeSdkTransport,
  xmtpDbKey,
  xmtpSignerOf,
  type XmtpTransport,
} from "../src/xmtp/transport.js";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "arena-xmtp-loader-"));
  homes.push(home);
  return home;
}

/** Writes a stand-in `@xmtp/node-sdk` package into `home`'s SDK dir. */
function fakeSdk(home: string, opts: { version?: string; source?: string; manifest?: Record<string, unknown> } = {}): string {
  const dir = join(xmtpSdkNodeModules(home), "@xmtp", "node-sdk");
  mkdirSync(join(dir, "dist"), { recursive: true });
  const manifest = opts.manifest ?? {
    name: "@xmtp/node-sdk",
    version: opts.version ?? XMTP_SDK_VERSION,
    type: "module",
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    main: "dist/index.js",
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  writeFileSync(
    join(dir, "dist", "index.js"),
    opts.source ?? "export const Client = { create: async () => ({}) };\nexport const IdentifierKind = { Ethereum: 0, Passkey: 1 };\n",
  );
  return dir;
}

describe("loadXmtpSdk (Review Focus 3: missing, broken or wrong-version SDK)", () => {
  it("pins @xmtp/node-sdk 6.1.0", () => {
    expect(XMTP_SDK_VERSION).toBe("6.1.0");
  });

  it("returns ok:false for a home with no SDK dir at all", async () => {
    const r = await loadXmtpSdk(newHome());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not installed");
  });

  it("returns ok:false for a home whose dir does not exist", async () => {
    const r = await loadXmtpSdk(join(tmpdir(), "arena-xmtp-no-such-home", String(Date.now())));
    expect(r).toMatchObject({ ok: false });
  });

  it("returns ok:false for the wrong version, without importing it", async () => {
    const home = newHome();
    fakeSdk(home, { version: "6.0.1", source: "throw new Error('must not be imported');\n" });
    const r = await loadXmtpSdk(home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('version "6.0.1"');
  });

  it("returns ok:false for an unreadable package.json", async () => {
    const home = newHome();
    const dir = fakeSdk(home);
    writeFileSync(join(dir, "package.json"), "{ not json");
    const r = await loadXmtpSdk(home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("unreadable");
  });

  it("returns ok:false when the import throws (a native binary that fails to load)", async () => {
    const home = newHome();
    fakeSdk(home, { source: "throw new Error('no native binding for this platform');\n" });
    const r = await loadXmtpSdk(home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("failed to load: no native binding for this platform");
  });

  it("returns ok:false when the entry file is missing (a corrupt install)", async () => {
    const home = newHome();
    const dir = fakeSdk(home);
    rmSync(join(dir, "dist"), { recursive: true });
    const r = await loadXmtpSdk(home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("failed to load");
  });

  it("returns ok:false when the module lacks Client.create or IdentifierKind", async () => {
    const home = newHome();
    fakeSdk(home, { source: "export const Client = {};\n" });
    const r = await loadXmtpSdk(home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("does not export");
  });

  it("returns the module for the pinned version", async () => {
    const home = newHome();
    fakeSdk(home);
    const r = await loadXmtpSdk(home);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.version).toBe("6.1.0");
      expect((r.sdk as { IdentifierKind: { Ethereum: number } }).IdentifierKind.Ethereum).toBe(0);
    }
  });
});

describe("the XMTP signer adapter and DB key (I5: through RelaySigner only)", () => {
  it("identifies as the lower-cased EOA and signs XMTP's text with EIP-191", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signer = xmtpSignerOf(account, 0);
    expect(signer.type).toBe("EOA");
    expect(signer.getIdentifier()).toEqual({ identifier: account.address.toLowerCase(), identifierKind: 0 });
    const text = "XMTP : Authenticate to inbox\n\nInbox ID: abc";
    const sig = await signer.signMessage(text);
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig).toHaveLength(65);
    expect(await recoverMessageAddress({ message: text, signature: toHex(sig) })).toBe(account.address);
  });

  it("derives a stable 32-byte DB key per channel from the session key's signature", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const id1 = keccak256(toHex("channel 1"));
    const id2 = keccak256(toHex("channel 2"));
    const k1 = await xmtpDbKey(account, id1);
    expect(k1).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await xmtpDbKey(account, id1)).toBe(k1);
    expect(await xmtpDbKey(account, id2)).not.toBe(k1);
    expect(k1).toBe(keccak256(await account.signMessage({ message: `arena-xmtp-db/v1:${id1}` })));
  });
});

// ------------------------------------------------------------------------------------------------- opt-in smoke test

/** Opt-in: point ARENA_XMTP_SDK_DIR at a `node_modules` holding `@xmtp/node-sdk` 6.1.0 to run this against XMTP's
 *  public `dev` network. Skipped otherwise. */
const SDK_DIR = process.env.ARENA_XMTP_SDK_DIR;
const HAVE_SDK = SDK_DIR !== undefined && existsSync(join(SDK_DIR, "@xmtp", "node-sdk", "package.json"));

describe.skipIf(!HAVE_SDK)("createNodeSdkTransport against XMTP's dev network (opt-in: ARENA_XMTP_SDK_DIR)", () => {
  it("two fresh session keys exchange one message; from and dm are the sender's address", async () => {
    const home = newHome();
    mkdirSync(join(home, "xmtp", "sdk"), { recursive: true });
    symlinkSync(SDK_DIR as string, xmtpSdkNodeModules(home), "dir");
    const loaded = await loadXmtpSdk(home);
    if (!loaded.ok) throw new Error(loaded.reason);
    const logs: string[] = [];
    const a = privateKeyToAccount(generatePrivateKey());
    const b = privateKeyToAccount(generatePrivateKey());
    const channelId = keccak256(toHex(`arena-smoke-${Date.now()}-${Math.random()}`)) as Hex;
    const make = (dir: string): XmtpTransport =>
      createNodeSdkTransport({ sdk: loaded.sdk, dbDir: join(home, "xmtp", dir), config: { env: "dev" }, log: (l) => logs.push(l) });
    const ta = make("db-a");
    const tb = make("db-b");
    try {
      const t0 = Date.now();
      await Promise.all([ta.open(channelId, a, b.address), tb.open(channelId, b, a.address)]);
      const opened = Date.now() - t0;
      const got = new Promise<{ id: Hex; from: Address; dm: Address; text: string }>((resolve) =>
        tb.onText((id, from, dm, text) => resolve({ id, from, dm, text })),
      );
      const t1 = Date.now();
      await ta.send(channelId, '{"arena":1,"msg":"smoke"}');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const r = await Promise.race([
        got,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no message within 60 s; logs: ${logs.join(" | ")}`)), 60_000);
        }),
      ]).finally(() => clearTimeout(timer));
      // eslint-disable-next-line no-console
      console.log(`xmtp smoke: both clients open in ${opened} ms, message delivered in ${Date.now() - t1} ms`);
      expect(r).toEqual({ id: channelId, from: a.address, dm: a.address, text: '{"arena":1,"msg":"smoke"}' });
      expect(existsSync(join(home, "xmtp", "db-a", `${channelId}.db3`))).toBe(true);
    } finally {
      await Promise.all([ta.stop(), tb.stop()]);
    }
  }, 180_000);

  it("a stranger's group invite is denied at the next stream start (the real consent filter matches a fresh invite)", async () => {
    const home = newHome();
    mkdirSync(join(home, "xmtp", "sdk"), { recursive: true });
    symlinkSync(SDK_DIR as string, xmtpSdkNodeModules(home), "dir");
    const loaded = await loadXmtpSdk(home);
    if (!loaded.ok) throw new Error(loaded.reason);
    const sdk = loaded.sdk as {
      Client: { create(s: unknown, o: Record<string, unknown>): Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
      IdentifierKind: { Ethereum: number };
    };
    const a = privateKeyToAccount(generatePrivateKey()); // the opponent: never registers here
    const b = privateKeyToAccount(generatePrivateKey());
    const stranger = privateKeyToAccount(generatePrivateKey());
    const channelId = keccak256(toHex(`arena-smoke-group-${Date.now()}-${Math.random()}`)) as Hex;
    const logs: string[] = [];
    const make = () =>
      createNodeSdkTransport({ sdk: loaded.sdk, dbDir: join(home, "xmtp", "db-b"), config: { env: "dev" }, log: (l) => logs.push(l) });
    const first = make();
    await first.open(channelId, b, a.address); // registers B's inbox
    const c = await sdk.Client.create(xmtpSignerOf(stranger, sdk.IdentifierKind.Ethereum), {
      env: "dev",
      dbPath: null,
      disableDeviceSync: true,
    });
    const group = await c.conversations.createGroupWithIdentifiers([
      { identifier: b.address.toLowerCase(), identifierKind: sdk.IdentifierKind.Ethereum },
    ]);
    await group.sendText("join us");
    await c.close(); // 6.1.0: the stranger's client releases its resources
    await first.stop();
    const second = make(); // B's daemon restarts: same DB, same installation
    try {
      await second.open(channelId, b, a.address);
      expect(logs.filter((l) => l.includes("denied 1 group invite(s) from strangers"))).toHaveLength(1);
    } finally {
      await second.stop();
    }
  }, 180_000);

  it("C-N1: members are in InboxState.identifiers (what the transport reads); a stranger can name any address as its recovery identifier, and is never taken for that address", async () => {
    const home = newHome();
    mkdirSync(join(home, "xmtp", "sdk"), { recursive: true });
    symlinkSync(SDK_DIR as string, xmtpSdkNodeModules(home), "dir");
    const loaded = await loadXmtpSdk(home);
    if (!loaded.ok) throw new Error(loaded.reason);
    const sdk = loaded.sdk as {
      Client: { create(s: unknown, o: Record<string, unknown>): Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
      IdentifierKind: { Ethereum: number };
    };
    const kind = sdk.IdentifierKind.Ethereum;
    const a = privateKeyToAccount(generatePrivateKey()); // the opponent: never registers, so B classifies by inbox state
    const b = privateKeyToAccount(generatePrivateKey());
    const eve = privateKeyToAccount(generatePrivateKey());
    const channelId = keccak256(toHex(`arena-smoke-recovery-${Date.now()}-${Math.random()}`)) as Hex;
    const logs: string[] = [];
    const tb = createNodeSdkTransport({ sdk: loaded.sdk, dbDir: join(home, "xmtp", "db-b"), config: { env: "dev" }, log: (l) => logs.push(l) });
    try {
      await tb.open(channelId, b, a.address);
      const got = new Promise<{ from: Address; dm: Address; text: string }>((resolve) =>
        tb.onText((_id, from, dm, text) => resolve({ from, dm, text })),
      );
      const c = await sdk.Client.create(xmtpSignerOf(eve, kind), { env: "dev", dbPath: null, disableDeviceSync: true });
      // Signed by Eve alone (her inbox's current recovery identity): A signs nothing.
      await c.changeRecoveryIdentifier({ identifier: a.address.toLowerCase(), identifierKind: kind });
      const state = (await c.preferences.fetchInboxState()) as {
        identifiers: Array<{ identifier: string; identifierKind: number }>;
        recoveryIdentifier: { identifier: string; identifierKind: number };
      };
      // The field the transport relies on: the members, each added by its own signature -- Eve's creating address.
      expect(state.identifiers.map((i) => i.identifier.toLowerCase())).toEqual([eve.address.toLowerCase()]);
      // The field it never reads: now A's address, with no signature of A's.
      expect(state.recoveryIdentifier.identifier.toLowerCase()).toBe(a.address.toLowerCase());
      const dm = await c.conversations.createDmWithIdentifier({ identifier: b.address.toLowerCase(), identifierKind: kind });
      await dm.sendText('{"arena":1,"msg":"eve"}');
      await c.close(); // 6.1.0: Eve's client releases its resources
      let timer: ReturnType<typeof setTimeout> | undefined;
      const r = await Promise.race([
        got,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no message within 60 s; logs: ${logs.join(" | ")}`)), 60_000);
        }),
      ]).finally(() => clearTimeout(timer));
      // eslint-disable-next-line no-console
      console.log(`xmtp smoke (C-N1): Eve's message arrived as from=${r.from === NOT_THE_PEER ? "NOT_THE_PEER" : r.from === UNDETERMINED ? "UNDETERMINED" : r.from}`);
      expect(r.text).toBe('{"arena":1,"msg":"eve"}');
      expect(r.from).not.toBe(a.address);
      expect(r.dm).not.toBe(a.address);
      expect([NOT_THE_PEER, UNDETERMINED]).toContain(r.from);
    } finally {
      await tb.stop();
    }
  }, 180_000);
  it("I-1: clients opened then closed through the transport release their resources: fds back to the baseline, RSS flat across rounds", async () => {
    if (!existsSync("/proc/self/fd")) return; // Linux only: the counts come from /proc
    const home = newHome();
    mkdirSync(join(home, "xmtp", "sdk"), { recursive: true });
    symlinkSync(SDK_DIR as string, xmtpSdkNodeModules(home), "dir");
    const loaded = await loadXmtpSdk(home);
    if (!loaded.ok) throw new Error(loaded.reason);
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const dbDir = join(home, "xmtp", "db");
    const fds = () => readdirSync("/proc/self/fd").length;
    const dbFds = () =>
      readdirSync("/proc/self/fd").filter((f) => {
        try {
          return readlinkSync(`/proc/self/fd/${f}`).startsWith(dbDir);
        } catch {
          return false;
        }
      }).length;
    const threads = () => readdirSync("/proc/self/task").length;
    const rssMB = () => Math.round(process.memoryUsage().rss / 1e6);
    const settleDown = async () => {
      for (let i = 0; i < 6; i++) {
        gc();
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    const N = 6;
    const logs: string[] = [];
    const t = createNodeSdkTransport({ sdk: loaded.sdk, dbDir, config: { env: "dev" }, log: (l) => logs.push(l) });
    const round = async (r: number) => {
      const ids: Hex[] = [];
      for (let i = 0; i < N; i++) {
        const id = keccak256(toHex(`arena-fd-${r}-${i}-${Date.now()}-${Math.random()}`)) as Hex;
        ids.push(id);
        // A peer that never registers: the client starts and streams; its DM is simply never found.
        await t.open(id, privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey()).address);
      }
      const open = { fds: fds(), dbFds: dbFds(), threads: threads(), rssMB: rssMB() };
      // Half finalized (closed and purged), half closed as on a daemon stop.
      for (const [i, id] of ids.entries()) await t.close(id, i % 2 === 0 ? { purge: true } : undefined);
      await settleDown();
      const closed = { fds: fds(), dbFds: dbFds(), threads: threads(), rssMB: rssMB() };
      for (const [i, id] of ids.entries()) expect(existsSync(join(dbDir, `${id}.db3`))).toBe(i % 2 !== 0);
      return { open, closed };
    };
    try {
      await round(0); // warm-up: the SDK's process-wide state (runtime, TLS) is created once, then kept
      await settleDown();
      const baseline = { fds: fds(), threads: threads(), rssMB: rssMB() };
      const r1 = await round(1);
      const r2 = await round(2);
      const r3 = await round(3);
      // eslint-disable-next-line no-console
      console.log(`xmtp fd/RSS (N=${N} per round): baseline ${JSON.stringify(baseline)}; ` +
        [r1, r2, r3].map((r, i) => `round ${i + 1} open ${JSON.stringify(r.open)} closed ${JSON.stringify(r.closed)}`).join("; "));
      for (const r of [r1, r2, r3]) {
        expect(r.open.dbFds).toBeGreaterThan(0); // the clients really held their DBs
        expect(r.closed.dbFds).toBe(0); // and released every DB file descriptor
        expect(r.closed.fds).toBeLessThanOrEqual(baseline.fds + 3);
      }
      // RSS does not keep growing: three more rounds of N clients end where the first one did, give or take.
      expect(r3.closed.rssMB).toBeLessThanOrEqual(r1.closed.rssMB + 40);
      expect(logs.filter((l) => l.includes("client close failed"))).toEqual([]);
    } finally {
      await t.stop();
    }
  }, 600_000);
});
