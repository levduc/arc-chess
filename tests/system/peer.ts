/**
 * Plan 4.5 Task 9: a malicious opponent built directly on the SDK -- no daemon. It is a real channel member: it
 * accepts a real offer through the real host's lobby (HTTP), funds the real hub from its own wallet, and joins the
 * real relay over its own raw WebSocket with the SDK's nonce-bound join signature.
 *
 * It keeps an honest `ChannelSession` for its own bookkeeping (so it can play on after an attack), and signs attack
 * messages outside that session with the raw SDK primitives (`successor` + `hashState` + `signState`/`signClose`),
 * which is exactly what the session's own guards (equivocation guard, rules check, terminal-only Close) would refuse.
 */
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createPublicClient, http, maxUint256, type Hex, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import {
  ChannelSession,
  HubClient,
  LocalKeyTxSender,
  MemoryStore,
  decodeWire,
  hashState,
  offerId as computeOfferId,
  parseMatchEvent,
  parseMove,
  parseRelayMessage,
  parseSignedOffer,
  signAcceptance,
  signClose,
  signRelayJoin,
  signState,
  successor,
  toWire,
  type ArenaDomain,
  type CloseSignature,
  type Params,
  type Proof,
  type RelayMessage,
  type SignedState,
  type State,
} from "@arena/sdk";
import type { Stack } from "./harness.js";

export type Frame = { type: string; [k: string]: unknown };

export class MaliciousPeer {
  readonly walletKey: Hex = generatePrivateKey();
  readonly sessionKey: Hex = generatePrivateKey();
  readonly address = privateKeyToAccount(this.walletKey).address;
  readonly signer = privateKeyToAccount(this.sessionKey).address;
  readonly domain: ArenaDomain;
  readonly pub: PublicClient;
  readonly hub: HubClient;
  readonly wallet: LocalKeyTxSender;
  readonly sessionSender: LocalKeyTxSender;
  params!: Params;
  channelId!: Hex;
  session!: ChannelSession;
  /** This peer's player index (1: it accepts the honest player's offer, so it is participants[1]). */
  readonly me = 1 as const;
  /** Every relay message received, in arrival order. */
  readonly inbox: RelayMessage[] = [];
  /** Every server `error` frame received. */
  readonly serverErrors: string[] = [];
  /** Every state this peer sent (honest or not), in send order -- for stale replays. */
  readonly sent: SignedState[] = [];
  /** Session-level failures while ingesting incoming messages (when `autoReceive` is on). */
  readonly receiveErrors: string[] = [];
  /** When true (default), incoming states/closes are fed to this peer's own honest session. */
  autoReceive = true;
  private ws: WebSocket | null = null;
  private chain: Promise<void> = Promise.resolve();

  private constructor(private readonly stack: Stack) {
    this.domain = { chainId: stack.chainId, hub: stack.hub };
    this.pub = createPublicClient({ chain: foundry, transport: http(stack.rpcUrl) }) as PublicClient;
    this.hub = new HubClient(stack.hub, this.pub);
    this.wallet = new LocalKeyTxSender(this.walletKey, stack.rpcUrl, foundry);
    this.sessionSender = new LocalKeyTxSender(this.sessionKey, stack.rpcUrl, foundry);
  }

  /** A peer with a funded wallet (gas + 10 USDC) and a session key with gas for its own challenges. */
  static async create(stack: Stack): Promise<MaliciousPeer> {
    const p = new MaliciousPeer(stack);
    await stack.fund(p.address);
    await stack.fund(p.signer, 0n);
    return p;
  }

  // -------------------------------------------------------------------------------------------- lobby + funding

  /** Accepts `offerId` through the real host's HTTP lobby; the response is the match (spec §5). */
  async accept(offerId: Hex): Promise<void> {
    const res = await fetch(`${this.stack.serverUrl}/offers`);
    const list = decodeWire(await res.text()) as unknown[];
    const so = list.map((x) => parseSignedOffer(x)).find((o) => computeOfferId(o.offer) === offerId);
    if (!so) throw new Error(`peer: offer ${offerId} not listed`);
    const acceptance = {
      offerId,
      player: this.address,
      signer: this.signer,
      nonce: `0x${randomBytes(32).toString("hex")}` as Hex,
    };
    const body = toWire({ acceptance, sig: await signAcceptance(this.sessionKey, acceptance) });
    const r = await fetch(`${this.stack.serverUrl}/offers/${offerId}/accept`, { method: "POST", body });
    const text = await r.text();
    if (!r.ok) throw new Error(`peer: accept failed ${r.status}: ${text}`);
    const match = parseMatchEvent(decodeWire(text));
    this.params = match.params;
    this.session = await ChannelSession.create({
      params: this.params,
      me: this.me,
      sessionKey: this.sessionKey,
      domain: this.domain,
      store: new MemoryStore(),
    });
    this.channelId = this.session.id;
  }

