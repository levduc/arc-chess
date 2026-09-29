import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";
import { DaemonError, type Actor, type ArenaDaemon } from "./daemon.js";

function send(res: ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new DaemonError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new DaemonError(400, "body must be a JSON object");
  }
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
function amount(v: unknown, name: string): bigint {
  if (typeof v !== "string" || !/^[0-9]+$/.test(v)) throw new DaemonError(400, `${name} must be a decimal string of base units`);
  return BigInt(v);
}

export async function startApi(
  daemon: ArenaDaemon,
  opts: { port: number; token: string; host?: string },
): Promise<{ server: Server; url: string }> {
  const host = opts.host ?? "127.0.0.1";
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${host}`);
        const route = `${req.method} ${url.pathname}`;
        if (route === "GET /health") return send(res, 200, { ok: true });
        if (!authorized(req, opts.token)) return send(res, 401, { error: "missing or invalid token" });
        const actor: Actor = req.headers["x-arena-actor"] === "human" ? "human" : "agent";
        const q = url.searchParams;
        const b = req.method === "POST" ? await body(req) : {};
        const ch = str(b.channel) ?? str(q.get("channel") ?? undefined);
        switch (route) {
          case "GET /channels":
            return send(res, 200, await daemon.channels());
          case "GET /status":
            return send(res, 200, await daemon.status(ch));
          case "GET /wait": {
            const seconds = Math.min(600, Math.max(0, Number(q.get("timeout") ?? "60") || 0));
            return send(res, 200, await daemon.wait({ ref: ch, timeoutMs: seconds * 1000 }));
          }
          case "GET /offers":
            return send(res, 200, await daemon.listOffers());
          case "POST /offers":
            return send(
              res,
              200,
              // Plan 5 Task 1: an omitted challengeTimeout is left undefined -- createOffer defaults it to this
              // daemon's own minChallengeTimeoutOf(config), not a value fixed here.
              await daemon.createOffer({
                deposit: amount(b.deposit, "deposit"),
                stakePerGame: amount(b.stakePerGame, "stakePerGame"),
                ...(b.challengeTimeout === undefined ? {} : { challengeTimeout: amount(b.challengeTimeout, "challengeTimeout") }),
              }),
            );
          case "POST /offers/accept": {
            const id = str(b.offerId);
            if (!id) throw new DaemonError(400, "offerId is required");
            await daemon.acceptOffer(id as Hex);
            return send(res, 200, { accepted: id });
          }
          case "POST /move": {
            const m = str(b.move);
            if (!m) throw new DaemonError(400, "move is required");
            await daemon.move(ch, m, { offerDraw: b.offerDraw === true, actor });
            return send(res, 200, await daemon.status(ch));
          }
          case "POST /resign":
            await daemon.resign(ch, actor);
            return send(res, 200, await daemon.status(ch));
          case "POST /accept-draw":
            await daemon.acceptDraw(ch, actor);
            return send(res, 200, await daemon.status(ch));
          case "POST /next-game":
            await daemon.nextGame(ch, actor);
            return send(res, 200, await daemon.status(ch));
          case "POST /close":
            await daemon.close(ch, actor);
            return send(res, 200, await daemon.status(ch));
          case "POST /challenge":
            await daemon.challenge(ch, actor);
            return send(res, 200, await daemon.status(ch));
          case "POST /reclaim":
            await daemon.reclaim(ch);
            return send(res, 200, await daemon.status(ch));
          case "POST /handoff": {
            const to = b.to;
            if (to !== "agent" && to !== "human") throw new DaemonError(400, 'to must be "agent" or "human"');
            await daemon.handoff(ch, to, typeof b.note === "string" ? b.note : "");
            return send(res, 200, await daemon.status(ch));
          }
          default:
            return send(res, 404, { error: `no route ${route}` });
        }
      } catch (err) {
        if (err instanceof DaemonError) return send(res, err.code, { error: err.message });
        return send(res, 500, { error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(opts.port, host, resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://${host}:${port}` };
}
