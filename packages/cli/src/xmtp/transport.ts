import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { hexToBytes, keccak256, toHex, type Address, type Hex } from "viem";
import type { RelaySigner } from "@arena/sdk";
import type { XmtpConfig } from "../config.js";

/**
 * Plan 5.7 (spec §3): one XMTP client per channel, whose identity is that channel's own session key, talking in a
 * DM to the opponent's session key. Text in, text out: framing and every acceptance check live in `XmtpRelay`.
 */
export interface XmtpTransport {
  /** Starts (or resumes from its DB) the XMTP client for one channel's session key, and opens a DM to `peer`. */
  open(channelId: Hex, me: RelaySigner, peer: Address): Promise<void>;
  send(channelId: Hex, text: string): Promise<void>;
  /** `from` is the XMTP sender's Ethereum address; `dm` is the peer address of the conversation it arrived in. */
  onText(handler: (channelId: Hex, from: Address, dm: Address, text: string) => void): () => void;
  close(channelId: Hex): Promise<void>;
  stop(): Promise<void>;
}

/**
 * What the node-SDK transport reports as `from` (or `dm`) for a sender (or conversation) that is not the channel's
 * opponent. It never resolves a stranger's inbox to an address: once the opponent's inbox is known, a flood from third
 * parties costs one string compare each, and the zero address can never equal a channel's signer, so `XmtpRelay`
 * drops it as a wrong sender.
 */
export const NOT_THE_PEER: Address = "0x0000000000000000000000000000000000000000";

/** How many of the opponent DM's latest messages are re-delivered each time the inbound stream (re)starts: a stream
 *  only carries messages that arrive after it starts, so a message that landed while the daemon was down (a restart
 *  mid-fallback) or while the stream was down (a network gap) would otherwise never reach the session. They go
 *  through the same queue and acceptance checks as streamed ones; one already delivered (same XMTP message id) is
 *  skipped, and any other repeat is a no-op for the session. */
export const XMTP_CATCH_UP_MESSAGES = 8;

/** The local DB's encryption key (Global Constraints, spec §3): RFC 6979 signing makes it stable, so there is no new
 *  secret to store, and the raw session key never reaches XMTP code (I5). */
export async function xmtpDbKey(signer: RelaySigner, channelId: Hex): Promise<Hex> {
  return keccak256(await signer.signMessage({ message: { raw: toHex(`arena-xmtp-db/v1:${channelId}`) } }));
}

/** The XMTP `Signer` for a session key: an EOA identified by its lower-cased address, signing through `RelaySigner`
 *  (EIP-191 over the UTF-8 bytes of XMTP's text, which is what XMTP verifies). */
export function xmtpSignerOf(signer: RelaySigner, ethereumKind: number) {
  return {
    type: "EOA" as const,
    getIdentifier: () => ({ identifier: signer.address.toLowerCase(), identifierKind: ethereumKind }),
    signMessage: async (m: string) => hexToBytes(await signer.signMessage({ message: { raw: toHex(m) } })),
  };
}

// ------------------------------------------------------- the slice of @xmtp/node-sdk 6.0.0 this file uses
// Structural types only: the SDK is never imported statically (it is loaded at runtime by loader.ts).

