/**
 * `pnpm build:cli [--out DIR] [--release]`
 *
 * Bundles the `arena` CLI (packages/cli/src/bin-entry.ts) and everything it imports -- the SDK, viem, chess.js --
 * into one zero-dependency ESM file (`DIR/arena.mjs`, default `DIR` is `packages/cli/dist`), copies the board
 * assets next to it (`DIR/board/*`), and writes a generated `DIR/package.json` manifest. No `tsx` at runtime: the
 * bundle calls `main(process.argv.slice(2))` directly.
 *
 * The manifest's `name` defaults to `@arena/cli` (a placeholder until the real package name is picked) and can be
 * overridden with `ARENA_CLI_PACKAGE`, for building a test tarball under a throwaway name. A set `ARENA_CLI_PACKAGE`
 * must be a valid npm package name -- an empty one (an unset GitHub variable expands to "") is an error, never the
 * default. `license` defaults to `UNLICENSED` for a dev build; `ARENA_CLI_LICENSE` overrides it. `repository` is
 * included only when `ARENA_CLI_REPOSITORY` is set. `--release` is for the (never-run) publish workflow: it requires
 * `ARENA_CLI_LICENSE`, `ARENA_CLI_REPOSITORY` and `ARENA_CLI_PACKAGE` to be set, and fails loudly otherwise.
 *
 * `DIR/THIRD_PARTY_LICENSES` holds the license text of every npm package the bundle inlines (viem, chess.js, ...),
 * found from esbuild's metafile and read from each package's own LICENSE file in node_modules. The build fails if a
 * bundled package ships no license file, so the notice can never silently go missing.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build, type Metafile } from "esbuild";
import { isNpmPackageName } from "../packages/cli/src/version.ts";

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

/** The root directory of every npm package esbuild bundled: each input under `node_modules/` belongs to the package
 *  named right after its last `node_modules/` (`name` or `@scope/name`). Workspace packages (the SDK) resolve to
 *  their source under `packages/`, not `node_modules/`, so they are this project's own code, not third-party. */
function bundledPackageDirs(metafile: Metafile): string[] {
  const dirs = new Set<string>();
  for (const input of Object.keys(metafile.inputs)) {
    const at = input.lastIndexOf("node_modules/");
    if (at < 0) continue;
    const parts = input.slice(at + "node_modules/".length).split("/");
    const nameParts = parts[0].startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1);
    dirs.add(join(REPO_ROOT, input.slice(0, at), "node_modules", ...nameParts));
  }
  return [...dirs];
}

const LICENSE_FILE = /^(licen[cs]e|copying)([.-].*)?$/i;

/** Final fix wave (M4): the license text of every bundled package, one section each, sorted by name@version. */
function thirdPartyLicenses(metafile: Metafile): string {
  const sections = new Map<string, string>();
  for (const dir of bundledPackageDirs(metafile)) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; version: string; license?: unknown };
    const id = `${pkg.name}@${pkg.version}`;
    if (sections.has(id)) continue;
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort() : [];
    if (files.length === 0) throw new Error(`bundled package ${id} (${dir}) ships no LICENSE file; refusing to build without its notice`);
    const license = typeof pkg.license === "string" ? ` (${pkg.license})` : "";
    const texts = files.map((f) => readFileSync(join(dir, f), "utf8").trimEnd()).join("\n\n");
    sections.set(id, `${"=".repeat(80)}\n${id}${license}\n${"=".repeat(80)}\n\n${texts}\n`);
  }
  const ids = [...sections.keys()].sort();
  return [
    "Third-party software bundled into arena.mjs",
    "",
    `arena.mjs inlines the following ${ids.length} npm packages. Each one's license text follows, as shipped in the package.`,
    "",
    ...ids.map((id) => sections.get(id)!),
  ].join("\n");
}

async function main(): Promise<void> {
  const { out, release } = parseArgs(process.argv.slice(2));
  const cliPkg = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8")) as { version: string };
  const version = cliPkg.version;

  if (release && !process.env.ARENA_CLI_LICENSE) {
    throw new Error("--release needs ARENA_CLI_LICENSE set (the published manifest's license)");
  }
  if (release && !process.env.ARENA_CLI_REPOSITORY) {
    throw new Error("--release needs ARENA_CLI_REPOSITORY set (the published manifest's repository URL)");
  }
  // Final fix wave (M3, K3): never publish under the placeholder name, and never let an empty ARENA_CLI_PACKAGE (an
  // unset GitHub variable) fall back to it -- `??` alone would have written a manifest named "".
  const rawName = process.env.ARENA_CLI_PACKAGE;
  if (release && rawName === undefined) {
    throw new Error("--release needs ARENA_CLI_PACKAGE set (the published package's npm name)");
  }
  if (rawName !== undefined && !isNpmPackageName(rawName)) {
    throw new Error(
      rawName === ""
        ? "ARENA_CLI_PACKAGE is set but empty: set it to the npm package name, or unset it for a dev build"
        : `ARENA_CLI_PACKAGE ${JSON.stringify(rawName)} is not a valid npm package name`,
    );
  }
  const name = rawName ?? "@arena/cli";
  const license = process.env.ARENA_CLI_LICENSE ?? "UNLICENSED";
  const repositoryUrl = process.env.ARENA_CLI_REPOSITORY;

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const result = await build({
    metafile: true,
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

  // Plan 5.7 (Global Constraints): the bundle stays zero-runtime-dependency and must never contain the XMTP SDK
  // (native bindings, about 725 MB) -- it is loaded only via a dynamic import() resolved at runtime from
  // <home>/xmtp/sdk, installed separately by "arena xmtp enable". A hard build-time guarantee, not only a test:
  // this fails the build loudly if `@xmtp/` is ever actually bundled in, whether from a future static import or
  // an accidental dependency pull-in -- checked against the metafile's own resolved input paths, which name the
  // real on-disk package directory regardless of how it got there (a workspace symlink, pnpm's store layout, ...).
  const xmtpInput = Object.keys(result.metafile.inputs).find((input) => input.includes("node_modules/@xmtp/"));
  if (xmtpInput) {
    throw new Error(
      `bundled an XMTP SDK module (${xmtpInput}): the published CLI must never bundle @xmtp/node-sdk -- it is ` +
        'installed at runtime by "arena xmtp enable", never a build-time dependency',
    );
  }

  writeFileSync(join(out, "THIRD_PARTY_LICENSES"), thirdPartyLicenses(result.metafile));

  const boardOut = join(out, "board");
  mkdirSync(boardOut, { recursive: true });
  for (const file of BOARD_FILES) copyFileSync(join(BOARD_SRC, file), join(boardOut, file));

  const manifest: Record<string, unknown> = {
    name,
    version,
    type: "module",
    bin: { arena: "arena.mjs" },
    engines: { node: ">=24" },
    files: ["arena.mjs", "board", "THIRD_PARTY_LICENSES"],
    license,
  };
  if (repositoryUrl) manifest.repository = { type: "git", url: `git+${repositoryUrl.replace(/\.git$/, "")}.git` };
  writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`build-cli: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
