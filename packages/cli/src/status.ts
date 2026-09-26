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
  cooldown: { meSeconds: number; opponentSeconds: number };
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
  const cooldown = chain
    ? {
        meSeconds: Math.max(0, Number(chain.cooldownUntil[me] - chain.now)),
        opponentSeconds: Math.max(0, Number(chain.cooldownUntil[opponent] - chain.now)),
      }
    : { meSeconds: 0, opponentSeconds: 0 };
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
    cooldown,
    newGame,
    closing,
    opponentWantsToClose,
    challenge,
    attention,
    suggestedActions,
    lastError: input.lastError,
  };
}