type SdkIdentifier = { identifier: string; identifierKind: number };
type SdkMessage = { id: string; content: unknown; conversationId: string; senderInboxId: string; sentAtNs?: bigint };
type SdkConversation = { readonly id: string; readonly peerInboxId?: string; updateConsentState?(state: number): void };
type SdkDm = SdkConversation & {
  readonly peerInboxId: string;
  sendText(text: string): Promise<string>;
  messages(opts?: { limit?: number; direction?: number }): Promise<SdkMessage[]>;
};
/** The SDK's AsyncStreamProxy: async-iterable, ended by `end()`. */
type SdkStream = AsyncIterable<SdkMessage | undefined> & { end(): Promise<unknown> };
type SdkClient = {
  readonly inboxId: string;
  fetchInboxIdByIdentifier(identifier: SdkIdentifier): Promise<string | null>;
  preferences?: { getInboxStates(inboxIds: string[]): Promise<Array<{ identifiers?: SdkIdentifier[] }>> };
  conversations: {
    createDmWithIdentifier(identifier: SdkIdentifier): Promise<SdkDm>;
    getConversationById(id: string): Promise<SdkConversation | undefined>;
    listGroups?(opts?: { consentStates?: number[] }): SdkConversation[];
    streamAllMessages(opts: {
      conversationType?: number;
      consentStates?: number[];
      retryOnFail?: boolean;
      onError?: (err: Error) => void;
    }): Promise<SdkStream>;
  };
};
type NodeSdk = {
  Client: { create(signer: unknown, opts: Record<string, unknown>): Promise<SdkClient> };
  IdentifierKind: { Ethereum: number };
  ConversationType?: { Dm?: number };
  SortDirection?: { Descending?: number };
  ConsentState?: { Unknown?: number; Allowed?: number; Denied?: number };
  isText?: (m: SdkMessage) => boolean;
};

type Entry = {
  channelId: Hex;
  me: RelaySigner;
  peer: Address;
  client: SdkClient | null;
  stream: SdkStream | null;
  dm: SdkDm | null;
  peerInboxId: string | null;
  lastPeerLookup: number;
  opening: Promise<void>;
  closed: boolean;
  /** Cancels the restart back-off sleep, if one is running. */
  wake: (() => void) | null;
  /** XMTP message ids already delivered, oldest first (bounded): the catch-up and the stream can overlap. */
  seen: Set<string>;
  /** conversationId -> the DM's peer inbox id (null: not a DM), so a conversation is looked up once, not per message.
   *  Only definitive answers are cached: a lookup that came back empty (the SDK turns any error into `undefined`) is
   *  retried, no sooner than `unresolvedUntil` allows. */
  convPeer: Map<string, string | null>;
  /** conversationId -> when (monotonic ms) a lookup that came back empty may be tried again (bounded). */
  unresolvedUntil: Map<string, number>;
  /** Sender inbox ids found not to be the opponent's while its inbox was still unknown (bounded). */
  notPeer: Set<string>;
  /** Strangers' conversations already denied (bounded). */
  denied: Set<string>;
  /** Set when an opponent message's conversation could not be resolved: from then on every opponent message is
   *  held (in `held`, neither emitted nor `seen`), so none can overtake it, until a catch-up -- which finds the DM by
   *  the opponent's address, the path that handles XMTP's DM stitching -- resolves them all, in order. */
  gap: boolean;
  /** The opponent's messages held while `gap` is set, in arrival order (bounded: `HELD_MAX`). */
  held: SdkMessage[];
  /** While `gap` is set: when (monotonic ms) the next catch-up may be tried, and the back-off after that. */
  gapRetryAt: number;
  gapBackoffMs: number;
  /** While `gap` is set: restarts the stream when the next catch-up is due, so the gap closes even if no further
   *  message arrives. One pending at a time. */
  refresh: ReturnType<typeof setTimeout> | undefined;
  /** The next restart is a deliberate one: no back-off. */
  refreshing: boolean;
};

/** A failed or ended stream is re-created after this back-off, doubling up to the cap, for as long as the channel is
 *  open (the transport owns the restart loop: the SDK's own gives up after 10 attempts and can outlive `end()`). */
const STREAM_RESTART_MIN_MS = 1_000;
const STREAM_RESTART_MAX_MS = 30_000;
/** A stream that stayed up this long resets the back-off. */
const STREAM_HEALTHY_MS = 60_000;
/** The opponent's inbox id is looked up on the network at most this often until it is known (it is null until the
 *  opponent's own client has registered). */
const PEER_LOOKUP_INTERVAL_MS = 1_000;
/** Bounds on the per-channel caches above. */
const SEEN_MAX = 512;
const CACHE_MAX = 256;
/** An opponent message whose conversation lookup comes back empty is retried in place this many times, after these
 *  pauses, before it is passed on as "not in the DM" (and left un-`seen`, so a later catch-up can deliver it). The
 *  channel's later messages wait meanwhile: delivery order is kept. */
