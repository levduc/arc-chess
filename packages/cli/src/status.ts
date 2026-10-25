import { Chess } from "chess.js";
import { formatUnits, type Hex } from "viem";
import {
  KIND,
  PROMO_LETTER,
  STATUS,
  decodeMove,
  fenOf,
  isGameOver,
  legalMoves,
  outcome,
  squareName,
  unpackMeta,
  type Outcome,
  type PlayerIndex,
  type SessionSnapshot,
} from "@arena/sdk";
import { chainProfile, weiToUsdc6Up } from "./chains.js";
import type { ChainView } from "./daemon.js";
import { FUND_TX_GAS_UNITS, formatUsdc6 } from "./funding.js";
import type { ChannelRecord, Controller } from "./records.js";

export type ChannelStatus = {
  channelId: Hex;
  phase: string;
  me: PlayerIndex;
  color: "white" | "black";
  /** Plan 5 Task 2: the board's own orientation for this seat -- always equal to `color`. */
  orientation: "white" | "black";
  controller: Controller;
  note: string;
  /** Plan 5 Task 2: the last move applied to reach `fen` from the state before it, as `{from, to, san}` (computed
   *  with chess.js from the previous FEN and the decoded move). `null` at the start of a game (no previous state)
   *  and for a non-move latest state (resign, accept-draw, claim-stalemate, a new-game checkpoint). */
  lastMove: { from: string; to: string; san: string } | null;
  /** Plan 5 Task 2: who controls this seat, this seat's handoff note, and when that was last set (ISO 8601), or
   *  `null` if this channel has never been handed off. `controller`/`note` duplicate the top-level fields of the
   *  same name (kept there for existing callers); this groups them with `since` for the board's controller panel. */
  handoff: { controller: Controller; note: string; since: string | null };
  gameIndex: number;
  turnNum: string;
  fen: string;
  board: string;
  legalMoves: string[];
  /** Plan 5 Task 2: the same legal moves as `legalMoves`, as UCI strings (e.g. "e7e8q") -- for the board's click
   *  targets. Empty unless it is my turn, exactly like `legalMoves`. */
  legalMovesUci: string[];
  myTurn: boolean;
  gameStatus: "playing" | "draw_offered" | "white_won" | "black_won" | "draw";
  outcome: Outcome;
  balances: { me: string; opponent: string };
  cooldown: { meSeconds: number; opponentSeconds: number };
  newGame: "none" | "proposed_by_me" | "proposed_by_opponent";
  closing: boolean;
  opponentWantsToClose: boolean;
  /** `autoReturnAt` (final fix wave I1): the chain time (unix seconds, like `deadline`) at which the daemon hands
   *  this seat back to the agent -- set only while a human holds a seat that must move and auto-return is on. */
  challenge: null | {
    deadline: string;
    secondsLeft: number;
    mustMove: boolean;
    challenger: "me" | "opponent";
    autoReturnAt: string | null;
  };
  attention:
    | null
    /** H1 fix round 1 (review I-1): Challenged on a registered state newer than this daemon holds, whose event could
     *  not be read -- unanswered, the current game is forfeited at the deadline. Whoever holds the seat. */
    | "challenge-unseen"
    | "session-gas-low"
    | "human-must-move"
    | "your-turn"
    | "new-game-proposed"
    | "game-over"
    | "close-requested"
    | "opponent-silent"
    | "settled";
  /** Plan 5 Task 3 fix round: what a human holding the seat should see that `attention` deliberately leaves out.
   *  `attention` stays agent-only apart from session-gas-low and human-must-move (final fix wave I1), because
   *  `wait()` wakes on any `attention` and must stay quiet while a human controls the channel (spec §6.2). Today that is `opponent-silent` alone, with
   *  `arena challenge` first in `suggestedActions` exactly as for the agent. Null while the agent is in control. */
  humanAttention: null | "opponent-silent";
  suggestedActions: string[];
  lastError: string | null;
  /** Plan 4.5 Task 11 fix round (C2): the daemon-wide "too many watched offers" (or other subscribe-refusal)
   *  message, if the host has ever refused a subscribe on this daemon's connection, else null. Not specific to
   *  this channel -- it means new offers/accepts are refused until this daemon restarts (see checkLobbyHealthy in
   *  daemon.ts) -- but every channel's status carries it, since there is no daemon-wide endpoint to put it on. */
  lobbyError: string | null;
  /** Plan 5 fix round (I2): the record's own sweep outcome -- `null` while not finalized or not yet swept,
   *  `true`/`"dust"`/`"abandoned"` once the sweep (or the abandon back-off) has run. See `ChannelRecord.swept`. */
  swept: true | "dust" | "abandoned" | null;
  /** Plan 5 fix round: the swept amount (base units of native gas), set alongside `swept: true`. The latest
   *  entry of `sweeps`, kept for compatibility. */
  sweptAmount: string | null;
  /** Plan 5 fix round: the sweep transaction's hash, set alongside `swept: true`. The latest entry of `sweeps`,
   *  kept for compatibility. */
  sweptTx: Hex | null;
  /** Fix round 3, M-4: every real sweep this channel's session key has had, oldest first -- a late top-up
   *  (minor 4) or a retried-and-succeeded abandoned channel (important 1) can mean more than one over its
   *  lifetime; `sweptAmount`/`sweptTx` alone only ever show the latest. Empty if it has never been swept. */
  sweeps: Array<{ amount: string; tx: Hex; at: number }>;
  /** Plan 5.7 (spec §2): the side this channel's messages are sent on now -- `"relay"` (the host), `"xmtp"` (the
   *  fallback, once the host has been down for the grace window), or `"none"` (neither yet: within the window, or a
   *  settled channel). Without the XMTP fallback it is `"relay"` or `"none"`. */
  transport: "relay" | "xmtp" | "none";
  /** Plan 5.7 (spec §3, K3): inbound XMTP messages dropped for this channel by the acceptance checks -- a known
   *  stranger's, an oversized or malformed one, one over the rate limit, or one the session rejected after its sender
   *  could not be determined. 0 when the XMTP fallback is off (or not armed for this channel). */
  xmtpDropped: number;
  /** H1 fix round 1 (review m-2): blocks whose dispute events for this channel the RPC refused to serve, even alone,
   *  and the scan skipped (`ChannelRecord.skippedEventBlocks`), as decimal strings; empty when none. */
  skippedEventBlocks: string[];
  /** H3 (Arc testnet rehearsal §8.2): set only on an action route's answer (`POST /move`, `/close`, ...) whose action
   *  took effect but whose chain refresh afterwards failed (a rate-limited RPC): the chain fields are the last ones
   *  read, and `chainStaleReason` says why they could not be read again. A `GET /status` never sets it. */
  chainStale?: true;
  chainStaleReason?: string;
  /** Final fix wave B (m-7): set with `chainStale` when the action's own transaction (a challenge, a reclaim) was mined
   *  but its receipt could not be read -- whether it succeeded is not known yet. The text says so, with the hash. */
  unconfirmed?: string;
};

