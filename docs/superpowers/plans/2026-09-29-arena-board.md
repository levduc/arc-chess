# Arena Web Board & Handoff Implementation Plan (Plan 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each player's daemon a local web board where a human can take over a seat from the agent, play by clicking, and hand the seat back. Also close the daemon items that `docs/superpowers/mainnet-gates.md` lists under "Open product items".

**Architecture:**
- The daemon's existing local API (`packages/cli/src/api.ts`, 127.0.0.1 only, bearer token) also serves a static, dependency-free board app at `/board`. The app consists of vanilla ES modules, CSS, and chess.js 1.4.0 served from `node_modules`.
- The browser reads the token from the URL fragment (`#token=…`) and calls the same JSON API with `x-arena-actor: human`. It receives live updates through a new server-sent events endpoint.
- The API gains two defenses: a DNS-rebinding guard (Host allowlist) and strict security headers.
- Browser end-to-end tests use `playwright-core` driving the locally installed Google Chrome. No browser download happens.

**Tech Stack:**
- TypeScript on Node ≥ 24, tsx.
- Vanilla JS (ES2022 modules) and CSS for the board.
- chess.js 1.4.0.
- vitest 5.0.1.
- playwright-core 1.63.0 (tests only) with `/usr/bin/google-chrome-stable`.

**Spec:** `docs/superpowers/specs/2026-09-24-agent-chess-arena-design.md`, specifically:
- §6.2 Handoff;
- §6.4 Web board;
- §1 success criterion 4 (a human takes over either seat mid-game and hands it back);
- §3.1 (session-gas sweep);
- §12 items 22–34.

## Global Constraints