const UNRESOLVED_RETRY_MS = [100, 400, 1_500];
/** After that, the same conversation is not looked up again for this long (a hot loop is impossible). */
const UNRESOLVED_HOLD_MS = 5_000;
/** While a gap is open: the first catch-up retry comes after this long, doubling up to the cap. */
const GAP_RETRY_MIN_MS = 5_000;
const GAP_RETRY_MAX_MS = 60_000;
/** At most this many opponent messages are held while a gap is open, each at most `HELD_TEXT_MAX` characters (larger
 *  ones are over XmtpRelay's 16 KiB anyway). A catch-up reads `XMTP_CATCH_UP_MESSAGES` plus the held count back. */
const HELD_MAX = 64;
const HELD_TEXT_MAX = 64 * 1024;
/** The network calls on the inbound path (the opponent's inbox, the DM) give up after this long. */
const NETWORK_TIMEOUT_MS = 5_000;

const errorText = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Adds `value` to a bounded insertion-ordered set, evicting the oldest. */
function remember<T>(set: Set<T>, value: T, max: number): void {
  set.add(value);
  if (set.size > max) set.delete(set.values().next().value as T);
}

/** `p`, or a rejection after `ms` (the call itself carries on). The timer never keeps the process alive. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Monotonic milliseconds: throttles and back-offs must never stretch on a wall-clock step. */
const monotonic = () => performance.now();

/**
 * The `XmtpTransport` over `@xmtp/node-sdk` 6.0.0 (`sdk` is the module `loadXmtpSdk` returned). Each channel's DB is
 * `<dbDir>/<channelId>.db3`, encrypted with `xmtpDbKey`, so a restarted daemon resumes the same installation
 * (XMTP caps an inbox at 10).
 *
 * Inbound, per channel, one serial pipeline: each (re)start of the DM stream first re-delivers the opponent DM's
 * latest `XMTP_CATCH_UP_MESSAGES`, then drains the stream with `for await`, one message at a time. So messages reach
 * `onText` in arrival order, and the SDK's stream buffer never grows: the SDK queues every streamed message until it
 * is read, which is why `onValue` is never used. The transport owns the restart loop (`retryOnFail: false`): a
 * stream that fails or ends is re-created with back-off for as long as the channel is open, and never after `close`.
 *
 * Sender and conversation are resolved against the opponent's inbox only (see `NOT_THE_PEER`). A DM's peer is looked
 * up once per conversation and cached; a lookup that comes back empty is retried in place (bounded), never cached. If
 * it stays empty, the channel opens a *gap*: that message and every later one from the opponent are held (bounded,
 * never emitted or marked delivered), and a catch-up -- which finds the DM by the opponent's address, across XMTP's
 * DM stitching, with no conversation lookup -- resolves them all and delivers them in send order. It is tried at once,
 * then with back-off (a stream restart arms each retry, so the gap closes even if the opponent sends nothing more)
 * until it succeeds. Only the opponent's own messages can open a gap; a stranger never can.
 *
 * Strangers: a stranger's DM is set to consent `Denied` on its first message -- once the opponent's inbox is known,
 * or earlier, when the sender's own inbox (read locally) is bound to addresses that do not include the opponent's.
 * Every stream (re)start also denies any group still in `Unknown` consent (an arena channel never uses groups). Streams
 * and syncs ask only for `Allowed` and `Unknown` conversations, so a stranger is dropped and counted once and its
 * conversation is not synced again. What the SDK stores regardless: each stranger's welcome (the new conversation),
 * the messages it delivered before the deny (for a group: what the next restart's sync fetched), and its inbox's
 * identity record -- all in the channel's own encrypted DB.
 *
 * The SDK has no public way to close a client: `close`/`stop` end the channel's stream, stop its restart loop and drop
 * every reference; the native client releases its DB when it is garbage-collected. The DB file is never deleted.
 */
