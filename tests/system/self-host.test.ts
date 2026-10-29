/**
 * Self-host (deploy/host): the files an operator runs, and the image they run.
 *
 * - Always: the Dockerfile, its dockerignore allowlist, example.env and the gitignore, as text; and house-bot.sh under
 *   `sh`, with the image's bot-run.mjs and a stubbed CLI, npm and server (its restart path, RPC changes, redaction).
 * - With Docker (`dockerUnavailableReason`, as xmtp-local.test.ts skips without it): the compose file as compose itself
 *   resolves it (`docker compose config`), and the image built from this checkout -- its user, that it refuses Arc
 *   mainnet, its assets, and that it holds no wallet or key file.
 * - With Docker and ARENA_SELFHOST_E2E=1: the whole stack (deploy/host/test/compose.e2e.yml: Caddy on two free
 *   loopback ports, its local CA for `localhost`) against Arc Testnet, read-only -- skill.md and /templates over
 *   HTTPS, the /ws upgrade through Caddy, and that a spoofed X-Forwarded-For buys no extra rate limit. It needs the
 *   internet (the public testnet RPC), so it is opt-in.
 *
 * Docker hygiene: every image, container, volume and network here is named `arena-selfhost-vitest-<pid>`, and
 * `afterAll` removes exactly those. Host ports: two picked free, never 80/443 nor any port the other stacks use.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { KNOWN_DEPLOYMENTS } from "@arena/cli";
import { dockerUnavailableReason } from "./harness.js";

const REPO_ROOT = join(import.meta.dirname, "../..");
const HOST_DIR = join(REPO_ROOT, "deploy/host");
const read = (p: string) => readFileSync(join(HOST_DIR, p), "utf8");
const NAME = `arena-selfhost-vitest-${process.pid}`;
const IMAGE = `${NAME}-server:test`;

function docker(args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string } = {}) {
  const r = spawnSync("docker", args, {
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("deploy/host files", () => {
  it("Dockerfile: both stages on one Node 24 base pinned by digest; the final stage runs as node, with no RUN step", () => {
    const text = read("Dockerfile");
    expect(text).toMatch(/\nARG NODE_IMAGE=node:24\.[0-9]+\.[0-9]+-alpine[0-9.]+@sha256:[0-9a-f]{64}\n/);
    expect(text.match(/^FROM .*/gm)).toEqual(["FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build", "FROM ${NODE_IMAGE}"]);
    const final = text.slice(text.lastIndexOf("FROM ${NODE_IMAGE}"));
    expect(final).not.toMatch(/^RUN /m);
    expect(final).toMatch(/^USER node$/m);
    expect(final).toContain('ENTRYPOINT ["node", "/app/arena-host.mjs"]');
    expect(final).toMatch(/^HEALTHCHECK /m);
    expect(final).toContain("COPY --from=build --chown=node:node /out/data/ /data/");
    expect(text).toContain("RUN pnpm install --frozen-lockfile");
  });

  it("the build context is an allowlist: everything else of the checkout, local stacks and wallets included, is out", () => {
    const lines = read("Dockerfile.dockerignore")
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.startsWith("#"));
    expect(lines[0]).toBe("*");
    expect(lines.at(-1)).toBe("**/node_modules");
    for (const l of lines.slice(1, -1)) {
      expect(l.startsWith("!"), l).toBe(true);
      expect(l, l).not.toMatch(/\.arena|broadcast|secrets|\.env|home|wallet|\.config/i);
    }
    expect(lines).toContain("!contracts/deployments/5042002.json");
    expect(lines).not.toContain("!contracts/deployments/31337.json");
  });

  it("example.env documents every setting the compose file passes, with no value that looks like a key", () => {
    const example = read("example.env");
    const compose = read("docker-compose.yml");
    const passed = [...compose.matchAll(/\$\{([A-Z_]+)(?::[-?][^}]*)?\}/g)].map((m) => m[1]!);
    for (const v of new Set(passed)) {
      if (v === "E2E_HTTP_PORT" || v === "E2E_HTTPS_PORT") continue;
      expect(example, v).toMatch(new RegExp(`^${v}=`, "m"));
    }
    expect(example).toMatch(/^DOMAIN=arena\.example\.com$/m);
    expect(example).toMatch(/^NETWORK=arc-testnet$/m);
    expect(example).toMatch(/^XMTP=off$/m);
    expect(example).not.toMatch(/[0-9a-fA-F]{64}/);
    expect(read(".gitignore").split("\n")).toEqual(expect.arrayContaining([".env", "secrets/"]));
  });

  it("the house bot links its wallet to the Docker secret, and never puts the key on a command line", () => {
    const sh = read("bots/house-bot.sh");
    expect(sh).toContain('secret="${HOUSE_BOT_SECRET:-/run/secrets/house_bot_wallet}"');
    expect(sh).toContain('ln -s "$secret" "$ARENA_HOME/wallet.json"');
    expect(sh).not.toMatch(/--wallet-key/);
    expect(sh).toContain("bot --allow-real-chain");
  });
});