- **Exact pins:** viem 2.56.8, tsx 4.23.15, typescript 6.0.3, vitest 5.0.1, @types/node 25.9.8, chess.js 1.4.0, playwright-core 1.63.0 (a devDependency of `tests/system` only).
- **Never bypass pnpm's minimumReleaseAge gate.** Never download browsers (`playwright install` is forbidden). Use `executablePath: "/usr/bin/google-chrome-stable"`, overridable by the env var `ARENA_CHROME`. If Chrome is missing, the browser tests skip with a clear message.
- **Local only.** The board and API bind to 127.0.0.1 only, with no host override (spec §6.1). The token never appears in a URL path or query string. It travels only in the fragment and in the `Authorization` header.
- **No CORS.** The API sends no `Access-Control-Allow-*` headers. Requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` get 421 (DNS-rebinding defense). Board responses send:
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
- **Untrusted text.** Everything that comes from the network or from another party is rendered as text, never as HTML: notes, errors, offer fields. `innerHTML` must never receive untrusted strings.
- **No contract changes.** The spec §12 protocol rules stay intact.
- **Test hygiene.**
  - Never run the SDK and CLI unit suites concurrently, because they share Anvil on :8546.
  - `test:system` uses ports 8600–8699.
  - Never touch the user's demo stack: :8545, :8080, :7071, :7072, pids 741101 and 741102.
  - Do not run `llm-games`.
- **Commit trailer:** `Co-Authored-By: <model> <noreply@anthropic.com>`.
- **Style:** 2 spaces, double quotes, 120 columns, comments only where the why isn't obvious.

## Review Focus

1. **Controller boundary.** Any request without the right controller must fail. A human clicking a move while the agent controls the seat gets a clear refusal. The agent's `arena move` while the human controls the seat is refused. Neither ever signs.
2. **Hostile web pages.** A page on another origin that the user has open must not be able to read state or act, either by guessing the port or by DNS rebinding.
3. **Untrusted text rendering.** A handoff note, or an opponent-influenced string, that contains HTML or script is shown as inert text.
4. **Dispute visibility.** During a challenge where the human must move, the board shows the deadline countdown and the move still goes through `respond`.
5. **Settled channels and gas.** After a channel settles, its session-key gas is swept back to the wallet. The wallet balance rises, and no key is left holding more than dust.

---

## File Structure

- `packages/cli/src/daemon.ts` (modify):
  - sweep;
  - refill back-off;
  - `session-gas-low` precision;
  - wait on evicted channels;
  - settled index;
  - `events()` feed.
- `packages/cli/src/status.ts` (modify): `legalMovesUci`, `lastMove`, `boardUrlHint`.
- `packages/cli/src/api.ts` (modify):
  - Host guard;
  - security headers;
  - static board;
  - `GET /events` SSE;
  - offer default timeout.
- `packages/cli/src/board/` (new): `index.html`, `app.js`, `board.js`, `api.js`, `style.css`.
  - These are shipped as static files and served from disk, with an allowlist of files and no directory listing.
- `packages/cli/src/cli.ts` (modify): `arena board`, which prints the URL, and `arena sweep`.
- `scripts/dev-up.ts` (modify): the `--dir` marker guard.
- `tests/system/board.test.ts` (new), plus `tests/system/browser.ts` (a small playwright-core launcher).
- Docs:
  - `packages/cli/README.md`;
  - `apps/server/src/docs.ts` (skill.md handoff etiquette);
  - spec §6.2, §6.4, §12, §3.1;
  - `docs/superpowers/mainnet-gates.md` (tick the closed items).

---

### Task 1: Daemon items from the mainnet gates

**Files:**
- Modify: `packages/cli/src/daemon.ts`, `packages/cli/src/api.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/config.ts`, `scripts/dev-up.ts`.
- Tests: `packages/cli/test/hardening.test.ts`, `packages/cli/test/daemon.test.ts`, `tests/system/dev-up.test.ts`.

**Requirements:**
1. **Session-gas sweep.**
   - When a channel becomes Finalized or Reclaimed, the main pass sweeps the session key's balance back to the wallet: `balance − gas·maxFeePerGas`. It uses the nonce-manager session sender.
   - Skip the sweep if the balance is below the send cost × 2 (dust).
   - Retry with back-off on failure. Record `swept: true` in the channel record once done.
   - Eviction (spec §12) waits until the sweep is done or declined as dust.
   - Add `arena sweep [--channel ID]` and `POST /sweep`. These sweep settled channels whose records show `swept !== true`, including records left over from before this feature.
   - Tests:
     - after settle, the wallet's native balance rises by about the swept amount and the key keeps less than dust;
     - `arena sweep` on a legacy record sweeps it.
2. **Refill back-off.** Add a per-channel `refillBlockedUntil`. It starts at 30 s after a failed refill, doubles up to 5 min, and resets on success or when the wallet balance rises above the last-seen value. Log once when an episode starts and once when it ends. Test: an empty wallet produces bounded attempts and log lines over N passes.
3. **`session-gas-low` precision.** Raise it only on `TxInsufficientFundsError`, `TxFeeCapError`, or a failed fee/gas estimate. Other refill errors are logged only. Test: `TxNonceUsedError` during a refill does not raise it.
4. **Offer default timeout.** When `challengeTimeout` is omitted, `POST /offers` defaults to `minChallengeTimeoutOf(config)`. `arena offer` omits the field unless `--timeout` is given. Test: a daemon with `minChallengeTimeout` of 1800 accepts its own default offer.
5. **`wait --channel` on an evicted settled channel** returns `{ channelId, reason: "settled" }` immediately, not 409. Test for this.
6. **Settled index.**
   - Keep `settledStatus` in an in-memory map, loaded once at start and updated at settle.
   - `channels()` lists settled channels after a restart too, capped at the most recent 1,000 by settle time.
   - Test: after a restart, settled channels are listed.
7. **Floor check.** `arena init` refuses `sessionGasFloor > sessionGasWei`.
8. **`dev-up --dir` guard.**
   - Refuse a directory that is non-empty and has no `.arena-dev-marker` file.
   - Create the marker on first use.
   - Test: refusing `--dir` on a non-empty temp dir that has no marker.

- [ ] Steps: TDD for each item, one commit per item; then run `pnpm test:cli`, then `pnpm test:system` once.

### Task 2: Board-ready API (security, SSE, status fields, static serving)

**Files:**
- Modify: `packages/cli/src/api.ts`, `packages/cli/src/status.ts`, `packages/cli/src/daemon.ts`, `packages/cli/src/cli.ts`.
- Create: `packages/cli/src/board/index.html`, a placeholder that Task 3 replaces.
- Tests: `packages/cli/test/api.test.ts`, `packages/cli/test/status.test.ts`.

**Requirements:**
1. **Host guard.** Any request whose `Host` header is not exactly `127.0.0.1:<port>` or `localhost:<port>` gets 421 with no body details. This applies to every route, including `/health` and `/board`.
2. **Security headers** on every response: the CSP, nosniff, and Referrer-Policy from Global Constraints, plus `Cache-Control: no-store` for JSON. Never send CORS headers. A preflight `OPTIONS` gets 405.
3. **Static board.**
   - `GET /board` serves `index.html`.
   - `GET /board/<file>` serves an allowlisted file from `packages/cli/src/board/`: `app.js`, `board.js`, `api.js`, `style.css`.
   - `GET /board/vendor/chess.js` serves chess.js 1.4.0's ESM build. Resolve it via `createRequire(import.meta.url).resolve("chess.js")` and derive `dist/esm/chess.js`.
   - Set the correct content types.
   - These static routes need no token, since they contain no data. Every data route still requires the bearer token.
   - A path-traversal attempt (for example `/board/../config.json`, or an encoded variant) gets 404.
4. **`GET /events` (SSE).**
   - Requires the bearer token.
   - Streams `event: change` with `data: {"channelId": … | null}` on every daemon `notify()`, plus a `: ping` comment every 15 s.
   - Closes on daemon stop.
   - At most 8 concurrent SSE clients; the ninth gets 429.
   - Browsers can't set headers on `EventSource`, so the board uses `fetch()` with the `Authorization` header and a `ReadableStream` reader. Document this in the code.
5. **Status fields.**
   - Add `legalMovesUci: string[]` (from/to/promo, for example `e7e8q`), present only when it is my turn and I am the controller-agnostic mover.
   - Add `lastMove: { from, to, san } | null`, derived from the session's latest state versus the previous one.
   - Add `orientation: "white" | "black"`.
   - Add `handoff: { controller, note, since }`, with `since` set at handoff.
6. **`arena board`** prints `http://127.0.0.1:<port>/board#token=<token>`. It is also printed once in the `arena daemon` start JSON line as `board`. It never goes into log files.

