# Arc mainnet deploy runbook (Plan 6, Task 6)

**Status: not run.** Nothing is deployed on Arc mainnet. Run this only when every item in `mainnet-gates.md` holds
and the owner has given an explicit "go" (spec `2026-10-23-arc-launch-design.md` §5). It is self-contained: the
testnet record in `arc-testnet-rehearsal.md` §1 explains where each step comes from, but nothing here depends on it.

The ownership flow is fixed: **deploy with the deployer as owner, then hand ownership to the multisig with
`transferOwnership`, and have the multisig call `acceptOwnership()` on Arc** (§8). The constructor sets
`ARENA_OWNER` as owner directly, with no acceptance step, so deploying straight to the multisig would never show
that the multisig can transact on Arc. A Safe that exists only on another chain, or a typo, would then hold the pause
key, and only a redeploy could fix it. `renounceOwnership` is disabled on-chain (audit M2), so ownership can only
ever move by this two-step hand-over.

## 0. Before you start

- **The gates hold**, including the testnet redeploy and re-rehearsal of the ECDSA-only hub (`mainnet-gates.md`
  item 4), and the final test gate on the release commit (item 9).
- **Deploy from the release commit.** In `contracts/`, `git status --porcelain -- .` prints nothing, and
  `git rev-parse HEAD` is the commit that passed item 9. Step 6 compares the deployed bytecode with this build.
- **No `contracts/deployments/5042.json` exists yet** (it is untracked until §9). If one exists, stop and find out
  which dry run or deploy wrote it before going on. If you abandon the run after the dry run (§4), or must redo
  §3 and §4, clear that run's outputs as §5's "Redo" says, so that no later step trusts its predicted addresses.
- **The deployer** is a fresh key or the owner's own wallet, in a Foundry keystore (§2). It holds at least 1 USDC
  on Arc mainnet. The testnet deploy cost 0.1035 USDC at 21 gwei (4.93M gas). The dry run quotes about 0.26 USDC at
  the 40 gwei cap, and the transfer in §8 costs about 0.001 USDC.
- **The multisig exists on Arc mainnet** (it has code at its address there; §3 checks it). Its signers can sign
  within minutes (gates item 7), and it holds a little USDC on Arc for gas. 0.05 USDC covers the acceptance and the
  pause drill in §8 many times over.
- **The fee recipient can transact on Arc.** If a payout to it is ever deferred to `owed`, only it can `claim()`
  it (audit M1). The multisig itself is a good choice.

## 1. Values

The owner fills in every `<placeholder>`. The arrays below fail to parse until each one is replaced, so nothing runs
on a half-filled block. None of these are secrets, and the key never appears here. Use plain shell variables, not
exported ones.

```bash
RPC=https://rpc.mainnet.arc.io
ACCOUNT=arena-mainnet-deployer            # the Foundry keystore name (§2)
DEPLOYER=<deployer address>               # cast wallet address --account "$ACCOUNT"
MULTISIG=<multisig address on Arc mainnet>
DEPLOY_ENV=(
  ARENA_OWNER="$DEPLOYER"                 # the deployer first; §8 moves ownership to the multisig
  ARENA_FEE_RECIPIENT=<fee recipient address>
  ARENA_TOKEN=0x3600000000000000000000000000000000000000   # Arc USDC; Deploy.s.sol refuses any other on 5042
  ARENA_FEE_PER_PLAYER=5000               # 0.005 USDC per player per channel
  ARENA_MAX_FEE_PER_PLAYER=1000000        # 1 USDC: the immutable cap on any later setFee
  ARENA_MAX_DEPOSIT_PER_PLAYER=10000000   # 10 USDC per player (spec §13 launch limit)
  ARENA_MAX_COMMITTED_ESCROW=1000000000   # 1,000 USDC committed hub-wide (spec §13 launch limit)
)
FORGE_GAS=(--with-gas-price 40000000000 --priority-gas-price 1000000000 --timeout 120)
CAST_GAS=(--gas-price 40000000000 --priority-gas-price 1000000000 --timeout 120)
```

The fee, the max fee and both limits are the spec's launch values. The owner signs them off (gates item 4) before
the broadcast. The gas flags cap the fee at the profile's 40 gwei ceiling, with a 1 gwei tip. Arc charges base fee
plus tip, and its base fee sits at the 20 gwei floor (`arc-facts.md`), so the testnet deploys paid 21 gwei. A cap at
the bare 20 gwei floor leaves no room for a tip, and Arc's mempool silently drops anything under the floor.

## 2. The deploy key (once)

```bash
cast wallet import "$ACCOUNT" --interactive    # prompts for the private key and a password; nothing on argv
cast wallet address --account "$ACCOUNT"        # set DEPLOYER to this
```