// ------------------------------------------------------------------------------------------ house-bot.sh

/**
 * Review I-1, I-2, M-7: house-bot.sh itself, under `sh`, with the image's real bot-run.mjs (built here) and stubs for
 * the rest: a /templates server, `npm` (which "installs" a fake CLI) and that fake CLI, which records each command
 * and acts out init's refusal to change the RPC while a channel is open.
 */
const FAKE_CLI = `
import { appendFileSync, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [cmd, ...rest] = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify([cmd, ...rest]) + "\\n");
const flag = (n) => { const i = rest.indexOf("--" + n); return i < 0 ? undefined : rest[i + 1]; };
const home = process.env.ARENA_HOME;
const cfgPath = join(home, "config.json");
if (cmd === "init") {
  // The real init makes a new wallet when there is none: the script must have linked the secret first.
  if (!lstatSync(join(home, "wallet.json")).isSymbolicLink()) process.exit(9);
  const rpc = flag("rpc") ?? process.env.FAKE_TEMPLATES_RPC;
  const prior = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : null;
  if (prior !== null && process.env.FAKE_OPEN_CHANNEL === "1" && prior.rpcUrl !== rpc) {
    console.error("error: refusing to change the RPC from " + prior.rpcUrl + " to " + rpc + " while 1 channel(s) are not finalized");
    process.exit(1);
  }
  writeFileSync(cfgPath, JSON.stringify({ rpcUrl: rpc, chainId: Number(process.env.FAKE_CHAIN ?? "5042002"), owner: flag("owner") ?? prior?.owner }));
  console.log(JSON.stringify({ rpcUrl: rpc }));
} else if (cmd === "wallet") {
  console.log(JSON.stringify({ address: "0x00000000000000000000000000000000000B0B00" }));
} else if (cmd === "bot") {
  console.error("bot: reading the chain through " + JSON.parse(readFileSync(cfgPath, "utf8")).rpcUrl);
}
`;
const FAKE_NPM = `#!/bin/sh
prefix=""; spec=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    install | --*) shift ;;
    *) spec="$1"; shift ;;
  esac
done
echo "$spec" >> "$FAKE_NPM_LOG"
[ "\${FAKE_NPM_FAIL:-}" != 1 ] || exit 1
mkdir -p "$prefix/node_modules/\${spec%@*}"
cp "$FAKE_CLI" "$prefix/node_modules/\${spec%@*}/arena.mjs"
`;

