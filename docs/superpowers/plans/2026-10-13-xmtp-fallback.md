# XMTP Fallback Transport Implementation Plan (Plan 5.7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a game in progress keeps moving when the host website is down, because the daemons fall back from the host relay to XMTP. The chain stays the last resort.

**Architecture:**
- `FallbackRelay` implements the existing `RelayClient` by composing the host relay with an `XmtpRelay`.
- Each channel's session key is its XMTP identity. A message is accepted only from the opponent's signer.
- The XMTP SDK is opt-in, installed into `<home>/xmtp/sdk` by `arena xmtp enable`, and loaded dynamically.
- The server publishes `xmtp` config in `/templates`, and `init` caches it.
- The host pays fees through an XMTP Gateway on separate infrastructure. This plan covers only its operations docs.
- System tests run against XMTP's local node in Docker.

**Tech Stack:** TypeScript on Node ≥ 24; viem 2.56.8; vitest 5.0.1; `@xmtp/node-sdk` 6.0.0, never bundled and installed at runtime; Docker for the XMTP local node.

**Spec:** `docs/superpowers/specs/2026-10-13-xmtp-fallback-design.md`. The parent spec is `docs/superpowers/specs/2026-09-24-agent-chess-arena-design.md`.

## Global Constraints
- **Unchanged behaviour when XMTP is off.** With XMTP not enabled, or `config.xmtp` absent, behaviour must be exactly today's. Every existing test must pass unmodified, except tests that pin `ChannelStatus` keys: they gain `transport`.
- **Bundle.** The published CLI bundle stays zero-runtime-dependency and must not contain the XMTP SDK. The SDK is loaded with a dynamic `import()` from `<home>/xmtp/sdk/node_modules/@xmtp/node-sdk` resolved at runtime.
- **Key handling.** The raw session key never reaches XMTP code; everything goes through `RelaySigner` (I5). The DB key is `keccak256(await signer.signMessage({ message: { raw: toHex("arena-xmtp-db/v1:" + channelId) } }))`.
- **Dependencies.**
  - viem stays at 2.56.8, never 2.56.9.
  - Never bypass pnpm's `minimumReleaseAge`.
  - No new workspace dependencies. The XMTP SDK is installed only into a home (runtime) or a test fixture directory, never into the pnpm workspace.
- **No contract changes.**
- **Hands off the user's stack.**
  - Never touch ports 8545/8080/7070, `~/.arena`, `.arena-dev/`, or the user's processes.
  - Every CLI invocation uses a temp `HOME`/`ARENA_HOME`.
  - Kill only pids you started, never by pattern.
- **Docker.**
  - XMTP local-node containers are started by tests with a unique compose project name per run, and torn down in `afterAll`/`afterEach`, even on failure.
  - Never `docker system prune` or touch other containers.
- **Test runs.** Suites run in the foreground, one at a time. Never run the SDK and CLI suites concurrently.
- **Commit trailer:** `Co-Authored-By: <model> <noreply@anthropic.com>`.

## Review Focus
1. **The host relay is half-up.** The socket is open but the channel is not joined, or the server accepts frames and drops them. Expected: if the channel is not joined after `HOST_DOWN_GRACE_MS`, sends go via XMTP. "Joined but silently dropping" is out of scope, because the chain fallback covers it. Document this in the code comment. Task 1 tests both the joined and not-joined cases.
2. **The same message arrives by both transports.** Expected: processed once, with no double proposals and no double close submissions. Task 1 tests delivery order relay-then-XMTP, XMTP-then-relay, and interleaved with a newer state.
3. **The SDK is missing, broken, or the wrong version** (no native binary for the platform, corrupt install). Expected: the daemon starts with `fallback: "off"`, logs once, and never crashes. Task 1 covers the loader. Task 4 covers `xmtp status` reporting it.
4. **A third party floods a session key's XMTP inbox.** Expected: dropped, counted, rate-limited per channel, and memory stays bounded. Task 1 tests the drop path; Task 5 injects a real third-party message.
5. **The daemon restarts while a channel is on XMTP.** Expected: the client resumes from its DB with no new installation. That keeps the inbox under XMTP's cap of 10 installations. Task 5 tests a restart mid-fallback and asserts the installation count stays 1.

