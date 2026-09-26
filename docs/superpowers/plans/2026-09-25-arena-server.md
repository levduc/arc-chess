# Arena Host Server Implementation Plan (Plan 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the host website (`apps/server`) and plug it into the daemon. The server provides the template registry, `skill.md`/`llms.txt`, a lobby with match replay, a WebSocket relay with a latest-message cache, a chain indexer with reputation, and a spectator page. The daemon connects to it through real transports, and `arena daemon` runs as a process. Agents can then find each other over the network and play.

**Architecture:**
- **Server.** Node `node:http` plus `ws` (one WebSocket endpoint, `/ws`) plus `node:sqlite` behind a repository interface. All chain reads go through a `ChainReader` interface, so lobby and relay logic can be unit-tested without Anvil.
- **Daemon side.** The daemon keeps its existing `LobbyClient`/`RelayClient` seams. The SDK gains shape validators and a signer-based relay join. The CLI gains a `HostConnection` transport (Node's global `WebSocket` plus `fetch`) with reconnect.
- **Plan 3 preconditions.** The daemon gets its outstanding fixes: chunked cursor event scan, reconnect re-send, serialized senders, and an `ARENA_HOME` lock.

**Tech Stack:**
- TypeScript (ESM, NodeNext, no build step, run through `tsx`) on Node ≥ 24.
- viem 2.56.8.
- ws 8.21.3 (server only); @types/ws 8.18.1.
- node:sqlite `DatabaseSync`.
- vitest 5.0.1; pnpm 12.6.0 workspace.

**Spec:** `docs/superpowers/specs/2026-09-24-agent-chess-arena-design.md`. This plan implements spec §5 (host server), the §6.1 `arena daemon start` and `arena init --server`, the §7 relay-reconnect handling, and part of the §8.7 e2e. Plan 3 left preconditions in `/home/papaduck/.claude/projects/-home-papaduck-dvl-working-repo-2026-arc-state-channel/memory/arena-daemon-carry-forward.md`; they are folded into Tasks 1, 2 and 7.

## Global Constraints

- Package locations: server `apps/server` (package `@arena/server`); CLI `packages/cli`; SDK `packages/sdk`. `pnpm-workspace.yaml` already globs `apps/*`.
- Exact dependency pins:
  - `viem` 2.56.8 (never 2.56.9);
  - `ws` 8.21.3;
  - `@types/ws` 8.18.1;
  - `tsx` 4.23.15;
  - `typescript` 6.0.3;
  - `vitest` 5.0.1;
  - `@types/node` 25.9.8.
- **Never bypass pnpm's `minimumReleaseAge` gate.** No `--config.minimumReleaseAge`, no overrides. If a pinned version is refused, stop and report.
- Node floor: **Node ≥ 24** (needed for `node:sqlite`). This amends spec §3's "Node ≥ 20" (recorded in spec §12 by Task 8).
- Transport ruling: **one multiplexed WebSocket endpoint `GET /ws`** carries both lobby match events and relay traffic. It replaces spec §5's separate `WS /lobby` and `WS /relay/:channelId`, with the same authentication strength (Task 8 records this in §12):
  - relay joins are authenticated by the channel's session key signing a per-connection server nonce;
  - lobby match subscriptions are unauthenticated, because a match event only contains params that become public on-chain at deposit.
- Wire encoding: every JSON body and WebSocket frame that carries protocol values uses the SDK's `toWire`/`fromWire`, where bigints travel as `{"$bigint":"…"}`. The only exceptions are the human/agent-facing JSON routes `/templates`, `/players/:address`, `/api/channels/:id` and `/metrics`, which render bigints as decimal strings.
- The server is untrusted plumbing. It never holds keys or funds. Daemons re-validate everything they receive (`checkMatchParams`, session signature checks).
- The daemon's local API binds to `127.0.0.1` only. `arena daemon` must not expose `startApi`'s `host` override.
- Files in `ARENA_HOME` are written atomically with mode 0600 (existing `writeJsonAtomic`).
- Tests that need a chain reuse `packages/sdk/test/global-setup.ts` (Anvil on port 8546) with `fileParallelism: false`.
- Commit messages end with the trailer `Co-Authored-By: <your model name> <noreply@anthropic.com>`.
- Do not add Prettier/ESLint or reformat untouched code. Match the surrounding style: 2-space indent, double quotes, 120-column lines, comments only where the why is not obvious.

## Review Focus

1. **An offerer is offline when someone accepts its offer.** Expected: when its daemon reconnects, the match is still delivered, so the channel is funded and opens. Pinned by the Task 4 replay test and the Task 8 e2e "offline offerer".
2. **The relay connection drops mid-game.** Expected: the move is delivered once both sides reconnect, with no manual step, whether the sender or the receiver was disconnected. Pinned by the Task 5 cache-replay test, the Task 7 reconnect test and the Task 8 e2e "relay drop".
3. **Re-sent, duplicate or stale relay messages** after a reconnect never show up as `lastError`, never wedge a channel, and never hide a real conflict. Same-turn, different-hash still errors. Pinned by the Task 1 and Task 2 tests.
4. **A non-member, a forged join, a malformed frame or an oversized frame** is refused. Other members of the channel keep working. Pinned by Task 5 tests.
5. **Two `arena daemon` processes on one `ARENA_HOME`**: the second refuses to start, and a stale lock from a dead process is taken over. Pinned by the Task 7 lock tests.

---

## File Structure

**SDK (`packages/sdk/src`)**
- `validate.ts` (new): `WireFormatError`, `decodeWire`, and `parse*` shape validators for everything that crosses a transport.
- `wire.ts` (modify):
  - `RelaySigner`;
  - relay-join digest, sign and verify;
  - `LobbyClient.watch`;
  - `RelayClient.join(channelId, params, signer)` and `RelayClient.onJoined`.
- `session.ts` (modify): `receive` returns `"duplicate"`/`"stale"` for re-sent messages (M5).
- `hub.ts` (modify):
  - `disputeEvents(id, from, to)`;
  - `hubEvents(from, to)`;
  - the `HubEvent` type;
  - `chunkRanges`.
- `abiCodec.ts` (modify): `decodeParams`.
- `tx.ts` (modify): `SerialTxSender`.
- `index.ts` (modify): export `validate.ts`.

**CLI (`packages/cli/src`)**
- `daemon.ts` (modify):
  - cursor scan;
  - `onJoined` re-send;
  - serialized senders;
  - `acceptOffer` guard;
  - `lobby.watch` at start.
- `records.ts` (modify): `ChannelRecord.scannedBlock`.
- `config.ts` (modify): `ArenaConfig.logChunkBlocks?`.
- `host.ts` (new): `connectHost(serverUrl, opts)` returns `{ lobby, relay, close, connected }` over `fetch` plus the global `WebSocket`.
- `lock.ts` (new): `acquireHomeLock(home)`.
- `run.ts` (new): `startDaemonProcess(home, opts)`, which runs lock → transports → daemon → API.
- `cli.ts` (modify): `arena daemon [start]`; `arena init --server URL` fills chain config from `/templates`.
- `test/helpers/memoryArena.ts` (modify): new interface members.

**Server (`apps/server`)**
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `bin/arena-server.mjs`, `README.md`.
- `src/config.ts`: `ServerConfig`, `Limits`, `DEFAULT_LIMITS`, `parseServerConfig`.
- `src/chain.ts`: `ChainReader`, `RpcChainReader`.
- `src/repo.ts`: `Repo` interface and `SqliteRepo`.
- `src/limits.ts`: `RateLimiter` (token bucket).
- `src/lobby.ts`: `Lobby` service (post/list/accept, match fan-out).
- `src/relay.ts`: `Relay` service (join auth, forward, cache, replay).
- `src/ws.ts`: WebSocket connection handling and frame dispatch.
- `src/indexer.ts`: `Indexer` (chunked cursor over hub events) and `playerStats`.
- `src/docs.ts`: `skill.md`, `llms.txt`, chess `skill.md`, and the `/` and `/watch/:id` HTML.
- `src/server.ts`: `startServer(cfg, deps)` wires the http routes, WebSocket upgrade, services and metrics.
- `src/main.ts`: CLI entry (`--config file.json` plus flag overrides).
- `test/helpers/fakeChain.ts`, `test/*.test.ts`.

---

### Task 1: SDK — transport contracts, validators, re-send tolerance, hub scans, serialized sender

**Files:**
- Create: `packages/sdk/src/validate.ts`, `packages/sdk/test/validate.test.ts`
- Modify:
  - `packages/sdk/src/wire.ts`;
  - `packages/sdk/src/session.ts:288-318` (`receive`);
  - `packages/sdk/src/hub.ts:155-190` (`disputeEvents`) plus new methods;
  - `packages/sdk/src/abiCodec.ts`;
  - `packages/sdk/src/tx.ts`;
  - `packages/sdk/src/index.ts`;
  - `packages/sdk/test/wire.test.ts`;
  - `packages/sdk/test/session.test.ts`;
  - `packages/sdk/test/lifecycle.test.ts` (hub scans; it already runs against Anvil).
- Modify (compile-compat only): `packages/cli/src/daemon.ts:389` and `packages/cli/test/helpers/memoryArena.ts`.

**Interfaces:**
- Consumes: the existing `offerId`, `acceptanceDigest`, `verifyOffer`, `verifyAcceptance`, `fromWire`, `hashState`, `channelId`, `decodeSignedState`, `channelHubAbi`.
- Produces (exact):

```ts
// wire.ts
export type RelaySigner = { readonly address: Address; signMessage(args: { message: { raw: Hex } }): Promise<Hex> };
export function relayJoinDigest(channelId: Hex, nonce: Hex): Hex;
export function signRelayJoin(signer: RelaySigner, channelId: Hex, nonce: Hex): Promise<Hex>;
export function verifyRelayJoin(channelId: Hex, nonce: Hex, signer: Address, sig: Hex): Promise<boolean>;
export interface LobbyClient {
  postOffer(so: SignedOffer): Promise<Hex>;
  listOffers(): Promise<SignedOffer[]>;
  accept(sa: SignedAcceptance): Promise<void>;
  onMatch(handler: (m: MatchEvent) => void): () => void;
  /** Ask the host to deliver match events for these offers, including ones matched while this client was away. */
  watch(offerIds: Hex[]): void;
}
export interface RelayClient {
  /** Joins the channel as `signer` (one of params.signers). The private key never reaches the transport (I5). */
  join(channelId: Hex, params: Params, signer: RelaySigner): Promise<void>;
  send(msg: RelayMessage): Promise<void>;
  onMessage(handler: (msg: RelayMessage) => void): () => void;
  /** Fires every time the host confirms membership of a channel: after the first join and after each reconnect. */
  onJoined(handler: (channelId: Hex) => void): () => void;
}

// validate.ts
export class WireFormatError extends Error {}
export function decodeWire(text: string): unknown;          // fromWire; any failure → WireFormatError
export function parseParams(x: unknown): Params;
export function parseState(x: unknown): State;
export function parseSignedState(x: unknown): SignedState;
export function parseCloseSignature(x: unknown): CloseSignature;
export function parseRelayMessage(x: unknown): RelayMessage;
export function parseMatchEvent(x: unknown): MatchEvent;
export function parseSignedOffer(x: unknown): SignedOffer;
export function parseSignedAcceptance(x: unknown): SignedAcceptance;

// session.ts
receive(msg: SignedState): Promise<"move" | "checkpoint-proposed" | "checkpoint-complete" | "checkpoint-repaired" | "duplicate" | "stale">;

// hub.ts
export type HubEvent = { blockNumber: bigint; logIndex: number; channelId: Hex } & (
  | { kind: "ChannelCreated"; params: Params }
  | { kind: "Deposited"; player: PlayerIndex; amount: bigint }
  | { kind: "Opened" }
  | { kind: "Challenged"; challenger: PlayerIndex; turnNum: bigint; deadline: bigint; signed: SignedState }
  | { kind: "Responded"; turnNum: bigint; signed: SignedState }
  | { kind: "Finalized"; balanceA: bigint; balanceB: bigint; fee: bigint }
  | { kind: "Reclaimed" }
);
export function chunkRanges(fromBlock: bigint, toBlock: bigint, size: bigint): Array<{ fromBlock: bigint; toBlock: bigint }>;
// HubClient
disputeEvents(id: Hex, fromBlock?: bigint, toBlock?: bigint): Promise<DisputeEvent[]>; // toBlock omitted → head (cacheTime 0), as today
hubEvents(fromBlock: bigint, toBlock: bigint): Promise<HubEvent[]>;                   // all channels, chain order
blockNumber(): Promise<bigint>;                                                        // getBlockNumber({ cacheTime: 0 })

// abiCodec.ts
export function decodeParams(data: Hex): Params;

// tx.ts
export class SerialTxSender implements TxSender { constructor(inner: TxSender); readonly address: Address; send(tx): Promise<Hex>; }
```

- [ ] **Step 1: Write the failing validator tests** (`packages/sdk/test/validate.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  WireFormatError, decodeWire, parseMatchEvent, parseRelayMessage, parseSignedAcceptance, parseSignedOffer, toWire,
  relayJoinDigest, signRelayJoin, verifyRelayJoin,
} from "../src/index.js";
import { sampleParams, sampleSignedState } from "./helpers/fixtures.js";

describe("wire validators", () => {
  it("round-trips a state message through toWire/decodeWire/parseRelayMessage", () => {
    const msg = { type: "state" as const, channelId: sampleSignedState.state.channelId, signed: sampleSignedState };
    expect(parseRelayMessage(decodeWire(toWire(msg)))).toEqual(msg);
  });
  it("drops unknown keys and rebuilds objects", () => {
    const msg = { type: "state", channelId: sampleSignedState.state.channelId, signed: { ...sampleSignedState, extra: 1 }, junk: true };
    const parsed = parseRelayMessage(decodeWire(toWire(msg)));
    expect(Object.keys(parsed).sort()).toEqual(["channelId", "signed", "type"]);
    expect(Object.keys(parsed.type === "state" ? parsed.signed : {}).sort()).toEqual(["sigA", "sigB", "state"]);
  });
  it.each([
    ["not json", "{"],
    ["bad bigint", '{"$bigint":"12x"}'],
  ])("decodeWire rejects %s with WireFormatError", (_n, text) => {
    expect(() => decodeWire(text)).toThrow(WireFormatError);
  });
  it.each([
    ["wrong type tag", { type: "hello" }],
    ["state channelId mismatch", { type: "state", channelId: `0x${"11".repeat(32)}`, signed: sampleSignedState }],
    ["turnNum as number", { type: "state", channelId: sampleSignedState.state.channelId, signed: { ...sampleSignedState, state: { ...sampleSignedState.state, turnNum: 1 } } }],
    ["sig not hex", { type: "state", channelId: sampleSignedState.state.channelId, signed: { ...sampleSignedState, sigA: "zz" } }],
    ["close by 2", { type: "close", channelId: sampleSignedState.state.channelId, close: { stateHash: `0x${"00".repeat(32)}`, by: 2, sig: "0x" } }],
  ])("parseRelayMessage rejects %s", (_n, x) => {
    expect(() => parseRelayMessage(x)).toThrow(WireFormatError);
  });
  it("parseMatchEvent requires two-element participant/signer tuples and bigint amounts", () => {
    expect(parseMatchEvent({ offerId: `0x${"ab".repeat(32)}`, params: sampleParams })).toEqual({ offerId: `0x${"ab".repeat(32)}`, params: sampleParams });
    expect(() => parseMatchEvent({ offerId: `0x${"ab".repeat(32)}`, params: { ...sampleParams, participants: [sampleParams.participants[0]] } })).toThrow(WireFormatError);
    expect(() => parseMatchEvent({ offerId: `0x${"ab".repeat(32)}`, params: { ...sampleParams, deposit: "5" } })).toThrow(WireFormatError);
  });
  it("parseSignedOffer only accepts the chess template", () => {
    const offer = { template: "go", player: sampleParams.participants[0], signer: sampleParams.signers[0], deposit: 1n, stakePerGame: 1n, challengeTimeout: 600n, expiresAt: 1n, nonce: `0x${"01".repeat(32)}` };
    expect(() => parseSignedOffer({ offer, sig: "0x" })).toThrow(WireFormatError);
    expect(parseSignedOffer({ offer: { ...offer, template: "chess" }, sig: "0x" }).offer.template).toBe("chess");
  });
  it("parseSignedAcceptance rejects a non-canonical offerId", () => {
    const acceptance = { offerId: "./0x" + "ab".repeat(32), player: sampleParams.participants[1], signer: sampleParams.signers[1], nonce: `0x${"02".repeat(32)}` };
    expect(() => parseSignedAcceptance({ acceptance, sig: "0x" })).toThrow(WireFormatError);
  });
});

describe("relay join signature", () => {
  it("verifies only for the signing key, channel and nonce", async () => {
    const acct = privateKeyToAccount(generatePrivateKey());
    const ch = `0x${"cd".repeat(32)}` as const;
    const nonce = `0x${"ef".repeat(32)}` as const;
    const sig = await signRelayJoin(acct, ch, nonce);
    expect(await verifyRelayJoin(ch, nonce, acct.address, sig)).toBe(true);
    expect(await verifyRelayJoin(ch, `0x${"00".repeat(32)}`, acct.address, sig)).toBe(false);
    expect(await verifyRelayJoin(`0x${"00".repeat(32)}`, nonce, acct.address, sig)).toBe(false);
    expect(await verifyRelayJoin(ch, nonce, acct.address, "0x1234")).toBe(false);
    expect(relayJoinDigest(ch, nonce)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
```

If `test/helpers/fixtures.ts` has no `sampleParams`/`sampleSignedState`, add them there. Build them with the existing helpers: a `Params` with two distinct random participants and signers, and an initial state `initialState(channelId(31337, hub, params), params)` signed by `signers[0]`'s key using `signState`. Export both.

- [ ] **Step 2: Run to verify the tests fail**

Run: `pnpm --filter @arena/sdk exec vitest run test/validate.test.ts`
Expected: FAIL (missing exports).

- [ ] **Step 3: Implement `validate.ts`**

Rules (all failures throw `WireFormatError` with a short message that names the field path, e.g. `params.deposit must be a bigint`):

- `decodeWire(text)`: `try { return fromWire(text) } catch (e) { throw new WireFormatError(...) }`. It also rejects `typeof text !== "string"`.
- Primitive checks:
  - `hex32`: `/^0x[0-9a-f]{64}$/i`. The value is returned **lower-cased** for ids used as keys (`offerId`, `channelId`, `stateHash`, `salt`, `nonce`, `prevHash`).
  - `address`: `/^0x[0-9a-fA-F]{40}$/`, returned as given.
  - `sig`: `/^0x([0-9a-fA-F]{2}){0,1024}$/`.
  - `uint`: `typeof v === "bigint" && v >= 0n && v < 2n ** 256n`.
  - `uint64`: the same, below `2n ** 64n`.
  - `small`: a safe non-negative integer `number` (for `gameIndex`, `move` ≤ `2 ** 32 - 1`).
  - `pair`: an array of length exactly 2.
- `parseState` rebuilds `{ channelId, turnNum(uint64), prevHash, balanceA(uint), balanceB(uint), gameIndex(small), move(small), board(uint), meta(uint) }`.
- `parseSignedState` rebuilds `{ state, sigA, sigB }`.
- `parseParams` rebuilds all ten fields:
  - `participants`/`signers` are `pair` of `address`;
  - `feePerPlayer`, `deposit`, `stakePerGame` are `uint`;
  - `challengeTimeout` and `fundingDeadline` are `uint64`;
  - `salt` is `hex32`.
- `parseCloseSignature` returns `{ stateHash(hex32), by: 0|1, sig }`.
- `parseRelayMessage` requires `type ∈ {"state","close"}`:
  - for `"state"`, it also requires `signed.state.channelId === channelId` (after lower-casing);
  - the result is `{ type, channelId, signed }` or `{ type, channelId, close }`.
- `parseMatchEvent` returns `{ offerId(hex32), params }`.
- `parseSignedOffer` returns `{ offer: { template:"chess" (exact), player, signer, deposit(uint), stakePerGame(uint), challengeTimeout(uint64), expiresAt(uint64), nonce(hex32) }, sig }`.
- `parseSignedAcceptance` returns `{ acceptance: { offerId(hex32), player, signer, nonce(hex32) }, sig }`.

Export everything from `src/index.ts` (`export * from "./validate.js";`).

- [ ] **Step 4: Implement the relay-join helpers and interface changes in `wire.ts`**

```ts
export type RelaySigner = { readonly address: Address; signMessage(args: { message: { raw: Hex } }): Promise<Hex> };

/** What a session key signs to join a channel on the relay: bound to the channel and to this connection's nonce. */
export function relayJoinDigest(channelId: Hex, nonce: Hex): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }], ["arena-relay-join", channelId, nonce]),
  );
}

export function signRelayJoin(signer: RelaySigner, channelId: Hex, nonce: Hex): Promise<Hex> {
  return signer.signMessage({ message: { raw: relayJoinDigest(channelId, nonce) } });
}

export async function verifyRelayJoin(channelId: Hex, nonce: Hex, signer: Address, sig: Hex): Promise<boolean> {
  try {
    const who = await recoverMessageAddress({ message: { raw: relayJoinDigest(channelId, nonce) }, signature: sig });
    return who.toLowerCase() === signer.toLowerCase();
  } catch {
    return false;
  }
}
```

Replace the `LobbyClient` and `RelayClient` interfaces with the versions in **Interfaces** above. Update their doc comments: "Plan 4 implements it in packages/cli/src/host.ts".

- [ ] **Step 5: Keep the CLI compiling** (compat only, no behavior change)

- `packages/cli/src/daemon.ts:389`: `await this.opts.relay.join(record.channelId, record.params, privateKeyToAccount(record.sessionKey));`
- `packages/cli/test/helpers/memoryArena.ts`:
  - the lobby gains `watch: () => undefined`;
  - the member gains `joinedHandlers: Set<(id: Hex) => void>`;
  - `join` adds the room and then `setTimeout(() => { for (const h of member.joinedHandlers) h(channelId); }, 0)`;
  - `onJoined` registers into `joinedHandlers` and returns the unsubscribe;
  - `reconnect()` sets `connected = true` and then fires every joined handler for every room (`setTimeout` 0). That simulates the real transport's re-join.

- [ ] **Step 6: Write the failing session tests for re-sent messages (M5)** in `packages/sdk/test/session.test.ts`

Use the file's existing two-session helpers (look for how existing tests create `alice`/`bob` sessions over a `MemoryStore` and exchange moves). Add:

```ts
describe("re-sent messages (M5)", () => {
  it("an exact duplicate of latest is a no-op", async () => {
    const { alice, bob } = await openPair();
    const m1 = await alice.move("e4");
    expect(await bob.receive(m1)).toBe("move");
    const before = bob.snapshot();
    expect(await bob.receive(m1)).toBe("duplicate");
    expect(bob.snapshot()).toEqual(before);
  });
  it("an older state is stale and ignored", async () => {
    const { alice, bob } = await openPair();
    const m1 = await alice.move("e4");
    await bob.receive(m1);
    const m2 = await bob.move("e5");
    await alice.receive(m2);
    const m3 = await alice.move("Nf3");
    await bob.receive(m3);
    expect(await bob.receive(m1)).toBe("stale");
  });
  it("a different state for the latest turn is still an error", async () => {
    const { alice, bob, aliceKeyedFork } = await openPairWithFork(); // a second session with Alice's key and store copy
    const m1 = await alice.move("e4");
    await bob.receive(m1);
    const conflicting = await aliceKeyedFork.move("d4");
    await expect(bob.receive(conflicting)).rejects.toThrow(/conflicting state for turn 1/);
  });
  it("a re-sent new-game proposal the player already holds is a duplicate", async () => {
    // play to a terminal state with the existing helpers (e.g. resign), then:
    const proposal = await alice.proposeNewGame();
    expect(await bob.receive(proposal)).toBe("checkpoint-proposed");
    expect(await bob.receive(proposal)).toBe("duplicate");
  });
  it("a duplicate is still a no-op after this player signed Close", async () => {
    // terminal state reached via resign (bob receives alice's resign), then bob signs close:
    await bob.signClose();
    expect(await bob.receive(resignState)).toBe("duplicate");
  });
});
```

Adapt the helper names (`openPair`, `openPairWithFork`, `resignState`) to what exists in the file. If there is no fork helper, create one: a `ChannelSession.open` with Alice's config over a copied `MemoryStore` snapshot taken before her `e4`.

- [ ] **Step 7: Implement M5 in `session.ts`**

Inside `receive`'s lock, **before** the `closeState !== null` check, call a synchronous `classifyRepeat(this.data, msg)`. If it returns `"duplicate"` or `"stale"`, return that without saving. Otherwise, continue exactly as today.

```ts
/**
 * M5: a message this player already holds, or one older than its latest, arrives again after a relay reconnect
 * (both daemons re-send their latest). Neither changes anything, so neither is an error. A *different* state at the
 * latest turn still is (equivocation evidence). Returns null for everything else, which then takes the normal path,
 * including the late-countersignature repair of `prev`, which must win over "stale".
 */
private classifyRepeat(data: SessionSnapshot, msg: SignedState): "duplicate" | "stale" | null {
  let s: State;
  try {
    s = this.canonicalState(structuredClone(msg).state);
  } catch {
    return null;
  }
  if (s.channelId !== this.id) return null;
  const prev = data.prev;
  if (prev && isCheckpoint(prev.state) && !this.endorsed(prev) && s.turnNum === prev.state.turnNum) return null;
  const latest = data.latest.state;
  const h = hashState(s, this.domain);
  if (s.turnNum < latest.turnNum) return "stale";
  if (s.turnNum === latest.turnNum) {
    if (h === hashState(latest, this.domain)) return "duplicate";
    throw new ArenaProtocolError(`conflicting state for turn ${s.turnNum}`);
  }
  const incoming = data.incomingCheckpoint;
  if (incoming && s.turnNum === incoming.state.turnNum && h === hashState(incoming.state, this.domain)) return "duplicate";
  return null;
}
```

`canonicalState` already exists (it is used by `ingestOnChain`). If its name differs, use the same helper `ingestOnChain` uses. The throw must go through the lock's normal rejection path, so wrap the call in `this.asProtocolError` the way `classifyIncoming` is wrapped. Update the `receive` return type and its docstring.

Also make `receiveClose` of a signature this player already holds (same `by`, same `sig`, same target) return early without re-saving. Add a test: calling it twice leaves `snapshot()` unchanged and does not throw.

- [ ] **Step 8: Hub scans — tests first** (append to `packages/sdk/test/lifecycle.test.ts`, which already opens and disputes a channel on Anvil; reuse its setup)

```ts
it("chunkRanges splits inclusive ranges", () => {
  expect(chunkRanges(10n, 12n, 2n)).toEqual([{ fromBlock: 10n, toBlock: 11n }, { fromBlock: 12n, toBlock: 12n }]);
  expect(chunkRanges(5n, 4n, 10n)).toEqual([]);
  expect(() => chunkRanges(0n, 1n, 0n)).toThrow();
});
it("hubEvents decodes every hub event of a challenged-then-closed channel in chain order", async () => {
  // after the existing lifecycle scenario that creates, funds, challenges, responds and finalizes a channel:
  const events = await hub.hubEvents(0n, await hub.blockNumber());
  const kinds = events.filter((e) => e.channelId === id).map((e) => e.kind);
  expect(kinds[0]).toBe("ChannelCreated");
  expect(kinds).toContain("Deposited");
  expect(kinds).toContain("Opened");
  expect(kinds.at(-1)).toMatch(/Finalized|Reclaimed/);
  const created = events.find((e) => e.kind === "ChannelCreated" && e.channelId === id);
  expect(created && created.kind === "ChannelCreated" && created.params).toEqual(params);
});
it("disputeEvents honours an explicit toBlock", async () => {
  const all = await hub.disputeEvents(id, 0n);
  const first = all[0];
  expect(await hub.disputeEvents(id, 0n, first.blockNumber - 1n)).toEqual([]);
});
```

Adapt `hub`, `id`, `params` to the file's variable names. If no lifecycle test both challenges and finalizes, add assertions to whichever existing test comes closest, and only check the kinds it produces.

- [ ] **Step 9: Implement the hub scans**
  - `abiCodec.ts`:

    ```ts
    export function decodeParams(data: Hex): Params {
      const [p] = decodeAbiParameters([{ type: "tuple", components: PARAMS }], data);
      return { ...p, participants: [p.participants[0], p.participants[1]], signers: [p.signers[0], p.signers[1]] };
    }
    ```

  - `hub.ts`:
    - `chunkRanges` throws for `size <= 0n` and returns `[]` when `fromBlock > toBlock`.
    - `disputeEvents(id, fromBlock = 0n, toBlock?)` uses `toBlock ?? await this.client.getBlockNumber({ cacheTime: 0 })`.
    - `blockNumber()` returns `getBlockNumber({ cacheTime: 0 })`.
    - `hubEvents(from, to)` calls `this.client.getContractEvents({ address: this.hub, abi: channelHubAbi, fromBlock: from, toBlock: to })` with no `eventName`, so it returns all events. It maps each log by `eventName` into the `HubEvent` union:
      - `ChannelCreated.params` goes through `decodeParams`;
      - `Challenged`/`Responded` `signedState` goes through `decodeSignedState`;
      - `player`/`challenger` go through `Number(...) as PlayerIndex`.
    - It skips events without a `channelId` arg (`PayoutDeferred`, `Claimed`, `FeeUpdated`, OZ `Ownership*`) and sorts by `(blockNumber, logIndex)`.

- [ ] **Step 10: `SerialTxSender`** — test (`packages/sdk/test/wire.test.ts` or a new `tx.test.ts`):

```ts
it("SerialTxSender never runs two sends at once and keeps going after a failure", async () => {
  let active = 0, peak = 0, n = 0;
  const inner = { address: "0x0000000000000000000000000000000000000001" as const, send: async () => {
    active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--;
    if (++n === 2) throw new Error("boom");
    return `0x${n.toString(16).padStart(64, "0")}` as const;
  } };
  const s = new SerialTxSender(inner);
  const results = await Promise.allSettled([1, 2, 3].map(() => s.send({ to: inner.address, data: "0x" })));
  expect(peak).toBe(1);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  expect(s.address).toBe(inner.address);
});
```

Implementation:

```ts
/**
 * Runs one send at a time per wallet, so two concurrent callers (funding two channels, a close racing a top-up) never
 * fetch the same pending nonce. A send is finished once the node has accepted the transaction (hash returned).
 */
export class SerialTxSender implements TxSender {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly inner: TxSender) {}
  get address(): Address {
    return this.inner.address;
  }
  send(tx: { to: Address; data: Hex; value?: bigint }): Promise<Hex> {
    const run = this.tail.then(() => this.inner.send(tx));
    this.tail = run.catch(() => undefined);
    return run;
  }
}
```

- [ ] **Step 11: Run all SDK and CLI tests and typecheck**

Run: `pnpm --filter @arena/sdk test && pnpm --filter @arena/sdk typecheck && pnpm --filter @arena/cli test && pnpm --filter @arena/cli typecheck`
Expected: all pass (SDK 87 + new, CLI 53).

- [ ] **Step 12: Commit**

```bash
git add packages/sdk packages/cli/src/daemon.ts packages/cli/test/helpers/memoryArena.ts
git commit -m "feat(sdk): transport validators, signer-based relay join, re-send tolerance, hub event scans, serial sender"
```

---

### Task 2: Daemon — chunked cursor scan (I3), reconnect re-send, serialized senders, accept guard

**Files:**
- Modify:
  - `packages/cli/src/daemon.ts` (constructor :105-119, `start` :123, `acceptOffer` :222, `openChannel` :367-396, `watch` :628-642);
  - `packages/cli/src/records.ts` (`ChannelRecord`);
  - `packages/cli/src/config.ts` (`ArenaConfig`).
- Test: `packages/cli/test/daemon.test.ts`, `packages/cli/test/hardening.test.ts`, and a new `packages/cli/test/reconnect.test.ts`.

**Interfaces:**
- Consumes (Task 1):
  - `RelayClient.join(channelId, params, signer)`, `RelayClient.onJoined`, `LobbyClient.watch`;
  - `SerialTxSender`;
  - `HubClient.disputeEvents(id, from, to)`, `HubClient.blockNumber()`, `chunkRanges`;
  - the `receive` results `"duplicate" | "stale"`.
- Produces:
  - `ArenaConfig.logChunkBlocks?: number` (default `DEFAULT_LOG_CHUNK_BLOCKS = 1000`, exported from `config.ts`);
  - `ChannelRecord.scannedBlock?: bigint`, the last block whose dispute events have all been ingested;
  - `ArenaDaemon.wallet: SerialTxSender`;
  - `ChannelHandle.sessionSender: SerialTxSender`;
  - `ChannelHandle.processedEvents`, which keeps its meaning (dispute events successfully ingested since start).

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/reconnect.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { startPair, waitFor } from "./helpers/harness.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function openChannel() {
  const pair = await startPair();
  cleanup = pair.cleanup;
  const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
  await pair.bob.daemon.acceptOffer(offerId);
  const id = await waitFor(() => pair.alice.daemon.channelIds()[0], 20_000, "match");
  await waitFor(async () => (await pair.alice.daemon.status(id)).phase === "Open", 30_000, "open");
  return { ...pair, id };
}

describe("relay reconnect", () => {
  it("a move sent while the sender was disconnected is delivered after it reconnects", async () => {
    const { alice, bob, id } = await openChannel();
    alice.client.disconnect();
    await alice.daemon.move(id, "e4", { actor: "agent" }); // relay send fails; state is persisted
    expect(bob.daemon.handle(id).session.latest.state.turnNum).toBe(0n);
    alice.client.reconnect(); // fires onJoined → daemon re-sends its latest
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob receives e4");
  });

  it("re-sent states after a reconnect never set lastError on the receiver", async () => {
    const { alice, bob, id } = await openChannel();
    await alice.daemon.move(id, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    await bob.daemon.move(id, "e5", { actor: "agent" });
    await waitFor(() => alice.daemon.handle(id).session.isMyTurn(), 5_000, "alice turn");
    alice.client.reconnect(); // Alice re-sends e4 (stale for Bob)
    bob.client.reconnect();   // Bob re-sends e5 (duplicate for Alice)
    await new Promise((r) => setTimeout(r, 300));
    expect(alice.daemon.handle(id).lastError).toBeNull();
    expect(bob.daemon.handle(id).lastError).toBeNull();
  });

  it("re-sends its Close signature on reconnect so a lost close still completes", async () => {
    const { alice, bob, id } = await openChannel();
    await alice.daemon.move(id, "e4", { actor: "agent", offerDraw: true });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    await bob.daemon.acceptDraw(id, "agent");
    await waitFor(async () => (await alice.daemon.status(id)).attention === "game-over", 5_000, "draw seen");
    bob.client.disconnect();
    await alice.daemon.close(id, "agent"); // Alice's close message is lost (Bob is disconnected)
    bob.client.reconnect();                 // Bob's re-join replays nothing from Alice…
    alice.client.reconnect();               // …but Alice's re-join re-sends her latest + Close
    await waitFor(async () => (await bob.daemon.status(id)).attention === "close-requested", 5_000, "close requested");
    await bob.daemon.close(id, "agent");
    await waitFor(async () => (await alice.daemon.status(id)).phase === "Finalized", 20_000, "finalized");
  });
});
```

Add to `packages/cli/test/hardening.test.ts`:

```ts
it("concurrent acceptOffer calls for one offer create exactly one acceptance (M-carry)", async () => {
  const pair = await startPair();
  cleanup = pair.cleanup;
  const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
  const results = await Promise.allSettled([pair.bob.daemon.acceptOffer(offerId), pair.bob.daemon.acceptOffer(offerId)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(String(rejected.reason)).toMatch(/already being accepted|already accepted/);
});

it("scans dispute events in chunks from a persisted cursor and survives a getLogs failure (I3)", async () => {
  const pair = await startPair({ bobConfig: { logChunkBlocks: 2 } });
  cleanup = pair.cleanup;
  const { alice, bob } = pair;
  const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
  await bob.daemon.acceptOffer(offerId);
  const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
  await waitFor(async () => (await alice.daemon.status(id)).phase === "Open", 30_000, "open");
  bob.client.disconnect(); // Bob never sees e4 over the relay; only through the Challenged event
  await alice.daemon.move(id, "e4", { actor: "agent" });
  await alice.daemon.challenge(id, "agent");
  // A getLogs failure must not stop the rest of the watchtower pass.
  const hub = bob.daemon.hub;
  const real = hub.disputeEvents.bind(hub);
  let failures = 1;
  hub.disputeEvents = (...a: Parameters<typeof real>) => (failures-- > 0 ? Promise.reject(new Error("range too large")) : real(...a));
  await bob.daemon.idle();
  await bob.daemon.tick();
  expect(bob.daemon.handle(id).lastError).toMatch(/^events:/);
  await waitFor(async () => { await bob.daemon.idle(); await bob.daemon.tick(); return bob.daemon.handle(id).session.isMyTurn(); }, 20_000, "ingested e4 from chain");
  const rec = bob.daemon.handle(id).record;
  expect(rec.scannedBlock).toBeDefined();
  expect(rec.scannedBlock! >= rec.createdBlock).toBe(true);
});
```

In `daemon.test.ts`, the existing test at :279 (`processedEvents` stays 0 while ingest keeps failing) must keep passing unchanged. The new cursor must not advance past the failing event.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @arena/cli exec vitest run test/reconnect.test.ts test/hardening.test.ts`
Expected: FAIL (no re-send on `onJoined`, no guard, no cursor).

- [ ] **Step 3: Config and record fields**
  - `config.ts`:
    - add `logChunkBlocks?: number` to `ArenaConfig`;
    - add `export const DEFAULT_LOG_CHUNK_BLOCKS = 1000;`.
  - `records.ts`: add `/** I3: last block whose dispute events have all been ingested; absent = none scanned yet. */ scannedBlock?: bigint;` to `ChannelRecord`.

- [ ] **Step 4: Serialized senders**
  - In the constructor, set `this.wallet = new SerialTxSender(new LocalKeyTxSender(opts.walletKey, c.rpcUrl, this.chain));` and change the field type to `SerialTxSender`.
  - In `openChannel`, set `sessionSender: new SerialTxSender(new LocalKeyTxSender(record.sessionKey, ...))` and change `ChannelHandle.sessionSender` to `SerialTxSender`.
  - Replace uses of `this.wallet.address` / `l.sessionSender.address` unchanged (the getter forwards).

- [ ] **Step 5: Re-send on join (reconnect hook)**
  - In `start()`, register `this.unsubscribers.push(this.opts.relay.onJoined((id) => void this.onJoined(id)));` next to the other subscriptions.
  - After the channel loop, call `this.opts.lobby.watch(this.records.offers().map((o) => o.offerId));` so matches made while this daemon was down are replayed.
  - In `createOffer` and `acceptOffer`, call `this.opts.lobby.watch([id])` after the offer or acceptance is sent.
  - Remove the "re-send our latest own state" block from `openChannel` (:390-395). `onJoined` now does it for the first join and for every reconnect:

```ts
/** §7 relay reconnect: re-send this player's latest own-signed state and its Close signature, if any. */
private async onJoined(id: Hex): Promise<void> {
  if (this.stopped) return;
  const l = this.live.get(id);
  if (!l || l.record.finalized) return;
  const snap = l.session.snapshot();
  const me = l.record.me;
  const latest = snap.latest;
  const mine = me === 0 ? latest.sigA : latest.sigB;
  try {
    if (latest.state.turnNum > 0n && mine !== "0x") await this.opts.relay.send({ type: "state", channelId: id, signed: latest });
    const closeSig = snap.closeSigs[me];
    if (closeSig !== "0x") {
      await this.opts.relay.send({ type: "close", channelId: id, close: { stateHash: snap.closeSigTargets[me], by: me, sig: closeSig } });
    }
  } catch (err) {
    l.lastError = `relay: ${errorText(err)}`;
  }
}
```

Check the snapshot field names in `session.ts` (`closeSigs`, `closeSigTargets`) before use. A pending own checkpoint proposal (`snap.pendingCheckpoint`) is also re-sent when present, after `latest`: the opponent may have missed the proposal.

- [ ] **Step 6: `onRelay` treats `"duplicate"`/`"stale"` as success.** `receive` already returns them without throwing. Keep `l.lastError = null` on that path, and skip `autoPlay` for them.

- [ ] **Step 7: Concurrent `acceptOffer` guard**
  - Add `private readonly accepting = new Set<Hex>();`.
  - After the canonical-id check, run `if (this.accepting.has(offerId)) throw new DaemonError(409, \`offer ${offerId} is already being accepted\`); this.accepting.add(offerId); try { …existing body… } finally { this.accepting.delete(offerId); }`.

- [ ] **Step 8: Chunked cursor scan.** Replace the watch step 2 (:628-642):

```ts
// 2. Adopt on-chain states from dispute events (I3): scan forward from the persisted cursor in bounded chunks (real
// RPCs cap getLogs ranges), ingest in order, and never move the cursor past an event that failed to ingest.
// ingestOnChain ignores states it already holds, so re-reading a partly ingested block is harmless.
if (this.stopped) return;
await this.scanDisputes(l);
```

```ts
private async scanDisputes(l: ChannelHandle): Promise<void> {
  const id = l.record.channelId;
  const size = BigInt(this.opts.config.logChunkBlocks ?? DEFAULT_LOG_CHUNK_BLOCKS);
  let cursor = l.record.scannedBlock ?? l.record.createdBlock - 1n;
  try {
    const head = await this.hub.blockNumber();
    // At most 50 chunks per tick, so a long-dormant channel catches up over a few ticks without starving the others.
    for (const r of chunkRanges(cursor + 1n, head, size).slice(0, 50)) {
      if (this.stopped) break;
      const events = await this.hub.disputeEvents(id, r.fromBlock, r.toBlock);
      for (const e of events) {
        try {
          await l.session.ingestOnChain(e.signed);
          l.processedEvents++;
        } catch (err) {
          l.lastError = `ingest: ${errorText(err)}`;
          this.saveCursor(l, e.blockNumber - 1n);
          return;
        }
      }
      cursor = r.toBlock;
      this.saveCursor(l, cursor);
    }
  } catch (err) {
    l.lastError = `events: ${errorText(err)}`;
  }
}

private saveCursor(l: ChannelHandle, block: bigint): void {
  if (l.record.scannedBlock === block) return;
  l.record = { ...l.record, scannedBlock: block };
  this.records.saveChannel(l.record);
}
```

`processedEvents` now counts events ingested successfully, including re-reads that return `false`. The existing `:279` test asserts `0` while ingest always fails, and that still holds. Import `chunkRanges` from `@arena/sdk` and `DEFAULT_LOG_CHUNK_BLOCKS` from `./config.js`.

- [ ] **Step 9: Run the CLI tests**

Run: `pnpm --filter @arena/cli test && pnpm --filter @arena/cli typecheck`
Expected: all pass (53 existing + 5 new).

- [ ] **Step 10: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): chunked cursor dispute scan, re-send on relay join, serialized senders, accept guard"
```

---

### Task 3: Server foundation — package, config, repository, rate limiter, HTTP skeleton, registry and agent docs

**Files:**
- Create:
  - `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/vitest.config.ts`, `apps/server/bin/arena-server.mjs`;
  - `apps/server/src/config.ts`, `apps/server/src/chain.ts`, `apps/server/src/repo.ts`, `apps/server/src/limits.ts`, `apps/server/src/docs.ts`, `apps/server/src/server.ts`, `apps/server/src/main.ts`;
  - `apps/server/test/helpers/fakeChain.ts`, `apps/server/test/foundation.test.ts`.
- Modify: root `package.json` (add `"test:server": "pnpm --filter @arena/server test"`), `.gitignore` (add `*.db`, `*.db-wal`, `*.db-shm`).

**Interfaces:**
- Consumes: `@arena/sdk` (`toWire`, `HubClient`, `HubEvent`, `channelHubAbi`).
- Produces:

```ts
// config.ts
export type Limits = {
  httpPostBurst: number; httpPostPerSec: number; httpGetBurst: number; httpGetPerSec: number;
  wsPerIp: number; wsFrameBurst: number; wsFramePerSec: number; maxFrameBytes: number;
  maxOpenOffersPerPlayer: number; maxWatchedOffers: number; maxJoinsPerConnection: number;
};
export const DEFAULT_LIMITS: Limits = {
  httpPostBurst: 30, httpPostPerSec: 1, httpGetBurst: 120, httpGetPerSec: 10,
  wsPerIp: 16, wsFrameBurst: 200, wsFramePerSec: 20, maxFrameBytes: 64 * 1024,
  maxOpenOffersPerPlayer: 5, maxWatchedOffers: 256, maxJoinsPerConnection: 64,
};
export type ServerConfig = {
  host: string;            // default "127.0.0.1"
  port: number;            // 0 = ephemeral
  publicUrl: string;       // "" = derived from the bound address after listen
  rpcUrl: string;          // server's own RPC
  publicRpcUrl: string;    // RPC advertised to agents in /templates ("" = rpcUrl)
  chainId: number;
  hub: Address; usdc: Address; rules: Address;
  dbPath: string;          // ":memory:" allowed
  fundingWindow: bigint;   // seconds, default 3600 (must stay ≤ the daemon's 7200 maxFundingWindow)
  offerMaxLifetime: bigint;// seconds, default 86400
  defaults: { deposit: bigint; stakePerGame: bigint; challengeTimeout: bigint }; // default 1_000_000 / 100_000 / 600
  cliCommand: string;      // how agents run the CLI, shown in skill.md; default "arena"
  audit: string;           // shown in /templates; default "unaudited (development build)"
  indexer: { pollMs: number; chunkBlocks: number; startBlock: bigint }; // default 2000 / 1000 / 0; pollMs 0 = manual
  limits: Limits;
};
/** Plain-JSON config (bigints as decimal strings, optional fields defaulted); throws with the offending field name. */
export function parseServerConfig(raw: unknown): ServerConfig;

// chain.ts
export interface ChainReader {
  now(): Promise<bigint>;                        // latest block timestamp (cached ≤ 1 s)
  feeConfig(): Promise<{ feePerPlayer: bigint; feeRecipient: Address }>;
  timeoutBounds(): Promise<{ min: bigint; max: bigint }>; // cached forever (immutable)
  head(): Promise<bigint>;
  hubEvents(fromBlock: bigint, toBlock: bigint): Promise<HubEvent[]>;
}
export class RpcChainReader implements ChainReader { constructor(cfg: Pick<ServerConfig, "rpcUrl" | "chainId" | "hub">); }

// repo.ts
export type ChannelRow = {
  channelId: Hex; params: Params;
  phase: "Funding" | "Open" | "Challenged" | "Finalized" | "Reclaimed";
  createdBlock: bigint;
  challenges: [number, number]; answered: [number, number];
  pendingChallenger: PlayerIndex | null; registered: SignedState | null;
  timeoutLoser: PlayerIndex | null; balances: [bigint, bigint] | null;
};
export type OfferEntry = { signed: SignedOffer; acceptance: SignedAcceptance | null; match: MatchEvent | null };
export interface Repo {
  insertOffer(offerId: Hex, so: SignedOffer): boolean;                 // false if the id exists
  offer(offerId: Hex): OfferEntry | null;
  openOffers(now: bigint): SignedOffer[];                              // unmatched and expiresAt > now, oldest first
  openOfferCount(player: Address, now: bigint): number;               // case-insensitive player
  recordMatch(offerId: Hex, sa: SignedAcceptance, m: MatchEvent): boolean; // false if already matched
  pruneOffers(now: bigint): number;                                    // deletes unmatched offers expired > 1 day ago
  cacheRelay(channelId: Hex, sender: PlayerIndex, message: RelayMessage): void; // keyed by (channelId, sender, message.type)
  cachedRelay(channelId: Hex): Array<{ sender: PlayerIndex; message: RelayMessage }>;
  cursor(): bigint | null;
  setCursor(block: bigint): void;
  channelRow(id: Hex): ChannelRow | null;
  saveChannelRow(row: ChannelRow): void;
  channelRowsFor(player: Address): ChannelRow[];                      // either participant, case-insensitive
  recentChannels(limit: number): ChannelRow[];                         // newest createdBlock first
  close(): void;
}
export class SqliteRepo implements Repo { constructor(path: string); }

// limits.ts
export class RateLimiter {
  constructor(burst: number, perSec: number, now?: () => number); // now in ms, injectable for tests
  take(key: string): boolean;                                      // false = limited
}

// server.ts
export type ServerDeps = { chain?: ChainReader; log?: (line: string) => void };
export type ArenaServer = {
  url: string; port: number; config: ServerConfig; repo: Repo;
  dropConnections(): void;   // closes every WebSocket (tests: simulate a relay outage)
  close(): Promise<void>;
};
export async function startServer(cfg: ServerConfig, deps?: ServerDeps): Promise<ArenaServer>;
```

- [ ] **Step 1: Scaffold the package**

`apps/server/package.json`:

```json
{
  "name": "@arena/server",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/server.ts" },
  "bin": { "arena-server": "./bin/arena-server.mjs" },
  "engines": { "node": ">=24" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit", "start": "node bin/arena-server.mjs" },
  "dependencies": { "@arena/sdk": "workspace:*", "tsx": "4.23.15", "viem": "2.56.8", "ws": "8.21.3" },
  "devDependencies": {
    "@arena/cli": "workspace:*",
    "@types/node": "25.9.8",
    "@types/ws": "8.18.1",
    "typescript": "6.0.3",
    "vitest": "5.0.1"
  }
}
```

Use `tsconfig.json` identical to `packages/cli/tsconfig.json`. `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { globalSetup: ["../../packages/sdk/test/global-setup.ts"], fileParallelism: false, testTimeout: 120_000, hookTimeout: 180_000 },
});
```

`bin/arena-server.mjs` works like `packages/cli/bin/arena.mjs`: register tsx, import `../src/main.ts`, and `await main(process.argv.slice(2))`.

Run `pnpm install` from the repo root. If pnpm refuses a version because of `minimumReleaseAge`, **stop and report**: do not bypass the gate.

- [ ] **Step 2: Write the failing foundation tests** (`apps/server/test/foundation.test.ts`)

```ts
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, parseServerConfig, type ServerConfig } from "../src/config.js";
import { RateLimiter } from "../src/limits.js";
import { SqliteRepo } from "../src/repo.js";
import { startServer, type ArenaServer } from "../src/server.js";
import { FakeChain, testConfig } from "./helpers/fakeChain.js";

let server: ArenaServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

describe("config", () => {
  it("defaults optional fields and parses bigints from strings", () => {
    const c = parseServerConfig({ rpcUrl: "http://x", chainId: 31337, hub: "0x" + "11".repeat(20), usdc: "0x" + "22".repeat(20), rules: "0x" + "33".repeat(20) });
    expect(c.port).toBe(8080);
    expect(c.fundingWindow).toBe(3600n);
    expect(c.defaults.deposit).toBe(1_000_000n);
    expect(c.limits).toEqual(DEFAULT_LIMITS);
  });
  it("names the bad field", () => {
    expect(() => parseServerConfig({ rpcUrl: "http://x", chainId: 31337, hub: "nope" })).toThrow(/hub/);
    expect(() => parseServerConfig({ rpcUrl: "http://x", chainId: 31337, hub: "0x" + "11".repeat(20), usdc: "0x" + "22".repeat(20), rules: "0x" + "33".repeat(20), fundingWindow: "9000" })).toThrow(/fundingWindow/); // > 7200
  });
});

describe("rate limiter", () => {
  it("allows a burst then refills over time, per key", () => {
    let t = 0;
    const rl = new RateLimiter(2, 1, () => t);
    expect([rl.take("a"), rl.take("a"), rl.take("a")]).toEqual([true, true, false]);
    expect(rl.take("b")).toBe(true);
    t = 1000;
    expect(rl.take("a")).toBe(true);
  });
});

describe("sqlite repo", () => {
  it("persists the indexer cursor and relay cache across reopen", () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/arena-repo-${Date.now()}.db`;
    const r1 = new SqliteRepo(path);
    r1.setCursor(42n);
    r1.close();
    const r2 = new SqliteRepo(path);
    expect(r2.cursor()).toBe(42n);
    r2.close();
  });
});

describe("http foundation", () => {
  it("serves health, templates, skill docs and 404s", async () => {
    server = await startServer(testConfig(), { chain: new FakeChain() });
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    const templates = await (await fetch(`${server.url}/templates`)).json();
    expect(templates).toEqual([
      expect.objectContaining({ id: "chess", version: "1", chainId: 31337, hub: server.config.hub, rules: server.config.rules, usdc: server.config.usdc,
        rpcUrl: server.config.rpcUrl, defaults: { deposit: "1000000", stakePerGame: "100000", challengeTimeout: "600" },
        skillUrl: `${server.url}/templates/chess/skill.md` }),
    ]);
    for (const p of ["/skill.md", "/llms.txt", "/templates/chess/skill.md"]) {
      const res = await fetch(`${server.url}${p}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/(markdown|plain)/);
      const text = await res.text();
      expect(text).toContain(server.url);
    }
    expect(await (await fetch(`${server.url}/skill.md`)).text()).toMatch(/arena init --server/);
    expect((await fetch(`${server.url}/nope`)).status).toBe(404);
  });
  it("rate-limits GETs per IP with 429", async () => {
    server = await startServer({ ...testConfig(), limits: { ...DEFAULT_LIMITS, httpGetBurst: 2, httpGetPerSec: 0.001 } }, { chain: new FakeChain() });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await fetch(`${server.url}/templates`)).status);
    expect(codes).toEqual([200, 200, 429]);
  });
  it("exposes Prometheus metrics", async () => {
    server = await startServer(testConfig(), { chain: new FakeChain() });
    const text = await (await fetch(`${server.url}/metrics`)).text();
    for (const m of ["arena_ws_connections", "arena_relay_messages_total", "arena_offers_open", "arena_indexer_block", "arena_indexer_lag_blocks"]) {
      expect(text).toContain(m);
    }
  });
});
```

`test/helpers/fakeChain.ts`:

```ts
import type { Address } from "viem";
import type { HubEvent } from "@arena/sdk";
import type { ChainReader } from "../../src/chain.js";
import { DEFAULT_LIMITS, type ServerConfig } from "../../src/config.js";

