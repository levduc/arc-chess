# Proposal: the hub verifies every signature it re-emits (audit I1, defence in depth)

- **Status:** proposal for the owner to decide. It is not merged.
- **Branch:** `proposal/hub-sig-check`, cut from `feat/arc-launch` at `a7b27da`. Since then `feat/arc-launch` has
  moved to `c321532`. None of the four new commits touches `contracts/` or `scripts/tools/`.
- **Finding:** I1 in `.superpowers/sdd/2026-10-23-arc-launch/audit-contracts.md`.
- **Scope:** `contracts/src/ChannelHub.sol` (`_supported` only), new tests, and new mutants in
  `scripts/tools/mutants.sh`. Nothing was deployed or broadcast.

## 1. The problem

`challenge` and `respond` emit `abi.encode(proof.latest)` verbatim in `Challenged` and `Responded`
(`ChannelHub.sol:278`, `:297`). Before this change the hub did not read every slot of `proof.latest`:

- **Opening state** (`:434`). Neither slot was read, so both could carry any bytes.
- **Move proof with a `prev`** (`:446`). Only the mover's slot was verified. The other player's slot was never read.

A griefer can therefore answer a challenge with a valid terminal move and put junk in the *victim's* slot. The
hub accepts it and emits the junk. The shipped SDK stores the emitted slots verbatim (`session.ts:815`, `:842`).
Its `challengeProof()` (`:540`) then treats "both slots non-empty" as "fully signed" and builds a
`{hasPrev: false}` proof, which the hub rejects with `Unsupported` every time. The victim has no working exit with
the shipped client. A correct proof can always be built by hand, so nothing is lost for good, but the griefer can
hold the funds for ransom: up to 10 USDC per player at the launch caps.

There is a second effect. The junk is bounded only by the griefer's own gas. So the griefer can emit an event of
hundreds of KB, and spec §12 item 18 says a daemon never advances its scan past an event it failed to ingest. The
audit names this as the strongest reason to bound the emitted bytes on-chain, and not only in the SDK.

The primary fix is in the SDK, which stores only verified signatures. It landed on `feat/arc-launch` as `c321532`
after this branch was cut. This proposal is the on-chain defence in depth.

## 2. The change

### The rule

Each of the two slots of `proof.latest` is either **empty** or a **valid signature by that slot's own signer**
over the state. The hub never accepts unchecked bytes, so it never stores or emits them.

### Diff summary

The diff is 11 added lines and 1 changed line, all inside `_supported` and its NatSpec. No storage, event,
error, function or type changes.

```diff
@@ _supported: no prev
-            if (s.turnNum == 0 && _isOpening(rules, id, p, h)) return (s, h);
+            // The opening needs no signatures: accepted here only with both slots empty. A co-signed opening
+            // falls through to the both-signed check below.
+            if (
+                s.turnNum == 0 && proof.latest.sigA.length == 0 && proof.latest.sigB.length == 0
+                    && _isOpening(rules, id, p, h)
+            ) return (s, h);
             if (_signedBy(p.signers[0], h, proof.latest.sigA) && _signedBy(p.signers[1], h, proof.latest.sigB)) {
@@ _supported: with prev
         if (!_signedBy(p.signers[m], h, m == 0 ? proof.latest.sigA : proof.latest.sigB)) revert BadSignature();
+        // The non-mover's slot is not needed for support, but it is emitted: empty, or a valid co-signature.
+        bytes memory other = m == 0 ? proof.latest.sigB : proof.latest.sigA;
+        if (other.length != 0 && !_signedBy(p.signers[1 - m], h, other)) revert BadSignature();
         if (!rules.validTransition(prev, s, p)) revert InvalidTransition();
```

The two NatSpec lines added to `_supported` are not shown. Runtime size grows from 12,968 to 13,117 bytes
(+149), against the 24,576-byte limit.

The new behaviour, branch by branch:

| Branch | Before | After |
|---|---|---|
| Opening, no `prev` | accepted with any bytes in either slot | accepted only with both slots empty. A co-signed opening falls through to the both-signed rule. Anything else gives `Unsupported`. |
| Both-signed, no `prev` | both slots verified | unchanged |
| Move with `prev`, mover's slot | verified | unchanged |
| Move with `prev`, other slot | never read | must be empty or a valid co-signature, otherwise `BadSignature` |
| `prev` slots | used only for endorsement, never emitted | unchanged |

### Why this variant

