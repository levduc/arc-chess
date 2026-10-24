# Arc testnet dress rehearsal (Plan 6, Task 5)

## 1. Deploy

Deployed from `0x840d6f90dd12A713CC5F1fb6EAbBF99e0E74A7E0` (the testnet deployer; key in
`~/.config/arena-deploy/arc-testnet-deployer.json`, mode 0600, never printed or committed) to **Arc testnet**
(chain `5042002`, RPC `https://rpc.testnet.arc.io`). Chain ID was asserted (`eth_chainId == 0x4cef52`) before the
dry run and again immediately before the broadcast.

### Command

```
cd contracts
ARENA_OWNER=0x840d6f90dd12A713CC5F1fb6EAbBF99e0E74A7E0 \
ARENA_FEE_RECIPIENT=0x840d6f90dd12A713CC5F1fb6EAbBF99e0E74A7E0 \
ARENA_TOKEN=0x3600000000000000000000000000000000000000 \
ARENA_MAX_DEPOSIT_PER_PLAYER=2000000 \
ARENA_MAX_COMMITTED_ESCROW=50000000 \
forge script script/Deploy.s.sol \
  --rpc-url https://rpc.testnet.arc.io \
  --private-key "$ARENA_DEPLOYER_KEY" \
  --broadcast \
  --with-gas-price 40000000000 \
  --priority-gas-price 1000000000 \
  --timeout 120
```

`ARENA_FEE_PER_PLAYER` (5,000) and `ARENA_MAX_FEE_PER_PLAYER` (1,000,000) were left at the script's defaults, as
required.

A dry run (same command without `--broadcast`) was run first and succeeded, estimating 6,390,739 gas and
0.1278 USDC at a 20 gwei quote. The real run cost less than that estimate (0.1032 USDC, below) even though the
effective price (21 gwei) was higher than the dry run's 20 gwei quote — actual gas used, 4,915,954, came in about
23% under forge's padded gas estimate.

### Gas price: observed base fee vs. the floor

`eth_gasPrice` returned 25 gwei and `eth_maxPriorityFeePerGas` suggested 5 gwei, but the actual latest-block
`baseFeePerGas` was exactly **20 gwei** — matching `arc-facts.md`'s "flat at 20 gwei" observation; the RPC's
gas-price suggestions were conservative overestimates. Passing `--with-gas-price 20000000000` (the bare floor)
would have left zero room for a priority fee under EIP-1559 and risked the transaction being dropped if the base
fee ticked up even slightly. Instead we used `--with-gas-price 40000000000` (the profile's `feeCeilingWei`, as a
safe cap) and `--priority-gas-price 1000000000` (1 gwei tip). The chain charged the effective price
`baseFee + tip = 21 gwei` on both transactions — comfortably above the 20 gwei floor, comfortably under the
40 gwei ceiling, and cheaper than the cap we offered.

### Transactions

| Contract | Tx hash | Explorer | Gas used | Effective price | Cost (USDC) |
|---|---|---|---|---|---|
| `ChessRules` | `0xdecedeb47e7ea9dcaff527b87569e9af410f538ef8dc8f1658de02b7714dcec7` | https://explorer.testnet.arc.io/tx/0xdecedeb47e7ea9dcaff527b87569e9af410f538ef8dc8f1658de02b7714dcec7 | 1,903,343 | 21 gwei | 0.039970203 |
| `ChannelHub` | `0xbb027d0e6a85a99a67fd84f186f02aa152f6d66b5fa370d5eac8776107cf3d42` | https://explorer.testnet.arc.io/tx/0xbb027d0e6a85a99a67fd84f186f02aa152f6d66b5fa370d5eac8776107cf3d42 | 3,012,611 | 21 gwei | 0.063264831 |
| **Total** | | | **4,915,954** | | **0.103235034** |

Both transactions landed with `status: 0x1` (success) in the same block, `68820062`; Arc's instant finality meant
no meaningful wait for receipts.

### Deployed addresses