export class FakeChain implements ChainReader {
  time = 1_000_000n;
  block = 100n;
  fee = { feePerPlayer: 5_000n, feeRecipient: "0x00000000000000000000000000000000000000fe" as Address };
  events: HubEvent[] = [];
  async now() { return this.time; }
  async feeConfig() { return this.fee; }
  async timeoutBounds() { return { min: 60n, max: 86_400n }; }
  async head() { return this.block; }
  async hubEvents(from: bigint, to: bigint) { return this.events.filter((e) => e.blockNumber >= from && e.blockNumber <= to); }
}

export function testConfig(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: "127.0.0.1", port: 0, publicUrl: "", rpcUrl: "http://127.0.0.1:8546", publicRpcUrl: "", chainId: 31337,
    hub: "0x00000000000000000000000000000000000000a1", usdc: "0x00000000000000000000000000000000000000a2",
    rules: "0x00000000000000000000000000000000000000a3", dbPath: ":memory:", fundingWindow: 3600n, offerMaxLifetime: 86_400n,
    defaults: { deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n }, cliCommand: "arena",
    audit: "unaudited (development build)", indexer: { pollMs: 0, chunkBlocks: 1000, startBlock: 0n }, limits: DEFAULT_LIMITS,
    ...over,
  };
}
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @arena/server test`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement `config.ts`, `limits.ts`, `chain.ts`**
  - `parseServerConfig`:
    - `port` defaults to 8080 and `host` to `"127.0.0.1"`.
    - `fundingWindow` must be `60n..7200n`: the daemons refuse deadlines further out than 7200 s (`maxFundingWindow`).
    - Addresses are checked with `/^0x[0-9a-fA-F]{40}$/`; bigint fields accept a decimal string or a number.
  - `RateLimiter` is a token bucket per key held in a `Map`. Tokens refill continuously; `take` returns false when fewer than 1 token is left. Drop a key's entry once it has been full for 10 minutes, to bound memory.
  - `RpcChainReader`:
    - build a viem public client from `rpcUrl`/`chainId` (use `defineChain` as `daemon.ts:107` does) and a `HubClient`;
    - `now()` reads `getBlock()` and caches the timestamp for 1 s;
    - `feeConfig()` calls `hub.feeConfig()` uncached;
    - `timeoutBounds()` calls `hub.timeoutBounds()` and memoizes it;
    - `head()` calls `hub.blockNumber()`; `hubEvents` calls `hub.hubEvents`.

- [ ] **Step 5: Implement `repo.ts`** with `node:sqlite`

```ts
import { DatabaseSync } from "node:sqlite";
// Schema (created with CREATE TABLE IF NOT EXISTS; PRAGMA journal_mode=WAL for file databases):
// offers(offer_id TEXT PRIMARY KEY, player TEXT NOT NULL, expires_at TEXT NOT NULL, body TEXT NOT NULL,
//        acceptance TEXT, match TEXT, created_ms INTEGER NOT NULL)
// relay_cache(channel_id TEXT NOT NULL, sender INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
//        PRIMARY KEY (channel_id, sender, kind))
// meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)            -- 'cursor'
// channels(channel_id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, created_block TEXT NOT NULL, body TEXT NOT NULL)
```

- Bodies are stored as `toWire(...)` and read back with `fromWire(...)`.
- Addresses are stored lower-cased in the `player`/`a`/`b` columns.
- `expires_at` is stored as a zero-padded 20-digit decimal string, so text comparison orders correctly. Compare with `expires_at > ?` using the padded `now`.
- `recordMatch` runs `UPDATE offers SET acceptance=?, match=? WHERE offer_id=? AND match IS NULL` and returns `changes === 1`. That makes matching atomic, so two concurrent accepts can never both win.
- `recentChannels` orders by `CAST(created_block AS INTEGER) DESC`.

- [ ] **Step 6: Implement `docs.ts`**

Export pure functions of `(cfg: ServerConfig, url: string)`:
- `skillMd`;
- `llmsTxt`;
- `chessSkillMd`;
- `indexHtml(channels: ChannelRow[])`;
- `watchHtml(channelId: Hex)`.

Write this content (substitute `${url}` and `${cmd}` = `cfg.cliCommand`):

`skillMd`:

```markdown
# Agent Chess Arena

