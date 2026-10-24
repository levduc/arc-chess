#!/usr/bin/env bash
# Mutation test for ChannelHub.sol (Plan 4.5 Task 3, fix round 2).
#
# Applies each of the 18 one-line mutants from the reviewer's mutation pass (task-3-review.md) — the 6
# already known to be caught plus the 12 that survived the original suite — and the 5 I1 mutants of the
# hub signature-check proposal (docs/superpowers/proposals/2026-10-24-hub-signature-check.md), plus the
# mutants of that proposal's later audit items (each registers its own IDs, below the DESC table), to a
# throwaway copy of the whole contracts/ tree, runs the FULL test suite (every *.t.sol file, not just the invariant one) against
# each mutant, and asserts every one of them is killed (i.e. the suite fails). Running the full suite
# matters: nearly every one of these 18 mutants already has a deterministic, non-fuzzed directed unit test
# elsewhere in the suite (e.g. ChannelHub.limits.t.sol's test_pause_*StillWorks tests for F1/F2/C1/C2,
# ChannelHub.dispute.t.sol's test_deadlineBoundary for F3/F11) — the invariant fuzz suite alone is a much
# weaker, seed-dependent net for exactly these guard-check mutants (see task-3-report.md fix round 2). The
# real repo is never touched: everything happens in a fresh temp directory, removed on exit via a trap.
#
# Usage: scripts/tools/mutants.sh
# Env:   MUTATION_PROFILE (default: mutation) - the foundry.toml profile used for the per-mutant test run.
#        MUTATION_SEED (default: 0x1) - fuzz seed pinned for reproducibility across repeated runs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROFILE="${MUTATION_PROFILE:-mutation}"
SEED="${MUTATION_SEED:-0x1}"
TMP="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

echo "==> Copying contracts/ to $TMP (original repo is never modified)"
rsync -a --exclude 'out' --exclude 'cache' --exclude 'broadcast' "$ROOT/contracts/" "$TMP/contracts/"

HUB="$TMP/contracts/src/ChannelHub.sol"
PRISTINE="$TMP/ChannelHub.sol.pristine"
cp "$HUB" "$PRISTINE"

# --------------------------------------------------------------------------------------------------
# Mutant definitions. Each `mutant_<ID>` function edits $HUB in place with a single sed pass. IDs match
# task-3-review.md exactly. F6/F8/F14/F15/F16 were never assigned mutants by the reviewer ("not
# reported, pick your own if useful") and are intentionally omitted rather than invented after the fact.
# --------------------------------------------------------------------------------------------------