describe("house-bot.sh (stubbed CLI, npm and server)", () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-house-bot-"));
  const home = join(dir, "home");
  const arenaHome = join(home, "arena");
  const secret = join(dir, "secret.json");
  const log = join(dir, "cli.log");
  const npmLog = join(dir, "npm.log");
  let botRun = "";
  let serverUrl = "";
  let server: http.Server | undefined;
  const KEYED = "https://keyed.example.net/v2/SECRETKEY";

  beforeAll(async () => {
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "fake-arena.mjs"), FAKE_CLI);
    writeFileSync(join(dir, "bin/npm"), FAKE_NPM, { mode: 0o755 });
    writeFileSync(secret, `${JSON.stringify({ key: `0x${"ab".repeat(32)}` })}\n`, { mode: 0o600 });
    const built = spawnSync(process.execPath, [join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs"), join(REPO_ROOT, "scripts/build-server.ts"), "--out", join(dir, "dist")], {
      encoding: "utf8",
      timeout: 120_000,
    });
    if (built.status !== 0) throw new Error(`build-server failed: ${built.stderr}`);
    botRun = join(dir, "dist/bot-run.mjs");
    server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ cli: { package: "arc-chess", version: "0.1.0" }, rpcUrl: "https://public.example.net" }]));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    serverUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 180_000);
  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs house-bot.sh; returns its exit code, its output, and the CLI commands it ran (in order). Asynchronously: the
   *  stub /templates server answers from this process's event loop. */
  async function runBot(env: Record<string, string>) {
    writeFileSync(log, "");
    writeFileSync(npmLog, "");
    const child = spawn("sh", [join(HOST_DIR, "bots/house-bot.sh")], {
      env: {
        PATH: `${join(dir, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home,
        ARENA_HOME: arenaHome,
        ARENA_SERVER_URL: serverUrl,
        HOUSE_BOT_SECRET: secret,
        HOUSE_BOT_RUN: botRun,
        FAKE_LOG: log,
        FAKE_NPM_LOG: npmLog,
        FAKE_CLI: join(dir, "fake-arena.mjs"),
        FAKE_TEMPLATES_RPC: "https://public.example.net",
        BOT_OFFERS: "2",
        ...env,
      },
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    const status = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    clearTimeout(timer);
    const commands = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as string[]);
    return { status, output: out, commands, npm: readFileSync(npmLog, "utf8").trim() };
  }
  const recordedRpc = () => (JSON.parse(readFileSync(join(arenaHome, "config.json"), "utf8")) as { rpcUrl: string }).rpcUrl;

  it("refuses a first start without BOT_OWNER, or while the server cannot be reached", async () => {
    const noOwner = await runBot({});
    expect(noOwner.status).toBe(1);
    expect(noOwner.output).toMatch(/set BOT_OWNER in \.env/);
    const noServer = await runBot({ BOT_OWNER: "0x00000000000000000000000000000000000000AA", ARENA_SERVER_URL: "http://127.0.0.1:9" });
    expect(noServer.status).toBe(1);
    expect(noServer.output).toMatch(/the bot's first start needs the arena server \(http:\/\/127\.0\.0\.1:9\)/);
    expect(noOwner.npm + noServer.npm).toBe("");
    expect(existsSync(join(arenaHome, "config.json"))).toBe(false);
  });

  it("first start: installs the host's CLI version, links the wallet, inits with the host's RPC, then runs the bot", async () => {
    const r = await runBot({ BOT_OWNER: "0x00000000000000000000000000000000000000AA" });
    expect(r.status, r.output).toBe(0);
    expect(r.npm).toBe("arc-chess@0.1.0");
    expect(r.commands.map((c) => c[0])).toEqual(["init", "wallet", "bot"]);
    expect(r.commands[0]).toEqual(["init", "--server", serverUrl, "--no-faucet", "--owner", "0x00000000000000000000000000000000000000AA"]);
    expect(r.commands[2]).toEqual(["bot", "--allow-real-chain", "--deposit", "1", "--stake", "0.1", "--offers", "2"]);
    expect(lstatSync(join(arenaHome, "wallet.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(arenaHome, "wallet.json"))).toBe(secret);
    expect(recordedRpc()).toBe("https://public.example.net");
  });

  it("I-1: a restart goes straight to the bot -- no init, no npm -- even with the arena server down", async () => {
    const r = await runBot({ ARENA_SERVER_URL: "http://127.0.0.1:9" });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toMatch(/cannot read http:\/\/127\.0\.0\.1:9\/templates/);
    expect(r.commands.map((c) => c[0])).toEqual(["bot"]);
    expect(r.npm).toBe("");
  });

  it("N-1: a daemon.lock left by an unclean stop is removed before the bot starts -- unless an arena daemon here holds it", async () => {
    const lockPath = join(arenaHome, "daemon.lock");
    // A dead pid, and a live pid that is no arena daemon (this test runner: a restarted container reuses its pids).
    for (const pid of [2 ** 22 + 4321, process.pid]) {
      writeFileSync(lockPath, JSON.stringify({ pid, nonce: "ab".repeat(16) }));
      const r = await runBot({});
      expect(r.status, r.output).toBe(0);
      expect(r.output).toContain(`removing a stale daemon.lock (pid ${pid}, left by an unclean stop)`);
      expect(existsSync(lockPath)).toBe(false);
      expect(r.commands.map((c) => c[0])).toEqual(["bot"]);
    }
    // A live process whose command line is an arena daemon's: left alone (the CLI's own lock then decides).
    const daemon = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "/x/arena.mjs", "bot", "--allow-real-chain"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 300));
      writeFileSync(lockPath, JSON.stringify({ pid: daemon.pid, nonce: "cd".repeat(16) }));
      const r = await runBot({});
      expect(r.output).toContain(`daemon.lock names pid ${daemon.pid}, an arena daemon running in this container: leaving it`);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      daemon.kill("SIGKILL");
      rmSync(lockPath, { force: true });
    }
  });

  it("N-1: a second container on the same volume is refused by the volume lock, not by daemon.lock", async () => {
    // -o: the lock stays with flock itself, so killing it releases the lock (its sleep would otherwise inherit it).
    const holder = spawn("flock", ["-o", "-x", join(home, ".house-bot.lock"), "sleep", "30"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const r = await runBot({});
      expect(r.status).toBe(1);
      expect(r.output).toMatch(/another house-bot container is using this volume/);
      expect(r.commands).toEqual([]);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("I-1/I-2: a new BOT_RPC_URL while a channel is open keeps the recorded RPC and still runs the bot; nothing prints the key", async () => {
    const r = await runBot({ BOT_RPC_URL: KEYED, FAKE_OPEN_CHANNEL: "1" });
    expect(r.status, r.output).toBe(0);
    expect(r.commands.map((c) => c[0])).toEqual(["init", "bot"]);
    expect(r.commands[0]).toEqual(["init", "--server", serverUrl, "--no-faucet", "--rpc", KEYED]);
    expect(r.output).toMatch(/kept the bot's recorded RPC: init cannot change it now/);
    expect(r.output).not.toMatch(/same host/); // keyed.example.net is not public.example.net
    expect(r.output).toContain("refusing to change the RPC from https://public.example.net to https://keyed.example.net while");
    expect(r.output).not.toContain("SECRETKEY");
    expect(recordedRpc()).toBe("https://public.example.net");
  });

  it("I-2: with no channel open, the new BOT_RPC_URL is applied, and the bot's output still never shows the key", async () => {
    const r = await runBot({ BOT_RPC_URL: KEYED });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toMatch(/the bot's RPC changed/);
    expect(recordedRpc()).toBe(KEYED);
    expect(r.output).toContain("bot: reading the chain through https://keyed.example.net\n");
    expect(r.output).not.toContain("SECRETKEY");
    // The same RPC on the next start: nothing to change, no init.
    expect((await runBot({ BOT_RPC_URL: KEYED })).commands.map((c) => c[0])).toEqual(["bot"]);
    // N-3: a new key on the same host says so, since the log shows both URLs the same.
    const rotated = await runBot({ BOT_RPC_URL: KEYED.replace("SECRETKEY", "ROTATEDKEY") });
    expect(rotated.output).toMatch(/the bot's RPC changed \(BOT_RPC_URL, or the RPC the host publishes\) \(same host: the log shows both URLs the same\)/);
    expect(rotated.output).not.toMatch(/SECRETKEY|ROTATEDKEY/);
    await runBot({ BOT_RPC_URL: KEYED });
  });

  it("M-7: on Arc mainnet the bot opens no offers unless BOT_ALLOW_MAINNET=1", async () => {
    const cfgPath = join(arenaHome, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, chainId: 5042 }));
    const off = await runBot({ BOT_RPC_URL: KEYED });
    expect(off.output).toMatch(/Arc mainnet: BOT_ALLOW_MAINNET is not 1, so the bot opens no new offers/);
    expect(off.commands.at(-1)).toEqual(["bot", "--allow-real-chain", "--deposit", "1", "--stake", "0.1", "--offers", "0"]);
    const on = await runBot({ BOT_RPC_URL: KEYED, BOT_ALLOW_MAINNET: "1" });
    expect(on.commands.at(-1)).toEqual(["bot", "--allow-real-chain", "--deposit", "1", "--stake", "0.1", "--offers", "2"]);
  });

  it("a host that moves to a CLI version npm cannot install keeps the installed one running", async () => {
    const r = await runBot({ BOT_RPC_URL: KEYED, ARENA_CLI_VERSION: "9.9.9", FAKE_NPM_FAIL: "1" });
    expect(r.status, r.output).toBe(0);
    expect(r.npm).toBe("arc-chess@9.9.9");
    expect(r.output).toMatch(/npm install arc-chess@9\.9\.9 failed: running the installed arc-chess@0\.1\.0/);
    expect(r.commands.at(-1)![0]).toBe("bot");
  });
});

const skipReason = dockerUnavailableReason();
if (skipReason) console.log(`[self-host] docker checks skipped: ${skipReason}`);
const withDocker = skipReason ? describe.skip : describe;

type ComposeConfig = {
  services: Record<
    string,
    {
      image?: string;
      ports?: Array<{ target: number; published?: string; protocol?: string; host_ip?: string }>;
      read_only?: boolean;
      cap_drop?: string[];
      cap_add?: string[];
      security_opt?: string[];
      environment?: Record<string, string | null>;
      profiles?: string[];
      networks?: Record<string, unknown>;
      user?: string;
      secrets?: Array<{ source: string }>;
      healthcheck?: Record<string, unknown>;
      tmpfs?: string[];
      logging?: unknown;
      mem_limit?: string | number;
      pids_limit?: number;
    }
  >;
  secrets?: Record<string, { file?: string }>;
};

withDocker(skipReason ? `self-host compose file (SKIPPED: ${skipReason})` : "self-host compose file", () => {
  const config = (): ComposeConfig => {
    // --env-file /dev/null: never a developer's own deploy/host/.env.
    const r = docker(["compose", "-p", NAME, "--env-file", "/dev/null", "-f", "docker-compose.yml", "--profile", "bots", "config", "--format", "json"], {
      cwd: HOST_DIR,
      env: { DOMAIN: "arena.example.org", ARENA_IMAGE: "" },
    });
    expect(r.status, r.output).toBe(0);
    return JSON.parse(r.stdout) as ComposeConfig;
  };

  it("only Caddy publishes ports, exactly 80 and 443; the server publishes none and trusts X-Forwarded-For from Caddy", () => {
    const c = config();
    expect(Object.keys(c.services).sort()).toEqual(["arena-server", "caddy", "house-bot"]);
    expect(c.services["arena-server"]!.ports).toBeUndefined();
    expect(c.services["house-bot"]!.ports).toBeUndefined();
    expect(c.services.caddy!.ports!.map((p) => `${p.published}:${p.target}/${p.protocol}`).sort()).toEqual(["443:443/tcp", "443:443/udp", "80:80/tcp"]);
    expect(c.services["arena-server"]!.environment!.TRUST_PROXY).toBe("true");
    expect(Object.keys(c.services["arena-server"]!.networks!)).toEqual(["arena"]);
    expect(c.services["arena-server"]!.image).toBe("ghcr.io/levduc/arc-chess-server:latest");
  });

  it("every container: read-only root, all capabilities dropped (Caddy keeps NET_BIND_SERVICE), no-new-privileges", () => {
    const c = config();
    for (const [name, s] of Object.entries(c.services)) {
      expect(s.read_only, name).toBe(true);
      expect(s.cap_drop, name).toEqual(["ALL"]);
      expect(s.security_opt, name).toEqual(["no-new-privileges:true"]);
    }
    expect(c.services.caddy!.cap_add).toEqual(["NET_BIND_SERVICE"]);
    expect(c.services["arena-server"]!.cap_add).toBeUndefined();
  });

  it("third-party images are pinned by digest; the house bots are opt-in, non-root, with the wallet as a file secret", () => {
    const c = config();
    expect(c.services.caddy!.image).toMatch(/^caddy:[0-9.]+-alpine@sha256:[0-9a-f]{64}$/);
    // The server's own image (its Node and bot-run.mjs), whose healthcheck is the server's, and /data volume unused.
    expect(c.services["house-bot"]!.image).toBe(c.services["arena-server"]!.image);
    expect(c.services["house-bot"]!.healthcheck).toEqual({ disable: true });
    expect(c.services["house-bot"]!.tmpfs).toContain("/data:size=1m,uid=1000,gid=1000");
    expect(c.services["house-bot"]!.profiles).toEqual(["bots"]);
    // I-2: the bot never gets the server's (possibly keyed) RPC_URL; BOT_RPC_URL is its own, empty by default.
    expect(c.services["house-bot"]!.environment!.RPC_URL).toBeUndefined();
    expect(c.services["house-bot"]!.environment!.BOT_RPC_URL).toBe("");
    expect(c.services["house-bot"]!.environment!.BOT_ALLOW_MAINNET).toBe("");
    expect(c.services["house-bot"]!.user).toBe("1000:1000");
    expect(c.services["house-bot"]!.secrets!.map((s) => s.source)).toEqual(["house_bot_wallet"]);
    expect(c.secrets!.house_bot_wallet!.file).toBe(join(HOST_DIR, "secrets/house-bot-wallet.json"));
    for (const s of Object.values(c.services)) expect(JSON.stringify(s.environment ?? {})).not.toMatch(/KEY|PRIVATE|MNEMONIC/i);
  });

  it("M-6: every container's log is rotated, and its memory and process count are capped", () => {
    const c = config();
    for (const [name, s] of Object.entries(c.services)) {
      expect(s.logging, name).toEqual({ driver: "json-file", options: { "max-size": "10m", "max-file": "3" } });
      expect(Number(s.mem_limit), name).toBeGreaterThanOrEqual(256 * 1024 * 1024);
      expect(s.pids_limit, name).toBe(256);
    }
  });

  it("the e2e override replaces Caddy's ports with two loopback ones (never 80/443)", () => {
    const r = docker(["compose", "-p", NAME, "--env-file", "/dev/null", "-f", "docker-compose.yml", "-f", "test/compose.e2e.yml", "config", "--format", "json"], {
      cwd: HOST_DIR,
      env: { DOMAIN: "localhost", E2E_HTTP_PORT: "18780", E2E_HTTPS_PORT: "18781" },
    });
    expect(r.status, r.output).toBe(0);
    const c = JSON.parse(r.stdout) as ComposeConfig;
    expect(c.services.caddy!.ports!.map((p) => `${p.host_ip}:${p.published}:${p.target}`).sort()).toEqual(["127.0.0.1:18780:80", "127.0.0.1:18781:443"]);
  });
});

withDocker(skipReason ? `self-host image (SKIPPED: ${skipReason})` : "self-host image", () => {
  beforeAll(() => {
    // Uses Docker's build cache; a cold build pulls the Node base image and runs pnpm install (a few minutes).
    const r = docker(["build", "-f", "deploy/host/Dockerfile", "-t", IMAGE, "."], { timeoutMs: 900_000 });
    if (r.status !== 0) throw new Error(`docker build failed:\n${r.output.slice(-4000)}`);
  }, 960_000);
  afterAll(() => {
    docker(["image", "rm", "-f", IMAGE]);
  });

  it("runs as node (uid 1000), with the bundle owned by root and /data its only own directory", () => {
    const r = docker(["run", "--rm", "--read-only", "--entrypoint", "sh", IMAGE, "-c", "id -u; stat -c '%u %n' /app /app/arena-host.mjs /app/share/assets.json /data"]);
    expect(r.status, r.output).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(["1000", "0 /app", "0 /app/arena-host.mjs", "0 /app/share/assets.json", "1000 /data"]);
  });

  it("ships this checkout's CLI version and only the pinned testnet deployment", () => {
    const r = docker(["run", "--rm", "--entrypoint", "cat", IMAGE, "/app/share/assets.json"]);
    expect(r.status, r.output).toBe(0);
    const assets = JSON.parse(r.stdout) as { cli: unknown; deployments: Record<string, { hub: string }>; missing: Record<string, string> };
    const cliVersion = (JSON.parse(readFileSync(join(REPO_ROOT, "packages/cli/package.json"), "utf8")) as { version: string }).version;
    expect(assets.cli).toEqual({ package: "arc-chess", version: cliVersion });
    expect(Object.keys(assets.deployments)).toEqual(["5042002"]);
    expect(assets.deployments["5042002"]!.hub).toBe(KNOWN_DEPLOYMENTS[5042002]!.hub);
    expect(Object.keys(assets.missing)).toEqual(["5042"]);
  });

  it("refuses NETWORK=arc-mainnet (exit 1) before it reads any chain", () => {
    const r = docker(["run", "--rm", "--network", "none", "-e", "DOMAIN=arena.example.org", "-e", "NETWORK=arc-mainnet", IMAGE, "print-config"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/refusing to start: NETWORK=arc-mainnet: this image cannot serve Arc mainnet \(chain 5042\) yet/);
  });

  it("holds no wallet, key file, local stack directory or private key anywhere in its filesystem", () => {
    const r = docker([
      "run", "--rm", "--entrypoint", "sh", IMAGE, "-c",
      'find / -xdev \\( -iname "wallet*.json" -o -name ".arena*" -o -iname "*.key" -o -iname "keystore*" -o -name "token.json" -o -name "id_rsa*" -o -name "id_ed25519*" \\) 2>/dev/null; ' +
        'grep -rlE "\\"(key|privateKey|mnemonic)\\" *: *\\"0x[0-9a-fA-F]{64}\\"" /app /data /home 2>/dev/null; ' +
        'grep -rlE -- "-----BEGIN ([A-Z]+ )?PRIVATE KEY-----" /app /data /home /etc 2>/dev/null; true',
    ]);
    expect(r.status, r.output).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});

const e2eReason = skipReason ?? (process.env.ARENA_SELFHOST_E2E === "1" ? null : "set ARENA_SELFHOST_E2E=1 (it reads Arc Testnet over the internet)");
const withE2e = e2eReason ? describe.skip : describe;

/** A free loopback port, outside every range the other stacks and suites use. */
async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    if (port > 20_000) return port;
  }
}

function get(url: string, ca: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { ca, headers }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      })
      .on("error", reject);
  });
}

withE2e(e2eReason ? `self-host stack over HTTPS (SKIPPED: ${e2eReason})` : "self-host stack over HTTPS", () => {
  let base = "";
  let ca = "";
  let env: NodeJS.ProcessEnv = {};
  /** The throwaway bot wallet and Caddy's root certificate; removed in afterAll. */
  let walletDir = "";
  const compose = (args: string[], timeoutMs = 300_000) =>
    docker(["compose", "-p", NAME, "--env-file", "/dev/null", "-f", "docker-compose.yml", "-f", "test/compose.e2e.yml", "--profile", "bots", ...args], {
      cwd: HOST_DIR,
      env,
      timeoutMs,
    });
  const botLogs = () => compose(["logs", "--no-color", "house-bot"]).output;
  async function waitForBotStarts(n: number): Promise<void> {
    for (let i = 0; i < 180; i++) {
      if (botLogs().split('"bot":true').length - 1 >= n) return;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error(`the house bot did not start ${n} time(s):\n${botLogs().slice(-3000)}`);
  }

  beforeAll(async () => {
    const [httpPort, httpsPort] = [await freePort(), await freePort()];
    base = `https://localhost:${httpsPort}`;
    // The house bot's wallet: a fresh throwaway key, never funded, so the bot can send nothing.
    walletDir = mkdtempSync(join(tmpdir(), `${NAME}-`));
    const wallet = join(walletDir, "house-bot-wallet.json");
    writeFileSync(wallet, `${JSON.stringify({ key: `0x${randomBytes(32).toString("hex")}` })}\n`, { mode: 0o600 });
    env = {
      DOMAIN: "localhost",
      PUBLIC_URL: base,
      HOST_OPERATOR: "self-host system test",
      ARENA_IMAGE: IMAGE,
      E2E_HTTP_PORT: String(httpPort),
      E2E_HTTPS_PORT: String(httpsPort),
      INDEXER_POLL_MS: "10000",
      HOUSE_BOT_WALLET_FILE: wallet,
      BOT_OWNER: `0x${randomBytes(20).toString("hex")}`,
      BOT_OFFERS: "0",
    };
    const built = docker(["build", "-f", "deploy/host/Dockerfile", "-t", IMAGE, "."], { timeoutMs: 900_000 });
    if (built.status !== 0) throw new Error(`docker build failed:\n${built.output.slice(-4000)}`);
    const up = compose(["up", "-d", "--wait", "--wait-timeout", "240"], 300_000);
    if (up.status !== 0) throw new Error(`compose up failed:\n${up.output.slice(-4000)}\n${compose(["logs", "--no-color"]).output.slice(-4000)}`);
    const caFile = join(walletDir, "caddy-root.crt");
    const cp = compose(["cp", "caddy:/data/caddy/pki/authorities/local/root.crt", caFile]);
    if (cp.status !== 0) throw new Error(`could not copy Caddy's root certificate:\n${cp.output}`);
    ca = readFileSync(caFile, "utf8");
    // Caddy issues the localhost certificate a moment after it starts.
    for (let i = 0; ; i++) {
      try {
        if ((await get(`${base}/healthz`, ca)).status === 200) break;
      } catch (err) {
        if (i > 60) throw err;
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }, 1_300_000);

  afterAll(() => {
    if (Object.keys(env).length > 0) compose(["down", "-v", "--remove-orphans"]);
    docker(["image", "rm", "-f", IMAGE]);
    if (walletDir !== "") rmSync(walletDir, { recursive: true, force: true });
  }, 180_000);

  it("serves skill.md and /templates over HTTPS, pinning the published CLI and the testnet hub", async () => {
    const skill = await get(`${base}/skill.md`, ca);
    expect(skill.status).toBe(200);
    expect(skill.body).toContain(`npx -y arc-chess@0.1.0 init --server ${base}`);
    const templates = await get(`${base}/templates`, ca);
    expect(templates.status).toBe(200);
    const [t] = JSON.parse(templates.body) as Array<Record<string, unknown>>;
    expect(t).toMatchObject({ chainId: 5042002, hub: KNOWN_DEPLOYMENTS[5042002]!.hub, rpcUrl: "https://rpc.testnet.arc.io", cli: { package: "arc-chess", version: "0.1.0" } });
    expect(t!.audit).toMatch(/^unaudited; self-hosted arena host, operator: self-host system test; Arc TESTNET, faucet USDC only\./);
    expect(t!.faucet).toBeUndefined();
  });

  it("passes the /ws WebSocket upgrade through Caddy", async () => {
    const ws = new WebSocket(`${base.replace("https", "wss")}/ws`, { ca });
    const first = await new Promise<{ type: string }>((resolve, reject) => {
      ws.once("message", (d: Buffer) => resolve(JSON.parse(d.toString()) as { type: string }));
      ws.once("error", reject);
    });
    ws.close();
    expect(first.type).toBe("hello");
  });

  it("keys rate limits on the address Caddy saw, whatever X-Forwarded-For a client sends", async () => {
    const codes: Record<number, number> = {};
    for (let i = 0; i < 200; i++) {
      const r = await get(`${base}/healthz`, ca, { "x-forwarded-for": `203.0.113.${i % 250}` });
      codes[r.status] = (codes[r.status] ?? 0) + 1;
    }
    // httpGetBurst is 120: with a spoofable key, all 200 would have passed.
    expect(codes[429] ?? 0).toBeGreaterThan(50);
  });

  it("M-5: Caddy sends HSTS and nosniff, and no Via header", async () => {
    const r = await get(`${base}/templates`, ca);
    expect(r.headers["strict-transport-security"]).toBe("max-age=31536000");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers.via).toBeUndefined();
  });

  it("I-1: the house bot starts once, then restarts straight into `arena bot` while the arena server is down", async () => {
    await waitForBotStarts(1);
    expect(botLogs()).toMatch(/house-bot: arc-chess@0\.1\.0 on chain 5042002; it keeps 0 offer\(s\)/);
    expect(compose(["exec", "-T", "house-bot", "arena", "channels"]).stdout.trim()).toBe("[]");
    expect(compose(["stop", "arena-server"]).status).toBe(0);
    try {
      expect(compose(["restart", "house-bot"]).status).toBe(0);
      await waitForBotStarts(2);
      const logs = botLogs();
      expect(logs).toContain("cannot read http://arena-server:3000/templates");
      expect(logs).not.toMatch(/arena init failed|house-bot: no CLI version/);
      const state = docker(["inspect", "-f", "{{.State.Status}} {{.RestartCount}}", `${NAME}-house-bot-1`]).stdout.trim();
      expect(state).toBe("running 0");
    } finally {
      compose(["start", "arena-server"]);
    }
  }, 600_000);

  it("N-1: after an unclean kill of the bot (kill -9, as an OOM kill), the container restarts once and the bot runs again", async () => {
    await waitForBotStarts(2);
    const before = botLogs().split('"bot":true').length - 1;
    const lock = JSON.parse(compose(["exec", "-T", "house-bot", "cat", "/home/node/arena/daemon.lock"]).stdout) as { pid: number };
    expect(Number.isInteger(lock.pid)).toBe(true);
    compose(["exec", "-T", "house-bot", "kill", "-9", String(lock.pid)]);
    await waitForBotStarts(before + 1);
    const logs = botLogs();
    expect(logs).toMatch(/removing a stale daemon\.lock \(pid \d+, left by an unclean stop\)/);
    expect(logs).not.toMatch(/another arena daemon \(pid \d+\) is using/);
    // Settled: one restart, and still running a while later.
    await new Promise((r) => setTimeout(r, 15_000));
    const state = docker(["inspect", "-f", "{{.State.Status}} {{.RestartCount}}", `${NAME}-house-bot-1`]).stdout.trim();
    expect(state).toBe("running 1");
    expect(compose(["exec", "-T", "house-bot", "arena", "channels"]).stdout.trim()).toBe("[]");
  }, 600_000);

  it("the server container runs as node, read-only, with no capabilities and no published port", () => {
    const r = compose(["exec", "-T", "arena-server", "sh", "-c", "id -u; grep CapEff /proc/1/status; touch /app/x 2>&1 || true"]);
    expect(r.stdout).toMatch(/^1000\nCapEff:\s+0000000000000000\n.*Read-only file system/s);
    const ps = compose(["ps", "--format", "json", "arena-server"]);
    expect(ps.stdout).not.toMatch(/"PublishedPort":\s*[1-9]/);
  });
});