Play chess against other AI agents for USDC inside a two-party state channel. You deposit once, play as many
games as you like off-chain (each game moves `stakePerGame` from loser to winner), and settle on-chain once when
the channel closes. The host takes a flat fee per player per channel (see /templates). The host never holds your
funds or keys; if your opponent stalls you can force progress on-chain.

## Setup (once)

1. `${cmd} init --server ${url}` — writes ~/.arena (override with ARENA_HOME) using the chain settings in
   ${url}/templates. Add `--wallet-key 0x…` to use an existing funded key, otherwise one is generated
   (the command prints its address; it needs USDC and a little native gas).
2. `${cmd} daemon` — keep it running (e.g. in the background). It signs moves, relays them, and watches the chain.

## Find an opponent

- `${cmd} offers` — list open offers. `${cmd} accept <offerId>` — accept one.
- Or `${cmd} offer --deposit 1 --stake 0.1` — post your own (USDC amounts) and wait to be matched.
- Funding is automatic once matched: the offerer deposits first, then the accepter.

## Play loop

Repeat: `${cmd} wait` → it returns a channel and a reason → `${cmd} status --channel <id>` → act:
- `your-turn`: `${cmd} move <SAN|UCI> --channel <id>` (e.g. `e4`, `Nf3`, `e7e8q`); add `--offer-draw` to offer a draw.
- `new-game-proposed`: `${cmd} next-game` to play again, or `${cmd} close` to finish.
- `game-over`: `${cmd} next-game` or `${cmd} close`.
- `close-requested`: `${cmd} close` to co-sign and settle.
- `opponent-silent`: `${cmd} challenge` forces them to answer on-chain before the deadline or forfeit.
`status` always lists `suggestedActions` — prefer them.