mutant_C1() { # claim: pause check at the top of the function
  sed -i '/^    function claim() external nonReentrant {$/a\        if (paused) revert Paused();' "$HUB"
}
mutant_C2() { # claim: pause check placed after NothingToClaim
  sed -i '/^        if (amount == 0) revert NothingToClaim();$/a\        if (paused) revert Paused();' "$HUB"
}
mutant_C3() { # _finalize: committedEscrow decremented using the CURRENT fee, not the channel's snapshot
  # Anchored on _finalize's body, not a line number (audit M2 moved it); reclaim has the same line.
  sed -i '/^    function _finalize(/,/^    }$/s/committedEscrow -= 2 \* (p\.deposit + p\.feePerPlayer);/committedEscrow -= 2 * (p.deposit + feePerPlayer);/' "$HUB"
}
mutant_C4() { # challenge: StaleState check removed
  sed -i '272s/.*/            \/\/ MUTATED: if (s.turnNum < reg || (s.turnNum == reg \&\& h != c.registeredHash)) revert StaleState();/' "$HUB"
}
mutant_C5() { # _pay: owed[to] = amount instead of +=
  sed -i 's/owed\[to\] += amount;/owed[to] = amount;/' "$HUB"
}
mutant_C6() { # _pay: always defers to owed, even on a successful direct transfer
  sed -i 's/if (ok \&\& (ret\.length == 0 || abi\.decode(ret, (bool)))) return;/if (false) return;/' "$HUB"
}
mutant_F1() { # challenge: added pause check (must never block an exit)
  sed -i '/^    function challenge(bytes calldata encodedProof) external nonReentrant {$/a\        if (paused) revert Paused();' "$HUB"
}
mutant_F2() { # respond: added pause check
  sed -i '/^    function respond(bytes calldata encodedProof) external nonReentrant {$/a\        if (paused) revert Paused();' "$HUB"
}
mutant_F3() { # timeout: off-by-one, < -> <=, makes the exact-deadline call revert TooEarly
  sed -i '308s/if (block\.timestamp < c\.deadline) revert TooEarly();/if (block.timestamp <= c.deadline) revert TooEarly();/' "$HUB"
}
mutant_F4() { # closeCooperative: NotClosable check removed (non-terminal states become closable)
  sed -i '248s/.*/        \/\/ MUTATED: if (s.turnNum != 0 \&\& !rules.isCheckpoint(s) \&\& !rules.isGameOver(s)) revert NotClosable();/' "$HUB"
}
mutant_F5() { # deposit: AlreadyFunded check removed
  sed -i '196s/.*/        \/\/ MUTATED: if (c.funded[i]) revert AlreadyFunded();/' "$HUB"
}
mutant_F7() { # _finalize: fee paid to the CURRENT feeRecipient, not the channel's own p.feeRecipient
  sed -i 's/_pay(p\.feeRecipient, fee);/_pay(feeRecipient, fee);/' "$HUB" # pattern-anchored (audit M2 moved the line)
}
mutant_F9() { # closeCooperative: StaleState check removed
  sed -i '249s/.*/        \/\/ MUTATED: if (c.hasRegistered \&\& s.turnNum < c.registered.turnNum) revert StaleState();/' "$HUB"
}
mutant_F10() { # challenge: any address may challenge (NotParticipant bypassed)
  sed -i '264s/uint8 who = _playerIndex(p, msg\.sender);/uint8 who = 0; \/\/ MUTATED: bypassed _playerIndex/' "$HUB"
}
mutant_F11() { # timeout: TooEarly check removed entirely (timeout allowed before the deadline)
  sed -i '308s/.*/        \/\/ MUTATED: if (block.timestamp < c.deadline) revert TooEarly();/' "$HUB"
}
mutant_F12() { # respond: DeadlinePassed check removed (respond allowed after the deadline)
  sed -i '290s/.*/        \/\/ MUTATED: if (block.timestamp >= c.deadline) revert DeadlinePassed();/' "$HUB"
}
mutant_F13() { # closeCooperative: signature check removed
  sed -i '246s/.*/        \/\/ MUTATED: if (!_signedBy(p.signers[0], h, ss.sigA) || !_signedBy(p.signers[1], h, ss.sigB)) revert BadSignature();/' "$HUB"
}
mutant_F17() { # respond: does not register the new state
  sed -i '294s/_register(c, s, h);/\/\/ MUTATED: _register(c, s, h);/' "$HUB"
}

# M1 (2026-10-23 audit): claim() pays msg.sender only. Pattern-anchored; claim kept its line count.
mutant_M1a() { # claim: pays someone other than the caller (a redirect, as claim(to) allowed)
  sed -i 's/^        token\.safeTransfer(msg\.sender, amount);$/        token.safeTransfer(feeRecipient, amount);/' "$HUB"
}
mutant_M1b() { # claim: Claimed event names the wrong recipient
  sed -i 's/^        emit Claimed(msg\.sender, msg\.sender, amount);$/        emit Claimed(msg.sender, address(0), amount);/' "$HUB"
}

# I1 (2026-10-23 audit): no unchecked signature bytes in proof.latest. These are anchored on patterns, not line
# numbers, and every line they touch sits after the 18 line-numbered mutants above, inside _supported.
mutant_I1a() { # _supported: non-mover slot of a move proof no longer checked
  sed -i 's/^        if (other\.length != 0 \&\& !_signedBy(p\.signers\[1 - m\], h, other)) revert BadSignature();$/        \/\/ MUTATED: non-mover slot check removed/' "$HUB"
}
mutant_I1b() { # _supported: non-mover slot verified against the mover's signer
  sed -i 's/!_signedBy(p\.signers\[1 - m\], h, other)/!_signedBy(p.signers[m], h, other)/' "$HUB"
}
mutant_I1c() { # _supported: opening accepted whatever its slots carry (the pre-I1 behaviour)
  sed -i 's/s\.turnNum == 0 \&\& proof\.latest\.sigA\.length == 0 \&\& proof\.latest\.sigB\.length == 0$/s.turnNum == 0/' "$HUB"
}
mutant_I1d() { # _supported: opening requires only sigA empty
  sed -i 's/ \&\& proof\.latest\.sigB\.length == 0$//' "$HUB"
}
mutant_I1e() { # _supported: opening requires only sigB empty
  sed -i 's/ \&\& proof\.latest\.sigA\.length == 0 \&\& / \&\& /' "$HUB"
}

# M2 (2026-10-23 audit): renounceOwnership always reverts. Pattern-anchored.
mutant_M2a() { # renounceOwnership: the inherited behaviour (owner-only, leaves the hub ownerless) restored
  sed -i 's/^    function renounceOwnership() public pure override {$/    function renounceOwnership() public override onlyOwner { _transferOwnership(address(0)); return;/' "$HUB"
}
mutant_M2b() { # renounceOwnership: a silent no-op instead of a revert
  sed -i 's/^        revert RenounceDisabled();$/        \/\/ MUTATED: revert removed/' "$HUB"
}