| Contract | Address | Explorer |
|---|---|---|
| `ChessRules` | `0x3fC37CCC07dbCd6cF3E894BA8df4e6D3Ff16E6E5` | https://explorer.testnet.arc.io/address/0x3fC37CCC07dbCd6cF3E894BA8df4e6D3Ff16E6E5 |
| `ChannelHub` | `0x9fcFBAC9FE8Dd64fB4602FB30A1583114Cef6893` | https://explorer.testnet.arc.io/address/0x9fcFBAC9FE8Dd64fB4602FB30A1583114Cef6893 |
| `USDC` (pre-existing) | `0x3600000000000000000000000000000000000000` | https://explorer.testnet.arc.io/address/0x3600000000000000000000000000000000000000 |

Written to `contracts/deployments/5042002.json` (same `{channelHub, chessRules, token}` shape as
`contracts/deployments/31337.json`), by the script's own `vm.writeJson`. **Not** pinned in
`packages/cli/src/config.ts` — that pin is a later step, owned by another part of this plan.

### On-chain verification (reads, not source)

Both addresses have non-empty code (`eth_getCode`: `ChannelHub` 12,968 bytes, `ChessRules` 8,557 bytes). Hub reads
back exactly as deployed:

| Call | Value |
|---|---|
| `owner()` | `0x840d6f90dd12A713CC5F1fb6EAbBF99e0E74A7E0` |
| `feeRecipient()` | `0x840d6f90dd12A713CC5F1fb6EAbBF99e0E74A7E0` |
| `feePerPlayer()` | `5000` |
| `maxFeePerPlayer()` | `1000000` |
| `maxDepositPerPlayer()` | `2000000` |
| `maxCommittedEscrow()` | `50000000` |
| `token()` | `0x3600000000000000000000000000000000000000` |

All match the intended testnet configuration (defaults for the fee, testnet limits for deposit/escrow, deployer as
both owner and fee recipient).

### Source verification

`explorer.testnet.arc.io` is a **Blockscout** instance (confirmed via `/api/v2/smart-contracts` and the
Etherscan-compatible `/api?module=contract&action=getabi`, both of which respond with Blockscout's characteristic
shapes). **Both contracts are now verified on it**: `ChessRules` and `ChannelHub` each show `is_verified: true`
and `is_fully_verified: true` at `/api/v2/smart-contracts/{address}`, with `compiler_settings.viaIR: true`,
`evmVersion: cancun`, `optimizer.runs: 200` and compiler `v0.8.28+commit.7893614a` — exactly `contracts/foundry.toml`'s
`[profile.default]`. Explorer links:

| Contract | Explorer (source tab) |
|---|---|
| `ChessRules` | https://explorer.testnet.arc.io/address/0x3fC37CCC07dbCd6cF3E894BA8df4e6D3Ff16E6E5?tab=contract |
| `ChannelHub` | https://explorer.testnet.arc.io/address/0x9fcFBAC9FE8Dd64fB4602FB30A1583114Cef6893?tab=contract |

It took two tries. `scripts/verify-arc.sh` (new; mainnet reuses it unchanged) automates the sequence below.

**First try (the one documented in the original version of this section): Blockscout's own standard-input
recompile, via two independent routes, both failed.**
1. `forge verify-contract --verifier blockscout --verifier-url https://explorer.testnet.arc.io/api --chain 5042002`
   for `ChessRules` (no constructor args). Submission succeeded (status `OK`, a GUID was returned), but polling
   `checkverifystatus` returned `Fail - Unable to verify`, with no further detail from the API.
2. A direct `POST .../api/v2/smart-contracts/{address}/verification/via/standard-input` with the exact
   `--show-standard-json-input` dump forge produced from the same build that produced the deployed bytecode, for
   both `ChessRules` and `ChannelHub` (the latter with its ABI-encoded constructor args supplied explicitly). Both
   submissions were accepted ("Smart-contract verification started"), but `is_verified` stayed `false` for both
   addresses afterward.