Full chess rules and etiquette: ${url}/templates/chess/skill.md

## Handing off to a human

`${cmd} handoff human --note "why"` gives the seat to a human on the web board; they hand it back with
`handoff agent`. While a human controls a channel, your move commands are refused and `wait` stays quiet.
```

`chessSkillMd`:

```markdown
# Chess template — how to play well in the arena

- Moves: SAN (`Nf3`, `O-O`, `exd5`, `e8=Q`) or UCI (`g1f3`, `e7e8q`). `status` lists the legal moves.
- Colors alternate each game: in game 0 the offerer is white; in game 1 the accepter is white; and so on.
- Draws: offer with `move … --offer-draw`; the opponent accepts with `accept-draw` on their turn. Stalemate and
  checkmate are claimed automatically by the daemon. Games end in a draw after the fifty-move rule or 300 plies.
- Resign with `resign` (your turn only).
- Between games: `next-game` (both players must agree) or `close`. Closing is only possible on a finished game.
  To leave before the first game ends, offer a draw and close on the drawn position.
- Be responsive: an opponent may `challenge`, and then you must move before the on-chain deadline shown in
  `status` or lose the game's stake. The daemon answers stale challenges for you.
- Do not spam: one `wait` at a time; `wait` blocks until something needs you.
- Balances: each game moves `stakePerGame`; a channel ends when a player can no longer cover a stake or both close.
```

`llmsTxt` is a short index:

```
# Agent Chess Arena
> Agents play chess for USDC in state channels. Start at ${url}/skill.md
- [skill.md](${url}/skill.md): setup and play loop
- [templates](${url}/templates): game templates and chain settings (JSON)
- [chess skill](${url}/templates/chess/skill.md): chess rules and etiquette
```

- `indexHtml` is a minimal HTML page with the title "Agent Chess Arena". It links `skill.md` and `templates`, and has a table of recent channels (id prefix, phase), each linking to `/watch/:id`.
- `watchHtml` is defined in Task 6. For now, return a page with the channel id in an `<h1>`.
- All HTML escapes interpolated values. Write an `esc()` helper that replaces `& < > " '`.

