/**
 * Final wave C (FW-A's mainnet finding): `scripts/verify-arc.sh` when the explorer's API answers HTTP 403, as
 * explorer.arc.io's Cloudflare challenge did on 2026-10-25. No network: `curl`, `forge`, `cast` and `sleep` are stubs
 * on PATH, the solc version comes from a stub svm binary, and the contracts are a fixture directory.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../..");
const SCRIPT = join(REPO_ROOT, "scripts/verify-arc.sh");
const CHAIN = "999999";
const CHESS = "0x00000000000000000000000000000000000000c1";
const HUB = "0x00000000000000000000000000000000000000c2";

/** A `curl` that answers the explorer with a 403 (as `curl -f` reports it), or with `STUB_EXPLORER=up` plays a working
 *  Blockscout, and plays Sourcify; its state is files in `STUB_STATE`. */
const CURL_STUB = `#!/bin/bash
method=GET; url=""; body=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -m|-H|-F) shift 2 ;;
    --data-binary) body="\${2#@}"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
echo "$method $url" >> "$STUB_STATE/calls.log"
case "$url" in
  "$ARENA_EXPLORER_URL"*)
    if [ "$STUB_EXPLORER" != up ]; then echo "curl: (22) The requested URL returned error: 403" >&2; exit 22; fi
    case "$url" in
      */verification/config) echo '{"solidity_compiler_versions":["v0.8.27+commit.40a35a09","v0.8.28+commit.7893614a"]}' ;;
      */verification/via/standard-input) echo '{"message":"Smart-contract verification started"}' ;;
      */verification/via/sourcify)
        addr="\${url%/verification/via/sourcify}"; addr="\${addr##*/}"
        touch "$STUB_STATE/imported-$addr"; echo '{"message":"Smart-contract verification started"}' ;;
      *)
        addr="\${url##*/}"
        if [ -e "$STUB_STATE/imported-$addr" ]; then echo '{"is_verified":true,"is_fully_verified":true}'; else echo '{"is_verified":false}'; fi ;;
    esac ;;
  "$ARENA_SOURCIFY_URL/v2/verify/vid-"*)
    echo '{"isJobCompleted":true,"contract":{"match":"exact_match"}}' ;;
  "$ARENA_SOURCIFY_URL/v2/verify/"*)
    if [ "$STUB_SOURCIFY" = down ]; then echo "curl: (22) The requested URL returned error: 503" >&2; exit 22; fi
    addr="\${url##*/}"
    cp "$body" "$STUB_STATE/submitted-$addr.json"
    touch "$STUB_STATE/verified-$addr"
    echo "{\\"verificationId\\":\\"vid-$addr\\"}" ;;
  "$ARENA_SOURCIFY_URL/v2/contract/"*)
    addr="\${url##*/}"; addr="\${addr%%\\?*}"
    if [ ! -e "$STUB_STATE/verified-$addr" ]; then echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; fi
    case "$url" in
      *fields=*) echo '{"metadata":{"compiler":{"version":"0.8.28+commit.7893614a"}},"sources":{"src/A.sol":{"content":"contract A {}"}}}' ;;
      *) echo '{"match":"exact_match"}' ;;
    esac ;;
  *) echo "unexpected URL $url" >&2; exit 99 ;;
esac
`;

const roots: string[] = [];
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

/** A fixture checkout, stubs and a fake HOME; `verified` pre-marks addresses as exact matches on Sourcify. */
function setup(opts: { sourcify?: "down"; explorer?: "up"; verified?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "arena-verify-arc-"));
  roots.push(root);
  const contracts = join(root, "contracts");
  mkdirSync(join(contracts, "deployments"), { recursive: true });
  mkdirSync(join(contracts, "broadcast/Deploy.s.sol", CHAIN), { recursive: true });
  writeFileSync(join(contracts, "foundry.toml"), '[profile.default]\nsolc_version = "0.8.28"\nvia_ir = true\n');
  writeFileSync(join(contracts, "deployments", `${CHAIN}.json`), JSON.stringify({ chessRules: CHESS, channelHub: HUB, token: "0x3600000000000000000000000000000000000000" }));
  writeFileSync(
    join(contracts, "broadcast/Deploy.s.sol", CHAIN, "run-latest.json"),
    JSON.stringify({ transactions: [{ contractName: "ChessRules", hash: `0x${"a1".repeat(32)}` }, { contractName: "ChannelHub", hash: `0x${"a2".repeat(32)}` }] }),
  );
  const bin = join(root, "bin");
  mkdirSync(bin);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  stub("curl", CURL_STUB);
  stub("forge", '#!/bin/sh\necho \'{"language":"Solidity","sources":{},"settings":{"viaIR":true}}\'\n');
  stub("cast", "#!/bin/sh\necho 0x00\n");
  stub("sleep", "#!/bin/sh\nexit 0\n");
  const home = join(root, "home");
  mkdirSync(join(home, ".svm/0.8.28"), { recursive: true });
  writeFileSync(join(home, ".svm/0.8.28/solc-0.8.28"), "#!/bin/sh\necho 'solc, the solidity compiler commandline interface'\necho 'Version: 0.8.28+commit.7893614a.Linux.g++'\n");
  chmodSync(join(home, ".svm/0.8.28/solc-0.8.28"), 0o755);
  const state = join(root, "state");
  mkdirSync(state);
  for (const a of opts.verified ?? []) writeFileSync(join(state, `verified-${a}`), "");
  const run = (args: string[] = [], extra: Record<string, string> = {}) =>
    spawnSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: home,
        STUB_STATE: state,
        ...(opts.sourcify ? { STUB_SOURCIFY: opts.sourcify } : {}),
        ...(opts.explorer ? { STUB_EXPLORER: opts.explorer } : {}),
        ARENA_CHAIN_ID: CHAIN,
        ARENA_EXPLORER_URL: "https://explorer.stub",
        ARENA_SOURCIFY_URL: "https://sourcify.stub/server",
        ARENA_CONTRACTS_DIR: contracts,
        ...extra,
      },
    });
  const calls = () => (existsSync(join(state, "calls.log")) ? readFileSync(join(state, "calls.log"), "utf8").trim().split("\n") : []);
  return { run, calls, state };
}

