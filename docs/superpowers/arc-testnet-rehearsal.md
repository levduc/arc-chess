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
`contracts/deployments/31337.json`), by the script's own `vm.writeJson`. Pinned in `packages/cli/src/config.ts`
(`KNOWN_DEPLOYMENTS[5042002]`) by the rehearsal step (§2), after this deploy and the source verification below.

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

## 2. The rehearsal (2026-10-24, 15:18–15:42 UTC)

`scripts/arc-rehearsal.ts` ran it end to end against the deployment above, with real faucet USDC. Rerun with
`pnpm exec tsx scripts/arc-rehearsal.ts --dir <dir>`. A rerun with the same `--dir` resumes after the last completed
step. `--collect-only` rebuilds the tables from the chain. It never deploys. Its header lists every safety rule. In short:

- The RPC is hard-coded to `https://rpc.testnet.arc.io`. `eth_chainId == 0x4cef52` is asserted before every deployer
  transaction.
- The deployer key is read into the script's memory for the funding step only.
- Every child process runs with `HOME` and `ARENA_HOME` in the run directory.
- Only pids the script started are ever signalled.

### Setup

- **Host server.** `apps/server` ran on `127.0.0.1:8760` with this config:
  - chain: `chainId` 5042002, and `rpcUrl` = `publicRpcUrl` = the testnet RPC;
  - XMTP: `xmtp: {"env": "dev"}`, with no gateway, because XMTP `dev` does not enforce fees;
  - indexer: starts at the deploy block, 68,820,062, in 10,000-block chunks, polling every 3 s;
  - `limits`: the defaults;
  - `audit`: "unaudited; Arc TESTNET dress rehearsal (Plan 6 Task 5), faucet USDC only, not a public deployment. Hub
    limits: 2 USDC deposit per player, 50 USDC total committed escrow; fee 0.005 USDC per player; owner and fee
    recipient are the testnet deployer".
- **Two agent homes, `alice` and `bob`.** Only CLI commands wrote them; no file was edited by hand.
  - `arena init --server http://127.0.0.1:8760 --port 8761|8762 --poll-ms 3000 --min-challenge-timeout 300`.
    `init` generated the wallet keys and took every address from `/templates`. Those addresses passed the new
    `KNOWN_DEPLOYMENTS[5042002]` pin.
  - `sessionGasWei` came out at the profile's 0.336 USDC.
  - `arena owner set 0x840d…7E0` ran before anything else, so the deployer is each home's owner.
  - `arena xmtp enable` ran once per home, each a real `@xmtp/node-sdk@6.1.0` install (476 MB, about 3 s each with a
    warm npm cache).
  - Both daemons started with `"fallback":"xmtp"`.
  - Wallets: alice `0x327999458DA726F37b3db68d4D38d3dEC1dCaE7E`, bob `0x639FFCA858FBFe35CC5596FcD1De6BaEc6755Eb5`.
- **Testnet only: `--min-challenge-timeout 300`.** The dispute channel's offer used `challengeTimeout` 300 s. The other
  two channels asked for the default 900 s explicitly, because that flag would otherwise make 300 s their default too.
- **Funding.** The deployer sent each wallet 2 USDC as a native transfer: on Arc, native gas and ERC-20 USDC are one
  balance. These are transactions 1–2 below.
- **Channels.** All three had deposit 1 USDC and stake 0.1 USDC. They ran strictly one after another: a channel opened
  only once both session keys of the previous one were swept. Alice offered and Bob accepted, so Alice is
  participant 0 every time.
  1. **`normal`** (`0xc2f7887629d9506ec3ef4508f2bfd96622ec361ad6af6fa911dee0b4d2b6a855`). Three games, then a
     cooperative close:
     - game 0: scholar's mate, Alice white, so Alice +0.1;
     - game 1: colours swap; fool's mate, Alice black, so Alice +0.1;
     - game 2: Alice plays e4 with a draw offer and Bob accepts, so a draw.

     Expected: participant 0 gets 1.2, participant 1 gets 0.8.
  2. **`dispute`** (`0xfea01d16477a4e1b609f936d7e1725f1095a0c0cbf2d8dd2d038772ef5a86801`, `challengeTimeout` 300):
     - Alice plays e4, then challenges.
     - Bob answers with e5 through `/move`, and his daemon submits a `respond`.
     - Bob then challenges the same registered state, which the hub allows for an identical state.
     - Alice, on move, does not move, and Bob's watchtower sends `timeout`.

     Expected: Alice forfeits one stake, so 0.9 / 1.1.
  3. **`xmtp`** (`0xb0b30f953c86d7b57371157ac2a02eae60f7c0a2036f08e4a1a2c793f3a04920`):
     - Both session keys were checked as registered on XMTP `dev`. The script did this with a short-lived SDK
       process, through `getInboxIdForIdentifier`.
     - Three moves went over the relay, then the script sent the host server **SIGKILL** by its pid.
     - Both daemons switched to `transport: "xmtp"`. The last four moves, Bob's auto-resign and both Close signatures
       went over XMTP `dev`, and Bob's daemon submitted `closeCooperative`.

     Expected: 1.1 / 0.9.
