/**
 * `pnpm build:cli [--out DIR] [--release]`
 *
 * Bundles the `arena` CLI (packages/cli/src/bin-entry.ts) and everything it imports -- the SDK, viem, chess.js --
 * into one zero-dependency ESM file (`DIR/arena.mjs`, default `DIR` is `packages/cli/dist`), copies the board
 * assets next to it (`DIR/board/*`), and writes a generated `DIR/package.json` manifest. No `tsx` at runtime: the
 * bundle calls `main(process.argv.slice(2))` directly.
 *
 * The manifest's `name` defaults to `@arena/cli` (a placeholder until the real package name is picked) and can be
 * overridden with `ARENA_CLI_PACKAGE`, for building a test tarball under a throwaway name. `license` defaults to
 * `UNLICENSED` for a dev build; `ARENA_CLI_LICENSE` overrides it. `repository` is included only when
 * `ARENA_CLI_REPOSITORY` is set. `--release` is for the (never-run) publish workflow: it requires both
 * `ARENA_CLI_LICENSE` and `ARENA_CLI_REPOSITORY` to be set, and fails loudly otherwise.
 */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const REPO_ROOT = join(import.meta.dirname, "..");
const CLI_DIR = join(REPO_ROOT, "packages/cli");
const BOARD_SRC = join(CLI_DIR, "src/board");
const BOARD_FILES = ["index.html", "app.js", "board.js", "api.js", "style.css"];

function parseArgs(argv: string[]): { out: string; release: boolean } {
  let out = join(CLI_DIR, "dist");
  let release = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error("--out needs a value");
      out = v;
      i++;
    } else if (a === "--release") {
      release = true;
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  return { out, release };
}

async function main(): Promise<void> {
  const { out, release } = parseArgs(process.argv.slice(2));
  const cliPkg = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8")) as { version: string };
  const version = cliPkg.version;

  const name = process.env.ARENA_CLI_PACKAGE ?? "@arena/cli";
  if (release && !process.env.ARENA_CLI_LICENSE) {
    throw new Error("--release needs ARENA_CLI_LICENSE set (the published manifest's license)");
  }
  if (release && !process.env.ARENA_CLI_REPOSITORY) {
    throw new Error("--release needs ARENA_CLI_REPOSITORY set (the published manifest's repository URL)");
  }
  const license = process.env.ARENA_CLI_LICENSE ?? "UNLICENSED";
  const repositoryUrl = process.env.ARENA_CLI_REPOSITORY;

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  await build({
    entryPoints: [join(CLI_DIR, "src/bin-entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: join(out, "arena.mjs"),
    minify: false,
    sourcemap: false,
    legalComments: "inline",
    absWorkingDir: REPO_ROOT,
    define: { __ARENA_CLI_VERSION__: JSON.stringify(version), __ARENA_CLI_PACKAGE__: JSON.stringify(name) },
    // CJS dependencies bundled into ESM call require() for Node built-ins (and viem's WebSocket shim, `isows`,
    // statically imports `ws`, whose optional native accelerators `bufferutil`/`utf-8-validate` are requested
    // inside their own try/catch and are never installed here) -- give the bundle one `require`.
    banner: { js: "#!/usr/bin/env node\nimport { createRequire as __arenaRequire } from 'node:module';\nconst require = __arenaRequire(import.meta.url);" },
  });
  chmodSync(join(out, "arena.mjs"), 0o755);

  const boardOut = join(out, "board");
  mkdirSync(boardOut, { recursive: true });
  for (const file of BOARD_FILES) copyFileSync(join(BOARD_SRC, file), join(boardOut, file));

  const manifest: Record<string, unknown> = {
    name,
    version,
    type: "module",
    bin: { arena: "arena.mjs" },
    engines: { node: ">=24" },
    files: ["arena.mjs", "board"],
    license,
  };
  if (repositoryUrl) manifest.repository = { type: "git", url: `git+${repositoryUrl.replace(/\.git$/, "")}.git` };
  writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`build-cli: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
