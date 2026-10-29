/**
 * The `THIRD_PARTY_LICENSES` notice of an esbuild bundle (`pnpm build:cli`'s `arena.mjs`, the self-host image's
 * `arena-host.mjs`): the license text of every npm package the bundle inlines, found from esbuild's metafile and read
 * from each package's own LICENSE file in node_modules. A bundled package that ships no license file fails the build,
 * so the notice can never silently go missing.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Metafile } from "esbuild";

/** The root directory of every npm package esbuild bundled: each input under `node_modules/` belongs to the package
 *  named right after its last `node_modules/` (`name` or `@scope/name`). Workspace packages (the SDK) resolve to
 *  their source under `packages/`, not `node_modules/`, so they are this project's own code, not third-party. */
function bundledPackageDirs(metafile: Metafile, repoRoot: string): string[] {
  const dirs = new Set<string>();
  for (const input of Object.keys(metafile.inputs)) {
    const at = input.lastIndexOf("node_modules/");
    if (at < 0) continue;
    const parts = input.slice(at + "node_modules/".length).split("/");
    const nameParts = parts[0].startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1);
    dirs.add(join(repoRoot, input.slice(0, at), "node_modules", ...nameParts));
  }
  return [...dirs];
}

const LICENSE_FILE = /^(licen[cs]e|copying)([.-].*)?$/i;

/** Final fix wave (M4): the license text of every bundled package, one section each, sorted by name@version. */
export function thirdPartyLicenses(metafile: Metafile, repoRoot: string, bundleName: string): string {
  const sections = new Map<string, string>();
  for (const dir of bundledPackageDirs(metafile, repoRoot)) {
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
    `Third-party software bundled into ${bundleName}`,
    "",
    `${bundleName} inlines the following ${ids.length} npm packages. Each one's license text follows, as shipped in the package.`,
    "",
    ...ids.map((id) => sections.get(id)!),
  ].join("\n");
}
