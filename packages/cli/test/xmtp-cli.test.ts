import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { runBot } from "../src/bot.js";
import type { ArenaDaemon } from "../src/daemon.js";
import { arenaPaths, loadConfig, resolveNpmBinary, runCli, xmtpBotHint } from "../src/index.js";
import { XMTP_SDK_VERSION } from "../src/xmtp/loader.js";

// Plan 5.7 Task 4: `arena xmtp enable|status|disable`, `init`'s xmtp caching, and the house-bot hint.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function io(home: string, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      // `enable` spawns a real child process (the fake npm script, via its own "#!/usr/bin/env node" shebang) --
      // it needs a real PATH to find `node` at all, so this spreads the ambient environment rather than only the
      // couple of vars these tests care about (as plain, non-spawning CLI tests elsewhere in this package do).
      env: { ...process.env, ARENA_HOME: home, ...env },
      fetch: (async () => {
        throw new Error("no network expected");
      }) as unknown as typeof fetch,
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
    },
  };
}

function chessTemplate(overrides: Record<string, unknown> = {}) {
  return [
    {
      id: "chess",
      version: "1",
      chainId: 31337,
      rpcUrl: "http://rpc.test",
      hub: `0x${"11".repeat(20)}`,
      usdc: `0x${"22".repeat(20)}`,
      rules: `0x${"33".repeat(20)}`,
      ...overrides,
    },
  ];
}

/** Answers `GET <server>/templates` with `templates`, and every JSON-RPC POST as chain 31337 where every address
 *  holds code -- enough for `init` to pass its chain checks without a faucet or any other network call. */
function stubFetch(templates: unknown) {
  return (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/templates")) return new Response(JSON.stringify(templates));
    const req = JSON.parse(String(init?.body)) as { id: number; method: string };
    const result = req.method === "eth_chainId" ? "0x7a69" : req.method === "eth_gasPrice" ? "0x3b9aca00" : "0x6080";
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
  }) as unknown as typeof fetch;
}

/**
 * A stand-in "npm" the tests point `ARENA_XMTP_NPM` at, in place of the real registry: a `#!/usr/bin/env node`
 * script, executable, that reads `--prefix <dir>` from its own argv and -- exactly like a real `npm install
 * --save-exact @xmtp/node-sdk@<version>` would -- creates `<dir>/node_modules/@xmtp/node-sdk` with a loadable
 * package.json and entry file. Never touches the network.
 */
