# Mainnet gates (Arc, real USDC)

Status after Plan 4.5, 2026-09-29. Nothing here has been deployed to mainnet. Every item below must be true before any real-USDC deploy. The owner chose a guarded launch without an external audit (spec §13). §11's audit and legal gates are accepted risks, not preconditions.

## Open product items (Plans 5–6)
- **Session-gas sweep** (spec §3.1) — **done in Plan 5** (spec §12 item 35). The main pass sweeps a
  Finalized/Reclaimed channel's session key back to the wallet, with per-record back-off and an `"abandoned"`
  outcome after `SWEEP_ABANDON_ATTEMPTS`; `arena sweep` / `POST /sweep` sweep settled-but-unswept records too,
  including legacy ones from before this feature. Arc's fee ceiling and `sessionGasWei` — **done in Plan 6**
  (Task 2, `dc0d0ed`; spec §12 items 60–61): a 40 gwei profile ceiling, and on profile chains `sessionGasWei` =
  4 × 2.1M × 40 gwei = 0.336 USDC (k stays 4; refills cover a fee spike).
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
- **Dev faucet and house bots** — **done in Plan 5.5** (spec §12 item 48): both are dev tooling, gated to a
  local Anvil chain (the faucet's three-way guard; `arena bot` refuses any chain but 31337 without
  `--allow-real-chain`). Before any real-USDC deploy: **faucet must be disabled; house bots not run on
  mainnet**.
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

### Plan 5 final review (2026-09-29)
- **A challenge on a human-held seat** — **done in the final fix wave** (spec §12 item 45). The agent's `wait`
  returns `human-must-move`, and the daemon hands the seat back to the agent once `max(60 s, challengeTimeout / 3)`
  is left (`autoReturnOnChallenge`, default on). With it turned off, a human who walks away can still forfeit.
- **Bounded automatic sweep** — **done in the final fix wave** (spec §12 item 46): a 20 s receipt bound per record,
  3 queued records per main pass, backed-off re-probes of a pending sweep then a same-nonce replacement, RPC read
  failures not counted toward abandoning, and pending hashes persisted across a restart. Residual: the main pass's
  loop over *live* settled channels is bounded per record (20 s) but not in count, so N channels settling at once
  with stuck sweeps can hold the main pass for up to N × 20 s (the dispute pass is unaffected). Measure under a
  fee spike before mainnet.
- **The token in browser history** — **done in the final fix wave** (spec §12 item 42): links carry a single-use,
  120 s code. Residual: an unused link is a full credential for its 120 s; a signed-in tab holds the token in
  memory until it closes; there is no `arena token rotate` command (the README documents manual rotation). Only
  Chrome's local History DB was verified; Chrome Sync, Firefox and Safari were not tested.
- **Still open from that review (Minors, not fixed in Plan 5):** `GET /channels` returns up to 1,000 settled
  statuses and the board renders them all (M8, pre-mainnet: add `?live=1` or paging); a contract-wallet sweep uses
  the exact `estimateGas(value: 1n)` as its gas limit (M10, pre-mainnet if Plan 6's Circle wallet is a
  smart-contract account); refill back-off also throttles a Challenged channel's refill, up to 5 min (M9); `stop()`
  does not wait for a manual `sweep()` or a busy queue entry (M17); a move-path respond is skipped while the dispute
  pass holds the channel, landing one `pollMs` later (M18).
- **From the final fix wave's re-review (Minors, 2026-09-30):**
  - **Pre-mainnet:**
    - Give the main pass one shared sweep budget per pass, covering both the live settled-channel loop and `sweepQueuePass`, so N stuck sweeps can't hold it for N × 20 s.
    - Bound the dispute pass's refill wait (`topUpSession` has no `giveUpAt`). A roughly 2-minute refill can otherwise delay the auto-return check past its window when `minChallengeTimeout` is at or below about 300 s.
  - **Other:**
    - When the late re-probe of a pending sweep returns "unknown" (an RPC blip), it records `swept: "dust"` and drops the pending hashes, so attribution is lost. The funds are safe. It should instead skip the pass and keep the hashes.
    - After the auto-return time has passed, the board still offers Take over and shows a deadline that is already past. Disable the button and show "the seat stays with your agent" instead.

