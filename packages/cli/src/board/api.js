// @ts-check
// Plan 5 Task 3: the board's network half -- the JSON API and the /events feed -- plus the small scheduling
// helpers app.js uses to keep request volume bounded. Nothing here touches the DOM, and nothing runs at import
// time, so the pure helpers are unit-tested under vitest (packages/cli/test/board.test.ts).

export class ApiError extends Error {
  /** @param {number} status HTTP status, or 0 when the daemon could not be reached at all @param {string} message */
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
 * @param {string} token
 * @param {{ onUnauthorized?: () => void, fetchImpl?: (input: string, init: RequestInit) => Promise<Response> }} [opts]
 */
export function createClient(token, { onUnauthorized = () => {}, fetchImpl = (input, init) => fetch(input, init) } = {}) {
  /** @param {boolean} json @returns {Record<string, string>} */
  const headers = (json) => ({
    authorization: `Bearer ${token}`,
    "x-arena-actor": "human",
    ...(json ? { "content-type": "application/json" } : {}),
  });

  /** @param {string} method @param {string} path @param {unknown} [body] @returns {Promise<any>} */
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

  /** @param {string} path @param {unknown} body */
  const post = (path, body) => request("POST", path, body);
  /** @param {string} path @returns {(channel: string) => Promise<any>} */
  const onChannel = (path) => (channel) => post(path, { channel });

  return {
    channels: () => request("GET", "/channels"),
    /** @param {string} channel */
    status: (channel) => request("GET", `/status?channel=${encodeURIComponent(channel)}`),
    offers: () => request("GET", "/offers"),
    /** Amounts are base-unit decimal strings. No challengeTimeout: the daemon picks its own default.
     *  @param {string} deposit @param {string} stakePerGame */
    createOffer: (deposit, stakePerGame) => post("/offers", { deposit, stakePerGame }),
    /** @param {string} offerId */
    acceptOffer: (offerId) => post("/offers/accept", { offerId }),
    /** @param {string} channel @param {string} move @param {boolean} offerDraw */
    move: (channel, move, offerDraw) => post("/move", { channel, move, offerDraw: offerDraw === true }),
    resign: onChannel("/resign"),
    acceptDraw: onChannel("/accept-draw"),
    nextGame: onChannel("/next-game"),
    close: onChannel("/close"),
    challenge: onChannel("/challenge"),
    /** @param {string} channel @param {"agent" | "human"} to @param {string} note */
    handoff: (channel, to, note) => post("/handoff", { channel, to, note }),

    /**
     * Reads GET /events until it ends. Browsers cannot set an Authorization header on EventSource, so this uses
     * fetch() plus a ReadableStream reader instead. `onEvent` gets each dispatched event; `onActivity` runs on
     * every chunk (pings included) so the caller can spot a stalled stream. Resolves when the server ends the
     * stream; rejects with ApiError on a refused connection or a network error.
     * @param {{
     *   onOpen?: () => void,
     *   onEvent?: (ev: { event: string, data: string }) => void,
     *   onActivity?: () => void,
     *   signal?: AbortSignal,
     * }} [opts]
     */
    async events({ onOpen = () => {}, onEvent = () => {}, onActivity = () => {}, signal } = {}) {
      let res;
      try {
        res = await fetchImpl("/events", { headers: headers(false), cache: "no-store", redirect: "error", signal });
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
 * Final fix wave (M1): trades a board link's one-time code for the bearer token (`POST /board/session`). The code
 * is the only credential this request carries; the token comes back in the JSON body and goes nowhere but the
 * caller's memory. Rejects with ApiError: 401 for a used, expired or unknown code, 429 when rate-limited, 0 when
 * the daemon cannot be reached.
 * @param {string} code
 * @param {(input: string, init: RequestInit) => Promise<Response>} [fetchImpl]
 * @returns {Promise<string>}
 */
export async function exchangeCode(code, fetchImpl = (input, init) => fetch(input, init)) {
  let res;
  try {
    res = await fetchImpl("/board/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new ApiError(0, "Cannot reach the daemon. Is `arena daemon` still running?");
  }
  const payload = /** @type {{ token?: unknown, error?: unknown } | null} */ (await res.json().catch(() => null));
  if (!res.ok || !payload || typeof payload.token !== "string" || payload.token === "") {
    const message = payload && typeof payload.error === "string" ? payload.error : `request failed (HTTP ${res.status})`;
    throw new ApiError(res.ok ? 0 : res.status, message);
  }
  return payload.token;
}

/**
 * Splits a text/event-stream buffer into complete events plus the unfinished tail. Comment lines (": ping") and
 * data-less blocks ("retry: 3000") dispatch nothing, as in the EventSource spec.
 * @param {string} buffer
 * @returns {{ events: Array<{ event: string, data: string }>, rest: string }}
 */
export function parseSse(buffer) {
  /** @type {Array<{ event: string, data: string }>} */
  const events = [];
  let rest = buffer;
  for (;;) {
    const m = /\r?\n\r?\n/.exec(rest);
    if (!m) break;
    const block = rest.slice(0, m.index);
    rest = rest.slice(m.index + m[0].length);
    let event = "message";
    /** @type {string[]} */
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
  /** @type {Promise<void> | null} */
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
  /** @type {unknown} */
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

/**
 * Board rate-limit fix: true for the daemon's answer to a read the RPC rate-limited past its retries -- a 503 worded
 * "the RPC is rate-limiting (…)", or "rate-limited (RPC or host) (…)" (api.ts). Not any 503: "the daemon is stopping"
 * is one too.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRateLimitAnswer(err) {
  return err instanceof ApiError && err.status === 503 && /^(the RPC is rate-limiting|rate-limited \(RPC or host\))/.test(err.message);
}

/**
 * Board rate-limit fix: why a status -- or the first such channel of a `/channels` list -- was answered from the
 * daemon's last chain read (`chainStale`, with `chainStaleReason`), or null when it is fresh. `""` when stale with no
 * reason given. Fix round 1 (m6): with `channelId` (a string, or null for none), only that channel's entry counts --
 * the banner speaks of "your game", the one on the board.
 * @param {unknown} payload a status, a list, or null
 * @param {string | null} [channelId]
 * @returns {string | null}
 */
export function staleReasonOf(payload, channelId) {
  const list = Array.isArray(payload) ? payload : [payload];
  for (const s of list) {
    if (channelId !== undefined && (!s || typeof s !== "object" || /** @type {{ channelId?: unknown }} */ (s).channelId !== channelId)) continue;
    if (s && typeof s === "object" && !("degraded" in s) && /** @type {{ chainStale?: unknown }} */ (s).chainStale === true) {
      const reason = /** @type {{ chainStaleReason?: unknown }} */ (s).chainStaleReason;
      return typeof reason === "string" ? reason : "";
    }
  }
  return null;
}

/**
 * Board rate-limit fix: whether the board's "chain RPC is busy" banner is up, per background read ("status",
 * "channels"). A route raises it when it is answered from the daemon's last chain read (`chainStale`) or with the
 * daemon's rate-limit 503, and only that route's own fresh answer lowers it. A rate-limit 503 is taken here instead
 * of the caller's "Could not refresh" toast (`failed` answers true); any other failure is left to the caller and
 * changes nothing.
 */
export function createChainStaleGate() {
  /** @type {Map<string, string>} */
  const reasons = new Map();
  return {
    /** A successful read of `route`; `channelId` as for `staleReasonOf`.
     *  @param {string} route @param {unknown} payload @param {string | null} [channelId] */
    answered(route, payload, channelId) {
      const reason = staleReasonOf(payload, channelId);
      if (reason === null) reasons.delete(route);
      else reasons.set(route, reason);
    },
    /** A failed read of `route`: true when it was a rate limit, now shown by the banner (the caller shows no toast).
     *  @param {string} route @param {unknown} err @returns {boolean} */
    failed(route, err) {
      if (!isRateLimitAnswer(err)) return false;
      reasons.set(route, /** @type {ApiError} */ (err).message);
      return true;
    },
    active() {
      return reasons.size > 0;
    },
    /** The distinct reasons behind it, for the banner's tooltip. @returns {string[]} */
    reasons() {
      return [...new Set([...reasons.values()].filter((r) => r !== ""))];
    },
  };
}

/**
 * Which user actions are in flight, per key: a channel id, or one key for the lobby. One action at a time per
 * key, but a slow close or challenge on one channel never blocks a forced move on another (nor the lobby).
 */
export function createActionGate() {
  /** @type {Set<string>} */
  const running = new Set();
  return {
    /** @param {string} key @returns {boolean} false if an action with this key is already running */
    tryStart(key) {
      if (running.has(key)) return false;
      running.add(key);
      return true;
    },
    /** @param {string} key */
    finish(key) {
      running.delete(key);
    },
    /** @param {string | null | undefined} key */
    isBusy(key) {
      return key !== null && key !== undefined && running.has(key);
    },
  };
}

/** Reconnect delay for the event stream: 1 s, 2 s, 4 s, ... capped at 30 s.
 *  @param {number} attempt */
export function backoffDelay(attempt) {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
}