## Parallelism
- **Wave 1 runs Tasks 1, 2 and 3 in parallel.** They touch disjoint files: Task 1 `packages/cli/src/{xmtp/**,host.ts,run.ts,status.ts,daemon.ts,config.ts}`, Task 2 `apps/server/**`, Task 3 `deploy/**`, `tests/system/xmtp-local/**` and docs.
- **Wave 2 is Task 4**, which needs Task 1's types and Task 2's `/templates` shape.
- **Wave 3 is Task 5.**

---

### Task 1: `XmtpRelay`, `FallbackRelay`, and the host relay's up-signal (CLI core)

**Files:**
- Create: `packages/cli/src/xmtp/transport.ts` (the `XmtpTransport` interface and the node-SDK implementation), `packages/cli/src/xmtp/relay.ts` (`XmtpRelay`), `packages/cli/src/xmtp/fallback.ts` (`FallbackRelay`), `packages/cli/src/xmtp/loader.ts` (the dynamic SDK loader).
- Modify:
  - `packages/cli/src/host.ts`: the relay exposes `isJoined(channelId)` and `onLinkChange(handler)`;
  - `packages/cli/src/run.ts`: wire in `FallbackRelay` when `config.xmtp` is set and the SDK loads;
  - `packages/cli/src/config.ts`: add `XmtpConfig` and `ArenaConfig.xmtp?`, validated by `loadConfig`;
  - `packages/cli/src/status.ts`: `transport`;
  - `packages/cli/src/daemon.ts`: the start line's `fallback`, plus the `transportOf(channelId)` hook it reads.
- Test: `packages/cli/test/xmtp-fallback.test.ts` and `packages/cli/test/xmtp-loader.test.ts`.

**Interfaces (produced, exact):**
```ts
// config.ts
export type XmtpConfig = { env: "local" | "dev" | "production"; apiUrl?: string; gatewayHost?: string };
// xmtp/transport.ts
export interface XmtpTransport {
  /** Starts (or resumes from its DB) the XMTP client for one channel's session key, and opens a DM to `peer`. */
  open(channelId: Hex, me: RelaySigner, peer: Address): Promise<void>;
  send(channelId: Hex, text: string): Promise<void>;
  /** `from` is the XMTP sender's Ethereum address; `dm` is the peer address of the conversation it arrived in. */
  onText(handler: (channelId: Hex, from: Address, dm: Address, text: string) => void): () => void;
  close(channelId: Hex): Promise<void>;
  stop(): Promise<void>;
}
export function createNodeSdkTransport(opts: { sdk: unknown; dbDir: string; config: XmtpConfig; log(l: string): void }): XmtpTransport;
// xmtp/loader.ts
export async function loadXmtpSdk(home: string): Promise<{ ok: true; sdk: unknown; version: string } | { ok: false; reason: string }>;
export const XMTP_SDK_VERSION = "6.0.0";
// xmtp/fallback.ts
export const HOST_DOWN_GRACE_MS = 3000;
export const XMTP_MAX_PAYLOAD_BYTES = 16 * 1024;
export class FallbackRelay implements RelayClient {
  constructor(opts: { host: HostRelay; xmtp: XmtpTransport; graceMs?: number; now?: () => number; log?(l: string): void });
  transportOf(channelId: Hex): "relay" | "xmtp" | "none";
  /** Messages dropped by the XMTP acceptance checks, per channel (spec §3). */
  dropped(channelId: Hex): number;
}
// host.ts — the relay object returned by connectHost gains:
export type HostRelay = RelayClient & { isJoined(channelId: Hex): boolean; onLinkChange(handler: () => void): () => void };
```

**Requirements:** spec §2 and §3, verbatim:
- `join` joins the host relay as today. It also calls `xmtp.open(channelId, signer, params.signers[other])` and does not await it for the host path, so a slow XMTP never delays the host join.
- `send`:
  - when `host.isJoined(id)`, send via the host;
  - else, if the channel has not been joined for `graceMs`, send via XMTP as `{"arena":1,"msg":<wire JSON>}`;
  - else, hold the message and retry on `onLinkChange` or a timer, whichever comes first.
- Acceptance:
  - `from` must equal the opponent signer, and so must `dm`;
  - the payload must be at most `XMTP_MAX_PAYLOAD_BYTES`;
  - `arena` must be `1`;
  - the message must pass the existing wire decoders and validators.

  Anything else increments `dropped(id)`. Apply the same per-channel inbound rate limit the server's relay uses.
