# Mainnet gates (Arc, real USDC)

Status after Plan 4.5, 2026-09-29. Nothing here has been deployed to mainnet. Every item below must be true before any real-USDC deploy. The owner chose a guarded launch without an external audit (spec §13). §11's audit and legal gates are accepted risks, not preconditions.

## Open product items (Plans 5–6)
- **Session-gas sweep** (spec §3.1).
  - The derived default `sessionGasWei` is about 0.84 USDC per channel at the 100 gwei ceiling. Without a sweep, that amount stays stranded on each settled channel's session key.
  - Implement the sweep, or an `arena sweep` command. Pin Arc's fee ceiling, and re-derive `sessionGasWei` with k = 2..4.
- **Refill retries.** Back off empty-wallet refill retries per channel (`refillBlockedUntil`), and log once per episode.
- **`session-gas-low`.** Raise it only on insufficient funds, the fee cap, or a failed estimate.
- **Offer timeout default.** The `arena offer` / `POST /offers` default timeout should follow `minChallengeTimeout`.
- **Evicted channels.** `wait --channel` on an evicted settled channel returns `settled`, not 409.
- **WS limits.** Add a per-IP aggregate frame budget, and set the limits from measured load.
- **`dev-up --dir`.** Refuse a non-empty directory that has no dev-up marker.
- **Memory.** Run a 60-minute soak with heap snapshots and confirm the daemon's RSS stays flat.

## Mainnet-readiness checklist (must be true before any real-USDC deploy)

1. **Arc chain facts verified and written down.**
   - The block gas limit comfortably exceeds 2.1M; `challenge` at 2.02M has headroom.
   - The fee scale is known: base fee range, priority fee, and whether EIP-1559 is supported.
   - The RPC supports the `pending` tag for `getTransactionCount` and `estimateGas`.
   - Finality is instant (so m2 does not arise).
   - The USDC ERC-20 address has 6 decimals, returns true on `transfer`, has no fee-on-transfer, and a blocklisted recipient reverts or returns false (so `owed` works).
2. **Dispute gas fixed (C1).**
   - `sessionGasWei` is derived from item 1.
   - There is a re-top-up while Open/Challenged, and a low-gas attention.
   - The new system test passes.
   - The wallet's `--fee-ceiling-wei` default is set for Arc.
3. **Daemon safety policy.**
   - A `minChallengeTimeout` floor (I4).
   - Bounded USDC approval (I2).
   - Pinned canonical mainnet addresses in the CLI.
   - Offer signature verified on accept (m6).
   - A supervisor or auto-restart is documented, and memory stays flat over 60 min (I3).
4. **Deployment and ownership.**
   - `ARENA_TOKEN` is set explicitly to Arc USDC (the script reverts on non-local chains without it; confirm the value).
   - `ARENA_OWNER` is a multisig. `ARENA_FEE_RECIPIENT` is set.
   - The fee and max fee, and the launch limits (10 USDC / 1,000 USDC suggested), are signed off.
   - Source is verified on the explorer, and `deployments/<chainId>.json` is committed.
   - Ownership acceptance (`Ownable2Step`) is completed and tested.
5. **Host production config.**
   - WS and HTTP limits come from load data (m8).
   - `fundingWindow` ≤ 7200.
   - `trustProxy` is set correctly behind the proxy.
   - A fresh `dbPath` records the identity on first start.
   - `audit` is truthful (m21). `publicRpcUrl` is an RPC you run or trust.
6. **Monitoring and alerting.**
   - `committedEscrow` against the cap and against game activity (m13 squatting).
   - Every `Challenged`, `PayoutDeferred`/`owed`, `Paused`/`LimitsUpdated` event, and ownership events.
   - Indexer lag and the cursor-ahead-of-head warning.
   - Server RSS and DB size (m7).
7. **Runbook.**
   - The multisig pause procedure and who can sign within minutes.
   - The cap-raise policy.
   - Incident response for a suspected hub defect: pause, let channels settle, redeploy.
   - Key custody. Never renounce ownership (m15).
8. **Docs.**
   - The spec's Plan 4.5 refinement block and the `TxSender` contract (I1).
   - skill.md's Arc gas wording (m11) and the settle/`wait` guidance (m4).
   - The admin-surface caveats (m13, m14).
9. **A final test gate on the release commit.**
   - `test:contracts`, plus the deep profile, mutants 18/18, Slither 0 High/Medium, and Echidna.
   - `test:sdk`, `test:cli` and `test:server`, each run on its own.
   - `test:system` twice.
   - A 60-minute soak.
   - One fully budgeted LLM run against the release build.

