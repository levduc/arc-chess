import { readFileSync } from "node:fs";
import { parseServerConfig, type ServerConfig } from "./config.js";
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

function applyOverrides(cfg: ServerConfig, args: Map<string, string>): ServerConfig {
  const out = { ...cfg };
  if (args.has("port")) out.port = Number(args.get("port"));
  if (args.has("db")) out.dbPath = args.get("db")!;
  if (args.has("public-url")) out.publicUrl = args.get("public-url")!;
  if (args.has("host")) out.host = args.get("host")!;
  return out;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const configPath = args.get("config");
  const raw = configPath ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const cfg = applyOverrides(parseServerConfig(raw), args);

  const server = await startServer(cfg);
  log("info", "listening", { url: server.url });
  console.log(JSON.stringify({ url: server.url }));

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log("info", "shutting down", { signal });
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  return 0;
}
