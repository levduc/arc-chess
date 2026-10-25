# Proposal: three hub changes before the mainnet deploy (audit I1, M2 and M1)

- **Status:** proposal for the owner to decide, item by item. Nothing here is merged.
  - *Update 2026-10-25:* all three items were adopted and merged (`750e280`), and deployed on Arc testnet.
  - Final review A then found that §1.7's "closed on-chain, whatever client" did not hold against a signer that has
    code. The owner's fix, ECDSA-only signatures, is §7. §1.3 and §1.7 carry corrections, marked as such.
- **Branch:** `proposal/hub-hardening`. It was cut from `proposal/hub-sig-check` at `0695737`, which was cut from
  `feat/arc-launch` at `a7b27da`. `proposal/hub-sig-check` itself is unchanged; it is checked out in another
  worktree.
- **Findings:** I1, M1 and M2 in `.superpowers/sdd/2026-10-23-arc-launch/audit-contracts.md`.
- **Nothing was deployed or broadcast.** The only chains used were local: forge's in-process EVM, a throwaway
  stock `anvil` for the deploy-gas figures, and `arc-anvil --network arc` for the Arc-semantics tests.

| Item | Change | ABI | Runtime size | Gas on the paths that change | Recommendation |
|---|---|---|---:|---|---|
| **I1** (§1) | `_supported` verifies every signature slot it re-emits | unchanged | +149 B | +34 to +141 typical; +114 worst case; +3.9k with a co-signature | **Adopt** |
| **M2** (§2) | `renounceOwnership()` always reverts | `renounceOwnership` becomes `pure`; new error `RenounceDisabled()` | −75 B | none | **Adopt** |
| **M1** (§3) | `claim(address to)` becomes `claim()`, which pays `msg.sender` | `claim(address)` `0x1e83409a` is replaced by `claim()` `0x4e71d92d` | −16 B | `claim`: −327 execution, −368 calldata | **Owner's choice. I recommend adopting it.** |

Each item is its own commit, so the owner can take any subset (§5.1):

| # | Commit | Item | Content |
|---|---|---|---|
| 1 | `ae4662f` | I1 | `_supported`, 5 tests, 1 gas test, 5 mutants |
| 2 | `0695737` | I1 | the I1-only version of this document |
| 3 | `8fc665d` | M2 | the override, 6 tests, 2 mutants, regenerated `abi.ts`, `contracts/README.md` |
| 4 | `dba95e5` | M1 | `claim()`, 6 forge tests, 1 arc-anvil test, 2 mutants, the SDK and its one caller, `contracts/README.md` |
| 5 | this commit | all | this document |

## 1. I1: the hub verifies every signature it re-emits (defence in depth)

### 1.1 The problem

`challenge` and `respond` emit `abi.encode(proof.latest)` verbatim in `Challenged` and `Responded`
(`ChannelHub.sol:278`, `:297`). Before this change the hub did not read every slot of `proof.latest`:

- **Opening state** (`:434` before the change). Neither slot was read, so both could carry any bytes.
- **Move proof with a `prev`** (`:446` before the change). Only the mover's slot was verified. The other player's
  slot was never read.

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
after this branch was cut. I1 is the on-chain defence in depth.

### 1.2 The change

**The rule.** Each of the two slots of `proof.latest` is either **empty** or a **valid signature by that slot's
own signer** over the state. The hub never accepts unchecked bytes, so it never stores or emits them.

**Diff summary.** The diff is 11 added lines and 1 changed line, all inside `_supported` and its NatSpec. No
storage, event, error, function or type changes.

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

The two NatSpec lines added to `_supported` are not shown. Runtime size grows from 12,968 to 13,117 bytes (+149),
against the 24,576-byte limit.

| Branch | Before | After |
|---|---|---|
| Opening, no `prev` | accepted with any bytes in either slot | accepted only with both slots empty. A co-signed opening falls through to the both-signed rule. Anything else gives `Unsupported`. |
| Both-signed, no `prev` | both slots verified | unchanged |
| Move with `prev`, mover's slot | verified | unchanged |
| Move with `prev`, other slot | never read | must be empty or a valid co-signature, otherwise `BadSignature` |
| `prev` slots | used only for endorsement, never emitted | unchanged |

**Why verify rather than sanitise.** The audit offered two options: verify the slots, or emit a sanitised copy
with the unverified slots blanked. I chose to verify, for three reasons:

- **It is the smaller diff.** It touches one function and does not change `challenge`, `respond` or the emits.
- **Valid co-signatures are kept.** A move that carries the non-mover's valid co-signature (spec §12 items 11
  and 14, R4) stays in the event, so a client can still prove it later with no `prev`. Sanitising would blank it.
- **The mutant line anchors stay valid.** All the new lines come after every line-numbered mutant.

There is a cost. A third-party client that used to submit stale or garbage bytes in a slot that was never read
now gets a revert. The shipped SDK never does this; see §1.5.

### 1.3 What closes, and what remains

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
  - *Correction, 2026-10-25 (final review A I-1):* the residual is not only about size. Even one junk byte in the
    griefer's own slot gives a state the victim's SDK cannot verify, and the review's PoC used it to lock a channel
    that only the griefer could unlock (§7.1).
  - Arc supports EIP-7702, so any session key can gain such code at any time after its channel opens.
  - Closed by §7.
- **Residual, already present.** A contract signer can revoke an ERC-1271 signature after it was emitted. This
  change does not alter that.

