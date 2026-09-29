/**
 * Plan 4.5 Task 11 regression: `waitStatus` must tolerate a transient "unknown channel" 404 -- seen for real during
 * the soak run, when a status poll on the offerer's daemon landed in the brief window before its `onMatch` handler
 * had created the channel record (an async lobby event, not yet delivered/processed) -- by retrying like a false
 * predicate, but must still fail immediately on any other error (a killed daemon, a 500, ...), since those never
 * resolve themselves and several suites (chaos.test.ts in particular) rely on `waitStatus` failing fast on them.
 *
 * No real stack: `Player.api` is the only surface `waitStatus` touches, so a fake implementing just that is enough.
 */
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type { Player } from "./harness.js";
import { playRandomGameCapped, waitStatus, type Status } from "./bot.js";

function fakePlayer(api: Player["api"]): Player {
  return { name: "fake", home: "", address: "0x0", apiUrl: "", token: "", api, kill: async () => {}, start: async () => {}, logs: () => "", pid: () => undefined };
}

const OPEN: Status = {
  channelId: "0xabc" as `0x${string}`,
  phase: "Open",
  myTurn: true,
  turnNum: "1",
  gameStatus: "playing",
  legalMoves: [],
  attention: null,
};

const UNKNOWN_CHANNEL_ERR = new Error(
  "GET /status?channel=0xf6f41782374cfe4d373c4120440675cc82fa2a9b39cd6ec301310cde6e1efda6 -> 404: unknown channel 0xf6f41782374cfe4d373c4120440675cc82fa2a9b39cd6ec301310cde6e1efda6",
);

describe("waitStatus tolerates the offerer's transient 'unknown channel' race but not real failures", () => {
  it("retries past a few 'unknown channel' 404s and resolves once the record catches up", async () => {
    let calls = 0;
    const player = fakePlayer(async () => {
      calls++;
      if (calls <= 2) throw UNKNOWN_CHANNEL_ERR;
      return OPEN;
    });
    const result = await waitStatus(player, (s) => s.phase === "Open", 5_000, OPEN.channelId);
    expect(result).toEqual(OPEN);
    expect(calls).toBe(3);
  });

  it("fails immediately on any other error (a killed daemon, a 500, ...)", async () => {
    let calls = 0;
    const player = fakePlayer(async () => {
      calls++;
      throw new Error("GET /status -> 500: internal");
    });
    await expect(waitStatus(player, (s) => s.phase === "Open", 5_000)).rejects.toThrow(/500: internal/);
    expect(calls).toBe(1);
  });

  it("times out with both the timeout and the last error when the channel never becomes known", async () => {
    const player = fakePlayer(async () => {
      throw UNKNOWN_CHANNEL_ERR;
    });
    await expect(waitStatus(player, (s) => s.phase === "Open", 250)).rejects.toThrow(/timed out after 250ms.*unknown channel/s);
  });
});

/**
 * Plan 4.5 Task 11 regression: found by the 15-minute soak run -- a game capped at the ply limit stalled for the
 * full `ms` budget instead of finishing, because `playRandomGameCapped`'s capping move (sent with `offerDraw: true`)
 * happened to also be a checkmate. The daemon never computes mate/stalemate at move-application time (a state's
 * status is only ever "playing" or, with the flag, "draw_offered" -- see chess.ts's `normalMove`), but the mated
 * side's own daemon re-evaluates the position on its own tick regardless of that flag and auto-resigns (spec
 * §6.3) -- which can race ahead of any poll ever observing "draw_offered" at all. The old code waited specifically
 * for "draw_offered" and had no other way out, so it looped until the timeout even though the game had already
 * reached a perfectly good terminal state.
 */
describe("playRandomGameCapped resolves a decisive result that races ahead of a forced draw at the ply cap", () => {
  it("returns the decisive status promptly instead of waiting out the timeout for a 'draw_offered' that never appears", async () => {
    const channelId = "0xabc" as Hex;
    const state = { turnNum: "0", whiteTurn: true };
    let whiteGameStatus: Status["gameStatus"] = "playing";
    let blackGameStatus: Status["gameStatus"] = "playing";
    let acceptDrawCalls = 0;
    const statusFor = (color: "white" | "black"): Status => ({
      channelId,
      phase: "Open",
      myTurn: color === "white" ? state.whiteTurn : !state.whiteTurn,
      turnNum: state.turnNum,
      gameStatus: color === "white" ? whiteGameStatus : blackGameStatus,
      legalMoves: ["a2a3"],
      attention: null,
    });
    const white = fakePlayer(async (method, path) => {
      if (method === "GET") return statusFor("white");
      if (method === "POST" && path === "/move") {
        state.turnNum = "1";
        state.whiteTurn = false;
        whiteGameStatus = "draw_offered"; // the mover's own view right after its offerDraw move
        blackGameStatus = "black_won"; // the race: black's daemon auto-resigned, never showing "draw_offered"
        return statusFor("white");
      }
      throw new Error(`unexpected ${method} ${String(path)}`);
    });
    const black = fakePlayer(async (method, path) => {
      if (method === "GET") return statusFor("black");
      if (method === "POST" && path === "/accept-draw") {
        acceptDrawCalls++;
        return statusFor("black");
      }
      throw new Error(`unexpected ${method} ${String(path)}`);
    });

    const started = Date.now();
    const result = await playRandomGameCapped(white, black, { channelId, maxMoves: 1, ms: 5_000 });
    expect(result.gameStatus).toBe("black_won");
    expect(acceptDrawCalls).toBe(0); // already decisive: no draw to accept
    expect(Date.now() - started).toBeLessThan(1_000); // must not have waited out the ms budget
  });
});
