# Arena Player Daemon + CLI Implementation Plan (Plan 3 of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@arena/cli`, the program an AI agent (or a human) runs to play in the arena:
- a long-running **player daemon** that owns session keys, funds channels, exchanges signed states with the opponent, runs the **watchtower**, and supports **agent ↔ human handoff**;
- a thin `arena` **CLI** that talks to the daemon's local HTTP API.

It also finishes the SDK items carried over from Plan 2.

**Architecture:**
- **Transport-agnostic daemon.** The daemon talks to the host only through two interfaces defined in the SDK (`LobbyClient`, `RelayClient`). Plan 4 implements them over HTTP/WebSocket. This plan tests them with an in-process `MemoryArena` test double that uses the same SDK matching code (`buildParams`, offer/acceptance signing) the real server will use.
- **Per-channel state.** Each channel has a `ChannelSession` persisted through an atomic file store, plus a JSON channel record (params, role, controller, session key).
- **Watchtower.** A polling watchtower reads hub state and events, funds in the right order, answers stale challenges, auto-resigns when checkmated, claims stalemate, calls `timeout`/`reclaim`, and ingests on-chain states.
- **Local API.** A token-protected HTTP API on 127.0.0.1 exposes status, long-poll `wait`, and actions. Every action carries an actor (`agent` | `human`), and the per-channel controller decides which actor may play.

**Tech Stack:** TypeScript ESM (tsx, no build), viem 2.56.8, chess.js 1.4.0, node:http, vitest 5.0.1 + Anvil (reusing `packages/sdk/test` helpers and global setup), pnpm 12.6.0 workspace.

**Spec:** `docs/superpowers/specs/2026-09-24-agent-chess-arena-design.md`. Read §3, §5 (funding order, param verification), §6 (daemon, CLI, handoff, watchtower), §7, §9 and §12 (items 9, 13 and 14 especially). Also read `packages/sdk/README.md` for the SDK API and its rules.

## Global Constraints

- JS deps pinned exactly as in `packages/sdk` (`viem@2.56.8`, `chess.js@1.4.0`, `vitest@5.0.1`, `typescript@6.0.3`, `@types/node@25.9.8`, `tsx@4.23.15`). Never bypass pnpm's minimum-release-age gate.
- ESM, NodeNext, relative imports end in `.js`, no build step; the package entry is `./src/index.ts`, and the `arena` bin runs through tsx.
- The daemon API binds **127.0.0.1 only** and requires `Authorization: Bearer <token>` (token file in `ARENA_HOME`, mode 0600) on every route except `GET /health`.
- Files under `ARENA_HOME` (session keys, wallet key, token, snapshots) are written atomically (temp file + fsync + rename) with mode **0600**; directories are 0700.
- **Protocol rules** (spec §12, SDK README). The daemon never works around the session: all signing goes through `ChannelSession`. Beyond that:
  - Close is signed only on finished games.
  - Dispute transactions (`challenge`, `respond`, `timeout`) are sent from the channel's **session key**, which is topped up with gas at funding.
  - `deposit`/`approve` are sent from the wallet.
- **Funding order** (spec §5): the offerer (`participants[0]`) deposits first. The accepter deposits only after the chain shows `funded[0]`. Before depositing, each daemon verifies that `Params` names its own wallet and session key, the configured rules address, and the agreed amounts, and that the fee equals the hub's current fee config (capped by `maxFeePerPlayer`).
- **Handoff:** move-type actions are accepted only from the actor equal to the channel's `controller`. The watchtower acts regardless of the controller.
- Every commit message ends with a `Co-Authored-By:` trailer naming the model that wrote it.

## Review Focus

1. **Double-deposit or wrong-order funding.** The accepter must never deposit before `funded[0]`, and a restart must not deposit twice. Covered by the Task 6 funding checks (`chain phase decides funding`) and the Task 8 restart test.
2. **Watchtower forfeiting the honest player.** It must never call `timeout` when this player is the one on move in the registered state. It must answer stale challenges automatically. Covered by Task 6 unit tests and the Task 8 stale-challenge e2e test.
3. **Handoff bypass.** An agent move while the human controls the channel must be rejected, including through `wait`-driven loops. Covered by the Task 8 handoff test.
4. **API exposed beyond localhost, or without the token.** Covered by the Task 7 tests (`binds 127.0.0.1`, `401 without token`).
5. **Crash between signing and sending.** On restart the daemon resumes from the file store without re-signing a turn, and resends its latest own state. Covered by the Task 8 restart test and Task 1's `ChannelSession.open`.

---

## File Structure

```
packages/sdk/src/session.ts        # (Task 1) N1 fix, late-countersign repair, proof guard, open()/restore validation
packages/sdk/src/store.ts          # (Task 1) LoadableSessionStore; MemoryStore.load
packages/sdk/src/tx.ts             # (Task 1) optional `value` on TxSender.send
packages/sdk/src/hub.ts            # (Task 2) HubClient.feeConfig()
packages/sdk/src/wire.ts           # (Task 2) bigint JSON codec, offers/acceptances, buildParams, checkMatchParams, LobbyClient/RelayClient
packages/sdk/test/session.test.ts  # (Task 1) new tests
packages/sdk/test/wire.test.ts     # (Task 2)
docs/superpowers/specs/2026-09-24-agent-chess-arena-design.md   # (Task 1) §12 item 14 amendment
packages/cli/
  package.json, tsconfig.json, vitest.config.ts, README.md
  bin/arena.mjs                    # tsx launcher
  src/index.ts                     # exports
  src/main.ts                      # process entry for the bin
  src/jsonfile.ts                  # atomic 0600 JSON (bigint-safe)
  src/config.ts                    # ARENA_HOME layout, init, load
  src/fileStore.ts                 # FileSessionStore (LoadableSessionStore)
  src/records.ts                   # channel + offer records
  src/status.ts                    # ChannelStatus builder (pure)
  src/daemon.ts                    # ArenaDaemon: lobby, funding, relay, actions, watchtower, wait
  src/api.ts                       # local HTTP API
  src/cli.ts                       # `arena` command parser → API
  test/helpers/memoryArena.ts      # in-process LobbyClient/RelayClient test double
  test/helpers/harness.ts          # Anvil + two daemons
  test/files.test.ts               # Task 3
  test/status.test.ts              # Task 5
  test/daemon.test.ts              # Tasks 4 and 6
  test/api.test.ts                 # Task 7
  test/cli.test.ts                 # Task 7
  test/e2e.test.ts                 # Task 8
package.json                       # root: "test:cli"
```

---

### Task 1: SDK must-fixes carried from Plan 2

**Files:**
- Modify: `packages/sdk/src/session.ts`, `packages/sdk/src/store.ts`, `packages/sdk/src/tx.ts`
- Modify: `docs/superpowers/specs/2026-09-24-agent-chess-arena-design.md` (§12 item 14)
- Test: `packages/sdk/test/session.test.ts` (append)

**Interfaces:**
- Produces:
  - `interface LoadableSessionStore extends SessionStore { load(): Promise<SessionSnapshot | null> }`; `MemoryStore` implements it.
  - `static ChannelSession.open(cfg: SessionConfig & { store: LoadableSessionStore }): Promise<ChannelSession>`: restores the snapshot if the store has one, otherwise creates.
  - `ChannelSession.receive(...)` may also resolve `"checkpoint-repaired"`.
  - `TxSender.send(tx: { to: Address; data: Hex; value?: bigint })`.

**Background (N1, from the Plan 2 final review):**
- Rule R9 accepts the opponent's move `C+1` on this player's pending checkpoint `C`. If `C+1` is a finished game (the only possibility is a RESIGN on move 1) and it arrives through `receive`, the player is left holding `prev = C` signed only by themselves.
- `challengeProof()` then yields a proof the hub rejects (`Unsupported`), and there is no further move to make. Funds stay locked until the opponent acts.
- The reviewer's reproduction: `/tmp/claude-1000/sdk-rereview/zz-rereview-poc3.keep.ts` (may no longer exist; the tests below cover it).

- [ ] **Step 1: Write the failing tests**

Append to `packages/sdk/test/session.test.ts` (inside the existing `describe("ChannelSession", …)` block; `setup`, `play`, `finishGame`, `SCHOLARS_MATE` already exist in that file):
```ts
  it("does not adopt a finished game on an uncountersigned checkpoint (N1)", async () => {
    const { a, b } = await setup();
    await finishGame(a, b); // A white wins game 0
    const terminal = a.latest;
    const proposal = await a.proposeNewGame();
    await b.receive(proposal);
    const full = await b.countersignNewGame(); // withheld from A for now
    const resign = await b.resign(); // B is white in game 1 and resigns on move 1
    await expect(a.receive(resign)).rejects.toThrow(/countersign/);
    expect(a.latest).toEqual(terminal); // A keeps a provable state
    expect(a.challengeProof().latest).toEqual(terminal);
    // Once the countersignature arrives, the resignation is accepted normally.
    expect(await a.receive(full)).toBe("checkpoint-complete");
    expect(await a.receive(resign)).toBe("move");
  });

  it("repairs prev with a late countersignature after adopting a move on its own checkpoint", async () => {
    const { a, b } = await setup();
    await finishGame(a, b);
    await b.receive(await a.proposeNewGame());
    const full = await b.countersignNewGame(); // withheld
    const e4 = await b.move("e2e4");
    expect(await a.receive(e4)).toBe("move"); // R9 adoption
    expect(() => a.challengeProof()).toThrow(/countersign/);
    expect(await a.receive(full)).toBe("checkpoint-repaired");
    const proof = a.challengeProof();
    expect(proof.hasPrev).toBe(true);
    expect(proof.prev.sigA).not.toBe("0x");
    expect(proof.prev.sigB).not.toBe("0x");
    expect(proof.latest.state).toEqual(e4.state);
  });

  it("opens from a loadable store: create first, restore afterwards", async () => {
    const { cfgA } = await setup();
    const store = new MemoryStore();
    const first = await ChannelSession.open({ ...cfgA, store });
    await first.move("e2e4");
    const second = await ChannelSession.open({ ...cfgA, store });
    expect(second.latest).toEqual(first.latest);
    expect(second.snapshot().lastSignedTurn).toBe(1n);
    await expect(second.move("d2d4")).rejects.toThrow(/not your turn/);
  });

  it("restores snapshots without closeSigTargets and rejects malformed ones", async () => {
    const { a, cfgA } = await setup();
    const snap = a.snapshot() as Partial<ReturnType<typeof a.snapshot>>;
    delete snap.closeSigTargets;
    const restored = ChannelSession.restore(cfgA, snap as ReturnType<typeof a.snapshot>);
    await expect(restored.move("e2e4")).resolves.toBeDefined();
    const bad = { ...a.snapshot(), lastSignedTurn: "1" as unknown as bigint };
    expect(() => ChannelSession.restore(cfgA, bad)).toThrow(ArenaProtocolError);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/sdk && export PATH="$HOME/.foundry/bin:$HOME/.local/bin:$PATH" && pnpm test -- test/session.test.ts`
Expected: the 4 new tests FAIL: `open` is not a function; N1 is accepted as "move"; there is no "checkpoint-repaired"; the missing `closeSigTargets` throws a TypeError on the first mutation.

- [ ] **Step 3: Implement**

`packages/sdk/src/store.ts`: add after `SessionStore`:
```ts
/** A per-channel store that can also read back the last saved snapshot (file store in the daemon). */
export interface LoadableSessionStore extends SessionStore {
  load(): Promise<SessionSnapshot | null>;
}
```
and make `MemoryStore` implement it:
```ts
export class MemoryStore implements LoadableSessionStore {
  readonly snapshots: SessionSnapshot[] = [];

  async save(snapshot: SessionSnapshot): Promise<void> {
    this.snapshots.push(structuredClone(snapshot));
  }

  async load(): Promise<SessionSnapshot | null> {
    const last = this.snapshots.at(-1);
    return last ? structuredClone(last) : null;
  }

  get last(): SessionSnapshot | undefined {
    return this.snapshots.at(-1);
  }
}
```

`packages/sdk/src/tx.ts`: change the interface and the implementation to carry an optional value:
```ts
export interface TxSender {
  readonly address: Address;
  send(tx: { to: Address; data: Hex; value?: bigint }): Promise<Hex>;
}
```
```ts
  send(tx: { to: Address; data: Hex; value?: bigint }): Promise<Hex> {
    return this.wallet.sendTransaction({
      account: this.account,
      chain: this.chain,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
  }
```

`packages/sdk/src/session.ts` (see the full current file before editing):

1. Import `LoadableSessionStore` alongside `SessionSnapshot, SessionStore` from `./store.js`.

2. Add `open` after `restore`, and validate snapshots in `restore`:
```ts
  /** Restores this channel's session from `store` if it has a snapshot, otherwise creates it (crash-safe start). */
  static async open(cfg: SessionConfig & { store: LoadableSessionStore }): Promise<ChannelSession> {
    const snapshot = await cfg.store.load();
    return snapshot ? ChannelSession.restore(cfg, snapshot) : ChannelSession.create(cfg);
  }

  static restore(cfg: SessionConfig, snapshot: SessionSnapshot): ChannelSession {
    const expected = channelId(cfg.domain.chainId, cfg.domain.hub, cfg.params);
    const data = normalizeSnapshot(snapshot);
    if (data.channelId !== expected) {
      throw new ArenaProtocolError("snapshot channelId does not match params/domain");
    }
    return new ChannelSession(cfg, data);
  }
```
and add this module-level function above the class:
```ts
/** Validates a snapshot read from storage and fills fields added after it was written. Throws on malformed data. */
function normalizeSnapshot(raw: SessionSnapshot): SessionSnapshot {
  const s = structuredClone(raw) as Partial<SessionSnapshot>;
  const isSigned = (x: unknown): x is SignedState =>
    typeof x === "object" && x !== null && "state" in x && typeof (x as SignedState).sigA === "string";
  const ok =
    typeof s.channelId === "string" &&
    isSigned(s.latest) &&
    (s.prev === null || isSigned(s.prev)) &&
    (s.pendingCheckpoint === null || isSigned(s.pendingCheckpoint)) &&
    (s.incomingCheckpoint === null || isSigned(s.incomingCheckpoint)) &&
    (s.lastSignedTurn === null || typeof s.lastSignedTurn === "bigint") &&
    (s.closeState === null || isSigned(s.closeState)) &&
    Array.isArray(s.closeSigs) &&
    s.closeSigs.length === 2;
  if (!ok) throw new ArenaProtocolError("malformed session snapshot");
  if (!Array.isArray(s.closeSigTargets) || s.closeSigTargets.length !== 2) {
    s.closeSigTargets = [ZERO_HASH, ZERO_HASH];
  }
  return s as SessionSnapshot;
}
```

