/**
 * RPC URL redaction (apps/server/src/redact.ts), which the server's logs and startup errors and the self-host house
 * bot's output (bot-run.ts) all go through; and bot-run itself, run as the image runs it.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { botRpcUrls } from "../src/bot-run.js";
import { redactRpcUrls, redactUrls } from "../src/redact.js";

describe("redactUrls", () => {
  it("replaces a configured URL by its scheme and host, wherever and however often it appears", () => {
    const url = "https://rpc.example.net/v2/SECRETKEY";
    expect(redactUrls(`HTTP request failed.\n\nURL: ${url}\nRequest body: {} (${url})`, [url])).toBe(
      "HTTP request failed.\n\nURL: https://rpc.example.net\nRequest body: {} (https://rpc.example.net)",
    );
  });

  it("M-1: matches in any letter case, and the forms viem's normalized URL takes", () => {
    // The host lower-cased by `new URL`.
    expect(redactUrls("URL: https://rpc.example.org/v2/SECRET1", ["https://RPC.Example.ORG/v2/SECRET1"])).toBe("URL: https://rpc.example.org");
    // The configured string itself, in another case.
    expect(redactUrls("see HTTPS://RPC.EXAMPLE.ORG/V2/SECRET1", ["https://rpc.example.org/v2/secret1"])).toBe("see https://rpc.example.org");
    // A query with no path: `new URL` adds the "/".
    expect(redactUrls("URL: https://127.0.0.1:9/?k=SECRET2", ["https://127.0.0.1:9?k=SECRET2"])).toBe("URL: https://127.0.0.1:9");
    // Credentials, which viem strips before it quotes the URL.
    expect(redactUrls("URL: https://rpc.example.net/x/SECRET3", ["https://user:pw@rpc.example.net/x/SECRET3"])).toBe("URL: https://rpc.example.net");
    // Re-review N-2: a non-canonical IPv6 literal, which `new URL` prints in its short form.
    expect(redactUrls("URL: http://[::1]:8545/v2/SECRET5", ["http://[0:0:0:0:0:0:0:1]:8545/v2/SECRET5"])).toBe("URL: http://[::1]:8545");
    expect(redactUrls("URL: http://[FE80::1]/SECRET6", ["http://[fe80::1]/SECRET6"])).toBe("URL: http://[fe80::1]");
    // The same host under another scheme (a WebSocket RPC URL) is redacted too, keeping its own scheme.
    expect(redactUrls("ws wss://rpc.example.net/v2/K", ["https://rpc.example.net/v2/K"])).toBe("ws wss://rpc.example.net");
    // A default port, which `new URL` drops.
    expect(redactUrls("URL: https://rpc.example.net/SECRET4", ["https://rpc.example.net:443/SECRET4"])).toBe("URL: https://rpc.example.net");
  });

  it("redacts any URL on a configured RPC's host, keeps sentence punctuation, and leaves other URLs alone", () => {
    const out = redactUrls("tried https://rpc.example.net/v3/OTHERKEY. Then https://arena.operator.dev/skill.md, done", ["https://rpc.example.net/v2/KEY"]);
    expect(out).toBe("tried https://rpc.example.net. Then https://arena.operator.dev/skill.md, done");
    expect(redactUrls("nothing here", [])).toBe("nothing here");
    expect(redactUrls("https://rpc.example.net/v2/KEY", [""])).toBe("https://rpc.example.net/v2/KEY");
  });

  it("redactRpcUrls keeps the server's behaviour: both of a config's RPC URLs, shown as scheme and host", () => {
    const cfg = { rpcUrl: "https://rpc.example/v2/SECRETKEY123", publicRpcUrl: "https://public.example/key/OTHERKEY456?x=1" };
    const text = `URL: ${cfg.rpcUrl}\n(also tried ${cfg.publicRpcUrl})`;
    expect(redactRpcUrls(text, cfg)).toBe("URL: https://rpc.example\n(also tried https://public.example)");
    expect(redactRpcUrls("x", { rpcUrl: "not a url", publicRpcUrl: "" })).toBe("x");
    expect(redactRpcUrls("rpc not a url here", { rpcUrl: "not a url", publicRpcUrl: "" })).toBe("rpc (the RPC URL) here");
  });
});

// ------------------------------------------------------------------------------------------ bot-run

const ENTRY = join(import.meta.dirname, "../src/bot-run-entry.ts");
const tmp = mkdtempSync(join(tmpdir(), "arena-bot-run-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** bot-run (under tsx, as the bundle runs it under node) on `argv`, with `env`; `onStart` gets the child. */
function botRunProcess(argv: string[], env: Record<string, string>, onStart?: (pid: number) => void) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", ENTRY, ...argv], { env: { PATH: process.env.PATH ?? "", ...env } });
    let stdout = "";
    let stderr = "";
    let started = false;
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
      if (!started && stdout.includes("ready")) {
        started = true;
        onStart?.(child.pid!);
      }
    });
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("bot-run (the house bot's output redactor)", () => {
  it("botRpcUrls: BOT_RPC_URL and the rpcUrl recorded in ARENA_HOME/config.json", () => {
    const home = join(tmp, "home-urls");
    mkdirSync(home, { recursive: true });
    expect(botRpcUrls({ ARENA_HOME: home })).toEqual([]);
    writeFileSync(join(home, "config.json"), JSON.stringify({ rpcUrl: "https://rec.example.net/v2/RECORDED" }));
    expect(botRpcUrls({ ARENA_HOME: home, BOT_RPC_URL: "https://new.example.net/v2/NEW" })).toEqual([
      "https://new.example.net/v2/NEW",
      "https://rec.example.net/v2/RECORDED",
    ]);
  });

  it("passes the command's stdout and stderr through with the RPC URLs redacted, and its exit code", async () => {
    const home = join(tmp, "home-run");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ rpcUrl: "https://RPC.Example.ORG/v2/RECORDEDKEY" }));
    const r = await botRunProcess(
      ["sh", "-c", 'echo "URL: https://rpc.example.org/v2/RECORDEDKEY"; echo "refusing https://new.example.net/?k=NEWKEY." >&2; printf "no newline https://new.example.net/?k=NEWKEY"; exit 3'],
      { ARENA_HOME: home, BOT_RPC_URL: "https://new.example.net?k=NEWKEY" },
    );
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("URL: https://rpc.example.org\nno newline https://new.example.net");
    expect(r.stderr).toBe("refusing https://new.example.net.\n");
  });

  it("forwards SIGTERM to the command, which shuts down cleanly", async () => {
    const script = "process.on('SIGTERM', () => { console.log('got SIGTERM'); process.exit(0); }); console.log('ready'); setInterval(() => {}, 1000);";
    const r = await botRunProcess([process.execPath, "-e", script], {}, (pid) => process.kill(pid, "SIGTERM"));
    expect(r.stdout).toBe("ready\ngot SIGTERM\n");
    expect(r.code).toBe(0);
  });

  it("a command that cannot start exits 127", async () => {
    const r = await botRunProcess(["/nonexistent/arena"], {});
    expect(r.code).toBe(127);
    expect(r.stderr).toMatch(/^bot-run: cannot run \/nonexistent\/arena: /);
  });
});