### 1.4 Gas

The figures are execution gas, measured with Foundry around the hub call on the standard EVM, with the I1 commit
alone. "Heaviest" is `Gas.t.sol`'s heaviest `CLAIM_STALEMATE` position, which is the only path whose cost scales
with board content. §4.2 re-measures them with all three items.

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
  the shipped SDK never does in a `prev` proof (§1.5).

### 1.5 SDK and daemon compatibility

- **The ABI is unchanged.** No function, event, error or struct changes, so `abiCodec.ts` and the daemon need no
  edit. The new reverts reuse the existing `BadSignature` and `Unsupported` errors.
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
- **Every combination is safe:** new hub with the old SDK (the junk can never be emitted); old hub with the new
  SDK (the SDK fix covers it); new hub with the new SDK (two independent layers).
- **The SDK fix (`c321532`) fits this rule exactly.** I read its diff; I did not run its tests here. It stores the
  opening unsigned, which is precisely what the new opening rule requires. It keeps only the mover's signature for
  a move, and both for a checkpoint or a state where both signatures verify. On restore,
  `dropUnverifiedSignatures` empties any stored slot that does not verify.
- **The SDK fix should still ship.** It protects channels on the current testnet hub, and it does not depend on
  the owner adopting I1.

### 1.6 Tests and mutants

The new tests are in `ChannelHub.dispute.t.sol`. They port the audit PoC (`ArcFindings.t.sol`) from the Arc fork
fixture to `HubFixture`. On the unmodified hub, 3 of the 5 fail ("next call did not revert as expected"); the 2
positive guards pass.

- **`test_I1_respond_rejectsUncheckedBytesInNonMoverSlot`.** The PoC's scenario. `respond` refuses four kinds of
  junk in Alice's slot: one byte; 4 KB; Bob's valid signature in Alice's slot; and Alice's valid signature over a
  different state. The clean answer is then accepted, its event carries only Bob's signature, and the proof the
  SDK would build from that event settles through `timeout`.
- **`test_I1_challenge_rejectsUncheckedBytesInNonMoverSlot`.** The audit's 200 KB case. It reverts, and nothing
  is registered.
- **`test_I1_openingChallenge_rejectsUncheckedBytes`.** An opening with junk in both slots, only in A, only in B,
  or a valid A with junk in B is refused. An opening with both slots empty is accepted.
- **`test_I1_coSignedOpening_stillSupported`** and **`test_I1_validNonMoverCoSignature_acceptedAndEmitted`**
  guard against making the rule too strict.