- `leave` leaves the host relay and closes XMTP.
- When `config.xmtp` is absent or the SDK fails to load, `run.ts` uses the host relay directly, exactly as today.
- The XMTP signer adapter is `{ type: "EOA", getIdentifier: () => ({ identifier: signer.address.toLowerCase(), identifierKind: <Ethereum> }), signMessage: async (m: string) => hexToBytes(await signer.signMessage({ message: { raw: toHex(m) } })) }`. Use the SDK's own `IdentifierKind` enum from the loaded module.

- [ ] Steps:
  1. Write the failing tests against a fake `XmtpTransport` and a fake `HostRelay`, covering:
     - the send rule, with an injected `now()` stepping through the grace window, and switching both ways;
     - dedupe in all three orders, using a real `ChannelSession` pair from the SDK test helpers, so processing-once is real and not mocked;
     - every drop path;
     - the rate limit;
     - `transportOf`;
     - `run.ts` choosing the plain host relay when `config.xmtp` is absent;
     - the loader returning `{ok:false}` for a missing dir, a wrong version, or an import that throws.
  2. Implement.
  3. Run `pnpm test:cli` and the typecheck.
  4. Commit.

---

### Task 2: Server `xmtp` config, `/templates`, and the `skill.md` step (server only)

**Files:** modify `apps/server/src/config.ts`, `apps/server/src/server.ts` and `apps/server/src/docs.ts`; test in `apps/server/test/foundation.test.ts` and the config test file.

**Interfaces (produced):**
- `ServerConfig.xmtp?: { env: "local" | "dev" | "production"; apiUrl?: string; gatewayHost?: string }`, the same shape as the CLI's `XmtpConfig`.
- `/templates[i].xmtp` is present only when configured.

**Requirements:**
- Validate `env` against the three values. `apiUrl` and `gatewayHost` must be `http(s)` URLs with no credentials. `gatewayHost` is allowed only with `env: "production"`.
- In `skill.md`, only when `xmtp` is configured, add to the recipe right after the daemon step:
  > Recommended before playing for real money: `<cmd> xmtp enable` (one-time, about 700 MB). If this site goes down mid-game, your daemon keeps playing over XMTP; `status` shows `transport`.
- Troubleshooting gains: "`transport: \"xmtp\"` means this site is unreachable and your game continues over XMTP; new matches need the site."
- Tests:
  - config validation, one test per rule;
  - `/templates` with and without `xmtp`;
  - `skill.md` with and without `xmtp`, pinning both sentences verbatim.
- Run `pnpm test:server`, then commit.

---

### Task 3: Gateway operations, the XMTP local-node fixture, and docs (no TypeScript runtime code)

**Files:**
- Create:
  - `deploy/xmtp-gateway/docker-compose.yml`;
  - `deploy/xmtp-gateway/README.md`;
  - `tests/system/xmtp-local/docker-compose.yml`, a copy of `github.com/xmtp/xmtp-local-node`'s compose file. Every image is pinned by `@sha256:` digest. Resolve the digests with `docker buildx imagetools inspect <image>` or `docker manifest inspect` and record them. Host ports are parameterized as `${XMTP_API_PORT:-5556}`, `${XMTP_GRPC_PORT:-5555}` and `${XMTP_HISTORY_PORT:-5558}`.
- Modify: `docs/superpowers/mainnet-gates.md` (a Plan 5.7 section) and the parent spec §12 (a Plan 5.7 refinements block).
- Test: `tests/system/xmtp-local.test.ts`. It brings the fixture up with a unique project name (`-p arena-xmtp-<pid>-<ts>`) and free ports. It waits for `http://127.0.0.1:<api>/` to answer, or for the gRPC port to accept TCP, within 120 s. It asserts reachability, then tears down with `down -v`. When `docker info` fails, it skips with a loud message.

**Requirements:**
- Gateway README:
  - what the gateway does;
  - the image pinned by digest;
  - every `XMTPD_*` variable from XMTP's docs, verbatim names;
  - the payer funding steps (USDC on Base, Funding Portal);
  - "**run on infrastructure separate from the website**";
  - an IP rate-limit setting;
  - a payer cap of about $20, with the arithmetic from XMTP's published ~$5 per 100k messages;
  - monitoring the payer balance;
  - the upgrade path to client auth tokens when XMTP ships `gatewayAuthTokenFetcher`;
  - a note that tests never run it.