3. In `classifyIncoming`, handle the late countersignature **before** the pending-checkpoint branch, and refuse adopting a finished game in the pending branch:
```ts
    const prevSigned = draft.prev;
    if (
      prevSigned &&
      isCheckpoint(prevSigned.state) &&
      !this.endorsed(prevSigned) &&
      s.turnNum === prevSigned.state.turnNum &&
      hashState(s, this.domain) === hashState(prevSigned.state, this.domain)
    ) {
      // A late countersignature for the checkpoint this player adopted a move on (R9): repair `prev`.
      const oppSig = this.opponent === 0 ? sigA : sigB;
      if (!(await this.signedBy(this.opponent, prevSigned.state, oppSig))) {
        throw new ArenaProtocolError("missing or invalid opponent signature");
      }
      const repaired: SignedState =
        this.opponent === 0 ? { ...prevSigned, sigA: oppSig } : { ...prevSigned, sigB: oppSig };
      return { kind: "checkpoint-repaired", signed: repaired };
    }
    const pending = draft.pendingCheckpoint;
    if (pending && s.turnNum === pending.state.turnNum + 1n) {
      const r = await this.moveOnPending(pending, s, sigA, sigB);
      if (!r.ok) throw new ArenaProtocolError(r.reason);
      if (isGameOver(r.signed.state)) {
        // N1: adopting a finished game here would leave `prev` a checkpoint signed only by this player, which the
        // hub rejects as a proof and which no further move can repair. Stay at the terminal state (provable)
        // until the countersignature arrives.
        throw new ArenaProtocolError(
          "refusing a finished game on a new-game checkpoint the opponent has not countersigned; waiting for the countersignature",
        );
      }
      return { kind: "on-pending", pending, signed: r.signed };
    }
```
Update the return type union of `classifyIncoming` to include `"checkpoint-repaired"` in the second member. In `receive`, handle it:
```ts
        case "checkpoint-repaired":
          draft.prev = v.signed;
          break;
```
and widen `receive`'s declared result to `Promise<"move" | "checkpoint-proposed" | "checkpoint-complete" | "checkpoint-repaired">`.

4. In `challengeProof()`, before returning the `hasPrev: true` proof:
```ts
    const prev = this.data.prev;
    if (isCheckpoint(prev.state) && !this.endorsed(prev)) {
      throw new ArenaProtocolError(
        "the new-game checkpoint before the latest state lacks the opponent's countersignature; make your next move first or wait for the countersignature",
      );
    }
```
(Keep the existing `if (!this.data.prev)` check first; adapt variable names to the existing code.)

`ingestOnChain` keeps accepting a finished game on a pending checkpoint. There the hub has already registered `C+1`, so `timeout` settles at `C+1`, which favours this player. Do not change it.

5. Spec: in §12 item 14, append this sentence to the end of the item: `Exception: if C+1 is a finished game (a resignation on move 1) and arrives off-chain, the proposer does not adopt it until the countersignature arrives, because C signed by only one player cannot anchor a proof and no further move can repair it; a late countersignature received after adopting a non-terminal C+1 repairs the stored predecessor.`

- [ ] **Step 4: Run tests and typecheck**

Run: `cd packages/sdk && pnpm test && pnpm typecheck`
Expected: all SDK suites PASS (74 existing + 4 new = 78), typecheck clean, `pgrep -a anvil` empty afterwards. If an existing test now fails because of the N1 rule, the test was relying on adopting a finished game on an uncountersigned checkpoint. Decide against the spec amendment above, and explain any change in the report.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk docs/superpowers/specs/2026-09-24-agent-chess-arena-design.md
git commit -m "fix(sdk): refuse terminal moves on uncountersigned checkpoints; repair prev; crash-safe open()"
```
(End with your `Co-Authored-By:` trailer.)

---

### Task 2: SDK wire protocol: codec, offers, matching, transport interfaces

**Files:**
- Create: `packages/sdk/src/wire.ts`
- Modify: `packages/sdk/src/hub.ts` (add `feeConfig`), `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/wire.test.ts`

**Interfaces:**
- Produces from `wire.ts`:
  - JSON codec: `toWire(value: unknown): string`, `fromWire<T>(text: string): T` (bigint-safe via `{"$bigint":"…"}`).
  - Offers:
    - `type Offer = { template: "chess"; player: Address; signer: Address; deposit: bigint; stakePerGame: bigint; challengeTimeout: bigint; expiresAt: bigint; nonce: Hex }`
    - `type SignedOffer = { offer: Offer; sig: Hex }`
    - `offerId(o: Offer): Hex`, `signOffer(key: Hex, o: Offer): Promise<Hex>`, `verifyOffer(so: SignedOffer): Promise<boolean>`
  - Acceptances:
    - `type Acceptance = { offerId: Hex; player: Address; signer: Address; nonce: Hex }`
    - `type SignedAcceptance = { acceptance: Acceptance; sig: Hex }`
    - `acceptanceDigest(a: Acceptance): Hex`, `signAcceptance(key: Hex, a: Acceptance): Promise<Hex>`, `verifyAcceptance(sa: SignedAcceptance): Promise<boolean>`
  - Matching:
    - `type MatchTerms = { rules: Address; feeRecipient: Address; feePerPlayer: bigint; fundingWindow: bigint }`
    - `buildParams(o: Offer, a: Acceptance, terms: MatchTerms, now: bigint): Params`
    - `type MatchExpectation = { me: PlayerIndex; player: Address; signer: Address; rules: Address; deposit: bigint; stakePerGame: bigint; challengeTimeout: bigint; feeRecipient: Address; minFeePerPlayer: bigint; maxFeePerPlayer: bigint }`
    - `checkMatchParams(p: Params, e: MatchExpectation): string | null`
  - Messages:
    - `type RelayMessage = { type: "state"; channelId: Hex; signed: SignedState } | { type: "close"; channelId: Hex; close: CloseSignature }`
    - `type MatchEvent = { offerId: Hex; params: Params }`
  - Transport interfaces:
    - `interface LobbyClient { postOffer(so): Promise<Hex>; listOffers(): Promise<SignedOffer[]>; accept(sa): Promise<void>; onMatch(h: (m: MatchEvent) => void): () => void }`
    - `interface RelayClient { join(channelId: Hex, sessionKey: Hex): Promise<void>; send(msg: RelayMessage): Promise<void>; onMessage(h: (m: RelayMessage) => void): () => void }`
- Produces from `hub.ts`: `HubClient.feeConfig(): Promise<{ feePerPlayer: bigint; feeRecipient: Address }>`.

- [ ] **Step 1: Write the failing test**

`packages/sdk/test/wire.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { keccak256, toHex, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  buildParams,
  checkMatchParams,
  fromWire,
  offerId,
  signAcceptance,
  signOffer,
  toWire,
  verifyAcceptance,
  verifyOffer,
  type Acceptance,
  type MatchTerms,
  type Offer,
} from "../src/index.js";

const ALICE: Address = "0x00000000000000000000000000000000000000a1";
const BOB: Address = "0x00000000000000000000000000000000000000b2";
const TERMS: MatchTerms = {
  rules: "0x00000000000000000000000000000000000000e5",
  feeRecipient: "0x00000000000000000000000000000000000000f6",
  feePerPlayer: 5_000n,
  fundingWindow: 3600n,
};

function offerFor(key: `0x${string}`): Offer {
  return {
    template: "chess",
    player: ALICE,
    signer: privateKeyToAccount(key).address,
    deposit: 1_000_000n,
    stakePerGame: 100_000n,
    challengeTimeout: 600n,
    expiresAt: 2_000_000_000n,
    nonce: keccak256(toHex("n1")),
  };
}

describe("wire", () => {
  it("round-trips bigints through the JSON codec", () => {
    const v = { a: 1n, b: [2n, { c: 3n }], d: "x", e: null, f: 7 };
    expect(fromWire(toWire(v))).toEqual(v);
    expect(toWire({ a: 10n })).toBe('{"a":{"$bigint":"10"}}');
  });

  it("signs and verifies offers and acceptances by their session keys", async () => {
    const aKey = generatePrivateKey();
    const bKey = generatePrivateKey();
    const offer = offerFor(aKey);
    const so = { offer, sig: await signOffer(aKey, offer) };
    expect(await verifyOffer(so)).toBe(true);
    expect(await verifyOffer({ ...so, offer: { ...offer, deposit: 2n } })).toBe(false);
    expect(await verifyOffer({ offer, sig: await signOffer(bKey, offer) })).toBe(false);

    const acc: Acceptance = { offerId: offerId(offer), player: BOB, signer: privateKeyToAccount(bKey).address, nonce: keccak256(toHex("n2")) };
    expect(await verifyAcceptance({ acceptance: acc, sig: await signAcceptance(bKey, acc) })).toBe(true);
    expect(await verifyAcceptance({ acceptance: { ...acc, player: ALICE }, sig: await signAcceptance(bKey, acc) })).toBe(false);
  });

  it("builds params and checks them from each side", async () => {
    const aKey = generatePrivateKey();
    const bKey = generatePrivateKey();
    const offer = offerFor(aKey);
    const acc: Acceptance = { offerId: offerId(offer), player: BOB, signer: privateKeyToAccount(bKey).address, nonce: keccak256(toHex("n2")) };
    const p = buildParams(offer, acc, TERMS, 1_000n);
    expect(p.participants).toEqual([ALICE, BOB]);
    expect(p.signers).toEqual([offer.signer, acc.signer]);
    expect(p.fundingDeadline).toBe(4_600n);
    expect(p.salt).toMatch(/^0x[0-9a-f]{64}$/);

    const base = {
      rules: TERMS.rules,
      deposit: offer.deposit,
      stakePerGame: offer.stakePerGame,
      challengeTimeout: offer.challengeTimeout,
      feeRecipient: TERMS.feeRecipient,
      minFeePerPlayer: 5_000n,
      maxFeePerPlayer: 10_000n,
    };
    expect(checkMatchParams(p, { ...base, me: 0, player: ALICE, signer: offer.signer })).toBeNull();
    expect(checkMatchParams(p, { ...base, me: 1, player: BOB, signer: acc.signer })).toBeNull();
    expect(checkMatchParams(p, { ...base, me: 1, player: BOB, signer: offer.signer })).toMatch(/session key/);
    expect(checkMatchParams({ ...p, rules: BOB }, { ...base, me: 0, player: ALICE, signer: offer.signer })).toMatch(/rules/);
    expect(checkMatchParams({ ...p, feePerPlayer: 20_000n }, { ...base, me: 0, player: ALICE, signer: offer.signer })).toMatch(/fee/);
    expect(checkMatchParams({ ...p, deposit: 1n }, { ...base, me: 0, player: ALICE, signer: offer.signer })).toMatch(/amount/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/sdk && pnpm test -- test/wire.test.ts`
Expected: FAIL: the exports are missing.

- [ ] **Step 3: Implement**

`packages/sdk/src/wire.ts`:
```ts
import { encodeAbiParameters, keccak256, recoverMessageAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { CloseSignature } from "./session.js";
import type { Params, PlayerIndex, SignedState } from "./types.js";

// ---------------------------------------------------------------- JSON codec

/** JSON with bigints encoded as {"$bigint":"<decimal>"} so protocol values survive the wire and disk. */
export function toWire(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? { $bigint: v.toString() } : v));
}

export function fromWire<T>(text: string): T {
  return JSON.parse(text, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.$bigint === "string") {
      return BigInt(v.$bigint);
    }
    return v;
  }) as T;
}

// -------------------------------------------------------------- offers

export type Offer = {
  template: "chess";
  player: Address;
  signer: Address;
  deposit: bigint;
  stakePerGame: bigint;
  challengeTimeout: bigint;
  expiresAt: bigint;
  nonce: Hex;
};
export type SignedOffer = { offer: Offer; sig: Hex };

export type Acceptance = { offerId: Hex; player: Address; signer: Address; nonce: Hex };
export type SignedAcceptance = { acceptance: Acceptance; sig: Hex };

export function offerId(o: Offer): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "bytes32" },
      ],
      [o.template, o.player, o.signer, o.deposit, o.stakePerGame, o.challengeTimeout, o.expiresAt, o.nonce],
    ),
  );
}

export function acceptanceDigest(a: Acceptance): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "bytes32" }],
      [a.offerId, a.player, a.signer, a.nonce],
    ),
  );
}

/** Signed by the offer's session key (EIP-191 over offerId), proving the offerer controls `signer`. */
export function signOffer(key: Hex, o: Offer): Promise<Hex> {
  return privateKeyToAccount(key).signMessage({ message: { raw: offerId(o) } });
}

export async function verifyOffer(so: SignedOffer): Promise<boolean> {
  try {
    const who = await recoverMessageAddress({ message: { raw: offerId(so.offer) }, signature: so.sig });
    return who.toLowerCase() === so.offer.signer.toLowerCase();
  } catch {
    return false;
  }
}

export function signAcceptance(key: Hex, a: Acceptance): Promise<Hex> {
  return privateKeyToAccount(key).signMessage({ message: { raw: acceptanceDigest(a) } });
}

export async function verifyAcceptance(sa: SignedAcceptance): Promise<boolean> {
  try {
    const who = await recoverMessageAddress({ message: { raw: acceptanceDigest(sa.acceptance) }, signature: sa.sig });
    return who.toLowerCase() === sa.acceptance.signer.toLowerCase();
  } catch {
    return false;
  }
}

// -------------------------------------------------------------- matching

export type MatchTerms = { rules: Address; feeRecipient: Address; feePerPlayer: bigint; fundingWindow: bigint };

/** The host's matching rule (spec §5): offerer is participants[0] and deposits first. */
export function buildParams(o: Offer, a: Acceptance, terms: MatchTerms, now: bigint): Params {
  return {
    participants: [o.player, a.player],
    signers: [o.signer, a.signer],
    rules: terms.rules,
    feeRecipient: terms.feeRecipient,
    feePerPlayer: terms.feePerPlayer,
    deposit: o.deposit,
    stakePerGame: o.stakePerGame,
    challengeTimeout: o.challengeTimeout,
    fundingDeadline: now + terms.fundingWindow,
    salt: keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [a.offerId, a.nonce])),
  };
}

export type MatchExpectation = {
  me: PlayerIndex;
  player: Address;
  signer: Address;
  rules: Address;
  deposit: bigint;
  stakePerGame: bigint;
  challengeTimeout: bigint;
  feeRecipient: Address;
  minFeePerPlayer: bigint;
  maxFeePerPlayer: bigint;
};

const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();

