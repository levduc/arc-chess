# Mainnet gates (Arc, real USDC)

Status after Plan 4.5, 2026-09-29. Nothing here has been deployed to mainnet. Every item below must be true before any real-USDC deploy. The owner chose a guarded launch without an external audit (spec §13). §11's audit and legal gates are accepted risks, not preconditions.

## Open product items (Plans 5–6)
- **Session-gas sweep** (spec §3.1) — **done in Plan 5** (spec §12 item 35). The main pass sweeps a
  Finalized/Reclaimed channel's session key back to the wallet, with per-record back-off and an `"abandoned"`
  outcome after `SWEEP_ABANDON_ATTEMPTS`; `arena sweep` / `POST /sweep` sweep settled-but-unswept records too,
  including legacy ones from before this feature. Still open: pin Arc's real fee ceiling and re-derive
  `sessionGasWei` with k = 2..4 once Arc's fee data is known (Plan 6).
- **Refill retries** — **done in Plan 5** (spec §12 item 36). Empty-wallet refill retries back off per channel
  (`refillBlockedUntil`: 30 s doubling to 5 min), with one log line per episode.
- **`session-gas-low`** — **done in Plan 5** (spec §12 item 37). Raised only on insufficient funds, the fee cap, or
  a failed estimate.
- **Offer timeout default** — **done in Plan 5** (spec §12 item 38). The daemon's own `arena offer` / `POST
  /offers` default timeout now follows `minChallengeTimeoutOf(config)`.
- **Evicted channels** — **done in Plan 5** (spec §12 item 39). `wait --channel` on an evicted settled channel
  returns `settled`, not 409.
- **WS limits.** Add a per-IP aggregate frame budget, and set the limits from measured load.
- **`dev-up --dir`** — **done in Plan 5** (spec §12 item 40). Refuses a non-empty directory that has no
  `.arena-dev-marker` file.
- **Memory.** Run a 60-minute soak with heap snapshots and confirm the daemon's RSS stays flat.

### New items surfaced by Plan 5's reviews
- **`wait()`'s pre-wait controller-change semantics.** `wait()` records, per channel, only the controller it first
  observes in that call; a change that happened before the call started is documented (spec §12 item 44) as
  visible solely through the channel's ordinary `attention`, never through `control-changed`. Every caller must
  re-read `status.controller` after each `wait` rather than trust the reason string. Before mainnet, consider
  giving `wait` a `since`/cursor argument so a caller can detect a change that happened entirely between two of its
  own calls, instead of relying on this read-after-wait discipline.
- **The global SSE `notify` rate.** `ArenaDaemon.notify()` fires at the end of every dispute pass and every main
  pass -- as often as `pollMs`, on every tick, whether or not anything actually changed -- and each connected
  `GET /events` client debounces its own output to at most one `change` per second. The per-client debounce is not
  a bound on how often `notify()` itself runs, or on the total work it causes across many connected clients on a
  busy daemon with many channels. Measure this under load before mainnet and bound `notify()` itself if it matters.
- **A late re-sweep is not added to the sweep history automatically.** If a session key already marked
  `swept: true` (or `"dust"`) receives money again -- a top-up that lands late, a manual transfer -- the periodic
  main pass skips it (it only ever attempts a record with `swept` unset or `"abandoned"`). Recovering that balance
  needs an explicit `arena sweep --channel <id>` (which does re-check the balance and, if it finds a real amount,
  appends it to `sweeps`). Confirm before mainnet whether this manual step is acceptable, or whether the periodic
  pass should also recheck already-swept channels on some schedule.

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

