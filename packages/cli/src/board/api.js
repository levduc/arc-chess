// Plan 5 Task 3: the board's network half -- the JSON API and the /events feed -- plus the small scheduling
// helpers app.js uses to keep request volume bounded. Nothing here touches the DOM, and nothing runs at import
// time, so the pure helpers are unit-tested under vitest (packages/cli/test/board.test.ts).

export class ApiError extends Error {
  /** @param {number} status HTTP status, or 0 when the daemon could not be reached at all */
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * A client for the daemon's local API (packages/cli/src/api.ts). Every request carries the bearer token and
 * `x-arena-actor: human`, so the daemon applies the controller rule for a human (spec §6.2). The token lives only
 * in this closure; it never goes into a URL. `onUnauthorized` runs on any 401 (a stale or wrong link).
 */
export function createClient(token, { onUnauthorized = () => {}, fetchImpl = (...a) => fetch(...a) } = {}) {
  const headers = (json) => ({
    authorization: `Bearer ${token}`,
    "x-arena-actor": "human",
    ...(json ? { "content-type": "application/json" } : {}),
  });

  async function request(method, path, body) {
    let res;
    try {
      res = await fetchImpl(path, {
        method,
        headers: headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        redirect: "error",
      });
    } catch {
      throw new ApiError(0, "Cannot reach the daemon. Is `arena daemon` still running?");
    }
    const text = await res.text().catch(() => "");
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (res.status === 401) onUnauthorized();
    if (!res.ok) {
      const message = payload && typeof payload.error === "string" ? payload.error : `request failed (HTTP ${res.status})`;
      throw new ApiError(res.status, message);
    }
    return payload;
  }

  const post = (path, body) => request("POST", path, body);
  const onChannel = (path) => (channel) => post(path, { channel });

  return {
    channels: () => request("GET", "/channels"),
    status: (channel) => request("GET", `/status?channel=${encodeURIComponent(channel)}`),
    offers: () => request("GET", "/offers"),
    /** Amounts are base-unit decimal strings. No challengeTimeout: the daemon picks its own default. */
    createOffer: (deposit, stakePerGame) => post("/offers", { deposit, stakePerGame }),
    acceptOffer: (offerId) => post("/offers/accept", { offerId }),
    move: (channel, move, offerDraw) => post("/move", { channel, move, offerDraw: offerDraw === true }),
    resign: onChannel("/resign"),
    acceptDraw: onChannel("/accept-draw"),
    nextGame: onChannel("/next-game"),
    close: onChannel("/close"),
    challenge: onChannel("/challenge"),
    handoff: (channel, to, note) => post("/handoff", { channel, to, note }),

    /**
     * Reads GET /events until it ends. Browsers cannot set an Authorization header on EventSource, so this uses
     * fetch() plus a ReadableStream reader instead. `onEvent` gets each dispatched event; `onActivity` runs on
     * every chunk (pings included) so the caller can spot a stalled stream. Resolves when the server ends the
     * stream; rejects with ApiError on a refused connection or a network error.
     */
    async events({ onOpen = () => {}, onEvent = () => {}, onActivity = () => {}, signal } = {}) {
      let res;
      try {
        res = await fetchImpl("/events", { headers: headers(false), cache: "no-store", signal });
      } catch (err) {
        if (signal?.aborted) return;
        throw new ApiError(0, `event stream failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (res.status === 401) onUnauthorized();
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw new ApiError(res.status, `event stream refused (HTTP ${res.status})`);
      }
      onOpen();
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          onActivity();
          const parsed = parseSse(buffer + value);
          buffer = parsed.rest;
          for (const ev of parsed.events) onEvent(ev);
        }
      } catch (err) {
        if (signal?.aborted) return;
        throw new ApiError(0, `event stream broke: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        reader.releaseLock();
      }
    },
  };
}

/**
 * Splits a text/event-stream buffer into complete events plus the unfinished tail. Comment lines (": ping") and
 * data-less blocks ("retry: 3000") dispatch nothing, as in the EventSource spec.
 */
export function parseSse(buffer) {
  const events = [];
  let rest = buffer;
  for (;;) {
    const m = /\r?\n\r?\n/.exec(rest);
    if (!m) break;
    const block = rest.slice(0, m.index);
    rest = rest.slice(m.index + m[0].length);
    let event = "message";
    const data = [];
    for (const raw of block.split(/\r?\n/)) {
      if (raw === "" || raw.startsWith(":")) continue;
      const colon = raw.indexOf(":");
      const field = colon === -1 ? raw : raw.slice(0, colon);
      const value = colon === -1 ? "" : raw.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length > 0) events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}

/**
 * Wraps an async `fn` so at most one call runs at a time and at most one more is queued behind it: triggering
 * while a call is in flight only marks it dirty, and the queued run starts once the current one settles. The
 * returned promise settles when the whole chain is done. Errors go to `onError`, never out of the trigger.
 * @param {() => unknown} fn
 * @param {(err: unknown) => void} [onError]
 * @returns {() => Promise<void>}
 */
export function createCoalescer(fn, onError = () => {}) {
  let chain = null;
  let dirty = false;
  return function trigger() {
    if (chain) {
      dirty = true;
      return chain;
    }
    chain = (async () => {
      do {
        dirty = false;
        try {
          await fn();
        } catch (err) {
          onError(err);
        }
      } while (dirty);
      chain = null;
    })();
    return chain;
  };
}

/**
 * At most one `fn()` per `intervalMs`. `request()` runs now if the interval has passed, else schedules one
 * trailing run for when it does (so the last request is never lost); `now()` runs immediately regardless and
 * restarts the interval (used right after a user action).
 * @param {() => void} fn
 * @param {number} intervalMs
 * @param {{ now?: () => number, setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (t: any) => void }} [clock]
 */
export function createThrottle(fn, intervalMs, clock = globalThis) {
  let last = -Infinity;
  let timer = null;
  const fire = () => {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
    last = clock.now ? clock.now() : Date.now();
    fn();
  };
  const now = () => (clock.now ? clock.now() : Date.now());
  return {
    request() {
      const elapsed = now() - last;
      if (elapsed >= intervalMs) fire();
      else if (timer === null) {
        timer = clock.setTimeout(() => {
          timer = null;
          fire();
        }, intervalMs - elapsed);
      }
    },
    now: fire,
    cancel() {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * De-duplicates background-refresh errors per route (status, channels, offers): `report` is true only when a
 * route's message differs from the last one it reported, and only that route's own success (`clear`) re-arms it.
 * One route recovering must not make another, still-failing route toast again on its next poll.
 */
export function createErrorGate() {
  /** @type {Map<string, string>} */
  const last = new Map();
  return {
    /** @param {string} route @param {string} message */
    report(route, message) {
      if (last.get(route) === message) return false;
      last.set(route, message);
      return true;
    },
    /** @param {string} route */
    clear(route) {
      last.delete(route);
    },
  };
}

/** Reconnect delay for the event stream: 1 s, 2 s, 4 s, ... capped at 30 s. */
export function backoffDelay(attempt) {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
}