- Never pass `--private-key` on the command line, and never put the key in an exported variable (gates item 4).
  Any local process of the same user can read argv while forge runs.
- forge and cast prompt for the keystore password. The only non-interactive alternative is
  `--password-file <file>`, with the file at mode 0600.
- A hardware wallet (`--ledger` or `--trezor`) works in place of `--account "$ACCOUNT"` everywhere below.

## 3. Pre-flight reads (read-only)

Run from `contracts/`. Each check prints `OK` or `STOP`, and any `STOP` ends the run.

A failed `cast` read prints nothing to stdout, so every check first requires its value to be non-empty. A failed
read is a `STOP`, never an `OK`. A `STOP` that comes from a failed read (an RPC flake, a rate limit) can simply be
retried.

```bash
cd contracts
CHAIN=$(cast chain-id --rpc-url "$RPC"); [ "$CHAIN" = 5042 ] && echo OK || echo "STOP: not Arc mainnet ('$CHAIN')"
CODE=$(cast code "$MULTISIG" --rpc-url "$RPC") && [ -n "$CODE" ] && [ "$CODE" != 0x ] && echo OK \
  || echo "STOP: the multisig has no code on Arc, or the read failed"
cast balance "$DEPLOYER" --rpc-url "$RPC" --ether                 # at least 1 (native USDC, 18 decimals)
N=$(cast nonce "$DEPLOYER" --rpc-url "$RPC" --block latest)
P=$(cast nonce "$DEPLOYER" --rpc-url "$RPC" --block pending)
[ -n "$N" ] && [ "$N" = "$P" ] && echo OK || echo "STOP: a tx is pending, or a read failed (latest '$N', pending '$P')"
cast call 0x3600000000000000000000000000000000000000 "decimals()(uint8)" --rpc-url "$RPC"    # 6
[ ! -e deployments/5042.json ] && echo OK || echo "STOP: deployments/5042.json exists (a redo? see §5)"
cast compute-address "$DEPLOYER" --nonce "$N"                     # predicted ChessRules
cast compute-address "$DEPLOYER" --nonce "$((N + 1))"             # predicted ChannelHub
```

Write down `N` and the two predicted addresses.

## 4. Dry run

```bash
env "${DEPLOY_ENV[@]}" forge script script/Deploy.s.sol --rpc-url "$RPC" \
  --account "$ACCOUNT" --sender "$DEPLOYER" "${FORGE_GAS[@]}"
```

- **Expect** two contract creations (`ChessRules`, then `ChannelHub`) and "SIMULATION COMPLETE". The testnet
  redeploy's dry run estimated 6,407,016 gas, "0.25628064 USDC" at the 40 gwei cap.
- **The dry run already writes `deployments/5042.json`** with forge's predicted addresses, because `vm.writeJson`
  runs during simulation too. It also writes `broadcast/Deploy.s.sol/5042/dry-run/run-latest.json`. Reconcile
  before going on: both addresses in `deployments/5042.json` equal the two predicted in §3. If they differ, the
  nonce moved: follow §5's "Redo".
- A revert reading "Deploy: on Arc (5042, 5042002) ARENA_TOKEN must be USDC 0x3600…" means `ARENA_TOKEN` is
  wrong. Fix §1. Do not work around the check.

## 5. Broadcast

Re-assert the chain id and the nonce first. If the nonce moved since §3, the addresses change: follow "Redo" below
before broadcasting.

```bash
CHAIN=$(cast chain-id --rpc-url "$RPC"); [ "$CHAIN" = 5042 ] && echo OK || echo "STOP: not Arc mainnet ('$CHAIN')"
P=$(cast nonce "$DEPLOYER" --rpc-url "$RPC" --block pending)
[ -n "$N" ] && [ "$P" = "$N" ] && echo OK || echo "STOP: nonce moved, or a read failed (pending '$P', §3's N '$N')"
env "${DEPLOY_ENV[@]}" forge script script/Deploy.s.sol --rpc-url "$RPC" \
  --account "$ACCOUNT" --sender "$DEPLOYER" "${FORGE_GAS[@]}" --broadcast
```

**Resume, when the broadcast stopped after `ChessRules`.** Forge may exit or time out after the first transaction.
- *How to recognize it:*
  - the deployer's nonce (latest and pending) is now `N + 1`;
  - `cast code` at §3's predicted `ChessRules` address is non-empty;
  - `cast code` at the predicted `ChannelHub` address is `0x`;
  - an empty output is a failed read: retry it.
- *What to do:* do not follow "Redo" below. That would deploy a second `ChessRules` at `N + 1` and leave the first one
  orphaned. Instead, rerun the same command with `--resume` added:

```bash
env "${DEPLOY_ENV[@]}" forge script script/Deploy.s.sol --rpc-url "$RPC" \
  --account "$ACCOUNT" --sender "$DEPLOYER" "${FORGE_GAS[@]}" --broadcast --resume
```

