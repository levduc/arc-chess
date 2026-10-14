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
type SdkMessage = { id: string; content: unknown; conversationId: string; senderInboxId: string };
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
  /** conversationId -> the DM's peer inbox id (null: not a DM), so a conversation is looked up once, not per message. */
  convPeer: Map<string, string | null>;
  /** Sender inbox ids found not to be the opponent's while its inbox was still unknown (bounded). */
  notPeer: Set<string>;
  /** Strangers' conversations already denied (bounded). */
  denied: Set<string>;
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

const errorText = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Adds `value` to a bounded insertion-ordered set, evicting the oldest. */
function remember<T>(set: Set<T>, value: T, max: number): void {
  set.add(value);
  if (set.size > max) set.delete(set.values().next().value as T);
}

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
 * up once per conversation and cached. A stranger's DM is set to consent `Denied` on its first message, and streams
 * and syncs ask only for `Allowed` and `Unknown` conversations, so a stranger is dropped and counted once and its DM
 * is no longer synced. What the SDK stores regardless: each stranger's welcome (the new conversation), the messages it
 * delivered before the deny, and its inbox's identity record -- all in the channel's own encrypted DB.
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

  /** The opponent's inbox id, if known yet. While it is not, a message's sender is checked against it locally first
   *  (an inbox lists the addresses bound to it, each by that address's own signature), then on the network,
   *  throttled. */
  async function peerInboxIdOf(e: Entry, sender: string): Promise<string | null> {
    if (e.peerInboxId !== null) return e.peerInboxId;
    if (e.dm) return (e.peerInboxId = e.dm.peerInboxId);
    if (!e.client || e.notPeer.has(sender)) return null;
    const states = (await e.client.preferences?.getInboxStates([sender]).catch(() => [])) ?? [];
    if (states[0]?.identifiers?.some((i) => i.identifierKind === ethereum && same(i.identifier, e.peer))) {
      return (e.peerInboxId = sender);
    }
    if (Date.now() - e.lastPeerLookup >= PEER_LOOKUP_INTERVAL_MS) {
      e.lastPeerLookup = Date.now();
      const id = await e.client.fetchInboxIdByIdentifier(identifierOf(e.peer)).catch(() => null);
      if (id) e.peerInboxId = id;
    }
    if (e.peerInboxId === null) remember(e.notPeer, sender, CACHE_MAX);
    return e.peerInboxId;
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
    return dm;
  }

  /** A conversation's DM peer inbox id (null when not a DM), looked up once per conversation. */
  async function convPeerOf(e: Entry, conversationId: string): Promise<{ peer: string | null; conv?: SdkConversation }> {
    if (e.convPeer.has(conversationId)) return { peer: e.convPeer.get(conversationId) ?? null };
    const conv = await e.client?.conversations.getConversationById(conversationId);
    const peer = conv && typeof conv.peerInboxId === "string" ? conv.peerInboxId : null;
    e.convPeer.set(conversationId, peer);
    if (e.convPeer.size > CACHE_MAX) e.convPeer.delete(e.convPeer.keys().next().value as string);
    return { peer, conv };
  }

  /** Stops a stranger's DM from being streamed or synced again (spec §3: it has been dropped and counted once). */
  async function deny(e: Entry, conversationId: string): Promise<void> {
    if (consent?.Denied === undefined || e.denied.has(conversationId)) return;
    remember(e.denied, conversationId, CACHE_MAX);
    const conv = await e.client?.conversations.getConversationById(conversationId);
    if (conv && e.peerInboxId !== null && typeof conv.peerInboxId === "string" && !same(conv.peerInboxId, e.peerInboxId)) {
      conv.updateConsentState?.(consent.Denied);
    }
  }

  /** One inbound message, start to finish; called strictly one at a time per channel. */
  async function deliver(e: Entry, m: SdkMessage | undefined): Promise<void> {
    if (!m || e.closed || !e.client || !isText(m)) return;
    if (e.seen.has(m.id)) return; // already delivered by the catch-up (or the stream)
    remember(e.seen, m.id, SEEN_MAX);
    if (same(m.senderInboxId, e.client.inboxId)) return; // our own send, echoed back by the stream
    const peerInbox = await peerInboxIdOf(e, m.senderInboxId);
    if (peerInbox === null || !same(m.senderInboxId, peerInbox)) {
      // A stranger: it cannot be in our DM with the opponent (a DM has two members), so neither field is the peer.
      if (peerInbox !== null) await deny(e, m.conversationId).catch(() => undefined);
      emit(e.channelId, NOT_THE_PEER, NOT_THE_PEER, m.content as string);
      return;
    }
    const { peer: dmPeer, conv } = await convPeerOf(e, m.conversationId);
    const inTheDm = dmPeer !== null && same(dmPeer, peerInbox);
    if (inTheDm && conv && consent?.Allowed !== undefined) conv.updateConsentState?.(consent.Allowed);
    emit(e.channelId, e.peer, inTheDm ? e.peer : NOT_THE_PEER, m.content as string);
  }

  /** Re-delivers the opponent DM's latest messages, oldest first, through `deliver`. */
  async function catchUp(e: Entry): Promise<void> {
    let dm: SdkDm;
    try {
      dm = await dmOf(e);
    } catch {
      return; // the opponent has not registered yet: nothing to catch up on
    }
    const recent = await dm.messages({ limit: XMTP_CATCH_UP_MESSAGES, direction: sdk.SortDirection?.Descending }).catch(() => []);
    for (const m of recent.slice(0, XMTP_CATCH_UP_MESSAGES).reverse()) {
      if (e.closed) return;
      await deliver(e, m).catch((err: unknown) => log(`xmtp: channel ${e.channelId}: catch-up message failed: ${errorText(err)}`));
    }
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
      const startedAt = Date.now();
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
        await catchUp(e);
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
      if (Date.now() - startedAt >= STREAM_HEALTHY_MS) backoff = STREAM_RESTART_MIN_MS;
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
        notPeer: new Set(),
        denied: new Set(),
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
