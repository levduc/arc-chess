import { describe, expect, it, vi } from "vitest";
import {
  actionState,
  baseUnitsToUsdc,
  boardView,
  canMove,
  channelBanners,
  channelChip,
  checkSquare,
  clickSquare,
  formatCountdown,
  formatDuration,
  formatUsdc,
  indexOfSquare,
  isPromotion,
  lastMoveSquares,
  movesBetween,
  normalizeNote,
  noteError,
  pickDefaultChannel,
  planKeyedList,
  piecesFromFen,
  secondsUntil,
  shortHex,
  sideToMove,
  squareAt,
  squareLabel,
  syncDeadline,
  stepSquare,
  targetsFrom,
  usdcToBaseUnits,
} from "../src/board/board.js";
import { backoffDelay, createCoalescer, createErrorGate, createThrottle, parseSse } from "../src/board/api.js";

// Plan 5 Task 3: the web board's pure helpers (no DOM, no fetch) -- see packages/cli/src/board/board.js.

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** A minimal ChannelStatus-shaped object; each test overrides what it exercises. */
function status(over: Record<string, unknown> = {}): any {
  return {
    channelId: `0x${"ab".repeat(32)}`,
    phase: "Open",
    me: 0,
    color: "white",
    orientation: "white",
    controller: "human",
    note: "",
    handoff: { controller: "human", note: "", since: null },
    lastMove: null,
    gameIndex: 0,
    turnNum: "0",
    fen: START,
    legalMoves: [],
    legalMovesUci: [],
    myTurn: false,
    gameStatus: "playing",
    outcome: "none",
    balances: { me: "1.000000", opponent: "1.000000" },
    cooldown: { meSeconds: 0, opponentSeconds: 0 },
    newGame: "none",
    closing: false,
    opponentWantsToClose: false,
    challenge: null,
    attention: null,
    suggestedActions: [],
    lastError: null,
    lobbyError: null,
    swept: null,
    ...over,
  };
}

describe("orientation index math", () => {
  it("white sees a8 top-left and h1 bottom-right", () => {
    expect(squareAt(0, "white")).toBe("a8");
    expect(squareAt(7, "white")).toBe("h8");
    expect(squareAt(56, "white")).toBe("a1");
    expect(squareAt(63, "white")).toBe("h1");
  });

  it("black sees h1 top-left and a8 bottom-right", () => {
    expect(squareAt(0, "black")).toBe("h1");
    expect(squareAt(7, "black")).toBe("a1");
    expect(squareAt(56, "black")).toBe("h8");
    expect(squareAt(63, "black")).toBe("a8");
  });

  it("indexOfSquare inverts squareAt for both orientations", () => {
    for (const o of ["white", "black"] as const) {
      for (let i = 0; i < 64; i++) expect(indexOfSquare(squareAt(i, o), o)).toBe(i);
    }
    expect(indexOfSquare("e4", "white")).toBe(36);
    expect(indexOfSquare("e4", "black")).toBe(27);
  });

  it("arrow keys step in screen space, so black's ArrowUp goes toward rank 1", () => {
    expect(stepSquare("e4", "ArrowUp", "white")).toBe("e5");
    expect(stepSquare("e4", "ArrowRight", "white")).toBe("f4");
    expect(stepSquare("e4", "ArrowUp", "black")).toBe("e3");
    expect(stepSquare("e4", "ArrowRight", "black")).toBe("d4");
    // clamped at the edges, never wrapping
    expect(stepSquare("a8", "ArrowUp", "white")).toBe("a8");
    expect(stepSquare("a8", "ArrowLeft", "white")).toBe("a8");
    expect(stepSquare("h1", "ArrowUp", "black")).toBe("h1"); // h1 is black's top-left corner
    expect(stepSquare("e4", "Home", "white")).toBe("a4");
    expect(stepSquare("e4", "End", "white")).toBe("h4");
    expect(stepSquare("e4", "Tab", "white")).toBe("e4");
  });
});

