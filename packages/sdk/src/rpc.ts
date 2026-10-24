import { http, type HttpTransport, type HttpTransportConfig } from "viem";

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
 *  tests (a fake `fetchFn`, a short `retryDelay`). */
export function rpcTransport(
  url: string,
  overrides: Pick<HttpTransportConfig, "fetchFn" | "retryCount" | "retryDelay" | "timeout"> = {},
): HttpTransport {
  return http(url, {
    retryCount: overrides.retryCount ?? RPC_RETRY_COUNT,
    retryDelay: overrides.retryDelay ?? RPC_RETRY_DELAY_MS,
    ...(overrides.timeout === undefined ? {} : { timeout: overrides.timeout }),
    fetchFn: cappedRetryAfter(overrides.fetchFn),
  });
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
 *  results", Alchemy's "Log response size exceeded", reth's "query exceeds max block range"/"max results", ...). */
const REFUSAL_TEXT =
  /range too large|requested range|block range|too many blocks|exceeds? (the )?max(imum)?\b|query returned more than|more than \d+ (results|logs)|max(imum)? results|response size|response (is )?too (big|large)|too many (results|logs)|response body too large/i;

/** The RPC's words for "too many requests": not about the query at all. */
const RATE_LIMIT_TEXT = /rate.?limit|too many requests|request limit|throttl|exceeded .*(per second|quota|capacity|compute units)/i;

/** True when the RPC is rate-limiting: `-32005` (Arc's "rate limit exceeded"; viem's `LimitExceededRpcError`) unless
 *  its words are a refusal (some RPCs use it for "query returned more than 10000 results"), `-32007`, a JSON-RPC
 *  code 429, an HTTP 429, or a message saying so. */
export function isRateLimited(err: unknown): boolean {
  const chain = causes(err);
  const refusalWords = chain.some((e) => REFUSAL_TEXT.test(textOf(e)));
  for (const e of chain) {
    const code = numberField(e, "code");
    if (numberField(e, "status") === 429 || code === 429 || code === -32007) return true;
    if (code === -32005 && !refusalWords) return true;
    if (RATE_LIMIT_TEXT.test(textOf(e))) return true;
  }
  return false;
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
