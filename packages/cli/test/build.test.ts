import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
      files: ["arena.mjs", "board"],
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
    expect(result.stderr).toContain("usage: arena");
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

  it("--release writes the license and repository when both are set", async () => {
    const out = freshDir("arena-cli-release-ok-");
    const env = { ...baseEnv(), ARENA_CLI_LICENSE: "MIT", ARENA_CLI_REPOSITORY: "https://github.com/example/arena" };
    const result = await run(TSX_BIN, [BUILD_SCRIPT, "--out", out, "--release"], { cwd: REPO_ROOT, env });
    expect(result.status).toBe(0);
    const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
    expect(pkg.license).toBe("MIT");
    expect(pkg.repository).toEqual({ type: "git", url: "git+https://github.com/example/arena.git" });
  }, 180_000);
});
