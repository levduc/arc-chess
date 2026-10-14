import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { expect } from "vitest";
import {
  ChannelSession,
  MemoryStore,
  decodeWire,
  parseRelayMessage,
  type ArenaDomain,
  type Params,
  type RelayMessage,
  type RelaySigner,
} from "@arena/sdk";
import type { HostRelay } from "../../src/host.js";
import type { XmtpTransport } from "../../src/xmtp/transport.js";
import { makeParams } from "../../../sdk/test/helpers/fixtures.js";

// ------------------------------------------------------------------------------------------------- fakes

/** A host relay whose link the test drives: `setJoined` flips `isJoined` and fires `onLinkChange` (and `onJoined`
 *  on a join), exactly as `connectHost` does. */
export class FakeHost implements HostRelay {
  readonly joined = new Set<Hex>();
  readonly sent: RelayMessage[] = [];
  readonly joins: Hex[] = [];
  readonly left: Hex[] = [];
  /** Throws on send even while `isJoined` (the socket dropping between the check and the send). */
  throwOnSend = false;
  private readonly msgHandlers = new Set<(m: RelayMessage) => void>();
  private readonly joinedHandlers = new Set<(id: Hex) => void>();
  private readonly linkHandlers = new Set<() => void>();

  async join(channelId: Hex): Promise<void> {
    this.joins.push(channelId);
  }
  async send(msg: RelayMessage): Promise<void> {
    if (this.throwOnSend || !this.joined.has(msg.channelId)) throw new Error("relay not connected");
    this.sent.push(msg);
  }
  onMessage(h: (m: RelayMessage) => void): () => void {
    this.msgHandlers.add(h);
    return () => this.msgHandlers.delete(h);
  }
  onJoined(h: (id: Hex) => void): () => void {
    this.joinedHandlers.add(h);
    return () => this.joinedHandlers.delete(h);
  }
  leave(channelId: Hex): void {
    this.left.push(channelId);
    if (this.joined.delete(channelId)) for (const h of this.linkHandlers) h();
  }
  isJoined(channelId: Hex): boolean {
    return this.joined.has(channelId);
  }
  onLinkChange(h: () => void): () => void {
    this.linkHandlers.add(h);
    return () => this.linkHandlers.delete(h);
  }
  setJoined(channelId: Hex, up: boolean): void {
    if (up) this.joined.add(channelId);
    else this.joined.delete(channelId);
    for (const h of this.linkHandlers) h();
    if (up) for (const h of this.joinedHandlers) h(channelId);
  }
  deliver(msg: RelayMessage): void {
    for (const h of this.msgHandlers) h(msg);
  }
}

export class FakeXmtp implements XmtpTransport {
  readonly opened: Array<{ channelId: Hex; me: Address; peer: Address }> = [];
  readonly sent: Array<{ channelId: Hex; text: string }> = [];
  readonly closed: Hex[] = [];
  stopped = false;
  openImpl: () => Promise<void> = async () => undefined;
  sendImpl: () => Promise<void> = async () => undefined;
  private readonly handlers = new Set<(channelId: Hex, from: Address, dm: Address, text: string) => void>();