describe("FEN helpers", () => {
  it("places every piece of the start position by square", () => {
    const p = piecesFromFen(START);
    expect(p.e1).toBe("K");
    expect(p.d8).toBe("q");
    expect(p.a2).toBe("P");
    expect(p.h7).toBe("p");
    expect(p.e4).toBeUndefined();
    expect(Object.keys(p)).toHaveLength(32);
  });

  it("handles gaps mid-rank and a malformed FEN without throwing", () => {
    const p = piecesFromFen("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
    expect(p.e8).toBe("k");
    expect(p.d5).toBe("p");
    expect(p.e5).toBe("P");
    expect(Object.keys(p)).toHaveLength(4);
    expect(piecesFromFen("")).toEqual({});
    expect(piecesFromFen("garbage")).toEqual({});
    expect(piecesFromFen(undefined as unknown as string)).toEqual({});
  });

  it("reads the side to move", () => {
    expect(sideToMove(START)).toBe("white");
    expect(sideToMove("4k3/8/8/8/8/8/8/4K3 b - - 0 1")).toBe("black");
  });
});

describe("uci-to-target mapping", () => {
  const moves = ["e2e4", "e2e3", "g1f3", "g1h3", "b1c3", "b1a3"];

  it("lists the distinct targets of one origin square", () => {
    expect(targetsFrom(moves, "e2").sort()).toEqual(["e3", "e4"]);
    expect(targetsFrom(moves, "g1").sort()).toEqual(["f3", "h3"]);
    expect(targetsFrom(moves, "e7")).toEqual([]);
    expect(targetsFrom([], "e2")).toEqual([]);
  });

  it("collapses the four promotion moves to one target square", () => {
    const promo = ["e7e8q", "e7e8r", "e7e8b", "e7e8n", "e7d8q", "e7d8r", "e7d8b", "e7d8n"];
    expect(targetsFrom(promo, "e7").sort()).toEqual(["d8", "e8"]);
    expect(movesBetween(promo, "e7", "e8")).toEqual(["e7e8q", "e7e8r", "e7e8b", "e7e8n"]);
    expect(movesBetween(moves, "e2", "e4")).toEqual(["e2e4"]);
    expect(movesBetween(moves, "e2", "e5")).toEqual([]);
  });
});

describe("promotion detection", () => {
  it("is true only for a from/to pair whose legal moves carry a promotion letter", () => {
    const moves = ["e7e8q", "e7e8r", "e7e8b", "e7e8n", "a2a3"];
    expect(isPromotion(moves, "e7", "e8")).toBe(true);
    expect(isPromotion(moves, "a2", "a3")).toBe(false);
    expect(isPromotion(moves, "e7", "e6")).toBe(false);
  });
});

describe("lastMove squares", () => {
  it("returns [from, to] for a move and [] for none", () => {
    expect(lastMoveSquares({ from: "e2", to: "e4", san: "e4" })).toEqual(["e2", "e4"]);
    expect(lastMoveSquares(null)).toEqual([]);
    expect(lastMoveSquares(undefined)).toEqual([]);
  });

  it("finds the king in check from the last move's SAN", () => {
    // 1. f3 e5 2. g4 Qh4# -- white to move, in check(mate)
    const fen = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
    expect(checkSquare(status({ fen, lastMove: { from: "d8", to: "h4", san: "Qh4#" } }))).toBe("e1");
    expect(checkSquare(status({ fen, lastMove: { from: "d8", to: "h4", san: "Qh4" } }))).toBeNull();
    expect(checkSquare(status({ lastMove: null }))).toBeNull();
  });
});

describe("square labels", () => {
  it("names the square and the piece on it", () => {
    expect(squareLabel("e4", "P")).toBe("e4 white pawn");
    expect(squareLabel("g8", "n")).toBe("g8 black knight");
    expect(squareLabel("d5", "")).toBe("d5 empty");
    expect(squareLabel("e1", "K", ["in check"])).toBe("e1 white king, in check");
  });
});

describe("move gating", () => {
  it("allows moves only for a human controller on my turn with legal moves", () => {
    const mine = { myTurn: true, legalMovesUci: ["e2e4"] };
    expect(canMove(status(mine))).toBe(true);
    expect(canMove(status({ ...mine, controller: "agent" }))).toBe(false);
    expect(canMove(status({ ...mine, myTurn: false }))).toBe(false);
    expect(canMove(status({ ...mine, legalMovesUci: [] }))).toBe(false);
    expect(canMove(status({ ...mine, phase: "Finalized" }))).toBe(false);
    expect(canMove(status({ ...mine, phase: "Challenged" }))).toBe(true);
    expect(canMove(null)).toBe(false);
  });

  it("enables each action from suggestedActions, only for a human controller", () => {
    const s = status({
      myTurn: true,
      legalMovesUci: ["e2e4"],
      suggestedActions: ["arena move <move>   (one of: e4)", "arena move <move> --offer-draw", "arena resign", "arena accept-draw"],
    });
    const a = actionState(s);
    expect(a).toMatchObject({ move: true, offerDraw: true, resign: true, acceptDraw: true, nextGame: false, close: false });
    expect(a.handBack).toBe(true);
    expect(a.takeOver).toBe(false);
    const agent = actionState({ ...s, controller: "agent" });
    expect(agent).toMatchObject({ move: false, offerDraw: false, resign: false, acceptDraw: false, takeOver: true, handBack: false });
  });

  it("enables next-game and close between games, and challenge only with no cooldown", () => {
    const over = status({ gameStatus: "white_won", suggestedActions: ["arena next-game", "arena close"] });
    expect(actionState(over)).toMatchObject({ nextGame: true, close: true, resign: false, challenge: false });
    const silent = status({ suggestedActions: ["arena challenge   (the opponent has made no progress)", "arena wait"] });
    expect(actionState(silent).challenge).toBe(true);
    expect(actionState({ ...silent, cooldown: { meSeconds: 30, opponentSeconds: 0 } }).challenge).toBe(false);
    // "arena close" must not match some longer command that merely starts with it
    expect(actionState(status({ suggestedActions: ["arena closeout"] })).close).toBe(false);
  });

  it("offers neither take-over nor hand-back once the channel is settled", () => {
    const settled = actionState(status({ phase: "Finalized", controller: "agent" }));
    expect(settled.takeOver).toBe(false);
    expect(settled.handBack).toBe(false);
  });
});

describe("click intents", () => {
  const s = status({ myTurn: true, legalMovesUci: ["e2e4", "e2e3", "g1f3", "e7e8q", "e7e8r", "e7e8b", "e7e8n"] });

  it("selects a movable piece, moves to a target, and deselects on a second click", () => {
    expect(clickSquare(s, { selected: null }, "e2")).toEqual({ selected: "e2", intent: null });
    expect(clickSquare(s, { selected: "e2" }, "e4")).toEqual({ selected: null, intent: { type: "move", uci: "e2e4" } });
    expect(clickSquare(s, { selected: "e2" }, "e2")).toEqual({ selected: null, intent: null });
    expect(clickSquare(s, { selected: "e2" }, "g1")).toEqual({ selected: "g1", intent: null });
    expect(clickSquare(s, { selected: "e2" }, "h5")).toEqual({ selected: null, intent: null });
    expect(clickSquare(s, { selected: null }, "d4")).toEqual({ selected: null, intent: null });
  });

  it("asks for a promotion piece instead of moving", () => {
    expect(clickSquare(s, { selected: "e7" }, "e8")).toEqual({
      selected: "e7",
      intent: { type: "promote", from: "e7", to: "e8", choices: ["q", "r", "b", "n"] },
    });
  });

  it("does nothing while the agent is in control", () => {
    expect(clickSquare({ ...s, controller: "agent" }, { selected: null }, "e2")).toEqual({ selected: null, intent: null });
  });
});

describe("boardView", () => {
  it("lays out 64 squares in display order with pieces, colours, and coordinates", () => {
    const v = boardView(status(), { selected: null });
    expect(v).toHaveLength(64);
    expect(v[0]).toMatchObject({ square: "a8", piece: "r", dark: false, rankLabel: "8", fileLabel: "" });
    expect(v[56]).toMatchObject({ square: "a1", piece: "R", dark: true, rankLabel: "1", fileLabel: "a" });
    expect(v[63]).toMatchObject({ square: "h1", dark: false, fileLabel: "h", rankLabel: "" });
    const black = boardView(status({ orientation: "black" }), { selected: null });
    expect(black[0]).toMatchObject({ square: "h1", rankLabel: "1" });
    expect(black[63]).toMatchObject({ square: "a8", fileLabel: "a" });
  });

  it("marks the last move, the selection, legal targets and captures", () => {
    const fen = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2";
    const s = status({ fen, myTurn: true, legalMovesUci: ["e4e5", "e4d5"], lastMove: { from: "d7", to: "d5", san: "d5" } });
    const v = boardView(s, { selected: "e4" });
    const at = (sq: string) => v.find((x: any) => x.square === sq)!;
    expect(at("d7").lastMove).toBe(true);
    expect(at("d5").lastMove).toBe(true);
    expect(at("e4").selected).toBe(true);
    expect(at("e4").movable).toBe(true);
    expect(at("e5")).toMatchObject({ target: true, capture: false });
    expect(at("d5")).toMatchObject({ target: true, capture: true });
    expect(at("e5").label).toBe("e5 empty, legal move");
    expect(at("d4").target).toBe(false);
  });

  it("drops a stale selection that has no legal moves (e.g. after the agent takes over)", () => {
    const v = boardView(status({ controller: "agent", myTurn: true, legalMovesUci: ["e2e4"] }), { selected: "e2" });
    expect(v.some((x: any) => x.selected || x.target || x.movable)).toBe(false);
  });
});

describe("channel list chips and banners", () => {
  it("maps each status to one chip", () => {
    expect(channelChip(status({ myTurn: true })).kind).toBe("your-turn");
    expect(channelChip(status()).kind).toBe("waiting");
    expect(channelChip(status({ phase: "Challenged" })).kind).toBe("challenged");
    expect(channelChip(status({ phase: "Finalized" })).kind).toBe("settled");
    expect(channelChip(status({ phase: "Reclaimed" })).kind).toBe("settled");
    expect(channelChip(status({ phase: "Funding" })).kind).toBe("funding");
    expect(channelChip(status({ gameStatus: "draw" })).kind).toBe("game-over");
    expect(channelChip({ channelId: "0x1", degraded: true, error: "x" }).kind).toBe("degraded");
  });

  it("raises gas-low, opponent-silent, and must-move banners", () => {
    expect(channelBanners(status())).toEqual([]);
    expect(channelBanners(status({ attention: "session-gas-low" })).map((b: any) => b.kind)).toEqual(["session-gas-low"]);
    expect(channelBanners(status({ attention: "opponent-silent" })).map((b: any) => b.kind)).toEqual(["opponent-silent"]);
    const must = status({ phase: "Challenged", challenge: { deadline: "1", secondsLeft: 60, mustMove: true, challenger: "opponent" } });
    expect(channelBanners(must).map((b: any) => b.kind)).toEqual(["must-move"]);
  });

  it("picks the most urgent channel to select first", () => {
    const a = status({ channelId: "0xa" });
    const b = status({ channelId: "0xb", myTurn: true });
    const c = status({ channelId: "0xc", phase: "Challenged", challenge: { mustMove: true, secondsLeft: 9 } });
    const d = status({ channelId: "0xd", phase: "Finalized" });
    expect(pickDefaultChannel([a, b, c, d])).toBe("0xc");
    expect(pickDefaultChannel([a, b, d])).toBe("0xb");
    expect(pickDefaultChannel([d, a])).toBe("0xa");
    expect(pickDefaultChannel([{ channelId: "0xe", degraded: true, error: "x" }, d])).toBe("0xd");
    expect(pickDefaultChannel([])).toBeNull();
  });
});

describe("formatting", () => {
  it("trims USDC amounts to at least two decimals", () => {
    expect(formatUsdc("0.900000")).toBe("0.90");
    expect(formatUsdc("12.000000")).toBe("12.00");
    expect(formatUsdc("1.234500")).toBe("1.2345");
    expect(formatUsdc("0.000001")).toBe("0.000001");
    expect(formatUsdc("weird")).toBe("weird");
  });

  it("converts base units to USDC and back", () => {
    expect(baseUnitsToUsdc("1500000")).toBe("1.50");
    expect(baseUnitsToUsdc("1")).toBe("0.000001");
    expect(baseUnitsToUsdc("0")).toBe("0.00");
    expect(usdcToBaseUnits("1.5")).toBe("1500000");
    expect(usdcToBaseUnits(" 2 ")).toBe("2000000");
    expect(usdcToBaseUnits("0.000001")).toBe("1");
    expect(usdcToBaseUnits(".25")).toBe("250000");
    for (const bad of ["", "-1", "1.0000001", "abc", "1e6", "1,5", "1.2.3"]) {
      expect(() => usdcToBaseUnits(bad)).toThrow();
    }
  });

  it("formats a countdown and ticks it down locally", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(65)).toBe("1:05");
    expect(formatCountdown(3725)).toBe("1:02:05");
    expect(formatCountdown(-5)).toBe("0:00");
    const d = syncDeadline(null, { deadline: "5000", secondsLeft: 100 }, 1_000);
    expect(d).toEqual({ deadline: "5000", endsAt: 101_000 });
    expect(secondsUntil(d!.endsAt, 1_000)).toBe(100);
    expect(secondsUntil(d!.endsAt, 1_500)).toBe(100);
    expect(secondsUntil(d!.endsAt, 3_000)).toBe(98);
    expect(secondsUntil(d!.endsAt, 500_000)).toBe(0);
    expect(syncDeadline(d, null, 2_000)).toBeNull();
  });

  it("re-syncs the countdown on each status without ever jumping back up for the same deadline", () => {
    const d0 = syncDeadline(null, { deadline: "5000", secondsLeft: 900 }, 0);
    // A chain clock that stands still (a local chain with no new blocks) keeps reporting 900 s: the local tick wins.
    const d1 = syncDeadline(d0, { deadline: "5000", secondsLeft: 900 }, 10_000);
    expect(secondsUntil(d1!.endsAt, 10_000)).toBe(890);
    // A status that says less time is left than the local estimate pulls the countdown down.
    const d2 = syncDeadline(d1, { deadline: "5000", secondsLeft: 850 }, 20_000);
    expect(secondsUntil(d2!.endsAt, 20_000)).toBe(850);
    // A new challenge (another deadline) starts over.
    const d3 = syncDeadline(d2, { deadline: "9000", secondsLeft: 600 }, 30_000);
    expect(secondsUntil(d3!.endsAt, 30_000)).toBe(600);
  });

  it("formats durations and ids", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration("1800")).toBe("30 min");
    expect(formatDuration(5400)).toBe("1 h 30 min");
    expect(formatDuration(3600)).toBe("1 h");
    expect(shortHex(`0x${"12".repeat(32)}`)).toBe("0x1212…1212");
    expect(shortHex("0xabc")).toBe("0xabc");
  });
});