/** Returns why these params must not be funded by the expecting player, or null if they are acceptable. */
export function checkMatchParams(p: Params, e: MatchExpectation): string | null {
  if (!same(p.participants[e.me], e.player)) return "params do not name this player's wallet";
  if (!same(p.signers[e.me], e.signer)) return "params do not name this player's session key";
  if (same(p.participants[0], p.participants[1]) || same(p.signers[0], p.signers[1])) return "participants or signers repeat";
  if (!same(p.rules, e.rules)) return "unexpected rules contract";
  if (p.deposit !== e.deposit || p.stakePerGame !== e.stakePerGame || p.challengeTimeout !== e.challengeTimeout) {
    return "amounts differ from the agreed offer";
  }
  if (!same(p.feeRecipient, e.feeRecipient)) return "unexpected fee recipient";
  if (p.feePerPlayer < e.minFeePerPlayer || p.feePerPlayer > e.maxFeePerPlayer) return "unexpected fee";
  return null;
}

// -------------------------------------------------------------- messages and transports

export type RelayMessage =
  | { type: "state"; channelId: Hex; signed: SignedState }
  | { type: "close"; channelId: Hex; close: CloseSignature };

export type MatchEvent = { offerId: Hex; params: Params };

/** Lobby side of the host (Plan 4 implements it over HTTP/WebSocket). */
export interface LobbyClient {
  postOffer(so: SignedOffer): Promise<Hex>;
  listOffers(): Promise<SignedOffer[]>;
  accept(sa: SignedAcceptance): Promise<void>;
  onMatch(handler: (m: MatchEvent) => void): () => void;
}

/** Relay side of the host: forwards signed messages between a channel's two session keys. */
export interface RelayClient {
  join(channelId: Hex, sessionKey: Hex): Promise<void>;
  send(msg: RelayMessage): Promise<void>;
  onMessage(handler: (msg: RelayMessage) => void): () => void;
}
```

In `packages/sdk/src/hub.ts`, add to `HubClient` (next to `owed`):
```ts
  /** The hub's current fee config for new channels (spec §4.6). */
  async feeConfig(): Promise<{ feePerPlayer: bigint; feeRecipient: Address }> {
    const [feePerPlayer, feeRecipient] = await Promise.all([
      this.client.readContract({ address: this.hub, abi: channelHubAbi, functionName: "feePerPlayer" }),
      this.client.readContract({ address: this.hub, abi: channelHubAbi, functionName: "feeRecipient" }),
    ]);
    return { feePerPlayer, feeRecipient };
  }
```
Add `export * from "./wire.js";` to `packages/sdk/src/index.ts`.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd packages/sdk && pnpm test && pnpm typecheck`
Expected: all PASS (wire: 3 new), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk
git commit -m "feat(sdk): wire protocol: bigint codec, signed offers, matching rules, transport interfaces"
```

---

### Task 3: `@arena/cli` package: config, atomic files, file session store, records

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/vitest.config.ts`, `packages/cli/src/index.ts`, `packages/cli/src/jsonfile.ts`, `packages/cli/src/config.ts`, `packages/cli/src/fileStore.ts`, `packages/cli/src/records.ts`
- Test: `packages/cli/test/files.test.ts`

**Interfaces:**
- Produces:
  - `writeJsonAtomic(path: string, value: unknown): void`, `readJson<T>(path: string): T | null`
  - `type ArenaConfig = { rpcUrl: string; chainId: number; hub: Address; usdc: Address; rules: Address; serverUrl: string; port: number; maxFeePerPlayer: bigint; sessionGasWei: bigint; pollMs: number }`
  - `arenaPaths(home)`, `initHome(home, cfg, walletKey?) → { walletKey: Hex; token: string }`, `loadConfig(home)`, `loadWalletKey(home)`, `loadToken(home)`, `defaultHome(env)`
  - `class FileSessionStore implements LoadableSessionStore`
  - `type Controller = "agent" | "human"`
  - `type ChannelRecord = { channelId; params; me; sessionKey; offerId; createdBlock: bigint; controller: Controller; note: string; finalized: boolean }`
  - `type OfferRecord = { offerId; offer; sessionKey; role: "offerer" | "accepter" }`
  - `class RecordStore(home)` with `saveChannel`, `channels()`, `channel(id)`, `saveOffer`, `offer(id)`, `offers()`, `removeOffer(id)`

- [ ] **Step 1: Package scaffold**

`packages/cli/package.json`:
```json
{
  "name": "@arena/cli",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "bin": {
    "arena": "./bin/arena.mjs"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@arena/sdk": "workspace:*",
    "chess.js": "1.4.0",
    "tsx": "4.23.15",
    "viem": "2.56.8"
  },
  "devDependencies": {
    "@types/node": "25.9.8",
    "typescript": "6.0.3",
    "vitest": "5.0.1"
  }
}
```

`packages/cli/tsconfig.json`: identical to `packages/sdk/tsconfig.json` except `"include": ["src", "test", "vitest.config.ts"]`.

`packages/cli/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Reuses the SDK's forge build + Anvil (port 8546) setup.
    globalSetup: ["../sdk/test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
```

Run from the repo root: `export PATH="$HOME/.foundry/bin:$HOME/.local/bin:$PATH" && pnpm install`
Expected: clean install; no release-age bypass added.

- [ ] **Step 2: Write the failing test**

`packages/cli/test/files.test.ts`:
```ts
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { ChannelSession, type ArenaDomain, type Params } from "@arena/sdk";
import {
  FileSessionStore,
  RecordStore,
  arenaPaths,
  initHome,
  loadConfig,
  loadToken,
  loadWalletKey,
  readJson,
  writeJsonAtomic,
  type ArenaConfig,
} from "../src/index.js";
import { privateKeyToAccount } from "viem/accounts";

const CFG: ArenaConfig = {
  rpcUrl: "http://127.0.0.1:8546",
  chainId: 31337,
  hub: "0x000000000000000000000000000000000000beef",
  usdc: "0x000000000000000000000000000000000000cafe",
  rules: "0x00000000000000000000000000000000000000e5",
  serverUrl: "http://127.0.0.1:3000",
  port: 7001,
  maxFeePerPlayer: 10_000n,
  sessionGasWei: 10n ** 16n,
  pollMs: 1000,
};

const home = () => mkdtempSync(join(tmpdir(), "arena-"));
const mode = (p: string) => statSync(p).mode & 0o777;

describe("files", () => {
  it("writes JSON atomically with 0600 and round-trips bigints", () => {
    const dir = home();
    const p = join(dir, "x", "v.json");
    writeJsonAtomic(p, { n: 5n, s: "a" });
    expect(readJson(p)).toEqual({ n: 5n, s: "a" });
    expect(mode(p)).toBe(0o600);
    expect(readJson(join(dir, "missing.json"))).toBeNull();
  });

  it("initialises a home with config, wallet key and token (0600) and reloads them", () => {
    const dir = home();
    const { walletKey, token } = initHome(dir, CFG);
    const paths = arenaPaths(dir);
    expect(loadConfig(dir)).toEqual(CFG);
    expect(loadWalletKey(dir)).toBe(walletKey);
    expect(loadToken(dir)).toBe(token);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    for (const f of [paths.config, paths.wallet, paths.token]) expect(mode(f)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    // Re-init keeps the existing wallet key and token.
    expect(initHome(dir, { ...CFG, port: 7002 })).toEqual({ walletKey, token });
    expect(loadConfig(dir).port).toBe(7002);
  });

  it("persists session snapshots so ChannelSession.open resumes", async () => {
    const dir = home();
    const keys = [generatePrivateKey(), generatePrivateKey()] as const;
    const params: Params = {
      participants: ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000b2"],
      signers: [privateKeyToAccount(keys[0]).address, privateKeyToAccount(keys[1]).address],
      rules: CFG.rules,
      feeRecipient: "0x00000000000000000000000000000000000000f6",
      feePerPlayer: 5_000n,
      deposit: 1_000_000n,
      stakePerGame: 100_000n,
      challengeTimeout: 600n,
      fundingDeadline: 2_000_000_000n,
      salt: `0x${"22".repeat(32)}`,
    };
    const domain: ArenaDomain = { chainId: 31337, hub: CFG.hub };
    const path = join(dir, "channels", "c", "session.json");
    const a = await ChannelSession.open({ params, me: 0, sessionKey: keys[0], domain, store: new FileSessionStore(path) });
    await a.move("e2e4");
    expect(mode(path)).toBe(0o600);
    const again = await ChannelSession.open({ params, me: 0, sessionKey: keys[0], domain, store: new FileSessionStore(path) });
    expect(again.latest).toEqual(a.latest);
    expect(again.snapshot().lastSignedTurn).toBe(1n);
  });

  it("stores channel and offer records", () => {
    const dir = home();
    const rs = new RecordStore(dir);
    const rec = {
      channelId: `0x${"33".repeat(32)}` as const,
      params: {} as Params,
      me: 0 as const,
      sessionKey: generatePrivateKey(),
      offerId: `0x${"44".repeat(32)}` as const,
      createdBlock: 7n,
      controller: "agent" as const,
      note: "",
      finalized: false,
    };
    rs.saveChannel(rec);
    expect(rs.channels()).toEqual([rec]);
    expect(rs.channel(rec.channelId)).toEqual(rec);
    const off = { offerId: rec.offerId, offer: {} as never, sessionKey: rec.sessionKey, role: "offerer" as const };
    rs.saveOffer(off);
    expect(rs.offer(rec.offerId)).toEqual(off);
    expect(rs.offers()).toHaveLength(1);
    rs.removeOffer(rec.offerId);
    expect(rs.offer(rec.offerId)).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd packages/cli && pnpm test -- test/files.test.ts`
Expected: FAIL, because `../src/index.js` is missing.

- [ ] **Step 4: Implement**

`packages/cli/src/jsonfile.ts`:
```ts
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { fromWire, toWire } from "@arena/sdk";

/** Atomically writes bigint-safe JSON with mode 0600 (temp file + fsync + rename); parent dirs get 0700. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, toWire(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return fromWire<T>(readFileSync(path, "utf8"));
}
```

`packages/cli/src/config.ts`:
```ts
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { readJson, writeJsonAtomic } from "./jsonfile.js";

export type ArenaConfig = {
  rpcUrl: string;
  chainId: number;
  hub: Address;
  usdc: Address;
  rules: Address;
  serverUrl: string;
  port: number;
  maxFeePerPlayer: bigint;
  sessionGasWei: bigint;
  pollMs: number;
};

export function defaultHome(env: NodeJS.ProcessEnv): string {
  return env.ARENA_HOME ?? join(homedir(), ".arena");
}

export function arenaPaths(home: string) {
  return {
    home,
    config: join(home, "config.json"),
    wallet: join(home, "wallet.json"),
    token: join(home, "token.json"),
    channels: join(home, "channels"),
    offers: join(home, "offers"),
    channelRecord: (id: Hex) => join(home, "channels", id, "record.json"),
    channelSession: (id: Hex) => join(home, "channels", id, "session.json"),
    offerRecord: (id: Hex) => join(home, "offers", `${id}.json`),
  };
}

/** Creates or updates ARENA_HOME: config is (re)written; the wallet key and API token are created once. */
export function initHome(home: string, cfg: ArenaConfig, walletKey?: Hex): { walletKey: Hex; token: string } {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const paths = arenaPaths(home);
  writeJsonAtomic(paths.config, cfg);
  const existingWallet = readJson<{ key: Hex }>(paths.wallet);
  const key = existingWallet?.key ?? walletKey ?? generatePrivateKey();
  if (!existingWallet) writeJsonAtomic(paths.wallet, { key });
  const existingToken = readJson<{ token: string }>(paths.token);
  const token = existingToken?.token ?? randomBytes(32).toString("hex");
  if (!existingToken) writeJsonAtomic(paths.token, { token });
  return { walletKey: key, token };
}

function required<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`${what} missing: run "arena init" first`);
  return value;
}

export function loadConfig(home: string): ArenaConfig {
  return required(readJson<ArenaConfig>(arenaPaths(home).config), "config");
}

export function loadWalletKey(home: string): Hex {
  return required(readJson<{ key: Hex }>(arenaPaths(home).wallet), "wallet key").key;
}

export function loadToken(home: string): string {
  return required(readJson<{ token: string }>(arenaPaths(home).token), "API token").token;
}
```

`packages/cli/src/fileStore.ts`:
```ts
import type { LoadableSessionStore, SessionSnapshot } from "@arena/sdk";
import { readJson, writeJsonAtomic } from "./jsonfile.js";

/** One channel's session snapshot on disk; written atomically before any signature leaves the session. */
export class FileSessionStore implements LoadableSessionStore {
  constructor(private readonly path: string) {}

  async save(snapshot: SessionSnapshot): Promise<void> {
    writeJsonAtomic(this.path, snapshot);
  }

  async load(): Promise<SessionSnapshot | null> {
    return readJson<SessionSnapshot>(this.path);
  }
}
```

`packages/cli/src/records.ts`:
```ts
import { existsSync, readdirSync, rmSync } from "node:fs";
import type { Hex } from "viem";
import type { Offer, Params, PlayerIndex } from "@arena/sdk";
import { arenaPaths } from "./config.js";
import { readJson, writeJsonAtomic } from "./jsonfile.js";

export type Controller = "agent" | "human";

export type ChannelRecord = {
  channelId: Hex;
  params: Params;
  me: PlayerIndex;
  sessionKey: Hex;
  offerId: Hex;
  createdBlock: bigint;
  controller: Controller;
  note: string;
  finalized: boolean;
};

export type OfferRecord = { offerId: Hex; offer: Offer; sessionKey: Hex; role: "offerer" | "accepter" };

export class RecordStore {
  private readonly paths;

  constructor(home: string) {
    this.paths = arenaPaths(home);
  }

  saveChannel(r: ChannelRecord): void {
    writeJsonAtomic(this.paths.channelRecord(r.channelId), r);
  }

  channel(id: Hex): ChannelRecord | null {
    return readJson<ChannelRecord>(this.paths.channelRecord(id));
  }

  channels(): ChannelRecord[] {
    if (!existsSync(this.paths.channels)) return [];
    return readdirSync(this.paths.channels)
      .map((id) => this.channel(id as Hex))
      .filter((r): r is ChannelRecord => r !== null);
  }

  saveOffer(r: OfferRecord): void {
    writeJsonAtomic(this.paths.offerRecord(r.offerId), r);
  }

  offer(id: Hex): OfferRecord | null {
    return readJson<OfferRecord>(this.paths.offerRecord(id));
  }

  offers(): OfferRecord[] {
    if (!existsSync(this.paths.offers)) return [];
    return readdirSync(this.paths.offers)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.offer(f.slice(0, -".json".length) as Hex))
      .filter((r): r is OfferRecord => r !== null);
  }

  removeOffer(id: Hex): void {
    rmSync(this.paths.offerRecord(id), { force: true });
  }
}
```