function writeFakeNpm(dir: string, opts: { version?: string; indexSource?: string; exitCode?: number; stderr?: string } = {}): string {
  const scriptPath = join(dir, "fake-npm.mjs");
  const version = opts.version ?? XMTP_SDK_VERSION;
  const indexSource =
    opts.indexSource ?? "export const Client = { create: async () => ({}) };\nexport const IdentifierKind = { Ethereum: 0, Passkey: 1 };\n";
  const exitCode = opts.exitCode ?? 0;
  const stderr = opts.stderr ?? "";
  const lines = [
    "#!/usr/bin/env node",
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "const args = process.argv.slice(2);",
    `const stderrMsg = ${JSON.stringify(stderr)};`,
    'if (stderrMsg) process.stderr.write(stderrMsg + "\\n");',
    `const exitCode = ${JSON.stringify(exitCode)};`,
    "if (exitCode !== 0) process.exit(exitCode);",
    'const prefix = args[args.indexOf("--prefix") + 1];',
    'const pkgDir = join(prefix, "node_modules", "@xmtp", "node-sdk");',
    "mkdirSync(pkgDir, { recursive: true });",
    `writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@xmtp/node-sdk", version: ${JSON.stringify(version)}, type: "module", main: "index.js" }));`,
    `writeFileSync(join(pkgDir, "index.js"), ${JSON.stringify(indexSource)});`,
    "process.exit(0);",
    "",
  ];
  writeFileSync(scriptPath, lines.join("\n"));
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe("arena xmtp enable|status|disable", () => {
  it("status on a fresh home: not installed, no cached config yet", async () => {
    const home = freshDir("arena-xmtp-cli-");
    const t = io(home);
    expect(await runCli(["xmtp", "status"], t.io)).toBe(0);
    expect(t.out).toHaveLength(1);
    const payload = JSON.parse(t.out[0]) as Record<string, unknown>;
    expect(payload).toMatchObject({ enabled: false, version: null, env: null });
    expect(payload.reason).toContain("not installed");
  });

  it('enable installs the fixture via ARENA_XMTP_NPM and prints {enabled:true, version, sizeMB}', async () => {
    const home = freshDir("arena-xmtp-cli-");
    const npmScript = writeFakeNpm(freshDir("arena-xmtp-npm-"));
    const t = io(home, { ARENA_XMTP_NPM: npmScript });
    expect(await runCli(["xmtp", "enable"], t.io)).toBe(0);
    const payload = JSON.parse(t.out.at(-1)!) as Record<string, unknown>;
    expect(payload.enabled).toBe(true);
    expect(payload.version).toBe(XMTP_SDK_VERSION);
    expect(typeof payload.sizeMB).toBe("number");
    expect(existsSync(join(home, "xmtp", "sdk", "node_modules", "@xmtp", "node-sdk", "package.json"))).toBe(true);

    // status now reports it installed, with no cached config (env: null).
    const t2 = io(home);
    expect(await runCli(["xmtp", "status"], t2.io)).toBe(0);
    expect(JSON.parse(t2.out[0])).toEqual({ enabled: true, version: XMTP_SDK_VERSION, env: null });
  });

  it("enable surfaces npm's own failure clearly, naming its exit code and output", async () => {
    const home = freshDir("arena-xmtp-cli-");
    const npmScript = writeFakeNpm(freshDir("arena-xmtp-npm-"), { exitCode: 1, stderr: "network unreachable" });
    const t = io(home, { ARENA_XMTP_NPM: npmScript });
    expect(await runCli(["xmtp", "enable"], t.io)).toBe(1);
    expect(t.err.join("\n")).toMatch(/exited 1/);
    expect(t.err.join("\n")).toContain("network unreachable");
  });

  it("enable refuses clearly when the install lands the wrong version (Review Focus 3)", async () => {
    const home = freshDir("arena-xmtp-cli-");
    const npmScript = writeFakeNpm(freshDir("arena-xmtp-npm-"), { version: "6.0.1" });
    const t = io(home, { ARENA_XMTP_NPM: npmScript });
    expect(await runCli(["xmtp", "enable"], t.io)).toBe(1);
    expect(t.err.join("\n")).toContain(`needs ${XMTP_SDK_VERSION}`);
  });

  it("enable refuses clearly when the install is broken (a native binary that fails to load, Review Focus 3)", async () => {
    const home = freshDir("arena-xmtp-cli-");
    const npmScript = writeFakeNpm(freshDir("arena-xmtp-npm-"), { indexSource: "throw new Error('no native binding for this platform');\n" });
    const t = io(home, { ARENA_XMTP_NPM: npmScript });
    expect(await runCli(["xmtp", "enable"], t.io)).toBe(1);
    expect(t.err.join("\n")).toContain("failed to load");
  });

  it("status reports the env cached by init, even before the SDK is installed", async () => {
    const home = freshDir("arena-xmtp-cli-");
    const initCode = await runCli(["init", "--server", "http://host.test"], {
      ...io(home).io,
      fetch: stubFetch(chessTemplate({ xmtp: { env: "dev" } })),
    });
    expect(initCode).toBe(0);
    const t = io(home);
    expect(await runCli(["xmtp", "status"], t.io)).toBe(0);
    expect(JSON.parse(t.out[0])).toMatchObject({ enabled: false, env: "dev" });
  });

  it("disable removes <home>/xmtp/sdk but never touches <home>/xmtp/db, and is idempotent", async () => {
    const home = freshDir("arena-xmtp-cli-");
    const npmScript = writeFakeNpm(freshDir("arena-xmtp-npm-"));
    const t = io(home, { ARENA_XMTP_NPM: npmScript });
    expect(await runCli(["xmtp", "enable"], t.io)).toBe(0);
    const dbDir = join(home, "xmtp", "db");
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, "somechannel.db3"), "fake-db-contents");

    const t2 = io(home);
    expect(await runCli(["xmtp", "disable"], t2.io)).toBe(0);
    expect(JSON.parse(t2.out[0])).toEqual({ enabled: false });
    expect(existsSync(join(home, "xmtp", "sdk"))).toBe(false);
    expect(existsSync(join(dbDir, "somechannel.db3"))).toBe(true); // the DB is never touched by disable

    // A second disable on an already-disabled home is a no-op, not an error.
    const t3 = io(home);
    expect(await runCli(["xmtp", "disable"], t3.io)).toBe(0);
  });

  it("an unknown xmtp subcommand is a usage error (exit 2)", async () => {
    const home = freshDir("arena-xmtp-cli-");
    const t = io(home);
    expect(await runCli(["xmtp", "bogus"], t.io)).toBe(2);
    expect(t.err.join("\n")).toContain("unknown xmtp subcommand");
  });
});

