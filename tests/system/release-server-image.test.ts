/**
 * Self-host: the server image's release workflow (`.github/workflows/release-server-image.yml`) is linted here as
 * text and never run from this repo's tooling (no pushed tag, no `docker push`), like release-workflow.test.ts does
 * for the CLI's. It pins the pieces the self-host brief asks for: the triggers, the permissions, GITHUB_TOKEN as the
 * only credential, provenance and attestation, the tags, and a smoke test of the image before anything is pushed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../..");
const WORKFLOW_PATH = join(REPO_ROOT, ".github/workflows/release-server-image.yml");

describe("release-server-image workflow", () => {
  const text = readFileSync(WORKFLOW_PATH, "utf8");
  const at = (needle: string) => {
    const i = text.indexOf(needle);
    expect(i, `missing: ${needle}`).toBeGreaterThan(-1);
    return i;
  };

  it('runs on "cli-v*" tags (the server and the CLI release together) and by manual dispatch only', () => {
    expect(text).toMatch(/\non:\n {2}push:\n {4}tags: \["cli-v\*"\]\n {2}workflow_dispatch:\n/);
    expect(text).not.toMatch(/\n {2}pull_request/);
    expect(text).not.toMatch(/\n {4}branches:/);
  });

  it("asks for exactly packages: write, contents: read, id-token: write and attestations: write", () => {
    expect(text).toMatch(/\npermissions:\n {2}contents: read\n {2}packages: write\n {2}id-token: write\n {2}attestations: write\nenv:/);
  });

  it("uses GITHUB_TOKEN and no other secret", () => {
    const secrets = [...text.matchAll(/secrets\.([A-Za-z_]+)/g)].map((m) => m[1]);
    expect(secrets).toEqual(["GITHUB_TOKEN"]);
    expect(text).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|DOCKERHUB|PAT\b/);
  });

  it("pushes ghcr.io/levduc/arc-chess-server, only from this repository", () => {
    expect(text).toContain("IMAGE: ghcr.io/levduc/arc-chess-server");
    expect(text).toContain("if: github.repository == 'levduc/arc-chess'");
    expect(text).toContain("registry: ghcr.io");
  });

  it("refuses a cli-v<version> tag that differs from packages/cli/package.json's version", () => {
    expect(text).toContain(`version="$(node -p "require('./packages/cli/package.json').version")"`);
    expect(text).toContain('if [ "$GITHUB_EVENT_NAME" = "push" ] && [ "${GITHUB_REF_NAME#cli-v}" != "$version" ]; then');
    expect(at("${GITHUB_REF_NAME#cli-v}")).toBeLessThan(at("docker/setup-buildx-action"));
  });

  it("tags <version>, sha-<commit> and latest, for amd64 and arm64", () => {
    expect(text).toContain("${{ env.IMAGE }}:${{ steps.version.outputs.version }}");
    expect(text).toContain("${{ env.IMAGE }}:sha-${{ steps.version.outputs.sha }}");
    expect(text).toContain("${{ env.IMAGE }}:latest");
    expect(text).toContain("platforms: linux/amd64,linux/arm64");
  });

  it("builds deploy/host/Dockerfile from the repository root (its dockerignore allowlists the context)", () => {
    expect(text.match(/file: deploy\/host\/Dockerfile/g)?.length).toBe(2);
    expect(text.match(/context: \./g)?.length).toBe(2);
  });

  it("smoke-tests the image before logging in or pushing: non-root, refuses mainnet, no key-like files", () => {
    const smoke = at("- name: Smoke test");
    expect(at("load: true")).toBeLessThan(smoke);
    expect(text).toContain('test "$(docker run --rm --entrypoint id arena-server:ci -u)" != 0');
    expect(text).toContain("-e NETWORK=arc-mainnet arena-server:ci print-config");
    expect(text).toContain('test "$code" = 1');
    expect(text).toContain('grep -q "this image cannot serve Arc mainnet"');
    expect(text).toContain('-name "wallet*.json" -o -name ".arena*" -o -name "*.key"');
    expect(smoke).toBeLessThan(at("docker/login-action"));
    expect(smoke).toBeLessThan(at("push: true"));
  });

  it("pushes once, with BuildKit provenance (mode=max) and an SBOM, then a GitHub build provenance attestation of that digest", () => {
    expect(text.match(/push: true/g)?.length).toBe(1);
    expect(text).toContain("provenance: mode=max");
    expect(text).toContain("sbom: true");
    const attest = at("actions/attest-build-provenance@");
    expect(attest).toBeGreaterThan(at("push: true"));
    expect(text).toContain("subject-digest: ${{ steps.push.outputs.digest }}");
    expect(text).toContain("push-to-registry: true");
  });

  it("pins every action by a full commit SHA", () => {
    const uses = [...text.matchAll(/uses: ([^\s]+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThanOrEqual(6);
    for (const u of uses) expect(u, u).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40}$/);
  });
});