`packages/cli/src/index.ts`:
```ts
export * from "./jsonfile.js";
export * from "./config.js";
export * from "./fileStore.js";
export * from "./records.js";
```

- [ ] **Step 5: Run tests and typecheck**

Run: `cd packages/cli && pnpm test -- test/files.test.ts && pnpm typecheck`
Expected: 4 tests PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/cli pnpm-lock.yaml
git commit -m "feat(cli): arena home layout, atomic 0600 files, file session store, records"
```

---

### Task 4: Daemon core: matching, funding, relay, actions, handoff (+ MemoryArena)

**Files:**
- Create: `packages/cli/src/daemon.ts`, `packages/cli/test/helpers/memoryArena.ts`, `packages/cli/test/helpers/harness.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/daemon.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `packages/sdk/test/helpers/chain.ts` (`deployArena`, `mintUsdc`, `usdcBalance`, `increaseTime`, `ANVIL_KEYS`, `RPC`, `CHAIN`, `now`).
- Produces:
  - `class ArenaDaemon`:
    - `constructor({ home, config, walletKey, lobby, relay, log? })`
    - lifecycle: `start()`, `stop()`
    - lobby: `createOffer({ deposit, stakePerGame, challengeTimeout })`, `listOffers()`, `acceptOffer(offerId)`
    - actions, each taking `(ref: string | undefined, actor: Actor)`:
      - `move(ref, input, { offerDraw?, actor })`
      - `resign`, `acceptDraw`, `nextGame`, `close`, `challenge`
    - other: `reclaim(ref)`, `handoff(ref, to, note)`, `tick()` (one watchtower pass; Task 6 fills it)
    - read: `status(ref?)` (Task 5), `channels()` (Task 5), `wait(opts)` (Task 5)
    - `handle(id)`, test/tool access returning `{ session, sessionSender, record }`
  - `type Actor = "agent" | "human"`
  - `class DaemonError extends Error { code: number }`
  - Test helpers:
    - `class MemoryArena(terms: () => Promise<MatchTerms & { now: bigint }>)` with `client(): { lobby; relay; disconnect(); reconnect() }`
    - `startPair()` returns `{ env, alice, bob, arena, cleanup }`, where each player is `{ daemon, home, wallet, arenaClient }`

- [ ] **Step 1: Write the MemoryArena test double**

`packages/cli/test/helpers/memoryArena.ts`:
```ts
import type { Hex } from "viem";
import {
  buildParams,
  offerId,
  verifyAcceptance,
  verifyOffer,
  type LobbyClient,
  type MatchEvent,
  type MatchTerms,
  type RelayClient,
  type RelayMessage,
  type SignedAcceptance,
  type SignedOffer,
} from "@arena/sdk";

type Member = { rooms: Set<Hex>; handlers: Set<(m: RelayMessage) => void>; connected: boolean };

/** In-process stand-in for the host (Plan 4) using the same SDK matching rules. */
export class MemoryArena {
  private readonly offers = new Map<Hex, SignedOffer>();
  private readonly matchHandlers = new Set<(m: MatchEvent) => void>();
  private readonly members = new Set<Member>();

  constructor(private readonly terms: () => Promise<MatchTerms & { now: bigint }>) {}

  client(): { lobby: LobbyClient; relay: RelayClient; disconnect(): void; reconnect(): void } {
    const member: Member = { rooms: new Set(), handlers: new Set(), connected: true };
    this.members.add(member);
    const lobby: LobbyClient = {
      postOffer: async (so) => {
        if (!(await verifyOffer(so))) throw new Error("bad offer signature");
        const id = offerId(so.offer);
        this.offers.set(id, structuredClone(so));
        return id;
      },
      listOffers: async () => [...this.offers.values()].map((o) => structuredClone(o)),
      accept: async (sa: SignedAcceptance) => {
        const so = this.offers.get(sa.acceptance.offerId);
        if (!so) throw new Error("unknown offer");
        if (!(await verifyAcceptance(sa))) throw new Error("bad acceptance signature");
        const t = await this.terms();
        const params = buildParams(so.offer, sa.acceptance, t, t.now);
        this.offers.delete(sa.acceptance.offerId);
        const event: MatchEvent = { offerId: sa.acceptance.offerId, params };
        setTimeout(() => {
          for (const h of this.matchHandlers) h(structuredClone(event));
        }, 0);
      },
      onMatch: (h) => {
        this.matchHandlers.add(h);
        return () => this.matchHandlers.delete(h);
      },
    };
    const relay: RelayClient = {
      join: async (channelId) => {
        member.rooms.add(channelId);
      },
      send: async (msg) => {
        if (!member.connected) throw new Error("disconnected");
        for (const other of this.members) {
          if (other === member || !other.connected || !other.rooms.has(msg.channelId)) continue;
          const copy = structuredClone(msg);
          setTimeout(() => {
            for (const h of other.handlers) h(copy);
          }, 0);
        }
      },
      onMessage: (h) => {
        member.handlers.add(h);
        return () => member.handlers.delete(h);
      },
    };
    return {
      lobby,
      relay,
      disconnect: () => {
        member.connected = false;
      },
      reconnect: () => {
        member.connected = true;
      },
    };
  }
}
```

- [ ] **Step 2: Write the harness**

`packages/cli/test/helpers/harness.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ArenaDaemon, initHome, type ArenaConfig } from "../../src/index.js";
import { ANVIL_KEYS, RPC, deployArena, mintUsdc, now } from "../../../sdk/test/helpers/chain.js";
import { MemoryArena } from "./memoryArena.js";

export const START = 10_000_000n;

export type Player = {
  daemon: ArenaDaemon;
  home: string;
  walletKey: Hex;
  address: `0x${string}`;
  client: ReturnType<MemoryArena["client"]>;
};

export async function startPair(opts: { pollMs?: number; bobConfig?: Partial<ArenaConfig> } = {}) {
  const env = await deployArena();
  const arena = new MemoryArena(async () => ({
    rules: env.rules,
    feeRecipient: env.host,
    feePerPlayer: 5_000n,
    fundingWindow: 3600n,
    now: await now(),
  }));
  const config: ArenaConfig = {
    rpcUrl: RPC,
    chainId: env.domain.chainId,
    hub: env.hub,
    usdc: env.usdc,
    rules: env.rules,
    serverUrl: "memory:",
    port: 0,
    maxFeePerPlayer: 10_000n,
    sessionGasWei: 10n ** 16n,
    pollMs: opts.pollMs ?? 100,
  };
  const make = async (walletKey: Hex, overrides: Partial<ArenaConfig> = {}): Promise<Player> => {
    const home = mkdtempSync(join(tmpdir(), "arena-"));
    const own: ArenaConfig = { ...config, ...overrides }; // each daemon gets its own config object
    initHome(home, own, walletKey);
    const address = privateKeyToAccount(walletKey).address;
    await mintUsdc(env.usdc, address, START);
    const client = arena.client();
    const daemon = new ArenaDaemon({ home, config: own, walletKey, lobby: client.lobby, relay: client.relay });
    await daemon.start();
    return { daemon, home, walletKey, address, client };
  };
  const alice = await make(ANVIL_KEYS[1]);
  const bob = await make(ANVIL_KEYS[2], opts.bobConfig);
  return {
    env,
    arena,
    config,
    alice,
    bob,
    cleanup: async () => {
      await alice.daemon.stop();
      await bob.daemon.stop();
    },
  };
}

/** Polls `fn` until it returns a truthy value (or throws after `ms`). */
export async function waitFor<T>(fn: () => Promise<T> | T, ms = 20_000, label = "condition"): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${String(last)}` : ""}`);
}
```

Note: Anvil account 1 and 2 are reused by several test files. Each `deployArena()` deploys a fresh MockUSDC, so balances start at `START` per test.

- [ ] **Step 3: Write the failing daemon test**

`packages/cli/test/daemon.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { DaemonError } from "../src/index.js";
import { usdcBalance } from "../../sdk/test/helpers/chain.js";
import { START, startPair, waitFor } from "./helpers/harness.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function matched() {
  const pair = await startPair();
  cleanup = pair.cleanup;
  const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
  const listed = await pair.bob.daemon.listOffers();
  expect(listed.map((o) => o.offerId)).toContain(offerId);
  await pair.bob.daemon.acceptOffer(offerId);
  const id = await waitFor(async () => {
    const [a, b] = [pair.alice.daemon.channelIds(), pair.bob.daemon.channelIds()];
    return a.length === 1 && b.length === 1 && a[0] === b[0] ? a[0] : null;
  }, 20_000, "match");
  await waitFor(async () => (await pair.alice.daemon.hub.channelInfo(id)).phase === "Open", 20_000, "funding");
  return { ...pair, id };
}

describe("ArenaDaemon core", () => {
  it("matches, funds in order, and opens the channel", async () => {
    const { alice, bob, env, id } = await matched();
    expect(await usdcBalance(env.usdc, alice.address)).toBe(START - 1_000_000n - 5_000n);
    expect(await usdcBalance(env.usdc, bob.address)).toBe(START - 1_000_000n - 5_000n);
    expect(alice.daemon.handle(id).record.me).toBe(0);
    expect(bob.daemon.handle(id).record.me).toBe(1);
  });

  it("relays moves between daemons and enforces turn order", async () => {
    const { alice, bob, id } = await matched();
    await expect(bob.daemon.move(undefined, "e7e5", { actor: "agent" })).rejects.toThrow(DaemonError);
    await alice.daemon.move(undefined, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob's turn");
    await bob.daemon.move(id, "e5", { actor: "agent" });
    await waitFor(() => alice.daemon.handle(id).session.isMyTurn(), 5_000, "alice's turn");
  });

  it("rejects agent moves while a human is in control", async () => {
    const { alice } = await matched();
    await alice.daemon.handoff(undefined, "human", "checking a line");
    await expect(alice.daemon.move(undefined, "e4", { actor: "agent" })).rejects.toThrow(/human is in control/);
    await alice.daemon.move(undefined, "e4", { actor: "human" });
    await alice.daemon.handoff(undefined, "agent", "");
    await expect(alice.daemon.move(undefined, "d4", { actor: "human" })).rejects.toThrow(/agent is in control|not your turn/);
  });

  it("rejects a mismatched match without funding", async () => {
    // Bob's daemon expects a different rules contract, so the host's match must be ignored by Bob.
    const pair = await startPair({ bobConfig: { rules: "0x00000000000000000000000000000000000000e5" } });
    cleanup = pair.cleanup;
    const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await pair.bob.daemon.acceptOffer(offerId);
    await waitFor(() => pair.alice.daemon.channelIds().length === 1, 20_000, "alice match");
    await new Promise((r) => setTimeout(r, 500));
    expect(pair.bob.daemon.channelIds()).toEqual([]);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd packages/cli && pnpm test -- test/daemon.test.ts`
Expected: FAIL, because `ArenaDaemon` is not exported.

- [ ] **Step 5: Implement `daemon.ts`**