The audit offered two options: verify the slots, or emit a sanitised copy with the unverified slots blanked. I
chose to verify, for three reasons:

- **It is the smaller diff.** It touches one function and does not change `challenge`, `respond` or the emits.
- **Valid co-signatures are kept.** A move that carries the non-mover's valid co-signature (spec §12 items 11
  and 14, R4) stays in the event, so a client can still prove it later with no `prev`. Sanitising would blank it.
- **The mutant line anchors stay valid.** `mutants.sh` addresses its 18 mutants by line number, and every one of
  them sits before line 406. All the new lines come after that.

There is a cost. A third-party client that used to submit stale or garbage bytes in a slot that was never read
now gets a revert. The shipped SDK never does this; see §5.2.

### What closes, and what remains

- **Closed.** After this change, if a state from a `Challenged` or `Responded` event has two non-empty slots,
  both are valid. The shipped SDK's `{hasPrev: false}` proof is then correct for every event this hub can emit.
  This holds even without the SDK fix.
- **Closed for code-less signers (the shipped daemon's session keys).** OpenZeppelin 5's `ECDSA.tryRecover`
  accepts only 65-byte signatures. The ERC-1271 fallback to an address with no code returns false. So every
  non-empty slot is exactly 65 bytes, and the emitted `SignedState` is at most 640 bytes. The 200 KB junk case
  from the audit now reverts before anything is emitted.
- **Residual, out of scope.** A party whose own signer has code (a contract signer, or a session key under an
  EIP-7702 delegation) can still make *its own* slot large, if its `isValidSignature` accepts arbitrary bytes.
  The shipped SDK verifies with ECDSA only, so it would refuse such a state as unverifiable. The daemon side of
  the audit's oversized-event item (spec §12 item 18) still applies to this case.
- **Residual, already present.** A contract signer can revoke an ERC-1271 signature after it was emitted. This
  change does not alter that.

## 3. Gas

The figures are execution gas, measured with Foundry around the hub call on the standard EVM. "Heaviest" is
`Gas.t.sol`'s heaviest `CLAIM_STALEMATE` position, which is the only path whose cost scales with board content.

| Case | Before | After | Change |
|---|---:|---:|---:|
| `challenge`, heaviest stalemate (`test_gas_challenge_heaviestFoundClaimStalemate`) | 2,023,537 | 2,023,651 | +114 |
| `respond`, heaviest stalemate (`test_gas_respond_heaviestFoundClaimStalemate`) | 1,860,500 | 1,860,614 | +114 |
| `respond`, heaviest stalemate, with the non-mover's co-signature in `latest` (new `..._coSignedLatest`) | 1,862,528 | 1,866,470 | +3,942 |

Typical calls come from `forge test --gas-report` over the 21 existing tests in `ChannelHub.dispute.t.sol`, with
the new I1 tests excluded so that both runs make the same calls.

| Function | Min (before → after) | Median (before → after) | Max (before → after) | Calls |
|---|---|---|---|---:|
| `challenge` | 40,570 → 40,570 | 298,492 → 298,580 (+88) | 374,979 → 375,120 (+141) | 30 |
| `respond` | 42,692 → 42,692 | 152,801 → 152,835 (+34) | 326,976 → 327,090 (+114) | 9 |

- **Honest proofs leave the other slot empty.** They pay about 34 to 141 gas: two length checks and a memory
  load.
- **A proof that includes a valid co-signature pays for one more `ecrecover`.** That is about 3.9k gas.
- **The worst case stays far inside Arc's block.** It is the heaviest `challenge`:

$$\frac{2{,}023{,}651}{30{,}000{,}000} \approx 6.7\%,$$

  which is under `Gas.t.sol`'s 9,000,000 budget (30 % of the block). That leaves about $14.8\times$ headroom
  against the block limit.
- **ERC-1271 co-signers are a separate cost.** If the non-mover's signer is a contract, verifying its co-signature
  costs whatever that contract's `isValidSignature` spends. Only the submitter chooses to include that slot, and
  the shipped SDK never does in a `prev` proof (§5.2).

## 4. Gate results

All runs used forge 1.8.3.

- **"After" runs** were made in this worktree.
- **The regression tests on the unmodified hub, and the `Gas.t.sol` "before" figures,** were run on a scratch copy
  of `contracts/`. It holds the final test files with the original `ChannelHub.sol` from `a7b27da` swapped in, so
  the "before" and "after" runs used the same tests.
- **The "before" gas report** was run in this worktree before the contract was edited. It used the same 21
  existing dispute tests as the "after" report.

| Gate | Result |
|---|---|
| Baseline `forge test --root contracts`, before the change | 146/146 pass |
| New regression tests on the **unmodified** hub (same test files) | 3 of the 5 new I1 tests **fail** ("next call did not revert as expected"): `respond` with junk in the non-mover slot, `challenge` with 200 KB junk in the non-mover slot, and the opening with junk slots. The 2 positive guards (co-signed opening, valid non-mover co-signature) pass. |
| `forge test --root contracts`, after the change | **152/152 pass**: 146 existing, 5 I1 tests and 1 new gas test |
| Deep profile (`pnpm vectors:deep`, then `ARENA_DEEP_VECTORS=1 FOUNDRY_PROFILE=deep forge test --root contracts`) | **227 passed, 0 failed, 126 skipped (353 total).** The vectors were regenerated from scratch (14m02s): 11,079 positions, 462,258 move checks, 74 chunks, 224,909,268 bytes, identical to Plan 4.5's set. The forge run took 128 s. The 126 skips are deep chunk slots 74–199, which have no vectors, exactly as in Plan 4.5's 347/221/126; the 6 extra tests are the new ones. |
| Mutation testing (`scripts/tools/mutants.sh`, profile `mutation`, seed `0x1`) | **23/23 killed**: the original 18/18 plus I1a–I1e 5/5. It took 8m12s. |
| Slither 0.11.6 (`scripts/tools/slither.sh`) | **0 High, 0 Medium**; exit 0. 2 informational findings, both in chess code this change does not touch: cyclomatic complexity in `ChessMoves._pawnMove`, and too-many-digits on `ChessBoard.INITIAL_BOARD`. That is the same count the audit reported. |
| Echidna 2.3.3 (`scripts/tools/echidna.sh`) | **4/4 properties pass**: `finalizedOrReclaimedAtMostOnce`, `feeNeverExceedsCap`, `hubBalanceEqualsEscrowPlusOwed` and `committedEscrowMatchesGhost`. 50,214 calls; seed 6779244319495112209. |

The new tests are in `ChannelHub.dispute.t.sol`. They port the audit PoC (`ArcFindings.t.sol`) from the Arc fork
fixture to `HubFixture`:

- **`test_I1_respond_rejectsUncheckedBytesInNonMoverSlot`.** This is the PoC's scenario. `respond` refuses four
  kinds of junk in Alice's slot: one byte; 4 KB; Bob's valid signature in Alice's slot; and Alice's valid
  signature over a different state. The clean answer is then accepted, and its event carries only Bob's
  signature. Finally the proof the SDK would build from that event settles through `timeout`.
- **`test_I1_challenge_rejectsUncheckedBytesInNonMoverSlot`.** This is the audit's 200 KB case. It reverts, and
  nothing is registered.
- **`test_I1_openingChallenge_rejectsUncheckedBytes`.** An opening with junk in both slots, only in A, only in B,
  or a valid A with junk in B is refused. An opening with both slots empty is accepted, and its event carries no
  signature bytes.
- **`test_I1_coSignedOpening_stillSupported`** and **`test_I1_validNonMoverCoSignature_acceptedAndEmitted`** guard
  against making the rule too strict.

The five new mutants are **I1a–I1e**:

- I1a: drop the non-mover check;
- I1b: verify the non-mover slot against the mover's signer;
- I1c: accept the opening with any bytes, which is the behaviour before this change;
- I1d: on the opening, require only `sigA` to be empty;
- I1e: on the opening, require only `sigB` to be empty.

They are anchored on patterns, not line numbers. A dry run confirmed that each one rewrites exactly its intended
line.

## 5. What adopting it costs

### 5.1 Testnet redeploy: about 0.10 USDC

- **The current testnet deployment cost 0.1032 USDC** (`docs/superpowers/arc-testnet-rehearsal.md`). That was
  0.0400 USDC for `ChessRules` and 0.0633 USDC for `ChannelHub`, at 21 gwei.
- **`Deploy.s.sol` deploys both contracts, so a straight re-run costs about the same again.** The hub's 149 extra
  bytes add roughly 30k gas, which is about 0.0006 USDC.
- **Redeploying only the hub would save about 0.04 USDC, but it needs a script change.** `ChessRules` is unchanged
  and byte-identical, so it could be reused. Not worth it.
- **The hub is immutable, so channels on the current testnet hub stay there.** They settle there as usual.
- **Nothing pins the old hub.** `KNOWN_DEPLOYMENTS` (`packages/cli/src/config.ts`) has no Arc entries yet, so there
  is no pin to move. `contracts/deployments/5042002.json` and the rehearsal doc get the new addresses.
- **No mainnet hub exists yet.** So adopting the change before the mainnet deploy costs nothing on mainnet.

### 5.2 SDK and daemon compatibility

- **The ABI is unchanged.** No function, event, error or struct changes, so `abiCodec.ts` and the daemon need no
  edit. The new reverts reuse the existing `BadSignature` and `Unsupported` errors, so there is no new error
  selector to decode.
- **No honest proof from the shipped SDK can trip the new check.** I checked this by reading
  `packages/sdk/src/session.ts` at `a7b27da`, before the SDK fix, not by running it:
  - A fresh channel's `latest` is `unsigned(initialState)`, with both slots empty. So the SDK's opening proof is
    accepted.
  - Off-chain `receive` stores the opponent's verified signature with `withOnly`. `signInto` adds the player's own
    signature. `moveOnPending` stores the verified opponent signature plus the player's own. A merged checkpoint
    combines verified slots.
  - `challengeProof()` returns `{hasPrev: false}` whenever both slots are set. So its `{hasPrev: true}` proofs
    always leave the non-mover slot empty, and its no-`prev` proofs with both slots go through the both-signed
    branch, which is unchanged.
  - The only SDK path that stores unverified bytes is `verifyOnChainState` cases (i) and (iii). Their input now
    comes from a hub that never emits unverified bytes.
- **Every combination is safe:**
  - new hub with the old SDK: the junk can never be emitted;
  - old hub with the new SDK: the SDK fix covers it;
  - new hub with the new SDK: two independent layers.
- **The SDK fix (`c321532`) fits this rule exactly.** I read its diff; I did not run its tests here. It stores
  the opening unsigned, which is precisely what the new opening rule requires. It keeps only the mover's
  signature for a move, and both for a checkpoint or a state where both signatures verify. On restore,
  `dropUnverifiedSignatures` empties any stored slot that does not verify. So every proof it builds passes the new
  checks.
- **The SDK fix should still ship.** It protects channels on the current testnet hub, and it does not depend on
  the owner adopting this proposal.
- **Not run for this proposal:** `test:sdk`, `test:cli`, `test:server` and `test:system`. Gate item 9 runs them on
  the release commit anyway. Any harness that deploys from `contracts/out` picks up the new bytecode
  automatically.

### 5.3 Re-verification

Any edit to `ChannelHub.sol` triggers the following, as the audit notes:

- **Gate item 9 runs again on the release commit** (`docs/superpowers/mainnet-gates.md`): `test:contracts`, the
  deep profile, mutants (now 23/23), Slither and Echidna. This proposal already ran them once (§4).
- **The audit's "testnet bytecode is byte-identical" evidence is void.** After the redeploy, redo the on-chain
  read-back, the bytecode match and the source verification on the explorer (rehearsal §1).
- **The rehearsal must exercise the new hub.** Every rehearsal step already run against the old hub has to run
  again against the new one, so that the rehearsal tests the code that will ship.
- **The docs need updating:**
  - a spec §12 entry, proposed text: *"Every non-empty slot of `proof.latest` must be a valid signature by its
    signer; the opening is accepted without signatures only with both slots empty. The hub never stores or emits
    unchecked signature bytes (audit I1)."*;
  - spec §4.3's opening bullet;
  - the "Signatures" section of `contracts/README.md`.
- **Fold in the other contract decisions before redeploying.** If the owner also wants M1 (`claim(to)`) or M2
  (`renounceOwnership`), make those edits first. Then the gates and the redeploy happen only once.

## 6. Recommendation

**Adopt it before the mainnet deploy, alongside the SDK fix, which still ships.**

- The hub is immutable and no mainnet hub exists yet, so now is the cheapest moment.
- It adds 114 gas to the worst case, plus about 3.9k gas only when a co-signature is included.
- It needs no ABI or SDK change.
- It also bounds the size of emitted events for EOA signers, which the SDK fix cannot do.
- The whole price is about 0.10 USDC of testnet redeploy plus one more pass of the gates and the rehearsal. Bundle
  that pass with any M1 or M2 decision.