// Opt-in: the real install, against the real npm registry -- never run by plain `pnpm test:cli`. Downloads the
// real ~725 MB @xmtp/node-sdk@6.0.0 (native binary included), so it is gated behind ARENA_XMTP_REAL_INSTALL=1 and
// given a generous timeout; its temp HOME is removed in `afterEach` like every other test here.
describe.skipIf(process.env.ARENA_XMTP_REAL_INSTALL !== "1")("arena xmtp enable: the real install (opt-in: ARENA_XMTP_REAL_INSTALL=1)", () => {
  it("installs the real @xmtp/node-sdk@6.0.0 from the npm registry and loads it", async () => {
    const home = freshDir("arena-xmtp-real-install-");
    // No ARENA_XMTP_NPM override here: resolveNpmBinary finds the real npm (next to process.execPath, else PATH).
    const t = io(home);
    const code = await runCli(["xmtp", "enable"], t.io);
    expect(code, [...t.out, ...t.err].join("\n")).toBe(0);
    const payload = JSON.parse(t.out.at(-1)!) as Record<string, unknown>;
    expect(payload.enabled).toBe(true);
    expect(payload.version).toBe(XMTP_SDK_VERSION);
    // ~725 MB; loosely bounded so this isn't brittle against a minor packaging change.
    expect(payload.sizeMB as number).toBeGreaterThan(100);

    const t2 = io(home);
    expect(await runCli(["xmtp", "status"], t2.io)).toBe(0);
    expect(JSON.parse(t2.out[0])).toEqual({ enabled: true, version: XMTP_SDK_VERSION, env: null });
  }, 600_000);
});

describe("resolveNpmBinary", () => {
  it("ARENA_XMTP_NPM overrides everything -- the one seam tests use", () => {
    const resolved = resolveNpmBinary({
      env: { ARENA_XMTP_NPM: "/some/fake/npm" },
      fetch,
      out: () => {},
      err: () => {},
    });
    expect(resolved).toBe("/some/fake/npm");
  });

  it("falls back to next to process.execPath, else the bare name resolved from PATH", () => {
    const resolved = resolveNpmBinary({ env: {}, fetch, out: () => {}, err: () => {} });
    expect(resolved === "npm" || resolved === "npm.cmd" || /[/\\]npm(\.cmd)?$/.test(resolved)).toBe(true);
  });
});

describe("init copies /templates[chess].xmtp into config.json as xmtp (spec §5)", () => {
  it("a fresh init caches it", async () => {
    const home = freshDir("arena-xmtp-init-");
    const xmtp = { env: "dev", apiUrl: "https://dev.xmtp.test" };
    const code = await runCli(["init", "--server", "http://host.test"], { ...io(home).io, fetch: stubFetch(chessTemplate({ xmtp })) });
    expect(code).toBe(0);
    expect(loadConfig(home).xmtp).toEqual(xmtp);
  });

  it("re-init updates a changed xmtp config", async () => {
    const home = freshDir("arena-xmtp-init-");
    await runCli(["init", "--server", "http://host.test"], { ...io(home).io, fetch: stubFetch(chessTemplate({ xmtp: { env: "dev" } })) });
    expect(loadConfig(home).xmtp).toEqual({ env: "dev" });
    const code = await runCli(["init", "--server", "http://host.test"], {
      ...io(home).io,
      fetch: stubFetch(chessTemplate({ xmtp: { env: "production", gatewayHost: "https://gw.test" } })),
    });
    expect(code).toBe(0);
    expect(loadConfig(home).xmtp).toEqual({ env: "production", gatewayHost: "https://gw.test" });
  });

  it("re-init against a server that stopped publishing xmtp removes the cached config", async () => {
    const home = freshDir("arena-xmtp-init-");
    await runCli(["init", "--server", "http://host.test"], { ...io(home).io, fetch: stubFetch(chessTemplate({ xmtp: { env: "local" } })) });
    expect(loadConfig(home).xmtp).toBeDefined();
    const code = await runCli(["init", "--server", "http://host.test"], { ...io(home).io, fetch: stubFetch(chessTemplate()) });
    expect(code).toBe(0);
    expect(loadConfig(home).xmtp).toBeUndefined();
  });

  it("an invalid xmtp config refuses the whole init and writes nothing, naming the server", async () => {
    const home = freshDir("arena-xmtp-init-");
    const t = io(home);
    const code = await runCli(["init", "--server", "http://host.test"], { ...t.io, fetch: stubFetch(chessTemplate({ xmtp: { env: "bogus" } })) });
    expect(code).toBe(1);
    expect(t.err.join("\n")).toContain("http://host.test published an invalid xmtp config");
    expect(existsSync(arenaPaths(home).config)).toBe(false);
  });

  it("validation reuses loadConfig's own rules: a local gatewayHost is refused the same way", async () => {
    const home = freshDir("arena-xmtp-init-");
    const t = io(home);
    const code = await runCli(["init", "--server", "http://host.test"], {
      ...t.io,
      fetch: stubFetch(chessTemplate({ xmtp: { env: "local", gatewayHost: "https://gw.test" } })),
    });
    expect(code).toBe(1);
    expect(t.err.join("\n")).toContain('xmtp.gatewayHost: is not allowed with env: "local"');
  });
});