The mutants are **I1a** (drop the non-mover check), **I1b** (verify the non-mover slot against the mover's signer),
**I1c** (accept the opening with any bytes, the old behaviour), **I1d** (require only `sigA` empty) and **I1e**
(require only `sigB` empty). They are anchored on patterns, not line numbers.

### 1.7 Adopt, or not

- **If adopted:** every `Challenged` and `Responded` event this hub can emit carries only verified signatures, of
  at most 640 bytes for EOA signers. The griefing ransom and the oversized-event attack on daemons are closed
  on-chain, whatever client a player uses. It costs the gas above, one testnet redeploy and one more pass of the
  gates and the rehearsal (§5), shared with M2 and M1.
  - *Correction, 2026-10-25 (final review A I-1):* "closed on-chain, whatever client" held only for griefers whose
    signer has no code.
  - "Verified" meant ECDSA *or* ERC-1271. A griefer could delegate its session key, with EIP-7702, to code that
    accepts anything. It would then still sign ECDSA off-chain, so play looked normal. On-chain, though, its own slot
    could carry any bytes, from one byte to about 1 MB, and the hub accepted them through ERC-1271. No client can
    verify those bytes.
  - That gave a lock only the griefer could lift (proven by a PoC), and a stake taken at a new-game boundary.
  - The owner closed both on 2026-10-25 by making the hub ECDSA-only (§7). With that change, the sentence above
    holds for every signer.
- **If not adopted:** the SDK fix alone protects players on the shipped client, but only players who have
  upgraded to it. A third-party or older client can still be held to ransom. A griefer can still emit events of
  hundreds of KB, which every daemon must ingest, so spec §12 item 18's "never advance past an event it failed to
  ingest" stays a liveness risk. The audit's "testnet bytecode is byte-identical" evidence stays valid, and no
  redeploy is needed for I1.

## 2. M2: `renounceOwnership()` always reverts

### 2.1 The problem

`renounceOwnership()` is inherited from `Ownable.sol:76`; `Ownable2Step` does not disable it. One mistaken multisig
transaction while the hub is paused would freeze new business forever: the hub could never be unpaused, and its
caps could never be raised. Funds would be unaffected, because no exit depends on the owner. Until now only the
README and gate item 7 ("Never renounce ownership (m15)") guarded against it.

### 2.2 The change

**Diff summary.** 10 added lines in `ChannelHub.sol`, in the admin section after `setPaused`:

```solidity
    /// @dev Declared here rather than with the other errors, so that the lines `scripts/tools/mutants.sh`
    /// addresses by number do not move.
    error RenounceDisabled();

    /// @notice Always reverts (audit M2): an ownerless hub could never be unpaused or have its caps raised again.
    /// Hand over with `transferOwnership` and `acceptOwnership` (Ownable2Step) instead.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }
```

- **No storage change.** No other function, event or modifier changes.
- **ABI.** `renounceOwnership`'s `stateMutability` becomes `pure`, and the new error `RenounceDisabled()`
  (`0x89051165`) appears. `packages/sdk/src/abi.ts` is regenerated; nothing in the SDK, CLI or server calls
  `renounceOwnership`.
- **Every caller gets the same error.** The override has no `onlyOwner`, so a non-owner now gets
  `RenounceDisabled`, not `OwnableUnauthorizedAccount`. That is harmless: nobody can renounce either way.
- **The hand-over is unchanged.** `transferOwnership` (owner only) sets `pendingOwner`, the owner keeps every right
  until the pending owner calls `acceptOwnership`, and `transferOwnership(address(0))` cancels a pending transfer.
- **Why the error is not with the others.** Twelve of the original 18 mutants in `mutants.sh` are addressed by
  line number, seven of them by rewriting the whole line. An error declared in the error block at the top would
  shift all of them onto the wrong lines. Declared next to the override, the change moves only lines after the
  admin section. The only line-numbered mutants there are C3 and F7, in `_finalize`; they are now anchored on
  patterns instead.
- **What it does not prevent.** The owner can still transfer ownership to an address that then accepts. That is a
  deliberate two-step act by both parties, not a single mistaken transaction.

`contracts/README.md`'s "Never renounce ownership" paragraph now says the rule is enforced on-chain.

### 2.3 Gas

| Measure | Before (I1) | After (I1 + M2) | Change |
|---|---:|---:|---:|
| Runtime size | 13,117 B | 13,042 B | −75 B |
| Initcode size | 14,107 B | 14,032 B | −75 B |
| Deploy `gasUsed`, local stock anvil | 3,045,050 | 3,028,866 | −16,184 |

No call path a player uses changes. The size falls because the inherited body (`onlyOwner`, `_transferOwnership`
and the `OwnershipTransferred` event) is no longer compiled into `renounceOwnership`. The deploy saving is about
0.0003 USDC at 21 gwei.

### 2.4 Tests and mutants

`ChannelHub.owner.t.sol` (new, 6 tests):

- **`test_M2_renounce_revertsForOwner_ownerKept`.** The owner's renounce reverts with `RenounceDisabled`; the owner
  is unchanged and can still pause.
- **`test_M2_renounce_revertsForAnyCaller`.** A participant and an unrelated caller get the same error.
- **`test_M2_renounceWhilePaused_hubCanStillBeUnpaused`.** The audit's scenario: after a renounce attempt while
  paused, the owner unpauses and a new channel opens.
- **`test_M2_renounce_keepsPendingTransfer`.** A reverted renounce does not clear a pending transfer, which can
  still be accepted.
- **`test_M2_twoStepTransfer_stillWorks`.** Only the owner may start a transfer, which emits
  `OwnershipTransferStarted`. Until acceptance, the old owner keeps every right and the new one has none. Only the
  pending owner may accept, which emits `OwnershipTransferred` and clears `pendingOwner`. The new owner then
  administers, the old one cannot, and the new owner cannot renounce either.
- **`test_M2_twoStepTransfer_redirectAndCancel`.** A pending transfer can be redirected, or cancelled with
  `address(0)`, after which nobody can accept it.

The mutants are **M2a**, which restores the inherited owner-only renounce, and **M2b**, which makes the override a
silent no-op. Each one fails 5 of the 6 tests in a direct run. Both are anchored on patterns.

### 2.5 Adopt, or not

- **If adopted:** an ownerless hub can no longer happen by mistake. The pause and the caps stay usable for the
  hub's whole life. The cost is nil at run time and slightly negative at deploy.
- **If not adopted:** the protection is procedural only (README, gate item 7, the multisig threshold). One
  mistaken renounce would end new business on that hub for good. Existing channels would still settle, but the
  only remedy would be a new hub, with a new address for every client and a new `KNOWN_DEPLOYMENTS` pin.

## 3. M1: `claim()` pays `msg.sender` only (owner's choice)

### 3.1 The problem

`claim(address to)` (`ChannelHub.sol:224-230` before the change) let a blocklisted party move its `owed` USDC
anywhere:

1. A participant is blocklisted after funding. Their payout is deferred to `owed`, which is correct.
2. They call `claim(freshAddress)`. USDC checks only the hub (as `msg.sender`) and `to`, so the funds leave the hub.

The hub is then a way around the blocklist. If Circle responded by blocklisting the hub itself, every user's payout
would freeze until Circle unblocked it. The audit showed both on forks of Arc
(`test_blocklistedClaimant_canRedirect`, `test_hubBlocklisted_fundsFrozenNotLost`) and rated it Minor: `withdraw(to)`
is a standard pattern, and the amounts are small at the launch caps.

**Who can still reach `claim` once blocklisted.** The audit left open whether a blocklisted EOA can pay gas on Arc.
arc-anvil, which models Circle's blocklist, refuses it outright: a blocklisted sender cannot send anything, and even
an `eth_call` from it is refused with `-32003 "Blocked address"` (`tools/arc-foundry.md` point 5, and a probe for
this proposal). This is arc-anvil's model, not a measurement on Arc. If real Arc behaves the same way, the redirect
needs a blocklisted *contract* wallet whose owner, or a relayer, pays the gas. The arc-anvil test in §3.4 uses
exactly that path.

### 3.2 The change

**Diff summary.** In `ChannelHub.sol`, 3 changed lines plus the NatSpec line; `claim` keeps its line count, so no
line-numbered mutant moves:

```diff
-    /// @notice Withdraw payouts that could not be pushed (e.g. the recipient was blocked by the token).
-    function claim(address to) external nonReentrant {
+    /// @notice Withdraw, to the caller only, payouts that could not be pushed (audit M1: a blocked one stays here).
+    function claim() external nonReentrant {
         uint256 amount = owed[msg.sender];
         if (amount == 0) revert NothingToClaim();
         owed[msg.sender] = 0;
-        emit Claimed(msg.sender, to, amount);
-        token.safeTransfer(to, amount);
+        emit Claimed(msg.sender, msg.sender, amount);
+        token.safeTransfer(msg.sender, amount);
     }
```

- **The event keeps its shape.** `Claimed(address indexed from, address indexed to, uint256 amount)` is unchanged;
  `to` is now always the caller. Event decoders in the SDK and the server need no change.
- **ABI.** `claim`'s input is gone, so the selector changes from `claim(address)` `0x1e83409a` to `claim()`
  `0x4e71d92d`. The hub has no fallback, so a call with the old selector reverts.
- **Blocked claimants.** A claim by a blocked party now reverts inside the token: `"Blocked address"` on Arc,
  `"blocked"` on MockUSDC, or `SafeERC20FailedOperation` on a token that returns false. `owed` is untouched, so
  the claim succeeds as soon as the token unblocks the party.

**Every off-chain file M1 touches.** `grep -rn "claim(" packages apps` finds one SDK method and one caller. No
daemon, CLI or server source calls `claim`.

| File | Change |
|---|---|
| `packages/sdk/src/hub.ts` | `HubClient.claim(sender, to, opts)` becomes `claim(sender, opts)`, with no `args`. |
| `packages/sdk/src/abi.ts` | Regenerated: `claim` has no inputs. |
| `packages/cli/test/arc/settlement.test.ts` | The one caller: `.claim(claimer, bob.address)` becomes `.claim(claimer)`. |
| `packages/cli/test/arc/claim.test.ts` | New arc-anvil test (§3.4). |
| `contracts/test/helpers/ContractWallet.sol` | New test-only contract wallet, used by that test. |
| `contracts/README.md` | The trust assumptions say `claim()` pays the caller only; the entry-point list says `claim()`. |

The forge tests that called `claim(to)` (`ChannelHub.close.t.sol`, `ChannelHub.limits.t.sol`,
`helpers/HubHandler.sol`) now call `claim()`. Where the payee was blocked, it now claims after it is unblocked.

### 3.3 Gas

| Measure | Before (I1 + M2) | After (I1 + M2 + M1) | Change |
|---|---:|---:|---:|
| `claim` execution gas, one claim by an unblocked payee (`forge test --gas-report`) | 53,505 | 53,178 | −327 |
| `claim` calldata | 36 B | 4 B | −32 B, about −368 gas of intrinsic cost |
| Runtime size | 13,042 B | 13,026 B | −16 B |
| Deploy `gasUsed`, local stock anvil | 3,028,866 | 3,025,360 | −3,506 |

The calldata figure assumes standard pricing (4 gas per zero byte, 16 per non-zero byte) and an address word with
12 zero bytes, so $12 \times 4 + 20 \times 16 = 368$.

### 3.4 Tests and mutants

`ChannelHub.claim.t.sol` (new) runs three tests on two token backends, 6 in all: MockUSDC, which reverts like Arc's
USDC, and BlockingToken, which returns false.

- **`test_M1_blockedClaimant_cannotRedirect`.** A blocked payee's `claim()` reverts at the token. A raw call with
  the old `claim(address)` selector fails. Another caller's `claim()` gives `NothingToClaim`, so nobody else can
  pull the funds. `owed`, the hub's balance and the would-be recipient's balance are all unchanged.
- **`test_M1_claim_paysCaller`.** Once unblocked, the payee's `claim()` pays the caller exactly what is owed, emits
  `Claimed(bob, bob, amount)` and zeroes `owed`; a second claim gives `NothingToClaim`.
- **`test_M1_hubBlocked_claimsWait_thenPayEachCaller`.** The token blocks the hub itself. Every payout defers, and a
  claim reverts. After the unblock, each of the three payees claims to itself and the hub ends empty.

`packages/cli/test/arc/claim.test.ts` (new) runs on `arc-anvil --network arc` against Circle's FiatToken proxy at
`0x3600…0000` and its real blocklist, with dev account 7 as blacklister:

- A `ContractWallet` funds a channel that the other side never funds.
- After the funding deadline it is blocklisted, and `reclaim` defers its refund to `owed`, with `PayoutDeferred`.
- While it is blocklisted, its owner relays `claim()` through it, and the call reverts with `"Blocked address"`.
- Relaying `claim(address)` with a fresh address also reverts. The funds stay in the hub, and the fresh address
  receives nothing.
- Once it is unblocked, its `claim()` pays the wallet itself in full, emits `Claimed(wallet, wallet, amount)`, and
  leaves the hub at zero.

This test was not run against the pre-M1 hub, where the `claim()` it calls does not exist. The redirect it guards
against was shown on Arc forks by the audit's PoC, and in forge by mutant M1a.

The mutants are **M1a**, where `claim` pays someone other than the caller (the fee recipient, a redirect), and
**M1b**, where `Claimed` names the wrong recipient. A direct run of `ChannelHub.claim.t.sol` fails all 6 tests
under M1a, and the 2 `paysCaller` tests under M1b. The existing mutant C1 is re-anchored on the new signature.

### 3.5 Adopt, or not

- **If adopted:**
  - A blocklisted party's `owed` stays frozen in the hub until Circle unblocks it, which is Circle's intent. The hub
    stops being a way around the blocklist, which removes the main reason Circle might blocklist the hub itself
    and freeze everyone's payouts.
  - Nothing an honest user can do is lost. An ERC-20 transfer to an address only fails when the token refuses it,
    so `to` mattered only to redirect around a refusal. A user who wants the funds elsewhere can claim and then
    transfer.
  - It is an interface break. `HubClient.claim` loses its `to` argument, and the selector changes. The shipped
    daemon, CLI and server never call `claim`, so only the SDK method and one test changed. A third-party script
    that calls `claim(address)` on the new hub reverts and must switch to `claim()`. The old testnet hub keeps
    `claim(address)`.
- **If not adopted:** keep `claim(to)` and record it as an accepted risk in the README's trust assumptions.
  Proposed text: *"`claim(to)` lets a party whose payout was deferred, including one the token has blocklisted,
  send it to any address. The hub can therefore move a blocklisted party's deferred funds: at most what the hub
  owes that party, which the launch caps bound at 10 USDC per player per channel. If Circle responds by
  blocklisting the hub, every payout defers and every claim reverts until Circle unblocks it; funds are frozen, not
  lost."* The SDK and the tests stay as they are.

## 4. Gate results on the final branch

All runs used forge 1.8.3, on `proposal/hub-hardening` at `dba95e5` (the code of all three items), in this
worktree unless noted.

### 4.1 Gates

| Gate | Result |
|---|---|
| `forge test --root contracts` | **164/164 pass**: the 152 of the I1 branch, 6 M2 tests and 6 M1 tests. Before this work, the I1 branch passed 152/152 in this worktree. |
| Mutation testing (`scripts/tools/mutants.sh`, profile `mutation`, seed `0x1`) | **27/27 killed**: the original 18, I1a–I1e, M2a–M2b and M1a–M1b. It took 11m51s, run alongside the deep vector generation. |
| Slither 0.11.6 (`scripts/tools/slither.sh`) | **0 High, 0 Medium**; exit 0. 2 informational findings, both in chess code no item touches: cyclomatic complexity in `ChessMoves._pawnMove`, and too-many-digits on `ChessBoard.INITIAL_BOARD`. That is the same count the audit reported. |
| Echidna 2.3.3 (`scripts/tools/echidna.sh`) | **4/4 properties pass**: `finalizedOrReclaimedAtMostOnce`, `feeNeverExceedsCap`, `hubBalanceEqualsEscrowPlusOwed` and `committedEscrowMatchesGhost`. 50,231 calls; seed 6112527063608793816. Its harness (`contracts/echidna/HubProperties.sol`) never calls `claim` or `renounceOwnership`, so it checks that M1 and M2 broke nothing else; the forge tests and mutants cover the items themselves. |
| Deep profile (`pnpm vectors:deep`, then `ARENA_DEEP_VECTORS=1 FOUNDRY_PROFILE=deep forge test --root contracts`) | **239 passed, 0 failed, 126 skipped (365 total).** The deep vectors were regenerated from scratch (15m29s, alongside the mutation run): 11,079 positions, 462,258 move checks, 74 chunks, 224,909,268 bytes, identical to Plan 4.5's and I1's set. The forge run took 132 s. The 126 skips are the deep chunk slots 74–199, which have no vectors, as in I1's 227/126/353; the 12 extra tests are the M2 and M1 ones. The whole profile took about 17.5 minutes. |
| `pnpm test:sdk` (under `flock /tmp/claude-1000/arena-8546.lock`) | **207/207 pass**, 14 files, including `abi.test.ts`, which checks the regenerated `abi.ts` against the build. It took 112 s. |
| `pnpm test:cli` (same lock) | **603 passed, 18 skipped (621)**; 25 files passed and 4 skipped. The 4 skipped files are `test/arc/*`, which skip themselves on stock anvil, the new `claim.test.ts` among them; the run on arc-anvil below covers them. It took 328 s. |
| The CLI's Arc-like harness on arc-anvil (`ARENA_ANVIL_BIN=…/arc-anvil ARENA_TEST_ANVIL_PORT=8667 vitest run test/arc/`, from `packages/cli`) | **13/13 pass**, 4 files: `settlement`, `one-balance`, `floor` and the new `claim`. The binary is the main checkout's `tools/bin/arc-anvil`, v0.8.0-2. |
| Typecheck (`tsc --noEmit` in the SDK, the CLI and the server) | clean |
| Independence: M1 cherry-picked onto I1 without M2 (`git merge-tree --merge-base=8fc665d 0695737 dba95e5`) | **Clean, no conflict.** In a scratch copy of the result: `forge test` 158/158; the committed `abi.ts` is identical to one regenerated from that build; all 25 mutants apply to exactly one line each. |

No `--fork-url` run was made: every Arc-semantics check ran on a local `arc-anvil`. `test:server` and
`test:system` were not run for this proposal; gate item 9 runs them on the release commit.

### 4.2 Gas with all three items

`Gas.t.sol` on the final branch gives exactly the I1 figures of §1.4: the heaviest `challenge` is 2,023,651, the
heaviest `respond` 1,860,614, and the co-signed `respond` 1,866,470. M2 and M1 add no gas to any dispute path.

| Measure | On testnet now (pre-I1) | I1 | I1 + M2 | I1 + M2 + M1 |
|---|---:|---:|---:|---:|
| Runtime size | 12,968 B | 13,117 B | 13,042 B | 13,026 B |
| Deploy `gasUsed`, local stock anvil | — | 3,045,050 | 3,028,866 | 3,025,360 |
| `claim` execution gas | — | 53,505 | 53,505 | 53,178 |

The deploy figures come from one throwaway stock `anvil` (port 47741), deploying each commit's build with the same
constructor arguments. For comparison, the pre-I1 hub's real testnet deploy used 3,012,611 gas.

## 5. Combined adoption plan

### 5.1 Pick the items

| Take | How |
|---|---|
| I1, M2 and M1 | the branch head |
| I1 and M2 | up to `8fc665d` |
| I1 and M1 | `0695737`, then cherry-pick `dba95e5`. Verified clean; see §4.1. |
| M2 or M1 without I1 | not prepared. Both commits sit on top of I1, and their `mutants.sh` hunks sit next to I1's mutants, so they would need a rebase and a fresh gate run. |

Make every contract decision before redeploying, so that the gates and the redeploy happen only once.

### 5.2 One testnet redeploy: about 0.10 USDC

- **The current testnet deployment cost 0.1032 USDC** (`docs/superpowers/arc-testnet-rehearsal.md` §1): 0.0400
  USDC for `ChessRules` and 0.0633 USDC for `ChannelHub`, at 21 gwei.
- **`Deploy.s.sol` deploys both contracts, so a straight re-run costs about the same again.** `ChessRules` is
  unchanged. The hub with all three items measures 3,025,360 gas locally; at 21 gwei,

$$3{,}025{,}360 \times 21 \times 10^{9}\ \text{wei} \approx 0.0635\ \text{USDC},$$

  so the total is about $0.0400 + 0.0635 \approx 0.1035$ USDC. The three items together add 58 bytes to the hub
  that is on testnet now ($+149 - 75 - 16$), about 12k gas or 0.0003 USDC.
- **Redeploying only the hub would save about 0.04 USDC, but it needs a script change.** Not worth it.
- **The hub is immutable, so channels on the current testnet hub stay there.** They settle there as usual, with
  the old `claim(address)`.
- **Nothing pins the old hub.** `KNOWN_DEPLOYMENTS` (`packages/cli/src/config.ts`) has no Arc entries yet.
  `contracts/deployments/5042002.json` and the rehearsal doc get the new addresses.
- **No mainnet hub exists yet**, so adopting any of the items now costs nothing on mainnet.
- **The owner runs the broadcast.** This proposal broadcast nothing.

### 5.3 Re-verification

- **Gate item 9 runs again on the release commit** (`docs/superpowers/mainnet-gates.md`). Its mutant count becomes
  27/27, or 23 plus 2 for each of M2 and M1 adopted. Because M1 changes the SDK, `test:sdk`, `test:cli` and
  `test:arc` (for `test/arc/claim.test.ts`) belong in that run too.
- **The audit's "testnet bytecode is byte-identical" evidence is void.** After the redeploy, redo rehearsal §1's
  on-chain read-back, the bytecode match against a local build (metadata included), and the explorer source
  verification.
- **Two read-only checks are new:**
  - with M2, an `eth_call` of `renounceOwnership()` from the owner reverts with `RenounceDisabled` (`0x89051165`);
  - with M1, an `eth_call` of `claim()` (`0x4e71d92d`) from an address owed nothing reverts with `NothingToClaim`,
    and one of `claim(address)` (`0x1e83409a`) reverts with no data.
- **The docs need updating:**
  - for I1, a spec §12 entry, proposed text: *"Every non-empty slot of `proof.latest` must be a valid signature by
    its signer; the opening is accepted without signatures only with both slots empty. The hub never stores or
    emits unchecked signature bytes (audit I1)."* Also spec §4.3's opening bullet, and the "Signatures" section of
    `contracts/README.md`;
  - gate item 9's "mutants 18/18": change it to the new count;
  - for M2, gate item 7's "Never renounce ownership (m15)": add "enforced on-chain (audit M2); key custody still
    applies";
  - for M1, spec §12 item 3's "withdrawn with `claim(to)`": change it to "withdrawn by the payee with `claim()`,
    which pays the caller only (audit M1)";
  - the plans under `docs/superpowers/plans/` record history and stay as they are.
  The M2 and M1 commits already update `contracts/README.md` for their own items.

### 5.4 Re-run the testnet rehearsal

Every rehearsal step already run against the old hub runs again against the new one, so that the rehearsal tests
the code that will ship. Add one step if M1 is adopted: a payout deferred to `owed`, then claimed by the payee
itself with `claim()`.

## 6. Recommendation

- **I1: adopt**, alongside the SDK fix, which still ships. It closes the griefing ransom and bounds emitted events
  on-chain, for 34 to 141 gas on honest proofs and no ABI change.
- **M2: adopt.** It removes a permanent, single-transaction failure mode at no run-time cost, and the Ownable2Step
  hand-over still works.
- **M1: the owner's choice; I recommend adopting it.** It makes the hub respect the blocklist and lowers the risk
  of the hub itself being blocklisted. Its cost is one SDK method signature, and no shipped daemon, CLI or server
  code path uses it.
- All three together cost one testnet redeploy of about 0.10 USDC, one gate pass and one rehearsal re-run, done
  once (§5).

## 7. Follow-up, 2026-10-25: ECDSA-only signatures (final review A I-1)

### 7.1 The gap

`_signedBy` tried ECDSA first and then ERC-1271 (`SignatureChecker.isValidERC1271SignatureNow`). The attacker is an
ordinary session key with an EIP-7702 delegation to code whose `isValidSignature` accepts anything. Arc supports
EIP-7702, and one type-4 transaction can set the delegation at any time after the channel opens. Offers, acceptances
and relay joins are ECDSA-verified, so a plain contract signer could never be matched; a delegated session key can.

Final review A's PoC (`LockPoC.t.sol`, ported as a regression test, §7.4) showed shape (a), a lock:
1. Bob challenges with his move and one junk byte as his signature. The hub accepts it through ERC-1271.
2. Alice's SDK cannot verify the byte. After its fallback adopts the move unsigned from the hub's storage, she
   answers it.
3. Bob goes silent. Every proof Alice's SDK can build is then refused (`Unsupported`). Only Bob can re-register the
   state and resume the game, so he holds leverage over her deposit.

The review also traced shape (b): at a new-game boundary, the same kind of junk lets the griefer forfeit the victim's
new game, which takes one stake.

### 7.2 The decision

The owner chose the review's recommended fix: verify state and Close signatures with ECDSA only. The alternative
was SDK and daemon changes (un-parking h1-rereview N-2 and N-3). Those would have turned (b) into (a), but the lock
in (a) would have stayed as a documented residual for launch.

### 7.3 The change (`aa5ddfc`)

```diff
-import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
@@ _signedBy
-    function _signedBy(address signer, bytes32 hash, bytes memory sig) private view returns (bool) {
+    function _signedBy(address signer, bytes32 hash, bytes memory sig) private pure returns (bool) {
         if (sig.length == 0) return false;
         (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, sig);
-        if (err == ECDSA.RecoverError.NoError && recovered == signer) return true;
-        return SignatureChecker.isValidERC1271SignatureNow(signer, hash, sig);
+        return err == ECDSA.RecoverError.NoError && recovered == signer;
     }
```

- **NatSpec.** The comments on `_signedBy` and `_supported` are rewritten, not shown.
- **`RenounceDisabled` moves back to the error block.** It sat next to `renounceOwnership` only so that
  `mutants.sh`'s line numbers would not move (§2.2), and the script no longer uses line numbers (§7.6).
- **No ABI change.** The error set is the same, and `packages/sdk/src/abi.ts` still matches the build: `abi.test.ts`
  passes, and the file is unchanged.

**What it closes, for every signer, code or none:**
- Every non-empty slot the hub stores or emits is a 65-byte, low-`s` ECDSA signature by that slot's signer. That is
  exactly what the SDK verifies, so both shapes above are closed.
- Every emitted `SignedState` is at most 640 bytes. That closes the oversized-event residual of §1.3 (parent spec
  item 18's liveness risk, h1-rereview N-5 and N-6) for every client.

**What still works:**
- A session key under an EIP-7702 delegation. Its ECDSA signatures are checked against its address, and gaining
  code cannot revoke them (ruling R13; `test_ecdsaSignatureSurvivesSignerGainingCode` is unchanged).

**What is lost:**
- A contract signer (an ERC-1271 smart account) can no longer sign states or Close intents. The shipped client
  never used one: offers and relay joins already required ECDSA from the signer. A channel that names one can still
  settle, because a challenge on the opening state needs no signature (`test_contractSignerRefused`).

**Found while checking the SDK against the new rule (fixed, `aeed9dc`).** viem's `recoverTypedDataAddress` also
recovers a signature's high-`s` twin, and a `v` of 0 or 1. OpenZeppelin's `ECDSA.tryRecover`, and so the hub,
refuses both.
- The risk: a griefer could relay a malleated signature on a move. The SDK would store it as verified, and every
  proof that carries it would then be refused. That is the same lock as (a), with no delegation needed.
- The fix: `recoverStateSigner` and `recoverCloseSigner` now throw unless the signature is 65 bytes, with `v` 27 or
  28 and a low `s`. Every signature the SDK itself makes already has this form.
- The hub-side pin is `test_ecdsaOnly_malleableFormsRefused`.
- `apps/server/src/relay.ts` uses the same function, so the relay now refuses such a signature as "state not signed
  by sender".

### 7.4 Tests

Four tests in `ChannelHub.dispute.t.sol`. The first three fail on the previous hub, as does
`test_contractSignerRefused`. The fourth passes on both, since OpenZeppelin's rules did not change.
- **`test_ecdsaOnly_acceptAllSigner_junkRefused`.** The PoC, as a regression test, with Bob's signer an
  accept-anything contract (`helpers/AcceptAllERC1271.sol`).
  - Junk in his slot is refused in each form: as the mover's signature (`BadSignature`), as a non-mover
    co-signature (`BadSignature`), and on a both-signed state (`Unsupported`).
  - Alice's own exit then settles normally.
- **`test_ecdsaOnly_delegatedSessionKey_realSignaturesOnly`.** Accept-anything code is etched onto Bob's session key.
  - His junk is refused, and his real ECDSA signature is accepted.
  - The PoC's lock is gone: Alice answers, Bob goes silent, and the proof built from his verified signature registers
    her state. Bob, on move, forfeits.
- **`test_ecdsaOnly_delegatedSessionKey_closeNeedsRealSignature`.** The same delegated key's junk Close signature is
  refused; its real one closes.
- **`test_ecdsaOnly_malleableFormsRefused`.** A high-`s` twin and `v` as 0/1 are refused, though `ecrecover` maps the
  twin to the signer.

`ChannelHub.erc1271.t.sol`'s `test_contractSignerAccepted` becomes `test_contractSignerRefused`.

The SDK adds three tests (`eip712.test.ts`, `session.test.ts`), and all three fail on the previous SDK:
- recovery refuses the twin, `v` as 0/1, and 64- and 66-byte signatures;
- a session refuses them in a relayed move and in a Close signature;
- `challengeProof()` leaves out a lone opening signature (final review A m-3).

### 7.5 Gas and size

Measured with forge 1.8.3 on the standard EVM, before (`f1f7e83`) and after (`aa5ddfc`):

| Measure | Before | After | Change |
|---|---:|---:|---:|
| `challenge`, heaviest stalemate (`Gas.t.sol`) | 2,023,651 | 2,023,507 | −144 |
| `respond`, heaviest stalemate | 1,860,614 | 1,860,470 | −144 |
| `respond`, heaviest stalemate, co-signed `latest` | 1,866,470 | 1,866,278 | −192 |
| `respond` median, `ChannelHub.dispute.t.sol`'s 26 earlier tests (`--gas-report`) | 129,624 | 129,576 | −48 |
| `closeCooperative` median, `ChannelHub.close.t.sol` | 72,735 | 69,851 | −2,884 |
| Runtime size | 13,026 B | 12,927 B | −99 B |
| Initcode size | 14,016 B | 13,917 B | −99 B |
| Deploy `gasUsed`, local stock anvil, same constructor arguments | 3,024,892 | 3,003,483 | −21,409 |

- **Valid signatures cost slightly less.** The ECDSA path is unchanged, and the fallback's code is gone.
- **Refused signatures cost much less.** An invalid signature no longer pays for a `staticcall` to the signer: a cold
  account access, and a copy of the bytes. Two figures show it. The `closeCooperative` median falls by 2,884 because
  the suite includes refused Close signatures. The 200 KB junk challenge in `test_I1_challenge_…` reverts at 995,640
  gas instead of 1,266,623.
- **The worst case is unchanged in practice:** $2{,}023{,}507 / 30{,}000{,}000 \approx 6.7\%$ of Arc's block.

### 7.6 Mutants

`scripts/tools/mutants.sh` now anchors every mutant on the text of the line it changes. Removing the import shifts every line
below it, which would have moved the 10 mutants still addressed by line number (§2.2). Seven of those rewrite the
whole line at their number, so they would have silently mutated a different line.

Each mutant also declares how many lines it changes (default 1). The run fails, as `NOT_APPLIED` or `MISAPPLIED`, if
the diff against the pristine hub does not match.

New mutant **E1** restores the ERC-1271 fallback inline. It changes two lines, because `_signedBy` also turns from
`pure` to `view`. It is killed by exactly the four I-1 tests: `test_contractSignerRefused` and the first three of
§7.4.

### 7.7 Gates, run on `aa5ddfc`–`aeed9dc`

| Gate | Result |
|---|---|
| `forge test --root contracts` | **169 passed, 0 failed** (19 suites): 164 before, plus 4 I-1 tests and `Deploy.t.sol` |
| Mutants (`scripts/tools/mutants.sh`, profile `mutation`, seed `0x1`) | **28/28 killed**, 10m58s (27 before, plus E1) |
| Slither (`scripts/tools/slither.sh`) | **0 High, 0 Medium**, exit 0. 2 informational, both in chess code, as before |
| Echidna 2.3.3 (`scripts/tools/echidna.sh`) | **4/4 properties pass**, 50,105 calls, seed 7006971862442609919. The harness now signs with real keys (hevm `sign`). Its old accept-all ERC-1271 signers would have made every signed action revert silently, so the properties would have passed vacuously. A probe run (20,222 calls) confirmed that `closeCooperative`, a signed `challenge`, `respond` and `timeout` each succeed |
| Deep profile (`ARENA_DEEP_VECTORS=1 FOUNDRY_PROFILE=deep forge test --root contracts`) | **244 passed, 0 failed, 126 skipped (370)**, on the existing deep vectors (generated 2026-09-28; the chess code has not changed since 2026-09-25) |
| `packages/sdk` (`vitest run`, under `flock /tmp/claude-1000/arena-8546.lock`) | **15 files, 250 tests passed**. That includes the lifecycle tests against this hub on anvil, and `abi.test.ts` |

`test:cli`, `test:server`, `test:system` and `test:arc` were not run for this change. The controller runs them on the
release commit (gates item 9).

### 7.8 Redeploy

- **The hub's bytecode changed, so the testnet hub needs a redeploy.**
  - The current testnet hub, `0x9b8B…bA41`, still has the ERC-1271 fallback.
  - The redeploy costs about 0.10 USDC, like §5.2's, since `ChessRules` is redeployed with the hub.
  - Then the rehearsal is rerun on the new hub (`mainnet-gates.md` item 4).
  - The controller does both, with the testnet deployer as the only sender.
- **Nothing was deployed or sent for this change.** The only chains used were forge's in-process EVM and a
  throwaway local anvil, for the deploy-gas figure.
- **The mainnet steps are in `docs/superpowers/arc-mainnet-runbook.md`.**