### Plan 5.5 final review
- init: require `--force` to switch an existing home's chain/server/hub, and record the chain's genesis hash so
  records from a previous chain are never acted on (ghost channels after a dev-up restart).

### Plan 5.6
- Arc: a lying RPC can inflate priority fees up to 4x its own estimate (tx.ts room()); pin a trusted RPC. (`feeCeilingWei` for Arc: done in Plan 6, 40 gwei by default, with the 20 gwei floor applied last; spec §12 items 60, 62.)
- **Before the first real publish** (owner's own steps, not automated — spec §6):
  - choose the npm package name/scope and set `ARENA_CLI_PACKAGE`;
  - choose a license, add a `LICENSE` file, and set `ARENA_CLI_LICENSE`; make `scripts/build-cli.ts` copy that
    `LICENSE` into `dist/` and its `files` (it ships only `THIRD_PARTY_LICENSES` today);
  - push the repo to GitHub and set `ARENA_CLI_REPOSITORY`; check npm's current provenance rules for the repo's
    visibility (public vs. private) at that time — provenance attestation needs a public source, or an npm plan
    that supports it for a private one;
  - add the `NPM_TOKEN` secret the `release-cli` workflow publishes with.
- **Host `cli` config set to a provenance-published version.** Only after a real `cli-v*` tag has gone through
  `.github/workflows/release-cli.yml` (build → the clean-room test → `npm publish --provenance`) should the
  host's `cli: {package, version, minVersion?}` point at that version — never at a version only built locally.
- **Plan 6: Arc's USDC-as-gas reserve** — **done in Plan 6** (Task 1, `4b822e3`, `4bc5e13`; spec §12 item 61).
  On Arc, `fund` folds the gas into `usdc.need` (plus one `sessionGasWei` per unsettled channel, `usdc.reserved`),
  and `withdrawReserve()` keeps unsettled channels × `sessionGasWei` + 500,000 × the fee ceiling, which also gates
  every opening path.
- **The host can pin only a version of the CLI's own package.** `init` validates `/templates.cli` locally and,
  in the published bundle, refuses a different package name (final review C1: a host-supplied package used to
  reach an install command the recipe told the agent to run). Re-check this whenever the gate or the install
  hint changes.
- **Licensing of the published tarball.** The bundle inlines viem, chess.js and their dependencies; the build
  ships `THIRD_PARTY_LICENSES` from esbuild's metafile. Confirm it is complete for the release build, alongside
  the project's own `LICENSE`.
- **A lying RPC can fake a withdraw receipt** (final review M11, parked): `withdraw` would report success while
  nothing moved. Funds are never redirected (targets come from config), but pin a trusted RPC for real funds.

### Plan 5.7

See `docs/superpowers/specs/2026-10-13-xmtp-fallback-design.md` (§6, §8) for the full design. The XMTP fallback
transport ships in Plan 5.7; these are the gates before it carries real money or real games on mainnet:
- **The gateway must be funded and running on separate infrastructure once XMTP fees are enforced.** While XMTP's
  fees are not enforced, no gateway is needed at all (`deploy/xmtp-gateway/`'s README notes that, as of
  2026-10-13, whether mainnet fee enforcement is already live or still pending is not clearly stated in XMTP's
  own docs — verify current status before launch). Once enforced, the gateway must be running, funded to its
  payer cap, monitored (`deploy/xmtp-gateway/README.md`), and on infrastructure separate from the website; the
  server must publish `gatewayHost` in its `xmtp` config.
- **Gateway authentication once XMTP ships client auth tokens.** XMTP's `gatewayAuthTokenFetcher` is marked
  "coming soon" as of 2026-10-13; until then, the only available gate is IP-based — a custom gateway build using
  the Go library's `WithAuthorizers` hook, or a per-IP rate limit in front of ports 5050/5055 (reverse proxy or
  firewall), since the prebuilt image ships with no limiter of its own (`deploy/xmtp-gateway/README.md`). Once
  XMTP ships client auth tokens, the gateway must authorize only session keys of currently open channels — not
  every client that happens to present a token.