describe("arena bot: a hint when xmtp is configured but the fallback is off (spec §4)", () => {
  it("xmtpBotHint is null unless xmtp is configured and the fallback ended up off", () => {
    expect(xmtpBotHint(false, "off")).toBeNull();
    expect(xmtpBotHint(true, "xmtp")).toBeNull();
    expect(xmtpBotHint(false, "xmtp")).toBeNull();
    expect(xmtpBotHint(true, "off")).toMatch(/xmtp enable/);
  });

  it("runBot logs the hint exactly once at startup, before touching the daemon at all, then continues", async () => {
    const controller = new AbortController();
    controller.abort(); // the loop body never runs; only the top-of-function hint log should fire
    const logs: string[] = [];
    const hint = 'bot: xmtp is configured but not enabled on this machine: run "arena xmtp enable" (about 700 MB, one-time)';
    await runBot({} as unknown as ArenaDaemon, {
      usdc: "0x0000000000000000000000000000000000000000" as Address,
      deposit: 0n,
      stake: 0n,
      offers: 0,
      log: (l) => logs.push(l),
      signal: controller.signal,
      xmtpEnableHint: hint,
    });
    expect(logs).toEqual([hint]);
  });

  it("runBot logs nothing extra when there is no hint (xmtp off, or already on)", async () => {
    const controller = new AbortController();
    controller.abort();
    const logs: string[] = [];
    await runBot({} as unknown as ArenaDaemon, {
      usdc: "0x0000000000000000000000000000000000000000" as Address,
      deposit: 0n,
      stake: 0n,
      offers: 0,
      log: (l) => logs.push(l),
      signal: controller.signal,
    });
    expect(logs).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------- bundle (Global Constraints)

const REPO_ROOT = join(import.meta.dirname, "../../..");
const TSX_BIN = join(REPO_ROOT, "node_modules/.bin/tsx");
const BUILD_SCRIPT = join(REPO_ROOT, "scripts/build-cli.ts");

function run(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ status: code ?? 1, stdout, stderr }));
  });
}

describe("build-cli bundles no static @xmtp/ import (Global Constraints: zero-runtime-dependency bundle)", () => {
  it("the published bundle never statically imports/requires @xmtp/ -- only loaded at runtime via a dynamic path", async () => {
    const out = freshDir("arena-xmtp-build-");
    const env = { ...process.env };
    delete env.ARENA_CLI_PACKAGE;
    delete env.ARENA_CLI_LICENSE;
    delete env.ARENA_CLI_REPOSITORY;
    const result = await run(TSX_BIN, [BUILD_SCRIPT, "--out", out], { cwd: REPO_ROOT, env });
    expect(result.status, result.stderr).toBe(0);
    const text = readFileSync(join(out, "arena.mjs"), "utf8");
    expect(text).not.toMatch(/\bfrom\s*["']@xmtp\//);
    expect(text).not.toMatch(/\brequire\(\s*["']@xmtp\//);
    expect(text).not.toMatch(/\bimport\(\s*["']@xmtp\//);
  }, 180_000);
});