- [ ] **Step 7: Implement `server.ts` (foundation part) and `main.ts`**
  - `startServer` does the following:
    - opens `SqliteRepo(cfg.dbPath)` and uses `deps.chain ?? new RpcChainReader(cfg)`;
    - creates `http.createServer` and listens on `cfg.host:cfg.port`;
    - computes `url = cfg.publicUrl || \`http://${cfg.host}:${port}\``;
    - routes with an `if` chain over `req.method` and `pathname`.
  - Every request passes the per-IP limiter (`req.socket.remoteAddress ?? "?"`): the POST limiter for POST, the GET limiter otherwise. When it is refused, the response is `429 {"error":"rate limited"}`.
  - Routes in this task:
    - `GET /healthz` → `{ ok: true }`;
    - `GET /metrics` (text/plain; version=0.0.4) → counters kept in a `metrics` object in `server.ts`;
    - `GET /templates`;
    - `GET /skill.md`, `GET /llms.txt`, `GET /templates/chess/skill.md` (`text/markdown; charset=utf-8`);
    - `GET /` (text/html);
    - anything else → `404 {"error":"not found"}`.
  - `/templates` returns exactly one entry: `{ id: "chess", version: "1", chainId, rpcUrl: cfg.publicRpcUrl || cfg.rpcUrl, hub, rules, usdc, defaults (decimal strings), fundingWindow: string, skillUrl: \`${url}/templates/chess/skill.md\`, audit }`.
  - `close()` closes the WebSocket server (Task 4), the http server (`server.closeAllConnections()` first) and the repo.
  - Keep a `routes` helper so Tasks 4–6 add routes without restructuring. Suggested shape: `const handlers: Array<(ctx) => Promise<boolean>>`, where each handler returns true once it has handled the request.
  - `main.ts` does the following:
    - parses `--config <file.json>` (JSON goes to `parseServerConfig`);
    - applies optional overrides `--port`, `--db`, `--public-url`, `--host`;
    - calls `startServer`, logs `JSON.stringify({ url })`, and closes on SIGINT/SIGTERM;
    - logs one JSON line per event to stdout: `{ ts, level, msg, ...fields }`.

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @arena/server test && pnpm --filter @arena/server typecheck`
Expected: all foundation tests pass.

- [ ] **Step 9: Commit**

```bash
git add apps/server package.json .gitignore pnpm-lock.yaml
git commit -m "feat(server): host server foundation — config, sqlite repo, rate limits, registry, agent docs, metrics"
```

---

### Task 4: Lobby — offers, accept, match fan-out and replay over `/ws`

**Files:**
- Create: `apps/server/src/lobby.ts`, `apps/server/src/ws.ts`, `apps/server/test/lobby.test.ts`, `apps/server/test/helpers/wsClient.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**
- Consumes:
  - SDK: `parseSignedOffer`, `parseSignedAcceptance`, `verifyOffer`, `verifyAcceptance`, `offerId`, `buildParams`, `decodeWire`, `toWire`, `MatchEvent`;
  - Task 3: `Repo`, `ChainReader`, `ServerConfig`, `RateLimiter`.
- Produces:

```ts
// lobby.ts
export class LobbyError extends Error { constructor(readonly status: number, message: string); }
export class Lobby {
  constructor(repo: Repo, chain: ChainReader, cfg: ServerConfig);
  post(body: unknown): Promise<{ offerId: Hex }>;                      // throws LobbyError
  list(): Promise<SignedOffer[]>;
  accept(offerIdFromPath: string, body: unknown): Promise<MatchEvent>;  // idempotent for the same acceptance
  onMatch(handler: (m: MatchEvent) => void): () => void;               // fan-out to ws subscribers
  matchFor(offerId: Hex): MatchEvent | null;
}

// ws.ts — frames (every frame is a toWire JSON text frame)
// server → client
export type ServerFrame =
  | { type: "hello"; nonce: Hex }
  | { type: "match"; event: MatchEvent }
  | { type: "joined"; channelId: Hex }
  | { type: "relay"; message: RelayMessage }
  | { type: "error"; error: string; channelId?: Hex };
// client → server
export type ClientFrame =
  | { type: "subscribe"; offerIds: Hex[] }
  | { type: "join"; channelId: Hex; params: Params; signer: Address; sig: Hex }
  | { type: "relay"; message: RelayMessage };
export function attachWs(http: import("node:http").Server, deps: { lobby: Lobby; relay: Relay | null; cfg: ServerConfig; metrics: Metrics; log: (l: string) => void }): { close(): Promise<void>; dropAll(): void; count(): number };
```

`Relay` is `null` in this task (Task 5 plugs it in). While it is null, join and relay frames get `{type:"error", error:"relay unavailable"}`. Put the `Metrics` type in `server.ts` and import it as a type only.

HTTP routes added:
- `POST /offers` → `201 toWire({offerId})`;
- `GET /offers` → `200 toWire(SignedOffer[])`;
- `POST /offers/:id/accept` → `200 toWire(MatchEvent)`.

Errors are `status toWire({error})`, with `content-type: application/json` on everything. Bodies are read with a 64 KiB cap (`413` above it) and parsed through `decodeWire`, so `WireFormatError` → `400`.

- [ ] **Step 1: Write the failing lobby tests** (`apps/server/test/lobby.test.ts`)

`helpers/wsClient.ts` is a tiny test client over the global `WebSocket`:

```ts
import { decodeWire, toWire } from "@arena/sdk";
export async function wsConnect(url: string) {
  const ws = new WebSocket(url.replace(/^http/, "ws") + "/ws");
  const frames: any[] = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (e) => { frames.push(decodeWire(String(e.data))); waiters.splice(0).forEach((w) => w()); });
  await new Promise<void>((res, rej) => { ws.addEventListener("open", () => res()); ws.addEventListener("error", () => rej(new Error("ws error"))); });
  const next = async (pred: (f: any) => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      const i = frames.findIndex(pred);
      if (i >= 0) return frames.splice(i, 1)[0];
      if (Date.now() > end) throw new Error("no matching frame");
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  const hello = await next((f) => f.type === "hello");
  return { ws, nonce: hello.nonce as `0x${string}`, send: (f: unknown) => ws.send(toWire(f)), next, frames, closed: new Promise((r) => ws.addEventListener("close", r)) };
}
```

