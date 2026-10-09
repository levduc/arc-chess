import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { arenaPaths, loadConfig, loadToken, runCli, startApi, writeJsonAtomic, type ArenaDaemon, type CliIo } from "../src/index.js";
import { ownerChangeMessage, setOwner, validateOwner, UsageError } from "../src/owner.js";
import { RPC, deployArena } from "../../sdk/test/helpers/chain.js";

// Plan 5.6 Task 3 (spec §4.3, Review Focus 3): the owner lock. Fix round 1 (I2): an owner change needs the
// current owner's EIP-191 signature, verified locally by ECDSA recovery (fix round 2: never through the RPC) -- the
// interactive-terminal gate is gone. Every home here is initialized against a real, freshly deployed hub/USDC/rules, every chain flag
// explicit; the CLI's io.fetch reaches only that RPC.

let HUB: Address;
let USDC: Address;
let RULES: Address;
beforeAll(async () => {
  const env = await deployArena();
  HUB = env.hub;
  USDC = env.usdc;
  RULES = env.rules;
});

/** Owners with keys, so tests can sign as them. */
const KEY_A = generatePrivateKey();
const KEY_B = generatePrivateKey();
const KEY_C = generatePrivateKey();
const OWNER_A = privateKeyToAccount(KEY_A).address;
const OWNER_B = privateKeyToAccount(KEY_B).address;
const OWNER_C = privateKeyToAccount(KEY_C).address;

const sign = (key: Hex, message: string): Promise<Hex> => privateKeyToAccount(key).signMessage({ message });

/** The exact text the spec pins, built by hand here (not with `ownerChangeMessage`), so the format itself is tested. */
function expectedMessage(wallet: Address, current: Address, next: Address, nonce: number): string {
  return `arena owner change\nwallet: ${wallet}\nchain: 31337\ncurrent owner: ${current}\nnew owner: ${next}\nnonce: ${nonce}`;
}

function ownerIo(home: string) {
  const out: string[] = [];
  const err: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url === RPC) return fetch(url, init);
    throw new Error(`owner tests must reach nothing but the chain's RPC (got ${url})`);
  }) as unknown as typeof fetch;
  const io: CliIo = { env: { ARENA_HOME: home }, fetch: fetchFn, out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
  return { out, err, io };
}

function initArgs(walletKey: Hex, extra: string[] = []): string[] {
  return [
    "init", "--rpc", RPC, "--chain-id", "31337", "--hub", HUB, "--usdc", USDC, "--rules", RULES,
    "--server", "http://127.0.0.1:3000", "--port", "7010", "--session-gas-wei", "10000000000000000",
    "--wallet-key", walletKey, ...extra,
  ];
}

async function freshHome(extra: string[] = []) {
  const home = mkdtempSync(join(tmpdir(), "arena-owner-"));
  const walletKey = generatePrivateKey();
  const t = ownerIo(home);
  const code = await runCli(initArgs(walletKey, extra), t.io);
  expect(code, t.err.join("\n")).toBe(0);
  return { home, walletKey, wallet: privateKeyToAccount(walletKey).address };
}

const rawConfig = (home: string) => JSON.parse(readFileSync(arenaPaths(home).config, "utf8")) as { owner?: unknown; ownerNonce?: unknown };
/** The raw `owner` field of config.json (undefined when absent). */
const ownerOnDisk = (home: string): unknown => rawConfig(home).owner;
/** `ownerNonce` as config.json holds it (0 when absent). */
const nonceOnDisk = (home: string): unknown => rawConfig(home).ownerNonce ?? 0;

async function printedOwner(home: string): Promise<unknown> {
  const t = ownerIo(home);
  expect(await runCli(["owner"], t.io)).toBe(0);
  return (JSON.parse(t.out.join("")) as { owner: unknown }).owner;
}

