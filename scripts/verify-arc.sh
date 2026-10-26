#!/usr/bin/env bash
# Verifies ChessRules and ChannelHub source on a Blockscout explorer (Plan 6, Task 5's rehearsal doc,
# "Source verification"). Mainnet reuses this unchanged by pointing ARENA_CHAIN_ID/ARENA_EXPLORER_URL at the
# mainnet chain/explorer: addresses come from contracts/deployments/<chainId>.json and constructor tx hashes
# from contracts/broadcast/Deploy.s.sol/<chainId>/run-latest.json -- both written by Deploy.s.sol itself.
#
# This script sends no transaction: every request is a read (GET) or a submission to an explorer/verifier's
# own HTTP API (POST), never an RPC call that reaches the chain's mempool.
#
# Why two services, in this order:
#   1. Blockscout's own standard-input recompile-and-match (the "normal" path; tried first, optimistically).
#      On the Arc testnet explorer as of 2026-10-24, this reliably FAILS for both contracts -- confirmed by
#      submitting via two independent routes (direct, and Sourcify's own forwarding of the identical
#      standard-json input to the same Blockscout endpoint) and seeing the same generic
#      "Fail - Unable to verify" both times, despite Blockscout's own /verification/config listing the exact
#      solc build and cancun evmVersion as supported, and dozens of other contracts verifying fine on this
#      instance. Of a 120-contract sample of already-verified contracts here, zero used viaIR -- consistent
#      with (not proof of) this instance's local matcher having a viaIR-specific bug, since both of our
#      contracts are viaIR builds (contracts/foundry.toml: via_ir = true) and both failed identically.
#   2. Sourcify's independent recompiler (https://sourcify.dev), fed the exact same standard-json input,
#      returns creationMatch/runtimeMatch "exact_match" for both contracts in under 6 seconds each -- proving
#      the standard-json input itself (viaIR, solc version, optimizer, evmVersion, remappings, metadata
#      settings) is correct and that step 1's failure is on Blockscout's side, not ours.
#   3. Once Sourcify has a match, fetching its stored metadata.json + sources and POSTing them to
#      Blockscout's own `/verification/via/sourcify` import endpoint DOES flip Blockscout's `is_verified` to
#      true -- it imports Sourcify's already-computed match instead of re-deriving one with the same local
#      matcher that fails in step 1. This is what actually gets the explorer page to show verified source.
#
# Final wave C: every explorer (Blockscout) step is best effort. On 2026-10-25 explorer.arc.io (mainnet) answered
# its API with HTTP 403, a Cloudflare challenge page, and the script exited at step 1 (curl 22 under `set -e`),
# never reaching Sourcify. Now an explorer that does not answer is a warning: steps 1 and 3 are skipped, and
# Sourcify (step 2) still runs. The full solc version Sourcify needs comes from the solc binary forge compiled
# with, not from the explorer. A contract counts as verified when one verifier confirms a FULL match: Blockscout's
# is_fully_verified, or Sourcify's exact_match. Every requested contract is attempted, and the exit is non-zero
# only if one of them has no full match from any verifier.
#
# Usage:
#   scripts/verify-arc.sh                       # verify both contracts for chain 5042002
#   scripts/verify-arc.sh chessRules             # verify only ChessRules
#   scripts/verify-arc.sh channelHub             # verify only ChannelHub
#
# Env overrides (all optional; defaults match the testnet rehearsal):
#   ARENA_CHAIN_ID       default 5042002
#   ARENA_EXPLORER_URL   default https://explorer.testnet.arc.io  (a Blockscout instance)
#   ARENA_SOURCIFY_URL   default https://sourcify.dev/server
#   ARENA_LICENSE_TYPE   default "none" (one of /api/v2/smart-contracts/verification/config's license_types)
#   ARENA_VERIFY_CONTACT an email/URL for Sourcify's User-Agent, per its "send a descriptive User-Agent" rule
#   ARENA_SOLC_LONG_VERSION  the full solc version, e.g. 0.8.28+commit.7893614a (default: from the solc binary in
#                        Foundry's svm cache, else from the explorer's verification/config)
#   ARENA_CONTRACTS_DIR  default <repo>/contracts (tests point it at a fixture)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="${ARENA_CONTRACTS_DIR:-$ROOT/contracts}"
export PATH="$HOME/.foundry/bin:$PATH"