- **XMTP production verified end to end before launch.** The system tests run only against XMTP's local node
  (Docker); nothing in this repo exercises XMTP's real `dev` or production network. Before mainnet, run the
  manual smoke script (spec §7) against XMTP's public `dev` network, and confirm the fallback actually works
  against production XMTP, not just the local-node fixture.
  - **`dev`: done in Plan 6 Task 5** (`docs/superpowers/arc-testnet-rehearsal.md` §7). On Arc testnet, the host was
    SIGKILLed mid-game, twice (once per hub). Both daemons were seen on XMTP `dev` 4.4 s after the kill in the first
    run, and 45.5 s after it in the rerun. Both figures are as observed through the script's own `/status` polling,
    which was rate-limited in the rerun; the daemons do not timestamp the switch itself. Both times they finished the
    game and closed over XMTP, the payouts were exact, and nothing reached the chain's dispute path. **Production
    XMTP is still open.**
- **Supply-chain note for the pinned native SDK.** `@xmtp/node-sdk@6.1.0` is installed at runtime (`arena xmtp
  enable`), never bundled into the published CLI, and pinned by exact version (`--save-exact`). It is a native
  module (not pure JS) fetched from npm outside the workspace's own lockfile/audit surface — confirm its
  provenance and integrity (npm's own signature/provenance checks, or a manual hash pin) before relying on it for
  real-money games, the same way Plan 5.6's gates treat the CLI's own published tarball.
- **The XMTP SDK runs inside the process that holds the wallet key.** `@xmtp/node-sdk` and its native bindings
  run in the daemon's own process, with the wallet key and every session key in memory: a supply-chain risk (and
  a native crash there stops the watchtower too). Isolate the SDK in its own process before real funds.
- **XMTP resource bound.** A daemon runs at most 64 XMTP clients (`XMTP_MAX_CLIENTS`), each one opened only once its
  channel is Open on-chain and closed (`Client.close()`, node-sdk 6.1.0) when the channel settles. Before launch,
  measure fds, threads and RSS on a long-running house bot across many channels and confirm they stay flat.

### Plan 6 live agent run and H3/H4 (2026-10-24)

- **H3 (rate-limit resilience).** A rate limit never counts as a refused range in the indexer or the dispute scan;
  every viem transport retries rate limits with bounded back-off; the sender treats an ambiguous "nonce too low" as
  possibly ours, never re-sending at the next nonce; actions that took effect answer 200 with `chainStale`. The
  dedicated-RPC item under Task 5 below still stands: retries soften a shared public RPC, they do not make it safe for
  a watchtower.