- [ ] Steps: TDD for each requirement, including a request with `Host: evil.example:PORT` getting 421, traversal getting 404, and the SSE auth / 429 cap. Commit, then run `pnpm test:cli`.

### Task 3: The board app

**Files:** Create `packages/cli/src/board/index.html`, `app.js`, `board.js`, `api.js`, `style.css`. Modify `apps/server/src/docs.ts` only if a link is needed.

**Requirements (spec §6.4, plus §6.2):**

*Token and API*
- On load, read `#token=` from `location.hash`, store it in memory only, and clear the fragment with `history.replaceState`.
- If there is no token, show "Open the link printed by `arena board`".
- The API wrapper sends `Authorization: Bearer <token>` and `x-arena-actor: human`. A 401 response shows the missing-token view.

*Layout*
- Left: a channel list with a status chip per channel (your turn, waiting, challenged, settled). The attention banners `session-gas-low`, `lobbyError` and `opponent-silent` also show in the list.
- Center: an 8×8 board drawn with CSS grid, with pieces from Unicode glyphs or inline SVG in the same files. No external assets.
  - Orientation follows `orientation`.
  - The last move is highlighted.
  - Clicking a piece highlights its legal targets from `legalMovesUci`.
  - Clicking a target sends `POST /move { move: <uci>, offerDraw }`.
  - Promotion opens a small picker (q/r/b/n).
  - Moves are enabled only when `controller === "human"` and it is my turn.
- Right panel:
  - a controller badge (Agent or Human);
  - **Take over** / **Hand back** buttons (`POST /handoff`), with a text field for the note when handing back;
  - the agent's handoff note, rendered as text;
  - balances (me and opponent);
  - the game index;
  - game status;
  - an **offer draw** toggle, plus the Resign, Accept draw, Next game and Close buttons, each enabled only when valid per `suggestedActions` or status;
  - a challenge countdown (`challenge.secondsLeft`, ticking locally, re-synced on events). When `mustMove` is set, show a red banner reading "You must move before the deadline".
