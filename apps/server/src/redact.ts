/**
 * Final review C N-6: text with RPC URLs shown as their scheme and host only. A provider URL can carry an API key in
 * its path or query, and viem quotes a failed request's URL in full in its error messages -- normalized by `new URL`
 * (host lower-cased, a `/` before the query, the username and password stripped), not as it was configured. So both
 * the configured string (in any letter case) and every URL in the text on the same host (and port) are replaced, whatever
 * its scheme. The server
 * runs every startup error and log line through this, and the self-host house bot every line it prints (bot-run.ts).
 */
import type { ServerConfig } from "./config.js";

/** A URL as messages show it: scheme and host, or a placeholder when it does not parse. */
function shownUrl(u: URL | null): string {
  return u === null ? "(the RPC URL)" : `${u.protocol}//${u.host}`;
}

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Anything that starts like an http(s) or ws(s) URL, up to the first character no URL in a message carries. Its host
 *  may be a bracketed IPv6 literal (re-review N-2: `new URL` prints `[0:0:0:0:0:0:0:1]` as `[::1]`). */
const URL_TOKEN_RE = /(?:https?|wss?):\/\/(?:\[[0-9a-f:.]+\]|[^\s"'<>()[\]{}|\\^`/?#]+)[^\s"'<>()[\]{}|\\^`]*/gi;
/** Sentence punctuation a message puts right after a URL, kept in place. */
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

/** `text` with each of `urls` (and every URL in it on the same host and port as one of them) shown as its scheme and
 *  host. */
export function redactUrls(text: string, urls: readonly string[]): string {
  const configured = urls.filter((u) => u !== "");
  let out = text;
  // The configured strings first, longest first, so a URL that is a prefix of another never leaves the rest behind.
  for (const url of [...configured].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(escapeRe(url), "gi"), shownUrl(parse(url)));
  }
  const hosts = new Set<string>();
  for (const url of configured) {
    const u = parse(url);
    if (u !== null) hosts.add(u.host.toLowerCase());
  }
  if (hosts.size === 0) return out;
  return out.replace(URL_TOKEN_RE, (token) => {
    const trailing = TRAILING_PUNCT_RE.exec(token)?.[0] ?? "";
    const u = parse(token.slice(0, token.length - trailing.length));
    return u !== null && hosts.has(u.host.toLowerCase()) ? `${shownUrl(u)}${trailing}` : token;
  });
}

/** `text` with this config's RPC URLs (`rpcUrl`, `publicRpcUrl`) redacted (`redactUrls`). */
export function redactRpcUrls(text: string, cfg: Pick<ServerConfig, "rpcUrl" | "publicRpcUrl">): string {
  return redactUrls(text, [cfg.rpcUrl, cfg.publicRpcUrl]);
}
