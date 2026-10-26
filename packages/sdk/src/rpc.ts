import { BaseError, HttpRequestError, TimeoutError, http, type HttpTransport, type HttpTransportConfig } from "viem";

/**
 * Plan 6 hardening H3 (rate-limit resilience). Arc's public RPC answers a modest mix of reads with `-32005 "rate limit
 * exceeded"` (viem: `LimitExceededRpcError`, "Request exceeds defined limit.") or an HTTP 429 (Arc testnet rehearsal
 * §8.2), and refuses a query it will not serve at all with `-32012 "requested range too large"` (§8.1). The two must
 * never be confused: a rate limit says nothing about the range, so it is retried as it was; only a refusal may split a
 * range or count toward skipping a block's dispute events (spec §12 item 18).
 */

/** viem's `http` retries a read answered with a rate limit (`-32005`, `-32007`, code or HTTP 429), an HTTP 403, 408,
 *  413 or 5xx, an internal error (`-32603`), a timeout or a network failure. Never a send: `eth_sendRawTransaction`
 *  and `eth_sendTransaction` are issued with `retryCount: 0` by viem itself (`sendRawTransaction.ts`,
 *  `sendTransaction.ts`), so a transport retry can never deliver a transaction twice. */
export const RPC_RETRY_COUNT = 5;
/** Retry `n` (from 0) waits `2^n x RPC_RETRY_DELAY_MS`: 0.5, 1, 2, 4 and 8 s, 15.5 s at most per call in all. */
export const RPC_RETRY_DELAY_MS = 500;
/** viem waits an HTTP 429's `Retry-After` (seconds) instead, as given; capped here, so one call never waits more than
 *  `RPC_RETRY_COUNT x RPC_RETRY_AFTER_MAX_S` = 20 s in all. */
export const RPC_RETRY_AFTER_MAX_S = 4;

type FetchFn = NonNullable<HttpTransportConfig["fetchFn"]>;

/** `fetchFn` with every `Retry-After` over `RPC_RETRY_AFTER_MAX_S` lowered to it; one that is not a number of seconds
 *  (an HTTP date) is dropped, so the exponential back-off applies. */
export function cappedRetryAfter(fetchFn: FetchFn = (input, init) => fetch(input, init)): FetchFn {
  return async (input, init) => {
    const res = await fetchFn(input, init);
    const after = res.headers.get("retry-after");
    if (after === null) return res;
    const seconds = /^\s*\d+\s*$/.test(after) ? Number.parseInt(after, 10) : Number.NaN;
    if (seconds <= RPC_RETRY_AFTER_MAX_S) return res;
    const headers = new Headers(res.headers);
    if (Number.isNaN(seconds)) headers.delete("retry-after");
    else headers.set("retry-after", String(RPC_RETRY_AFTER_MAX_S));
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

/** The HTTP transport every arena RPC client uses: viem's `http`, with the retry budget above. `overrides` are for
 *  tests (a fake `fetchFn`, a short `retryDelay`), and for the daemon's per-attempt `timeout` and `totalTimeoutMs`.
 *
 *  H3 fix round 2 (re-review I-a): with `totalTimeoutMs`, one request -- every attempt and every wait between them --
 *  never takes longer than that. The retries are this transport's own then (the same classes, back-off and
 *  `Retry-After` cap as viem's), because viem's cannot be stopped by a deadline: an attempt still in flight at the
 *  deadline is abandoned (it ends at its own `timeout`), and no retry starts whose wait would end past it. The error
 *  thrown is the last attempt's, so a rate limit stays a rate limit (`isRateLimited`), never a refusal; a request with
 *  no answer at all by the deadline is viem's `TimeoutError`. A send is still attempted exactly once: viem passes
 *  `retryCount: 0` for it, and the send methods are excluded by name as well. */
export function rpcTransport(
  url: string,
  overrides: Pick<HttpTransportConfig, "fetchFn" | "retryCount" | "retryDelay" | "timeout"> & { totalTimeoutMs?: number } = {},
): HttpTransport {
  const retryCount = overrides.retryCount ?? RPC_RETRY_COUNT;
  const retryDelay = overrides.retryDelay ?? RPC_RETRY_DELAY_MS;
  const options = {
    ...(overrides.timeout === undefined ? {} : { timeout: overrides.timeout }),
    fetchFn: cappedRetryAfter(overrides.fetchFn),
  };
  const total = overrides.totalTimeoutMs;
  if (total === undefined) return http(url, { retryCount, retryDelay, ...options });
  const single = http(url, { retryCount: 0, retryDelay, ...options });
  return (params) => {
    const base = single(params);
    const once = (args: Parameters<typeof base.request>[0], opts: Parameters<typeof base.request>[1]) =>
      base.request(args, { ...opts, retryCount: 0 });
    const request = (async (args, opts) => {
      if (opts?.retryCount === 0 || SEND_METHODS.has(args.method)) return once(args, opts);
      const deadline = Date.now() + total;
      let last: unknown;
      for (let count = 0; ; count++) {
        const left = deadline - Date.now();
        const attempt = once(args, opts);
        attempt.catch(() => undefined); // abandoned at the deadline: it ends at its own timeout, unobserved
        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
          attempt.then(
            (value: unknown) => ({ value }),
            (error: unknown) => ({ error }),
          ),
          new Promise<{ late: true }>((resolve) => {
            timer = setTimeout(() => resolve({ late: true }), Math.max(0, left));
          }),
        ]);
        clearTimeout(timer);
        if ("value" in outcome) return outcome.value;
        if ("late" in outcome) throw last ?? new TimeoutError({ body: args as unknown as Record<string, unknown>, url });
        last = outcome.error;
        if (count >= retryCount || !retryable(last)) throw last;
        const wait = retryAfterMs(last) ?? (1 << count) * retryDelay;
        if (Date.now() + wait >= deadline) throw last;
        await new Promise((r) => setTimeout(r, wait));
      }
    }) as typeof base.request;
    // `totalTimeoutMs` shows on the client's `transport`, as `retryCount` and `timeout` do.
    return { ...base, config: { ...base.config, retryCount, retryDelay, totalTimeoutMs: total } as typeof base.config, request };
  };
}

