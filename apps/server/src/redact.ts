/**
 * Final review C N-6: text with RPC URLs shown as their scheme and host only. A provider URL can carry an API key in
 * its path or query, and viem quotes a failed request's URL in full in its error messages -- normalized by `new URL`
 * (host lower-cased, a `/` before the query, the username and password stripped), not as it was configured. So both
 * the configured string (in any letter case) and every URL in the text with the same origin are replaced. The server
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

/** Anything that starts like an http(s) URL, up to the first character no URL in a message carries. */
const URL_TOKEN_RE = /https?:\/\/[^\s"'<>()[\]{}|\\^`]+/gi;
/** Sentence punctuation a message puts right after a URL, kept in place. */
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

/** `text` with each of `urls` (and every URL in it on the same origin as one of them) shown as its scheme and host. */
export function redactUrls(text: string, urls: readonly string[]): string {
  const configured = urls.filter((u) => u !== "");
  let out = text;
  // The configured strings first, longest first, so a URL that is a prefix of another never leaves the rest behind.
  for (const url of [...configured].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(escapeRe(url), "gi"), shownUrl(parse(url)));
  }
  const byOrigin = new Map<string, string>();
  for (const url of configured) {
    const u = parse(url);
    if (u !== null) byOrigin.set(u.origin.toLowerCase(), shownUrl(u));
  }
  if (byOrigin.size === 0) return out;
  return out.replace(URL_TOKEN_RE, (token) => {
    const trailing = TRAILING_PUNCT_RE.exec(token)?.[0] ?? "";
    const bare = token.slice(0, token.length - trailing.length);
    const u = parse(bare);
    const shown = u === null ? undefined : byOrigin.get(u.origin.toLowerCase());
    return shown === undefined ? token : `${shown}${trailing}`;
  });
}

/** `text` with this config's RPC URLs (`rpcUrl`, `publicRpcUrl`) redacted (`redactUrls`). */
export function redactRpcUrls(text: string, cfg: Pick<ServerConfig, "rpcUrl" | "publicRpcUrl">): string {
  return redactUrls(text, [cfg.rpcUrl, cfg.publicRpcUrl]);
}
