import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { arenaPaths, loadConfig, loadToken, runCli, startApi, writeJsonAtomic, type ArenaDaemon, type CliIo } from "../src/index.js";
import { setOwner, validateOwner, UsageError } from "../src/owner.js";

// Plan 5.6 Task 3 (spec §4.3, Review Focus 3): the owner lock. Every test here runs `init` with every chain flag
// (and --session-gas-wei) explicit, so no command reaches the network at all -- the stub fetch below throws if one
// ever tries.

const HUB = "0x000000000000000000000000000000000000beef";
const USDC = "0x000000000000000000000000000000000000cafe";
const RULES = "0x00000000000000000000000000000000000000e5";

/** Two distinct, valid owner addresses, in checksummed form. */
const OWNER_A = privateKeyToAccount(generatePrivateKey()).address;
const OWNER_B = privateKeyToAccount(generatePrivateKey()).address;

type TtyOpts = { stdinIsTTY?: boolean; stdoutIsTTY?: boolean; prompt?: (q: string) => Promise<string> };

function ownerIo(home: string, tty: TtyOpts = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const fetchFn = (async () => {
    throw new Error("owner tests must not reach the network");
  }) as unknown as typeof fetch;
  const io: CliIo = {
    env: { ARENA_HOME: home },
    fetch: fetchFn,
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    ...(tty.stdinIsTTY !== undefined ? { stdinIsTTY: tty.stdinIsTTY } : {}),
    ...(tty.stdoutIsTTY !== undefined ? { stdoutIsTTY: tty.stdoutIsTTY } : {}),
    ...(tty.prompt
      ? {
          prompt: async (q: string) => {
            prompts.push(q);
            return tty.prompt!(q);
          },
        }
      : {}),
  };
  return { out, err, prompts, io };
}

/** A terminal a human is sitting at: both TTY flags true, and a prompt that answers `answer`. */
const human = (answer: string): TtyOpts => ({ stdinIsTTY: true, stdoutIsTTY: true, prompt: async () => answer });
/** An agent's pipe: no TTY at all. */
const agent: TtyOpts = { stdinIsTTY: false, stdoutIsTTY: false };

function initArgs(walletKey: Hex, extra: string[] = []): string[] {
  return [
    "init", "--rpc", "http://127.0.0.1:8546", "--chain-id", "31337", "--hub", HUB, "--usdc", USDC, "--rules", RULES,
    "--server", "http://127.0.0.1:3000", "--port", "7010", "--session-gas-wei", "10000000000000000",
    "--wallet-key", walletKey, ...extra,
  ];
}

async function freshHome(extra: string[] = []) {
  const home = mkdtempSync(join(tmpdir(), "arena-owner-"));
  const walletKey = generatePrivateKey();
  const t = ownerIo(home, agent);
  const code = await runCli(initArgs(walletKey, extra), t.io);
  expect(code, t.err.join("\n")).toBe(0);
  return { home, walletKey, wallet: privateKeyToAccount(walletKey).address };
}

/** The raw `owner` field of config.json (undefined when absent). */
const ownerOnDisk = (home: string): unknown => (JSON.parse(readFileSync(arenaPaths(home).config, "utf8")) as { owner?: unknown }).owner;

async function printedOwner(home: string): Promise<unknown> {
  const t = ownerIo(home, agent);
  expect(await runCli(["owner"], t.io)).toBe(0);
  return (JSON.parse(t.out.join("")) as { owner: unknown }).owner;
}

/** Flips the case of the first letter in an address's hex part, so its EIP-55 checksum no longer matches. */
function breakChecksum(addr: Address): string {
  const i = addr.slice(2).search(/[a-fA-F]/) + 2;
  const c = addr[i];
  return addr.slice(0, i) + (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()) + addr.slice(i + 1);
}

