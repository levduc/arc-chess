import { readFileSync } from "node:fs";

/** Replaced by esbuild's `define` in the published bundle; undefined when running from source under tsx. */
declare const __ARENA_CLI_VERSION__: string | undefined;
/** Plan 5.6 Task 4 (ruling 3): the published npm package name, set by `scripts/build-cli.ts`'s `define` from the
 *  same `ARENA_CLI_PACKAGE` value as the manifest's `name`; undefined when running from source under tsx. */
declare const __ARENA_CLI_PACKAGE__: string | undefined;
/** Remote agents: the URL of the tarball this build is served as, when a host serves the CLI itself instead of npm --
 *  set by `scripts/build-cli.ts --self-url`; undefined in an npm build and under tsx. */
declare const __ARENA_CLI_TARBALL_URL__: string | undefined;

export function cliVersion(): string {
  if (typeof __ARENA_CLI_VERSION__ === "string") return __ARENA_CLI_VERSION__;
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

/**
 * Plan 5.6 Task 4 (ruling 3): how this *running* CLI refers to itself in a message a human or agent must run
 * (re-invoking it, not installing some other pinned version). In the published bundle, where
 * `__ARENA_CLI_PACKAGE__` is set, it is the exact `npx` form that would re-run this same build:
 * `npx -y <package>@<this build's own version>`. Remote agents: a build packed for a host that serves it itself
 * (`__ARENA_CLI_TARBALL_URL__`) names that tarball instead (`tarballCommand`) -- its package name is a placeholder
 * nobody published, so the npm form would fetch someone else's package, or nothing. Under `tsx` (all defines
 * undefined, as in every unit test and dev run) it is simply `arena`. Never use this to build the init version
 * gate's *install* hint -- that names the host's required package/version from `/templates`, which this build cannot
 * know about itself.
 */
export function selfCommand(): string {
  return commandFor({
    package: typeof __ARENA_CLI_PACKAGE__ === "string" ? __ARENA_CLI_PACKAGE__ : undefined,
    version: cliVersion(),
    tarballUrl: typeof __ARENA_CLI_TARBALL_URL__ === "string" ? __ARENA_CLI_TARBALL_URL__ : undefined,
  });
}

/** `selfCommand`'s choice, as a pure function so a test can stand in for each kind of build. */
export function commandFor(build: { package: string | undefined; version: string; tarballUrl: string | undefined }): string {
  if (build.tarballUrl !== undefined) return tarballCommand(build.tarballUrl);
  if (build.package !== undefined) return `npx -y ${build.package}@${build.version}`;
  return "arena";
}

/** Remote agents: a tarball URL as a host serves it -- an http(s) origin and a path of plain characters ending in
 *  `.tgz`, nothing a shell treats specially (no credentials, query, space, `$`, quote or `;`). Copied from the server
 *  config's own check (`CLI_TARBALL_URL_RE` in apps/server/src/config.ts), the way `NPM_PACKAGE_NAME` was. */
const TARBALL_URL = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~-]+)*\.tgz$/;

export function isTarballUrl(s: unknown): s is string {
  return typeof s === "string" && TARBALL_URL.test(s);
}

/**
 * Remote agents: the command that runs the CLI from a tarball URL -- the same string the server derives as its
 * `cliCommand` (`cliTarballCommand`, apps/server/src/config.ts). `--package=<url> arena` installs that one file (no
 * dependencies, so no registry) and runs its `arena` bin; `--prefer-offline` runs the installed copy without asking
 * the host again, so a host that is down costs nothing (npm's retries take about 70 s per command otherwise). The
 * URL's name changes with its content, so that copy is never stale.
 */
export function tarballCommand(url: string): string {
  return `npx -y --prefer-offline --package=${url} arena`;
}

/** Remote agents: the tarball URL baked into this build (`build-cli --self-url`) -- a build a host serves as its own
 *  tarball -- or undefined in an npm (release) build and under tsx. */
export function selfTarballUrl(): string | undefined {
  return typeof __ARENA_CLI_TARBALL_URL__ === "string" ? __ARENA_CLI_TARBALL_URL__ : undefined;
}

/** The path a host serves its CLI tarball at (`GET /cli/<name>`, apps/server). */
const SERVED_TARBALL_PATH = /^\/cli\/[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/;

/**
 * Fix round 1 (C-1): the host's tarball URL, only when this build may repeat it -- a plain URL on the same origin as
 * the build's own baked one, at a `/cli/<name>.tgz` path: the host that served this build, serving a newer one. Any
 * other origin is code the host chose, not a version of this CLI (the C1 rule: a host may pin a version of this CLI,
 * never other code). Undefined otherwise, and always in a build with no baked URL.
 */
export function sameHostTarballUrl(url: unknown, self: string | undefined): string | undefined {
  if (self === undefined || !isTarballUrl(url)) return undefined;
  try {
    const there = new URL(url);
    // Re-review N-2: the parsed URL, not the raw string: `0x64.70.62.92`, `:08700` or `/cli/../cli/` would otherwise be
    // repeated as written (npx keys its cache on that string). Its canonical form keeps to `TARBALL_URL`'s characters.
    const same = there.origin === new URL(self).origin && SERVED_TARBALL_PATH.test(there.pathname) && isTarballUrl(there.href);
    return same ? there.href : undefined;
  } catch {
    // `TARBALL_URL` admits a few hosts the URL parser refuses (`999.1.1.1`, `100.70.62.092`): no echo, never a crash.
    return undefined;
  }
}

/** Final fix wave (C1): the npm package name this build was published under -- `__ARENA_CLI_PACKAGE__`, defined only
 *  in the bundle -- or undefined under tsx (every unit test and dev run). */
export function cliPackage(): string | undefined {
  return typeof __ARENA_CLI_PACKAGE__ === "string" ? __ARENA_CLI_PACKAGE__ : undefined;
}

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** Final fix wave (C1): npm package-name syntax, copied from the server config's own check (`CLI_PACKAGE_RE` in
 *  apps/server/src/config.ts), the way `SEMVER` was copied the other way: lowercase, optionally `@scope/name`, at
 *  most 214 characters. No space, `&`, `;`, `|`, `$` or quote can pass it. */