MUTANT_IDS=(C1 C2 C3 C4 C5 C6 F1 F2 F3 F4 F5 F7 F9 F10 F11 F12 F13 F17 I1a I1b I1c I1d I1e)
declare -A DESC=(
  [C1]="claim: pause check at top (previously caught)"
  [C2]="claim: pause check after NothingToClaim (previously caught)"
  [C3]="_finalize: committedEscrow uses current fee, not snapshot (previously caught)"
  [C4]="challenge: StaleState check removed (previously caught, deep profile only)"
  [C5]="_pay: owed[to] = amount instead of += (previously caught, deep profile only)"
  [C6]="_pay: always defers to owed (previously caught, unit test only)"
  [F1]="challenge: pause check added"
  [F2]="respond: pause check added"
  [F3]="timeout: off-by-one (< -> <=)"
  [F4]="closeCooperative: NotClosable check removed"
  [F5]="deposit: AlreadyFunded check removed"
  [F7]="_finalize: fee paid to current feeRecipient, not channel's own"
  [F9]="closeCooperative: StaleState check removed"
  [F10]="challenge: any address may challenge"
  [F11]="timeout: TooEarly check removed"
  [F12]="respond: DeadlinePassed check removed"
  [F13]="closeCooperative: signature check removed"
  [F17]="respond: does not register the new state"
  [I1a]="_supported: non-mover slot of a move proof unchecked"
  [I1b]="_supported: non-mover slot checked against the mover's signer"
  [I1c]="_supported: opening accepted with any slot bytes"
  [I1d]="_supported: opening requires only sigA empty"
  [I1e]="_supported: opening requires only sigB empty"
)

# M2 mutants, registered apart from the arrays above so that each audit item's mutants stand alone.
MUTANT_IDS+=(M2a M2b)
DESC[M2a]="renounceOwnership: inherited owner-only renounce restored"
DESC[M2b]="renounceOwnership: silent no-op, no revert"

declare -A RESULT
FAIL=0

# M1 mutants, registered apart from the arrays above so that each audit item's mutants stand alone.
MUTANT_IDS+=(M1a M1b)
DESC[M1a]="claim: pays a non-caller (redirect)"
DESC[M1b]="claim: Claimed event names the wrong recipient"

for id in "${MUTANT_IDS[@]}"; do
  cp "$PRISTINE" "$HUB"
  "mutant_${id}"

  if cmp -s "$PRISTINE" "$HUB"; then
    RESULT[$id]="NOT_APPLIED"
    FAIL=1
    continue
  fi

  BUILD_LOG="$TMP/build_${id}.log"
  if ! (cd "$TMP/contracts" && FOUNDRY_PROFILE="$PROFILE" PATH="$HOME/.foundry/bin:$PATH" forge build) \
      > "$BUILD_LOG" 2>&1; then
    RESULT[$id]="COMPILE_ERROR"
    FAIL=1
    continue
  fi

  TEST_LOG="$TMP/test_${id}.log"
  if (cd "$TMP/contracts" && FOUNDRY_PROFILE="$PROFILE" PATH="$HOME/.foundry/bin:$PATH" \
      forge test --fuzz-seed "$SEED") > "$TEST_LOG" 2>&1; then
    RESULT[$id]="SURVIVED"
    FAIL=1
  else
    RESULT[$id]="KILLED"
  fi
done

# Restore the pristine file in the temp copy (defensive; the trap already removes $TMP wholesale, and the
# real repo's ChannelHub.sol was never touched).
cp "$PRISTINE" "$HUB"

echo
echo "== Mutation kill table =="
printf "%-6s %-9s %s\n" "ID" "RESULT" "DESCRIPTION"
for id in "${MUTANT_IDS[@]}"; do
  printf "%-6s %-9s %s\n" "$id" "${RESULT[$id]}" "${DESC[$id]}"
done
echo
echo "Profile: $PROFILE, seed: $SEED, scope: full test suite"

SURVIVORS=()
for id in "${MUTANT_IDS[@]}"; do
  if [[ "${RESULT[$id]}" != "KILLED" ]]; then
    SURVIVORS+=("$id (${RESULT[$id]})")
  fi
done

if [[ $FAIL -ne 0 ]]; then
  echo "FAILED: not every mutant was killed: ${SURVIVORS[*]}"
  exit 1
fi

echo "PASSED: all ${#MUTANT_IDS[@]} mutants killed."