describe("verify-arc.sh when the explorer's API answers HTTP 403 (explorer.arc.io's Cloudflare challenge)", () => {
  it("warns, skips the explorer's steps, still verifies both contracts on Sourcify, and exits 0", () => {
    const { run, calls, state } = setup();
    const r = run([], { ARENA_OWNER: "0x00000000000000000000000000000000000000d1", ARENA_FEE_RECIPIENT: "0x00000000000000000000000000000000000000d1" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/WARNING: the explorer's API at https:\/\/explorer\.stub does not answer \(curl: \(22\) The requested URL returned error: 403\): skipping its steps; Sourcify still runs/);
    expect(r.stdout).toContain(`==> ChessRules (${CHESS})`);
    expect(r.stdout).toContain(`==> ChannelHub (${HUB})`);
    expect(r.stdout).toContain(`VERIFIED: Sourcify exact_match -- https://sourcify.stub/server/v2/contract/${CHAIN}/${CHESS} (Blockscout: unreachable)`);
    expect(r.stdout).toContain(`VERIFIED: Sourcify exact_match -- https://sourcify.stub/server/v2/contract/${CHAIN}/${HUB} (Blockscout: unreachable)`);
    // Sourcify got both, with the full solc version from the svm binary, not from the explorer.
    for (const [addr, tx] of [[CHESS, "a1"], [HUB, "a2"]] as const) {
      expect(calls()).toContain(`POST https://sourcify.stub/server/v2/verify/${CHAIN}/${addr}`);
      const body = JSON.parse(readFileSync(join(state, `submitted-${addr}.json`), "utf8")) as Record<string, unknown>;
      expect(body).toMatchObject({ compilerVersion: "0.8.28+commit.7893614a", creationTransactionHash: `0x${tx.repeat(32)}` });
    }
    // Nothing was POSTed to the explorer: no standard-input step, no import.
    expect(calls().filter((c) => c.startsWith("POST https://explorer.stub"))).toEqual([]);
  });

  it("exits 1 only when no verifier confirms a full match, after trying both contracts", () => {
    const { run, calls } = setup({ sourcify: "down" });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/WARNING: Sourcify did not take the submission: curl: \(22\) The requested URL returned error: 503/);
    expect(r.stderr.match(/NOT VERIFIED: no verifier confirmed a full match \(Blockscout: unreachable; Sourcify: none\)/g)).toHaveLength(2);
    expect(r.stderr).toContain("verify-arc: at least one contract has no full match from any verifier");
    // ChannelHub was still attempted after ChessRules failed.
    expect(calls()).toContain(`POST https://sourcify.stub/server/v2/verify/${CHAIN}/${HUB}`);
  });

  it("a contract already an exact match on Sourcify is not submitted again, and ChannelHub needs no ARENA_OWNER", () => {
    const { run, calls } = setup({ verified: [CHESS, HUB] });
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.match(/already an exact match on Sourcify -- not submitting again/g)).toHaveLength(2);
    expect(calls().filter((c) => c.startsWith("POST"))).toEqual([]);
    expect(r.stderr).not.toMatch(/ARENA_OWNER/); // the explorer is unreachable, so its constructor-args step is moot
  });

  it("unchanged when the explorer answers: standard input, then Sourcify, then the import, and Blockscout's full match", () => {
    const { run, calls } = setup({ explorer: "up" });
    const r = run([], { ARENA_OWNER: "0x00000000000000000000000000000000000000d1", ARENA_FEE_RECIPIENT: "0x00000000000000000000000000000000000000d1" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/WARNING/);
    for (const addr of [CHESS, HUB]) {
      const mine = calls().filter((c) => c.includes(addr) && c.startsWith("POST"));
      expect(mine).toEqual([
        `POST https://explorer.stub/api/v2/smart-contracts/${addr}/verification/via/standard-input`,
        `POST https://sourcify.stub/server/v2/verify/${CHAIN}/${addr}`,
        `POST https://explorer.stub/api/v2/smart-contracts/${addr}/verification/via/sourcify`,
      ]);
    }
    expect(r.stdout.match(/VERIFIED: Blockscout full match/g)).toHaveLength(2);
    expect(r.stdout).toContain("compiler_version=v0.8.28+commit.7893614a");
  });

  it("with an explorer that answers no compiler version, Sourcify still gets ARENA_SOLC_LONG_VERSION", () => {
    const { run, state } = setup();
    const r = run(["chessRules"], { HOME: "/nonexistent", ARENA_SOLC_LONG_VERSION: "v0.8.28+commit.7893614a" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(state, `submitted-${CHESS}.json`), "utf8"))).toMatchObject({ compilerVersion: "0.8.28+commit.7893614a" });
  });
});
