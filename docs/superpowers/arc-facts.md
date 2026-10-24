# Arc chain facts (verified 2026-10-19)

Arc **public mainnet has been live since 2026-09-16**. This was verified on-chain on 2026-10-19: chain ID `0x13b2`, client `arc/v1`, latest block ≈ 26.78M with a current timestamp. This file covers `mainnet-gates.md` checklist item 1. Re-verify before deploying.

## Network

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | 5042 | 5042002 |
| RPC | `https://rpc.mainnet.arc.io` (also Alchemy, Blockdaemon, dRPC, QuickNode) | `https://rpc.testnet.arc.io` |
| Explorer | `https://explorer.arc.io` | `https://explorer.testnet.arc.io` |
| Faucet | none | `https://faucet.circle.com` |
| Circle CLI chain id | `ARC` | `ARC-TESTNET` |

The validator set is permissioned at launch. The network itself is public.

## USDC is the gas token, and it is one balance

- The **ERC-20 USDC** contract is `0x3600000000000000000000000000000000000000` on both networks, with **6 decimals**.
- **Native gas is the same USDC balance**, with **18 decimals**. "Both interfaces share one balance." The ERC-20 `balanceOf` truncates sub-micro-USDC amounts.
- Native value transfers emit an ERC-20 `Transfer` log (EIP-7708), emitted from `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE`, in 18 decimals.
- A transfer to or from a **blocklisted** address **reverts**; it never returns false. Arc's docs also say such an included transaction "consuming gas produce[s] no receipt". Waits must be bounded.

## Fees, blocks and finality

- **EIP-1559.** The base fee has a **20 gwei floor**, and was observed flat at 20 gwei. The priority fee varies: about 1.15M wei on 2026-10-19, but `eth_maxPriorityFeePerGas` was 5 gwei and `eth_gasPrice` 25 gwei on 2026-10-23 (block 27,584,886, read-only calls; audit-journey I-4). The base fee is paid to the proposer, not burned.
- The mempool **silently drops** any transaction with `maxFeePerGas` below 20 gwei. There is no error, and the transaction never appears.
- The **block gas limit is 30M**. Our `challenge`, at 2.02M gas, fits; it costs about 0.04 USDC at 20 gwei.
- A plain value transfer costs **21,000 gas**, the same as Ethereum, even though Arc also emits an EIP-7708 log. *Correction, 2026-10-24:* this file first said 21,225. That came from an estimate whose recipient was `0x…02`, the SHA-256 precompile. Twelve real transfers on mainnet and testnet show 21,000 gas limit and 21,000 gas used, and `eth_estimateGas` returns 21,000.
- Finality is deterministic and instant on inclusion.
- Blocks are sub-second. `block.timestamp` is non-decreasing at 1 s granularity, so several blocks can share a timestamp.
- `eth_getTransactionCount(…, "pending")` and `eth_estimateGas(…, "pending")` both work.

## RPC limits (added 2026-10-24, Plan 6 Task 5 rehearsal)

- **`eth_getLogs` refuses a topic-0 OR list of more than 10 entries**, even for one block: `-32012 "requested range
  too large"`. Probed on testnet, and with two read-only calls (10 topics, then 11) on `rpc.mainnet.arc.io`: 10 is
  served, 11 is refused. A 10,000-block range with no topic filter is served on testnet.
- **A `getLogs` whose `toBlock` is past the head answers `-32014 "requested data not available"`.** Seen in the T5
  review, on testnet. A load-balanced head can run ahead of the log index, so this is transient. The SDK treats it
  that way: `isRangeRefusal` is false for it, so it is retried and not counted as a refusal.
- **The public testnet RPC rate-limits**: `-32005 "rate limit exceeded"` in the body, or an HTTP 429. Five seconds of
  `eth_blockNumber` at 20 per second passed. Two daemons, a host indexer and status polling hit the limit
  constantly. Details are in `arc-testnet-rehearsal.md` §8.
- Measured gas on Arc testnet:

  | Call | Gas |
  |---|---|
  | `challenge` | 177k–356k |
  | `respond` | 200k |
  | `timeout` | 149k |
  | `closeCooperative` | 143k |
  | `deposit` | 394k (first) / 76k (second) |

  The 2.02M figure above is the worst-case budget.

## Other differences

- `PREVRANDAO` = 0. We use no on-chain randomness.
- Blob transactions are not supported.
- SELFDESTRUCT follows EIP-6780, plus Arc's native-value rules.
- Most contracts deploy unchanged; Arc targets the Osaka baseline.
- For Arc-accurate local tests, use Arc Foundry (`arc-anvil --network arc`, `arc-forge`, `arc-cast`). Standard `anvil` does not model native USDC.

## Other Circle contracts on mainnet

| Contract | Address |
|---|---|
| CCTP TokenMessengerV2 | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` |
| CCTP MessageTransmitterV2 | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |
| GatewayWallet | `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |

## Consequences for Plan 6, found by this check

1. **`fund` and `withdraw --all`.** USDC and gas are one balance on Arc. `fund` must add the gas reserve into the USDC need instead of asking for "native gas" separately. `withdrawReserve()` must keep enough USDC for each live channel's session-gas refills, or `withdraw --all` can strand a channel's dispute gas.
2. **Session-key top-ups** hard-coded `gas: 21_000` before Plan 6 Task 2 (correct on Arc; see above). They now use `estimateGas` + 20 % + 5,000 and check the receipt status.
3. **Fee floor.** Clamp every `maxFeePerGas` to at least 20 gwei on Arc. A lower `--fee-ceiling-wei` would make transactions vanish silently.
4. **Receipts.** A blocklist revert may produce no receipt. The bounded waits already exist; confirm the hub's payout path treats a reverting USDC `transfer` as `owed`.
5. **Session gas sizing.** The default formula is 4 × 2.1M × max(fee ceiling, 4 × eth_gasPrice). On Arc, `eth_gasPrice` is 20–25 gwei, so the second term is at least 80 gwei, giving at least 0.672 USDC per channel, and 0.84 USDC at 25 gwei. The ruling for Plan 6 is that on profile chains `sessionGasWei` = 4 × 2.1M × the profile ceiling (40 gwei), which is 0.336 USDC; refills cover fee spikes.
6. **Tests.** Run the contract and daemon suites against `arc-anvil --network arc` as well as standard anvil.
7. **Circle agent wallets on mainnet.** The CLI reference uses `--chain ARC`, and third-party reports show mainnet runs through Circle ARC wallets. Circle's Agent Stack marketing page still says "Arc testnet (mainnet coming soon)". Confirm with `circle blockchain list` once logged in.

## Funding an agent on Arc (added 2026-10-24, audit-journey C-1 and C-2)

- There is no faucet on mainnet. The agent's address is a plain EVM address, valid on every EVM chain, so USDC sent to it on Ethereum, Base or any other network does not arrive on Arc.
- A human brings USDC onto Arc with Circle's CCTP V2 (TokenMessengerV2 above) from another chain, or from an exchange or wallet that supports Arc. On testnet, Circle's faucet.
- The owner (cash-out) address must likewise be one the human controls on Arc. `fund`'s message, `owner set` and `/skill.md` say so (hardening wave H2).

Sources:
- `https://docs.arc.io/arc/references/connect-to-arc`
- `https://docs.arc.io/arc/references/evm-differences.md`
- `https://docs.arc.io/arc/references/contract-addresses.md`
- `https://developers.circle.com/agent-stack/circle-cli/command-reference`
- `https://technode.global/2026/09/18/circle-launches-arc-mainnet-institutional-ecosystem-builders/`