`packages/cli/src/daemon.ts`:
```ts
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { createPublicClient, defineChain, http, maxUint256, type Chain, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ArenaProtocolError,
  ChannelSession,
  HubClient,
  HubRevertError,
  LocalKeyTxSender,
  channelId as computeChannelId,
  checkMatchParams,
  offerId as computeOfferId,
  outcome,
  signAcceptance,
  signOffer,
  type ArenaDomain,
  type LobbyClient,
  type MatchEvent,
  type Offer,
  type RelayClient,
  type RelayMessage,
  type SignedState,
} from "@arena/sdk";
import { arenaPaths, type ArenaConfig } from "./config.js";
import { FileSessionStore } from "./fileStore.js";
import { RecordStore, type ChannelRecord, type Controller } from "./records.js";

export type Actor = "agent" | "human";

export class DaemonError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

export type ChainView = {
  phase: string;
  funded: readonly [boolean, boolean];
  deadline: bigint;
  challenger: number;
  registeredTurn: bigint | null;
  now: bigint;
};

type Live = {
  record: ChannelRecord;
  session: ChannelSession;
  sessionSender: LocalKeyTxSender;
  processedEvents: number;
  chain: ChainView | null;
  lastError: string | null;
};

export type DaemonOptions = {
  home: string;
  config: ArenaConfig;
  walletKey: Hex;
  lobby: LobbyClient;
  relay: RelayClient;
  log?: (line: string) => void;
};

const errorText = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err));

export class ArenaDaemon {
  readonly client: PublicClient;
  readonly hub: HubClient;
  readonly wallet: LocalKeyTxSender;
  protected readonly chain: Chain;
  protected readonly domain: ArenaDomain;
  protected readonly records: RecordStore;
  protected readonly live = new Map<Hex, Live>();
  protected readonly changes = new EventEmitter();
  private timer: NodeJS.Timeout | undefined;
  private unsubscribers: Array<() => void> = [];
  private ticking = false;
  private approved = false;

  constructor(protected readonly opts: DaemonOptions) {
    const c = opts.config;
    this.chain = defineChain({
      id: c.chainId,
      name: `arena-${c.chainId}`,
      nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
      rpcUrls: { default: { http: [c.rpcUrl] } },
    });
    this.client = createPublicClient({ chain: this.chain, transport: http(c.rpcUrl) });
    this.hub = new HubClient(c.hub, this.client);
    this.wallet = new LocalKeyTxSender(opts.walletKey, c.rpcUrl, this.chain);
    this.domain = { chainId: c.chainId, hub: c.hub };
    this.records = new RecordStore(opts.home);
    this.changes.setMaxListeners(0);
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    this.unsubscribers.push(this.opts.lobby.onMatch((m) => void this.onMatch(m)));
    this.unsubscribers.push(this.opts.relay.onMessage((m) => void this.onRelay(m)));
    for (const record of this.records.channels()) {
      if (!record.finalized) await this.openChannel(record);
    }
    this.timer = setInterval(() => void this.tick(), this.opts.config.pollMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    while (this.ticking) await new Promise((r) => setTimeout(r, 10));
  }

  channelIds(): Hex[] {
    return [...this.live.keys()];
  }

  /** Direct access to a channel's session and senders — for tests and tooling, not for the agent API. */
  handle(id: Hex): Live {
    const l = this.live.get(id);
    if (!l) throw new DaemonError(404, `unknown channel ${id}`);
    return l;
  }

  // ------------------------------------------------------------------ lobby

  async createOffer(o: { deposit: bigint; stakePerGame: bigint; challengeTimeout: bigint }): Promise<{ offerId: Hex }> {
    const sessionKey = generatePrivateKey();
    const offer: Offer = {
      template: "chess",
      player: this.wallet.address,
      signer: privateKeyToAccount(sessionKey).address,
      deposit: o.deposit,
      stakePerGame: o.stakePerGame,
      challengeTimeout: o.challengeTimeout,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: `0x${randomBytes(32).toString("hex")}`,
    };
    const id = computeOfferId(offer);
    this.records.saveOffer({ offerId: id, offer, sessionKey, role: "offerer" });
    await this.opts.lobby.postOffer({ offer, sig: await signOffer(sessionKey, offer) });
    return { offerId: id };
  }

  async listOffers(): Promise<Array<{ offerId: Hex; offer: Offer; mine: boolean }>> {
    const offers = await this.opts.lobby.listOffers();
    return offers.map((so) => ({
      offerId: computeOfferId(so.offer),
      offer: so.offer,
      mine: so.offer.player.toLowerCase() === this.wallet.address.toLowerCase(),
    }));
  }

  async acceptOffer(offerId: Hex): Promise<void> {
    const so = (await this.opts.lobby.listOffers()).find((o) => computeOfferId(o.offer) === offerId);
    if (!so) throw new DaemonError(404, `offer ${offerId} not found`);
    if (so.offer.player.toLowerCase() === this.wallet.address.toLowerCase()) {
      throw new DaemonError(400, "cannot accept your own offer");
    }
    const sessionKey = generatePrivateKey();
    const acceptance = {
      offerId,
      player: this.wallet.address,
      signer: privateKeyToAccount(sessionKey).address,
      nonce: `0x${randomBytes(32).toString("hex")}` as Hex,
    };
    this.records.saveOffer({ offerId, offer: so.offer, sessionKey, role: "accepter" });
    await this.opts.lobby.accept({ acceptance, sig: await signAcceptance(sessionKey, acceptance) });
  }

  private async onMatch(m: MatchEvent): Promise<void> {
    try {
      const rec = this.records.offer(m.offerId);
      if (!rec) return;
      const signer = privateKeyToAccount(rec.sessionKey).address;
      const me = m.params.signers.findIndex((s) => s.toLowerCase() === signer.toLowerCase());
      if (me !== 0 && me !== 1) return;
      const fee = await this.hub.feeConfig();
      const problem = checkMatchParams(m.params, {
        me,
        player: this.wallet.address,
        signer,
        rules: this.opts.config.rules,
        deposit: rec.offer.deposit,
        stakePerGame: rec.offer.stakePerGame,
        challengeTimeout: rec.offer.challengeTimeout,
        feeRecipient: fee.feeRecipient,
        minFeePerPlayer: fee.feePerPlayer,
        maxFeePerPlayer: this.opts.config.maxFeePerPlayer,
      });
      if (problem) {
        this.log(`ignoring match for offer ${m.offerId}: ${problem}`);
        return;
      }
      const id = computeChannelId(this.domain.chainId, this.domain.hub, m.params);
      if (this.live.has(id)) return;
      const record: ChannelRecord = {
        channelId: id,
        params: m.params,
        me,
        sessionKey: rec.sessionKey,
        offerId: m.offerId,
        createdBlock: await this.client.getBlockNumber(),
        controller: "agent",
        note: "",
        finalized: false,
      };
      this.records.saveChannel(record);
      this.records.removeOffer(m.offerId);
      await this.openChannel(record);
      this.notify();
      void this.tick();
    } catch (err) {
      this.log(`match handling failed: ${errorText(err)}`);
    }
  }

  private async openChannel(record: ChannelRecord): Promise<void> {
    const store = new FileSessionStore(arenaPaths(this.opts.home).channelSession(record.channelId));
    const session = await ChannelSession.open({
      params: record.params,
      me: record.me,
      sessionKey: record.sessionKey,
      domain: this.domain,
      store,
    });
    const sessionSender = new LocalKeyTxSender(record.sessionKey, this.opts.config.rpcUrl, this.chain);
    this.live.set(record.channelId, { record, session, sessionSender, processedEvents: 0, chain: null, lastError: null });
    await this.opts.relay.join(record.channelId, record.sessionKey);
    // Crash recovery (Review Focus 5): re-send our latest own state so a message lost at the crash is delivered.
    const latest = session.latest;
    const mine = record.me === 0 ? latest.sigA : latest.sigB;
    if (latest.state.turnNum > 0n && mine !== "0x") {
      await this.opts.relay.send({ type: "state", channelId: record.channelId, signed: latest }).catch(() => undefined);
    }
  }

  /** Approve once, give the session key gas for disputes, then deposit (spec §3.1, §5). */
  protected async fund(l: Live): Promise<void> {
    const p = l.record.params;
    if (!this.approved) {
      await this.hub.approve(this.wallet, this.opts.config.usdc, maxUint256);
      this.approved = true;
    }
    if (this.opts.config.sessionGasWei > 0n) {
      const hash = await this.wallet.send({ to: l.sessionSender.address, data: "0x", value: this.opts.config.sessionGasWei });
      await this.client.waitForTransactionReceipt({ hash });
    }
    await this.hub.deposit(this.wallet, p);
  }

  // ------------------------------------------------------------------ relay

  private async onRelay(msg: RelayMessage): Promise<void> {
    const l = this.live.get(msg.channelId);
    if (!l) return;
    try {
      if (msg.type === "state") {
        await l.session.receive(msg.signed);
        await this.autoPlay(l);
      } else {
        await l.session.receiveClose(msg.close);
        await this.trySubmitClose(l);
      }
      l.lastError = null;
    } catch (err) {
      l.lastError = errorText(err);
      this.log(`channel ${msg.channelId}: ${l.lastError}`);
    }
    this.notify();
  }

  /** Spec §6.3: sign RESIGN when checkmated and CLAIM_STALEMATE when stalemated, regardless of controller. */
  protected async autoPlay(l: Live): Promise<void> {
    if (!l.session.isMyTurn()) return;
    const o = outcome(l.session.latest.state);
    if (o === "checkmate") await this.sendState(l, await l.session.resign());
    else if (o === "stalemate") await this.sendState(l, await l.session.claimStalemate());
  }

  protected async sendState(l: Live, signed: SignedState): Promise<void> {
    await this.opts.relay.send({ type: "state", channelId: l.record.channelId, signed }).catch((err) => {
      l.lastError = `relay: ${errorText(err)}`;
    });
    await this.respondIfChallenged(l);
  }

  /** If a challenge is pending and we now hold a newer supported state, answer it on-chain from the session key. */
  protected async respondIfChallenged(l: Live): Promise<void> {
    const id = l.record.channelId;
    const info = await this.hub.channelInfo(id);
    if (info.phase !== "Challenged") return;
    const registered = await this.hub.registeredState(id);
    if (l.session.latest.state.turnNum <= registered.turnNum) return;
    try {
      await this.hub.respond(l.sessionSender, l.session.challengeProof());
    } catch (err) {
      l.lastError = `respond: ${errorText(err)}`;
    }
  }

  private async trySubmitClose(l: Live): Promise<void> {
    const tx = l.session.closeTransaction();
    if (!tx) return;
    const info = await this.hub.channelInfo(l.record.channelId);
    if (info.phase !== "Open" && info.phase !== "Challenged") return;
    try {
      await this.hub.closeCooperative(this.wallet, tx);
    } catch (err) {
      if (!(err instanceof HubRevertError && err.errorName === "WrongPhase")) throw err;
    }
  }

  // ------------------------------------------------------------------ actions

  async move(ref: string | undefined, input: string, opts: { offerDraw?: boolean; actor: Actor }): Promise<void> {
    const l = this.pick(ref);
    this.requireController(l, opts.actor);
    await this.sendState(l, await this.guard(() => l.session.move(input, { offerDraw: opts.offerDraw })));
    this.notify();
  }

  async resign(ref: string | undefined, actor: Actor): Promise<void> {
    const l = this.pick(ref);
    this.requireController(l, actor);
    await this.sendState(l, await this.guard(() => l.session.resign()));
    this.notify();
  }

  async acceptDraw(ref: string | undefined, actor: Actor): Promise<void> {
    const l = this.pick(ref);
    this.requireController(l, actor);
    await this.sendState(l, await this.guard(() => l.session.acceptDraw()));
    this.notify();
  }

  async nextGame(ref: string | undefined, actor: Actor): Promise<void> {
    const l = this.pick(ref);
    this.requireController(l, actor);
    await this.sendState(l, await this.guard(() => l.session.proposeNewGame()));
    this.notify();
  }

  async close(ref: string | undefined, actor: Actor): Promise<void> {
    const l = this.pick(ref);
    this.requireController(l, actor);
    const cs = await this.guard(() => l.session.signClose());
    await this.opts.relay.send({ type: "close", channelId: l.record.channelId, close: cs }).catch((err) => {
      l.lastError = `relay: ${errorText(err)}`;
    });
    await this.guard(() => this.trySubmitClose(l));
    this.notify();
  }

  async challenge(ref: string | undefined, actor: Actor): Promise<void> {
    const l = this.pick(ref);
    this.requireController(l, actor);
    await this.guard(() => this.hub.challenge(l.sessionSender, l.session.challengeProof()));
    this.notify();
  }

  async reclaim(ref: string | undefined): Promise<void> {
    const l = this.pick(ref);
    await this.guard(() => this.hub.reclaim(this.wallet, l.record.channelId));
    this.notify();
  }

  async handoff(ref: string | undefined, to: Controller, note: string): Promise<void> {
    const l = this.pick(ref);
    l.record = { ...l.record, controller: to, note };
    this.records.saveChannel(l.record);
    this.notify();
  }

  // ------------------------------------------------------------------ watchtower (Task 6)

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const l of this.live.values()) {
        if (l.record.finalized) continue;
        try {
          await this.watch(l);
        } catch (err) {
          l.lastError = errorText(err);
        }
      }
    } finally {
      this.ticking = false;
      this.notify();
    }
  }

  /** One watchtower pass for one channel. Task 4 funds only; Task 6 adds disputes. */
  protected async watch(l: Live): Promise<void> {
    const id = l.record.channelId;
    const p = l.record.params;
    const info = await this.hub.channelInfo(id);
    const now = (await this.client.getBlock()).timestamp;
    const me = l.record.me;
    // Funding order (spec §5): the offerer creates the channel; the accepter deposits only after funded[0].
    if (now <= p.fundingDeadline) {
      if (info.phase === "None" && me === 0) await this.fund(l);
      else if (info.phase === "Funding" && !info.funded[me] && (me === 0 || info.funded[0])) await this.fund(l);
    }
    l.chain = {
      phase: info.phase,
      funded: info.funded,
      deadline: info.deadline,
      challenger: info.challenger,
      registeredTurn: null,
      now,
    };
  }

  // ------------------------------------------------------------------ helpers

  protected pick(ref: string | undefined): Live {
    const active = [...this.live.values()].filter((l) => !l.record.finalized);
    if (ref) {
      const hits = [...this.live.values()].filter((l) => l.record.channelId.toLowerCase().startsWith(ref.toLowerCase()));
      if (hits.length === 1) return hits[0];
      throw new DaemonError(hits.length === 0 ? 404 : 400, hits.length === 0 ? `unknown channel ${ref}` : `ambiguous channel ${ref}`);
    }
    if (active.length === 1) return active[0];
    throw new DaemonError(400, active.length === 0 ? "no active channel" : "several channels are active: pass --channel");
  }

  protected requireController(l: Live, actor: Actor): void {
    if (actor !== l.record.controller) {
      throw new DaemonError(409, `the ${l.record.controller} is in control of this channel (use "arena handoff")`);
    }
  }

  protected async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ArenaProtocolError || err instanceof HubRevertError) throw new DaemonError(409, err.message);
      throw err;
    }
  }

  protected notify(): void {
    this.changes.emit("change");
  }

  protected log(line: string): void {
    (this.opts.log ?? (() => undefined))(line);
  }
}
```

Add to `packages/cli/src/index.ts`: `export * from "./daemon.js";`

- [ ] **Step 6: Run tests and typecheck**

Run: `cd packages/cli && export PATH="$HOME/.foundry/bin:$HOME/.local/bin:$PATH" && pnpm test -- test/daemon.test.ts && pnpm typecheck`
Expected: 4 tests PASS; typecheck clean; `pgrep -a anvil` empty afterwards.

- [ ] **Step 7: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): player daemon core: matching, ordered funding, relay, actions, handoff"
```

---

### Task 5: Status, channel listing and `wait`

**Files:**
- Create: `packages/cli/src/status.ts`
- Modify: `packages/cli/src/daemon.ts` (add `status`, `channels`, `wait`), `packages/cli/src/index.ts`
- Test: `packages/cli/test/status.test.ts`

**Interfaces:**
- Produces:
  - `buildStatus(input: StatusInput): ChannelStatus` (pure)
  - `ArenaDaemon.status(ref?): Promise<ChannelStatus>`
  - `ArenaDaemon.channels(): Promise<ChannelStatus[]>`
  - `ArenaDaemon.wait({ ref?, timeoutMs }): Promise<{ channelId: Hex | null; reason: string }>`
- `ChannelStatus` fields:
  - identity: `channelId`, `phase`, `me`, `color` ("white" | "black"), `controller`, `note`
  - game: `gameIndex`, `turnNum` (string), `fen`, `board` (ASCII), `legalMoves` (SAN), `myTurn`, `gameStatus`, `outcome`
  - money: `balances: { me, opponent }` (USDC decimal strings)
  - between games: `newGame` ("none" | "proposed_by_me" | "proposed_by_opponent"), `closing`, `opponentWantsToClose`
  - dispute: `challenge: null | { deadline, secondsLeft, mustMove, challenger: "me" | "opponent" }`
  - guidance: `attention: null | "your-turn" | "new-game-proposed" | "game-over" | "close-requested"`, `suggestedActions: string[]`, `lastError`

- [ ] **Step 1: Write the failing test**

`packages/cli/test/status.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { ChannelSession, MemoryStore, type ArenaDomain } from "@arena/sdk";
import { buildStatus, type ChannelRecord } from "../src/index.js";
import { makeParams, SCHOLARS_MATE } from "../../sdk/test/helpers/fixtures.js";

const domain: ArenaDomain = { chainId: 31337, hub: "0x000000000000000000000000000000000000beef" };

async function sessions() {
  const keys = [generatePrivateKey(), generatePrivateKey()] as const;
  const params = makeParams({
    participants: ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000b2"],
    sessionKeys: keys,
    rules: "0x00000000000000000000000000000000000000e5",
    feeRecipient: "0x00000000000000000000000000000000000000f6",
    fundingDeadline: 2_000_000_000n,
  });
  const a = await ChannelSession.create({ params, me: 0, sessionKey: keys[0], domain, store: new MemoryStore() });
  const b = await ChannelSession.create({ params, me: 1, sessionKey: keys[1], domain, store: new MemoryStore() });
  const rec = (me: 0 | 1): ChannelRecord => ({
    channelId: a.id,
    params,
    me,
    sessionKey: keys[me],
    offerId: a.id,
    createdBlock: 0n,
    controller: "agent",
    note: "",
    finalized: false,
  });
  return { a, b, rec };
}

