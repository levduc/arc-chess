import { readFileSync } from "node:fs";

/** Replaced by esbuild's `define` in the published bundle; undefined when running from source under tsx. */
declare const __ARENA_CLI_VERSION__: string | undefined;

export function cliVersion(): string {
  if (typeof __ARENA_CLI_VERSION__ === "string") return __ARENA_CLI_VERSION__;
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
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
