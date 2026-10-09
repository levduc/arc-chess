import { readFileSync } from "node:fs";

/** Replaced by esbuild's `define` in the published bundle; undefined when running from source under tsx. */
declare const __ARENA_CLI_VERSION__: string | undefined;
/** Plan 5.6 Task 4 (ruling 3): the published npm package name, set by `scripts/build-cli.ts`'s `define` from the
 *  same `ARENA_CLI_PACKAGE` value as the manifest's `name`; undefined when running from source under tsx. */
declare const __ARENA_CLI_PACKAGE__: string | undefined;

export function cliVersion(): string {
  if (typeof __ARENA_CLI_VERSION__ === "string") return __ARENA_CLI_VERSION__;
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

/**
 * Plan 5.6 Task 4 (ruling 3): how this *running* CLI refers to itself in a message a human or agent must run
 * (re-invoking it, not installing some other pinned version). In the published bundle, where
 * `__ARENA_CLI_PACKAGE__` is set, it is the exact `npx` form that would re-run this same build:
 * `npx -y <package>@<this build's own version>`. Under `tsx` (both defines undefined, as in every unit test and
 * dev run) it is simply `arena`. Never use this to build the init version gate's *install* hint -- that names
 * the host's required package/version from `/templates`, which this build cannot know about itself.
 */
export function selfCommand(): string {
  if (typeof __ARENA_CLI_PACKAGE__ === "string") return `npx -y ${__ARENA_CLI_PACKAGE__}@${cliVersion()}`;
  return "arena";
}

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw new TypeError(`not a plain x.y.z version: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
