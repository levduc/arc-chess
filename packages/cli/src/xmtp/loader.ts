import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Plan 5.7 (spec §4): the one `@xmtp/node-sdk` version this CLI is written and tested against. `arena xmtp enable`
 *  installs exactly this version, and the loader refuses any other. */
export const XMTP_SDK_VERSION = "6.1.0";

export type XmtpSdkLoad = { ok: true; sdk: unknown; version: string } | { ok: false; reason: string };

/** Where `arena xmtp enable` installs the SDK: `<home>/xmtp/sdk` is an npm prefix, so the package lands under its
 *  `node_modules`. */
export function xmtpSdkNodeModules(home: string): string {
  return join(home, "xmtp", "sdk", "node_modules");
}

const errorText = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err));

/**
 * Plan 5.7: loads `@xmtp/node-sdk` from `<home>/xmtp/sdk/node_modules`, never from the CLI's own dependencies: the
 * published bundle stays zero-dependency, and the SDK (native bindings, about 480 MB installed) is opt-in. Never throws: a
 * missing install, a different version, a corrupt package or a native binary that fails to load all come back as
 * `{ ok: false, reason }`, and the daemon then runs with the host relay alone (`fallback: "off"`).
 */
export async function loadXmtpSdk(home: string): Promise<XmtpSdkLoad> {
  return loadXmtpSdkFrom(xmtpSdkNodeModules(home));
}

/** `loadXmtpSdk` against any `node_modules` directory (the opt-in smoke test points it at a throwaway install). */
export async function loadXmtpSdkFrom(nodeModules: string): Promise<XmtpSdkLoad> {
  const dir = join(nodeModules, "@xmtp", "node-sdk");
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return { ok: false, reason: `the XMTP SDK is not installed (no ${manifestPath}): run "arena xmtp enable"` };
  let manifest: { version?: unknown; main?: unknown; exports?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
  } catch (err) {
    return { ok: false, reason: `the XMTP SDK's package.json is unreadable: ${errorText(err)}` };
  }
  if (manifest.version !== XMTP_SDK_VERSION) {
    return {
      ok: false,
      reason: `the installed XMTP SDK is version ${JSON.stringify(manifest.version)}, but this CLI needs ${XMTP_SDK_VERSION}: run "arena xmtp enable"`,
    };
  }
  const entry = entryOf(manifest);
  let mod: Record<string, unknown>;
  try {
    // A computed file URL, never a bare "@xmtp/..." specifier: the bundler leaves it alone, and Node resolves the
    // SDK's own dependencies (its native bindings) from where it is installed.
    mod = (await import(pathToFileURL(join(dir, entry)).href)) as Record<string, unknown>;
  } catch (err) {
    return { ok: false, reason: `the XMTP SDK failed to load: ${errorText(err)}` };
  }
  const client = mod.Client as { create?: unknown } | undefined;
  const kinds = mod.IdentifierKind as Record<string, unknown> | undefined;
  if (typeof client?.create !== "function" || typeof kinds !== "object" || kinds === null || typeof kinds.Ethereum !== "number") {
    return { ok: false, reason: "the XMTP SDK loaded, but does not export Client.create and IdentifierKind.Ethereum" };
  }
  return { ok: true, sdk: mod, version: XMTP_SDK_VERSION };
}

/** The package's ESM entry: `exports["."].default` (or `.import`), else `main`, else `index.js`. */
function entryOf(manifest: { main?: unknown; exports?: unknown }): string {
  const exp = manifest.exports;
  if (typeof exp === "string") return exp;
  if (typeof exp === "object" && exp !== null) {
    const dot = (exp as Record<string, unknown>)["."];
    if (typeof dot === "string") return dot;
    if (typeof dot === "object" && dot !== null) {
      const d = dot as Record<string, unknown>;
      if (typeof d.import === "string") return d.import;
      if (typeof d.default === "string") return d.default;
    }
  }
  return typeof manifest.main === "string" ? manifest.main : "index.js";
}