  /** Deposits once the offerer has (the hub's funding order, spec §5). */
  async fund(): Promise<void> {
    for (let i = 0; i < 300; i++) {
      const info = await this.hub.channelInfo(this.channelId);
      if (info.phase === "Funding" && info.funded[0]) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await this.hub.approve(this.wallet, this.stack.usdc, maxUint256);
    await this.hub.deposit(this.wallet, this.params);
  }

  // ------------------------------------------------------------------------------------------------------ relay

  /** Opens a raw WebSocket to the real server's `/ws`, and joins this channel with the SDK's relay join signature
   *  over the connection's `hello` nonce. Resolves once the server confirms `joined`. */
  async connect(): Promise<void> {
    const ws = new WebSocket(`${this.stack.serverUrl.replace(/^http/, "ws")}/ws`);
    this.ws = ws;
    const account = privateKeyToAccount(this.sessionKey);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("peer: join timed out")), 10_000);
      ws.on("message", (data) => {
        const frame = decodeWire(data.toString()) as Frame;
        if (frame.type === "hello") {
          void signRelayJoin(account, this.channelId, frame.nonce as Hex).then((sig) =>
            ws.send(toWire({ type: "join", channelId: this.channelId, params: this.params, signer: this.signer, sig })),
          );
        } else if (frame.type === "joined") {
          clearTimeout(timer);
          resolve();
        } else if (frame.type === "relay") {
          const msg = parseRelayMessage(frame.message);
          this.inbox.push(msg);
          if (this.autoReceive) this.chain = this.chain.then(() => this.ingest(msg));
        } else if (frame.type === "error") {
          this.serverErrors.push(String(frame.error));
        }
      });
      ws.on("error", reject);
    });
  }

  private async ingest(msg: RelayMessage): Promise<void> {
    try {
      if (msg.type === "state") await this.session.receive(msg.signed);
      else await this.session.receiveClose(msg.close);
    } catch (err) {
      this.receiveErrors.push(err instanceof Error ? err.message : String(err));
    }
  }

  /** Resolves once every relay message received so far has been fed to the session. */
  async settled(): Promise<void> {
    await this.chain;
  }

  /** Waits until this peer's own session holds turn `n`. */
  async waitTurn(n: bigint, ms = 15_000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await this.chain;
      if (this.session.latest.state.turnNum >= n) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`peer: never reached turn ${n} (at ${this.session.latest.state.turnNum})`);
  }

  /** The state for `turn` that this peer received over the relay (the honest side's signed state), if any. */
  received(turn: bigint): SignedState | undefined {
    for (const m of this.inbox) if (m.type === "state" && m.signed.state.turnNum === turn) return m.signed;
    return undefined;
  }

  sendRaw(message: RelayMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("peer: not connected");
    this.ws.send(toWire({ type: "relay", message }));
  }

  sendState(signed: SignedState): void {
    this.sent.push(structuredClone(signed));
    this.sendRaw({ type: "state", channelId: this.channelId, signed });
  }

  sendClose(close: CloseSignature): void {
    this.sendRaw({ type: "close", channelId: this.channelId, close });
  }

  // --------------------------------------------------------------------------------------------- honest moves

  async move(uci: string): Promise<SignedState> {
    const signed = await this.session.move(uci);
    this.sendState(signed);
    return signed;
  }

  async resign(): Promise<SignedState> {
    const signed = await this.session.resign();
    this.sendState(signed);
    return signed;
  }

  // ------------------------------------------------------------------------------------- raw (attack) signing

  /** The canonical successor of `prev` under `uci` (or an encoded move), with prevHash set -- unsigned. Throws if the
   *  rules refuse it. */
  craft(prev: State, move: string | number): State {
    const encoded = typeof move === "number" ? move : parseMove(prev, move);
    const r = successor(prev, encoded, this.params);
    if (!r.ok) throw new Error(`peer: craft: ${r.reason}`);
    return { ...r.next, prevHash: hashState(prev, this.domain) };
  }

  /** `state` carrying only this peer's signature (sigB), signed outside the session's guards. */
  async signRaw(state: State): Promise<SignedState> {
    return { state, sigA: "0x", sigB: await signState(this.sessionKey, state, this.domain) };
  }

  /** A Close signature by this peer over `state`, outside the session's terminal-only rule; `stateHash` may be
   *  overridden to claim another target. */
  async closeRaw(state: State, stateHash: Hex = hashState(state, this.domain)): Promise<CloseSignature> {
    return { stateHash, by: this.me, sig: await signClose(this.sessionKey, state, this.domain) };
  }

  challenge(proof: Proof) {
    return this.hub.challenge(this.sessionSender, proof);
  }

  close(): void {
    this.ws?.terminate();
    this.ws = null;
  }
}