CHAIN_ID="${ARENA_CHAIN_ID:-5042002}"
EXPLORER_URL="${ARENA_EXPLORER_URL:-https://explorer.testnet.arc.io}"
SOURCIFY_URL="${ARENA_SOURCIFY_URL:-https://sourcify.dev/server}"
LICENSE_TYPE="${ARENA_LICENSE_TYPE:-none}"
CONTACT="${ARENA_VERIFY_CONTACT:-noreply@example.com}"
DEPLOYMENTS_FILE="$CONTRACTS_DIR/deployments/$CHAIN_ID.json"
RUN_LATEST="$CONTRACTS_DIR/broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json"

if [[ ! -f "$DEPLOYMENTS_FILE" ]]; then
  echo "FATAL: $DEPLOYMENTS_FILE not found -- deploy first (contracts/script/Deploy.s.sol)." >&2
  exit 1
fi
if [[ ! -f "$RUN_LATEST" ]]; then
  echo "FATAL: $RUN_LATEST not found -- can't recover constructor tx hashes for Sourcify." >&2
  exit 1
fi

CHESS_ADDR="$(jq -r '.chessRules' "$DEPLOYMENTS_FILE")"
HUB_ADDR="$(jq -r '.channelHub' "$DEPLOYMENTS_FILE")"

# The short solc version (e.g. "0.8.28") pinned in contracts/foundry.toml's [profile.default]. Read from
# foundry.toml itself, not hardcoded, so a solc bump there doesn't need a matching edit here -- mainnet's
# foundry.toml is the same file, so this needs no override unless ARENA_SOLC_VERSION is set explicitly.
SOLC_VERSION="${ARENA_SOLC_VERSION:-$(grep -E '^\s*solc_version\s*=' "$CONTRACTS_DIR/foundry.toml" | head -1 | sed -E 's/^[^"]*"([^"]+)".*/\1/')}"
if [[ -z "$SOLC_VERSION" ]]; then
  echo "FATAL: could not read solc_version from $CONTRACTS_DIR/foundry.toml -- set ARENA_SOLC_VERSION." >&2
  exit 1
fi

tx_hash_for() {
  jq -r --arg name "$1" '.transactions[] | select(.contractName == $name) | .hash' "$RUN_LATEST"
}

WHAT="${1:-both}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

warn() { echo "    WARNING: $*" >&2; }

# Short solc version (e.g. "0.8.28") as pinned in contracts/foundry.toml, resolved against the explorer's own
# verification/config list to the exact "v<ver>+commit.<hash>" string it (and Sourcify) expect -- so a solc
# point-release bump doesn't silently go stale here. Empty, never fatal, when the explorer does not answer.
blockscout_compiler_version() {
  local short="$1" config
  config="$(curl -fsS -m 20 "$EXPLORER_URL/api/v2/smart-contracts/verification/config" 2>/dev/null)" || return 0
  echo "$config" | jq -r --arg v "$short" '.solidity_compiler_versions[] | select(startswith("v" + $v + "+"))' 2>/dev/null \
    | head -1 || true
}