export type StatusInput = {
  record: ChannelRecord;
  snapshot: SessionSnapshot;
  myTurn: boolean;
  chain: ChainView | null;
  lastError: string | null;
  /**
   * I2: chain time at which the daemon last saw this channel progress (a state, checkpoint, Close signature or
   * phase change), or null if not yet observed. Drives `opponent-silent`.
   */
  lastProgressAt?: bigint | null;
  /** Plan 4.5 Task 11 fix round (C2): see ChannelStatus.lobbyError. */
  lobbyError?: string | null;
  /** Final review C1: why the session key's dispute gas is low and the wallet could not refill it, or null. */
  sessionGasLow?: string | null;
  /** H1 (Task 2 review Minor-2, audit-daemon M-5): what kind of failure `sessionGasLow` is, so its action names a
   *  remedy that works. Absent: `"funds"`, the action as before. */
  sessionGasLowCause?: SessionGasLowCause | null;
  /** H1 fix round 1 (review I-1): set by the daemon once a registered state newer than its latest has stayed unread
   *  past its debounce (`challenge-unseen`). */
  unseenChallenge?: { registeredTurn: bigint; deadline: bigint } | null;
  /** Final review m4: the channel settled while the daemon watched it and no `wait()` has woken for it yet. */
  settled?: boolean;
  /** Final fix wave (I1): seconds before the deadline at which the daemon returns a human-held seat that must move
   *  to the agent (`autoReturnSecondsOf`), or null/absent when auto-return is off. */
  autoReturnSeconds?: number | null;
  /** Final fix wave (I1): `wait()` has already woken for this challenge's `human-must-move`. */
  ignoreHumanMustMove?: boolean;
  /** Plan 5.7: see ChannelStatus.transport. Default `"none"`. */
  transport?: ChannelStatus["transport"];
  /** Plan 5.7 (K3): see ChannelStatus.xmtpDropped. Default 0. */
  xmtpDropped?: number;
  /** Plan 6 hardening H2 (audit-journey I-2): the chain and gas numbers `session-gas-low` is worded from -- the
   *  daemon's `config.chainId` and `config.sessionGasWei`, and its wallet's fee ceiling. On a chain whose gas is USDC
   *  (Arc), the reason is then shown in USDC, not wei, and the action says how much USDC to send. Absent, or on any
   *  other chain: the chain-neutral wording, unchanged. See `sessionGasLowAction`. */
  gasFunding?: { chainId: number; sessionGasWei: bigint; feeCeilingWei: bigint };
};