/** Flips the case of the first letter in an address's hex part, so its EIP-55 checksum no longer matches. */
function breakChecksum(addr: Address): string {
  const i = addr.slice(2).search(/[a-fA-F]/) + 2;
  const c = addr[i];
  return addr.slice(0, i) + (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()) + addr.slice(i + 1);
}

/** `owner set <addr> [--signature sig]`, returning the exit code and output. */
async function ownerSet(home: string, addr: string, signature?: string) {
  const t = ownerIo(home);
  const code = await runCli(["owner", "set", addr, ...(signature !== undefined ? ["--signature", signature] : [])], t.io);
  return { code, out: t.out.join("\n"), err: t.err.join("\n") };
}

describe("arena owner (spec §4.3)", () => {
  it("prints {\"owner\":null} on a fresh home -- and on a home that was never initialized", async () => {
    const { home } = await freshHome();
    const t = ownerIo(home);
    expect(await runCli(["owner"], t.io)).toBe(0);
    expect(t.out).toEqual(['{"owner":null}']);

    const empty = mkdtempSync(join(tmpdir(), "arena-owner-empty-"));
    const e = ownerIo(empty);
    expect(await runCli(["owner"], e.io)).toBe(0);
    expect(e.out).toEqual(['{"owner":null}']);
  });

  it("first set needs no signature, and stores the checksummed address (the nonce stays 0)", async () => {
    const { home } = await freshHome();
    const r = await ownerSet(home, OWNER_A.toLowerCase());
    expect(r.code, r.err).toBe(0);
    expect(ownerOnDisk(home)).toBe(OWNER_A); // checksummed, though it was given in lowercase
    expect(nonceOnDisk(home)).toBe(0);
    expect(loadConfig(home).owner).toBe(OWNER_A);
    expect(await printedOwner(home)).toBe(OWNER_A);
    expect(JSON.parse(r.out)).toEqual({ owner: OWNER_A });
    // The rest of config.json is untouched by owner set.
    expect(loadConfig(home).port).toBe(7010);
    expect(loadConfig(home).sessionGasWei).toBe(10_000_000_000_000_000n);
  });

  it("refuses every forbidden address with exit 1 (not the usage error 2), and records nothing", async () => {
    const { home, wallet } = await freshHome();
    // A channel record and an offer record in this home, each with its own session key.
    const channelSessionKey = generatePrivateKey();
    const channelId = `0x${randomBytes(32).toString("hex")}` as Hex;
    writeJsonAtomic(arenaPaths(home).channelRecord(channelId), { channelId, sessionKey: channelSessionKey, me: 0, finalized: true });
    const offerSessionKey = generatePrivateKey();
    const offerId = `0x${randomBytes(32).toString("hex")}` as Hex;
    writeJsonAtomic(arenaPaths(home).offerRecord(offerId), { offerId, sessionKey: offerSessionKey, role: "offerer" });

    const forbidden: Array<[string, string]> = [
      ["the zero address", zeroAddress],
      ["the wallet itself", wallet],
      ["the wallet itself, lowercase", wallet.toLowerCase()],
      ["the hub", HUB],
      ["the hub, lowercase", HUB.toLowerCase()],
      ["the USDC token", USDC],
      ["the rules contract", RULES],
      ["a channel's session key", privateKeyToAccount(channelSessionKey).address],
      ["an offer's session key", privateKeyToAccount(offerSessionKey).address],
      ["malformed: too short", "0x123"],
      ["malformed: no 0x", OWNER_A.slice(2)],
      ["malformed: trailing junk", `${OWNER_A}00`],
      ["malformed: a bad EIP-55 checksum", breakChecksum(OWNER_A)],
      ["malformed: whitespace", ` ${OWNER_A}`],
    ];
    for (const [what, addr] of forbidden) {
      const r = await ownerSet(home, addr);
      expect(r.code, what).toBe(1);
      expect(r.err, what).toMatch(/^error: /);
      expect(ownerOnDisk(home), what).toBeUndefined();
      // init --owner applies exactly the same rules.
      const i = ownerIo(home);
      expect(await runCli(initArgs(generatePrivateKey(), ["--owner", addr]), i.io), `init --owner ${what}`).toBe(1);
      expect(ownerOnDisk(home), `init --owner ${what}`).toBeUndefined();
    }
    expect(await printedOwner(home)).toBeNull();
  });

  it("owner set with no address is a usage error (exit 2)", async () => {
    const { home } = await freshHome();
    expect(await runCli(["owner", "set"], ownerIo(home).io)).toBe(2);
    expect(await runCli(["owner", "bogus"], ownerIo(home).io)).toBe(2);
  });

  describe("changing an owner already set (fix round 1, I2: the current owner's signature)", () => {
    async function homeWithOwnerA() {
      const h = await freshHome();
      expect((await ownerSet(h.home, OWNER_A)).code).toBe(0);
      return h;
    }

    it("without --signature: exit 1, printing the exact message to sign, its signer and the command; nothing changes", async () => {
      const { home, wallet } = await homeWithOwnerA();
      const r = await ownerSet(home, OWNER_B.toLowerCase());
      expect(r.code).toBe(1);
      expect(JSON.parse(r.out)).toEqual({
        messageToSign: expectedMessage(wallet, OWNER_A, OWNER_B, 0),
        signer: OWNER_A,
        command: `arena owner set ${OWNER_B} --signature <signature>`,
      });
      expect(r.err.split("\n")).toHaveLength(1); // one line of explanation
      expect(r.err).toMatch(/^error: the owner is already set to .*signature/);
      // Fix round 2: a smart-contract owner cannot sign here; the refusal says the only route is a hand edit.
      expect(r.err).toMatch(/smart-contract wallet, the only way to change it is to hand-edit .*config\.json/);
      expect(ownerOnDisk(home)).toBe(OWNER_A);
      expect(nonceOnDisk(home)).toBe(0);
      // The library builds the same text the spec pins.
      expect(ownerChangeMessage({ wallet, chainId: 31337, currentOwner: OWNER_A, newOwner: OWNER_B, nonce: 0 })).toBe(
        expectedMessage(wallet, OWNER_A, OWNER_B, 0),
      );
    });

    it("a valid signature by the current owner changes it, and the nonce goes up by one", async () => {
      const { home, wallet } = await homeWithOwnerA();
      const sig = await sign(KEY_A, expectedMessage(wallet, OWNER_A, OWNER_B, 0));
      const r = await ownerSet(home, OWNER_B, sig);
      expect(r.code, r.err).toBe(0);
      expect(JSON.parse(r.out)).toEqual({ owner: OWNER_B });
      expect(ownerOnDisk(home)).toBe(OWNER_B);
      expect(nonceOnDisk(home)).toBe(1);
      expect(await printedOwner(home)).toBe(OWNER_B);
      // The next change is signed by B, at nonce 1.
      const sig2 = await sign(KEY_B, expectedMessage(wallet, OWNER_B, OWNER_C, 1));
      expect((await ownerSet(home, OWNER_C, sig2)).code).toBe(0);
      expect(ownerOnDisk(home)).toBe(OWNER_C);
      expect(nonceOnDisk(home)).toBe(2);
    });

    it("refuses every signature that is not the current owner's over this exact change; nothing changes", async () => {
      const { home, wallet, walletKey } = await homeWithOwnerA();
      const right = expectedMessage(wallet, OWNER_A, OWNER_B, 0);
      const cases: Array<[string, string, Promise<Hex> | string]> = [
        ["signed by the new owner instead", OWNER_B, sign(KEY_B, right)],
        ["signed by the wallet itself", OWNER_B, sign(walletKey, right)],
        ["the wrong nonce", OWNER_B, sign(KEY_A, expectedMessage(wallet, OWNER_A, OWNER_B, 1))],
        ["the wrong chain", OWNER_B, sign(KEY_A, right.replace("chain: 31337", "chain: 1"))],
        ["a tampered new owner (signed for B, used for C)", OWNER_C, sign(KEY_A, right)],
        ["malformed: too short", OWNER_B, "0x1234"],
        ["malformed: not hex", OWNER_B, "nothex"],
        ["malformed: empty", OWNER_B, "0x"],
        ["malformed: odd length", OWNER_B, "0xabc"],
      ];
      for (const [what, next, sigP] of cases) {
        const r = await ownerSet(home, next, await sigP);
        expect(r.code, what).toBe(1);
        expect(r.err, what).toMatch(/the owner is unchanged/);
        expect(ownerOnDisk(home), what).toBe(OWNER_A);
        expect(nonceOnDisk(home), what).toBe(0);
      }
    });

    it("refuses a replay: another home's signature, and A→B→A then the old A→B signature -- even across a re-init", async () => {
      const { home, wallet, walletKey } = await homeWithOwnerA();
      // A signature for another home (another wallet) with the very same owners and nonce.
      const other = await freshHome();
      expect((await ownerSet(other.home, OWNER_A)).code).toBe(0);
      const otherSig = await sign(KEY_A, expectedMessage(other.wallet, OWNER_A, OWNER_B, 0));
      expect((await ownerSet(home, OWNER_B, otherSig)).code).toBe(1);
      expect(ownerOnDisk(home)).toBe(OWNER_A);

      const aToB = await sign(KEY_A, expectedMessage(wallet, OWNER_A, OWNER_B, 0));
      expect((await ownerSet(home, OWNER_B, aToB)).code).toBe(0);
      const bToA = await sign(KEY_B, expectedMessage(wallet, OWNER_B, OWNER_A, 1));
      expect((await ownerSet(home, OWNER_A, bToA)).code).toBe(0);
      expect(ownerOnDisk(home)).toBe(OWNER_A);
      expect(nonceOnDisk(home)).toBe(2);
      const replay = await ownerSet(home, OWNER_B, aToB);
      expect(replay.code).toBe(1);
      expect(ownerOnDisk(home)).toBe(OWNER_A);

      // A re-init keeps the nonce: back at 0, the old A→B signature would verify again.
      const re = ownerIo(home);
      expect(await runCli(initArgs(walletKey), re.io), re.err.join("\n")).toBe(0);
      expect(nonceOnDisk(home)).toBe(2);
      expect((await ownerSet(home, OWNER_B, aToB)).code).toBe(1);
      expect(ownerOnDisk(home)).toBe(OWNER_A);
    });

    it("setting the same address again is a no-op with no signature (not a change)", async () => {
      const { home } = await homeWithOwnerA();
      for (const same of [OWNER_A, OWNER_A.toLowerCase()]) {
        const r = await ownerSet(home, same);
        expect(r.code, r.err).toBe(0);
        expect(ownerOnDisk(home)).toBe(OWNER_A);
        expect(nonceOnDisk(home)).toBe(0);
      }
    });

    it("setOwner builds the printed command from its cmd (Task 4 passes the pinned npx form)", async () => {
      const { home, wallet } = await homeWithOwnerA();
      const t = ownerIo(home);
      await expect(setOwner(home, OWNER_B, t.io, "npx -y @x/arena@0.3.0")).rejects.toThrow(/signature/);
      expect(JSON.parse(t.out.join("\n")).command).toBe(`npx -y @x/arena@0.3.0 owner set ${OWNER_B} --signature <signature>`);
      await setOwner(home, OWNER_B, t.io, "arena", await sign(KEY_A, expectedMessage(wallet, OWNER_A, OWNER_B, 0)));
      expect(ownerOnDisk(home)).toBe(OWNER_B);
    });

    it("fix round 2: the check is local ECDSA -- an RPC that lies, or none at all, changes nothing", async () => {
      const { home, wallet } = await homeWithOwnerA();
      // A "lying" RPC: answers every JSON-RPC request with a true-looking word (an ERC-6492/1271 verifier call
      // through it would say "valid"), and counts how often it is asked.
      let asked = 0;
      const liar = createServer((req, res) => {
        asked++;
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const id = (() => {
            try {
              return (JSON.parse(body) as { id?: unknown }).id ?? 1;
            } catch {
              return 1;
            }
          })();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id, result: `0x${"0".repeat(63)}1` }));
        });
      });
      await new Promise<void>((r) => liar.listen(0, "127.0.0.1", () => r()));
      try {
        const liarUrl = `http://127.0.0.1:${(liar.address() as AddressInfo).port}`;
        writeJsonAtomic(arenaPaths(home).config, { ...loadConfig(home), rpcUrl: liarUrl });
        const right = expectedMessage(wallet, OWNER_A, OWNER_B, 0);
        for (const [what, sig] of [
          ["junk 0x00", "0x00"],
          ["65 junk bytes", `0x${"11".repeat(65)}`],
          ["a well-formed signature by a non-owner", await sign(KEY_C, right)],
        ] as const) {
          const r = await ownerSet(home, OWNER_B, sig);
          expect(r.code, what).toBe(1);
          expect(ownerOnDisk(home), what).toBe(OWNER_A);
          expect(nonceOnDisk(home), what).toBe(0);
        }
        expect(asked).toBe(0); // the decision never reached the RPC at all

        // No RPC reachable at all: a valid signature by the current owner still succeeds.
        writeJsonAtomic(arenaPaths(home).config, { ...loadConfig(home), rpcUrl: "http://127.0.0.1:9" });
        const r = await ownerSet(home, OWNER_B, await sign(KEY_A, right));
        expect(r.code, r.err).toBe(0);
        expect(ownerOnDisk(home)).toBe(OWNER_B);
        expect(nonceOnDisk(home)).toBe(1);
        expect(asked).toBe(0);
      } finally {
        await new Promise<void>((r) => liar.close(() => r()));
      }
    });
  });

  describe("init --owner, and re-running init (Review Focus 3)", () => {
    it("init --owner on a fresh home records the owner", async () => {
      const { home } = await freshHome(["--owner", OWNER_A.toLowerCase()]);
      expect(ownerOnDisk(home)).toBe(OWNER_A);
      expect(await printedOwner(home)).toBe(OWNER_A);
    });

    it("init again without --owner keeps it -- whether it came from init --owner or from owner set", async () => {
      const viaInit = await freshHome(["--owner", OWNER_A]);
      expect(await runCli(initArgs(viaInit.walletKey), ownerIo(viaInit.home).io)).toBe(0);
      expect(ownerOnDisk(viaInit.home)).toBe(OWNER_A);

      const viaSet = await freshHome();
      expect((await ownerSet(viaSet.home, OWNER_A)).code).toBe(0);
      // A re-init that changes other settings still keeps the owner.
      const re = ownerIo(viaSet.home);
      const repointed = initArgs(viaSet.walletKey).map((a) => (a === "7010" ? "7020" : a));
      expect(await runCli(repointed, re.io), re.err.join("\n")).toBe(0);
      expect(loadConfig(viaSet.home).port).toBe(7020);
      expect(ownerOnDisk(viaSet.home)).toBe(OWNER_A);
      expect(JSON.parse(re.out.join("\n")).owner).toBe(OWNER_A);
      // Fix round 1 (I3): the same hub/USDC/rules given in lowercase are not a repoint.
      const lower = initArgs(viaSet.walletKey).map((a) => (a === HUB || a === USDC || a === RULES ? a.toLowerCase() : a));
      const l = ownerIo(viaSet.home);
      expect(await runCli(lower, l.io), l.err.join("\n")).toBe(0);
      expect(ownerOnDisk(viaSet.home)).toBe(OWNER_A);
    });

    it("init --owner <other> is refused (exit 1), pointing at owner set --signature, and writes nothing at all", async () => {
      const { home, walletKey } = await freshHome();
      expect((await ownerSet(home, OWNER_A)).code).toBe(0);
      const before = readFileSync(arenaPaths(home).config, "utf8");
      const t = ownerIo(home);
      const args = initArgs(walletKey, ["--owner", OWNER_B]).map((a) => (a === "7010" ? "7099" : a));
      expect(await runCli(args, t.io)).toBe(1);
      expect(t.err.join("\n")).toContain(`owner set ${OWNER_B}`);
      expect(t.err.join("\n")).toContain("--signature");
      expect(ownerOnDisk(home)).toBe(OWNER_A);
      expect(readFileSync(arenaPaths(home).config, "utf8")).toBe(before); // not even the port changed
    });

    it("init --owner <same> exits 0", async () => {
      const { home, walletKey } = await freshHome(["--owner", OWNER_A]);
      const t = ownerIo(home);
      expect(await runCli(initArgs(walletKey, ["--owner", OWNER_A.toLowerCase()]), t.io), t.err.join("\n")).toBe(0);
      expect(ownerOnDisk(home)).toBe(OWNER_A);
    });

    it("init refuses to run over a config.json it cannot read, rather than silently dropping an owner", async () => {
      const { home, walletKey } = await freshHome(["--owner", OWNER_A]);
      writeFileSync(arenaPaths(home).config, "{ not json");
      const t = ownerIo(home);
      expect(await runCli(initArgs(walletKey), t.io)).toBe(1);
      expect(t.err.join("\n")).toMatch(/config\.json/);
      expect(readFileSync(arenaPaths(home).config, "utf8")).toBe("{ not json");
    });
  });

  describe("validateOwner", () => {
    it("returns the checksummed address, or throws UsageError", () => {
      expect(validateOwner(OWNER_A.toLowerCase(), [])).toBe(OWNER_A);
      expect(validateOwner(OWNER_A, [OWNER_B])).toBe(OWNER_A);
      expect(() => validateOwner(OWNER_A, [OWNER_A.toLowerCase() as Address])).toThrow(UsageError);
      expect(() => validateOwner(zeroAddress, [])).toThrow(UsageError);
      expect(() => validateOwner("0x123", [])).toThrow(UsageError);
      expect(() => validateOwner(breakChecksum(OWNER_A), [])).toThrow(UsageError);
      expect(() => validateOwner(OWNER_A.toUpperCase().replace("0X", "0x"), [])).toThrow(UsageError);
    });
  });
});