# The full solc version without the "v" (e.g. "0.8.28+commit.7893614a"): ARENA_SOLC_LONG_VERSION, else the solc
# binary forge compiled with (Foundry's svm cache: $SVM_HOME, ~/.svm or ~/.local/share/svm), else the explorer's
# list. Empty if none answers.
full_solc_version() {
  if [[ -n "${ARENA_SOLC_LONG_VERSION:-}" ]]; then
    echo "${ARENA_SOLC_LONG_VERSION#v}"
    return 0
  fi
  local dir solc v
  for dir in ${SVM_HOME:+"$SVM_HOME"} "$HOME/.svm" "${XDG_DATA_HOME:-$HOME/.local/share}/svm"; do
    solc="$dir/$SOLC_VERSION/solc-$SOLC_VERSION"
    [[ -x "$solc" ]] || continue
    v="$("$solc" --version 2>/dev/null | sed -nE 's/^Version: ([0-9]+\.[0-9]+\.[0-9]+\+commit\.[0-9a-f]+).*/\1/p' | head -1)" || v=""
    if [[ -n "$v" ]]; then
      echo "$v"
      return 0
    fi
  done
  blockscout_compiler_version "$SOLC_VERSION" | sed 's/^v//'
}

# Why the explorer's API last failed (curl's own line, e.g. "curl: (22) The requested URL returned error: 403").
EXPLORER_ERROR=""

# "true" only for a FULL match: Blockscout sets is_verified for a partial match too (metadata differs), and a partial
# match is not proof that the published source is what was deployed (T5 review m-5). "unreachable" when the explorer's
# API does not answer. Every decision below uses this. Run in the current shell (not `$(...)`) so EXPLORER_ERROR sticks:
# the answer is in BLOCKSCOUT.
BLOCKSCOUT=false
blockscout_full_match() {
  local body
  if ! body="$(curl -fsS -m 15 "$EXPLORER_URL/api/v2/smart-contracts/$1" 2>&1)"; then
    EXPLORER_ERROR="$(echo "$body" | head -1)"
    BLOCKSCOUT=unreachable
    return 0
  fi
  BLOCKSCOUT="$(echo "$body" | jq -r '(.is_verified // false) and (.is_fully_verified // false)' 2>/dev/null)" || BLOCKSCOUT=unreachable
  [[ "$BLOCKSCOUT" == "true" || "$BLOCKSCOUT" == "false" ]] || BLOCKSCOUT=unreachable
}

# For the log: both flags as Blockscout reports them.
verified_flags() {
  curl -fsS -m 15 "$EXPLORER_URL/api/v2/smart-contracts/$1" 2>/dev/null \
    | jq -r '"is_verified=\(.is_verified // false) is_fully_verified=\(.is_fully_verified // false)"' 2>/dev/null || echo "unreadable"
}

# Sourcify's own match for this address: "exact_match" (full), "match" (partial), or "none" (not verified there, or
# Sourcify did not answer).
sourcify_match() {
  local body
  body="$(curl -fsS -m 20 "$SOURCIFY_URL/v2/contract/$CHAIN_ID/$1" 2>/dev/null)" || {
    echo none
    return 0
  }
  echo "$body" | jq -r '.match // "none"' 2>/dev/null || echo none
}

# Step 1: optimistic, best-effort standard-input submission straight to Blockscout. Non-fatal on failure --
# see the header comment for why this is currently expected to fail on Arc testnet but is cheap to keep
# trying (a future Blockscout update may fix the local viaIR matcher, at which point this step alone
# succeeds and steps 2-3 become unnecessary, harmless no-ops).
try_blockscout_standard_input() {
  local addr="$1" autodetect="$2" ctor_args_hex="${3:-}"
  local input_file="$WORKDIR/$addr.std.json"
  local cv
  cv="$(blockscout_compiler_version "$SOLC_VERSION")"
  if [[ -z "$cv" ]]; then
    warn "the explorer listed no compiler version for $SOLC_VERSION: skipping its standard-input step"
    return 0
  fi
  echo "    (best-effort) submitting standard-input to Blockscout, compiler_version=$cv"
  if [[ "$autodetect" == "true" ]]; then
    curl -fsS -m 30 -X POST "$EXPLORER_URL/api/v2/smart-contracts/$addr/verification/via/standard-input" \
      -F "compiler_version=$cv" -F "license_type=$LICENSE_TYPE" \
      -F "autodetect_constructor_args=true" \
      -F "files[0]=@$input_file;type=application/json;filename=input.json" \
      > /dev/null 2>&1 || true
  else
    curl -fsS -m 30 -X POST "$EXPLORER_URL/api/v2/smart-contracts/$addr/verification/via/standard-input" \
      -F "compiler_version=$cv" -F "license_type=$LICENSE_TYPE" \
      -F "autodetect_constructor_args=false" -F "constructor_args=$ctor_args_hex" \
      -F "files[0]=@$input_file;type=application/json;filename=input.json" \
      > /dev/null 2>&1 || true
  fi
}