- `mainnet-gates.md`: the spec §8 items.
- Run the new test alone, then commit.

---

### Task 4: `arena xmtp enable|status|disable`, `init` caching, house bots (CLI)

**Files:** modify `packages/cli/src/cli.ts`, `packages/cli/src/bot.ts` and `scripts/build-cli.ts` (an assertion that the bundle contains no `@xmtp/` import); test in `packages/cli/test/xmtp-cli.test.ts`.

**Interfaces:** consumes `XmtpConfig`, `loadXmtpSdk` and `XMTP_SDK_VERSION` (Task 1), and `/templates[i].xmtp` (Task 2).

**Requirements:**
- `arena xmtp enable` runs `npm install --prefix <home>/xmtp/sdk --no-audit --no-fund --save-exact @xmtp/node-sdk@<XMTP_SDK_VERSION>`. The npm binary is found next to `process.execPath`, else on `PATH`. It then calls `loadXmtpSdk(home)` and prints `{enabled:true, version, sizeMB}`.
- `arena xmtp status` prints `{enabled, version|null, reason?, env|null}`. `arena xmtp disable` removes `<home>/xmtp/sdk`; it never touches `<home>/xmtp/db`.
- Tests stub the npm call with an `ARENA_XMTP_NPM` env var that points at a fake installer script copying a fixture package. There is one opt-in real install test behind `ARENA_XMTP_REAL_INSTALL=1`.
- `init` copies `/templates[chess].xmtp` into `config.json` as `xmtp`. Re-init updates it, and a server without `xmtp` removes it. Validation reuses `loadConfig`'s.
- `arena bot`: when `config.xmtp` is set and the SDK is not installed, it logs one line suggesting `xmtp enable` and continues.
- The bundle test asserts that `dist/arena.mjs` contains no static `@xmtp/` import.
- Run `pnpm test:cli`, then commit.

---

### Task 5: System tests against the XMTP local node, and `dev:up --xmtp-local`

**Files:**
- Create: `tests/system/xmtp-fallback.test.ts`.
- Modify:
  - `tests/system/harness.ts`: `startXmtpLocal(): Promise<{ apiUrl: string; stop(): Promise<void> }>`, using Task 3's fixture, plus a `stopServer()` and `restartServer()` on the stack, if not already present;
  - `scripts/dev-up.ts`: `--xmtp-local`;
  - `tests/system/dev-up.test.ts`.

**Requirements:**
- **SDK fixture.** Install the real `@xmtp/node-sdk@6.0.0` once per test run into a temp `HOME`'s `<home>/xmtp/sdk` with `arena xmtp enable`, using a shared cache dir under the system-test temp root. Each further home symlinks to it, so the 725 MB is installed once per run.
- **Scenarios** (each bounded, with cleanup in `afterEach`):
  1. **Kill the host mid-game** (success criterion 1).
     1. Two daemons with XMTP play.
     2. After about 4 plies, stop the server. Within `HOST_DOWN_GRACE_MS` + 10 s, both statuses show `transport: "xmtp"`.
     3. Play to game over and close cooperatively. Expect `Finalized` with exact balances.
     4. Restart the server. A new channel's status shows `transport: "relay"`.
  2. **Flapping host:** down, up, down mid-game; the game completes.
  3. **Third-party sender:** a third-party XMTP client DMs a daemon's session key with a valid-looking message, which is dropped (`dropped > 0`). The game is unaffected.
  4. **Restart mid-fallback:** the daemon is restarted while the host is down. The game resumes over XMTP, and the inbox's installation count stays 1, read with the SDK's inbox state.
  5. **XMTP off:** a pair without `xmtp` behaves exactly as today. Kill the host and show the chain path still works, or reuse an existing dispute test.
- **`dev:up --xmtp-local`** starts the fixture and publishes `xmtp: {env:"local", apiUrl}`. Its test asserts that `/templates` publishes it and that teardown removes the containers.
- **Verification.** Run `pnpm test:system` in full. The new XMTP tests run when Docker is available and skip loudly otherwise.