const OPEN = { phase: "Open", funded: [true, true] as const, deadline: 0n, challenger: 0, registeredTurn: null, now: 1000n };
const view = (s: ChannelSession, record: ChannelRecord, chain = OPEN) =>
  buildStatus({ record, snapshot: s.snapshot(), myTurn: s.isMyTurn(), chain, lastError: null });

describe("buildStatus", () => {
  it("describes the opening for both sides", async () => {
    const { a, b, rec } = await sessions();
    const sa = view(a, rec(0));
    expect(sa.color).toBe("white");
    expect(sa.myTurn).toBe(true);
    expect(sa.legalMoves).toContain("e4");
    expect(sa.legalMoves).toHaveLength(20);
    expect(sa.attention).toBe("your-turn");
    expect(sa.balances).toEqual({ me: "1.000000", opponent: "1.000000" });
    expect(sa.board).toContain("r  n  b  q  k  b  n  r");
    expect(sa.suggestedActions.some((x) => x.startsWith("arena move"))).toBe(true);
    const sb = view(b, rec(1));
    expect(sb.color).toBe("black");
    expect(sb.myTurn).toBe(false);
    expect(sb.legalMoves).toEqual([]);
    expect(sb.attention).toBeNull();
  });

  it("reports game over, new-game proposals and close requests", async () => {
    const { a, b, rec } = await sessions();
    for (const m of SCHOLARS_MATE) {
      const [mover, other] = a.isMyTurn() ? [a, b] : [b, a];
      await other.receive(await mover.move(m));
    }
    await a.receive(await b.resign());
    const over = view(a, rec(0));
    expect(over.gameStatus).toBe("white_won");
    expect(over.attention).toBe("game-over");
    expect(over.balances).toEqual({ me: "1.100000", opponent: "0.900000" });
    expect(over.suggestedActions).toEqual(expect.arrayContaining(["arena next-game", "arena close"]));

    await b.receive(await a.proposeNewGame());
    expect(view(b, rec(1)).newGame).toBe("proposed_by_opponent");
    expect(view(b, rec(1)).attention).toBe("new-game-proposed");
    expect(view(a, rec(0)).newGame).toBe("proposed_by_me");
  });

  it("flags a challenge that needs this player's move", async () => {
    const { a, b, rec } = await sessions();
    await b.receive(await a.move("e2e4"));
    const s = view(b, rec(1), { ...OPEN, phase: "Challenged", deadline: 1600n, challenger: 0, registeredTurn: 1n });
    expect(s.challenge).toEqual({ deadline: "1600", secondsLeft: 600, mustMove: true, challenger: "opponent" });
    expect(s.attention).toBe("your-turn");
  });

  it("stays quiet while a human controls the channel", async () => {
    const { a, rec } = await sessions();
    const s = view(a, { ...rec(0), controller: "human", note: "mine now" });
    expect(s.attention).toBeNull();
    expect(s.note).toBe("mine now");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/cli && pnpm test -- test/status.test.ts`
Expected: FAIL, because `buildStatus` is missing.

- [ ] **Step 3: Implement**

`packages/cli/src/status.ts`:
```ts
import { Chess } from "chess.js";
import type { Hex } from "viem";
import { STATUS, fenOf, isGameOver, outcome, unpackMeta, type Outcome, type PlayerIndex, type SessionSnapshot } from "@arena/sdk";
import type { ChainView } from "./daemon.js";
import type { ChannelRecord, Controller } from "./records.js";

export type ChannelStatus = {
  channelId: Hex;
  phase: string;
  me: PlayerIndex;
  color: "white" | "black";
  controller: Controller;
  note: string;
  gameIndex: number;
  turnNum: string;
  fen: string;
  board: string;
  legalMoves: string[];
  myTurn: boolean;
  gameStatus: "playing" | "draw_offered" | "white_won" | "black_won" | "draw";
  outcome: Outcome;
  balances: { me: string; opponent: string };
  newGame: "none" | "proposed_by_me" | "proposed_by_opponent";
  closing: boolean;
  opponentWantsToClose: boolean;
  challenge: null | { deadline: string; secondsLeft: number; mustMove: boolean; challenger: "me" | "opponent" };
  attention: null | "your-turn" | "new-game-proposed" | "game-over" | "close-requested";
  suggestedActions: string[];
  lastError: string | null;
};

export type StatusInput = {
  record: ChannelRecord;
  snapshot: SessionSnapshot;
  myTurn: boolean;
  chain: ChainView | null;
  lastError: string | null;
};

const GAME_STATUS = ["playing", "draw_offered", "white_won", "black_won", "draw"] as const;

export function usdc(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = (amount % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

export function buildStatus(input: StatusInput): ChannelStatus {
  const { record, snapshot, myTurn, chain } = input;
  const s = snapshot.latest.state;
  const me = record.me;
  const color = s.gameIndex % 2 === me ? "white" : "black";
  const game = new Chess(fenOf(s));
  const status = unpackMeta(s.meta).status;
  const [mine, theirs] = me === 0 ? [s.balanceA, s.balanceB] : [s.balanceB, s.balanceA];
  const newGame = snapshot.pendingCheckpoint
    ? "proposed_by_me"
    : snapshot.incomingCheckpoint
      ? "proposed_by_opponent"
      : "none";
  const opponent = me === 0 ? 1 : 0;
  const closing = snapshot.closeState !== null;
  const opponentWantsToClose = snapshot.closeSigs[opponent] !== "0x";
  const phase = chain?.phase ?? "Unknown";
  const challenge =
    chain && phase === "Challenged"
      ? {
          deadline: chain.deadline.toString(),
          secondsLeft: Math.max(0, Number(chain.deadline - chain.now)),
          mustMove: myTurn && chain.registeredTurn !== null && chain.registeredTurn === s.turnNum,
          challenger: (chain.challenger === me ? "me" : "opponent") as "me" | "opponent",
        }
      : null;
  const over = isGameOver(s);
  const live = phase === "Open" || phase === "Challenged";

  let attention: ChannelStatus["attention"] = null;
  if (live && record.controller === "agent") {
    if (myTurn) attention = "your-turn";
    else if (newGame === "proposed_by_opponent" && !closing) attention = "new-game-proposed";
    else if (opponentWantsToClose && !closing) attention = "close-requested";
    else if (over && !closing && newGame === "none") attention = "game-over";
  }

  const suggestedActions: string[] = [];
  if (phase === "None" || phase === "Funding") suggestedActions.push("wait: the channel is being funded");
  else if (phase === "Finalized") suggestedActions.push("done: the channel is settled");
  else if (phase === "Reclaimed") suggestedActions.push("done: the channel was never funded and deposits were returned");
  else if (closing) suggestedActions.push("wait: close signed; waiting for the opponent's close signature");
  else if (myTurn) {
    suggestedActions.push(`arena move <move>   (one of: ${game.moves().slice(0, 8).join(", ")}${game.moves().length > 8 ? ", …" : ""})`);
    suggestedActions.push("arena move <move> --offer-draw", "arena resign");
    if (status === STATUS.DRAW_OFFERED) suggestedActions.push("arena accept-draw");
  } else if (over) {
    suggestedActions.push(newGame === "proposed_by_me" ? "wait: new game proposed" : "arena next-game", "arena close");
  } else {
    suggestedActions.push("arena wait");
  }

  return {
    channelId: record.channelId,
    phase,
    me,
    color,
    controller: record.controller,
    note: record.note,
    gameIndex: s.gameIndex,
    turnNum: s.turnNum.toString(),
    fen: game.fen(),
    board: game.ascii(),
    legalMoves: myTurn ? game.moves() : [],
    myTurn,
    gameStatus: GAME_STATUS[status] ?? "playing",
    outcome: outcome(s),
    balances: { me: usdc(mine), opponent: usdc(theirs) },
    newGame,
    closing,
    opponentWantsToClose,
    challenge,
    attention,
    suggestedActions,
    lastError: input.lastError,
  };
}
```

In `packages/cli/src/daemon.ts`:
- import `buildStatus, type ChannelStatus` from `./status.js`;
- add these public methods in the "helpers" area:
```ts
  async status(ref?: string): Promise<ChannelStatus> {
    const l = this.pick(ref);
    await this.refreshChain(l);
    return this.statusOf(l);
  }

  async channels(): Promise<ChannelStatus[]> {
    const out: ChannelStatus[] = [];
    for (const l of this.live.values()) {
      await this.refreshChain(l);
      out.push(this.statusOf(l));
    }
    return out;
  }

  /** Long-poll: resolves as soon as a channel needs the agent, or after `timeoutMs`. */
  async wait(opts: { ref?: string; timeoutMs: number }): Promise<{ channelId: Hex | null; reason: string }> {
    const end = Date.now() + opts.timeoutMs;
    for (;;) {
      const targets = opts.ref ? [this.pick(opts.ref)] : [...this.live.values()];
      for (const l of targets) {
        const st = this.statusOf(l);
        if (st.attention) return { channelId: l.record.channelId, reason: st.attention };
      }
      const left = end - Date.now();
      if (left <= 0) return { channelId: null, reason: "timeout" };
      await this.nextChange(Math.min(left, 1000));
    }
  }

  private statusOf(l: Live): ChannelStatus {
    return buildStatus({
      record: l.record,
      snapshot: l.session.snapshot(),
      myTurn: l.session.isMyTurn(),
      chain: l.chain,
      lastError: l.lastError,
    });
  }

  private async refreshChain(l: Live): Promise<void> {
    const id = l.record.channelId;
    const [info, block] = await Promise.all([this.hub.channelInfo(id), this.client.getBlock()]);
    const registeredTurn = info.hasRegistered ? (await this.hub.registeredState(id)).turnNum : null;
    l.chain = {
      phase: info.phase,
      funded: info.funded,
      deadline: info.deadline,
      challenger: info.challenger,
      registeredTurn,
      now: block.timestamp,
    };
  }

  private nextChange(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.changes.off("change", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.changes.on("change", done);
    });
  }
```
Then replace the `l.chain = {...}` assignment at the end of `watch` with `await this.refreshChain(l);`, so the chain view comes from one place. Export `./status.js` from `src/index.ts`.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd packages/cli && pnpm test -- test/status.test.ts test/daemon.test.ts && pnpm typecheck`
Expected: status 4/4 and daemon 4/4 PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): LLM-friendly channel status, attention signals and long-poll wait"
```

---

### Task 6: Watchtower: disputes, timeouts, reclaim, on-chain ingest

**Files:**
- Modify: `packages/cli/src/daemon.ts` (`watch`)
- Test: `packages/cli/test/daemon.test.ts` (append)

**Interfaces:**
- Consumes: `HubClient.disputeEvents`, `registeredState`, `timeout`, `reclaim`, `respond`; `ChannelSession.ingestOnChain`, `challengeProof`, `latest`; `isGameOver`, `mover` from the SDK.

**Behaviour (spec §6.3):** each pass does the following for each live channel.
1. **Funding:** as in Task 4. If this player funded, the phase is still `Funding` and `now > fundingDeadline`, call `reclaim` from the wallet.
2. **Ingest:** read `disputeEvents(id, createdBlock)` and ingest every event not yet processed, in order. Errors are recorded in `lastError`, and processing continues.
3. **When `Challenged`:** read the registered state and the deadline.
   - Our latest `turnNum` is greater than the registered one: `respond` with our proof (stale challenge).
   - Equal, the game is in progress, and we are on move: if checkmated, auto-resign (which responds via `sendState`); if stalemated, auto-claim; otherwise leave it for the controller. Status shows `mustMove`.
   - `now >= deadline`, and either the registered state is game-over or the player on move in it is the **opponent**: call `timeout`. Never call it when we are on move.
4. **When `Finalized` or `Reclaimed`:** mark the record finalized.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/daemon.test.ts`:
```ts
import { increaseTime } from "../../sdk/test/helpers/chain.js";

describe("watchtower", () => {
  it("answers a stale challenge automatically", async () => {
    const { alice, bob, id } = await matched();
    await alice.daemon.move(undefined, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    const stale = alice.daemon.handle(id).session.challengeProof(); // turn 1
    await bob.daemon.move(undefined, "e5", { actor: "agent" });
    await waitFor(() => alice.daemon.handle(id).session.isMyTurn(), 5_000, "alice turn");
    // A misbehaving Alice registers the stale state; Bob's watchtower must answer with turn 2.
    await alice.daemon.hub.challenge(alice.daemon.handle(id).sessionSender, stale);
    await waitFor(async () => (await bob.daemon.hub.channelInfo(id)).phase === "Open", 20_000, "respond");
    expect((await bob.daemon.hub.registeredState(id)).turnNum).toBe(2n);
  });

  it("times out a silent opponent and never times out itself", async () => {
    const { alice, bob, env, id } = await matched();
    await alice.daemon.move(undefined, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    await bob.daemon.stop();
    bob.client.disconnect();
    await alice.daemon.challenge(undefined, "agent");
    // Bob is on move in the registered state. Alice's watchtower must not have called timeout before the deadline.
    await new Promise((r) => setTimeout(r, 500));
    expect((await alice.daemon.hub.channelInfo(id)).phase).toBe("Challenged");
    await increaseTime(601);
    await waitFor(async () => (await alice.daemon.hub.channelInfo(id)).phase === "Finalized", 20_000, "timeout");
    expect(await usdcBalance(env.usdc, alice.address)).toBe(START - 5_000n + 100_000n);
    expect(alice.daemon.handle(id).record.finalized).toBe(true);
  });

  it("does not time out a challenge in which it is on move", async () => {
    const { alice, bob, id } = await matched();
    await alice.daemon.move(undefined, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    await alice.daemon.challenge(undefined, "agent"); // Bob must move
    await alice.daemon.stop(); // only Bob's watchtower runs from here
    await increaseTime(601);
    await bob.daemon.tick();
    await bob.daemon.tick();
    // Bob is on move in the registered state and past the deadline: calling timeout would forfeit Bob's stake.
    expect((await bob.daemon.hub.channelInfo(id)).phase).toBe("Challenged");
    expect((await bob.daemon.status(id)).challenge?.mustMove).toBe(true);
  });

  it("reclaims a deposit when the counterparty never funds", async () => {
    const pair = await startPair();
    cleanup = pair.cleanup;
    await pair.bob.daemon.stop(); // Bob matches but will never deposit
    const { offerId } = await pair.alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await pair.bob.daemon.acceptOffer(offerId); // records Bob's acceptance; Bob's daemon is stopped so no funding
    const id = await waitFor(() => pair.alice.daemon.channelIds()[0], 20_000, "alice match");
    await waitFor(async () => (await pair.alice.daemon.hub.channelInfo(id)).phase === "Funding", 20_000, "alice funded");
    await increaseTime(3601);
    await waitFor(async () => (await pair.alice.daemon.hub.channelInfo(id)).phase === "Reclaimed", 20_000, "reclaim");
    expect(await usdcBalance(pair.env.usdc, pair.alice.address)).toBe(START);
  });
});
```
Add `increaseTime` to the chain-helper import at the top of the file instead of importing twice, and adjust the imports to your file's structure.

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/cli && pnpm test -- test/daemon.test.ts`
Expected: the 4 new tests FAIL (no respond, timeout or reclaim yet).

- [ ] **Step 3: Implement `watch`**

Replace `watch` in `packages/cli/src/daemon.ts`, and add `isGameOver, mover` to the SDK import:
```ts
  /** One watchtower pass for one channel (spec §6.3). Runs regardless of the controller. */
  protected async watch(l: Live): Promise<void> {
    const id = l.record.channelId;
    const p = l.record.params;
    const me = l.record.me;
    const info = await this.hub.channelInfo(id);
    const now = (await this.client.getBlock()).timestamp;

    // 1. Funding in order, or reclaim after the deadline (spec §5).
    if (now <= p.fundingDeadline) {
      if (info.phase === "None" && me === 0) await this.fund(l);
      else if (info.phase === "Funding" && !info.funded[me] && (me === 0 || info.funded[0])) await this.fund(l);
    } else if (info.phase === "Funding" && info.funded[me]) {
      await this.hub.reclaim(this.wallet, id);
    }

    // 2. Adopt on-chain states from dispute events, in order.
    const events = await this.hub.disputeEvents(id, l.record.createdBlock);
    for (const ev of events.slice(l.processedEvents)) {
      try {
        await l.session.ingestOnChain(ev.signed);
      } catch (err) {
        l.lastError = `ingest: ${errorText(err)}`;
      }
    }
    l.processedEvents = events.length;

    // 3. Disputes.
    if (info.phase === "Challenged") {
      const registered = await this.hub.registeredState(id);
      const latest = l.session.latest.state;
      if (latest.turnNum > registered.turnNum) {
        await this.respondIfChallenged(l);
      } else if (latest.turnNum === registered.turnNum && !isGameOver(latest) && mover(latest) === me) {
        await this.autoPlay(l); // checkmated → resign, stalemated → claim; otherwise the controller must move
      } else if (now >= info.deadline && (isGameOver(registered) || mover(registered) !== me)) {
        await this.hub.timeout(this.wallet, id);
      }
    }

    // 4. Settled channels are done.
    const after = await this.hub.channelInfo(id);
    if (after.phase === "Finalized" || after.phase === "Reclaimed") {
      l.record = { ...l.record, finalized: true };
      this.records.saveChannel(l.record);
    }
    await this.refreshChain(l);
  }
```
Note the `timeout` condition. We call `timeout` only when the opponent is on move in the registered state, or the registered game is over. When we are on move, `timeout` would make us forfeit, so we never call it (Review Focus 2).

- [ ] **Step 4: Run tests and typecheck**

Run: `cd packages/cli && pnpm test && pnpm typecheck`
Expected: all cli suites PASS (daemon: 8 tests), typecheck clean, `pgrep -a anvil` empty. The "does not time out a challenge in which it is on move" test must stay deterministic (explicit `tick()`s with Alice stopped); do not weaken the invariant it checks.

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): watchtower: ingest disputes, answer stale challenges, timeouts, reclaim"
```

---

### Task 7: Local HTTP API and the `arena` CLI

**Files:**
- Create: `packages/cli/src/api.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/main.ts`, `packages/cli/bin/arena.mjs`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/api.test.ts`, `packages/cli/test/cli.test.ts`

**Interfaces:**
- Produces:
  - `startApi(daemon, { port, token, host? }): Promise<{ server: Server; url: string }>` (binds 127.0.0.1 by default)
  - `runCli(argv: string[], io: CliIo): Promise<number>`
  - `type CliIo = { env: NodeJS.ProcessEnv; fetch: typeof fetch; out(s: string): void; err(s: string): void }`
  - `main(argv)`

**API routes.** All routes except `/health` require the bearer token. The actor comes from the `x-arena-actor` header (`agent` by default, or `human`). Amounts are decimal strings of USDC base units.

| Method | Path | Body / query | Daemon call |
|---|---|---|---|
| GET | `/health` | none | `{ ok: true }` |
| GET | `/channels` | none | `channels()` |
| GET | `/status` | `?channel=` | `status(ref)` |
| GET | `/wait` | `?channel=&timeout=<seconds, default 60, max 600>` | `wait()` |
| GET | `/offers` | none | `listOffers()` |
| POST | `/offers` | `{ deposit, stakePerGame, challengeTimeout? }` | `createOffer` |
| POST | `/offers/accept` | `{ offerId }` | `acceptOffer` |
| POST | `/move` | `{ channel?, move, offerDraw? }` | `move` |
| POST | `/resign`, `/accept-draw`, `/next-game`, `/close`, `/challenge` | `{ channel? }` | corresponding action |
| POST | `/reclaim` | `{ channel? }` | `reclaim` |
| POST | `/handoff` | `{ channel?, to: "agent" \| "human", note? }` | `handoff` |

Action routes respond with the resulting `status(channel)`. JSON responses encode bigints as decimal strings. `DaemonError` maps to its code; anything else maps to 500. Every error body is `{ error }`.

**CLI commands:**
- `arena init --rpc URL --chain-id N --hub ADDR --usdc ADDR --rules ADDR --server URL [--port N] [--wallet-key HEX] [--max-fee N] [--session-gas-wei N] [--poll-ms N]`
- `arena offers`
- `arena offer --deposit USDC --stake USDC [--timeout SECONDS]`
- `arena accept <offerId>`
- `arena channels`
- `arena status [--channel ID]`
- `arena wait [--channel ID] [--timeout SECONDS]`
- `arena move <move> [--offer-draw] [--channel ID]`
- `arena resign|accept-draw|next-game|close|challenge|reclaim [--channel ID]`
- `arena handoff human|agent [--note TEXT] [--channel ID]`

`--deposit`/`--stake` take USDC decimals ("1.5"), and the CLI converts them with `parseUnits(x, 6)`. Output is pretty JSON on stdout; errors go to stderr as `error: <message>` with exit code 1 (2 for usage errors). `ARENA_HOME` defaults to `~/.arena`. The CLI reads `config.json` (for the port) and `token.json` from it. `arena daemon` is added in Plan 4, once the server transport exists.

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/api.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { loadToken, startApi } from "../src/index.js";
import { startPair, waitFor } from "./helpers/harness.js";

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

describe("local API", () => {
  it("binds 127.0.0.1, requires the token, and drives the daemon", async () => {
    const pair = await startPair();
    const token = loadToken(pair.alice.home);
    const { server, url } = await startApi(pair.alice.daemon, { port: 0, token });
    const bobToken = loadToken(pair.bob.home);
    const bobApi = await startApi(pair.bob.daemon, { port: 0, token: bobToken });
    stop = async () => {
      server.close();
      bobApi.server.close();
      await pair.cleanup();
    };
    expect(url.startsWith("http://127.0.0.1:")).toBe(true);
    expect((server.address() as { address: string }).address).toBe("127.0.0.1");

    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/channels`)).status).toBe(401);
    expect((await fetch(`${url}/channels`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);

    const call = async (base: string, tok: string, method: string, path: string, body?: unknown, actor = "agent") => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", "x-arena-actor": actor },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const offer = await call(url, token, "POST", "/offers", { deposit: "1000000", stakePerGame: "100000", challengeTimeout: "600" });
    expect(offer.status).toBe(200);
    await call(bobApi.url, bobToken, "POST", "/offers/accept", { offerId: offer.body.offerId });
    await waitFor(async () => (await call(url, token, "GET", "/status")).body.phase === "Open", 30_000, "open");

    const moved = await call(url, token, "POST", "/move", { move: "e4" });
    expect(moved.status).toBe(200);
    expect(moved.body.turnNum).toBe("1");
    expect((await call(url, token, "POST", "/move", { move: "d4" })).status).toBe(409);

    const w = await call(bobApi.url, bobToken, "GET", "/wait?timeout=10");
    expect(w.body.reason).toBe("your-turn");

    expect((await call(url, token, "POST", "/handoff", { to: "human", note: "n" })).body.controller).toBe("human");
    expect((await call(url, token, "POST", "/handoff", { to: "robot" })).status).toBe(400);
  });
});
```

`packages/cli/test/cli.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, runCli } from "../src/index.js";