const GAME_STATUS = ["playing", "draw_offered", "white_won", "black_won", "draw"] as const;

/**
 * Plan 6 hardening H2 (audit-journey I-2): a `session-gas-low` reason (the daemon's own text, in wei) as an agent on a
 * chain whose gas is USDC should read it: on Arc, 10^18 wei is 1 USDC. The daemon's reason is "the session key holds
 * N wei, below the floor of M, and the wallet could not refill it: <the first line of the error>". So:
 * - a fee per gas -- `TxFeeCapError`'s "the cap of N wei per gas (needs M)" -- becomes gwei, its `needs` included;
 * - every other native amount (`N wei`) becomes USDC at 18 decimals, as does the key's floor (printed without a unit).
 * Anything else in the text is kept as it is. H2 fix round 1 (review m-1): the rules are pinned against the reasons
 * the daemon actually emits; the amount to ask the human for never comes from here (see `sessionGasLowAction`).
 */
export function gasReasonInUsdc(reason: string): string {
  const gwei = (n: string) => `${formatUnits(BigInt(n), 9)} gwei per gas`;
  return reason
    .replace(/\b(\d+) wei per gas( \(needs (\d+)\))?/g, (_m, n: string, needs?: string, m?: string) =>
      needs !== undefined && m !== undefined ? `${gwei(n)} (needs ${gwei(m)})` : gwei(n),
    )
    .replace(/\b(\d+) wei\b/g, (_m, n: string) => `${formatUnits(BigInt(n), 18)} USDC`)
    .replace(/\b(below the floor of )(\d+)\b(?! (?:g?wei|USDC))/g, (_m, pre: string, n: string) => `${pre}${formatUnits(BigInt(n), 18)} USDC`);
}

/**
 * H1 (Task 2 review Minor-2, audit-daemon M-5): why a refill failed, as the daemon classified it.
 * - `funds`: the wallet cannot pay the refill (`TxInsufficientFundsError`) -- funding the wallet fixes it.
 * - `fee-cap`: a refill needs a fee over the wallet's fee ceiling (`TxFeeCapError`).
 * - `estimate`: the refill's fee or gas estimate failed.
 * - `reverted`: the top-up was mined and reverted (`txHash`); nothing reached the key.
 * - `failing`: `failures` refills in a row failed in transit (dropped, stuck, no receipt, a nonce race).
 * Only `funds` is fixed by sending the wallet money, so only its action asks for any.
 */
export type SessionGasLowCause =
  | { kind: "funds" }
  | { kind: "fee-cap" }
  | { kind: "estimate" }
  | { kind: "reverted"; txHash: Hex }
  | { kind: "failing"; failures: number };

/**
 * The `session-gas-low` action, first in `suggestedActions` (final review C1). Chain-neutral by default, unchanged:
 * fund the wallet and the daemon refills the key on its next pass. Plan 6 hardening H2 (audit-journey I-2): on a
 * chain whose gas is USDC (Arc), the reason is shown in USDC (`gasReasonInUsdc`), and the action names the asset,
 * the network and the amount -- one channel's gas budget, as `arena fund` counts it: its `sessionGasWei` (the most
 * one refill can send) plus `FUND_TX_GAS_UNITS` x the wallet's fee ceiling for the refill's own gas, rounded up.
 * H1 (Task 2 review Minor-2): that holds only when the wallet's balance is the cause (`cause` absent or `funds`).
 * Any other cause gets its own remedy, says that funding the wallet will not fix it, and asks for no amount.
 */
