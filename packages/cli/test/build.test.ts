import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RPC, deployArena } from "../../sdk/test/helpers/chain.js";
import { initHome, livePidHoldingLock } from "../src/index.js";

// packages/cli/test -> repo root
const REPO_ROOT = join(import.meta.dirname, "../../..");
const TSX_BIN = join(REPO_ROOT, "node_modules/.bin/tsx");
const BUILD_SCRIPT = join(REPO_ROOT, "scripts/build-cli.ts");
const BOARD_SRC = join(REPO_ROOT, "packages/cli/src/board");
const BOARD_FILES = ["api.js", "app.js", "board.js", "index.html", "style.css"];

type RunResult = { status: number; stdout: string; stderr: string };

function run(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<RunResult> {
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

// A hermetic base env: this suite's assertions about the *default* manifest (name, license, no repository) must
// hold regardless of what the ambient shell happens to export.
function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ARENA_CLI_PACKAGE;
  delete env.ARENA_CLI_LICENSE;
  delete env.ARENA_CLI_REPOSITORY;
  return env;
}

function buildCli(out: string, extraEnv: NodeJS.ProcessEnv = {}, extraArgs: string[] = []): Promise<RunResult> {
  return run(TSX_BIN, [BUILD_SCRIPT, "--out", out, ...extraArgs], { cwd: REPO_ROOT, env: { ...baseEnv(), ...extraEnv } });
}

/** Final fix wave (C1): a stand-in arena host on 127.0.0.1 -- `GET /templates` publishes a chess template whose
 *  `cli` entry is `cli`, and `POST /rpc` answers as chain 31337 on which every address holds code -- so the built
 *  bundle's own `init` can be run against it end to end. */
async function startStubHost(cli: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/templates") {
        res.end(
          JSON.stringify([
            {
              id: "chess",
              version: "1",
              chainId: 31337,
              rpcUrl: `${url}/rpc`,
              hub: `0x${"11".repeat(20)}`,
              usdc: `0x${"22".repeat(20)}`,
              rules: `0x${"33".repeat(20)}`,
              cli,
              ...extra,
            },
          ]),
        );
        return;
      }
      const rpc = JSON.parse(body || "{}") as { id?: number; method?: string };
      const result = rpc.method === "eth_chainId" ? "0x7a69" : rpc.method === "eth_gasPrice" ? "0x3b9aca00" : "0x6080";
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? 1, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

describe("build-cli", () => {
  const dirs: string[] = [];
  function freshDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  }

  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  let outDir: string;
  let bundleText: string;

  beforeAll(async () => {
    outDir = freshDir("arena-cli-build-");
    const result = await buildCli(outDir);
    if (result.status !== 0) throw new Error(`build-cli failed (${result.status}): ${result.stderr}`);
    bundleText = readFileSync(join(outDir, "arena.mjs"), "utf8");
  }, 180_000);

  it("exits 0 and writes a manifest with no dependencies, devDependencies, or repository", () => {
    const pkg = JSON.parse(readFileSync(join(outDir, "package.json"), "utf8"));
    expect(pkg).toEqual({
      name: "@arena/cli",
      version: "0.1.0",
      type: "module",
      bin: { arena: "arena.mjs" },
      engines: { node: ">=24" },
      files: ["arena.mjs", "board", "THIRD_PARTY_LICENSES"],
      license: "UNLICENSED",
    });
    expect(Object.prototype.hasOwnProperty.call(pkg, "dependencies")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(pkg, "devDependencies")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(pkg, "repository")).toBe(false);
  });

  it("writes an executable ESM entry with a node shebang", () => {
    expect(bundleText.startsWith("#!/usr/bin/env node")).toBe(true);
    const mode = statSync(join(outDir, "arena.mjs")).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it("copies the board assets byte-identical to packages/cli/src/board/", () => {
    const names = readdirSync(join(outDir, "board")).sort();
    expect(names).toEqual(BOARD_FILES);
    for (const name of names) {
      expect(readFileSync(join(outDir, "board", name))).toEqual(readFileSync(join(BOARD_SRC, name)));
    }
  });

  it("never ships tsx's ESM loader or the repo's absolute path", () => {
    expect(bundleText).not.toContain("tsx/esm");
    expect(bundleText).not.toContain("register()");
    expect(bundleText).not.toContain(REPO_ROOT);
  });

  it("prints the version and exits 0 when run standalone from another cwd", async () => {
    const cwd = freshDir("arena-cli-run-");
    const result = await run(process.execPath, [join(outDir, "arena.mjs"), "--version"], {
      cwd,
      env: { PATH: dirname(process.execPath) },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.0");
  });

  it("exits non-zero with the usage text when run with no arguments", async () => {
    const cwd = freshDir("arena-cli-run-");
    const result = await run(process.execPath, [join(outDir, "arena.mjs")], {
      cwd,
      env: { PATH: dirname(process.execPath) },
    });
    expect(result.status).not.toBe(0);
    // Fix round 1 (M1): USAGE's header now names this build's own selfCommand() -- in this default build
    // (ARENA_CLI_PACKAGE unset) that's "npx -y @arena/cli@0.1.0", never the bare word "arena" an agent running
    // under a pinned npx install could not actually type back.
    expect(result.stderr).toContain("usage: npx -y @arena/cli@0.1.0");
  });

  it("final fix wave (M5): the bundle's own messages name the pinned npx command, never a bare \"arena\"", async () => {
    const home = freshDir("arena-cli-noconfig-");
    const result = await run(process.execPath, [join(outDir, "arena.mjs"), "wallet"], {
      cwd: freshDir("arena-cli-run-"),
      env: { PATH: dirname(process.execPath), HOME: home },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('run "npx -y @arena/cli@0.1.0 init" first');
    // The startup line's board hint and the other agent-facing hints use the same selfCommand() form.
    expect(bundleText).toContain("boardHint: `run: ${CLI_COMMAND} board`");
  });

  it("names the manifest from ARENA_CLI_PACKAGE", async () => {
    const out = freshDir("arena-cli-pkg-");
    const result = await buildCli(out, { ARENA_CLI_PACKAGE: "@x/arena-test" });
    expect(result.status).toBe(0);
    const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
    expect(pkg.name).toBe("@x/arena-test");
  }, 180_000);

  it("Plan 5.6 Task 4 (ruling 3): __ARENA_CLI_PACKAGE__ is substituted into the bundle, for selfCommand()'s npx form", async () => {
    // The default build (ARENA_CLI_PACKAGE unset) embeds the manifest's own default package name.
    expect(bundleText).toContain('"@arena/cli"');
    const out = freshDir("arena-cli-selfcmd-");
    const result = await buildCli(out, { ARENA_CLI_PACKAGE: "@x/arena-test" });
    expect(result.status).toBe(0);
    const text = readFileSync(join(out, "arena.mjs"), "utf8");
    expect(text).toContain('"@x/arena-test"');
  }, 180_000);

  it("--release fails, naming ARENA_CLI_LICENSE, when it is unset", async () => {
    const out = freshDir("arena-cli-release-fail-");
    const result = await run(TSX_BIN, [BUILD_SCRIPT, "--out", out, "--release"], { cwd: REPO_ROOT, env: baseEnv() });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ARENA_CLI_LICENSE");
  }, 180_000);

  it("--release writes the package name, license and repository when all three are set", async () => {
    const out = freshDir("arena-cli-release-ok-");
    const env = {
      ...baseEnv(),
      ARENA_CLI_PACKAGE: "@example/arena",
      ARENA_CLI_LICENSE: "MIT",
      ARENA_CLI_REPOSITORY: "https://github.com/example/arena",
    };
    const result = await run(TSX_BIN, [BUILD_SCRIPT, "--out", out, "--release"], { cwd: REPO_ROOT, env });
    expect(result.status, result.stderr).toBe(0);
    const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
    expect(pkg.name).toBe("@example/arena");
    expect(pkg.license).toBe("MIT");
    expect(pkg.repository).toEqual({ type: "git", url: "git+https://github.com/example/arena.git" });
  }, 180_000);

  it("Final fix wave (M3, K3): --release needs ARENA_CLI_PACKAGE -- never the placeholder -- and an empty or invalid one always fails", async () => {
    const releaseEnv = { ARENA_CLI_LICENSE: "MIT", ARENA_CLI_REPOSITORY: "https://github.com/example/arena" };
    const cases: Array<[NodeJS.ProcessEnv, string[], RegExp]> = [
      [releaseEnv, ["--release"], /--release needs ARENA_CLI_PACKAGE set/],
      // An unset GitHub variable expands to "": that must fail, not fall back to @arena/cli.
      [{ ...releaseEnv, ARENA_CLI_PACKAGE: "" }, ["--release"], /ARENA_CLI_PACKAGE is set but empty/],
      [{ ARENA_CLI_PACKAGE: "" }, [], /ARENA_CLI_PACKAGE is set but empty/],
      [{ ...releaseEnv, ARENA_CLI_PACKAGE: "Not A Name" }, ["--release"], /is not a valid npm package name/],
      [{ ARENA_CLI_PACKAGE: "evil && curl x | sh" }, [], /is not a valid npm package name/],
    ];
    for (const [env, args, message] of cases) {
      const out = freshDir("arena-cli-pkgname-");
      const result = await buildCli(out, env, args);
      expect(result.status, JSON.stringify(env)).not.toBe(0);
      expect(result.stderr).toMatch(message);
      expect(existsSync(join(out, "package.json"))).toBe(false);
    }
  }, 180_000);

  it("Final fix wave (M4): ships THIRD_PARTY_LICENSES, holding the license text of every bundled package, viem's and chess.js's included", () => {
    const notices = readFileSync(join(outDir, "THIRD_PARTY_LICENSES"), "utf8");
    const pnpmStore = join(REPO_ROOT, "node_modules/.pnpm");
    const pkgDir = (prefix: string, name: string) => {
      const entry = readdirSync(pnpmStore).find((d) => d.startsWith(prefix));
      if (!entry) throw new Error(`test setup: no ${prefix}* in ${pnpmStore}`);
      return join(pnpmStore, entry, "node_modules", name);
    };
    for (const [prefix, name, header] of [
      ["viem@2.56.8", "viem", "viem@2.56.8 (MIT)"],
      ["chess.js@1.4.0", "chess.js", "chess.js@1.4.0 (BSD-2-Clause)"],
    ] as const) {
      const dir = pkgDir(prefix, name);
      const licenseFile = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
      expect(licenseFile, name).toBeDefined();
      expect(notices).toContain(header);
      expect(notices).toContain(readFileSync(join(dir, licenseFile!), "utf8").trimEnd());
    }
    // The other inlined dependencies are named too (each one's text is checked the same way by the build itself).
    for (const name of ["ox@", "abitype@", "@noble/curves@", "@noble/hashes@", "@scure/bip32@"]) expect(notices).toContain(`\n${name}`);
  });

  it("Final fix wave (C1): the bundle's init refuses a host that pins a different package -- naming it, with no install command -- and writes nothing", async () => {
    for (const [cli, expected, forbidden] of [
      [
        { package: "arena-cli-next", version: "9.9.9", minVersion: "9.9.9" },
        "error: this server pins a different CLI package (arena-cli-next); refusing: this CLI is @arena/cli. Ask your human",
        ["npx -y arena-cli-next"],
      ],
      [
        { package: "arena-cli-next", version: "0.1.0" }, // even a version this build satisfies: never another package
        "error: this server pins a different CLI package (arena-cli-next); refusing",
        ["npx"],
      ],
      [
        // The same package as this build, below minVersion: the install command names this build's own package.
        { package: "@arena/cli", version: "9.9.9", minVersion: "9.9.9" },
        "install and run it with: npx -y @arena/cli@9.9.9 init --server http://127.0.0.1:",
        ["arena-cli-next"],
      ],
    ] as const) {
      const host = await startStubHost(cli);
      try {
        const home = freshDir("arena-cli-gate-home-");
        const result = await run(process.execPath, [join(outDir, "arena.mjs"), "init", "--server", host.url, "--no-faucet"], {
          cwd: freshDir("arena-cli-gate-cwd-"),
          env: { PATH: dirname(process.execPath), HOME: home },
        });
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(expected);
        for (const f of forbidden) expect(result.stderr).not.toContain(f);
        expect(existsSync(join(home, ".arena", "config.json"))).toBe(false);
      } finally {
        await new Promise<void>((r) => host.server.close(() => r()));
      }
    }
  }, 60_000);

  describe("remote agents: --self-url, a build a host serves as its own tarball", () => {
    const SELF = "http://100.70.62.92:8700/cli/arena-cli-0.1.0-0123456789abcdef.tgz";
    const CMD = `npx -y --prefer-offline --package=${SELF} arena`;
    let selfOut: string;

    beforeAll(async () => {
      selfOut = freshDir("arena-cli-selfurl-");
      const result = await buildCli(selfOut, {}, ["--self-url", SELF]);
      if (result.status !== 0) throw new Error(`build-cli --self-url failed (${result.status}): ${result.stderr}`);
    }, 180_000);

    it("every message names the tarball command, never the placeholder npm package", async () => {
      const cwd = freshDir("arena-cli-run-");
      const env = { PATH: dirname(process.execPath), HOME: freshDir("arena-cli-noconfig-") };
      const usage = await run(process.execPath, [join(selfOut, "arena.mjs")], { cwd, env });
      expect(usage.status).not.toBe(0);
      expect(usage.stderr).toContain(`usage: ${CMD} <command>`);
      const wallet = await run(process.execPath, [join(selfOut, "arena.mjs"), "wallet"], { cwd, env });
      expect(wallet.stderr).toContain(`run "${CMD} init" first`);
      expect(`${usage.stderr}${wallet.stderr}`).not.toContain("@arena/cli@");
      // The manifest is unchanged: the same placeholder name the host pins in /templates.
      expect(JSON.parse(readFileSync(join(selfOut, "package.json"), "utf8")).name).toBe("@arena/cli");
    });

    it("init accepts a host that serves this tarball at its own version; one pinning a newer version is refused with the host's tarball", async () => {
      const tarball = { cliTarball: { url: SELF, sha256: "a".repeat(64) } };
      const ok = await startStubHost({ package: "@arena/cli", version: "0.1.0" }, tarball);
      try {
        const home = freshDir("arena-cli-gate-home-");
        const result = await run(process.execPath, [join(selfOut, "arena.mjs"), "init", "--server", ok.url, "--no-faucet", "--port", "0"], {
          cwd: freshDir("arena-cli-gate-cwd-"),
          env: { PATH: dirname(process.execPath), HOME: home },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(existsSync(join(home, ".arena", "config.json"))).toBe(true);
        expect(JSON.parse(result.stdout)).not.toHaveProperty("cliUpgrade");
      } finally {
        await new Promise<void>((r) => ok.server.close(() => r()));
      }
      const newer = await startStubHost({ package: "@arena/cli", version: "0.2.0" }, { cliTarball: { url: SELF.replace("0.1.0-", "0.2.0-"), sha256: "b".repeat(64) } });
      try {
        const home = freshDir("arena-cli-gate-home-");
        const result = await run(process.execPath, [join(selfOut, "arena.mjs"), "init", "--server", newer.url, "--no-faucet"], {
          cwd: freshDir("arena-cli-gate-cwd-"),
          env: { PATH: dirname(process.execPath), HOME: home },
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          `this host requires arena CLI version 0.2.0 or newer (you are running 0.1.0): install and run it with: npx -y --prefer-offline --package=${SELF.replace("0.1.0-", "0.2.0-")} arena init --server ${newer.url}`,
        );
        expect(existsSync(join(home, ".arena", "config.json"))).toBe(false);
      } finally {
        await new Promise<void>((r) => newer.server.close(() => r()));
      }
    }, 60_000);

    it("refuses a --self-url that is not a plain http(s) .tgz URL, and --self-url with --release", async () => {
      for (const bad of ["http://h/cli/a.tgz;id", "http://u:p@h/a.tgz", "http://h/a.tar", "/tmp/a.tgz"]) {
        const result = await buildCli(freshDir("arena-cli-selfurl-bad-"), {}, ["--self-url", bad]);
        expect(result.status, bad).not.toBe(0);
        expect(result.stderr).toContain("--self-url needs a plain http(s) URL ending in .tgz");
      }
      const release = await buildCli(freshDir("arena-cli-selfurl-rel-"), {}, ["--self-url", SELF, "--release"]);
      expect(release.status).not.toBe(0);
      expect(release.stderr).toContain("--self-url is for a host's own tarball, never a --release build");
    }, 60_000);
  });

  it("H4: the bundle's daemon --detach, run the way npx runs it (a node_modules/.bin link), starts the bundle itself, detached", async () => {
    const env = await deployArena();
    const home = freshDir("arena-cli-detach-home-");
    initHome(
      home,
      {
        rpcUrl: RPC,
        chainId: env.domain.chainId,
        hub: env.hub,
        usdc: env.usdc,
        rules: env.rules,
        serverUrl: "http://127.0.0.1:9", // closed: the host connection only retries in the background
        port: 0,
        maxFeePerPlayer: 10_000n,
        sessionGasWei: 10n ** 16n,
        pollMs: 100,
        minChallengeTimeout: 60n,
      },
      generatePrivateKey(),
    );
    const bin = join(freshDir("arena-cli-npx-"), "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(join(outDir, "arena.mjs"), join(bin, "arena"));
    const result = await run(join(bin, "arena"), ["daemon", "--detach"], {
      cwd: freshDir("arena-cli-run-"),
      env: { PATH: dirname(process.execPath), ARENA_HOME: home },
    });
    expect(result.status, result.stderr).toBe(0);
    const line = JSON.parse(result.stdout.trim()) as { detached: boolean; pid: number; api: string; log: string };
    try {
      expect(line.detached).toBe(true);
      // The child is node running the bundle -- never the link's shell, never npx again -- in a session of its own.
      const cmdline = readFileSync(`/proc/${line.pid}/cmdline`, "utf8").split("\0");
      expect(cmdline[0]).toBe(process.execPath);
      expect(realpathSync(cmdline[1]!)).toBe(realpathSync(join(outDir, "arena.mjs")));
      expect(cmdline.slice(2)).toEqual(["daemon", ""]);
      expect(Number(readFileSync(`/proc/${line.pid}/stat`, "utf8").split(") ")[1]!.split(" ")[3])).toBe(line.pid);
      expect((await fetch(`${line.api}/health`)).status).toBe(200);
    } finally {
      if (livePidHoldingLock(home) === line.pid) process.kill(line.pid, "SIGTERM");
      const end = Date.now() + 20_000;
      while (livePidHoldingLock(home) === line.pid && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    }
    expect(livePidHoldingLock(home)).toBeNull();
  }, 120_000);
});