/** The methods that send a transaction: attempted once, whatever the caller asks. */
const SEND_METHODS = new Set(["eth_sendRawTransaction", "eth_sendTransaction", "wallet_sendTransaction", "eth_sendRawTransactionSync"]);

/** viem's own retry classes (`shouldRetry`, `utils/buildRequest.ts`), plus any `isRateLimited` wording. */
function retryable(err: unknown): boolean {
  if (!(err instanceof Error) || err.name === "AbortError") return false;
  if (isRateLimited(err)) return true;
  const code = numberField(err, "code");
  if (code !== undefined) return code === -1 || code === -32005 || code === -32603 || code === 429 || code === -32007;
  if (err instanceof HttpRequestError && err.status) return [403, 408, 413, 429, 500, 502, 503, 504].includes(err.status);
  return true; // a timeout, a network failure
}

/** An HTTP 429's `Retry-After`, in ms, capped at `RPC_RETRY_AFTER_MAX_S`. */
function retryAfterMs(err: unknown): number | undefined {
  for (const e of causes(err)) {
    const after = e instanceof HttpRequestError ? e.headers?.get("retry-after") : null;
    if (after && /^\s*\d+\s*$/.test(after)) return Math.min(Number(after), RPC_RETRY_AFTER_MAX_S) * 1000;
  }
  return undefined;
}

// ------------------------------------------------------------------------------------ classification

/** An error and its causes, outermost first (viem wraps the RPC's own error: `LimitExceededRpcError` around an
 *  `RpcRequestError`, an `HttpRequestError` around a `ResponseBodyTooLargeError`, ...). */
function causes(err: unknown): unknown[] {
  const out: unknown[] = [];
  for (let e = err; e !== undefined && e !== null && out.length < 10; e = (e as { cause?: unknown }).cause) out.push(e);
  return out;
}

const numberField = (e: unknown, k: "code" | "status") => {
  const v = (e as Record<string, unknown> | null)?.[k];
  return typeof v === "number" ? v : undefined;
};

/** What the RPC itself said: a viem error's `details` (the node's own message), else its message (the innermost cause
 *  is the node's raw `{code, message}`). Never viem's full `message`, which also carries the URL and the request
 *  body. */