- **H4 (agent journey, from the live run's frictions).** `arena fund` leads with `tellYourHuman` and a `disclosure`;
  `arena daemon --detach` keeps the daemon alive past the agent's tool session; skill.md picks a random matching
  offer and explains `chainStale`. A detached daemon keeps running after the agent finishes (by design);
  `arena daemon stop` (`8e7eb93`) lets an agent under a narrow tool allowlist stop or restart it.
- [ ] **Re-run the live agent test after H4** and check: each agent writes the funding ask in its own reply before
  `wallet --wait-for-usdc`; it states the audit text and caps before funding; `daemon --detach` survives the session;
  concurrent agents pick different offers.

### Plan 6 Task 5 (the Arc testnet rehearsal, 2026-10-24)

See `docs/superpowers/arc-testnet-rehearsal.md` §2–§10. The scripted rehearsal used real faucet USDC on Arc testnet:
3 games then a close, a challenge → respond → timeout dispute, and a host kill finished over XMTP `dev`. It ran
twice: first on the pre-hardening hub (§2–§9), then on the hardened-hub redeploy (§10). Both times, payouts and
balances reconciled exactly, and gas was 0.0827 and 0.0844 USDC. On the hardened hub, `claim()` and
`renounceOwnership()` behave as M1/M2 require (`eth_call`).

- **Fixed: Arc's RPC refuses an `eth_getLogs` with more than 10 topics** (testnet and mainnet, -32012). The host's
  indexer read all 15 hub events in one query and could never index a channel, so the relay could serve no game. The
  SDK's `hubEvents` now asks for the 7 channel events only (report 8.1).
- **Pre-mainnet: a dedicated, rate-limit-free RPC for the host and every daemon.** The public testnet RPC rate-limited
  the run constantly (report 8.2):
  - 264 indexer errors and over 200 daemon read failures were logged;
  - a `respond` landed 53 s after the move that answered the challenge;
  - a `timeout` landed 55 s after the deadline;
  - the session-gas check, which triggers refills, failed 208 times.

  Measure the mainnet RPC's limits under the expected load; do not run the watchtower on a shared public endpoint.
  (This makes item 5's "`publicRpcUrl` is an RPC you run or trust" concrete.)
- **Fixed (H3, `7d151b8`): an action route must not report failure for an action that happened.** `POST /move` (and every route
  that returns `status()`: `/close`, `/challenge`, `/next-game`, `/accept-draw`, `/resign`) answered 500 when only
  the status read after the action was rate-limited. The move had been signed and relayed. An agent that trusts the
  500 may retry, or give up on a move it already made (report 8.2).
- **Fixed (H3, `c0e07d7`): `arena init` had no retry on a 429.** One rate-limited `eth_getCode` failed the command (report 8.3). The CLI's one-shot RPC calls now retry 429/-32005/5xx for up to about 15 s.
- **Fixed (H3, `abde97a`): a sweep whose receipt wait hits a plain RPC error was recorded as `"dust"`.** The swept amount is then missing from
  `sweeps`; the funds are safe in the wallet. This is a new path into the parked "Other" item above (report 8.4).
- **Each sweep leaves about 0.00027 USDC on its session key:** the fee reserve it did not spend (report 8.5).
- **Closing over XMTP `dev`.** The rerun timed every sub-step and measured 5.8 s, against 2.8 s over the relay. About
  3 s of it was the Close signature's XMTP delivery (report §10). The first run's 48.9 s was not broken down. Its cause
  is unproven; rate-limited status polling is likely. Measure it again under load before relying on it.

## Mainnet-readiness checklist (must be true before any real-USDC deploy)

1. **Arc chain facts verified and written down.** Done 2026-10-19 in `docs/superpowers/arc-facts.md`. Arc mainnet has been live since 2026-09-16. The facts below are recorded there, with seven consequences for Plan 6.
   - The block gas limit comfortably exceeds 2.1M; `challenge` at 2.02M has headroom.
   - The fee scale is known: base fee range, priority fee, and whether EIP-1559 is supported.
   - The RPC supports the `pending` tag for `getTransactionCount` and `estimateGas`.
   - Finality is instant (so m2 does not arise).
   - The USDC ERC-20 address has 6 decimals, returns true on `transfer`, has no fee-on-transfer, and a blocklisted recipient reverts or returns false (so `owed` works).
2. **Dispute gas fixed (C1).**
   - `sessionGasWei` is derived from item 1.
   - There is a re-top-up while Open/Challenged, and a low-gas attention.
   - The new system test passes.
   - The wallet's `--fee-ceiling-wei` default is set for Arc. (Done in Plan 6 Task 2, `dc0d0ed`: 40 gwei, and `init` refuses a value under the 20 gwei floor.)
3. **Daemon safety policy.**
   - A `minChallengeTimeout` floor (I4).
   - Bounded USDC approval (I2).
   - Pinned canonical mainnet addresses in the CLI. (Arc testnet 5042002 pinned in Plan 6 Task 5, with tests: `init`
     refuses another hub or rules there, and the pin is checked against `contracts/deployments/5042002.json`. The
     mainnet 5042 pin is Task 6's, after the mainnet deploy.)
   - Offer signature verified on accept (m6).
   - A supervisor or auto-restart is documented, and memory stays flat over 60 min (I3).
4. **Deployment and ownership.** The steps are in `docs/superpowers/arc-mainnet-runbook.md`, which is self-contained.
   - [ ] **The ECDSA-only hub is redeployed on Arc testnet and the rehearsal rerun on it.** On 2026-10-25 the owner
     decided that the hub verifies ECDSA only (final review A I-1, `aa5ddfc`). The bytecode changed, so the testnet
     hub `0x9b8B…bA41` still has the ERC-1271 fallback. The controller redeploys after the final fix wave, with the
     testnet deployer as the only sender. Then it reruns the rehearsal and updates `contracts/deployments/5042002.json`
     and `KNOWN_DEPLOYMENTS[5042002]`.
   - `ARENA_TOKEN` is set explicitly to Arc USDC. The script reverts without it on any chain but 31337, and on 5042 and
     5042002 it reverts for any token but `0x3600…0000` (`21bd2da`, final review A m-1).
   - The owner ends as a multisig that exists on Arc (last bullet). `ARENA_FEE_RECIPIENT` is set, to an address that
     can transact on Arc, since only it can `claim()` a payout deferred to it.
   - The fee and max fee, and the launch limits (10 USDC / 1,000 USDC suggested), are signed off.
   - Source is verified on the explorer, and `deployments/<chainId>.json` is committed. (Testnet done in Plan 6 Task
     5: both contracts are verified on `explorer.testnet.arc.io`, and `contracts/deployments/5042002.json` is committed
     (rehearsal report §1). That includes the hardened-hub redeploy (`0x9b8B…bA41`, I1/M1/M2), whose `ChannelHub`
     verified cold through `scripts/verify-arc.sh`'s Sourcify import. The script now requires a full match
     (`is_fully_verified`). It is ready for mainnet pending a check of `explorer.arc.io`'s API: in the T5 review, its
     `/api/v2/smart-contracts/verification/config` answered 403 to a plain request; Sourcify lists 5042. Re-checked
     2026-10-25: still 403, a Cloudflare "Just a moment…" challenge page, and Sourcify lists 5042 as supported. The
     script reads that endpoint first, under `set -e`, so it stops there, before Sourcify (runbook §7). Mainnet is
     still to do.)
   - [ ] **The mainnet deploy key never touches argv or the environment.** Use a Foundry encrypted keystore
     (`cast wallet import <name> --interactive`, then `forge script … --account <name> --sender <address>`, with a
     password prompt or a 0600 `--password-file`), or a hardware wallet. Never `--private-key` on the command line,
     never an exported variable. The testnet deploys used `--private-key` (rehearsal report §1, "For mainnet
     (Task 6)"); mainnet follows the runbook's §2.
   - [ ] **Ownership is handed to the multisig on Arc** (runbook §8).
     - Deploy with `ARENA_OWNER` set to the deployer. The deployer then calls `transferOwnership(multisig)`, and the
       multisig itself calls `acceptOwnership()` on Arc. That is the multisig's own transaction there, which proves
       it can transact on Arc before it holds the pause key.
     - Afterwards `owner()` reads the multisig and `pendingOwner()` reads zero. Record both transaction hashes.
     - Deploying with `ARENA_OWNER` set to the multisig would skip that proof, because the constructor sets the
       owner directly and there is nothing to accept. A Safe that exists only on another chain, or a typo, could
       then be fixed only by a redeploy. Renouncing is disabled (audit M2).
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
   - Key custody. Never renounce ownership (m15); the hub enforces this on-chain (audit M2).
8. **Docs.**
   - The spec's Plan 4.5 refinement block and the `TxSender` contract (I1).
   - skill.md's Arc gas wording (m11) and the settle/`wait` guidance (m4). (Arc wording: done in hardening wave H2, `2bbdf58`; spec §12 item 66. Still to do: read it back from the deployed mainnet host before launch.)
   - The spec's Plan 6 refinement block (spec §12 items 60–68). (Done in H2.)
   - The admin-surface caveats (m13, m14).
9. **A final test gate on the release commit.**
   - `test:contracts`, plus the deep profile, mutants 28/28 (`scripts/tools/mutants.sh`: the original 18, I1a–I1e,
     M2a–M2b, M1a–M1b and E1), Slither 0 High/Medium, and Echidna.
   - `test:sdk`, `test:cli` and `test:server`, each run on its own.
   - `test:system` twice.
   - A 60-minute soak.
   - One fully budgeted LLM run against the release build.