export function sessionGasLowAction(
  channelId: Hex,
  reason: string,
  gasFunding?: StatusInput["gasFunding"],
  cause?: SessionGasLowCause | null,
): string {
  const profile = gasFunding !== undefined ? chainProfile(gasFunding.chainId) : undefined;
  if (cause && cause.kind !== "funds") {
    const why = profile?.nativeIsUsdc === true ? gasReasonInUsdc(reason) : reason;
    const low = `dispute gas for channel ${channelId} is low (${why})`;
    const notFunds = "funding the wallet will not fix it; the daemon retries with back-off";
    switch (cause.kind) {
      case "reverted":
        return (
          `check the refill: a top-up of channel ${channelId}'s session key reverted on-chain (tx ${cause.txHash}), so ` +
          `nothing reached the key and ${low}; ${notFunds}. A top-up reverts when the wallet or the session key ` +
          "cannot send or receive (on Arc: a blocklisted address)"
        );
      case "fee-cap":
        return `wait: ${low}; a refill needs a fee over the wallet's fee ceiling right now, and ${notFunds} as fees fall`;
      case "estimate":
        return `check the RPC: ${low}; the refill's fee or gas estimate failed, so nothing was sent, and ${notFunds}`;
      case "failing":
        return (
          `check the RPC: ${low}; the last ${cause.failures} refills failed before they could be confirmed (dropped, ` +
          `stuck or without a receipt), and ${notFunds}. On Arc, a transfer from or to a blocklisted address gets no receipt`
        );
    }
  }
  if (gasFunding === undefined || profile?.nativeIsUsdc !== true) {
    return `fund your wallet: dispute gas for channel ${channelId} is low (${reason}); the daemon refills it on its next pass`;
  }
  const ask = formatUsdc6(weiToUsdc6Up(gasFunding.sessionGasWei + FUND_TX_GAS_UNITS * gasFunding.feeCeilingWei));
  return (
    `fund your wallet: dispute gas for channel ${channelId} is low (${gasReasonInUsdc(reason)}); on ${profile.name}, ` +
    `gas is paid in USDC: ask your human to send at least ${ask} USDC to this wallet on ${profile.name} ` +
    `(chain id ${gasFunding.chainId}), and the daemon refills it on its next pass once that arrives`
  );
}