- `--resume` does not simulate the script again. It sends the transactions of `broadcast/Deploy.s.sol/5042/
  run-latest.json` that have not landed, at the nonces recorded there, so the hub lands at `N + 1`, the address §3
  predicted. The constructor arguments come from that record, so `deployments/5042.json` (written when the
  broadcast run started) still names the right pair.
- Then reconcile in §6 against the receipts.
- If `--resume` refuses, for example because the record is missing, follow "Redo". The orphan `ChessRules` costs
  about 0.04 USDC and is never pinned.

**Redo, when the nonce moved after §3.** §4's dry run wrote `deployments/5042.json`, so a plain rerun of §3 stops
at its "already exists" check. Clear that run's outputs first:

1. **Find out why the nonce moved.** This key exists only for this deploy, so a transaction you cannot account for
   means someone else holds it. Stop the deploy and treat the key as compromised.
2. **Check that nothing landed at the old addresses.** Run `cast code` on both addresses §3 predicted, at the old
   `N`. `cast code` prints `0x` for no code; an empty output is a failed read, so retry it.
   - Both `0x`: nothing was deployed. Go on.
   - The hub has code: an earlier broadcast landed. Do not deploy again. Go to §6 with
     `broadcast/Deploy.s.sol/5042/run-latest.json`.
   - Only `ChessRules` has code: the broadcast stopped halfway. Use "Resume" above, not this redo.
3. **Remove the dry run's outputs.** These files must be untracked, so confirm that first:
   ```bash
   git status --porcelain -- deployments/5042.json      # must print "?? contracts/deployments/5042.json"
   rm deployments/5042.json && rm -r broadcast/Deploy.s.sol/5042/dry-run
   ```
   If `git status` shows the file as tracked, a deploy was already committed. Stop: this runbook does not cover
   that case.
4. **Redo §3 and §4 from the top,** with the new `N` and its predicted addresses, then come back here.

## 6. Reconcile and read back

```bash
HUB=$(jq -r .channelHub deployments/5042.json); RULES=$(jq -r .chessRules deployments/5042.json)
jq '.transactions[] | {contractName, contractAddress, hash}' broadcast/Deploy.s.sol/5042/run-latest.json
jq '.receipts[] | {status, blockNumber, gasUsed, effectiveGasPrice}' broadcast/Deploy.s.sol/5042/run-latest.json
```

- **The three sources agree.** Each `contractAddress` in `run-latest.json`, the broadcast's rewrite of
  `deployments/5042.json`, and §3's predicted address are the same. Both receipts show `status` `0x1`.
- **Code is present and is this build's.**
  - `cast code "$HUB"` and `cast code "$RULES"` are non-empty.
  - Their runtime sizes equal `forge build --sizes` at the release commit.
  - Each equals `out/<Contract>.sol/<Contract>.json`'s `.deployedBytecode.object` byte for byte, once the ranges in
    `.deployedBytecode.immutableReferences` are masked to zero in both. The hub's `token` and `maxFeePerPlayer` are
    immutables. This is the comparison of `arc-testnet-rehearsal.md` §1.
- **The hub reads back as deployed.** Use `cast call "$HUB" "<getter>()(<type>)" --rpc-url "$RPC"`:

  | Call | Expected |
  |---|---|
  | `owner()(address)` | `$DEPLOYER` |
  | `pendingOwner()(address)` | `0x0000…0000` |
  | `feeRecipient()(address)` | the fee recipient |
  | `feePerPlayer()(uint256)` | 5000 |
  | `maxFeePerPlayer()(uint256)` | 1000000 |
  | `maxDepositPerPlayer()(uint256)` | 10000000 |
  | `maxCommittedEscrow()(uint256)` | 1000000000 |
  | `token()(address)` | `0x3600000000000000000000000000000000000000` |
  | `paused()(bool)` | false |
  | `committedEscrow()(uint256)` | 0 |

- **Renounce is disabled.** `cast call "$HUB" "renounceOwnership()" --from "$DEPLOYER" --rpc-url "$RPC"` reverts
  with `RenounceDisabled()`, `0x89051165`.
- **The money adds up.** The deployer's balance fell by exactly the two receipts' `gasUsed × effectiveGasPrice`,
  and its nonce rose by 2.

## 7. Verify the source

From the repo root:

```bash
cd ..
env "${DEPLOY_ENV[@]}" ARENA_CHAIN_ID=5042 ARENA_EXPLORER_URL=https://explorer.arc.io scripts/verify-arc.sh
```

- **`ARENA_OWNER` must be the constructor's value: the deployer.** The script ABI-encodes the constructor arguments
  from these variables for the explorer's standard-input step, whenever the explorer answers. It must still be
  given the deployer after §8 has moved ownership. `DEPLOY_ENV` already holds it, so do not substitute the
  multisig.
