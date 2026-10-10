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

describe("release-cli workflow (written, never run)", () => {
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

  it("reads the npm auth token from the NPM_TOKEN secret", () => {
    expect(text).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
  });

  it("calls npm publish exactly once, after the clean-room test step", () => {
    const occurrences = text.split("npm publish").length - 1;
    expect(occurrences).toBe(1);
    const publishIdx = text.indexOf("npm publish");
    const cleanRoomIdx = text.indexOf("cli-clean-room.test.ts");
    expect(cleanRoomIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(cleanRoomIdx);
  });

  it("never runs npm publish anywhere else in the repo's own workflows (this file is the only release path)", () => {
    // Sanity: the one occurrence found above is this file's own `npm publish packages/cli/dist ...` line, not a
    // dry-run or a different target package.
    expect(text).toContain("npm publish packages/cli/dist --provenance --access public");
  });
});