# Step 2: submit the same standard-json input to Sourcify, which runs its own independent compiler --
# unaffected by whatever makes Blockscout's local matcher fail. Polls its job (usually done in under 10s).
# Sets SOURCIFY_RESULT to Sourcify's match ("exact_match", "match" or "none"); succeeds on either match.
SOURCIFY_RESULT=none
sourcify_verify() {
  local addr="$1" contract_id="$2" tx_hash="$3"
  local input_file="$WORKDIR/$addr.std.json"
  SOURCIFY_RESULT="$(sourcify_match "$addr")"
  if [[ "$SOURCIFY_RESULT" == "exact_match" ]]; then
    echo "    already an exact match on Sourcify -- not submitting again"
    return 0
  fi
  local cv
  cv="$(full_solc_version)"
  if [[ -z "$cv" ]]; then
    warn "no full solc version for $SOLC_VERSION (no svm binary, and the explorer gave none): set ARENA_SOLC_LONG_VERSION"
    return 1
  fi
  local body_file="$WORKDIR/$addr.sourcify-body.json"
  jq -n --slurpfile std "$input_file" --arg cv "$cv" --arg cid "$contract_id" --arg tx "$tx_hash" \
    '{stdJsonInput: $std[0], compilerVersion: $cv, contractIdentifier: $cid, creationTransactionHash: $tx}' \
    > "$body_file"

  echo "    submitting to Sourcify ($contract_id, solc $cv)"
  local submit
  if ! submit="$(curl -fsS -m 30 -X POST "$SOURCIFY_URL/v2/verify/$CHAIN_ID/$addr" \
    -H "Content-Type: application/json" \
    -H "User-Agent: agent-chess-arena-verify-arc.sh/1.0 (contact: $CONTACT)" \
    --data-binary "@$body_file" 2>&1)"; then
    warn "Sourcify did not take the submission: $(echo "$submit" | head -1)"
    return 1
  fi
  local verification_id
  verification_id="$(echo "$submit" | jq -r '.verificationId // empty' 2>/dev/null)" || verification_id=""
  if [[ -z "$verification_id" ]]; then
    echo "    Sourcify submission did not return a verificationId: $submit" >&2
    return 1
  fi

  local delays=(5 10 15 20) elapsed=0
  for d in "${delays[@]}"; do
    sleep "$d"
    elapsed=$((elapsed + d))
    local status
    status="$(curl -fsS -m 20 "$SOURCIFY_URL/v2/verify/$verification_id" 2>/dev/null)" || status="{}"
    if [[ "$(echo "$status" | jq -r '.isJobCompleted // false' 2>/dev/null)" == "true" ]]; then
      local match
      match="$(echo "$status" | jq -r '.contract.match // "null"')"
      echo "    Sourcify job done after ${elapsed}s: match=$match"
      SOURCIFY_RESULT="$match"
      [[ "$match" == "exact_match" || "$match" == "match" ]]
      return $?
    fi
    echo "    Sourcify job still running after ${elapsed}s"
  done
  echo "    Sourcify job did not complete within $elapsed s" >&2
  return 1
}