function io(home: string, responses: Array<{ status: number; body: unknown }> = []) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { calls, out, err, io: { env: { ARENA_HOME: home }, fetch: fetchFn, out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

const INIT = [
  "init", "--rpc", "http://127.0.0.1:8546", "--chain-id", "31337",
  "--hub", "0x000000000000000000000000000000000000beef", "--usdc", "0x000000000000000000000000000000000000cafe",
  "--rules", "0x00000000000000000000000000000000000000e5", "--server", "http://127.0.0.1:3000", "--port", "7010",
];

describe("arena CLI", () => {
  it("init writes the home", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-cli-"));
    const t = io(home);
    expect(await runCli(INIT, t.io)).toBe(0);
    expect(loadConfig(home).port).toBe(7010);
    expect(loadConfig(home).maxFeePerPlayer).toBe(10_000n);
  });

  it("maps commands to API calls with the token and agent actor", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-cli-"));
    const t = io(home);
    await runCli(INIT, t.io);
    expect(await runCli(["move", "e4", "--offer-draw", "--channel", "0xab"], t.io)).toBe(0);
    const c = t.calls.at(-1)!;
    expect(c.url).toBe("http://127.0.0.1:7010/move");
    expect(c.init.method).toBe("POST");
    expect(JSON.parse(String(c.init.body))).toEqual({ move: "e4", offerDraw: true, channel: "0xab" });
    const headers = new Headers(c.init.headers);
    expect(headers.get("authorization")).toMatch(/^Bearer [0-9a-f]{64}$/);
    expect(headers.get("x-arena-actor")).toBe("agent");

    await runCli(["offer", "--deposit", "1.5", "--stake", "0.1"], t.io);
    expect(JSON.parse(String(t.calls.at(-1)!.init.body))).toEqual({
      deposit: "1500000",
      stakePerGame: "100000",
      challengeTimeout: "600",
    });
    await runCli(["wait", "--timeout", "30"], t.io);
    expect(t.calls.at(-1)!.url).toBe("http://127.0.0.1:7010/wait?timeout=30");
    await runCli(["handoff", "human", "--note", "look"], t.io);
    expect(JSON.parse(String(t.calls.at(-1)!.init.body))).toEqual({ to: "human", note: "look" });
  });

  it("reports API errors and usage errors", async () => {
    const home = mkdtempSync(join(tmpdir(), "arena-cli-"));
    const t = io(home, [{ status: 409, body: { error: "not your turn" } }]);
    await runCli(INIT, io(home).io);
    expect(await runCli(["move", "e4"], t.io)).toBe(1);
    expect(t.err.join("\n")).toContain("not your turn");
    expect(await runCli(["frobnicate"], t.io)).toBe(2);
    expect(await runCli(["move"], t.io)).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/cli && pnpm test -- test/api.test.ts test/cli.test.ts`
Expected: FAIL, because `startApi`/`runCli` are missing.

- [ ] **Step 3: Implement**

`packages/cli/src/api.ts`:
```ts
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";
import { DaemonError, type Actor, type ArenaDaemon } from "./daemon.js";

function send(res: ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new DaemonError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new DaemonError(400, "body must be a JSON object");
  }
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
function amount(v: unknown, name: string): bigint {
  if (typeof v !== "string" || !/^[0-9]+$/.test(v)) throw new DaemonError(400, `${name} must be a decimal string of base units`);
  return BigInt(v);
}

export async function startApi(
  daemon: ArenaDaemon,
  opts: { port: number; token: string; host?: string },
): Promise<{ server: Server; url: string }> {
  const host = opts.host ?? "127.0.0.1";
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${host}`);
        const route = `${req.method} ${url.pathname}`;
        if (route === "GET /health") return send(res, 200, { ok: true });
        if (!authorized(req, opts.token)) return send(res, 401, { error: "missing or invalid token" });
        const actor: Actor = req.headers["x-arena-actor"] === "human" ? "human" : "agent";
        const q = url.searchParams;
        const b = req.method === "POST" ? await body(req) : {};
        const ch = str(b.channel) ?? str(q.get("channel") ?? undefined);
        switch (route) {
          case "GET /channels":
            return send(res, 200, await daemon.channels());
          case "GET /status":
            return send(res, 200, await daemon.status(ch));
          case "GET /wait": {
            const seconds = Math.min(600, Math.max(0, Number(q.get("timeout") ?? "60") || 0));
            return send(res, 200, await daemon.wait({ ref: ch, timeoutMs: seconds * 1000 }));
          }
          case "GET /offers":
            return send(res, 200, await daemon.listOffers());
          case "POST /offers":
            return send(
              res,
              200,
              await daemon.createOffer({
                deposit: amount(b.deposit, "deposit"),
                stakePerGame: amount(b.stakePerGame, "stakePerGame"),
                challengeTimeout: b.challengeTimeout === undefined ? 600n : amount(b.challengeTimeout, "challengeTimeout"),
              }),
            );
          case "POST /offers/accept": {
            const id = str(b.offerId);
            if (!id) throw new DaemonError(400, "offerId is required");
            await daemon.acceptOffer(id as Hex);
            return send(res, 200, { accepted: id });
          }
          case "POST /move": {
            const m = str(b.move);
            if (!m) throw new DaemonError(400, "move is required");
            await daemon.move(ch, m, { offerDraw: b.offerDraw === true, actor });
            return send(res, 200, await daemon.status(ch));
          }
          case "POST /resign":
            await daemon.resign(ch, actor);
            return send(res, 200, await daemon.status(ch));
          case "POST /accept-draw":
            await daemon.acceptDraw(ch, actor);
            return send(res, 200, await daemon.status(ch));
          case "POST /next-game":
            await daemon.nextGame(ch, actor);
            return send(res, 200, await daemon.status(ch));
          case "POST /close":
            await daemon.close(ch, actor);
            return send(res, 200, await daemon.status(ch));
          case "POST /challenge":
            await daemon.challenge(ch, actor);
            return send(res, 200, await daemon.status(ch));
          case "POST /reclaim":
            await daemon.reclaim(ch);
            return send(res, 200, await daemon.status(ch));
          case "POST /handoff": {
            const to = b.to;
            if (to !== "agent" && to !== "human") throw new DaemonError(400, 'to must be "agent" or "human"');
            await daemon.handoff(ch, to, typeof b.note === "string" ? b.note : "");
            return send(res, 200, await daemon.status(ch));
          }
          default:
            return send(res, 404, { error: `no route ${route}` });
        }
      } catch (err) {
        if (err instanceof DaemonError) return send(res, err.code, { error: err.message });
        return send(res, 500, { error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(opts.port, host, resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://${host}:${port}` };
}
```

`packages/cli/src/cli.ts`:
```ts
import { parseUnits, type Address, type Hex } from "viem";
import { defaultHome, initHome, loadConfig, loadToken, type ArenaConfig } from "./config.js";

export type CliIo = {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  out(s: string): void;
  err(s: string): void;
};

const USAGE = `usage: arena <command> [options]
  init --rpc URL --chain-id N --hub ADDR --usdc ADDR --rules ADDR --server URL [--port N] [--wallet-key HEX]
       [--max-fee N] [--session-gas-wei N] [--poll-ms N]
  offers | offer --deposit USDC --stake USDC [--timeout SECONDS] | accept <offerId>
  channels | status [--channel ID] | wait [--channel ID] [--timeout SECONDS]
  move <move> [--offer-draw] [--channel ID]
  resign | accept-draw | next-game | close | challenge | reclaim  [--channel ID]
  handoff human|agent [--note TEXT] [--channel ID]`;

class UsageError extends Error {}

function parse(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--offer-draw") flags.set("offer-draw", true);
    else if (a.startsWith("--")) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`missing value for ${a}`);
      flags.set(a.slice(2), v);
      i++;
    } else positional.push(a);
  }
  return { positional, flags };
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  try {
    const { positional, flags } = parse(argv);
    const [cmd, arg] = positional;
    const home = defaultHome(io.env);
    const flag = (name: string) => {
      const v = flags.get(name);
      return typeof v === "string" ? v : undefined;
    };
    const need = (name: string) => {
      const v = flag(name);
      if (!v) throw new UsageError(`--${name} is required`);
      return v;
    };

    if (cmd === "init") {
      const cfg: ArenaConfig = {
        rpcUrl: need("rpc"),
        chainId: Number(need("chain-id")),
        hub: need("hub") as Address,
        usdc: need("usdc") as Address,
        rules: need("rules") as Address,
        serverUrl: need("server"),
        port: Number(flag("port") ?? "7070"),
        maxFeePerPlayer: BigInt(flag("max-fee") ?? "10000"),
        sessionGasWei: BigInt(flag("session-gas-wei") ?? "10000000000000000"),
        pollMs: Number(flag("poll-ms") ?? "2000"),
      };
      const { walletKey } = initHome(home, cfg, flag("wallet-key") as Hex | undefined);
      const { privateKeyToAccount } = await import("viem/accounts");
      io.out(JSON.stringify({ home, wallet: privateKeyToAccount(walletKey).address, port: cfg.port }, null, 2));
      return 0;
    }

    const channel = flag("channel");
    const withChannel = (b: Record<string, unknown>) => (channel ? { ...b, channel } : b);
    let request: { method: "GET" | "POST"; path: string; body?: Record<string, unknown> };
    switch (cmd) {
      case "offers":
        request = { method: "GET", path: "/offers" };
        break;
      case "offer":
        request = {
          method: "POST",
          path: "/offers",
          body: {
            deposit: parseUnits(need("deposit"), 6).toString(),
            stakePerGame: parseUnits(need("stake"), 6).toString(),
            challengeTimeout: flag("timeout") ?? "600",
          },
        };
        break;
      case "accept":
        if (!arg) throw new UsageError("accept needs an offer id");
        request = { method: "POST", path: "/offers/accept", body: { offerId: arg } };
        break;
      case "channels":
        request = { method: "GET", path: "/channels" };
        break;
      case "status":
        request = { method: "GET", path: `/status${channel ? `?channel=${channel}` : ""}` };
        break;
      case "wait": {
        const qs = new URLSearchParams();
        if (channel) qs.set("channel", channel);
        qs.set("timeout", flag("timeout") ?? "60");
        request = { method: "GET", path: `/wait?${qs.toString()}` };
        break;
      }
      case "move":
        if (!arg) throw new UsageError("move needs a move, e.g. arena move e4");
        request = {
          method: "POST",
          path: "/move",
          body: withChannel(flags.has("offer-draw") ? { move: arg, offerDraw: true } : { move: arg }),
        };
        break;
      case "resign":
      case "accept-draw":
      case "next-game":
      case "close":
      case "challenge":
      case "reclaim":
        request = { method: "POST", path: `/${cmd}`, body: withChannel({}) };
        break;
      case "handoff":
        if (arg !== "human" && arg !== "agent") throw new UsageError("handoff needs human or agent");
        request = { method: "POST", path: "/handoff", body: withChannel(flag("note") ? { to: arg, note: flag("note") } : { to: arg }) };
        break;
      default:
        throw new UsageError(cmd ? `unknown command ${cmd}` : "no command given");
    }

    const cfg = loadConfig(home);
    const token = loadToken(home);
    const res = await io.fetch(`http://127.0.0.1:${cfg.port}${request.path}`, {
      method: request.method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-arena-actor": "agent" },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
    const payload = (await res.json()) as unknown;
    if (!res.ok) {
      io.err(`error: ${(payload as { error?: string }).error ?? res.statusText}`);
      return 1;
    }
    io.out(JSON.stringify(payload, null, 2));
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`error: ${err.message}\n${USAGE}`);
      return 2;
    }
    io.err(`error: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    return 1;
  }
}
```

`packages/cli/src/main.ts`:
```ts
import { runCli } from "./cli.js";

export async function main(argv: string[]): Promise<number> {
  return runCli(argv, {
    env: process.env,
    fetch,
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
  });
}
```

`packages/cli/bin/arena.mjs`:
```js
#!/usr/bin/env node
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/main.ts");
process.exitCode = await main(process.argv.slice(2));
```
Run `chmod +x packages/cli/bin/arena.mjs`. Add `export * from "./api.js"; export * from "./cli.js";` to `src/index.ts`.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd packages/cli && pnpm test && pnpm typecheck && node bin/arena.mjs frobnicate; echo "exit=$?"`
Expected: all suites PASS (api 1, cli 3), typecheck clean. The bin prints usage to stderr and `exit=2`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): token-protected local API and the arena command"
```

---

### Task 8: End-to-end: full match, restart, handoff; docs and root script

**Files:**
- Create: `packages/cli/test/e2e.test.ts`, `packages/cli/README.md`
- Modify: root `package.json` (add `"test:cli": "pnpm --filter @arena/cli test"`)

- [ ] **Step 1: Write the end-to-end test**

`packages/cli/test/e2e.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { ArenaDaemon, loadConfig, type ArenaDaemon as Daemon } from "../src/index.js";
import { usdcBalance } from "../../sdk/test/helpers/chain.js";
import { SCHOLARS_MATE } from "../../sdk/test/helpers/fixtures.js";
import { START, startPair, waitFor } from "./helpers/harness.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function playLine(white: Daemon, black: Daemon, id: `0x${string}`, moves: string[]) {
  for (const m of moves) {
    const [mover, other] = white.handle(id).session.isMyTurn() ? [white, black] : [black, white];
    await mover.move(id, m, { actor: "agent" });
    await waitFor(() => other.handle(id).session.latest.state.turnNum === mover.handle(id).session.latest.state.turnNum, 5_000, `relay ${m}`);
  }
}

describe("arena end-to-end (two daemons, Anvil)", () => {
  it("match → game 0 (auto-resign on mate) → game 1 → cooperative close", async () => {
    const pair = await startPair();
    cleanup = pair.cleanup;
    const { alice, bob, env } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    await waitFor(async () => (await alice.daemon.status(id)).phase === "Open", 30_000, "open");

    await playLine(alice.daemon, bob.daemon, id, SCHOLARS_MATE); // Alice (white) mates; Bob's daemon auto-resigns
    await waitFor(async () => (await alice.daemon.status(id)).gameStatus === "white_won", 10_000, "game 0 over");
    expect((await alice.daemon.status(id)).attention).toBe("game-over");

    await alice.daemon.nextGame(id, "agent");
    await waitFor(async () => (await bob.daemon.status(id)).attention === "new-game-proposed", 10_000, "proposal");
    await bob.daemon.nextGame(id, "agent");
    await waitFor(async () => (await bob.daemon.status(id)).myTurn, 10_000, "game 1 starts with Bob as white");

    await playLine(bob.daemon, alice.daemon, id, SCHOLARS_MATE); // Bob mates; Alice auto-resigns
    await waitFor(async () => (await bob.daemon.status(id)).gameStatus === "white_won", 10_000, "game 1 over");

    await alice.daemon.close(id, "agent");
    await waitFor(async () => (await bob.daemon.status(id)).attention === "close-requested", 10_000, "close requested");
    await bob.daemon.close(id, "agent");
    await waitFor(async () => (await alice.daemon.status(id)).phase === "Finalized", 20_000, "finalized");
    expect(await usdcBalance(env.usdc, alice.address)).toBe(START - 5_000n);
    expect(await usdcBalance(env.usdc, bob.address)).toBe(START - 5_000n);
    expect(await usdcBalance(env.usdc, env.host)).toBe(10_000n);
  });

  it("resumes after a daemon restart without re-signing", async () => {
    const pair = await startPair();
    cleanup = pair.cleanup;
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    await waitFor(async () => (await alice.daemon.status(id)).phase === "Open", 30_000, "open");
    await alice.daemon.move(id, "e4", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");

    await alice.daemon.stop();
    const restarted = new ArenaDaemon({
      home: alice.home,
      config: loadConfig(alice.home),
      walletKey: alice.walletKey,
      lobby: alice.client.lobby,
      relay: alice.client.relay,
    });
    await restarted.start();
    pair.alice.daemon = restarted;
    expect(restarted.handle(id).session.snapshot().lastSignedTurn).toBe(1n);
    await expect(restarted.move(id, "d4", { actor: "agent" })).rejects.toThrow(/not your turn/);
    await bob.daemon.move(id, "e5", { actor: "agent" });
    await waitFor(() => restarted.handle(id).session.isMyTurn(), 5_000, "alice turn after restart");
    await restarted.move(id, "Nf3", { actor: "agent" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "relay after restart");
    // Funding was not repeated by the restart.
    expect((await restarted.hub.channelInfo(id)).phase).toBe("Open");
  });

  it("human takes over mid-game and hands back; wait only wakes the agent when it controls", async () => {
    const pair = await startPair();
    cleanup = pair.cleanup;
    const { alice, bob } = pair;
    const { offerId } = await alice.daemon.createOffer({ deposit: 1_000_000n, stakePerGame: 100_000n, challengeTimeout: 600n });
    await bob.daemon.acceptOffer(offerId);
    const id = await waitFor(() => alice.daemon.channelIds()[0], 20_000, "match");
    await waitFor(async () => (await alice.daemon.status(id)).phase === "Open", 30_000, "open");

    await alice.daemon.handoff(id, "human", "let me play the opening");
    expect((await alice.daemon.wait({ timeoutMs: 300 })).reason).toBe("timeout");
    await expect(alice.daemon.move(id, "e4", { actor: "agent" })).rejects.toThrow(/human is in control/);
    await alice.daemon.move(id, "e4", { actor: "human" });
    await waitFor(() => bob.daemon.handle(id).session.isMyTurn(), 5_000, "bob turn");
    await bob.daemon.move(id, "e5", { actor: "agent" });
    await waitFor(() => alice.daemon.handle(id).session.isMyTurn(), 5_000, "alice turn");
    await alice.daemon.handoff(id, "agent", "");
    expect((await alice.daemon.wait({ timeoutMs: 5_000 })).reason).toBe("your-turn");
  });
});
```

- [ ] **Step 2: Run the e2e test**

Run: `cd packages/cli && export PATH="$HOME/.foundry/bin:$HOME/.local/bin:$PATH" && pnpm test -- test/e2e.test.ts`
Expected: 3 tests PASS; no anvil left running. Fix daemon bugs the e2e test reveals in `src/`, and report each. Never loosen the funds, controller, or no-re-sign assertions.

- [ ] **Step 3: README and root script**

`packages/cli/README.md`:
````markdown
# @arena/cli — player daemon and `arena` command

The daemon holds your per-channel session keys and plays the state-channel protocol for you. It:

- funds channels in the right order;
- exchanges signed moves with the opponent through the host relay;
- runs a watchtower (answers stale challenges, resigns when mated, times out silent opponents, reclaims unfunded deposits);
- lets a human take over a channel from the agent and hand it back.

The `arena` command is a thin client for the daemon's local API (127.0.0.1, bearer token in `ARENA_HOME`).

## Setup

    arena init --rpc http://127.0.0.1:8545 --chain-id 31337 --hub 0x… --usdc 0x… --rules 0x… \
               --server http://127.0.0.1:3000 [--port 7070]
    # starting the daemon (`arena daemon`) arrives with the host server in Plan 4

`ARENA_HOME` (default `~/.arena`) holds `config.json`, `wallet.json`, `token.json` and `channels/<id>/`. All of these files are mode 0600.

## Playing (agent loop)

    arena offers                        # open offers in the lobby
    arena offer --deposit 1 --stake 0.1 # or accept one: arena accept <offerId>
    arena wait --timeout 60             # blocks until a channel needs you
    arena status                        # FEN, ASCII board, legal moves (SAN), balances, suggested actions
    arena move e4 [--offer-draw]
    arena resign | accept-draw | next-game | close
    arena handoff human --note "…"      # a human plays from the web board; "arena handoff agent" returns control

Close is only possible on a finished game. To stop before playing, move with `--offer-draw`, accept the draw, and close.
````

In the root `package.json` `scripts`, add `"test:cli": "pnpm --filter @arena/cli test"`.

- [ ] **Step 4: Full verification**

Run from the repo root:
```bash
export PATH="$HOME/.foundry/bin:$HOME/.local/bin:$PATH"
pnpm test:sdk && pnpm test:cli && pnpm --filter @arena/sdk typecheck && pnpm --filter @arena/cli typecheck && pnpm test:contracts
```
Expected: everything PASSES (contracts 115/115); no anvil left running.

- [ ] **Step 5: Commit**

```bash
git add packages/cli package.json
git commit -m "test(cli): end-to-end match, restart and handoff; README and test:cli"
```