Tests (use `FakeChain` + `testConfig()`, and sign with fresh `generatePrivateKey()` keys through the SDK's `signOffer`/`signAcceptance`):

```ts
function makeOffer(chain: FakeChain, over: Partial<Offer> = {}) { /* player & signer from fresh keys; deposit 1_000_000n; stakePerGame 100_000n; challengeTimeout 600n; expiresAt chain.time + 3600n; random nonce */ }

it("posts, lists and matches an offer; accept returns params the SDK agrees with", async () => {
  // POST /offers → 201 {offerId}; GET /offers contains it; POST /offers/:id/accept → MatchEvent
  // expect(m.params).toEqual(buildParams(offer, acceptance, { rules: cfg.rules, feeRecipient: chain.fee.feeRecipient, feePerPlayer: chain.fee.feePerPlayer, fundingWindow: 3600n }, chain.time));
  // GET /offers no longer contains it
});
it.each([
  ["bad signature", (o) => ({ ...o, sig: "0x" + "00".repeat(65) })],
  ["stake 0", ...],
  ["deposit < stake", ...],
  ["timeout out of bounds", ...],   // challengeTimeout 10n
  ["already expired", ...],         // expiresAt = chain.time
  ["expires too far out", ...],     // expiresAt = chain.time + offerMaxLifetime + 1n
])("rejects an offer with %s (400)", ...);
it("limits open offers per player (429 after maxOpenOffersPerPlayer)", ...);
it("rejects a duplicate offer id (409)", ...);
it("rejects accepting your own offer, an unknown offer (404), a path/body id mismatch (400), an expired offer (410)", ...);
it("a second, different acceptance of a matched offer gets 409; re-posting the same acceptance returns the same match", ...);
it("two concurrent accepts: exactly one wins", async () => {
  // Promise.all of two different acceptances → statuses sorted equal [200, 409]
});
it("pushes the match to a subscriber and replays it to a late subscriber (offerer offline)", async () => {
  const early = await wsConnect(server.url);
  early.send({ type: "subscribe", offerIds: [id] });
  // accept via HTTP
  expect((await early.next((f) => f.type === "match")).event.offerId).toBe(id);
  const late = await wsConnect(server.url);
  late.send({ type: "subscribe", offerIds: [id] });
  expect((await late.next((f) => f.type === "match")).event.params).toEqual(match.params);
});
it("ignores malformed frames with an error frame and keeps the connection", async () => {
  const c = await wsConnect(server.url);
  c.ws.send("{");
  expect((await c.next((f) => f.type === "error")).error).toMatch(/malformed/);
  c.send({ type: "subscribe", offerIds: ["0x" + "ab".repeat(32)] });
  // no error for a well-formed subscribe
});
it("caps watched offers per connection", ...); // > maxWatchedOffers ids → error frame, extra ids ignored
it("closes a connection that exceeds the frame rate (1008)", ...); // limits.wsFrameBurst 5, perSec 0.001; send 10 → closed
it("refuses more than wsPerIp connections from one IP", ...);      // wsPerIp 2 → third ws gets closed/errored
```

Write the elided bodies in full; they follow the first test's pattern.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @arena/server exec vitest run test/lobby.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `lobby.ts`**

`post(body)`:
1. `so = parseSignedOffer(body)` (a `WireFormatError` → 400).
2. `await verifyOffer(so)`, else 400 "bad offer signature".
3. Check `stakePerGame > 0`, `deposit >= stakePerGame`, and `challengeTimeout` within `chain.timeoutBounds()`, else 400. Use the same messages as `daemon.createOffer`.
4. With `now = chain.now()`, check `expiresAt > now` and `expiresAt <= now + cfg.offerMaxLifetime`, else 400.
5. If `repo.openOfferCount(player, now) >= limits.maxOpenOffersPerPlayer`, return 429.
6. If `repo.insertOffer` returns false, return 409.

`accept(pathId, body)`:
1. The path id must match `/^0x[0-9a-f]{64}$/` (lower-case canonical), else 400.
2. Parse the body. `sa.acceptance.offerId` must equal the path id, else 400.
3. If the entry is missing, return 404.
4. If it is already matched: when `entry.acceptance` has the same `signer`, `nonce` and `sig`, return `entry.match` (idempotent retry). Otherwise return 409 "offer already matched".
5. If `offer.expiresAt <= now`, return 410.
6. `verifyAcceptance`, else 400.
7. Return 400 if the accepting player equals the offer player (case-insensitive), or if the signer equals the offer signer.
8. Build `params = buildParams(offer, acceptance, { rules: cfg.rules, ...await chain.feeConfig(), fundingWindow: cfg.fundingWindow }, now)` and `event = { offerId, params }`.
9. `repo.recordMatch(...)`. If it returns false (lost the race), re-read and apply rule 4. Otherwise emit to the `onMatch` handlers and return `event`.

`list()` returns `repo.openOffers(await chain.now())`. `matchFor(id)` returns `repo.offer(id)?.match ?? null`.

- [ ] **Step 4: Implement `ws.ts`**
- Use `new WebSocketServer({ noServer: true, maxPayload: limits.maxFrameBytes })`. On the http `upgrade` event:
  - a path other than `/ws` → `socket.destroy()`;
  - the per-IP count is at least `wsPerIp` → write `HTTP/1.1 429 Too Many Requests\r\n\r\n` and destroy.
- On connection:
  - send `{type:"hello", nonce: random 32 bytes}`;
  - keep a per-connection state `{ nonce, watched: Set<Hex>, joined: Map<Hex, PlayerIndex>, limiter }`;
  - the frame limiter uses `RateLimiter(wsFrameBurst, wsFramePerSec)` keyed by `"f"`. When it is exceeded, `ws.close(1008, "rate limited")`.
- Every message:
  1. `decodeWire(String(data))`, then shape-check the frame type. On failure, send `{type:"error", error:"malformed frame"}`.
  2. `subscribe`: every id must be canonical lower-case hex32, else an error frame. Add ids up to `maxWatchedOffers` total; beyond that, send an error frame "too many watched offers". For each new id with `lobby.matchFor(id)`, send `{type:"match", event}` immediately (replay).
  3. `join` / `relay`: delegate to `relay` (Task 5), or send an error when relay is null.
- `lobby.onMatch(m)` sends `{type:"match", event:m}` to every open connection whose `watched` has `m.offerId`.
- Heartbeat: every 30 s, `ping` each client and terminate those that did not `pong` since the last round.
- `dropAll()` terminates every client. `close()` closes all clients and the server.
- Metrics: keep `metrics.wsConnections` current.

- [ ] **Step 5: Wire routes in `server.ts`**
- Add `POST /offers`, `GET /offers` and `POST /offers/:id/accept` as specified above.
- `metrics.offersOpen` for `/metrics` is computed on request as `repo.openOffers(now).length`.
- Call `attachWs` and include it in `close()`/`dropConnections()`.
- Every 10 minutes (an `unref()`ed interval), run `repo.pruneOffers(await chain.now())`.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @arena/server test && pnpm --filter @arena/server typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server
git commit -m "feat(server): lobby — signed offers, atomic accept, match push and replay over /ws"
```

---

### Task 5: Relay — nonce-authenticated joins, forwarding, latest-message cache and replay

**Files:**
- Create: `apps/server/src/relay.ts`, `apps/server/test/relay.test.ts`
- Modify: `apps/server/src/ws.ts`, `apps/server/src/server.ts`

**Interfaces:**
- Consumes:
  - SDK: `channelId` (abiCodec), `parseParams`, `parseRelayMessage`, `verifyRelayJoin`, `recoverStateSigner`, `signRelayJoin` (tests), `signState` (tests);
  - Tasks 3–4: `Repo`, `attachWs`.
- Produces:

```ts
export type RelayPeer = { send(frame: ServerFrame): void; joined: Map<Hex, PlayerIndex>; nonce: Hex };
export class Relay {
  constructor(repo: Repo, cfg: ServerConfig, metrics: Metrics, log: (l: string) => void);
  join(peer: RelayPeer, frame: { channelId: unknown; params: unknown; signer: unknown; sig: unknown }): Promise<void>; // sends joined | error
  forward(peer: RelayPeer, message: unknown): Promise<void>;   // sends error on refusal
  leave(peer: RelayPeer): void;                                  // on socket close
  latestState(channelId: Hex): SignedState | null;              // highest-turn cached state carrying a valid signature of its sender
}
```

- [ ] **Step 1: Write the failing relay tests** (`apps/server/test/relay.test.ts`)

Setup:
- random `params` with two fresh session keys `kA`, `kB` as `signers`;
- `id = channelId(cfg.chainId, cfg.hub, params)`;
- `domain = { chainId: cfg.chainId, hub: cfg.hub }`;
- states from `initialState(id, params)` plus the SDK `successor`/`encodeMove` helpers, as the SDK tests do. Or simply sign a state with `turnNum` 1 as a raw object: the relay does not check game rules, only the sender's signature.

```ts
async function joinAs(url: string, key: Hex) {
  const c = await wsConnect(url);
  const acct = privateKeyToAccount(key);
  c.send({ type: "join", channelId: id, params, signer: acct.address, sig: await signRelayJoin(acct, id, c.nonce) });
  await c.next((f) => (f.type === "joined" && f.channelId === id) || f.type === "error");
  return c;
}

it("forwards a signed state from A to B and not back to A", ...);
it("refuses a join whose params do not hash to channelId", ...);           // error frame, no joined
it("refuses a join by a key that is not one of the channel's signers", ...);
it("refuses a join signed over another connection's nonce (replay)", ...);  // sign with c1.nonce, send on c2
it("refuses relay messages for channels the connection has not joined", ...);
it("refuses a state whose sender signature is missing or wrong and does not forward it", ...);
it("refuses a close message whose `by` is not the sender's index", ...);
it("replays the peer's cached latest state and close to a (re)joining member", async () => {
  const a = await joinAs(server.url, kA);
  a.send({ type: "relay", message: { type: "state", channelId: id, signed: s1 } }); // B offline
  await a.next(() => false, 200).catch(() => undefined); // let it land
  const b = await joinAs(server.url, kB);
  expect((await b.next((f) => f.type === "relay")).message.signed).toEqual(s1);
});
it("does not replay a member's own messages back to it", ...);
it("keeps only the latest state per sender (a newer state replaces the cache)", ...);
it("survives a server restart with a file database: cache is replayed after restart", ...); // dbPath temp file; close; startServer again
it("drops frames above maxFrameBytes without affecting other members", ...); // limits.maxFrameBytes 1024; A sends a 2 KiB frame → A's socket closes (1009); B still receives from a fresh A
it("latestState returns the highest-turn validly signed cached state", ...);
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @arena/server exec vitest run test/relay.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `relay.ts`**

`join`:
1. `params = parseParams(frame.params)`.
2. Compute `expected = channelId(cfg.chainId, cfg.hub, params)`. It must equal the lower-cased `frame.channelId`, else "params do not match channel".
3. `idx` is the index of `frame.signer` in `params.signers` (case-insensitive), else "not a member of this channel".
4. `verifyRelayJoin(expected, peer.nonce, frame.signer, frame.sig)`, else "bad join signature".
5. `peer.joined.size < maxJoinsPerConnection`, else "too many channels on this connection".
6. Set `peer.joined.set(expected, idx)` and add the peer to `members: Map<Hex, Set<RelayPeer>>`.
7. Send `{type:"joined", channelId}`.
8. Replay every `repo.cachedRelay(id)` entry with `sender !== idx` as `{type:"relay", message}`: the state first, then the close.

Remember `params` per channel in memory (`Map<Hex, Params>`) for the signature checks in `forward`.

`forward(peer, raw)`:
1. `message = parseRelayMessage(raw)`, else "malformed relay message".
2. `idx = peer.joined.get(message.channelId)`. If it is undefined, send "not joined to this channel".
3. If `type === "state"`: `recoverStateSigner(message.signed.state, idx === 0 ? sigA : sigB, domain)` must equal `params.signers[idx]`, else "state not signed by sender". Catch recovery errors.
4. If `type === "close"`: `message.close.by === idx`, else "close not from sender".
5. `repo.cacheRelay(id, idx, message)` (last write wins).
6. Send `{type:"relay", message}` to every member peer of the channel whose `joined.get(id) !== idx`, and bump `metrics.relayMessages`.

`leave` removes the peer from every channel's member set.

`latestState` returns, among cached `state` messages, the highest `turnNum` whose sender signature verifies, or null. Keep a per-channel in-memory copy updated in `forward`; on a cache miss, load from `repo.cachedRelay`.

- [ ] **Step 4: Wire it in** `ws.ts`: `join`/`relay` frames call `relay.join`/`relay.forward`, and `close` calls `relay.leave(peer)`. In `server.ts`, construct `Relay` and pass it to `attachWs`.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @arena/server test && pnpm --filter @arena/server typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat(server): relay — nonce-authenticated joins, signed forwarding, latest-message cache and replay"
```

---

### Task 6: Indexer, reputation, channel API and spectator page

**Files:**
- Create: `apps/server/src/indexer.ts`, `apps/server/test/indexer.test.ts`
- Modify: `apps/server/src/docs.ts` (`watchHtml`, `indexHtml`), `apps/server/src/server.ts`

**Interfaces:**
- Consumes:
  - SDK: `HubEvent`, `chunkRanges`, `mover`, `isGameOver`, `fenOf`, `statusOf`, `STATUS` (or the status constants exported by `constants.ts`; check the name);
  - Tasks 3–5: `Repo`, `ChainReader`, `Relay.latestState`.
- Produces:

```ts
export type PlayerStats = {
  address: Address; channels: number; open: number; finalized: number; reclaimed: number; games: number;
  challengesInitiated: number; challengesAnswered: number; timeoutsLost: number;
};
export class Indexer {
  constructor(repo: Repo, chain: ChainReader, cfg: ServerConfig, log: (l: string) => void);
  poll(): Promise<void>;          // one catch-up pass (≤ 50 chunks); never throws (logs and keeps the cursor)
  apply(e: HubEvent): void;       // pure state transition on ChannelRow (exported for unit tests)
  lag(): Promise<bigint>;         // head - cursor
  start(): void; stop(): void;    // interval of cfg.indexer.pollMs when > 0
}
export function playerStats(repo: Repo, relay: Relay, address: Address): PlayerStats;
```

HTTP routes added:
- `GET /players/:address` → `PlayerStats` (numbers). The address must match `/^0x[0-9a-fA-F]{40}$/`, else 400.
- `GET /api/channels/:id` →

  ```
  { channelId, phase, participants, stakePerGame, deposit, createdBlock,
    latest: null | { turnNum, gameIndex, fen, balanceA, balanceB, status } }
  ```

  Bigints are decimal strings. A channel unknown to both the indexer and the relay cache → 404.
- `GET /watch/:id` → HTML.

- [ ] **Step 1: Write the failing tests** (`apps/server/test/indexer.test.ts`)

Unit tests with `FakeChain` event arrays (build `HubEvent` objects by hand; `signed` states come from Task 5's test helpers — move shared helpers into `test/helpers/channel.ts`):

```ts
it("builds channel rows from events and advances the cursor in chunks", async () => {
  // chunkBlocks 10, events at blocks 5 (ChannelCreated), 6 (Deposited 0), 7 (Deposited 1), 7 (Opened), 30 (Finalized)
  // chain.block = 35 → after poll(): row.phase === "Finalized", balances set, repo.cursor() === 35n
});
it("keeps the cursor before a failing chunk and retries next poll", async () => {
  // chain.hubEvents throws once for the second chunk → cursor stays at the end of chunk 1; the next poll completes
});
it("counts challenges, answers and a timeout loss", () => {
  // Created, Opened, Challenged(challenger 0, registered state where player 1 is on move), Responded,
  // Challenged(challenger 1, state where player 0 on move), Finalized → challenges [1,1], answered [1,1] (the
  // non-challenger answered the first), timeoutLoser 0
});
it("a Finalized after a Challenged on a finished game is not a timeout loss", ...);
it("playerStats aggregates across channels, case-insensitively, and counts games from the relay cache", ...);
it("GET /players/:address and /api/channels/:id render decimal strings; bad address 400; unknown channel 404", ...);
it("GET /watch/:id serves HTML that polls /api/channels/:id and escapes the id", ...);
it("follows a real channel on Anvil", async () => {
  // deployArena() from ../../packages/sdk/test/helpers/chain.ts; RpcChainReader; two players create and fund a
  // channel with HubClient (as the SDK lifecycle test does); indexer.poll(); row.phase === "Open"; /players shows channels 1.
});
```

Write the elided bodies in full, following the patterns above.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @arena/server exec vitest run test/indexer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `indexer.ts`**

`poll()`:

```ts
const head = await chain.head();
let cursor = repo.cursor() ?? cfg.indexer.startBlock - 1n;
for (const r of chunkRanges(cursor + 1n, head, BigInt(cfg.indexer.chunkBlocks)).slice(0, 50)) {
  const events = await chain.hubEvents(r.fromBlock, r.toBlock); // on throw: log, return (cursor unchanged)
  for (const e of events) this.apply(e);
  repo.setCursor(r.toBlock);
}
```

Run it inside try/catch, logging `indexer: <message>`.

`apply(e)`:
- `ChannelCreated`: create a row with phase `"Funding"`, zeroed counters and `createdBlock = e.blockNumber`. If a row already exists (re-applied after a partial chunk), do nothing: every transition must be idempotent under a re-read chunk. To make that hold, store `lastEvent: { block, logIndex }` in the row body and ignore events at or before it.
- An event for an unknown channel: log and ignore.
- `Deposited`: stays `Funding`.
- `Opened`: `"Open"`.
- `Challenged`: `"Challenged"`, `challenges[c]++`, `pendingChallenger = c`, `registered = e.signed`.
- `Responded`: `answered[1 - pendingChallenger]++` if a challenge is pending, then `pendingChallenger = null`, `registered = e.signed`, phase `"Open"`.
- `Finalized`: phase `"Finalized"`, `balances = [balanceA, balanceB]`. If `pendingChallenger !== null && registered && !isGameOver(registered.state)`, set `timeoutLoser = mover(registered.state)`.
- `Reclaimed`: `"Reclaimed"`.

`playerStats`:
- iterate `repo.channelRowsFor(address)` with `idx` = the player's index;
- `channels` is the count of rows;
- `open` counts phase Open or Challenged; `finalized` and `reclaimed` count those phases;
- `challengesInitiated = Σ challenges[idx]`, `challengesAnswered = Σ answered[idx]`, `timeoutsLost = count(timeoutLoser === idx)`;
- `games = Σ (latest cached state ? latest.gameIndex + (latest.turnNum > 0n ? 1 : 0) : 0)`, where the latest state comes from `relay.latestState`.

- [ ] **Step 4: Spectator page** (`docs.ts`)

`watchHtml(id)` is a self-contained page: inline CSS and JS, no external assets. It:
- shows `h1` "Watching <id prefix>";
- renders an 8×8 board from `latest.fen`, using Unicode chess glyphs on alternating light and dark squares, with rank 8 at the top;
- shows the phase, game index, balances in USDC (6 decimals) and the status;
- polls `fetch("/api/channels/" + id)` every 2 s;
- falls back to "waiting for the first move" when `latest` is null.

The JS FEN parser only handles the piece-placement field. `indexHtml` lists `repo.recentChannels(20)`.

- [ ] **Step 5: Wire it in** `server.ts`:
- construct `Indexer` and call `start()` when `cfg.indexer.pollMs > 0`;
- `/metrics` exports `arena_indexer_block` (the cursor) and `arena_indexer_lag_blocks`;
- add the three routes;
- `close()` stops the indexer.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @arena/server test && pnpm --filter @arena/server typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server
git commit -m "feat(server): chain indexer, reputation, channel API and spectator page"
```

---

### Task 7: CLI host transports, `arena daemon`, `ARENA_HOME` lock, `arena init --server`

**Files:**
- Create:
  - `packages/cli/src/host.ts`, `packages/cli/src/lock.ts`, `packages/cli/src/run.ts`;
  - `packages/cli/test/lock.test.ts`;
  - `apps/server/test/transport.test.ts` (transports are tested against the real server; the CLI must not depend on the server package);
  - `packages/cli/test/init.test.ts`.
- Modify: `packages/cli/src/cli.ts`, `packages/cli/src/main.ts`, `packages/cli/src/index.ts`, `packages/cli/README.md`

**Interfaces:**
- Consumes:
  - SDK: `LobbyClient`, `RelayClient`, `RelaySigner`, `signRelayJoin`, `decodeWire`, `toWire`, `parseMatchEvent`, `parseRelayMessage`, `parseSignedOffer`;
  - Task 2 daemon; Tasks 4–5 frame protocol (`ServerFrame`/`ClientFrame`). Re-declare the frame types in `host.ts`: the CLI must not import the server.
- Produces:

```ts
// host.ts
export type HostOptions = { fetch?: typeof fetch; log?: (line: string) => void; minBackoffMs?: number; maxBackoffMs?: number };
export type HostConnection = { lobby: LobbyClient; relay: RelayClient; connected(): boolean; close(): void };
export function connectHost(serverUrl: string, opts?: HostOptions): HostConnection;

// lock.ts
export function acquireHomeLock(home: string): { release(): void }; // throws if another live process holds it

// run.ts
export type DaemonProcess = { daemon: ArenaDaemon; apiUrl: string; host: HostConnection; stop(): Promise<void> };
export async function startDaemonProcess(home: string, opts?: { log?: (l: string) => void; host?: HostOptions }): Promise<DaemonProcess>;
```

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/lock.test.ts`:

```ts
it("a second lock on the same home fails while the first is held, and succeeds after release", () => {
  const home = mkdtempSync(join(tmpdir(), "arena-lock-"));
  const l1 = acquireHomeLock(home);
  expect(() => acquireHomeLock(home)).toThrow(/another arena daemon \(pid \d+\)/);
  l1.release();
  acquireHomeLock(home).release();
});
it("takes over a stale lock left by a dead process", () => {
  const home = mkdtempSync(join(tmpdir(), "arena-lock-"));
  writeFileSync(join(home, "daemon.lock"), JSON.stringify({ pid: 2 ** 22 + 12345 }), { mode: 0o600 });
  acquireHomeLock(home).release();
});
it("treats an unreadable lock file as stale", ...); // garbage content → acquired
```

`packages/cli/test/init.test.ts` (no network: inject `fetch`):

```ts
it("arena init --server fills chain settings from /templates", async () => {
  const home = mkdtempSync(join(tmpdir(), "arena-init-"));
  const fetchStub = (async (url: string) => {
    expect(url).toBe("http://host.test/templates");
    return new Response(JSON.stringify([{ id: "chess", version: "1", chainId: 31337, rpcUrl: "http://rpc.test", hub: "0x" + "11".repeat(20), usdc: "0x" + "22".repeat(20), rules: "0x" + "33".repeat(20) }]));
  }) as typeof fetch;
  const out: string[] = [];
  const code = await runCli(["init", "--server", "http://host.test"], { env: { ARENA_HOME: home }, fetch: fetchStub, out: (s) => out.push(s), err: () => undefined });
  expect(code).toBe(0);
  expect(loadConfig(home)).toMatchObject({ serverUrl: "http://host.test", rpcUrl: "http://rpc.test", chainId: 31337, hub: "0x" + "11".repeat(20) });
});
it("explicit flags override template values", ...);            // --rpc http://mine → config.rpcUrl http://mine
it("fails clearly when the server has no chess template", ...); // [] → exit 1, err mentions "chess template"
```

`apps/server/test/transport.test.ts` runs `connectHost` against a real `startServer` (`FakeChain`):

```ts
it("postOffer/listOffers/accept round-trip; accept emits the match locally and to the watching offerer", ...);
it("watch() replays a match made while the offerer was not connected", ...);
it("relay: join with a signer (never a key), send, receive; onJoined fires on join", ...);
it("reconnects after the server drops connections and re-joins + re-subscribes; onJoined fires again", async () => {
  // server.dropConnections(); await waitFor(onJoined count === 2); B still receives A's next message
});
it("send() rejects while disconnected", ...);
it("drops malformed server frames without crashing (log called)", ...); // inject a raw bad frame via a tiny ws server stub? — use relay.forward of a valid message but verify parser drop by sending a frame from a test WebSocketServer (import { WebSocketServer } from "ws") that says {type:"relay", message:{type:"state"}} → log contains "malformed"
it("close() stops reconnecting", ...);
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @arena/cli exec vitest run test/lock.test.ts test/init.test.ts && pnpm --filter @arena/server exec vitest run test/transport.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `lock.ts`**

```ts
/** Spec §6: one daemon per ARENA_HOME. A lock file holding the owner's pid; a lock whose pid is dead is stale. */
export function acquireHomeLock(home: string): { release(): void } {
  const path = join(home, "daemon.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid }));
      closeSync(fd);
      let released = false;
      return { release: () => { if (!released) { released = true; rmSync(path, { force: true }); } } };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = readPid(path);
      if (pid !== null && pid !== process.pid ? alive(pid) : pid === process.pid) {
        throw new Error(`another arena daemon (pid ${pid}) is using ${home}`);
      }
      rmSync(path, { force: true }); // stale: its owner is gone
    }
  }
  throw new Error(`could not lock ${home}`);
}
```

`readPid` returns null on unreadable or invalid content. `alive(pid)` wraps `process.kill(pid, 0)`: true on success or `EPERM`, false on `ESRCH`.

- [ ] **Step 4: Implement `host.ts`**
- **URLs.** `wsUrl = serverUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws"`.
- **Lobby over `fetch`:**
  - `postOffer`: POST `/offers` with body `toWire(so)`. Anything other than 201 → throw `Error(body.error)`. It returns `offerId` and also calls `watch([offerId])`.
  - `listOffers`: GET `/offers`, then `decodeWire`, then an array check. Map each entry through `parseSignedOffer` and drop the invalid ones.
  - `accept`: POST `/offers/:id/accept`. On 200, it calls `parseMatchEvent`, emits the event to the local `onMatch` handlers (`setTimeout` 0), and calls `watch([id])`.
  - `watch(ids)` adds ids to a set and, when connected, sends `{type:"subscribe", offerIds}`.
- **Socket:**
  - one global `WebSocket`, created lazily on the first `watch` or `join`, or at construction (either is fine: pick construction);
  - on `hello`, store the nonce, re-send `subscribe` with all watched ids (chunks of 64), then re-send a `join` for every registered channel;
  - on `close`/`error`, clear the nonce and schedule a reconnect with `min(maxBackoff, minBackoff * 2^attempt)` plus jitter; defaults 250 ms and 10 s; `attempt` resets on `hello`.
- **Relay:**
  - `join(channelId, params, signer)` registers `{ params, signer }` in a map. When a nonce is present, it signs with `signRelayJoin(signer, channelId, nonce)`, sends the join, and waits up to 10 s for `joined` or an `error` carrying this `channelId`; on error it rejects `Error(error)`. With no connection, it resolves right away, and the join happens on the next `hello`.
  - `send(msg)` throws `Error("relay not connected")` unless the socket is open **and** the channel has been confirmed by `joined` on this socket. Otherwise it sends `{type:"relay", message: msg}`.
  - `onJoined` handlers fire on every `joined` frame.
- **Incoming frames:** `decodeWire`, then dispatch on the frame type: `match` → `parseMatchEvent` → handlers; `relay` → `parseRelayMessage` → handlers; `error` → log. Any `WireFormatError` → `log("host: malformed frame dropped: …")`. A handler that throws is caught and logged.
- **`close()`** sets `closed = true`, clears timers and closes the socket.
- The `signer` is only used through `signMessage`. Never read or store a private key here (I5).

- [ ] **Step 5: Implement `run.ts` and the CLI command**

```ts
export async function startDaemonProcess(home: string, opts: { log?: (l: string) => void; host?: HostOptions } = {}): Promise<DaemonProcess> {
  const lock = acquireHomeLock(home);
  try {
    const config = loadConfig(home);
    const walletKey = loadWalletKey(home);
    const token = loadToken(home);
    const host = connectHost(config.serverUrl, { log: opts.log, ...opts.host });
    const daemon = new ArenaDaemon({ home, config, walletKey, lobby: host.lobby, relay: host.relay, log: opts.log });
    await daemon.start();
    // 127.0.0.1 only: `host` is deliberately not configurable here (spec §6.1).
    const { server, url } = await startApi(daemon, { port: config.port, token });
    let stopped = false;
    return {
      daemon, apiUrl: url, host,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
        await daemon.stop();
        host.close();
        lock.release();
      },
    };
  } catch (err) {
    lock.release();
    throw err;
  }
}
```

The partial-start cleanup inside the catch must also stop anything already started (daemon, host). Keep references and clean up in reverse order.

In `cli.ts`:
- `daemon` and `daemon start` call `startDaemonProcess(home, { log: io.err })`, then print `JSON.stringify({ api: apiUrl, pid: process.pid, wallet: daemon.wallet.address })`. They then wait for `SIGINT`/`SIGTERM` (via `process.once`), call `stop()` and return 0.
- Update `USAGE`: `init --server URL [--rpc URL --chain-id N --hub ADDR --usdc ADDR --rules ADDR] …` and `daemon [start]`.

`init`:
- When `--hub`, `--usdc`, `--rules`, `--chain-id` and `--rpc` are not all given, fetch `${server}/templates` with `io.fetch`. Pick the entry with `id === "chess"`, or fail with `UsageError("server ${server} offers no chess template")`.
- Fill the missing fields from it; explicit flags win. Validate the addresses with `/^0x[0-9a-fA-F]{40}$/`.
- Set `logChunkBlocks` from `--log-chunk-blocks` (default 1000).

Export `connectHost`, `acquireHomeLock` and `startDaemonProcess` from `src/index.ts`. Update `packages/cli/README.md`: `arena init --server`, `arena daemon`, the lock, and the server URL.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @arena/cli test && pnpm --filter @arena/cli typecheck && pnpm --filter @arena/server test && pnpm --filter @arena/server typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli apps/server/test/transport.test.ts
git commit -m "feat(cli): WebSocket/HTTP host transports with reconnect, arena daemon, ARENA_HOME lock, init from /templates"
```

---

### Task 8: End-to-end over the real server, docs, spec amendments

**Files:**
- Create: `apps/server/test/e2e.test.ts`, `apps/server/README.md`
- Modify:
  - `docs/superpowers/specs/2026-09-24-agent-chess-arena-design.md` (§12 new items 15–18, plus the §3 Node floor);
  - `contracts/README.md` (link to the server README), only if it has a "running locally" section.

**Interfaces:**
- Consumes everything above: `startServer`, `RpcChainReader`, `startDaemonProcess`, `initHome`, `deployArena`, `mintUsdc`, `usdcBalance`, `SCHOLARS_MATE`, `ANVIL_KEYS`.

- [ ] **Step 1: Write the e2e tests** (`apps/server/test/e2e.test.ts`)

Harness: `deployArena()` then `startServer(testConfig({ rpcUrl: RPC, chainId, hub, usdc, rules, indexer: { pollMs: 200, chunkBlocks: 50, startBlock: 0n } }))` with a **real** `RpcChainReader` (no `chain` dep). Then, for each of Alice (`ANVIL_KEYS[1]`) and Bob (`ANVIL_KEYS[2]`):
- `mkdtemp` a home;
- `initHome(home, { rpcUrl: RPC, chainId, hub, usdc, rules, serverUrl: server.url, port: 0, maxFeePerPlayer: 10_000n, sessionGasWei: 10n ** 16n, pollMs: 200, logChunkBlocks: 50 }, key)`;
- `mintUsdc(usdc, address, START)`;
- `startDaemonProcess(home, { host: { minBackoffMs: 50, maxBackoffMs: 500 } })`.

Drive the players through `proc.daemon` (the same API the CLI uses). Reuse the `playLine` helper from `packages/cli/test/e2e.test.ts` (copy it; import paths differ).

```ts
it("two daemons over the real server: match → 3 games → cooperative close → balances, fee and reputation", async () => {
  // alice.createOffer; bob.acceptOffer; channel opens; games 0,1,2 via SCHOLARS_MATE alternating white
  // (game 0 Alice white, game 1 Bob white, game 2 Alice white); after game 2, both close; Finalized.
  // Balances: Alice won 2, Bob won 1 → Alice START + 100_000 - 5_000, Bob START - 100_000 - 5_000, host 10_000.
  // Reputation: await waitFor(async () => (await (await fetch(`${server.url}/players/${alice.address}`)).json()).finalized === 1);
  // expect games === 3, channels === 1. /api/channels/:id → phase "Finalized".
});

it("relay drop mid-game: moves made during the outage are delivered after reconnect", async () => {
  // open channel; alice e4 → bob sees; server.dropConnections(); immediately bob e5 (send may fail);
  // await waitFor(alice isMyTurn) (delivered via Bob's onJoined re-send or the server cache replay);
  // alice Nf3 → bob sees; both lastError eventually null.
});

it("offline offerer: a match made while the offerer's daemon is down is replayed when it restarts", async () => {
  // alice.createOffer; await alice.stop(); bob.acceptOffer (server matches; bob's daemon waits for Alice's deposit);
  // restart alice with startDaemonProcess(aliceHome) → lobby.watch(pending offers) replays the match → Alice funds → Open.
});

it("refuses a second daemon on the same ARENA_HOME", async () => {
  await expect(startDaemonProcess(aliceHome)).rejects.toThrow(/another arena daemon/);
});
```

Each test cleans up in `afterEach`: stop both daemon processes, then `server.close()`.

- [ ] **Step 2: Run the e2e**

Run: `pnpm --filter @arena/server exec vitest run test/e2e.test.ts`
Expected: PASS. If a scenario fails, debug the component at fault (use superpowers:systematic-debugging). Never weaken an assertion to make it pass.

- [ ] **Step 3: Spec amendments** (§12, append after the last item; keep the house style)

15. **Node floor.** The host server uses `node:sqlite`, so the workspace requires Node ≥ 24; this supersedes §3's "Node ≥ 20".
16. **One WebSocket endpoint.** `GET /ws` multiplexes lobby match events and relay traffic, and replaces §5's `WS /lobby` and `WS /relay/:channelId`.
    - Each connection receives a random nonce in its `hello` frame.
    - A relay `join` carries the channel's `Params` (self-certifying: the server recomputes `channelId`) and a session-key signature over `keccak256(abi.encode("arena-relay-join", channelId, nonce))`.
    - Lobby `subscribe` frames name offer ids and are unauthenticated: a match event only reveals params that become public on-chain at deposit.
    - The server persists matches and replays them on subscribe, so an offerer who was offline at match time still funds.
17. **Relay cache.** The relay keeps the latest `state` and `close` message per channel and sender. It accepts a state only if it carries a valid signature of its sender, and replays the peer's cached messages to a (re)joining member.
    - Daemons re-send their latest own-signed state, a pending own new-game proposal, and their Close signature every time a join is confirmed.
    - `ChannelSession.receive` answers re-sent messages with `duplicate`/`stale` instead of an error. A different state at the latest turn remains an error.
18. **Dispute scan cursor.** Daemons scan `Challenged`/`Responded` events forward from a persisted per-channel cursor, in chunks of `logChunkBlocks` (default 1000). They never advance past an event that failed to ingest, and a `getLogs` failure does not stop the rest of the watchtower pass. The server indexer uses the same chunked-cursor pattern over all hub events.

Also update §3's table row 4 location, `apps/server`, which is unchanged, and add "(Node ≥ 24, see §12 item 15)" after "TypeScript on Node ≥ 20".

- [ ] **Step 4: `apps/server/README.md`**

It covers:
- what the server does;
- running it with `node apps/server/bin/arena-server.mjs --config server.json`, with an example config for the local Anvil deployment and the fields from `ServerConfig`;
- the routes table;
- the frame protocol (hello/subscribe/join/relay/match/joined/error);
- the trust model (untrusted plumbing);
- limits and metrics.

- [ ] **Step 5: Full verification**

Run: `pnpm test:contracts && pnpm test:sdk && pnpm test:cli && pnpm test:server`
Then: `pnpm --filter @arena/sdk typecheck && pnpm --filter @arena/cli typecheck && pnpm --filter @arena/server typecheck`
Expected: every suite green. Report the exact counts.

- [ ] **Step 6: Commit**

```bash
git add apps/server docs/superpowers/specs/2026-09-24-agent-chess-arena-design.md contracts/README.md
git commit -m "test(server): end-to-end over the real host server; docs; spec §12 items 15-18"
```

---

## Out of scope (deferred to Plan 5 or later, recorded so nobody half-builds them here)

- The web board and handoff UI (`/board` on the daemon), `pnpm dev:up`, LLM-agent e2e: Plan 5.
- Session-key gas sweep after finalize or abandon; claiming the `owed` fallback; back-off for the `opponent-silent` wait loop: Plan 5 (daemon polish alongside the board).
- `CircleCliTxSender`, Arc Testnet: Plan 6.
- Postgres repository and a trusted-proxy `X-Forwarded-For` mode: post-v1.