export function createNodeSdkTransport(opts: { sdk: unknown; dbDir: string; config: XmtpConfig; log(l: string): void }): XmtpTransport {
  const sdk = opts.sdk as NodeSdk;
  const log = opts.log;
  const ethereum = sdk.IdentifierKind.Ethereum;
  const entries = new Map<Hex, Entry>();
  const handlers = new Set<(channelId: Hex, from: Address, dm: Address, text: string) => void>();
  const identifierOf = (address: Address): SdkIdentifier => ({ identifier: address.toLowerCase(), identifierKind: ethereum });
  const isText = (m: SdkMessage) => (typeof sdk.isText === "function" ? sdk.isText(m) : true) && typeof m.content === "string";
  const consent = sdk.ConsentState;
  const wantedConsent =
    consent?.Allowed !== undefined && consent.Unknown !== undefined ? [consent.Allowed, consent.Unknown] : undefined;

  function emit(channelId: Hex, from: Address, dm: Address, text: string): void {
    for (const h of handlers) {
      try {
        h(channelId, from, dm, text);
      } catch (err) {
        log(`xmtp: onText handler threw: ${errorText(err)}`);
      }
    }
  }

  /** The opponent's inbox id, if known yet, and whether `sender` is definitely someone else. While the opponent's
   *  inbox is unknown, the sender is checked locally first (an inbox lists the addresses bound to it, each by that
   *  address's own signature, so an inbox whose list lacks the opponent's address is not the opponent's), then on the
   *  network, throttled and with a timeout. */
  async function peerInboxIdOf(e: Entry, sender: string): Promise<{ peer: string | null; stranger: boolean }> {
    if (e.peerInboxId !== null) return { peer: e.peerInboxId, stranger: !same(sender, e.peerInboxId) };
    if (e.dm) {
      e.peerInboxId = e.dm.peerInboxId;
      return { peer: e.peerInboxId, stranger: !same(sender, e.peerInboxId) };
    }
    if (!e.client) return { peer: null, stranger: false };
    if (e.notPeer.has(sender)) return { peer: null, stranger: true };
    const states = (await e.client.preferences?.getInboxStates([sender]).catch(() => [])) ?? [];
    const bound = (states[0]?.identifiers ?? []).filter((i) => i.identifierKind === ethereum);
    if (bound.some((i) => same(i.identifier, e.peer))) {
      e.peerInboxId = sender;
      return { peer: sender, stranger: false };
    }
    if (bound.length > 0) {
      remember(e.notPeer, sender, CACHE_MAX); // bound to other addresses only: definitely not the opponent
      return { peer: null, stranger: true };
    }
    if (monotonic() - e.lastPeerLookup >= PEER_LOOKUP_INTERVAL_MS) {
      e.lastPeerLookup = monotonic();
      const client = e.client;
      const id = await withTimeout(client.fetchInboxIdByIdentifier(identifierOf(e.peer)), NETWORK_TIMEOUT_MS, "inbox lookup").catch(
        () => null,
      );
      if (id) e.peerInboxId = id;
    }
    return { peer: e.peerInboxId, stranger: e.peerInboxId !== null && !same(sender, e.peerInboxId) };
  }

  /** The DM to the opponent, created (or found: the SDK returns an existing DM) on first use. It fails until the
   *  opponent's client has registered, so it is retried on every `send` and stream (re)start. */
  async function dmOf(e: Entry): Promise<SdkDm> {
    if (e.dm) return e.dm;
    if (!e.client) throw new Error("xmtp: client not started");
    const dm = await e.client.conversations.createDmWithIdentifier(identifierOf(e.peer));
    e.dm = dm;
    if (e.peerInboxId === null) e.peerInboxId = dm.peerInboxId;
    e.convPeer.set(dm.id, dm.peerInboxId);
    e.unresolvedUntil.delete(dm.id);
    return dm;
  }

  /** Whether a conversation whose lookup came back empty is still inside its hold (not to be looked up yet). */
  function isHeld(e: Entry, conversationId: string): boolean {
    const until = e.unresolvedUntil.get(conversationId);
    return until !== undefined && monotonic() < until;
  }

  /** A conversation, never looked up while held. */
  async function lookUp(e: Entry, conversationId: string): Promise<SdkConversation | undefined> {
    if (isHeld(e, conversationId)) return undefined;
    const conv = await e.client?.conversations.getConversationById(conversationId);
    if (conv) e.unresolvedUntil.delete(conversationId);
    return conv;
  }

  function holdUnresolved(e: Entry, conversationId: string): void {
    e.unresolvedUntil.delete(conversationId); // re-inserted last: the bound evicts the oldest hold
    e.unresolvedUntil.set(conversationId, monotonic() + UNRESOLVED_HOLD_MS);
    if (e.unresolvedUntil.size > CACHE_MAX) e.unresolvedUntil.delete(e.unresolvedUntil.keys().next().value as string);
  }

  /** A conversation's DM peer inbox id (null when not a DM), cached once known; `unresolved` when the lookup came
   *  back empty even after `UNRESOLVED_RETRY_MS`. */
  async function convPeerOf(e: Entry, conversationId: string): Promise<{ peer: string | null; conv?: SdkConversation; unresolved?: true }> {
    if (e.convPeer.has(conversationId)) return { peer: e.convPeer.get(conversationId) ?? null };
    if (isHeld(e, conversationId)) return { peer: null, unresolved: true }; // no lookup, no retries: still held
    let conv = await lookUp(e, conversationId);
    for (const pause of UNRESOLVED_RETRY_MS) {
      if (conv || e.closed) break;
      await sleep(e, pause);
      conv = await lookUp(e, conversationId);
    }
    if (!conv) {
      holdUnresolved(e, conversationId);
      return { peer: null, unresolved: true };
    }
    const peer = typeof conv.peerInboxId === "string" ? conv.peerInboxId : null;
    e.convPeer.set(conversationId, peer);
    if (e.convPeer.size > CACHE_MAX) e.convPeer.delete(e.convPeer.keys().next().value as string);
    return { peer, conv };
  }

  /** Sets a conversation's consent; never throws (a native failure only means it is tried again later). */
  function setConsent(conv: SdkConversation, state: number | undefined): boolean {
    if (state === undefined || typeof conv.updateConsentState !== "function") return false;
    try {
      conv.updateConsentState(state);
      return true;
    } catch {
      return false;
    }
  }

  /** Stops a stranger's DM from being streamed or synced again (spec §3: it has been dropped and counted once). */
  async function deny(e: Entry, conversationId: string, sender: string): Promise<void> {
    if (consent?.Denied === undefined || e.denied.has(conversationId)) return;
    if (isHeld(e, conversationId)) return;
    const conv = await lookUp(e, conversationId);
    if (!conv) {
      holdUnresolved(e, conversationId); // tried again on a later message, no sooner than the hold allows
      return;
    }
    // Only ever a DM whose peer is this stranger: never the opponent's.
    if (typeof conv.peerInboxId !== "string" || !same(conv.peerInboxId, sender)) return;
    if (e.peerInboxId !== null && same(conv.peerInboxId, e.peerInboxId)) return;
    if (setConsent(conv, consent.Denied)) remember(e.denied, conversationId, CACHE_MAX);
  }

  /** Denies every group still in `Unknown` consent: an arena channel never uses groups, so any group is a stranger's
   *  invite, and its messages are then not synced again. Local and synchronous; run at each stream (re)start. */
  function denyStrangerGroups(e: Entry): void {
    if (consent?.Denied === undefined || consent.Unknown === undefined || !e.client?.conversations.listGroups) return;
    let groups: SdkConversation[] = [];
    try {
      groups = e.client.conversations.listGroups({ consentStates: [consent.Unknown] });
    } catch {
      return;
    }
    let n = 0;
    for (const g of groups) if (setConsent(g, consent.Denied)) n++;
    if (n > 0) log(`xmtp: channel ${e.channelId}: denied ${n} group invite(s) from strangers`);
  }

  /** One inbound message, start to finish; called strictly one at a time per channel. */
  async function deliver(e: Entry, m: SdkMessage | undefined): Promise<void> {
    if (!m || e.closed || !e.client || !isText(m)) return;
    if (e.seen.has(m.id)) return; // already delivered by the catch-up (or the stream)
    if (same(m.senderInboxId, e.client.inboxId)) return; // our own send, echoed back by the stream
    const { peer: peerInbox, stranger } = await peerInboxIdOf(e, m.senderInboxId);
    if (peerInbox === null || !same(m.senderInboxId, peerInbox)) {
      // A stranger: it cannot be in our DM with the opponent (a DM has two members), so neither field is the peer.
      // Nothing here can open a gap, hold a message or restart the stream.
      if (stranger) await deny(e, m.conversationId, m.senderInboxId).catch(() => undefined);
      emit(e.channelId, NOT_THE_PEER, NOT_THE_PEER, m.content as string);
      return;
    }
    if (e.gap) {
      // An earlier opponent message is still unresolved: nothing of the opponent's may overtake it.
      hold(e, m);
      if (monotonic() >= e.gapRetryAt) await closeGap(e);
      return;
    }
    const { peer: dmPeer, conv, unresolved } = await convPeerOf(e, m.conversationId);
    if (e.closed) return;
    if (unresolved) {
      // Not resolvable by its conversation id: hold it, and resolve it at once the way the catch-up does.
      e.gap = true;
      e.gapBackoffMs = GAP_RETRY_MIN_MS;
      e.gapRetryAt = 0;
      log(`xmtp: channel ${e.channelId}: the opponent's message ${m.id} could not be placed; holding the opponent's messages until a catch-up resolves them`);
      hold(e, m);
      await closeGap(e);
      return;
    }
    const inTheDm = dmPeer !== null && same(dmPeer, peerInbox);
    if (inTheDm && conv) setConsent(conv, consent?.Allowed);
    if (inTheDm) remember(e.seen, m.id, SEEN_MAX); // delivered for good: a catch-up must not repeat it
    emit(e.channelId, e.peer, inTheDm ? e.peer : NOT_THE_PEER, m.content as string);
  }

  /** Keeps an opponent message for the gap's catch-up (bounded; never emitted or marked `seen` here). */
  function hold(e: Entry, m: SdkMessage): void {
    if (e.held.some((h) => h.id === m.id)) return;
    if (e.held.length >= HELD_MAX || (m.content as string).length > HELD_TEXT_MAX) {
      if (e.held.length === HELD_MAX) log(`xmtp: channel ${e.channelId}: ${HELD_MAX} opponent messages held; later ones are left to the catch-up`);
      return;
    }
    e.held.push(m);
  }

  /** Emits one of the opponent's messages known to be in its DM, once. */
  function emitOpponent(e: Entry, m: SdkMessage, peerInbox: string): void {
    if (!isText(m) || e.seen.has(m.id) || !same(m.senderInboxId, peerInbox)) return;
    remember(e.seen, m.id, SEEN_MAX);
    emit(e.channelId, e.peer, e.peer, m.content as string);
  }

  /** Tries the catch-up that closes an open gap; on failure, schedules the next try (back-off) and a stream restart
   *  for then, so the gap closes even if the opponent sends nothing more. */
  async function closeGap(e: Entry): Promise<void> {
    if (!e.gap || e.closed) return;
    if (await catchUp(e)) return;
    e.gapRetryAt = monotonic() + e.gapBackoffMs;
    scheduleRefresh(e, e.gapBackoffMs);
    log(`xmtp: channel ${e.channelId}: catch-up failed with ${e.held.length} message(s) held; retrying in ${e.gapBackoffMs / 1000}s`);
    e.gapBackoffMs = Math.min(GAP_RETRY_MAX_MS, e.gapBackoffMs * 2);
  }

  /** Restarts the channel's stream after `ms` (one pending at a time): the restart runs a catch-up first. */
  function scheduleRefresh(e: Entry, ms: number): void {
    if (e.refresh !== undefined || e.closed) return;
    e.refresh = setTimeout(() => {
      e.refresh = undefined;
      if (e.closed || !e.gap || !e.stream) return;
      e.refreshing = true;
      void e.stream.end().catch(() => undefined);
    }, ms);
    e.refresh.unref?.();
  }

  /**
   * Re-delivers the opponent DM's latest messages, oldest first. The DM is found by the opponent's address (`dmOf`,
   * which the SDK resolves across XMTP's duplicate-DM stitching), so no conversation lookup is involved, and every
   * message it lists is the DM's. While a gap is open it also reads back as far as the held messages reach, merges
   * them in (by send time), and on success closes the gap. Returns whether it ran to the end.
   */
  async function catchUp(e: Entry): Promise<boolean> {
    let dm: SdkDm;
    try {
      dm = await withTimeout(dmOf(e), NETWORK_TIMEOUT_MS, "DM lookup");
    } catch {
      return false; // the opponent has not registered yet (or the network is out): nothing to catch up on now
    }
    const limit = XMTP_CATCH_UP_MESSAGES + (e.gap ? e.held.length : 0);
    let recent: SdkMessage[];
    try {
      recent = await withTimeout(dm.messages({ limit, direction: sdk.SortDirection?.Descending }), NETWORK_TIMEOUT_MS, "catch-up");
    } catch {
      return false;
    }
    if (e.closed) return false;
    const peerInbox = dm.peerInboxId;
    const ordered = recent.slice(0, limit).reverse(); // oldest first
    const ids = new Set(ordered.map((m) => m.id));
    let lost = 0;
    if (e.gap) {
      // Held messages the listing did not reach: still the DM's if they arrived in it (or a stitched duplicate of it).
      for (const h of e.held) {
        if (ids.has(h.id)) continue;
        const cached = e.convPeer.get(h.conversationId);
        if (h.conversationId === dm.id || (typeof cached === "string" && same(cached, peerInbox))) {
          ordered.push(h);
          ids.add(h.id);
        } else lost++;
      }
    }
    // By send time when every message carries one (a stable sort keeps arrival order among equals).
    if (ordered.every((m) => typeof m.sentAtNs === "bigint")) {
      ordered.sort((a, b) => ((a.sentAtNs as bigint) < (b.sentAtNs as bigint) ? -1 : (a.sentAtNs as bigint) > (b.sentAtNs as bigint) ? 1 : 0));
    }
    const wasGap = e.gap;
    const heldCount = e.held.length;
    e.gap = false;
    e.held = [];
    clearTimeout(e.refresh);
    e.refresh = undefined;
    for (const m of ordered) emitOpponent(e, m, peerInbox);
    if (wasGap) {
      log(`xmtp: channel ${e.channelId}: catch-up resolved ${heldCount} held message(s)` + (lost > 0 ? `; ${lost} could not be found in the DM` : ""));
    }
    return true;
  }

  /** Waits `ms`, or less if the channel is closed meanwhile. Never keeps the process alive. */
  function sleep(e: Entry, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        e.wake = null;
        resolve();
      }, ms);
      timer.unref?.();
      e.wake = () => {
        clearTimeout(timer);
        e.wake = null;
        resolve();
      };
    });
  }

  /** The channel's inbound loop: (re)create the stream, catch up, drain it; on any end, back off and go again --
   *  until the channel is closed. `ready` resolves after the first attempt, whatever its outcome. */
  async function run(e: Entry, ready: () => void): Promise<void> {
    let backoff = STREAM_RESTART_MIN_MS;
    let first = true;
    while (!e.closed && e.client) {
      const startedAt = monotonic();
      let stream: SdkStream | null = null;
      try {
        stream = await e.client.conversations.streamAllMessages({
          conversationType: sdk.ConversationType?.Dm,
          consentStates: wantedConsent,
          retryOnFail: false,
          onError: (err) => log(`xmtp: channel ${e.channelId}: stream error: ${errorText(err)}`),
        });
      } catch (err) {
        log(`xmtp: channel ${e.channelId}: stream failed to start: ${errorText(err)}`);
      }
      if (stream && e.closed) await stream.end().catch(() => undefined);
      if (stream && !e.closed) {
        e.stream = stream;
        denyStrangerGroups(e);
        if (e.gap) await closeGap(e);
        else await catchUp(e);
        if (first) ready();
        first = false;
        for await (const m of stream) {
          if (e.closed) break;
          await deliver(e, m).catch((err: unknown) => log(`xmtp: channel ${e.channelId}: inbound message failed: ${errorText(err)}`));
        }
        e.stream = null;
      }
      if (first) ready();
      first = false;
      if (e.closed) return;
      if (monotonic() - startedAt >= STREAM_HEALTHY_MS || e.refreshing) backoff = STREAM_RESTART_MIN_MS;
      e.refreshing = false;
      log(`xmtp: channel ${e.channelId}: inbound stream ended; restarting in ${backoff / 1000}s`);
      await sleep(e, backoff);
      backoff = Math.min(STREAM_RESTART_MAX_MS, backoff * 2);
    }
  }

  async function start(e: Entry): Promise<void> {
    mkdirSync(opts.dbDir, { recursive: true, mode: 0o700 });
    const dbEncryptionKey = hexToBytes(await xmtpDbKey(e.me, e.channelId));
    const network: Record<string, unknown> = { env: opts.config.env };
    if (opts.config.apiUrl !== undefined) network.apiUrl = opts.config.apiUrl;
    if (opts.config.gatewayHost !== undefined) network.gatewayHost = opts.config.gatewayHost;
    const client = await sdk.Client.create(xmtpSignerOf(e.me, ethereum), {
      ...network,
      dbPath: join(opts.dbDir, `${e.channelId}.db3`),
      dbEncryptionKey,
      // One installation per channel, never synced to another device: no history-sync traffic.
      disableDeviceSync: true,
    });
    if (e.closed) return;
    e.client = client;
    await new Promise<void>((ready) => {
      run(e, ready).catch((err: unknown) => log(`xmtp: channel ${e.channelId}: inbound loop failed: ${errorText(err)}`));
    });
  }

  const transport: XmtpTransport = {
    open(channelId: Hex, me: RelaySigner, peer: Address): Promise<void> {
      const existing = entries.get(channelId);
      if (existing) return existing.opening;
      const e: Entry = {
        channelId,
        me,
        peer,
        client: null,
        stream: null,
        dm: null,
        peerInboxId: null,
        lastPeerLookup: 0,
        opening: Promise.resolve(),
        closed: false,
        wake: null,
        seen: new Set(),
        convPeer: new Map(),
        unresolvedUntil: new Map(),
        notPeer: new Set(),
        denied: new Set(),
        gap: false,
        held: [],
        gapRetryAt: 0,
        gapBackoffMs: GAP_RETRY_MIN_MS,
        refresh: undefined,
        refreshing: false,
      };
      e.opening = start(e).catch((err: unknown) => {
        // Forgotten, so the next `open` starts over (XmtpRelay retries it).
        if (entries.get(channelId) === e) entries.delete(channelId);
        e.closed = true;
        throw err;
      });
      entries.set(channelId, e);
      return e.opening;
    },
    async send(channelId: Hex, text: string): Promise<void> {
      const e = entries.get(channelId);
      if (!e) throw new Error(`xmtp: channel ${channelId} is not open`);
      await e.opening;
      if (e.closed || !e.client) throw new Error(`xmtp: channel ${channelId} is closed`);
      await (await dmOf(e)).sendText(text);
    },
    onText(handler: (channelId: Hex, from: Address, dm: Address, text: string) => void): () => void {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async close(channelId: Hex): Promise<void> {
      const e = entries.get(channelId);
      if (!e) return;
      entries.delete(channelId);
      e.closed = true;
      clearTimeout(e.refresh);
      e.wake?.();
      await e.stream?.end().catch(() => undefined);
      await e.opening.catch(() => undefined);
      await e.stream?.end().catch(() => undefined);
      e.client = null;
      e.stream = null;
      e.dm = null;
    },
    async stop(): Promise<void> {
      await Promise.all([...entries.keys()].map((id) => transport.close(id)));
      handlers.clear();
    },
  };
  return transport;
}