# Step 3: fetch Sourcify's own metadata.json + source files for this (now-matched) contract, and hand them to
# Blockscout's /verification/via/sourcify import endpoint, which trusts an externally-computed match rather
# than recompiling locally -- this is the step that actually flips Blockscout's is_verified to true.
import_sourcify_into_blockscout() {
  local addr="$1"
  local import_dir="$WORKDIR/$addr-import"
  mkdir -p "$import_dir"

  local resp
  if ! resp="$(curl -fsS -m 20 "$SOURCIFY_URL/v2/contract/$CHAIN_ID/$addr?fields=metadata,sources" 2>&1)"; then
    warn "could not fetch Sourcify's files to import: $(echo "$resp" | head -1)"
    return 1
  fi
  echo "$resp" | jq '.metadata' > "$import_dir/metadata.json"

  local paths curl_args
  mapfile -t paths < <(echo "$resp" | jq -r '.sources | keys[]')
  curl_args=(-F "files[0]=@$import_dir/metadata.json;type=application/json;filename=metadata.json")
  local i=1
  for p in "${paths[@]}"; do
    local dest="$import_dir/$p"
    mkdir -p "$(dirname "$dest")"
    echo "$resp" | jq -r --arg p "$p" '.sources[$p].content' > "$dest"
    curl_args+=(-F "files[$i]=@$dest;type=text/plain;filename=$p")
    i=$((i + 1))
  done

  echo "    importing Sourcify's match into Blockscout ($((i)) files)"
  local result
  if ! result="$(curl -fsS -m 60 -X POST "$EXPLORER_URL/api/v2/smart-contracts/$addr/verification/via/sourcify" \
    "${curl_args[@]}" 2>&1)"; then
    warn "the explorer refused the import: $(echo "$result" | head -1)"
    return 1
  fi
  echo "    Blockscout import response: $result"
}

verify_one() {
  local label="$1" addr="$2" contract_path_name="$3" contract_id="$4" tx_hash="$5" autodetect="$6" ctor_args_hex="${7:-}"
  echo "==> $label ($addr)"
  SOURCIFY_RESULT=none

  blockscout_full_match "$addr"
  if [[ "$BLOCKSCOUT" == "true" ]]; then
    echo "    already fully verified on Blockscout -- skipping"
    return 0
  fi

  # The standard-json input both verifiers take. A failure here is ours (the checkout, forge), never a warning.
  if ! (cd "$CONTRACTS_DIR" && forge verify-contract --show-standard-json-input "$addr" "$contract_path_name") \
    > "$WORKDIR/$addr.std.json"; then
    echo "    NOT VERIFIED: forge could not produce the standard-json input for $contract_path_name" >&2
    return 1
  fi

  if [[ "$BLOCKSCOUT" == "unreachable" ]]; then
    warn "the explorer's API at $EXPLORER_URL does not answer (${EXPLORER_ERROR:-no answer}): skipping its steps; Sourcify still runs"
  elif [[ "$autodetect" != "true" && -z "$ctor_args_hex" ]]; then
    warn "no constructor arguments (ARENA_OWNER or ARENA_FEE_RECIPIENT unset): skipping the explorer's standard-input step"
  else
    try_blockscout_standard_input "$addr" "$autodetect" "$ctor_args_hex"
    blockscout_full_match "$addr"
    if [[ "$BLOCKSCOUT" == "true" ]]; then
      echo "    verified on Blockscout directly"
      return 0
    fi
  fi

  if sourcify_verify "$addr" "$contract_id" "$tx_hash"; then
    blockscout_full_match "$addr"
    if [[ "$BLOCKSCOUT" == "unreachable" ]]; then
      warn "the explorer's API does not answer (${EXPLORER_ERROR:-no answer}): not importing Sourcify's match into it"
    elif import_sourcify_into_blockscout "$addr"; then
      # Blockscout's import only *starts* verification ("Smart-contract verification started"): is_verified flips
      # seconds later. Plan 6 Task 5's redeploy read it at once, saw false, and set -e stopped the run before
      # ChannelHub -- so poll for up to 90 s.
      local waited=0
      blockscout_full_match "$addr"
      while [[ "$BLOCKSCOUT" == "false" && "$waited" -lt 90 ]]; do
        sleep 5
        waited=$((waited + 5))
        blockscout_full_match "$addr"
      done
      echo "    Blockscout full match: $BLOCKSCOUT (after ${waited}s; $(verified_flags "$addr")) -- $EXPLORER_URL/address/$addr#code"
    fi
  else
    echo "    Sourcify did not produce a match either -- see the bytecode diff guidance in" \
      "docs/superpowers/arc-testnet-rehearsal.md" >&2
  fi

  if [[ "$BLOCKSCOUT" == "true" ]]; then
    echo "    VERIFIED: Blockscout full match -- $EXPLORER_URL/address/$addr#code"
    return 0
  fi
  if [[ "$SOURCIFY_RESULT" == "exact_match" ]]; then
    echo "    VERIFIED: Sourcify exact_match -- $SOURCIFY_URL/v2/contract/$CHAIN_ID/$addr (Blockscout: $BLOCKSCOUT)"
    return 0
  fi
  echo "    NOT VERIFIED: no verifier confirmed a full match (Blockscout: $BLOCKSCOUT; Sourcify: $SOURCIFY_RESULT)" >&2
  return 1
}