That original report flagged a missing `viaIR: true` as the prime suspect. **This rules out:** a fresh
`forge verify-contract --show-standard-json-input` dump (same `forge`, same `foundry.toml`) does include
`settings.viaIR: true`, the correct `evmVersion`, `optimizer` and `metadata` settings, and the same remappings —
confirmed by inspecting the dump directly before resubmitting. The constructor args were also correct both times:
the explorer's own stored `creation_bytecode` for `ChannelHub` has, as its last 448 hex characters, exactly
`cast abi-encode "constructor(address,address,address,uint256,uint256,uint256,uint256)" <token> <owner>
<feeRecipient> 5000 1000000 2000000 50000000` — byte-for-byte.

To rule out a bytecode mismatch on our side, we diffed forge's local build artifacts against `eth_getCode`
on-chain: `ChessRules` matched **byte-for-byte identical** (17,116 hex characters, including the metadata CBOR
tail). `ChannelHub` initially looked like a mismatch at byte offset 455, but that's `token`'s **immutable**
storage slot (`deployedBytecode.immutableReferences` in the build artifact) — zero-filled in the unlinked
artifact, filled with the real token address on-chain; masking every `immutableReferences` range in both buffers
to zero made them match exactly too. Both deployed contracts are exactly what the repo's pinned
`solc 0.8.28+commit.7893614a`, `viaIR`, `optimizer runs=200`, `evmVersion=cancun` settings produce.

