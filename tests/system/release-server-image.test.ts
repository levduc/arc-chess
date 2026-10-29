/**
 * Self-host: the server image's release workflow (`.github/workflows/release-server-image.yml`) is linted here as
 * text and never run from this repo's tooling (no pushed tag, no `docker push`), like release-workflow.test.ts does
 * for the CLI's. It pins the pieces the self-host brief asks for: the triggers, the permissions, GITHUB_TOKEN as the
 * only credential, provenance and attestation, the tags (a version tag pushed once, by a tag run only), the npm gate
 * (no image advertises an arc-chess version npm does not have), and a smoke test before anything is pushed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../..");
const WORKFLOW_PATH = join(REPO_ROOT, ".github/workflows/release-server-image.yml");

describe("release-server-image workflow", () => {
  const text = readFileSync(WORKFLOW_PATH, "utf8");

  it("the smoke test scans for key files as root (as the app user, find exits 1 on unreadable dirs and bash -e aborts)", () => {
    expect(text).toContain("docker run --rm -u 0 --entrypoint sh arena-server:ci -c 'find / -xdev");
  });

  it("the smoke test reads the mainnet refusal from stderr too (the server logs it there)", () => {
    expect(text).toContain("arena-server:ci print-config 2>&1)");
  });
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

  it("I-3, N-4, N-5: a tag run tags <version>, sha-<commit>, and latest only for the highest cli-v* version, re-fetched right before the push; a manual run tags sha-<commit> only", () => {
    const step = text.slice(at("- name: The tags to push"), at("- name: Build and push"));
    expect(step).toContain("id: tags");
    expect(step).toContain("if: steps.once.outputs.pushed != 'true'");
    const block = step.slice(step.indexOf('echo "tags<<EOF"'), step.indexOf('echo "EOF"'));
    expect(block).toBe(
      'echo "tags<<EOF"\n            echo "$IMAGE:sha-${{ steps.version.outputs.sha }}"\n' +
        '            if [ "$GITHUB_EVENT_NAME" = "push" ]; then\n' +
        '              echo "$IMAGE:$version"\n' +
        "              git fetch --quiet --force origin 'refs/tags/cli-v*:refs/tags/cli-v*'\n" +
        `              highest="$(git tag -l 'cli-v*' | sed 's/^cli-v//' | grep -E '^[0-9]+\\.[0-9]+\\.[0-9]+$' | sort -V | tail -n 1)"\n` +
        '              if [ "$version" = "$highest" ]; then\n                echo "$IMAGE:latest"\n              else\n' +
        '                echo "not moving :latest: cli-v$highest is higher than $version" >&2\n              fi\n' +
        '            fi\n            ',
    );
    // Decided after the overwrite check, right before the push, and nowhere else.
    expect(at("- name: The tags to push")).toBeGreaterThan(at("- name: A version tag is pushed once"));
    expect(text.split('echo "$IMAGE:latest"').length - 1).toBe(1);
    expect(text).toContain("tags: ${{ steps.tags.outputs.tags }}");
    // N-5: no concurrency group (it could cancel a pending run and leave its version with no image).
    expect(text).not.toMatch(/^\s*concurrency:/m);
    expect(text).toMatch(/persist-credentials: false\n(?: {10}#.*\n)* {10}fetch-depth: 0\n/);
    expect(text).not.toMatch(/\$\{\{ env\.IMAGE \}\}:latest/);
    expect(text).toContain("platforms: linux/amd64,linux/arm64");
  });

  it("I-3: a tag run refuses to overwrite an existing :<version>, and stops when it cannot tell", () => {
    const step = text.slice(at("- name: A version tag is pushed once"), at("- name: The tags to push"));
    expect(step).toContain("id: once");
    expect(step).toContain("if: github.event_name == 'push'");
    expect(step).toContain(`if out="$(docker buildx imagetools inspect "$ref" --format '{{.Manifest.Digest}}' 2>&1)"; then`);
    expect(step).toMatch(/already exists: a version tag always names the same image[\s\S]*?exit 1/);
    expect(step).toMatch(/if echo "\$out" \| grep -qiE "not found\|manifest unknown"; then\n\s+echo "\$ref is not pushed yet"\n\s+exit 0/);
    // Anything else -- a network error, a 5xx -- stops the run.
    expect(step).toMatch(/\n {10}echo "cannot tell whether \$ref exists: \$out" >&2\n {10}exit 1\n/);
    // Authenticated: after docker login.
    expect(at("- name: A version tag is pushed once")).toBeGreaterThan(at("docker/login-action@"));
  });

  it("first publish: an authenticated 403/denied counts as absent only when :sha-<commit> is absent too", () => {
    const step = text.slice(at("- name: A version tag is pushed once"), at("- name: The tags to push"));
    const denied = step.slice(step.indexOf('grep -qiE "403|forbidden|denied|unauthorized"'), step.indexOf('echo "cannot tell whether $ref exists: $out" >&2'));
    expect(denied).toContain('if mine_out="$(docker buildx imagetools inspect "$mine_ref" 2>&1)"; then');
    expect(denied).toMatch(/while \$mine_ref exists: cannot tell whether \$ref exists" >&2\n\s+exit 1/);
    expect(denied).toMatch(/if echo "\$mine_out" \| grep -qiE "not found\|manifest unknown\|403\|forbidden\|denied\|unauthorized"; then\n\s+echo "\$ref is not pushed yet \(the package has never been pushed: \$out\)"\n\s+exit 0/);
    expect(denied).toMatch(/cannot tell whether \$ref exists: \$out; \$mine_ref: \$mine_out" >&2\n\s+exit 1/);
    // "not found" is tried first; 403/denied only after it.
    expect(step.indexOf('"not found|manifest unknown"')).toBeLessThan(step.indexOf('"403|forbidden|denied|unauthorized"'));
  });

  it("N-4: a re-run of a tag run whose push went through attests the pushed digest instead of refusing", () => {
    const step = text.slice(at("- name: A version tag is pushed once"), at("- name: The tags to push"));
    expect(step).toContain('mine_ref="$IMAGE:sha-${{ steps.version.outputs.sha }}"');
    expect(step).toContain(`mine="$(docker buildx imagetools inspect "$mine_ref" --format '{{.Manifest.Digest}}' 2>/dev/null || true)"`);
    expect(step).toContain('if [ -n "$mine" ] && [ "$mine" = "$out" ]; then');
    expect(step).toContain('echo "pushed=true" >> "$GITHUB_OUTPUT"');
    expect(step).toContain('echo "digest=$out" >> "$GITHUB_OUTPUT"');
    // The re-run detection comes before the refusal, and only a matching sha tag reaches it.
    expect(step.indexOf("pushed=true")).toBeLessThan(step.indexOf("already exists"));
    const push = text.slice(at("- name: Build and push"), at("actions/attest-build-provenance@"));
    expect(push).toContain("if: steps.once.outputs.pushed != 'true'");
    expect(text).toContain("subject-digest: ${{ steps.push.outputs.digest || steps.once.outputs.digest }}");
  });

  it("I-4: nothing is pushed until arc-chess@<version> is on npm (waiting up to 20 minutes for release-cli.yml)", () => {
    const gate = at("- name: arc-chess@<version> is on npm");
    const step = text.slice(gate, at("docker/login-action@"));
    expect(text).toContain("CLI_PACKAGE: arc-chess");
    expect(step).toContain('want="$CLI_PACKAGE@${{ steps.version.outputs.version }}"');
    expect(step).toContain('for i in $(seq 1 40); do');
    expect(step).toContain('if [ "$(npm view "$want" version 2>/dev/null)" = "${{ steps.version.outputs.version }}" ]; then');
    expect(step).toContain("sleep 30");
    expect(step).toMatch(/never appeared on npm[\s\S]*?exit 1/);
    expect(gate).toBeGreaterThan(at("- name: Smoke test"));
    expect(gate).toBeLessThan(at("docker/login-action@"));
    expect(gate).toBeLessThan(at("push: true"));
    // The image advertises the CLI package it was built for: the same name the gate checks.
    expect(text.match(/build-args: ARENA_CLI_PACKAGE=\$\{\{ env\.CLI_PACKAGE \}\}/g)?.length).toBe(2);
    expect(text).toContain("/app/share/assets.json | node -p");
  });

  it("M-8: the checkout keeps no token, and the pushed build reuses the smoke-tested build's cache", () => {
    expect(text).toMatch(/- uses: actions\/checkout@[0-9a-f]{40} # v[0-9.]+\n {8}with:\n {10}persist-credentials: false\n/);
    expect(text).toContain("cache-to: type=gha,mode=max");
    expect(text.match(/cache-from: type=gha/g)?.length).toBe(2);
  });

  it("builds deploy/host/Dockerfile from the repository root (its dockerignore allowlists the context)", () => {
    expect(text.match(/file: deploy\/host\/Dockerfile/g)?.length).toBe(2);
    expect(text.match(/context: \./g)?.length).toBe(2);
  });

  it("smoke-tests the image before logging in or pushing: non-root, refuses mainnet offline, no key-like files", () => {
    const smoke = at("- name: Smoke test");
    expect(at("load: true")).toBeLessThan(smoke);
    expect(text).toContain('test "$(docker run --rm --entrypoint id arena-server:ci -u)" != 0');
    expect(text).toContain("--network none -e DOMAIN=arena.operator.dev -e NETWORK=arc-mainnet arena-server:ci print-config");
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
    expect(text).toContain("subject-digest: ${{ steps.push.outputs.digest || steps.once.outputs.digest }}");
    expect(text).toContain("push-to-registry: true");
  });

  it("pins every action by a full commit SHA", () => {
    const uses = [...text.matchAll(/uses: ([^\s]+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThanOrEqual(6);
    for (const u of uses) expect(u, u).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40}$/);
  });
});