function textOf(e: unknown): string {
  if (typeof e === "string") return e;
  if (typeof e !== "object" || e === null) return "";
  const v = e as { details?: unknown; shortMessage?: unknown; message?: unknown };
  if (typeof v.details === "string" && v.details !== "") return v.details;
  if (typeof v.shortMessage === "string") return v.shortMessage;
  return typeof v.message === "string" ? v.message : "";
}

/** The RPC's words for a query it will not serve however often it is asked: a block range, a result count or a
 *  response size over its limit (Arc's "requested range too large", Infura's "query returned more than 10000
 *  results", Alchemy's "Log response size exceeded", reth's "query exceeds max block range"/"max results", ...). A
 *  bare "exceeds max" is not one: "request exceeds max requests per second" is a rate limit (H3 review I1). */
const REFUSAL_TEXT =
  /range too large|requested range|block range|too many blocks|exceeds? (the )?max(imum)? (block|range|results?|logs?|response|size)|query returned more than|more than \d+ (results|logs)|max(imum)? results|response size|response (is )?too (big|large)|too many (results|logs)|response body too large/i;

/** The RPC's words for "too many requests": not about the query at all. Checked before any refusal wording. */
const RATE_LIMIT_TEXT =
  /rate.?limit|too many requests|request limit|max(imum)? requests|requests? per|per second|\brps\b|throttl|quota|compute units|capacity/i;

/** True when the RPC is rate-limiting: the words for it anywhere in the cause chain (checked first, so they always
 *  win), an HTTP 429, a JSON-RPC code 429 or `-32007`, or `-32005` (Arc's "rate limit exceeded"; viem's
 *  `LimitExceededRpcError`) unless its words are a refusal (some RPCs use it for "query returned more than 10000
 *  results"). */
export function isRateLimited(err: unknown): boolean {
  const chain = causes(err);
  const texts = chain.map(textOf);
  if (texts.some((t) => RATE_LIMIT_TEXT.test(t))) return true;
  if (chain.some((e) => numberField(e, "status") === 429 || numberField(e, "code") === 429 || numberField(e, "code") === -32007)) {
    return true;
  }
  return chain.some((e) => numberField(e, "code") === -32005) && !texts.some((t) => REFUSAL_TEXT.test(t));
}

/** H3 fix round 1 (review M5, M6): whether a viem error is in the chain -- a failure of the RPC, not of the host. */
export function isRpcError(err: unknown): boolean {
  return causes(err).some((e) => e instanceof BaseError);
}

/** H3 fix round 1 (review M6): the RPC's own answer in a few words, for a message to an agent: `HTTP 429`,
 *  `-32005 "rate limit exceeded"`, else the error's first line. viem's first line alone says nothing for an HTTP 429
 *  ("HTTP request failed."). */
export function rpcErrorSummary(err: unknown): string {
  const chain = causes(err);
  const status = chain.map((e) => numberField(e, "status")).find((v) => v !== undefined);
  if (status !== undefined) return `HTTP ${status}`;
  for (const e of [...chain].reverse()) {
    const code = numberField(e, "code");
    const text = textOf(e);
    if (code !== undefined && code !== -1 && text !== "") return `${code} "${text.split("\n")[0]}"`;
  }
  return err instanceof Error ? err.message.split("\n")[0] : String(err);
}

/**
 * True only for a refusal of the query itself: `-32012` (Arc), viem's own `ResponseBodyTooLargeError`, or the RPC's
 * words for a range, result count or response size over its limit -- and never while it is also rate-limiting. This
 * is the one class of failure that may split a `getLogs` range or count toward skipping a block (spec §12 item 18).
 * Everything else -- a rate limit, a timeout, a 5xx, a network failure, an error this does not know -- is retried on
 * the same range, uncounted: under load the RPC refuses at random, and a skip on that would hide a dispute event.
 */
export function isRangeRefusal(err: unknown): boolean {
  if (isRateLimited(err)) return false;
  for (const e of causes(err)) {
    if (numberField(e, "code") === -32012) return true;
    if (e instanceof Error && e.name === "ResponseBodyTooLargeError") return true;
    if (REFUSAL_TEXT.test(textOf(e))) return true;
  }
  return false;
}