describe("arena owner (spec §4.3)", () => {
  it("prints {\"owner\":null} on a fresh home -- and on a home that was never initialized", async () => {
    const { home } = await freshHome();
    const t = ownerIo(home, agent);
    expect(await runCli(["owner"], t.io)).toBe(0);
    expect(t.out).toEqual(['{"owner":null}']);

    const empty = mkdtempSync(join(tmpdir(), "arena-owner-empty-"));
    const e = ownerIo(empty, agent);
    expect(await runCli(["owner"], e.io)).toBe(0);
    expect(e.out).toEqual(['{"owner":null}']);
  });

  it("first set is allowed with no TTY at all, and stores the checksummed address", async () => {
    const { home } = await freshHome();
    const t = ownerIo(home, agent);
    expect(await runCli(["owner", "set", OWNER_A.toLowerCase()], t.io), t.err.join("\n")).toBe(0);
    expect(t.prompts).toEqual([]); // a first set never prompts
    expect(ownerOnDisk(home)).toBe(OWNER_A); // checksummed, though it was given in lowercase
    expect(loadConfig(home).owner).toBe(OWNER_A);
    expect(await printedOwner(home)).toBe(OWNER_A);
    expect(JSON.parse(t.out.join(""))).toEqual({ owner: OWNER_A });
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
      ["the hub, checksummed", getAddress(HUB)],
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
      const t = ownerIo(home, agent);
      expect(await runCli(["owner", "set", addr], t.io), what).toBe(1);
      expect(t.err.join("\n"), what).toMatch(/^error: /);
      expect(ownerOnDisk(home), what).toBeUndefined();
      // init --owner applies exactly the same rules.
      const i = ownerIo(home, agent);
      expect(await runCli(initArgs(generatePrivateKey(), ["--owner", addr]), i.io), `init --owner ${what}`).toBe(1);
      expect(ownerOnDisk(home), `init --owner ${what}`).toBeUndefined();
    }
    expect(await printedOwner(home)).toBeNull();
  });

  it("owner set with no address is a usage error (exit 2)", async () => {
    const { home } = await freshHome();
    const t = ownerIo(home, agent);
    expect(await runCli(["owner", "set"], t.io)).toBe(2);
    expect(await runCli(["owner", "bogus"], ownerIo(home, agent).io)).toBe(2);
  });

  describe("changing an owner already set", () => {
    async function homeWithOwnerA() {
      const h = await freshHome();
      expect(await runCli(["owner", "set", OWNER_A], ownerIo(h.home, agent).io)).toBe(0);
      return h;
    }

    it("is refused with no TTY, naming the command the human must run in their own terminal", async () => {
      const { home } = await homeWithOwnerA();
      for (const tty of [agent, {}, { stdinIsTTY: true, stdoutIsTTY: false }, { stdinIsTTY: false, stdoutIsTTY: true }] as TtyOpts[]) {
        const t = ownerIo(home, { ...tty, prompt: async () => OWNER_B.slice(-6) });
        expect(await runCli(["owner", "set", OWNER_B], t.io)).toBe(1);
        expect(t.err.join("\n")).toContain("the owner is already set; ask your human to run");
        expect(t.err.join("\n")).toContain(`arena owner set ${OWNER_B}`);
        expect(t.err.join("\n")).toContain("in their own terminal");
        expect(t.prompts).toEqual([]); // never even asked
        expect(ownerOnDisk(home)).toBe(OWNER_A);
      }
    });

    it("is refused with both TTYs but no way to prompt", async () => {
      const { home } = await homeWithOwnerA();
      const t = ownerIo(home, { stdinIsTTY: true, stdoutIsTTY: true });
      expect(await runCli(["owner", "set", OWNER_B], t.io)).toBe(1);
      expect(ownerOnDisk(home)).toBe(OWNER_A);
    });

    it("is refused at a TTY when the typed suffix is wrong", async () => {
      const { home } = await homeWithOwnerA();
      for (const wrong of ["", "000000", OWNER_A.slice(-6), OWNER_B.slice(-5), OWNER_B.slice(-7)]) {
        const t = ownerIo(home, human(wrong));
        expect(await runCli(["owner", "set", OWNER_B], t.io), JSON.stringify(wrong)).toBe(1);
        expect(t.prompts).toEqual(["Type the last 6 characters of the new owner address to confirm: "]);
        expect(ownerOnDisk(home)).toBe(OWNER_A);
      }
    });

    it("is accepted at a TTY when the typed suffix is right, in any case", async () => {
      const { home } = await homeWithOwnerA();
      const t = ownerIo(home, human(OWNER_B.slice(-6).toUpperCase()));
      expect(await runCli(["owner", "set", OWNER_B.toLowerCase()], t.io), t.err.join("\n")).toBe(0);
      expect(t.prompts).toEqual(["Type the last 6 characters of the new owner address to confirm: "]);
      expect(ownerOnDisk(home)).toBe(OWNER_B);
      expect(await printedOwner(home)).toBe(OWNER_B);

      const back = ownerIo(home, human(` ${OWNER_A.slice(-6).toLowerCase()}\n`)); // surrounding whitespace is ignored
      expect(await runCli(["owner", "set", OWNER_A], back.io)).toBe(0);
      expect(ownerOnDisk(home)).toBe(OWNER_A);
    });

    it("setting the same address again is a no-op, even with no TTY (not a change)", async () => {
      const { home } = await homeWithOwnerA();
      for (const same of [OWNER_A, OWNER_A.toLowerCase()]) {
        const t = ownerIo(home, agent);
        expect(await runCli(["owner", "set", same], t.io), t.err.join("\n")).toBe(0);
        expect(ownerOnDisk(home)).toBe(OWNER_A);
      }
    });

    it("setOwner applies the same rules when called directly", async () => {
      const { home } = await homeWithOwnerA();
      const noTty = ownerIo(home, agent);
      await expect(setOwner(home, OWNER_B, noTty.io, "npx -y @x/arena@0.3.0")).rejects.toThrow(
        `the owner is already set; ask your human to run \`npx -y @x/arena@0.3.0 owner set ${OWNER_B}\` in their own terminal`,
      );
      await setOwner(home, OWNER_B, ownerIo(home, human(OWNER_B.slice(-6))).io, "arena");
      expect(ownerOnDisk(home)).toBe(OWNER_B);
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
      expect(await runCli(initArgs(viaInit.walletKey), ownerIo(viaInit.home, agent).io)).toBe(0);
      expect(ownerOnDisk(viaInit.home)).toBe(OWNER_A);

      const viaSet = await freshHome();
      expect(await runCli(["owner", "set", OWNER_A], ownerIo(viaSet.home, agent).io)).toBe(0);
      // A re-init that changes other settings still keeps the owner.
      const re = ownerIo(viaSet.home, agent);
      const repointed = initArgs(viaSet.walletKey).map((a) => (a === "7010" ? "7020" : a));
      expect(await runCli(repointed, re.io), re.err.join("\n")).toBe(0);
      expect(loadConfig(viaSet.home).port).toBe(7020);
      expect(ownerOnDisk(viaSet.home)).toBe(OWNER_A);
      expect(JSON.parse(re.out.join("\n")).owner).toBe(OWNER_A);
    });

    it("init --owner <other> with no TTY exits 1 and writes nothing at all", async () => {
      const { home, walletKey } = await freshHome();
      expect(await runCli(["owner", "set", OWNER_A], ownerIo(home, agent).io)).toBe(0);
      const before = readFileSync(arenaPaths(home).config, "utf8");
      const t = ownerIo(home, agent);
      const args = initArgs(walletKey, ["--owner", OWNER_B]).map((a) => (a === "7010" ? "7099" : a));
      expect(await runCli(args, t.io)).toBe(1);
      expect(t.err.join("\n")).toContain("the owner is already set; ask your human to run");
      expect(ownerOnDisk(home)).toBe(OWNER_A);
      expect(readFileSync(arenaPaths(home).config, "utf8")).toBe(before); // not even the port changed
    });

    it("init --owner <other> at a TTY follows the change rule: wrong suffix refused, right suffix accepted", async () => {
      const { home, walletKey } = await freshHome(["--owner", OWNER_A]);
      expect(await runCli(initArgs(walletKey, ["--owner", OWNER_B]), ownerIo(home, human("zzzzzz")).io)).toBe(1);
      expect(ownerOnDisk(home)).toBe(OWNER_A);
      expect(await runCli(initArgs(walletKey, ["--owner", OWNER_B]), ownerIo(home, human(OWNER_B.slice(-6))).io)).toBe(0);
      expect(ownerOnDisk(home)).toBe(OWNER_B);
    });

    it("init --owner <same> exits 0 with no TTY", async () => {
      const { home, walletKey } = await freshHome(["--owner", OWNER_A]);
      const t = ownerIo(home, agent);
      expect(await runCli(initArgs(walletKey, ["--owner", OWNER_A.toLowerCase()]), t.io), t.err.join("\n")).toBe(0);
      expect(t.prompts).toEqual([]);
      expect(ownerOnDisk(home)).toBe(OWNER_A);
    });

    it("init refuses to run over a config.json it cannot read, rather than silently dropping an owner", async () => {
      const { home, walletKey } = await freshHome(["--owner", OWNER_A]);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(arenaPaths(home).config, "{ not json");
      const t = ownerIo(home, agent);
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
    expect(routes).toContain("POST /handoff"); // sanity: the scan does see the route table
    expect(routes.filter((r) => /owner/i.test(r))).toEqual([]);
    const rawPaths = [...src.matchAll(/rawPath === "([^"]*)"/g)].map((m) => m[1]);
    expect(rawPaths.filter((p) => /owner/i.test(p))).toEqual([]);
  });
});