  async open(channelId: Hex, me: RelaySigner, peer: Address): Promise<void> {
    this.opened.push({ channelId, me: me.address, peer });
    return this.openImpl();
  }
  async send(channelId: Hex, text: string): Promise<void> {
    await this.sendImpl();
    this.sent.push({ channelId, text });
  }
  onText(h: (channelId: Hex, from: Address, dm: Address, text: string) => void): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
  async close(channelId: Hex): Promise<void> {
    this.closed.push(channelId);
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  deliver(channelId: Hex, from: Address, dm: Address, text: string): void {
    for (const h of this.handlers) h(channelId, from, dm, text);
  }
  /** The RelayMessages sent so far, decoded from their `{"arena":1,"msg":…}` frames. */
  messages(): RelayMessage[] {
    return this.sent.map((s) => {
      const outer = decodeWire(s.text) as { arena: number; msg: unknown };
      expect(outer.arena).toBe(1);
      return parseRelayMessage(outer.msg);
    });
  }
}

// ------------------------------------------------------------------------------------------------- fixtures

export const domain: ArenaDomain = { chainId: 31337, hub: "0x000000000000000000000000000000000000beef" };

/** A real ChannelSession pair (A is seat 0, B seat 1) over fresh session keys. */
export async function sessionPair() {
  const keys = [generatePrivateKey(), generatePrivateKey()] as const;
  const params: Params = makeParams({
    participants: ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000b2"],
    sessionKeys: keys,
    rules: "0x00000000000000000000000000000000000000e5" as Address,
    feeRecipient: "0x00000000000000000000000000000000000000f6" as Address,
    fundingDeadline: 2_000_000_000n,
    salt: `xmtp-${Math.random()}`,
  });
  const cfg = (me: 0 | 1) => ({ params, me, sessionKey: keys[me], domain, store: new MemoryStore() });
  const a = await ChannelSession.create(cfg(0));
  const b = await ChannelSession.create(cfg(1));
  const signers = [privateKeyToAccount(keys[0]), privateKeyToAccount(keys[1])] as const;
  return { a, b, params, id: a.id, signers };
}

/** Runs every queued microtask and promise continuation (fake timers fake only setTimeout/clearTimeout). */
export const settle = () => new Promise<void>((r) => setImmediate(r));


// ------------------------------------------------------------------------------------------------- a fake node-sdk

export type FakeMessage = { id: string; content: unknown; conversationId: string; senderInboxId: string };

/** The SDK's AsyncStream, as far as the transport can see it: a buffer that grows while nobody reads it. Like the
 *  real one, `push` also calls `onValue` when the consumer passed one. */
export class FakeStream {
  readonly buffer: FakeMessage[] = [];
  isDone = false;
  private readonly waiters: Array<(r: IteratorResult<FakeMessage>) => void> = [];
  constructor(readonly opts: Record<string, unknown>) {}
  push(m: FakeMessage): void {
    if (this.isDone) return;
    const w = this.waiters.shift();
    if (w) w({ done: false, value: m });
    else this.buffer.push(m);
    (this.opts.onValue as ((m: FakeMessage) => void) | undefined)?.(m);
  }
  next = (): Promise<IteratorResult<FakeMessage>> => {
    if (this.isDone) return Promise.resolve({ done: true, value: undefined });
    const m = this.buffer.shift();
    if (m) return Promise.resolve({ done: false, value: m });
    return new Promise((r) => this.waiters.push(r));
  };
  end = (): Promise<IteratorResult<FakeMessage>> => {
    this.isDone = true;
    this.buffer.length = 0;
    for (const w of this.waiters.splice(0)) w({ done: true, value: undefined });
    return Promise.resolve({ done: true, value: undefined });
  };
  return = this.end;
  /** The native stream failing with `retryOnFail: false`: the SDK ends the async stream. */
  fail(): void {
    void this.end();
  }
  [Symbol.asyncIterator](): this {
    return this;
  }
}

export type FakeConversation = {
  id: string;
  peerInboxId?: string;
  consent: number[];
  updateConsentState(state: number): void;
};

/**
 * A fake `@xmtp/node-sdk` for one client (B, the transport under test) talking to the opponent A and to strangers.
 * Inbox ids are `inbox-<address>`; the opponent's DM is `dm-ab`.
 */
export class FakeSdk {
  static readonly ConsentState = { Unknown: 0, Allowed: 1, Denied: 2 };
  readonly IdentifierKind = { Ethereum: 0, Passkey: 1 };
  readonly ConversationType = { Dm: 0, Group: 1 };
  readonly SortDirection = { Ascending: 0, Descending: 1 };
  readonly ConsentState = FakeSdk.ConsentState;
  readonly streams: FakeStream[] = [];
  readonly creates: Array<Record<string, unknown>> = [];
  /** Every streamAllMessages call's options, including ones that threw. */
  readonly streamCalls: Array<Record<string, unknown>> = [];
  readonly conversations = new Map<string, FakeConversation & { sent?: string[] }>();
  /** The opponent DM's history, oldest first (what `dm.messages()` returns, newest first, limited). */
  readonly history: FakeMessage[] = [];
  readonly messagesCalls: Array<Record<string, unknown>> = [];
  lookups = 0;
  /** Whether the opponent has registered (`fetchInboxIdByIdentifier` finds it). */
  peerRegistered = true;
  /** Makes the next N streamAllMessages calls fail to start (a `syncAll` failure while offline): like the real
   *  `createStream` with `retryOnFail: false`, the call reports `onError` and returns an already-ended stream. */
  failStarts = 0;
  /** Makes the next N getConversationById calls come back `undefined` (the SDK turns any error into that). */
  lookupMisses = 0;
  /** Groups B has been invited to (strangers' invites). */
  readonly groups: FakeConversation[] = [];
  /** Delays a getConversationById call: the test resolves it. */
  lookupGate: Promise<void> | null = null;
  readonly sentTexts: string[] = [];
  readonly isText = (m: FakeMessage) => typeof m.content === "string";
  readonly Client: { create(signer: unknown, opts: Record<string, unknown>): Promise<unknown> };

