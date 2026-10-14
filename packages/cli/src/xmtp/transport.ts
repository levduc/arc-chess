import { mkdirSync, readdirSync, rmSync } from "node:fs";
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
  /** `from` is the XMTP sender's Ethereum address; `dm` is the peer address of the conversation it arrived in.
   *  Either is `NOT_THE_PEER` when it is known not to be the opponent, and `UNDETERMINED` when it could not be
   *  determined (spec §3: such a message still reaches the session, which checks every signature).
   *  A handler returns `false` when it did not take the text for now (the channel's rate limit): the transport then
   *  does not mark the message as delivered, so a later catch-up can deliver it again. */
  onText(handler: (channelId: Hex, from: Address, dm: Address, text: string) => boolean | void): () => void;
  /** Stops the channel's client (`Client.close()`, bounded). With `purge` -- the channel is finalized, its inbox is
   *  never used again -- its DB files are then deleted. */
  close(channelId: Hex, opts?: { purge?: boolean }): Promise<void>;
  /** K1: re-delivers the opponent DM's latest messages no sooner than `afterMs` from now, once: a message the
   *  channel's rate limit turned away is then delivered without waiting for a stream restart. Never restarts the
   *  stream; at most one is pending per channel. */
  catchUp?(channelId: Hex, afterMs: number): void;
  /** Stops every client. The DB files are kept: a restarted daemon resumes the same installations. */
  stop(): Promise<void>;
}

/**
 * What the node-SDK transport reports as `from` (or `dm`) for a sender (or conversation) known not to be the
 * channel's opponent. It never resolves a stranger's inbox to an address: once the opponent's inbox is known, a
 * flood from third parties costs one string compare each, and the zero address can never equal a channel's signer,
 * so `XmtpRelay` drops it as a wrong sender, before the channel's rate limit.
 */
export const NOT_THE_PEER: Address = "0x0000000000000000000000000000000000000000";

/**
 * What the node-SDK transport reports as `from` (or `dm`) when it could not tell whether the sender (or the
 * conversation) is the opponent's: a local read failed or came back empty, and the network has not answered yet.
 * Spec §3: such a message is delivered, in arrival order, like any other; the session verifies every state and
 * close signature, and `XmtpRelay` counts a rejection of it silently. Like `NOT_THE_PEER`, an address nobody holds
 * a key for.
 */
export const UNDETERMINED: Address = "0x0000000000000000000000000000000000000001";

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

// ------------------------------------------------------- the slice of @xmtp/node-sdk 6.1.0 this file uses
// Structural types only: the SDK is never imported statically (it is loaded at runtime by loader.ts).

type SdkIdentifier = { identifier: string; identifierKind: number };
type SdkMessage = { id: string; content: unknown; conversationId: string; senderInboxId: string; sentAtNs?: bigint };
type SdkConversation = {
  readonly id: string;
  readonly peerInboxId?: string;
  consentState?(): number;
  updateConsentState?(state: number): void;
};
type SdkDm = SdkConversation & {
  readonly peerInboxId: string;
  sendText(text: string): Promise<string>;
  messages(opts?: { limit?: number; direction?: number }): Promise<SdkMessage[]>;
  /** The opponent's other DMs with us, which XMTP stitches into this one (both sides created one at once). */
  duplicateDms?(): Promise<SdkConversation[]>;
};
/** The SDK's AsyncStreamProxy: async-iterable, ended by `end()`. */
type SdkStream = AsyncIterable<SdkMessage | undefined> & { end(): Promise<unknown> };
/** `identifiers` are the inbox's members: each was added with its own signature (libxmtp `AddAssociation`). The
 *  recovery identifier is not: any inbox can name any address as its recovery identifier without that address's
 *  signature (libxmtp `ChangeRecoveryIdentity`), so it is never read here (C-N1). */