**The second try used a completely independent compiler — Sourcify — and that is what actually exposed and
fixed the problem.** Submitting the *identical* standard-json input (same file, same compiler version string, same
settings) to Sourcify's `POST /v2/verify/{chainId}/{address}` returned `creationMatch` and `runtimeMatch` of
`"exact_match"` for both contracts, each in under 6 seconds. Re-submitting that same input back to Blockscout's
own endpoint — this time via Sourcify's built-in "also notify Blockscout" forwarding — hit the identical
`Fail - Unable to verify` a second time, for both contracts, confirming the first failures weren't a fluke or a
rate-limit artifact. **This pins the root cause on Blockscout's own local recompile-and-match step on this
particular explorer instance**, not on anything in our build: the same inputs that this instance's matcher
rejects twice are proven correct by an entirely different compiler invocation (Sourcify's), by the exact
on-chain-bytecode diff above, and by Blockscout's own `/api/v2/smart-contracts/verification/config`, which lists
`v0.8.28+commit.7893614a` and `cancun` as supported and shows the Rust verifier microservice enabled. A sample of
120 already-verified contracts on this explorer had **zero** using `viaIR: true` — consistent with (not proof
of) a `viaIR`-specific bug in this instance's local matcher, since both our contracts are `viaIR` builds and both
failed the same way. We did not dig into Blockscout's verifier internals further than this; filing it with
Blockscout/Arc support would be the next step if this needs to be understood rather than worked around.

**The workaround that closed it out: import, don't recompile.** Blockscout has a separate
`POST /api/v2/smart-contracts/{address}/verification/via/sourcify` endpoint that takes a `metadata.json` plus the
exact source files (fetched straight from `GET https://sourcify.dev/server/v2/contract/{chainId}/{address}
?fields=metadata,sources`, once Sourcify has a match) and *imports* that already-computed match instead of
recompiling locally. **This was exercised and confirmed working for `ChessRules` only**: calling it returned
`"Smart-contract verification started"`, and `is_verified` flipped to `true` (`is_verified_via_sourcify: true`)
moments later. For `ChannelHub`, calling the same endpoint with the same shape of request returned
`"Already verified"` — by the time we called it, `is_verified` was already `true`, with `verified_at` timestamped
*before* our import call, and `is_verified_via_eth_bytecode_db: true` / `is_verified_via_verifier_alliance: true`
(`is_verified_via_sourcify: false`). So something else verified `ChannelHub` first — plausibly a background sync
between Blockscout's shared eth-bytecode-db/Verifier-Alliance pool and Sourcify's own match, which landed ~34
seconds after Sourcify's `verifiedAt` — but we did not confirm that mechanism; we only confirmed the before/after
state. **Practical consequence for `scripts/verify-arc.sh` and mainnet:** the Sourcify-import step is proven to
work on a cold contract (`ChessRules`); it was never actually exercised end-to-end on a contract that wasn't
already verified by something else (`ChannelHub`). Either way, both contracts now carry `viaIR: true` in their
*displayed* `compiler_settings` on Blockscout — proof the path that got them verified, unlike the local-recompile
path, is viaIR-clean.

We tried one additional diagnostic: joining Blockscout's Phoenix websocket
(`wss://explorer.testnet.arc.io/socket/v2/websocket`, topic `addresses:<address>`) to catch a `verification_result`
push with more detail than the REST API's generic failure string. The channel joined fine (`phx_reply` "ok"), but
across several minutes and two failed submissions it never pushed a `verification_result` event of any kind —
either the topic name was wrong, or this instance doesn't push that event over this channel. **Don't rely on this
as a working diagnostic**; the REST `is_verified` / Etherscan-compatible `checkverifystatus` polling above is what
actually worked for observing state.

No `foundry.toml` edit was needed or made: `via_ir`, `optimizer_runs`, `evm_version` and the remappings there were
already exactly what both successful verifications (the bytecode-level proof, and Sourcify's independent compile)
needed.

### Deployer balance

| | Native balance (18 dec) | USDC-equivalent |
|---|---|---|
| Before | `20000000000000000000` wei | 20.000000 USDC |
| After | `19896764966000000000` wei | 19.896764966 USDC |
| Spent | `103235034000000000` wei | **0.103235034 USDC** |

The spend matches the sum of the two transaction costs exactly (`0.039970203 + 0.063264831 = 0.103235034`),
confirming no other transactions were sent from this key. Nonce went from 0 → 2.

### Arc-specific surprises

- **`eth_gasPrice`/`eth_maxPriorityFeePerGas` over-suggest.** The node quoted a 25 gwei legacy gas price and a
  5 gwei priority fee, both above what was actually needed; the real base fee was the flat 20 gwei floor
  `arc-facts.md` predicted, and a 1 gwei tip was enough, giving an effective price of 21 gwei — about 19% below
  the RPC's 25 gwei quote. Relying on `--with-gas-price` set to exactly the 20 gwei floor (with no tip) would have
  risked a silent drop the moment the base fee moved even slightly. Using the fee ceiling (40 gwei) as the cap
  and a small explicit tip (1 gwei) was the correct, cheap combination: it paid only what the chain actually
  charged (base + tip), not the cap.
- **The dry run already writes `deployments/<chainId>.json`.** `vm.writeJson` is a cheatcode and runs during
  simulation too, so the dry run pre-populated `contracts/deployments/5042002.json` with the CREATE-predicted
  addresses before anything was broadcast. Because the deployer's nonce was still 0 at broadcast time, the
  predicted and actual addresses matched exactly — but this is worth checking explicitly (reconcile against
  `broadcast/Deploy.s.sol/5042002/run-latest.json` and `eth_getCode`) rather than trusting the dry run's file on
  its own, in case the nonce has moved between the dry run and the broadcast.
- **Blockscout's local recompile-and-match step rejected a provably exact bytecode match; importing an
  externally-computed match (Sourcify) worked around it.** Updated: see "Source verification" above — both
  contracts are now verified. The gap was real but is now understood to be scoped to Blockscout's own local
  matcher on this instance (likely `viaIR`-specific; 0/120 sampled verified contracts there used it), not to our
  build. Still worth filing with Blockscout/Arc support so the local path gets fixed directly.
- **`forge`/`cast`/`anvil` are not on `PATH`** in this shell by default; they live at `~/.foundry/bin` (installed
  via `foundryup`) and must be added to `PATH` explicitly, matching how `scripts/dev-up.ts` already does this for
  its own `anvil`/`forge` calls.
