/**
 * Plan 5.6 Task 5: the release workflow (`.github/workflows/release-cli.yml`) is written and linted here as text,
 * never run -- see the Global Constraints ("Never publish": no `npm publish`, `npm login`, pushed tags, or GitHub
 * API calls from this repo's own tooling). This suite only checks the committed YAML contains the pieces the spec
 * (§6) and the task brief pin, in the right relative order, so the workflow can't silently drift (a renamed test
 * file, a dropped `--provenance`, a second `npm publish` slipping in ahead of the clean-room gate) without a test
 * failing here first.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../..");
const WORKFLOW_PATH = join(REPO_ROOT, ".github/workflows/release-cli.yml");

describe("release-cli workflow", () => {
  const text = readFileSync(WORKFLOW_PATH, "utf8");

  it('triggers only on "cli-v*" tags', () => {
    expect(text).toContain('tags: ["cli-v*"]');
  });

  it("requests OIDC id-token write permission (for npm provenance)", () => {
    expect(text).toContain("id-token: write");
  });

  it("installs with a frozen lockfile", () => {
    expect(text).toContain("--frozen-lockfile");
  });

  it("builds the release bundle with pnpm build:cli --release", () => {
    expect(text).toContain("pnpm build:cli --release");
  });

  it("runs the clean-room system test before publishing", () => {
    expect(text).toContain("cli-clean-room.test.ts");
  });

  it("publishes with --provenance", () => {
    expect(text).toContain("--provenance");
  });

  it("publishes by npm trusted publishing (OIDC): no npm token anywhere in the workflow", () => {
    // 2026-10-29: arc-chess trusts this repo's release-cli.yml on npm, so the workflow holds no token.
    expect(text).not.toContain("NODE_AUTH_TOKEN");
    expect(text).not.toContain("NPM_TOKEN");
    expect(text).toContain("npm is new enough for trusted publishing");
    const guardIdx = text.indexOf("npm is new enough for trusted publishing");
    expect(guardIdx).toBeLessThan(text.indexOf("npm publish"));
  });

  it("calls npm publish exactly once, after the clean-room test step", () => {
    const occurrences = text.split("npm publish").length - 1;
    expect(occurrences).toBe(1);
    const publishIdx = text.indexOf("npm publish");
    const cleanRoomIdx = text.indexOf("cli-clean-room.test.ts");
    expect(cleanRoomIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(cleanRoomIdx);
  });

  it("publishes exactly packages/cli/dist, publicly, with provenance (not a dry-run or another package)", () => {
    // K2: this checks this one file's publish line only -- no other workflow is read here.
    expect(text).toContain("npm publish packages/cli/dist --provenance --access public");
  });

  it("I1: checks out the Foundry submodules (forge build needs contracts/lib before the clean-room test)", () => {
    expect(text).toMatch(/- uses: actions\/checkout@v4\n\s+with:\n\s+submodules: recursive\n/);
  });

  it("K2: installs Foundry before the clean-room test (its global setup runs forge build)", () => {
    const foundryIdx = text.indexOf("- uses: foundry-rs/foundry-toolchain@v1");
    expect(foundryIdx).toBeGreaterThan(-1);
    expect(foundryIdx).toBeLessThan(text.indexOf("cli-clean-room.test.ts"));
  });

  it("K2: build:cli --release gets the package name, license and repository from the three env lines", () => {
    const buildIdx = text.indexOf("pnpm build:cli --release");
    const block = text.slice(buildIdx, text.indexOf("- run:", buildIdx + 1));
    expect(block).toContain("ARENA_CLI_PACKAGE: ${{ vars.ARENA_CLI_PACKAGE }}");
    expect(block).toContain("ARENA_CLI_LICENSE: ${{ vars.ARENA_CLI_LICENSE }}");
    expect(block).toContain("ARENA_CLI_REPOSITORY: ${{ github.server_url }}/${{ github.repository }}");
  });

  it("M6: fails when the cli-v<version> tag differs from packages/cli/package.json's version, before installing or building", () => {
    expect(text).toContain('tag="${GITHUB_REF_NAME#cli-v}"');
    expect(text).toContain(`version="$(node -p "require('./packages/cli/package.json').version")"`);
    expect(text).toMatch(/if \[ "\$tag" != "\$version" \]; then[\s\S]*?exit 1[\s\S]*?fi/);
    const checkIdx = text.indexOf('tag="${GITHUB_REF_NAME#cli-v}"');
    expect(checkIdx).toBeGreaterThan(text.indexOf("- uses: actions/setup-node@v4")); // node is on PATH by then
    expect(checkIdx).toBeLessThan(text.indexOf("pnpm install --frozen-lockfile"));
  });

  it("M2: the clean-room test installs the release bundle the workflow just built, not a fresh dev build", () => {
    const testIdx = text.indexOf("vitest run cli-clean-room.test.ts");
    const block = text.slice(testIdx, text.indexOf("- run:", testIdx + 1));
    expect(block).toContain("ARENA_CLEAN_ROOM_DIST: ${{ github.workspace }}/packages/cli/dist");
    expect(text.indexOf("pnpm build:cli --release")).toBeLessThan(testIdx);
  });
});