describe("handoff note checks", () => {
  it("normalizes CRLF and mirrors the daemon's length and character rules", () => {
    expect(normalizeNote("a\r\nb")).toBe("a\nb");
    expect(noteError("fine\n\ttext")).toBeNull();
    expect(noteError("x".repeat(1024))).toBeNull();
    expect(noteError("x".repeat(1025))).toMatch(/1024/);
    expect(noteError("bell\u0007")).toMatch(/control/);
    expect(noteError("bidi‮override")).toMatch(/control/);
    expect(noteError("lone\rcr")).toMatch(/control/);
  });
});

describe("api.js helpers", () => {
  it("parses SSE blocks, keeps a partial block, and skips comments and data-less blocks", () => {
    const { events, rest } = parseSse('retry: 3000\n\n: ping\n\nevent: change\ndata: {"channelId":null}\n\nevent: cha');
    expect(events).toEqual([{ event: "change", data: '{"channelId":null}' }]);
    expect(rest).toBe("event: cha");
    const more = parseSse(`${rest}nge\ndata: 1\ndata: 2\n\n`);
    expect(more.events).toEqual([{ event: "change", data: "1\n2" }]);
    expect(more.rest).toBe("");
    expect(parseSse("data: x\r\n\r\n").events).toEqual([{ event: "message", data: "x" }]);
  });

  it("coalesces: one call in flight and at most one queued", async () => {
    let calls = 0;
    const gates: Array<() => void> = [];
    const run = createCoalescer(() => {
      calls++;
      return new Promise<void>((r) => gates.push(r));
    });
    const first = run();
    run();
    run();
    run();
    expect(calls).toBe(1);
    gates.shift()!();
    await vi.waitFor(() => expect(calls).toBe(2));
    gates.shift()!();
    await first;
    expect(calls).toBe(2);
  });

  it("keeps coalescing after a failed call", async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const run = createCoalescer(
      async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
      },
      (e: unknown) => errors.push(e),
    );
    await run();
    await run();
    expect(calls).toBe(2);
    expect(errors).toHaveLength(1);
  });

  it("throttles to one call per interval, trailing edge, with an immediate override", () => {
    let t = 0;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const clock = {
      now: () => t,
      setTimeout: (fn: () => void, ms: number) => {
        const timer = { at: t + ms, fn };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer: unknown) => {
        const i = timers.indexOf(timer as never);
        if (i >= 0) timers.splice(i, 1);
      },
    };
    let calls = 0;
    const th = createThrottle(() => void calls++, 10_000, clock);
    th.request();
    expect(calls).toBe(1);
    t = 2_000;
    th.request();
    th.request();
    expect(calls).toBe(1);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.at).toBe(10_000);
    t = 10_000;
    timers.shift()!.fn();
    expect(calls).toBe(2);
    t = 11_000;
    th.request();
    expect(timers).toHaveLength(1);
    th.now();
    expect(calls).toBe(3);
    expect(timers).toHaveLength(0);
  });

  it("gates background errors per route: one toast per new message, re-armed only by that route's success", () => {
    const gate = createErrorGate();
    expect(gate.report("status", "boom")).toBe(true);
    expect(gate.report("status", "boom")).toBe(false);
    expect(gate.report("channels", "boom")).toBe(true);
    // Another route's success does not re-arm this one.
    gate.clear("channels");
    expect(gate.report("status", "boom")).toBe(false);
    expect(gate.report("status", "worse")).toBe(true);
    gate.clear("status");
    expect(gate.report("status", "worse")).toBe(true);
  });

  it("backs off exponentially up to a cap", () => {
    expect(backoffDelay(0)).toBe(1_000);
    expect(backoffDelay(1)).toBe(2_000);
    expect(backoffDelay(4)).toBe(16_000);
    expect(backoffDelay(10)).toBe(30_000);
  });
});