type SdkInboxState = { identifiers?: SdkIdentifier[] };
type SdkClient = {
  readonly inboxId: string;
  /** 6.1.0: cancels the client's workers and streams, then releases its DB connection. Idempotent. */
  close?(): Promise<void>;
  fetchInboxIdByIdentifier(identifier: SdkIdentifier): Promise<string | null>;
  preferences?: { getInboxStates(inboxIds: string[]): Promise<SdkInboxState[]> };
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

/** Who sent a message, as far as this channel can tell (spec §3). */
type Sender = "opponent" | "stranger" | "undetermined";

type Entry = {
  channelId: Hex;
  me: RelaySigner;
  peer: Address;
  client: SdkClient | null;
  stream: SdkStream | null;
  dm: SdkDm | null;
  /** The opponent's inbox id. Only an answer keyed by the opponent's own address sets it -- its DM (`dmOf`) or the
   *  network's inbox lookup -- and each such answer replaces what was stored (`setPeerInbox`). */
  peerInboxId: string | null;
  /** When (monotonic ms) the opponent's inbox was last looked up on the network, and whether a lookup is running. */
  lastPeerLookup: number;
  peerLookupRunning: boolean;
  opening: Promise<void>;
  /** Settles once `Client.create` has returned or failed (`creating` is true until then). */
  created: Promise<void>;
  creating: boolean;
  closed: boolean;
  /** Set by `close(…, {purge: true})`: a client whose `Client.create` returns after that is closed and its DB deleted
   *  by `start` itself. */
  purge: boolean;
  /** Cancels the restart back-off sleep, if one is running. */
  wake: (() => void) | null;
  /** The channel's one inbound pipeline: stream deliveries and every catch-up run on it, one at a time (I3). */
  inbound: Promise<void>;
  /** K1: a message was turned away by the rate limit, and no catch-up has re-delivered it yet. Until one has, later
   *  messages are delivered but not marked delivered, so the catch-up re-delivers them after it, in order. */
  behind: boolean;
  /** K1: the pending rate-limit catch-up, whether one is running, whether another was asked for meanwhile, and the
   *  back-off between catch-ups that were turned away again. */
  catchUpTimer: ReturnType<typeof setTimeout> | undefined;
  catchingUp: boolean;
  catchUpAgain: boolean;
  catchUpBackoffMs: number;
  /** XMTP message ids already delivered, oldest first (bounded): the catch-up and the stream can overlap. */
  seen: Set<string>;
  /** conversationId -> the DM's peer inbox id (null: not a DM). Only definitive answers are cached: the opponent's
   *  DM and its stitched duplicates (from `open`), and conversations looked up once (bounded). A message in a
   *  conversation cached as the opponent's DM is the opponent's, with no lookup at all (the fast path). */
  convPeer: Map<string, string | null>;
  /** conversationId -> when (monotonic ms) a lookup that came back empty may be tried again (bounded). This only
   *  spares the native DB a lookup per message: it never holds a message, which is delivered as undetermined. */
  lookupAgainAt: Map<string, number>;
  /** Sender inbox ids found not to be the opponent's while its inbox was still unknown (bounded). */
  notPeer: Set<string>;
  /** Strangers' conversations already denied -> their peer's inbox id (bounded), so that one later found to be the
   *  opponent's is allowed again. */
  denied: Map<string, string>;
};

/** A failed or ended stream is re-created after this back-off, doubling up to the cap, for as long as the channel is
 *  open (the transport owns the restart loop: the SDK's own gives up after 10 attempts and can outlive `end()`). */
const STREAM_RESTART_MIN_MS = 1_000;
const STREAM_RESTART_MAX_MS = 30_000;
/** A stream that stayed up this long resets the back-off. */
const STREAM_HEALTHY_MS = 60_000;
/** The opponent's inbox id is looked up on the network at most this often until it is known (it is null until the
 *  opponent's own client has registered). The lookup runs beside the inbound queue, never in it. */
const PEER_LOOKUP_INTERVAL_MS = 1_000;
/** A conversation whose lookup came back empty is not looked up again for this long. */
const LOOKUP_RETRY_MS = 5_000;
/** Bounds on the per-channel caches above. */
const SEEN_MAX = 512;
const CACHE_MAX = 256;
/** The network calls of the catch-up (the DM, its history) give up after this long. */
const NETWORK_TIMEOUT_MS = 5_000;
/** Closing a channel waits at most this long for its stream to end, then this long for a `Client.create` still
 *  running (one that returns later is closed by `start` itself), then this long for `Client.close()`: 4.5 s in all,
 *  inside `run.ts`'s 5 s stop budget. */
const STREAM_END_WAIT_MS = 500;
const CREATE_WAIT_MS = 1_000;
const CLIENT_CLOSE_TIMEOUT_MS = 3_000;
/** K1: a rate-limit catch-up runs no sooner than this, and one turned away again backs off, doubling up to the cap. */
const RATE_CATCH_UP_MIN_MS = 1_000;
const RATE_CATCH_UP_MAX_MS = 30_000;

const errorText = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Adds `value` to a bounded insertion-ordered set, evicting the oldest. */
function remember<T>(set: Set<T>, value: T, max: number): void {
  set.add(value);
  if (set.size > max) set.delete(set.values().next().value as T);
}

/** Sets `key` in a bounded insertion-ordered map (re-inserted last), evicting the oldest. */
function cache<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value as string);
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
 * The `XmtpTransport` over `@xmtp/node-sdk` 6.1.0 (`sdk` is the module `loadXmtpSdk` returned). Each channel's DB is
 * `<dbDir>/<channelId>.db3`, encrypted with `xmtpDbKey`, so a restarted daemon resumes the same installation
 * (XMTP caps an inbox at 10). Each client keeps one DB connection (`useSingleConnection`, 6.1.0: "intended for
 * services running many clients in one process"): about 4 file descriptors and no pool threads per client, against
 * about 12 and 3 with the default pool (measured on 6.1.0).
 *
 * Inbound, per channel, one serial pipeline: each (re)start of the DM stream first re-delivers the opponent DM's
 * latest `XMTP_CATCH_UP_MESSAGES`, then drains the stream with `for await`, one message at a time. So messages reach
 * `onText` in arrival order, and the SDK's stream buffer never grows: the SDK queues every streamed message until it
 * is read, which is why `onValue` is never used. The transport owns the restart loop (`retryOnFail: false`): a
 * stream that fails or ends is re-created with back-off for as long as the channel is open, and never after `close`.
 *
 * K1: a message the channel's rate limit turned away is not marked delivered, and `XmtpRelay` asks for a catch-up
 * once its bucket has refilled (`catchUp`). That catch-up runs on the same pipeline, without restarting the stream,
 * re-reads the opponent DM's latest messages and delivers the ones not yet delivered, in order: messages after the
 * turned-away one are delivered when they arrive but marked delivered only by the catch-up, so none of them can stay
 * ahead of it. A catch-up turned away again backs off (1 s doubling to 30 s), so a flood costs at most one local
 * read of `XMTP_CATCH_UP_MESSAGES` per back-off, and never a stream restart.
 *
 * Acceptance (spec §3), per message, with no network call and no wait on the inbound path:
 * - **Fast path.** `open` creates (or finds) the DM to the opponent and caches its conversation id and those of its
 *   stitched duplicates. A message in one of them is the opponent's: a DM has two members, and our own echoes are
 *   skipped. No lookup.
 * - **Otherwise the sender is looked up**, locally: against the opponent's inbox id once known, else in the sender's
 *   own inbox state, by its member identifiers only (each added with its own signature; never the recovery
 *   identifier, which any inbox can set to any address). The opponent's message is then checked to be in a DM with
 *   the opponent, by one conversation lookup, cached.
 * - **The opponent's inbox id** is set only by answers keyed by the opponent's own address -- its DM, found by
 *   address (`dmOf`), and the network's inbox lookup -- and each replaces what was stored. A sender's own inbox state
 *   classifies that one message; it never sets the opponent's inbox. A conversation of the opponent's that was
 *   denied earlier is allowed again once such an answer names it, and the stream restarted to carry it.
 * - **A known stranger** -- the lookup succeeded and the sender is not the opponent, or the conversation is not a DM
 *   with the opponent -- is passed on as `NOT_THE_PEER`, for `XmtpRelay` to drop and count before its rate limit,
 *   and its DM is set to consent `Denied`.
 * - **Anything else is undetermined** -- a local read failed or came back empty, or the opponent's inbox is not
 *   known yet (it is then looked up on the network in the background, for later messages) -- and is passed on as
 *   `UNDETERMINED`, at once and in order, never held: the session, which checks every signature, decides.
 *
 * Strangers: every stream (re)start also denies any group still in `Unknown` consent (an arena channel never uses
 * groups). Streams and syncs ask only for `Allowed` and `Unknown` conversations, so a known stranger is dropped and
 * counted once and its conversation is not synced again. What the SDK stores regardless: each stranger's welcome
 * (the new conversation), the messages it delivered before the deny (for a group: what the next restart's sync
 * fetched), and its inbox's identity record -- all in the channel's own encrypted DB.
 *
 * Closing (I-1): `close`/`stop` end the channel's stream, stop its restart loop and catch-ups, then `Client.close()`
 * (6.1.0) the client, bounded by `CLIENT_CLOSE_TIMEOUT_MS`: that releases its DB connection and cancels its workers
 * (the native threads idle out shortly after). A client whose `Client.create` returns after the close is closed as it
 * returns. `close(…, {purge: true})` -- the channel is finalized -- then deletes the channel's DB files
 * (`<channelId>.db3`, `-wal`, `-shm`); `stop` keeps them, so a restarted daemon resumes the same installation.
 */
export function createNodeSdkTransport(opts: { sdk: unknown; dbDir: string; config: XmtpConfig; log(l: string): void }): XmtpTransport {
  const sdk = opts.sdk as NodeSdk;
  const log = opts.log;
  const ethereum = sdk.IdentifierKind.Ethereum;
  const entries = new Map<Hex, Entry>();
  const handlers = new Set<(channelId: Hex, from: Address, dm: Address, text: string) => boolean | void>();
  const identifierOf = (address: Address): SdkIdentifier => ({ identifier: address.toLowerCase(), identifierKind: ethereum });
  const isText = (m: SdkMessage) => (typeof sdk.isText === "function" ? sdk.isText(m) : true) && typeof m.content === "string";
  const consent = sdk.ConsentState;
  const wantedConsent =
    consent?.Allowed !== undefined && consent.Unknown !== undefined ? [consent.Allowed, consent.Unknown] : undefined;

  /** Hands a text to every handler; false when one did not take it for now (the channel's rate limit). */
  function emit(channelId: Hex, from: Address, dm: Address, text: string): boolean {
    let taken = true;
    for (const h of handlers) {
      try {
        if (h(channelId, from, dm, text) === false) taken = false;
      } catch (err) {
        log(`xmtp: onText handler threw: ${errorText(err)}`);
      }
    }
    return taken;
  }

  /** The opponent's inbox id, once an answer keyed by its address has come in (its DM, or the network's lookup). */
  function peerInboxOf(e: Entry): string | null {
    return e.peerInboxId;
  }

  /** The only writer of `e.peerInboxId` (C-N1): an answer keyed by the opponent's own address, which replaces whatever
   *  was stored. A conversation with that inbox that was denied earlier is allowed again. */
  function setPeerInbox(e: Entry, inbox: string): void {
    e.peerInboxId = inbox;
    for (const s of e.notPeer) if (same(s, inbox)) e.notPeer.delete(s);
    for (const [conversationId, peer] of [...e.denied]) {
      if (!same(peer, inbox)) continue;
      void lookUp(e, conversationId).then((conv) => {
        if (conv && !e.closed) allowAgain(e, conv);
      });
    }
  }

  function isDenied(conv: SdkConversation): boolean {
    if (consent?.Denied === undefined || typeof conv.consentState !== "function") return false;
    try {
      return conv.consentState() === consent.Denied;
    } catch {
      return false;
    }
  }

  /** Allows one of the opponent's conversations again if it was denied (by an earlier wrong classification, or in the
   *  DB from an earlier run), and ends the stream, so that the restarted stream carries it and its catch-up re-reads
   *  it: a stream asks only for the conversations allowed when it starts. */
  function allowAgain(e: Entry, conv: SdkConversation): void {
    if (!e.denied.has(conv.id) && !isDenied(conv)) return;
    if (!setConsent(conv, consent?.Allowed)) return;
    e.denied.delete(conv.id);
    log(`xmtp: channel ${e.channelId}: the opponent's conversation ${conv.id} was denied; allowed again`);
    void e.stream?.end().catch(() => undefined);
  }

  /** Whether a conversation is cached as our DM with the opponent: the fast path. */
  function isOpponentDm(e: Entry, conversationId: string): boolean {
    const peerInbox = peerInboxOf(e);
    const dmPeer = e.convPeer.get(conversationId);
    return peerInbox !== null && typeof dmPeer === "string" && same(dmPeer, peerInbox);
  }

  /** Looks the opponent's inbox id up on the network, in the background (throttled, one at a time, with a timeout),
   *  so that later messages can be told apart. The message at hand never waits for it. */
  function lookUpPeerInbox(e: Entry): void {
    const client = e.client;
    if (!client || e.peerLookupRunning || monotonic() - e.lastPeerLookup < PEER_LOOKUP_INTERVAL_MS) return;
    e.peerLookupRunning = true;
    e.lastPeerLookup = monotonic();
    const lookup = Promise.resolve().then(() => client.fetchInboxIdByIdentifier(identifierOf(e.peer)));
    withTimeout(lookup, NETWORK_TIMEOUT_MS, "inbox lookup")
      .then(
        (id) => {
          if (id && !e.closed) setPeerInbox(e, id); // keyed by the opponent's address: it has the last word
        },
        () => undefined,
      )
      .finally(() => {
        e.peerLookupRunning = false;
      });
  }

  /** Who sent a message. Known only on a definitive answer: the opponent's inbox id compared, or the sender's own
   *  inbox state (read locally) listing member identifiers -- the opponent's address among them or not. A failed or
   *  empty read leaves the sender undetermined. Never the recovery identifier (C-N1), and a sender found to be the
   *  opponent this way is not stored as the opponent's inbox: only an answer keyed by its address is. */
  async function senderOf(e: Entry, sender: string): Promise<Sender> {
    const peerInbox = peerInboxOf(e);
    if (peerInbox !== null) return same(sender, peerInbox) ? "opponent" : "stranger";
    if (e.notPeer.has(sender)) return "stranger";
    lookUpPeerInbox(e); // the opponent's inbox, from the network, for later messages (throttled; never waited for)
    let state: SdkInboxState | undefined;
    try {
      state = (await e.client?.preferences?.getInboxStates([sender]))?.[0];
    } catch {
      state = undefined; // a native error: undetermined, below
    }
    const members = Array.isArray(state?.identifiers) ? state.identifiers : [];
    // The opponent's creating address, its session key, is a member of its inbox; a member was added by its own
    // signature, so no other inbox can list it.
    if (members.some((i) => i.identifierKind === ethereum && same(i.identifier, e.peer))) return "opponent";
    if (members.length > 0) {
      remember(e.notPeer, sender, CACHE_MAX); // other members only: definitely not the opponent
      return "stranger";
    }
    return "undetermined";
  }

  /** A conversation, or undefined (the SDK's answer to any native error), never looked up again within
   *  `LOOKUP_RETRY_MS` of an empty answer. */
  async function lookUp(e: Entry, conversationId: string): Promise<SdkConversation | undefined> {
    const again = e.lookupAgainAt.get(conversationId);
    if (again !== undefined && monotonic() < again) return undefined;
    let conv: SdkConversation | undefined;
    try {
      conv = await e.client?.conversations.getConversationById(conversationId);
    } catch {
      conv = undefined;
    }
    if (conv) e.lookupAgainAt.delete(conversationId);
    else cache(e.lookupAgainAt, conversationId, monotonic() + LOOKUP_RETRY_MS, CACHE_MAX);
    return conv;
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

  /** Whether the opponent's message (from `senderInbox`, found to be the opponent's) arrived in a DM with that inbox,
   *  by one lookup per conversation (cached); undetermined while the lookup comes back empty. */
  async function inOpponentDm(e: Entry, conversationId: string, senderInbox: string): Promise<boolean | "undetermined"> {
    if (!e.convPeer.has(conversationId)) {
      const conv = await lookUp(e, conversationId);
      if (!conv) return "undetermined";
      const peer = typeof conv.peerInboxId === "string" ? conv.peerInboxId : null;
      cache(e.convPeer, conversationId, peer, CACHE_MAX);
      if (peer !== null && same(peer, senderInbox)) setConsent(conv, consent?.Allowed);
    }
    const peer = e.convPeer.get(conversationId);
    return typeof peer === "string" && same(peer, senderInbox);
  }

  /** Whether a conversation is the opponent's by the answers keyed by its address: our DM found by its address, or a
   *  conversation whose peer is its inbox. `deny` never touches one. */
  function isTheOpponents(e: Entry, conversationId: string, peer: string): boolean {
    if (e.dm && conversationId === e.dm.id) return true;
    const peerInbox = peerInboxOf(e);
    if (peerInbox === null) return false;
    const cached = e.convPeer.get(conversationId);
    return same(peer, peerInbox) || (typeof cached === "string" && same(cached, peerInbox));
  }

  /** Stops a known stranger's DM from being streamed or synced again (spec §3: it has been dropped and counted). */
  async function deny(e: Entry, conversationId: string, sender: string): Promise<void> {
    if (consent?.Denied === undefined || e.denied.has(conversationId)) return;
    const conv = await lookUp(e, conversationId);
    if (!conv || e.closed) return; // tried again on a later message, no sooner than LOOKUP_RETRY_MS
    // Only ever a DM whose peer is this stranger, and never the opponent's (checked after the lookup: an answer keyed
    // by the opponent's address may have come in meanwhile).
    if (typeof conv.peerInboxId !== "string" || !same(conv.peerInboxId, sender)) return;
    if (isTheOpponents(e, conversationId, conv.peerInboxId)) return;
    if (setConsent(conv, consent.Denied)) cache(e.denied, conversationId, conv.peerInboxId, CACHE_MAX);
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

  /** Hands one message on, once (spec §3: dedupe by XMTP message id). It is marked delivered only once taken: one the
   *  channel's rate limit turned away stays unmarked, so a catch-up delivers it again (m-N10, K1) -- and so do the
   *  ones after it until then (`behind`), so that the catch-up delivers them in order after it. */
  function pass(e: Entry, m: SdkMessage, from: Address, dm: Address): void {
    if (!emit(e.channelId, from, dm, m.content as string)) e.behind = true;
    else if (!e.behind) remember(e.seen, m.id, SEEN_MAX);
  }

  /** Runs `fn` after everything already on the channel's inbound pipeline: stream deliveries and catch-ups take turns
   *  on it, so they never interleave (I3). */
  function serially(e: Entry, fn: () => Promise<void>): Promise<void> {
    const turn = e.inbound.then(fn);
    e.inbound = turn.catch(() => undefined);
    return turn;
  }

  /** One inbound message, start to finish; called strictly one at a time per channel. It never waits on the network
   *  and never holds a message back. */
  async function deliver(e: Entry, m: SdkMessage | undefined): Promise<void> {
    if (!m || e.closed || !e.client || !isText(m)) return;
    if (e.seen.has(m.id)) return; // already delivered by the catch-up (or the stream)
    if (same(m.senderInboxId, e.client.inboxId)) return; // our own send, echoed back by the stream
    if (isOpponentDm(e, m.conversationId)) return pass(e, m, e.peer, e.peer); // the fast path
    const sender = await senderOf(e, m.senderInboxId);
    if (e.closed) return;
    if (sender === "stranger") {
      // It cannot be in our DM with the opponent (a DM has two members), so neither field is the peer.
      await deny(e, m.conversationId, m.senderInboxId).catch(() => undefined);
      emit(e.channelId, NOT_THE_PEER, NOT_THE_PEER, m.content as string);
      return;
    }
    if (sender === "undetermined") return pass(e, m, UNDETERMINED, UNDETERMINED);
    const inDm = await inOpponentDm(e, m.conversationId, m.senderInboxId);
    if (e.closed) return;
    if (inDm === false) {
      emit(e.channelId, e.peer, NOT_THE_PEER, m.content as string); // the opponent, but not in its DM with us
      return;
    }
    pass(e, m, e.peer, inDm === true ? e.peer : UNDETERMINED);
  }

  /** The DM to the opponent, created (or found: the SDK returns an existing DM) on first use, by the opponent's
   *  address: its peer is the opponent's inbox, whatever was stored before, and it is allowed again if it was denied.
   *  It fails until the opponent's client has registered, so it is retried on every `send` and stream (re)start. */
  async function dmOf(e: Entry): Promise<SdkDm> {
    if (e.dm) return e.dm;
    if (!e.client) throw new Error("xmtp: client not started");
    const dm = await e.client.conversations.createDmWithIdentifier(identifierOf(e.peer));
    if (e.closed) return dm;
    e.dm = dm;
    cache(e.convPeer, dm.id, dm.peerInboxId, CACHE_MAX);
    e.lookupAgainAt.delete(dm.id);
    setPeerInbox(e, dm.peerInboxId);
    allowAgain(e, dm);
    return dm;
  }

  /** `dmOf` within `NETWORK_TIMEOUT_MS`; null until the opponent has registered (or while the network is out). */
  async function findDm(e: Entry): Promise<SdkDm | null> {
    try {
      return await withTimeout(dmOf(e), NETWORK_TIMEOUT_MS, "DM lookup");
    } catch {
      return null;
    }
  }

  /** Caches the conversation ids of the opponent DM's stitched duplicates (both sides created a DM at once), so
   *  messages in them take the fast path too. Best-effort: a duplicate it misses costs one lookup, once. */
  async function rememberDuplicates(e: Entry, dm: SdkDm): Promise<void> {
    if (typeof dm.duplicateDms !== "function") return;
    let dups: SdkConversation[];
    try {
      dups = await withTimeout(dm.duplicateDms(), NETWORK_TIMEOUT_MS, "duplicate DMs");
    } catch {
      return;
    }
    for (const d of dups) {
      if (typeof d.peerInboxId !== "string" || !same(d.peerInboxId, dm.peerInboxId)) continue;
      cache(e.convPeer, d.id, d.peerInboxId, CACHE_MAX);
      allowAgain(e, d);
    }
  }

  /** Re-delivers the opponent DM's latest messages, oldest first, through `deliver`; run on the inbound pipeline. The
   *  DM was found by the opponent's address (`dmOf`), so its own messages take the fast path. Anything the rate limit
   *  turned away before is re-read here (K1): `behind` starts over, and is set again only if this catch-up's own
   *  delivery is turned away. No DM yet (the opponent has not registered, or the network is out): nothing to catch
   *  up on now. */
  async function catchUp(e: Entry, dm: SdkDm | null): Promise<void> {
    if (!dm || e.closed) return;
    let recent: SdkMessage[];
    try {
      recent = await withTimeout(
        dm.messages({ limit: XMTP_CATCH_UP_MESSAGES, direction: sdk.SortDirection?.Descending }),
        NETWORK_TIMEOUT_MS,
        "catch-up",
      );
    } catch {
      return;
    }
    e.behind = false;
    for (const m of recent.slice(0, XMTP_CATCH_UP_MESSAGES).reverse()) {
      if (e.closed) return;
      await deliver(e, m);
    }
  }

  /** K1: asks for a catch-up `afterMs` from now (at least `RATE_CATCH_UP_MIN_MS`, or the current back-off). One at a
   *  time per channel: asked again while one is pending, it changes nothing; while one runs, another follows it. */
  function scheduleCatchUp(e: Entry, afterMs: number): void {
    if (e.closed || e.catchUpTimer !== undefined) return;
    if (e.catchingUp) {
      e.catchUpAgain = true;
      return;
    }
    const delay = Math.max(afterMs, RATE_CATCH_UP_MIN_MS, e.catchUpBackoffMs);
    e.catchUpTimer = setTimeout(() => {
      e.catchUpTimer = undefined;
      void rateCatchUp(e);
    }, delay);
    e.catchUpTimer.unref?.();
  }

  /** K1: one catch-up for messages the rate limit turned away, on the inbound pipeline (never a stream restart). The
   *  DM is found first, off the pipeline. Turned away again (or the DM not found): it backs off and tries again. */
  async function rateCatchUp(e: Entry): Promise<void> {
    if (e.closed) return;
    e.catchingUp = true;
    e.catchUpAgain = false;
    let done = false;
    try {
      const dm = await findDm(e);
      if (dm && !e.closed) {
        await serially(e, () => catchUp(e, dm));
        done = !e.behind;
      }
    } finally {
      e.catchingUp = false;
    }
    if (e.closed) return;
    if (done && !e.catchUpAgain) {
      e.catchUpBackoffMs = 0;
      return;
    }
    e.catchUpBackoffMs = Math.min(RATE_CATCH_UP_MAX_MS, Math.max(2 * RATE_CATCH_UP_MIN_MS, 2 * e.catchUpBackoffMs));
    scheduleCatchUp(e, 0);
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
      // The DM first: a stream carries only the conversations allowed when it starts, and `dmOf` allows the
      // opponent's again if it was denied.
      const dm = await findDm(e);
      let stream: SdkStream | null = null;
      const client = e.client; // null once closed meanwhile: no stream then, and `ready` below still runs
      if (client && !e.closed) {
        try {
          stream = await client.conversations.streamAllMessages({
            conversationType: sdk.ConversationType?.Dm,
            consentStates: wantedConsent,
            retryOnFail: false,
            onError: (err) => log(`xmtp: channel ${e.channelId}: stream error: ${errorText(err)}`),
          });
        } catch (err) {
          log(`xmtp: channel ${e.channelId}: stream failed to start: ${errorText(err)}`);
        }
      }
      if (stream && e.closed) await stream.end().catch(() => undefined);
      if (stream && !e.closed) {
        e.stream = stream;
        denyStrangerGroups(e);
        if (dm) await rememberDuplicates(e, dm);
        await serially(e, () => catchUp(e, dm)).catch(() => undefined);
        if (first) ready();
        first = false;
        for await (const m of stream) {
          if (e.closed) break;
          await serially(e, () => deliver(e, m)).catch((err: unknown) =>
            log(`xmtp: channel ${e.channelId}: inbound message failed: ${errorText(err)}`),
          );
        }
        e.stream = null;
      }
      if (first) ready();
      first = false;
      if (e.closed) return;
      if (monotonic() - startedAt >= STREAM_HEALTHY_MS) backoff = STREAM_RESTART_MIN_MS;
      log(`xmtp: channel ${e.channelId}: inbound stream ended; restarting in ${backoff / 1000}s`);
      await sleep(e, backoff);
      backoff = Math.min(STREAM_RESTART_MAX_MS, backoff * 2);
    }
  }

  /** `Client.close()`, bounded; true once it has resolved. A client without `close` (an SDK before 6.1.0, which the
   *  loader refuses anyway) is only dropped. Never throws. */
  async function closeClient(channelId: Hex, client: SdkClient): Promise<boolean> {
    if (typeof client.close !== "function") return false;
    try {
      await withTimeout(Promise.resolve().then(() => client.close?.()), CLIENT_CLOSE_TIMEOUT_MS, "client close");
      return true;
    } catch (err) {
      log(`xmtp: channel ${channelId}: client close failed: ${errorText(err)}`);
      return false;
    }
  }

  /** Deletes a finalized channel's DB files: `<channelId>.db3` and its `-wal`/`-shm` (or any other sidecar named after
   *  it). Only ever called once no client of this channel is open in this process. Never throws. */
  function purgeDb(channelId: Hex): void {
    if (!/^0x[0-9a-f]{64}$/.test(channelId)) return; // a path component: canonical ids only
    let names: string[];
    try {
      names = readdirSync(opts.dbDir);
    } catch {
      return; // no DB dir: nothing to delete
    }
    for (const name of names) {
      if (!name.startsWith(`${channelId}.db3`)) continue;
      try {
        rmSync(join(opts.dbDir, name), { force: true });
      } catch (err) {
        log(`xmtp: channel ${channelId}: could not delete ${name}: ${errorText(err)}`);
      }
    }
  }

  /** Ends one channel's client: its stream, restart loop and catch-ups, then `Client.close()`; with `purge`, its DB
   *  files are deleted once the client is closed. Bounded: `STREAM_END_WAIT_MS` + `CREATE_WAIT_MS` +
   *  `CLIENT_CLOSE_TIMEOUT_MS`. */
  async function shutdown(e: Entry, purge: boolean): Promise<void> {
    e.closed = true;
    if (purge) e.purge = true;
    e.wake?.();
    clearTimeout(e.catchUpTimer);
    e.catchUpTimer = undefined;
    if (e.stream) await withTimeout(e.stream.end(), STREAM_END_WAIT_MS, "stream end").catch(() => undefined);
    // A Client.create still running: give it a moment. If it returns later, `start` closes (and purges) it itself.
    await withTimeout(e.created, CREATE_WAIT_MS, "client start").catch(() => undefined);
    const client = e.client;
    e.client = null;
    e.stream = null;
    e.dm = null;
    if (e.creating) return;
    const closed = client === null ? true : await closeClient(e.channelId, client);
    if (purge && closed) purgeDb(e.channelId);
    else if (purge) log(`xmtp: channel ${e.channelId}: its client did not close; its DB files are kept`);
  }

  async function start(e: Entry): Promise<void> {
    mkdirSync(opts.dbDir, { recursive: true, mode: 0o700 });
    const dbEncryptionKey = hexToBytes(await xmtpDbKey(e.me, e.channelId));
    const network: Record<string, unknown> = { env: opts.config.env };
    if (opts.config.apiUrl !== undefined) network.apiUrl = opts.config.apiUrl;
    if (opts.config.gatewayHost !== undefined) network.gatewayHost = opts.config.gatewayHost;
    if (e.closed) return; // closed before its client was created: none is
    let created: () => void = () => undefined;
    e.created = new Promise<void>((r) => (created = r));
    e.creating = true;
    let client: SdkClient;
    try {
      client = await sdk.Client.create(xmtpSignerOf(e.me, ethereum), {
        ...network,
        dbPath: join(opts.dbDir, `${e.channelId}.db3`),
        dbEncryptionKey,
        // One installation per channel, never synced to another device: no history-sync traffic.
        disableDeviceSync: true,
        // One DB connection per client, not a pool (6.1.0): a daemon may hold many clients (I-1).
        useSingleConnection: true,
      });
    } finally {
      e.creating = false;
      created();
    }
    if (e.closed) {
      // Closed while starting: this client was never handed out, so it is closed here (I-1).
      if ((await closeClient(e.channelId, client)) && e.purge) purgeDb(e.channelId);
      return;
    }
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
        lastPeerLookup: Number.NEGATIVE_INFINITY,
        peerLookupRunning: false,
        opening: Promise.resolve(),
        created: Promise.resolve(),
        creating: false,
        closed: false,
        purge: false,
        wake: null,
        inbound: Promise.resolve(),
        behind: false,
        catchUpTimer: undefined,
        catchingUp: false,
        catchUpAgain: false,
        catchUpBackoffMs: 0,
        seen: new Set(),
        convPeer: new Map(),
        lookupAgainAt: new Map(),
        notPeer: new Set(),
        denied: new Map(),
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
    onText(handler: (channelId: Hex, from: Address, dm: Address, text: string) => boolean | void): () => void {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    catchUp(channelId: Hex, afterMs: number): void {
      const e = entries.get(channelId);
      if (e && e.client) scheduleCatchUp(e, afterMs);
    },
    async close(channelId: Hex, closeOpts: { purge?: boolean } = {}): Promise<void> {
      const e = entries.get(channelId);
      if (!e) {
        // No client in this process (never opened here, or its start failed): a finalized channel's DB from an
        // earlier run is still deleted.
        if (closeOpts.purge === true) purgeDb(channelId);
        return;
      }
      entries.delete(channelId);
      await shutdown(e, closeOpts.purge === true);
    },
    async stop(): Promise<void> {
      const all = [...entries.values()];
      entries.clear();
      await Promise.all(all.map((e) => shutdown(e, false)));
      handlers.clear();
    },
  };
  return transport;
}