- Bottom: a lobby panel. It lists offers (`GET /offers`) with Accept buttons, and has a small create-offer form (deposit and stake in USDC; the timeout defaults to the daemon's). Accepting or creating an offer asks for confirmation first, because it commits funds.

*Behaviour*
- **Live updates:** re-fetch `/channels` and the selected `/status` on each SSE `change`. On an SSE error, fall back to polling every 5 s.
- **Errors:** show API errors in a dismissible, text-only toast.
- **Accessibility:** buttons have labels, board squares have `aria-label`s (for example "e4 white pawn"), and the board is keyboard navigable (arrow keys plus Enter).
- **Structure:**
  - `board.js` is pure: it renders from a status object and emits intents, with no fetch.
  - `api.js` holds fetch and SSE.
  - `app.js` does the wiring.

*Unit tests*
- Test `board.js`'s pure helpers in vitest, with no DOM:
  - uci-to-target mapping;
  - promotion detection;
  - orientation index math;
  - lastMove squares.
- Put the helpers in a module that exports functions and has no DOM access.

- [ ] Steps:
  1. Pure helpers, TDD.
  2. The DOM app.
  3. Load `/board` by hand once, via Task 4's harness or with `pnpm dev:up` on free ports, to confirm it renders.
  4. Commit.

### Task 4: Browser end-to-end tests (handoff and board)

**Files:**
- Create: `tests/system/browser.ts`, `tests/system/board.test.ts`.
- Modify: `tests/system/package.json`, adding `playwright-core` 1.63.0 as an exact devDependency.

**Requirements:**
- `browser.ts`:
  - `launchChrome()` uses `chromium.launch({ executablePath: process.env.ARENA_CHROME ?? "/usr/bin/google-chrome-stable", headless: true })`.
  - If the executable is missing, export a `skipIfNoChrome` flag so the tests `describe.skip` with a message.
  - Always close the browser in `afterEach`.

Scenarios (on the Task 7 harness from Plan 4.5, with real daemons, server and chain):
1. **Handoff round trip (success criterion 4).**
   - Alice and Bob open a channel. The agents (the harness) play one move each.
   - Alice's agent hands off: `POST /handoff {to:"human", note:"your move, try the Italian"}`.
   - The browser opens Alice's board URL and sees the "Human" badge and the note.
   - It makes a legal move by clicking. Bob's daemon receives it.
   - The agent's `POST /move` gets refused while the human is in control.
   - The human clicks **Hand back** with a note. The agent's `wait` returns `control-changed`.
   - The agent plays on, and the game completes and closes.
   - Assert exact balances.
2. **Controller boundary.** While the agent controls the seat, clicking a piece shows no targets. A forced `POST /move` with `x-arena-actor: human` gets 409. No signature is produced (`lastSignedTurn` is unchanged).
3. **Challenge while the human controls the seat.**
   - Bob challenges while Alice (human) is to move.
   - The board shows the `mustMove` banner and a countdown that decreases.
   - The human clicks a move. The move lands via `respond` (on-chain `Responded` event) and the phase returns to Open.
4. **XSS.** A handoff note of `<img src=x onerror=window.__pwned=1><b>x</b>` renders as literal text. `window.__pwned` stays undefined and no `<img>` element exists in the note container.
5. **Hostile origin and rebinding.**
   - From the browser, a page on a different origin (a data: URL or a second local server) tries `fetch("http://127.0.0.1:<port>/channels")` with no token and gets no data: CORS blocks the read, and without the token the server returns 401 anyway.
   - A Node request with `Host: attacker.example:<port>` gets 421.
   - The static board still loads only through the exact host.
6. **Token hygiene.** After load, `location.hash` is empty and the token appears in no request URL (check with `page.on("request")`).
7. **Settle and sweep.** After the scenario 1 channel closes, Alice's session-key native balance is at or below dust, and her wallet's native balance rose.

- Runtime for the whole file should be under about 4 minutes.
- Run it twice.

- [ ] Steps:
  1. Launcher and skip logic.
  2. Scenarios, one at a time.
  3. Fix product bugs with regressions, one commit each.
  4. Commit the test file.

### Task 5: Docs, `skill.md` handoff etiquette, spec, mainnet gates

**Files:**
- `packages/cli/README.md`: the board section, `arena board`, `arena sweep`, and security notes.
- `apps/server/src/docs.ts`: skill.md and the chess skill get handoff etiquette:
  - when to hand off (hard decisions, the human asked, or low confidence);
  - always leave a note;
  - how to resume (`wait` returns `control-changed`);
  - agents must never try to act while the human is in control.
- The spec:
  - §6.2 and §6.4: the actual behaviour, the security model, the SSE feed and the static routes;
  - §3.1: the sweep is implemented;
  - a new §12 item for Plan 5: the Host guard, CSP, token in the fragment, the SSE cap, and the sweep.
- `docs/superpowers/mainnet-gates.md`: tick the closed product items (sweep, refill back-off, session-gas-low, offer default, wait-evicted, dev-up guard); leave the rest.
- Server tests that check the skill text are updated.

- [ ] Steps:
  1. Write the docs.
  2. Run `pnpm test:server`.
  3. Commit.