const NPM_PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export function isNpmPackageName(s: string): boolean {
  return s.length <= 214 && NPM_PACKAGE_NAME.test(s);
}

/** Final fix wave (C1): what `init` does with the `cli` entry a host publishes in `/templates`. */
export type HostCliVerdict = { refusal: string } | { upgrade?: string };

/**
 * Final fix wave (C1): the `init` version gate, as a pure function so a test can stand in for the bundle by passing
 * `ownPackage` (in `init` it is `cliPackage()`). Everything here comes from the host, so nothing raw is ever echoed:
 * - a `cli` entry whose `package` is not a valid npm name, or whose `version`/`minVersion` is not a strict `x.y.z`
 *   (or whose `minVersion` is above its `version`), is refused with a short description of what is wrong;
 * - in the bundle (`ownPackage` set), a host that pins a different package is refused, naming the validated name
 *   only and no install command: a host may pin a version of this CLI, never another package;
 * - below `minVersion`, it refuses with the install command for this same package at the host's `version` -- or, in a
 *   build a host serves as its own tarball (`selfTarballUrl`), with that host's tarball command when it is on the
 *   build's own origin, and no command otherwise;
 * - below `version` only, it returns an `upgrade` note; otherwise `{}`.
 */
export function hostCliVerdict(
  raw: Record<string, unknown>,
  ctx: { ownPackage: string | undefined; current: string; server: string; selfTarballUrl?: string; tarball?: { url?: unknown } },
): HostCliVerdict {
  const malformed = (what: string) => ({ refusal: `the server's ${what}; refusing (ask your human)` });
  const pkg = raw.package;
  if (typeof pkg !== "string" || !isNpmPackageName(pkg)) return malformed("cli.package is not a valid npm package name");
  const version = raw.version;
  if (typeof version !== "string" || !SEMVER.test(version)) return malformed("cli.version is not a plain x.y.z version");
  const minVersionRaw = raw.minVersion;
  if (minVersionRaw !== undefined && (typeof minVersionRaw !== "string" || !SEMVER.test(minVersionRaw))) {
    return malformed("cli.minVersion is not a plain x.y.z version");
  }
  const minVersion = minVersionRaw ?? version;
  if (compareSemver(minVersion, version) > 0) return malformed("cli.minVersion is above its cli.version");
  if (ctx.ownPackage !== undefined && pkg !== ctx.ownPackage) {
    return { refusal: `this server pins a different CLI package (${pkg}); refusing: this CLI is ${ctx.ownPackage}. Ask your human` };
  }
  if (compareSemver(ctx.current, minVersion) < 0) {
    // Never this build's own selfCommand(): in the bundle that is `npx -y <pkg>@<this too-old version>`, the very
    // command just refused. The package is validated above (and, in the bundle, is this build's own). The server URL
    // is the caller's own --server; it goes into the command only if it holds no shell metacharacter.
    const server = /^https?:\/\/[A-Za-z0-9._~:/%@-]+$/.test(ctx.server) ? ctx.server : "<server URL>";
    const need = `this host requires arena CLI version ${minVersion} or newer (you are running ${ctx.current})`;
    // Fix round 1 (C-1): only a build a host serves as its own tarball (one with a baked URL) ever looks at the host's
    // `cliTarball`, and it repeats that URL only on its own origin (`sameHostTarballUrl`); otherwise it names no
    // command at all -- never another origin, and never the npm form of its placeholder package name, which is not
    // ours on npm. An npm build and tsx ignore `cliTarball` entirely: their refusal is the npm one, as before.
    if (ctx.selfTarballUrl !== undefined) {
      const url = sameHostTarballUrl(ctx.tarball?.url, ctx.selfTarballUrl);
      return {
        refusal:
          url !== undefined
            ? `${need}: install and run it with: ${tarballCommand(url)} init --server ${server}`
            : `${need}: install it as step 0 of this host's skill.md says`,
      };
    }
    return { refusal: `${need}: install and run it with: npx -y ${pkg}@${version} init --server ${server}` };
  }
  return compareSemver(ctx.current, version) < 0 ? { upgrade: `a newer CLI (${version}) is available; you are running ${ctx.current}` } : {};
}

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