- **Afterwards.** `arena sweep` ran in both homes and found nothing left to sweep: `{"results": [], "remaining": 0}`.
  Then `arena withdraw --all` ran in both homes, paying the owner (the deployer). Then the daemons were stopped.

### Result

Every step passed, and every amount reconciles exactly:

- **Hub side.** In every channel, the deposits, the `Finalized` balances, the USDC transfers and the fees match the
  expected amounts to the micro-USDC. There were no `PayoutDeferred` events, and at the end `owed` = 0 for every
  address and `committedEscrow` = 0.
- **Wallet side.** For each home: funding + payouts − deposits − withdrawn − gas from receipts (gasUsed ×
  effectiveGasPrice, over the wallet and its three session keys) = what the wallet and its session keys hold now.
  This holds to the wei.
- **Whole run.** Deployer before = deployer after + what the agents still hold + all gas. This holds to the wei.

Gas for the whole run was **0.08266014 USDC**, across 34 transactions. The deployer's balance went from
**19.896764966** to **19.774950966** USDC.

The run had to be restarted three times before it finished. The script resumed each time from its `state.json`, and
the open channel was never at risk:

1. **15:19:27.** The deployer key file holds `data` as an array of `{address, private_key}`; the script expected an
   object. Nothing had been sent. Fixed in the script.