export function usdc(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = (amount % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

/**
 * Plan 5 Task 2: `latest`'s move, described against `prev` (the state directly before it) as `{from, to, san}`,
 * or `null` when there is nothing to describe -- no `prev` at all (the opening state), a non-move latest state
 * (resign, accept-draw, claim-stalemate, or a NEW_GAME checkpoint), or (defensively) a `prev` that turns out not
 * to be latest's immediate predecessor after all. `ChannelSession.advanceLatest` sets `prev` to the old `latest`
 * on every normal move, so the turnNum/gameIndex check below should never actually fail in practice; it exists so
 * an unexpected shape falls back to `null` instead of feeding chess.js a mismatched position.
 */
function lastMoveOf(snapshot: SessionSnapshot): ChannelStatus["lastMove"] {
  const { prev, latest } = snapshot;
  if (!prev) return null;
  const decoded = decodeMove(latest.state.move);
  if (decoded.kind !== KIND.NORMAL && decoded.kind !== KIND.NORMAL_OFFER_DRAW) return null;
  if (prev.state.turnNum + 1n !== latest.state.turnNum || prev.state.gameIndex !== latest.state.gameIndex) return null;
  const from = squareName(decoded.from);
  const to = squareName(decoded.to);
  try {
    const game = new Chess(fenOf(prev.state));
    const played = game.move({ from, to, ...(decoded.promo ? { promotion: PROMO_LETTER[decoded.promo] } : {}) });
    return { from, to, san: played.san };
  } catch {
    return null;
  }
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
  let challenge: ChannelStatus["challenge"] = null;
  if (chain && phase === "Challenged") {
    const mustMove = myTurn && chain.registeredTurn !== null && chain.registeredTurn === s.turnNum;
    const autoReturn = input.autoReturnSeconds ?? null;
    challenge = {
      deadline: chain.deadline.toString(),
      secondsLeft: Math.max(0, Number(chain.deadline - chain.now)),
      mustMove,
      challenger: chain.challenger === me ? "me" : "opponent",
      autoReturnAt:
        mustMove && record.controller === "human" && autoReturn !== null ? (chain.deadline - BigInt(autoReturn)).toString() : null,
    };
  }
  const cooldown = chain
    ? {
        meSeconds: Math.max(0, Number(chain.cooldownUntil[me] - chain.now)),
        opponentSeconds: Math.max(0, Number(chain.cooldownUntil[opponent] - chain.now)),
      }
    : { meSeconds: 0, opponentSeconds: 0 };
  const over = isGameOver(s);
  const live = phase === "Open" || phase === "Challenged";
  const open = phase === "Open";

  // I2: the channel waits on the opponent — their move, their countersignature on our new-game proposal, or their
  // Close signature once we have signed ours. Silence beyond challengeTimeout (chain time) escalates (spec §7).
  const waitingOnOpponent =
    open && !myTurn && (!over || newGame === "proposed_by_me" || (closing && !opponentWantsToClose));
  const lastProgressAt = input.lastProgressAt ?? null;
  const silent =
    waitingOnOpponent && chain !== null && lastProgressAt !== null && chain.now - lastProgressAt > record.params.challengeTimeout;

  let attention: ChannelStatus["attention"] = null;
  // Final review C1: first, and whoever controls the channel -- a session key that cannot pay cannot answer a
  // challenge, and an unanswered one can roll the channel back.
  const gasLow = live && input.sessionGasLow ? input.sessionGasLow : null;
  const unseen = phase === "Challenged" && input.unseenChallenge ? input.unseenChallenge : null;
  const skippedBlocks = (record.skippedEventBlocks ?? []).map((b) => b.toString());
  if (unseen) attention = "challenge-unseen";
  else if (gasLow) attention = "session-gas-low";
  else if (live && record.controller === "agent") {
    if (myTurn) attention = "your-turn";
    else if (newGame === "proposed_by_opponent" && !closing) attention = "new-game-proposed";
    // I2: only a request we can honour — `arena close` works only on a finished game with no proposal pending.
    else if (opponentWantsToClose && over && !closing && newGame === "none") attention = "close-requested";
    else if (over && !closing && newGame === "none") attention = "game-over";
    else if (silent) attention = "opponent-silent";
  } else if (live && challenge?.mustMove && !input.ignoreHumanMustMove) {
    // Final fix wave (I1): a human holds a seat that must move before the challenge deadline. Raised for the agent
    // too (wait() wakes once per challenge): the human may have walked away, and a missed deadline forfeits.
    attention = "human-must-move";
  } else if (input.settled && (phase === "Finalized" || phase === "Reclaimed")) {
    // Final review m4: one wake for the settlement (e.g. after this player's close), consumed by `wait()`. Final
    // fix wave (M2): whoever holds the seat -- a settled channel has no seat left to protect.
    attention = "settled";
  }

  const humanAttention: ChannelStatus["humanAttention"] = record.controller === "human" && silent ? "opponent-silent" : null;

  const suggestedActions: string[] = [];
  // I2: the on-chain escape from a stalled or withheld state (only while Open; once Challenged it is under way).
  let challengeHint: string | null = null;
  if (phase === "None" || phase === "Funding") {
    suggestedActions.push(
      record.finalized
        ? "done: the funding window closed without this channel opening; nothing is left to do"
        : "wait: the channel is being funded",
    );
    // Task 2 (spec §13): names the cause when funding is blocked by the hub's pause, rather than leaving the
    // agent to guess why a channel is not progressing.
    if (!record.finalized && input.lastError?.startsWith("funding: Paused")) {
      suggestedActions.push(
        "wait: the hub is paused; funding resumes automatically when it is unpaused (or reclaim after the funding deadline)",
      );
    }
  } else if (phase === "Finalized") suggestedActions.push("done: the channel is settled");
  else if (phase === "Reclaimed") suggestedActions.push("done: the channel was never funded and deposits were returned");
  else if (closing) {
    suggestedActions.push("wait: close signed; waiting for the opponent's close signature");
    if (open && !opponentWantsToClose) challengeHint = "arena challenge   (settles the finished game on-chain if they never sign)";
  } else if (myTurn) {
    suggestedActions.push(`arena move <move>   (one of: ${game.moves().slice(0, 8).join(", ")}${game.moves().length > 8 ? ", …" : ""})`);
    suggestedActions.push("arena move <move> --offer-draw", "arena resign");
    if (status === STATUS.DRAW_OFFERED) suggestedActions.push("arena accept-draw");
  } else if (over) {
    if (newGame === "proposed_by_me") {
      // `arena close` always fails while our own proposal is pending, so it is not offered here.
      suggestedActions.push("wait: new game proposed");
      if (open) challengeHint = "arena challenge   (settles the finished game on-chain if the opponent never answers)";
    } else if (opponentWantsToClose) {
      // Final review I2: `arena next-game` now refuses once the opponent has signed Close (daemon.ts's
      // nextGame), so it must not be suggested here either -- the only way forward is `close`.
      suggestedActions.push("arena close");
    } else {
      suggestedActions.push("arena next-game", "arena close");
    }
  } else {
    suggestedActions.push("arena wait");
    if (open) challengeHint = "arena challenge   (if the opponent stops responding)";
  }
  if (silent) {
    suggestedActions.unshift(
      `arena challenge   (the opponent has made no progress for over ${record.params.challengeTimeout}s; forces an answer on-chain)`,
    );
  } else if (challengeHint) {
    suggestedActions.push(challengeHint);
  }
  if (challenge?.mustMove && record.controller === "human") {
    suggestedActions.unshift(
      `tell your human: a challenge needs their move on the board within ${challenge.secondsLeft}s` +
        (challenge.autoReturnAt !== null
          ? `; with ${input.autoReturnSeconds}s left the daemon hands the seat back to you, and then you must move (arena move)`
          : "; if they cannot, take the seat back (arena handoff agent) and move"),
    );
  }
  // Final fix wave B (m-3): never on a finalized record (a retired channel is still in `live` for a while): its first
  // action stays `done:`. m-5: `daemon stop` refuses while any channel is live, so the restart waits for that.
  if (input.lobbyError && !record.finalized) {
    suggestedActions.unshift(
      `restart this daemon once no channel is live ("arena daemon stop", then "arena daemon --detach"; until then keep ` +
        `playing, and tell your human if it persists): the host refused a subscribe (${input.lobbyError}) -- new ` +
        "offers/accepts are refused until then",
    );
  }
  if (gasLow) suggestedActions.unshift(sessionGasLowAction(record.channelId, gasLow, input.gasFunding, input.sessionGasLowCause));
  // H1 fix round 1 (review m-2): a skipped block is shown from the record, whatever `lastError` says.
  const skippedNote =
    skippedBlocks.length > 0
      ? `block(s) ${skippedBlocks.join(", ")} hold dispute events for this channel that the RPC refuses to serve, even alone`
      : null;
  if (unseen) {
    const left = chain ? Math.max(0, Number(unseen.deadline - chain.now)) : null;
    suggestedActions.unshift(
      `switch RPC: channel ${record.channelId} is challenged on turn ${unseen.registeredTurn}, newer than this daemon holds ` +
        `(turn ${s.turnNum}), and the challenge's event could not be read${skippedNote ? ` (${skippedNote})` : ""}; unanswered, ` +
        `the current game is forfeited at the deadline (${unseen.deadline}${left !== null ? `, in ${left}s` : ""}). Tell ` +
        "your human now: they (never you) set rpcUrl in config.json to an RPC that serves larger getLogs responses, " +
        "then restart the daemon",
    );
  } else if (skippedNote && live) {
    suggestedActions.push(
      `check the RPC: ${skippedNote}; the daemon skipped them so later events stay readable, and retries them every ` +
        "few minutes. If a challenge's state is in one of them, tell your human: they (never you) set rpcUrl in " +
        "config.json to an RPC that serves larger getLogs responses, then restart the daemon",
    );
  }

  return {
    channelId: record.channelId,
    phase,
    me,
    color,
    orientation: color,
    controller: record.controller,
    note: record.note,
    lastMove: lastMoveOf(snapshot),
    handoff: {
      controller: record.controller,
      note: record.note,
      since: record.handoffAt !== undefined ? new Date(record.handoffAt).toISOString() : null,
    },
    gameIndex: s.gameIndex,
    turnNum: s.turnNum.toString(),
    fen: game.fen(),
    board: game.ascii(),
    legalMoves: myTurn ? game.moves() : [],
    legalMovesUci: myTurn ? legalMoves(s) : [],
    myTurn,
    gameStatus: GAME_STATUS[status] ?? "playing",
    outcome: outcome(s),
    balances: { me: usdc(mine), opponent: usdc(theirs) },
    cooldown,
    newGame,
    closing,
    opponentWantsToClose,
    challenge,
    attention,
    humanAttention,
    suggestedActions,
    lastError: input.lastError,
    lobbyError: input.lobbyError ?? null,
    swept: record.swept ?? null,
    sweptAmount: record.sweptAmount !== undefined ? record.sweptAmount.toString() : null,
    sweptTx: record.sweptTx ?? null,
    sweeps: (record.sweeps ?? []).map((s) => ({ amount: s.amount.toString(), tx: s.tx, at: s.at })),
    transport: input.transport ?? "none",
    xmtpDropped: input.xmtpDropped ?? 0,
    skippedEventBlocks: skippedBlocks,
  };
}
