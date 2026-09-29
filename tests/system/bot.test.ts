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
import type { Player } from "./harness.js";
import { waitStatus, type Status } from "./bot.js";

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
