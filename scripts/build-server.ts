/**
 * `pnpm build:server [--out DIR]`
 *
 * Builds what the self-host image (`deploy/host/Dockerfile`) runs, into `DIR` (default `apps/server/dist`):
 * - `arena-host.mjs`: the host server (apps/server/src/host-entry.ts) and everything it imports -- the SDK, viem, ws --
 *   bundled into one zero-dependency ESM file, like `pnpm build:cli`'s `arena.mjs`. No tsx, no node_modules at run time.
 * - `share/assets.json` (`HostAssets`, apps/server/src/selfhost.ts): the CLI release the host advertises by default
 *   (`ARENA_CLI_PACKAGE`, default `arc-chess`, the name release-cli.yml publishes under, at packages/cli/package.json's
 *   version) and the deployments the image may serve: per network, only one that `contracts/deployments/<chainId>.json`
 *   records with its `deployBlock` AND the CLI pins in `KNOWN_DEPLOYMENTS` (`hostDeployments`). Arc mainnet ships
 *   only once both exist; until then `missing` says what is absent and the container refuses `NETWORK=arc-mainnet`.
 * - `THIRD_PARTY_LICENSES`: the license text of every npm package the bundle inlines.
 *
 * The pins are read here, at build time, so the server's runtime never depends on the CLI package.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { KNOWN_DEPLOYMENTS } from "../packages/cli/src/config.ts";
import { isNpmPackageName } from "../packages/cli/src/version.ts";
import { hostDeployments, type HostAssets } from "../apps/server/src/selfhost.ts";
import { thirdPartyLicenses } from "./bundle-licenses.ts";

const REPO_ROOT = join(import.meta.dirname, "..");
const SERVER_DIR = join(REPO_ROOT, "apps/server");

function parseArgs(argv: string[]): { out: string } {
  let out = join(SERVER_DIR, "dist");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error("--out needs a value");
      out = v;
      i++;
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  return { out };
}

/** The assets for `share/assets.json`, from this checkout. */
function buildHostAssets(env: NodeJS.ProcessEnv = process.env): HostAssets {
  const rawName = env.ARENA_CLI_PACKAGE;
  if (rawName !== undefined && !isNpmPackageName(rawName)) throw new Error(`ARENA_CLI_PACKAGE ${JSON.stringify(rawName)} is not a valid npm package name`);
  const cliPkg = JSON.parse(readFileSync(join(REPO_ROOT, "packages/cli/package.json"), "utf8")) as { version: string };
  const { deployments, missing } = hostDeployments({
    pins: KNOWN_DEPLOYMENTS,
    readDeployment: (chainId) => {
      const file = join(REPO_ROOT, "contracts/deployments", `${chainId}.json`);
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as unknown) : null;
    },
  });
  if (Object.keys(deployments).length === 0) throw new Error(`no network can be served: ${JSON.stringify(missing)}`);
  return { cli: { package: rawName ?? "arc-chess", version: cliPkg.version }, deployments, missing };
}

async function main(): Promise<void> {
  const { out } = parseArgs(process.argv.slice(2));
  const assets = buildHostAssets();

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "share"), { recursive: true });
  const result = await build({
    metafile: true,
    entryPoints: [join(SERVER_DIR, "src/host-entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: join(out, "arena-host.mjs"),
    minify: false,
    sourcemap: false,
    legalComments: "inline",
    absWorkingDir: REPO_ROOT,
    // As in build-cli.ts: CJS dependencies (ws) call require() for Node built-ins, and ws's optional native
    // accelerators (`bufferutil`, `utf-8-validate`) are required inside their own try/catch and never installed.
    banner: { js: "import { createRequire as __arenaRequire } from 'node:module';\nconst require = __arenaRequire(import.meta.url);" },
  });
  writeFileSync(join(out, "THIRD_PARTY_LICENSES"), thirdPartyLicenses(result.metafile, REPO_ROOT, "arena-host.mjs"));
  writeFileSync(join(out, "share/assets.json"), `${JSON.stringify(assets, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ out, cli: assets.cli, networks: Object.keys(assets.deployments), missing: assets.missing })}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`build-server: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