describe("no daemon route sets the owner (Review Focus 3)", () => {
  let close: (() => void) | undefined;
  afterEach(() => {
    close?.();
    close = undefined;
  });

  it("POST/PUT/GET /owner reach no route: 404, with a valid token and a JSON body", async () => {
    const { home } = await freshHome(["--owner", OWNER_A]);
    const token = loadToken(home);
    // The router answers these before touching the daemon at all, so no real daemon is needed here; the real
    // daemon's own POST /withdraw is exercised end to end in withdraw.test.ts.
    const api = await startApi({} as unknown as ArenaDaemon, { port: 0, token });
    close = () => api.server.close();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "GET"]) {
      for (const path of ["/owner", "/owner/set", "/config"]) {
        const res = await fetch(`${api.url}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-arena-actor": "human" },
          body: method === "GET" ? undefined : JSON.stringify({ owner: OWNER_B, address: OWNER_B }),
        });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
    expect(ownerOnDisk(home)).toBe(OWNER_A);
  });

  it("api.ts names no route containing 'owner' (static check of every route the router matches)", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/api.ts"), "utf8");
    const routes = [...src.matchAll(/"(GET|POST|PUT|PATCH|DELETE) (\/[^"]*)"/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(routes).toContain("POST /withdraw"); // sanity: the scan does see the route table
    expect(routes.filter((r) => /owner/i.test(r))).toEqual([]);
    const rawPaths = [...src.matchAll(/rawPath === "([^"]*)"/g)].map((m) => m[1]);
    expect(rawPaths.filter((p) => /owner/i.test(p))).toEqual([]);
  });
});