/** Applies a planKeyedList() plan to a plain array, the way app.js applies it to a container's children. */
function applyPlan(current: string[], plan: { remove: string[]; create: string[]; moves: Array<{ key: string; before: string | null }> }) {
  const dom = current.filter((k) => !plan.remove.includes(k));
  for (const { key, before } of plan.moves) {
    const at = dom.indexOf(key);
    if (at >= 0) dom.splice(at, 1);
    dom.splice(before === null ? dom.length : dom.indexOf(before), 0, key);
  }
  return dom;
}

describe("keyed list reconciliation", () => {
  it("touches nothing when the keys and their order are unchanged", () => {
    expect(planKeyedList(["a", "b", "c"], ["a", "b", "c"])).toEqual({ remove: [], create: [], moves: [] });
    expect(planKeyedList([], [])).toEqual({ remove: [], create: [], moves: [] });
  });

  it("creates new keys and removes gone ones without moving the rest", () => {
    const plan = planKeyedList(["a", "b", "c"], ["a", "c", "d"]);
    expect(plan.remove).toEqual(["b"]);
    expect(plan.create).toEqual(["d"]);
    expect(plan.moves).toEqual([{ key: "d", before: null }]);
    expect(applyPlan(["a", "b", "c"], plan)).toEqual(["a", "c", "d"]);
  });

  it("inserts at the front and moves only what is out of place", () => {
    const front = planKeyedList(["a", "b"], ["z", "a", "b"]);
    expect(front.moves).toEqual([{ key: "z", before: "a" }]);
    expect(applyPlan(["a", "b"], front)).toEqual(["z", "a", "b"]);
    const swap = planKeyedList(["a", "b", "c"], ["b", "a", "c"]);
    expect(swap.moves).toHaveLength(1);
    expect(applyPlan(["a", "b", "c"], swap)).toEqual(["b", "a", "c"]);
  });

  it("always converges to the target order", () => {
    const cases: Array<[string[], string[]]> = [
      [["a", "b", "c", "d"], ["d", "c", "b", "a"]],
      [["a", "b", "c"], []],
      [[], ["x", "y"]],
      [["a", "b", "c", "d", "e"], ["e", "a", "x", "c", "b"]],
    ];
    for (const [from, to] of cases) expect(applyPlan(from, planKeyedList(from, to))).toEqual(to);
  });

  it("ignores duplicate target keys after the first", () => {
    expect(applyPlan(["a"], planKeyedList(["a"], ["a", "b", "a"]))).toEqual(["a", "b"]);
  });
});
