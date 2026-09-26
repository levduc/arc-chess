import { readFileSync } from "node:fs";
import { parseServerConfig } from "./config.js";
import { startServer } from "./server.js";

function log(level: "info" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
}

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith("--")) {
      const key = a.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${key} needs a value`);
      args.set(key, value);
      i++;
    }
  }
  return args;
}

/** Merges `--port`/`--db`/`--public-url`/`--host` into the raw JSON *before* parsing, so a bad override (e.g. a
 *  non-numeric or out-of-range `--port`) fails through parseServerConfig's own validation with a clear field
 *  name, instead of silently producing an invalid ServerConfig. */
function mergeOverrides(raw: unknown, args: Map<string, string>): unknown {
  const base: Record<string, unknown> =
    raw !== null && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  if (args.has("port")) base.port = args.get("port");
  if (args.has("db")) base.dbPath = args.get("db");
  if (args.has("public-url")) base.publicUrl = args.get("public-url");
  if (args.has("host")) base.host = args.get("host");
  return base;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const configPath = args.get("config");
  const raw = configPath ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const cfg = parseServerConfig(mergeOverrides(raw, args));

  const server = await startServer(cfg);
  log("info", "listening", { url: server.url });
  console.log(JSON.stringify({ url: server.url }));

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log("info", "shutting down", { signal });
    try {
      await server.close();
      process.exit(0);
    } catch (err) {
      log("error", "shutdown failed", { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  return 0;
}