2. **15:21:05.** `POST /move` came back 500 "Request exceeds defined limit." (the RPC's rate limit), even though the
   move had been made (see 8.2). The normal channel was Open at turn 3. The script now treats a rate-limited action
   by checking whether it took effect.
3. **15:27:14.** The script's own gas guard stopped the run by mistake. It did not count the 2.01 USDC escrowed in the
   open channel, so 2.0267 USDC looked "spent"; the real gas was 0.0167. The guard now counts the escrow.

A first attempt in another directory never got past `init`. Its alice wallet,
`0xA765E464E3a03978a2B679223d05503B28b9A056`, was never funded and holds 0. That attempt is how the getLogs limit
in 8.1 was found.

## 3. Transactions

Every transaction the deployer, the two wallets and the six session keys sent during the run is listed below. The
list comes from Blockscout's `/api/v2/addresses/<a>/transactions?filter=from`. It was checked against each sender's
nonce, and each sender's count matched (table in §5). The cost is the receipt's `gasUsed × effectiveGasPrice`.
Prices are in gwei.

| # | Action | Channel | Sender | Tx (explorer) | Gas used | Price (gwei) | Cost (USDC) |
|---|---|---|---|---|---|---|---|
| 1 | fund agent (deployer → wallet, 2 USDC) | — | deployer | [`0x12847b2ee77306184ae31d62dfb6960c56e120e8c1c7c8d2354a7c19838692c0`](https://explorer.testnet.arc.io/tx/0x12847b2ee77306184ae31d62dfb6960c56e120e8c1c7c8d2354a7c19838692c0) | 21,000 | 21 | 0.000441 |
| 2 | fund agent (deployer → wallet, 2 USDC) | — | deployer | [`0x2fa4f24299bf711cbeb4e57bfe0365e024abc4747ca30a1f85973b8ec8a7a0a1`](https://explorer.testnet.arc.io/tx/0x2fa4f24299bf711cbeb4e57bfe0365e024abc4747ca30a1f85973b8ec8a7a0a1) | 21,000 | 21 | 0.000441 |
| 3 | approve | — | alice wallet | [`0x921e1914a040af57ade45c143fde061017018c38ddd8cdff5a40297ebe075d1e`](https://explorer.testnet.arc.io/tx/0x921e1914a040af57ade45c143fde061017018c38ddd8cdff5a40297ebe075d1e) | 55,438 | 25 | 0.00138595 |
| 4 | session top-up (wallet → session key, 0.336) | normal | alice wallet | [`0xfe18ba542b3edd6cb9c8b6a2084ad3b55d53c6dd6a39ef863123e5671a552d8e`](https://explorer.testnet.arc.io/tx/0xfe18ba542b3edd6cb9c8b6a2084ad3b55d53c6dd6a39ef863123e5671a552d8e) | 21,000 | 25 | 0.000525 |
| 5 | deposit | normal | alice wallet | [`0xc2b32b2c87db51efb9a5047f98fcb3295b68eae82cdd0c81c2f49f5d2106394e`](https://explorer.testnet.arc.io/tx/0xc2b32b2c87db51efb9a5047f98fcb3295b68eae82cdd0c81c2f49f5d2106394e) | 393,833 | 25 | 0.009845825 |
| 6 | approve | — | bob wallet | [`0xf75242afb92e13fd03f641900ea1b41d6941085dfff18daf88c5de7fc1798f61`](https://explorer.testnet.arc.io/tx/0xf75242afb92e13fd03f641900ea1b41d6941085dfff18daf88c5de7fc1798f61) | 55,438 | 30 | 0.00166314 |
| 7 | session top-up (wallet → session key, 0.336) | normal | bob wallet | [`0x6ea6018f22cf5c4a448a5affa588294bfd357cca3f062922a7d4d78f942371f1`](https://explorer.testnet.arc.io/tx/0x6ea6018f22cf5c4a448a5affa588294bfd357cca3f062922a7d4d78f942371f1) | 21,000 | 25 | 0.000525 |
| 8 | deposit | normal | bob wallet | [`0x20a99b1a629d64725321bc03b11690dbc1151cad2564a79bc8f97910663b65ec`](https://explorer.testnet.arc.io/tx/0x20a99b1a629d64725321bc03b11690dbc1151cad2564a79bc8f97910663b65ec) | 76,417 | 25 | 0.001910425 |
| 9 | closeCooperative | normal | bob wallet | [`0xccb4dedc31c5c8598fb1df62067f594855bb9ce971f1cd5fe67c3c8dc14ca141`](https://explorer.testnet.arc.io/tx/0xccb4dedc31c5c8598fb1df62067f594855bb9ce971f1cd5fe67c3c8dc14ca141) | 142,568 | 25 | 0.0035642 |
| 10 | session sweep (session key → wallet) | normal | bob session (normal) | [`0x48c9eecbbc0ae0af1d0c40cf422b86c41095432fa3398471eaebbc7c30f4939c`](https://explorer.testnet.arc.io/tx/0x48c9eecbbc0ae0af1d0c40cf422b86c41095432fa3398471eaebbc7c30f4939c) | 21,000 | 25 | 0.000525 |
| 11 | session sweep (session key → wallet) | normal | alice session (normal) | [`0x6896e0d4823c0a7b1fc6d48d61f253c11b353a45a27c9fe63e6278187c37a5f6`](https://explorer.testnet.arc.io/tx/0x6896e0d4823c0a7b1fc6d48d61f253c11b353a45a27c9fe63e6278187c37a5f6) | 21,000 | 25 | 0.000525 |
| 12 | approve | — | alice wallet | [`0x570582b6a6df263a676808f9c0823dc1df579a01dfb1e4b9febc7665bb0aad15`](https://explorer.testnet.arc.io/tx/0x570582b6a6df263a676808f9c0823dc1df579a01dfb1e4b9febc7665bb0aad15) | 55,438 | 25 | 0.00138595 |
| 13 | session top-up (wallet → session key, 0.336) | dispute | alice wallet | [`0xf44e8cdb00b95a7642f7fcd779665de278cc42b72bf26f778378c4c0aabe4638`](https://explorer.testnet.arc.io/tx/0xf44e8cdb00b95a7642f7fcd779665de278cc42b72bf26f778378c4c0aabe4638) | 21,000 | 25 | 0.000525 |
| 14 | deposit | dispute | alice wallet | [`0x279e3a6d42170e2e61cc451023fbe01b7dac465c7bc72ae181dce6083c81452a`](https://explorer.testnet.arc.io/tx/0x279e3a6d42170e2e61cc451023fbe01b7dac465c7bc72ae181dce6083c81452a) | 393,833 | 25 | 0.009845825 |
| 15 | approve | — | bob wallet | [`0x10bc26636a13a42a69605c43f7400f98dfa63c9ef61b375876d5613e0d72debd`](https://explorer.testnet.arc.io/tx/0x10bc26636a13a42a69605c43f7400f98dfa63c9ef61b375876d5613e0d72debd) | 55,438 | 25 | 0.00138595 |
| 16 | session top-up (wallet → session key, 0.336) | dispute | bob wallet | [`0xd652685fb70f75c9313ea41d9e2ca2558108f223c90ece7f1c2c3faf1d55f8c7`](https://explorer.testnet.arc.io/tx/0xd652685fb70f75c9313ea41d9e2ca2558108f223c90ece7f1c2c3faf1d55f8c7) | 21,000 | 25 | 0.000525 |
| 17 | deposit | dispute | bob wallet | [`0x1dc4fbef2c0d9461823de9567915f02910eb4d1625e2198083c9a98abe1328b7`](https://explorer.testnet.arc.io/tx/0x1dc4fbef2c0d9461823de9567915f02910eb4d1625e2198083c9a98abe1328b7) | 76,417 | 25 | 0.001910425 |
| 18 | challenge | dispute | alice session (dispute) | [`0x6b50c017463b62dd5db8748ddb7862dc0127f6fda1e2c994f8f5764ef5993071`](https://explorer.testnet.arc.io/tx/0x6b50c017463b62dd5db8748ddb7862dc0127f6fda1e2c994f8f5764ef5993071) | 355,960 | 25 | 0.008899 |
| 19 | respond | dispute | bob session (dispute) | [`0x4756be57a0c8d0420f3c3692e7866248af5107202558d77346cffe02c890f018`](https://explorer.testnet.arc.io/tx/0x4756be57a0c8d0420f3c3692e7866248af5107202558d77346cffe02c890f018) | 200,104 | 25 | 0.0050026 |
| 20 | challenge | dispute | bob session (dispute) | [`0x072ecd1c2adfda9b0d1016f9d8150d09301b98316052ee2e1ce3c179e8d913ac`](https://explorer.testnet.arc.io/tx/0x072ecd1c2adfda9b0d1016f9d8150d09301b98316052ee2e1ce3c179e8d913ac) | 176,512 | 25 | 0.0044128 |
| 21 | timeout | dispute | bob session (dispute) | [`0x2197f8d9f7153f8190f8fdd1684fa20d5dce545d337b9c28de62a55743b801f4`](https://explorer.testnet.arc.io/tx/0x2197f8d9f7153f8190f8fdd1684fa20d5dce545d337b9c28de62a55743b801f4) | 149,089 | 25 | 0.003727225 |
| 22 | session sweep (session key → wallet) | dispute | bob session (dispute) | [`0xccffec93c7e60b6c19b903ecaf32108db891a8b8e4b987d240f176b181feddb9`](https://explorer.testnet.arc.io/tx/0xccffec93c7e60b6c19b903ecaf32108db891a8b8e4b987d240f176b181feddb9) | 21,000 | 25 | 0.000525 |
| 23 | session sweep (session key → wallet) | dispute | alice session (dispute) | [`0x1b9e3643b8fc449a0aa99f4a1c57b058719f9c27c5d07600706d8e923ce7deeb`](https://explorer.testnet.arc.io/tx/0x1b9e3643b8fc449a0aa99f4a1c57b058719f9c27c5d07600706d8e923ce7deeb) | 21,000 | 25 | 0.000525 |
| 24 | approve | — | alice wallet | [`0xba9b9c44557cd466038563bfc7102d24cb90073f3709b924eb46bb5597366cfd`](https://explorer.testnet.arc.io/tx/0xba9b9c44557cd466038563bfc7102d24cb90073f3709b924eb46bb5597366cfd) | 55,438 | 25 | 0.00138595 |
| 25 | session top-up (wallet → session key, 0.336) | xmtp | alice wallet | [`0xf692619dc9c6cfd7fbd3ac880f5f3ed7b798045b0e77d51e5c80d8a382f2989e`](https://explorer.testnet.arc.io/tx/0xf692619dc9c6cfd7fbd3ac880f5f3ed7b798045b0e77d51e5c80d8a382f2989e) | 21,000 | 25 | 0.000525 |
| 26 | deposit | xmtp | alice wallet | [`0xb8ba8335c0340239938dafefb729ce70035e8958f17d13eee3da3bae5eca86aa`](https://explorer.testnet.arc.io/tx/0xb8ba8335c0340239938dafefb729ce70035e8958f17d13eee3da3bae5eca86aa) | 393,809 | 25 | 0.009845225 |
| 27 | approve | — | bob wallet | [`0xdfa54b2e98f9157e2deb927349720682b66fd6b7570ace729082343f28badd45`](https://explorer.testnet.arc.io/tx/0xdfa54b2e98f9157e2deb927349720682b66fd6b7570ace729082343f28badd45) | 55,438 | 25 | 0.00138595 |
| 28 | session top-up (wallet → session key, 0.336) | xmtp | bob wallet | [`0xbc546d08e48074019a89bf67b687b97cf4bc89eda31d4ed7e9b939300af60c1f`](https://explorer.testnet.arc.io/tx/0xbc546d08e48074019a89bf67b687b97cf4bc89eda31d4ed7e9b939300af60c1f) | 21,000 | 25 | 0.000525 |
| 29 | deposit | xmtp | bob wallet | [`0x3c1e7cedf2a67684a8fedcc948474e91cf49bc1ce5222fe960060216a8ff5b39`](https://explorer.testnet.arc.io/tx/0x3c1e7cedf2a67684a8fedcc948474e91cf49bc1ce5222fe960060216a8ff5b39) | 76,393 | 25 | 0.001909825 |
| 30 | closeCooperative | xmtp | bob wallet | [`0x5d7ad0d72978b6860db1590854b5556890c86902d35226436e56a414481acae8`](https://explorer.testnet.arc.io/tx/0x5d7ad0d72978b6860db1590854b5556890c86902d35226436e56a414481acae8) | 142,575 | 25 | 0.003564375 |
| 31 | session sweep (session key → wallet) | xmtp | alice session (xmtp) | [`0x7e30c1253c46293d1f0dc4d5ab485bdfc527d8150f16b79eeda854400c03a1cb`](https://explorer.testnet.arc.io/tx/0x7e30c1253c46293d1f0dc4d5ab485bdfc527d8150f16b79eeda854400c03a1cb) | 21,000 | 25 | 0.000525 |
| 32 | session sweep (session key → wallet) | xmtp | bob session (xmtp) | [`0xa82c2fab5325b36958dabb8cc439a063fa607404fbd5b2be488334138c384606`](https://explorer.testnet.arc.io/tx/0xa82c2fab5325b36958dabb8cc439a063fa607404fbd5b2be488334138c384606) | 21,000 | 25 | 0.000525 |
| 33 | withdraw --all (USDC transfer to the owner) | — | alice wallet | [`0x209f8e05491ada7e0f3c74bba07e790dde0602d0e6bac34d854b4a947a3e3f6d`](https://explorer.testnet.arc.io/tx/0x209f8e05491ada7e0f3c74bba07e790dde0602d0e6bac34d854b4a947a3e3f6d) | 48,950 | 25 | 0.00122375 |
| 34 | withdraw --all (USDC transfer to the owner) | — | bob wallet | [`0xe3880839021f425099cce12d012ee7eee537a0462707cbc939a3931a47fec068`](https://explorer.testnet.arc.io/tx/0xe3880839021f425099cce12d012ee7eee537a0462707cbc939a3931a47fec068) | 48,950 | 25 | 0.00122375 |

**Gas prices.**
- Every daemon transaction paid an effective **25 gwei**: the 20 gwei base fee plus the 5 gwei tip that
  `eth_maxPriorityFeePerGas` suggests. Bob's first `approve` paid 30 gwei.
- The deployer's two transfers paid 21 gwei, with an explicit 1 gwei tip.

**Who sent what.**
- `approve` (an exact amount, once per deposit) and `deposit` were sent by the wallets.
- `closeCooperative` was sent by Bob's wallet both times.
- `challenge`, `respond` and `timeout` were sent by the channel session keys.
- The session top-ups went from wallet to session key, and the sweeps from session key back to wallet.

## 4. Cost per action

Measured on Arc testnet, at the prices above. A USDC cost scales linearly with the gas price; at the 20 gwei floor,
every daemon row is 20 % cheaper.

| Action | Count | Gas used | Cost per action (USDC) | Total (USDC) |
|---|---|---|---|---|
| deploy `ChessRules` (§1) | 1 | 1,903,343 | 0.039970203 (21 gwei) | 0.039970203 |
| deploy `ChannelHub` (§1) | 1 | 3,012,611 | 0.063264831 (21 gwei) | 0.063264831 |
| deposit | 6 | 76,393–393,833 | 0.001909825–0.009845825 | 0.03526755 |
| closeCooperative | 2 | 142,568–142,575 | 0.0035642–0.003564375 | 0.007128575 |
| challenge | 2 | 176,512–355,960 | 0.0044128–0.008899 | 0.0133118 |
| respond | 1 | 200,104 | 0.0050026 | 0.0050026 |
| timeout | 1 | 149,089 | 0.003727225 | 0.003727225 |
| session sweep (session key → wallet) | 6 | 21,000 | 0.000525 | 0.00315 |
| session top-up (wallet → session key, 0.336) | 6 | 21,000 | 0.000525 | 0.00315 |
| withdraw --all (USDC transfer to the owner) | 2 | 48,950 | 0.00122375 | 0.0024475 |
| approve | 6 | 55,438 | 0.00138595–0.00166314 | 0.00859289 |
| fund agent (deployer → wallet, 2 USDC) | 2 | 21,000 | 0.000441 | 0.000882 |
| **rehearsal total (34 txs)** | 34 | | | **0.08266014** |

Notes on the gas numbers:

- **`deposit`.** The first deposit into a channel uses about 394k gas: it creates the channel (`ChannelCreated`, the
  params in storage). The second uses about 76k.
- **`challenge`.** Alice's challenge registered a state for the first time: 356k gas. Bob's re-challenge of the same
  registered state: 177k. Both are far under the 2.1M `RESPOND_GAS_BUDGET` that `sessionGasWei` is sized on. That
  budget is the worst case, a long game.
- **Session gas.** Each channel's 0.336 USDC of session gas was about 25× what the busiest key spent. Bob's dispute
  key sent respond, challenge, timeout and its sweep, for 0.0137 USDC. No refill was needed.
- **Session top-ups.** They estimate gas (+20 % + 5,000) and used exactly 21,000, matching `arc-facts.md`.

## 5. Balances: hub side, wallet side, the whole run

All amounts were read from the chain by the script's collection step. Hub-side amounts are in 6-decimal base units.
Wallet-side amounts are native wei, 18 decimals, the exact balance (ERC-20 `balanceOf` truncates).

### Hub-side checks (6-decimal base units)

| Channel | Check | Expected | Got | OK |
|---|---|---|---|---|
| normal | deposits | 2 x 1005000 | 2 x 1005000 | yes |
| normal | Finalized.balanceA (participant 0) | 1200000 | 1200000 | yes |
| normal | Finalized.balanceB (participant 1) | 800000 | 800000 | yes |
| normal | Finalized.fee | 10000 | 10000 | yes |
| normal | USDC transfer hub -> participant 0 | 1200000 | 1200000 | yes |
| normal | USDC transfer hub -> participant 1 | 800000 | 800000 | yes |
| normal | USDC transfer hub -> fee recipient (deployer) | 10000 | 10000 | yes |
| normal | PayoutDeferred events | 0 | 0 | yes |
| dispute | deposits | 2 x 1005000 | 2 x 1005000 | yes |
| dispute | Finalized.balanceA (participant 0) | 900000 | 900000 | yes |
| dispute | Finalized.balanceB (participant 1) | 1100000 | 1100000 | yes |
| dispute | Finalized.fee | 10000 | 10000 | yes |
| dispute | USDC transfer hub -> participant 0 | 900000 | 900000 | yes |
| dispute | USDC transfer hub -> participant 1 | 1100000 | 1100000 | yes |
| dispute | USDC transfer hub -> fee recipient (deployer) | 10000 | 10000 | yes |
| dispute | PayoutDeferred events | 0 | 0 | yes |
| xmtp | deposits | 2 x 1005000 | 2 x 1005000 | yes |
| xmtp | Finalized.balanceA (participant 0) | 1100000 | 1100000 | yes |
| xmtp | Finalized.balanceB (participant 1) | 900000 | 900000 | yes |
| xmtp | Finalized.fee | 10000 | 10000 | yes |
| xmtp | USDC transfer hub -> participant 0 | 1100000 | 1100000 | yes |
| xmtp | USDC transfer hub -> participant 1 | 900000 | 900000 | yes |
| xmtp | USDC transfer hub -> fee recipient (deployer) | 10000 | 10000 | yes |
| xmtp | PayoutDeferred events | 0 | 0 | yes |

### Wallet-side reconciliation (wei, 18 decimals)

| Home | Funded | Payouts in | Deposits out | Withdrawn | Gas paid | Expected held | Held | OK |
|---|---|---|---|---|---|---|---|---|
| alice | 2000000000000000000 | 3200000000000000000 | 3015000000000000000 | 2118456000000000000 | 46967475000000000 | 19576525000000000 | 19576525000000000 | yes |
| bob | 2000000000000000000 | 2800000000000000000 | 3015000000000000000 | 1730612000000000000 | 34810665000000000 | 19577335000000000 | 19577335000000000 | yes |

System: deployer before 19.896764966 = deployer after 19.774950966 + held by agents 0.03915386 + gas 0.08266014 → exact.

### Balances after (native, 18 decimals)

| Address | Balance (USDC) |
|---|---|
| deployer | 19.774950966 |
| alice wallet | 0.018776425 |
| alice session (xmtp) | 0.0002667 |
| alice session (normal) | 0.0002667 |
| alice session (dispute) | 0.0002667 |
| bob wallet | 0.018777235 |
| bob session (xmtp) | 0.0002667 |
| bob session (normal) | 0.0002667 |
| bob session (dispute) | 0.0002667 |

### Sender nonce check (Blockscout listing vs nonce)

| Sender | Listed | Nonce delta |
|---|---|---|
| deployer | 2 | 2 |
| alice wallet | 10 | 10 |
| alice session (xmtp) | 1 | 1 |
| alice session (normal) | 1 | 1 |
| alice session (dispute) | 2 | 2 |
| bob wallet | 12 | 12 |
| bob session (xmtp) | 1 | 1 |
| bob session (normal) | 1 | 1 |
| bob session (dispute) | 4 | 4 |

Reading the reconciliation:

- Alice won 0.2 net (+0.2, −0.1, +0.1) and Bob lost 0.2.
- The six player fees, 0.03 USDC, went back to the deployer as the fee recipient.
- What the agents still hold is §9's.

| Deployer | Native balance | USDC |
|---|---|---|
| Before (block 68,880,334) | `19896764966000000000` wei | 19.896764966 |
| After (block 68,883,090) | `19774950966000000000` wei | 19.774950966 |
| Change | `−121814000000000` wei | −0.121814 = gas 0.08266014 + held by the agents 0.03915386 |

## 6. Timings

Wall clock, from the script's measurements and the blocks' timestamps. Blocks were about 0.5 s apart: 2,621 blocks in
22 minutes.

| Step | Time |
|---|---|
| `arena init` | 0.8 s. Bob's first try was refused with HTTP 429 by the RPC (8.3); the retry 20 s later passed. |
| `arena xmtp enable` (476 MB, warm npm cache) | 2.6–2.9 s per home |
| Deployer funding transfer, send → receipt | 4.3 s each |
| Offer → Open on both daemons (approve + top-up + deposit, ×2) | 47.0 s (normal, rate-limited), 16.7 s (dispute), 21.6 s (xmtp) |
| One move over the relay, `/move` → the other daemon holds it | 135–1,301 ms (one 5.5 s outlier, under rate limiting) |
| NEW_GAME handshake | 1.0–4.9 s |
| Cooperative close, request → `Finalized` (relay) | 2.7 s |
| Finalized → both session keys swept | 100 s (normal), 96 s (dispute), 4.0 s (xmtp). The first two include the sweep's 30 s back-offs after rate-limited reads. |
| Alice's `POST /challenge`, sent and mined | 1.1 s; Bob sees `mustMove` 0.2 s later |
| Bob's answering move → `respond` mined | 53 s. The move itself was applied at once; the respond waited on rate-limited reads (8.2). |
| Bob's `POST /challenge` | 1.6 s |
| Challenge deadline → `timeout` mined | Deadline 15:37:07 UTC; `timeout` mined 15:38:02, 55 s after the deadline. |
| `withdraw --all` | 1.4 s and 2.7 s |
| Whole rehearsal, preflight → collected | 23.4 min (15:18:58–15:42:21), including the three restarts in §2 |

## 7. XMTP `dev`: the host killed mid-game

This is the first run of the fallback against XMTP's public `dev` network, not the local node in Docker.

- **Registration.** Both session keys were registered on XMTP `dev`, one installation each, 0.9 s after the channel
  was Open.
- **Switch.** The host server was SIGKILLed after move 3. Both daemons reported `transport: "xmtp"` 4.4 s later. The
  script polls every 2 s, and the grace window is 3 s.
- **Moves.** The four remaining moves took 686, 144, 175 and 129 ms each over XMTP `dev`. Bob's auto-resign followed
  over XMTP too.
- **Close.** Both Close signatures went over XMTP, and Bob's daemon sent `closeCooperative`
  (`0x5d7ad0d7…acae8`). Both daemons showed `transport: "xmtp"` at that point.
- **Settlement.** Payouts were exactly 1.1 / 0.9 / 0.01. No `challenge`, `respond` or `timeout` was sent for this
  channel: the outage never reached the chain.
- **One slow step.** From the close request to `Finalized` took **48.9 s** over XMTP, against 2.7 s over the relay. The
  `closeCooperative` itself was mined in one block. Where the rest of the time went was not isolated. It could be the
  delivery of the Close message over XMTP `dev`, or the 3 s back-offs of the script's own rate-limited `/status`
  polls.

XMTP `dev` does not enforce fees, so no gateway was configured or needed.

## 8. Surprises and findings

### 8.1 Arc's RPC refuses an `eth_getLogs` with more than 10 topics (fixed)

`eth_getLogs` with a topic-0 OR list of 11 or more entries is refused with `-32012 "requested range too large"`,
even for a single block. With 10 or fewer it is served.

| Probe | Result |
|---|---|
| Testnet, one block, 10 topics | served |
| Testnet, one block, 11 topics | refused |
| Testnet, 10,000 blocks, no topic filter | served |
| Mainnet, one block, 10 topics (read only) | served |
| Mainnet, one block, 11 topics (read only) | refused |

**The bug.** `HubClient.hubEvents()` read every hub event with one `getContractEvents` over the whole ABI: 15 event
topics. So the host's indexer was refused on every range, starting with the deploy block.

**How it played out.** H1's split-on-refusal logic then took over, as built:
- each refused range was halved, down to single blocks;
- a block still refused had its dispute events skipped after `INDEXER_UNREADABLE_POLLS` polls.

The indexer would have crept forward at about one block per few polls, and flooded the RPC with probes (8.2). It would
never have reached a live channel, and the relay serves only channels the host has indexed. **On Arc, the host could
not have relayed a single game.**

**Fix (`packages/sdk/src/hub.ts`).** The full read now asks only for the 7 events that carry a `channelId`
(`HUB_EVENT_KINDS` / `HUB_EVENT_ABI`), which are the only events `hubEvents` ever decoded. Nothing else changes: the
same events, decoded the same way, in one query.
- New test: `packages/sdk/test/hub.test.ts`, against a transport that refuses more than 10 topics as Arc's does.
- The existing anvil `lifecycle.test.ts` scan still passes.
- With the fix, the indexer caught up from the deploy block and indexed all three channels; its cursor was at
  68,882,951 when the host was killed.

### 8.2 The public testnet RPC rate-limits, and that reaches the daemons

The RPC answers `-32005 "rate limit exceeded"` (viem reports it as "Request exceeds defined limit."), or an HTTP 429.
Five seconds of `eth_blockNumber` at 20 per second was not limited. The mix of `eth_call`, `eth_getLogs` and
`eth_getBalance` from two daemons, the indexer and the script's `/status` polls was limited often.

Every `/status` refreshes the chain. The script first polled at 0.5 s, and it polled at 2 s after the second restart.

Over the run, the logs counted:

| Where | Count |
|---|---|
| Server log, `indexer: Request exceeds defined limit.` | 264 |
| Alice's and Bob's daemon logs, rate-limited reads | 112 and 106 lines |
| … of which "session gas check failed (retried on the next pass)" | 208 |
| Script's `GET /status`, retried | 46 |
| Script's `POST /move`, answered 500 | 2 |

Nothing was lost; every retry path held. But the rate limit:

- **Answered actions that had taken effect with an error.** `POST /move` returned 500 after the move was signed and
  relayed: the daemon makes the move, then refreshes the chain for the status it returns, and only that read failed.
  An agent that trusts the 500 may think its move failed. (The rehearsal script checks the turn instead.) The other
  action routes that return `status()` behave the same way: `/close`, `/challenge`, `/next-game`, `/accept-draw`,
  `/resign`.
- **Delayed disputes.**
  - Bob's `respond` was mined 53 s after his move. His daemon logged "challenge check after sending turn 2 failed (the
    watchtower retries): Request exceeds defined limit." and answered on a later pass.
  - Bob's watchtower sent the `timeout` 55 s after the deadline. Rate-limited reads were logged in those minutes, but
    this delay was not isolated: polling every 3 s alone would explain only a few seconds of it.
  - The session-gas check, which is what triggers a refill, failed 208 times and was retried on the next pass each
    time. No refill was needed in this run. One that was needed would have waited.

  With a 300 s window there was room. Under real load on a shared public RPC, that latency is taken out of the
  challenge window.
- **Lost a sweep's attribution** (8.4).

### 8.3 `arena init` does not retry on 429

Bob's first `init` failed with "RPC https://rpc.testnet.arc.io answered eth_getCode with status 429". `init` makes a
handful of RPC calls: `eth_chainId` and three `eth_getCode`. Its `rpcCall` has no retry, so one 429 fails the command.
The script retried it 20 s later. An agent following `skill.md` would see a failure and have to retry by itself.

### 8.4 A sweep that landed was recorded as `"dust"`

Alice's dispute session key `0x7721BC884912E605511CF72Fd5Bd5CC6Ca477Fec` swept 0.3263093 USDC back to her wallet in
`0x1b9e3643b8fc449a0aa99f4a1c57b058719f9c27c5d07600706d8e923ce7deeb`. Her record says `swept: "dust"`, with no
`sweeps` entry and no `sweepTx`.

**Cause.** The sweep's receipt wait failed on a rate-limited read ("sweep failed (retried with back-off)"). That is a
plain RPC error, not `TxReceiptMissingError`/`TxDroppedError`/`TxStuckError`, so the hash was not kept in
`pendingTx`. The next attempt read a balance of 0.0002667, which is dust, and recorded `"dust"`.

**Impact.** The funds are safe (they are in the wallet, and the reconciliation includes them). Only the record's
accounting and the board's sweep history are wrong. This is a new path into the parked "Other" item in
`mainnet-gates.md` (a late re-probe that returns "unknown" records `"dust"`). It is not fixed here.

### 8.5 Smaller things

- **Sweep leftover.** A sweep leaves **0.0002667 USDC** in every session key. It reserves `21,000 × ~37.7 gwei` for its
  own fee and pays 25 gwei; the difference stays on the key. That is 6 keys × 0.0002667 = 0.0016 USDC over this run
  (§9).
- **Tips.** The daemons tip 5 gwei, `eth_maxPriorityFeePerGas`, on top of the 20 gwei base fee: 25 % over the floor.
  The deployer's 1 gwei tip landed in the next block just the same. Not a problem; worth a look for cost.
- **Explorer.** Blockscout's address listing matched every sender's nonce exactly (9 of 9). It works as an audit
  source for a run like this one.
- **XMTP's native SDK** logs `WARN CORE sqlcipherCodecAttach: no codec attached to db` once per channel client.
  Harmless; noted so nobody chases it.

## 9. Funds not returned

All three channels are `Finalized`, `committedEscrow` is 0, and `owed` is 0 everywhere. What did not come back to the
deployer, 0.03915386 USDC in all, is what the product keeps by design:

| Address | USDC | Why |
|---|---|---|
| alice wallet `0x3279…aE7E` | 0.018776425 | `withdraw --all` keeps `withdrawReserve()` = 500,000 × 40 gwei = 0.02 USDC for the wallet's own gas; the withdraw's own gas came out of it |
| bob wallet `0x639F…5Eb5` | 0.018777235 | the same |
| 6 session keys | 0.0002667 each, 0.0016002 total | the sweep's unused fee reserve (8.5) |

None of it is at risk. The two wallet reserves could only be withdrawn by signing a transfer with the agent keys
outside the CLI. That was deliberately not done: the product's custody model is that only the daemon sends from the
wallet, and only to the owner.