verify_chess_rules() {
  verify_one "ChessRules" "$CHESS_ADDR" "src/chess/ChessRules.sol:ChessRules" \
    "src/chess/ChessRules.sol:ChessRules" "$(tx_hash_for ChessRules)" true
}

verify_channel_hub() {
  # ChannelHub takes constructor args; Blockscout's standard-input path needs them explicit (ABI-encoded),
  # read from the same ARENA_* env vars contracts/script/Deploy.s.sol reads, with the same defaults, so
  # mainnet needs nothing but different values for these vars (and ARENA_EXPLORER_URL/ARENA_CHAIN_ID). Only that
  # step needs them -- Sourcify reads the constructor arguments from the creation transaction -- so without
  # ARENA_OWNER and ARENA_FEE_RECIPIENT it is skipped with a warning.
  local ctor_args=""
  if [[ -n "${ARENA_OWNER:-}" && -n "${ARENA_FEE_RECIPIENT:-}" ]]; then
    local token
    token="${ARENA_TOKEN:-$(jq -r '.token' "$DEPLOYMENTS_FILE")}"
    ctor_args="$(cast abi-encode \
      "constructor(address,address,address,uint256,uint256,uint256,uint256)" \
      "$token" "$ARENA_OWNER" "$ARENA_FEE_RECIPIENT" "${ARENA_FEE_PER_PLAYER:-5000}" "${ARENA_MAX_FEE_PER_PLAYER:-1000000}" \
      "${ARENA_MAX_DEPOSIT_PER_PLAYER:-10000000}" "${ARENA_MAX_COMMITTED_ESCROW:-1000000000}" | sed 's/^0x//')" || {
      warn "cast abi-encode failed on the ARENA_* constructor values: skipping the explorer's standard-input step"
      ctor_args=""
    }
  fi

  verify_one "ChannelHub" "$HUB_ADDR" "src/ChannelHub.sol:ChannelHub" \
    "src/ChannelHub.sol:ChannelHub" "$(tx_hash_for ChannelHub)" false "$ctor_args"
}

# Every requested contract is attempted, whatever the other's outcome; the exit is 1 if any has no full match.
FAILED=0
case "$WHAT" in
  chessRules) verify_chess_rules || FAILED=1 ;;
  channelHub) verify_channel_hub || FAILED=1 ;;
  both)
    verify_chess_rules || FAILED=1
    verify_channel_hub || FAILED=1
    ;;
  *)
    echo "FATAL: unknown target '$WHAT' (expected chessRules, channelHub or both)" >&2
    exit 1
    ;;
esac
if [[ "$FAILED" -ne 0 ]]; then
  echo "verify-arc: at least one contract has no full match from any verifier" >&2
fi
exit "$FAILED"
