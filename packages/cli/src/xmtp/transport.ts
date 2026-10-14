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
 * opponent. It never resolves a stranger's inbox to an address: a flood from third parties costs one string
 * compare each, and the zero address can never equal a channel's signer, so `XmtpRelay` drops it as a wrong sender.
 */
export const NOT_THE_PEER: Address = "0x0000000000000000000000000000000000000000";

/** How many of the DM's latest messages `open` re-delivers once its stream is up: the stream only carries messages
 *  that arrive after it starts, so a message that landed while the daemon was down (a restart mid-fallback) would
 *  otherwise never reach the session. Re-delivery is harmless: the session treats a repeat as a no-op. */
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
type SdkDm = {
  readonly peerInboxId: string;
  sendText(text: string): Promise<string>;
  messages(opts?: { limit?: number; direction?: number }): Promise<SdkMessage[]>;
};
type SdkStream = { end(): Promise<unknown> };
type SdkClient = {
  readonly inboxId: string;
  fetchInboxIdByIdentifier(identifier: SdkIdentifier): Promise<string | null>;
  conversations: {
    createDmWithIdentifier(identifier: SdkIdentifier): Promise<SdkDm>;
    getConversationById(id: string): Promise<unknown>;
    streamAllMessages(opts: {
      conversationType?: number;
      onValue?: (m: SdkMessage | undefined) => void;
      onError?: (err: Error) => void;
      retryDelay?: number;
    }): Promise<SdkStream>;
  };
};
type NodeSdk = {
  Client: { create(signer: unknown, opts: Record<string, unknown>): Promise<SdkClient> };
  IdentifierKind: { Ethereum: number };
  ConversationType?: { Dm?: number };
  SortDirection?: { Descending?: number };
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
};

/** A stream that fails is retried by the SDK after this long (its default is 60 s, far too slow for a fallback). */
const STREAM_RETRY_DELAY_MS = 5_000;
/** The opponent's inbox id is looked up on the network at most this often until it is known (it is null until the
 *  opponent's own client has registered). */
const PEER_LOOKUP_INTERVAL_MS = 1_000;

const errorText = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The `XmtpTransport` over `@xmtp/node-sdk` 6.0.0 (`sdk` is the module `loadXmtpSdk` returned). Each channel's DB is
 * `<dbDir>/<channelId>.db3`, encrypted with `xmtpDbKey`, so a restarted daemon resumes the same installation
 * (XMTP caps an inbox at 10). Sender and conversation are resolved by inbox id against the opponent's inbox only
 * (see `NOT_THE_PEER`).
 *
 * The SDK has no public way to close a client: `close`/`stop` end the channel's stream and drop every reference,
 * and the native client releases its DB when it is garbage-collected. The DB file is never deleted.
 */
export function createNodeSdkTransport(opts: { sdk: unknown; dbDir: string; config: XmtpConfig; log(l: string): void }): XmtpTransport {
  const sdk = opts.sdk as NodeSdk;
  const log = opts.log;
  const ethereum = sdk.IdentifierKind.Ethereum;
  const entries = new Map<Hex, Entry>();
  const handlers = new Set<(channelId: Hex, from: Address, dm: Address, text: string) => void>();
  const identifierOf = (address: Address): SdkIdentifier => ({ identifier: address.toLowerCase(), identifierKind: ethereum });
  const isText = (m: SdkMessage) => (typeof sdk.isText === "function" ? sdk.isText(m) : true) && typeof m.content === "string";

  function emit(channelId: Hex, from: Address, dm: Address, text: string): void {
    for (const h of handlers) {
      try {
        h(channelId, from, dm, text);
      } catch (err) {
        log(`xmtp: onText handler threw: ${errorText(err)}`);
      }
    }
  }

  async function peerInboxIdOf(e: Entry): Promise<string | null> {
    if (e.peerInboxId !== null) return e.peerInboxId;
    if (e.dm) return (e.peerInboxId = e.dm.peerInboxId);
    if (!e.client || Date.now() - e.lastPeerLookup < PEER_LOOKUP_INTERVAL_MS) return null;
    e.lastPeerLookup = Date.now();
    const id = await e.client.fetchInboxIdByIdentifier(identifierOf(e.peer));
    if (id) e.peerInboxId = id;
    return e.peerInboxId;
  }

  /** The DM to the opponent, created (or found: the SDK returns an existing DM) on first use. It fails until the
   *  opponent's client has registered, so it is retried on every `send` rather than only at `open`. */
  async function dmOf(e: Entry): Promise<SdkDm> {
    if (e.dm) return e.dm;
    if (!e.client) throw new Error("xmtp: client not started");
    const dm = await e.client.conversations.createDmWithIdentifier(identifierOf(e.peer));
    e.dm = dm;
    if (e.peerInboxId === null) e.peerInboxId = dm.peerInboxId;
    return dm;
  }

  async function onMessage(e: Entry, m: SdkMessage | undefined): Promise<void> {
    if (!m || e.closed || !e.client || !isText(m)) return;
    if (same(m.senderInboxId, e.client.inboxId)) return; // our own send, echoed back by the stream
    const peerInbox = await peerInboxIdOf(e);
    if (peerInbox === null || !same(m.senderInboxId, peerInbox)) {
      // A stranger: it cannot be in our DM with the opponent (a DM has two members), so neither field is the peer.
      emit(e.channelId, NOT_THE_PEER, NOT_THE_PEER, m.content as string);
      return;
    }
    const conv = (await e.client.conversations.getConversationById(m.conversationId)) as { peerInboxId?: unknown } | undefined;
    const dmPeer = conv && typeof conv.peerInboxId === "string" ? conv.peerInboxId : null;
    emit(e.channelId, e.peer, dmPeer !== null && same(dmPeer, peerInbox) ? e.peer : NOT_THE_PEER, m.content as string);
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
    e.stream = await client.conversations.streamAllMessages({
      conversationType: sdk.ConversationType?.Dm,
      onValue: (m) => {
        onMessage(e, m).catch((err: unknown) => log(`xmtp: channel ${e.channelId}: inbound message failed: ${errorText(err)}`));
      },
      onError: (err) => log(`xmtp: channel ${e.channelId}: stream error: ${errorText(err)}`),
      retryDelay: STREAM_RETRY_DELAY_MS,
    });
    if (e.closed) {
      await e.stream.end().catch(() => undefined);
      return;
    }
    // Best effort: the DM can only be created once the opponent has registered; `send` retries it.
    let dm: SdkDm | null = null;
    try {
      dm = await dmOf(e);
    } catch {
      return;
    }
    const recent = await dm.messages({ limit: XMTP_CATCH_UP_MESSAGES, direction: sdk.SortDirection?.Descending }).catch(() => []);
    for (const m of [...recent].reverse()) await onMessage(e, m).catch(() => undefined);
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
      };
      e.opening = start(e).catch((err: unknown) => {
        // Forgotten, so the next `open` starts over (XmtpRelay retries it).
        if (entries.get(channelId) === e) entries.delete(channelId);
        e.closed = true;
        void e.stream?.end().catch(() => undefined);
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