- **`explorer.arc.io`'s API may refuse the script.**
  - On 2026-10-25, a scripted GET of `https://explorer.arc.io/api/v2/smart-contracts/verification/config` returned
    HTTP 403, with a Cloudflare "Just a moment…" challenge page. Sourcify's `/server/chains` lists 5042 ("Arc
    Mainnet") as supported.
  - Since FW-C's `bb7acb0`, the script treats an explorer that does not answer as one WARNING naming curl's error.
    It skips the explorer's standard-input step, its import and its poll, and still runs Sourcify.
  - It counts a contract as VERIFIED on the explorer's `is_fully_verified` or on Sourcify's `exact_match`, and
    exits 0 only if both contracts have one.
  - So while the block lasts, Sourcify's `exact_match` is the proof of the source. The explorer page's import from
    Sourcify then has to be done another way: the explorer's web UI, or Arc or Blockscout support.
  - Check the endpoint again before Task 6.
- **Accept only a full match** (`is_fully_verified`, or Sourcify `exact_match`). A partial match does not prove the
  source.

## 8. Hand ownership to the multisig, on Arc

```bash
cd contracts
cast send "$HUB" "transferOwnership(address)" "$MULTISIG" --rpc-url "$RPC" --account "$ACCOUNT" "${CAST_GAS[@]}"
cast call "$HUB" "pendingOwner()(address)" --rpc-url "$RPC"   # $MULTISIG
cast call "$HUB" "owner()(address)" --rpc-url "$RPC"          # still $DEPLOYER: it keeps every right until acceptance
```

Then **the multisig sends `acceptOwnership()` to `$HUB` on Arc mainnet**, through its own interface. The call takes
no arguments, and its calldata is the selector `0x79ba5097`. This is the multisig's own transaction on Arc. It proves
the multisig can transact there before it holds the pause key. Then:

```bash
cast call "$HUB" "owner()(address)" --rpc-url "$RPC"          # $MULTISIG
cast call "$HUB" "pendingOwner()(address)" --rpc-url "$RPC"   # 0x0000…0000
```

The hub emitted `OwnershipTransferred(DEPLOYER, MULTISIG)`. Record both transaction hashes.

- **If the multisig cannot send it,** nothing is lost: the deployer is still the owner. Fix the multisig, or point
  the transfer elsewhere with a new `transferOwnership(<address>)`. A pending transfer can be redirected, or
  cancelled with `address(0)` (`ChannelHub.owner.t.sol`).
- **Do not pin or announce the hub until `owner()` is the multisig.**
- **Recommended: the pause drill (gates item 7).** The multisig sends `setPaused(true)`. Check that `paused()` reads
  true, and that an `eth_call` of `deposit` reverts with `Paused()`, `0x9e87fac8`. Then the multisig sends
  `setPaused(false)`. This times the signers' real response before any user funds are in the hub.
- **Read the pause on-chain, never from the host's `/templates`.** While the host's limits reads fail, `/templates`
  keeps serving the last good value, with no age cap. During an RPC outage it can therefore show `paused: false`
  for a hub that is paused (final review C re-review N-5). No funds are at risk, because the daemon re-reads the
  hub before every deposit and the lobby checks live. Still, confirm a pause with `cast call "$HUB"
  "paused()(bool)"`.

## 9. Commit, pin, record

- **Commit `contracts/deployments/5042.json`**, only after §6 has reconciled it. First add `"deployBlock": <the
  block both deploy receipts landed in>` to it, as `5042002.json` has: `Deploy.s.sol` does not write it, and the
  self-host image (`deploy/host`, `pnpm build:server`) serves Arc mainnet only from a pinned file that records it.
- **Pin `KNOWN_DEPLOYMENTS[5042]`** in `packages/cli/src/config.ts`: the hub, the rules and the token. Add the
  matching check to `packages/cli/test/chains.test.ts`, which compares the 5042002 pin with
  `contracts/deployments/5042002.json` today.
- **Record the evidence** in `mainnet-gates.md` item 4, and tick it:
  - the release commit;
  - both deploy transaction hashes, the block, gas used and cost;
  - the verification links;
  - the `transferOwnership` and `acceptOwnership` hashes, and the pause drill's hashes if it was run.
- **The production server config** (`docs/deploy/arc-mainnet.server.json.example`, Task 6) sets
  `indexer.startBlock` to the deploy block, and `xmtp.env` to `"production"` if XMTP is configured. On chain 5042 the
  server refuses to start without either (final wave C, `4184a16`). It also refuses an `rpcUrl` whose `eth_chainId`
  is not the config's `chainId`.
- **Time `eth_getLogs` on the RPC the server will use** (h3-rereview M-f). The 2026-10-25 reference is in
  `arc-facts.md`.