  constructor(
    readonly me: Address,
    readonly peer: Address,
  ) {
    const sdk = this;
    const meInbox = FakeSdk.inboxOf(me);
    const peerInbox = FakeSdk.inboxOf(peer);
    this.conversations.set("dm-ab", { id: "dm-ab", peerInboxId: peerInbox, consent: [], updateConsentState(s) { this.consent.push(s); } });
    const dm = () => {
      const c = sdk.conversations.get("dm-ab")!;
      return {
        id: c.id,
        peerInboxId: peerInbox,
        updateConsentState: (s: number) => c.consent.push(s),
        sendText: async (text: string) => {
          sdk.sentTexts.push(text);
          return `sent-${sdk.sentTexts.length}`;
        },
        messages: async (opts: { limit?: number; direction?: number } = {}) => {
          sdk.messagesCalls.push(opts);
          const newestFirst = [...sdk.history].reverse();
          return opts.limit !== undefined ? newestFirst.slice(0, opts.limit) : newestFirst;
        },
      };
    };
    const client = {
      inboxId: meInbox,
      fetchInboxIdByIdentifier: async (id: { identifier: string }) =>
        sdk.peerRegistered && id.identifier.toLowerCase() === peer.toLowerCase() ? peerInbox : null,
      preferences: {
        getInboxStates: async (ids: string[]) =>
          ids.map((i) => ({ identifiers: [{ identifier: i.replace(/^inbox-/, ""), identifierKind: 0 }] })),
      },
      conversations: {
        createDmWithIdentifier: async (id: { identifier: string }) => {
          if (!sdk.peerRegistered || id.identifier.toLowerCase() !== peer.toLowerCase()) throw new Error("peer not registered");
          return dm();
        },
        listGroups: (opts: { consentStates?: number[] } = {}) =>
          sdk.groups.filter((g) => !opts.consentStates || opts.consentStates.includes(g.consent.at(-1) ?? FakeSdk.ConsentState.Unknown)),
        getConversationById: async (id: string) => {
          sdk.lookups++;
          if (sdk.lookupMisses > 0) {
            sdk.lookupMisses--;
            return undefined;
          }
          const gate = sdk.lookupGate;
          if (gate) {
            sdk.lookupGate = null;
            await gate;
          }
          return sdk.conversations.get(id);
        },
        streamAllMessages: async (opts: Record<string, unknown>) => {
          sdk.streamCalls.push(opts);
          const s = new FakeStream(opts);
          if (sdk.failStarts > 0) {
            sdk.failStarts--;
            (opts.onError as ((err: Error) => void) | undefined)?.(new Error("syncAll failed: offline"));
            void s.end();
          }
          sdk.streams.push(s);
          return s;
        },
      },
    };
    this.Client = {
      create: async (_signer: unknown, opts: Record<string, unknown>) => {
        sdk.creates.push(opts);
        return client;
      },
    };
  }

  static inboxOf(a: Address): string {
    return `inbox-${a.toLowerCase()}`;
  }

  /** A stranger's group invite to B. */
  strangerGroup(id: string): FakeConversation {
    const g: FakeConversation = { id, consent: [], updateConsentState(s) { this.consent.push(s); } };
    this.groups.push(g);
    this.conversations.set(id, g);
    return g;
  }

  /** A stranger's DM with B. */
  strangerDm(stranger: Address): string {
    const id = `dm-${stranger.toLowerCase()}`;
    if (!this.conversations.has(id)) {
      this.conversations.set(id, { id, peerInboxId: FakeSdk.inboxOf(stranger), consent: [], updateConsentState(s) { this.consent.push(s); } });
    }
    return id;
  }

  /** A text from `from` in `conversationId`. */
  msg(id: string, from: Address, text: string, conversationId = "dm-ab"): FakeMessage {
    return { id, content: text, conversationId, senderInboxId: FakeSdk.inboxOf(from) };
  }

  get stream(): FakeStream {
    const s = this.streams.at(-1);
    if (!s) throw new Error("no stream yet");
    return s;
  }
}
