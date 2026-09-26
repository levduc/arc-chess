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

export type ChannelHandle = {
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
  protected readonly live = new Map<Hex, ChannelHandle>();
  protected readonly changes = new EventEmitter();
  private timer: NodeJS.Timeout | undefined;
  private unsubscribers: Array<() => void> = [];
  private ticking = false;
  private approved = false;
  /** M1: set by stop(); every handler checks this before any side effect (open/join/fund) it hasn't started yet. */
  private stopped = false;
  /** I3: offerIds currently being turned into a channel — guards against two match events racing the same offer. */
  private readonly claiming = new Set<Hex>();

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
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    while (this.ticking) await new Promise((r) => setTimeout(r, 10));
    this.changes.removeAllListeners();
  }

  channelIds(): Hex[] {
    return [...this.live.keys()];
  }

  /** Direct access to a channel's session and senders — for tests and tooling, not for the agent API. */
  handle(id: Hex): ChannelHandle {
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
    if (this.stopped) return;
    // I3: claim the offerId synchronously, before any await, so a second match event for the same offer
    // (concurrent or back-to-back) bails here instead of racing this call to open a second channel.
    if (this.claiming.has(m.offerId)) return;
    const rec = this.records.offer(m.offerId);
    if (!rec) return;
    this.claiming.add(m.offerId);
    // I3: released on every path that does not end in removeOffer() below (i.e. every rejection or error),
    // so a later, corrected match event for the same offer can still be considered.
    let claimed = true;
    const release = () => {
      if (claimed) {
        this.claiming.delete(m.offerId);
        claimed = false;
      }
    };
    try {
      // I2: never trust the host's participant/signer ordering in m.params — derive `me` from which role this
      // player took when it created or accepted the offer, so a host that swaps indices is caught below by
      // checkMatchParams (params[me] no longer names this player's wallet/signer) rather than trusted.
      const me = rec.role === "offerer" ? 0 : 1;
      const signer = privateKeyToAccount(rec.sessionKey).address;
      const fee = await this.hub.feeConfig();
      if (this.stopped) return release();
      const now = (await this.client.getBlock()).timestamp;
      // M4: an offer the host matched after it expired must never be funded.
      if (now >= rec.offer.expiresAt) {
        this.log(`ignoring match for offer ${m.offerId}: offer has expired`);
        return release();
      }
      // M3: fee equality — accept only the hub's current fee, and only if it is within this player's ceiling.
      const maxFeePerPlayer = fee.feePerPlayer < this.opts.config.maxFeePerPlayer ? fee.feePerPlayer : this.opts.config.maxFeePerPlayer;
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
        maxFeePerPlayer,
        now,
        maxFundingWindow: 7200n,
      });
      if (problem) {
        this.log(`ignoring match for offer ${m.offerId}: ${problem}`);
        return release();
      }
      const id = computeChannelId(this.domain.chainId, this.domain.hub, m.params);
      if (this.live.has(id)) return release();
      if (this.stopped) return release();
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
      // The offer record is gone: a duplicate match event now bails at `!rec` above, so the claim can be released.
      release();
      if (this.stopped) return;
      await this.openChannel(record);
      this.notify();
      void this.tick();
    } catch (err) {
      release();
      this.log(`match handling failed: ${errorText(err)}`);
    }
  }

  private async openChannel(record: ChannelRecord): Promise<void> {
    if (this.stopped) return;
    const store = new FileSessionStore(arenaPaths(this.opts.home).channelSession(record.channelId));
    const session = await ChannelSession.open({
      params: record.params,
      me: record.me,
      sessionKey: record.sessionKey,
      domain: this.domain,
      store,
    });
    // I3/M1: re-check immediately before mutating `live` — the await above is a window another call (or a
    // stop()) could have used to already open this same channel, or to stop the daemon.
    if (this.stopped || this.live.has(record.channelId)) return;
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
  protected async fund(l: ChannelHandle): Promise<void> {
    if (this.stopped) return;
    const p = l.record.params;
    if (!this.approved) {
      await this.hub.approve(this.wallet, this.opts.config.usdc, maxUint256);
      this.approved = true;
    }
    if (this.stopped) return;
    if (this.opts.config.sessionGasWei > 0n) {
      // I1: top up only the shortfall, and only while the session key is actually below the target — otherwise
      // a deposit that keeps reverting (e.g. insufficient USDC) tops up the session key on every tick forever.
      const balance = await this.client.getBalance({ address: l.sessionSender.address });
      if (balance < this.opts.config.sessionGasWei) {
        if (this.stopped) return;
        const hash = await this.wallet.send({
          to: l.sessionSender.address,
          data: "0x",
          value: this.opts.config.sessionGasWei - balance,
        });
        await this.client.waitForTransactionReceipt({ hash });
      }
    }
    if (this.stopped) return;
    await this.hub.deposit(this.wallet, p);
  }

  // ------------------------------------------------------------------ relay

  private async onRelay(msg: RelayMessage): Promise<void> {
    if (this.stopped) return;
    const l = this.live.get(msg.channelId);
    if (!l) return;
    try {
      if (msg.type === "state") {
        await l.session.receive(msg.signed);
        if (this.stopped) return;
        await this.autoPlay(l);
      } else {
        await l.session.receiveClose(msg.close);
        if (this.stopped) return;
        await this.trySubmitClose(l);
      }
      l.lastError = null;
    } catch (err) {
      l.lastError = errorText(err);
      this.log(`channel ${msg.channelId}: ${l.lastError}`);
    }
    if (this.stopped) return;
    this.notify();
  }

  /** Spec §6.3: sign RESIGN when checkmated and CLAIM_STALEMATE when stalemated, regardless of controller. */
  protected async autoPlay(l: ChannelHandle): Promise<void> {
    if (!l.session.isMyTurn()) return;
    const o = outcome(l.session.latest.state);
    if (o === "checkmate") await this.sendState(l, await l.session.resign());
    else if (o === "stalemate") await this.sendState(l, await l.session.claimStalemate());
  }

  protected async sendState(l: ChannelHandle, signed: SignedState): Promise<void> {
    await this.opts.relay.send({ type: "state", channelId: l.record.channelId, signed }).catch((err) => {
      l.lastError = `relay: ${errorText(err)}`;
    });
    await this.respondIfChallenged(l);
  }

  /** If a challenge is pending and we now hold a newer supported state, answer it on-chain from the session key. */
  protected async respondIfChallenged(l: ChannelHandle): Promise<void> {
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

  private async trySubmitClose(l: ChannelHandle): Promise<void> {
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
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      for (const l of this.live.values()) {
        if (this.stopped) break;
        if (l.record.finalized) continue;
        try {
          await this.watch(l);
        } catch (err) {
          l.lastError = errorText(err);
        }
      }
    } finally {
      this.ticking = false;
      if (!this.stopped) this.notify();
    }
  }

  /** One watchtower pass for one channel. Task 4 funds only; Task 6 adds disputes. */
  protected async watch(l: ChannelHandle): Promise<void> {
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

  protected pick(ref: string | undefined): ChannelHandle {
    const active = [...this.live.values()].filter((l) => !l.record.finalized);
    if (ref) {
      const hits = [...this.live.values()].filter((l) => l.record.channelId.toLowerCase().startsWith(ref.toLowerCase()));
      if (hits.length === 1) return hits[0];
      throw new DaemonError(hits.length === 0 ? 404 : 400, hits.length === 0 ? `unknown channel ${ref}` : `ambiguous channel ${ref}`);
    }
    if (active.length === 1) return active[0];
    throw new DaemonError(400, active.length === 0 ? "no active channel" : "several channels are active: pass --channel");
  }

  protected requireController(l: ChannelHandle, actor: Actor): void {
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
    try {
      this.changes.emit("change");
    } catch {
      // M8: a throwing listener must never break the caller (a move, a relay message, a tick).
    }
  }

  protected log(line: string): void {
    (this.opts.log ?? (() => undefined))(line);
  }
}
