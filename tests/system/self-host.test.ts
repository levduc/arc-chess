/**
 * Self-host (deploy/host): the files an operator runs, and the image they run.
 *
 * - Always: the Dockerfile, its dockerignore allowlist, example.env and the gitignore, as text.
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
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import https from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(sh).toContain("secret=/run/secrets/house_bot_wallet");
    expect(sh).toContain('ln -s "$secret" "$ARENA_HOME/wallet.json"');
    expect(sh).not.toMatch(/--wallet-key/);
    expect(sh).toContain("bot --allow-real-chain");
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
    expect(c.services["house-bot"]!.image).toMatch(/^node:24\.[0-9.]+-alpine[0-9.]+@sha256:[0-9a-f]{64}$/);
    expect(c.services["house-bot"]!.image).toBe(/ARG NODE_IMAGE=(\S+)/.exec(read("Dockerfile"))![1]);
    expect(c.services["house-bot"]!.profiles).toEqual(["bots"]);
    expect(c.services["house-bot"]!.user).toBe("1000:1000");
    expect(c.services["house-bot"]!.secrets!.map((s) => s.source)).toEqual(["house_bot_wallet"]);
    expect(c.secrets!.house_bot_wallet!.file).toBe(join(HOST_DIR, "secrets/house-bot-wallet.json"));
    for (const s of Object.values(c.services)) expect(JSON.stringify(s.environment ?? {})).not.toMatch(/KEY|PRIVATE|MNEMONIC/i);
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

function get(url: string, ca: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { ca, headers }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

withE2e(e2eReason ? `self-host stack over HTTPS (SKIPPED: ${e2eReason})` : "self-host stack over HTTPS", () => {
  let base = "";
  let ca = "";
  let env: NodeJS.ProcessEnv = {};
  const compose = (args: string[], timeoutMs = 300_000) =>
    docker(["compose", "-p", NAME, "--env-file", "/dev/null", "-f", "docker-compose.yml", "-f", "test/compose.e2e.yml", ...args], { cwd: HOST_DIR, env, timeoutMs });

  beforeAll(async () => {
    const [http, httpsPort] = [await freePort(), await freePort()];
    base = `https://localhost:${httpsPort}`;
    env = {
      DOMAIN: "localhost",
      PUBLIC_URL: base,
      HOST_OPERATOR: "self-host system test",
      ARENA_IMAGE: IMAGE,
      E2E_HTTP_PORT: String(http),
      E2E_HTTPS_PORT: String(httpsPort),
      INDEXER_POLL_MS: "10000",
    };
    const built = docker(["build", "-f", "deploy/host/Dockerfile", "-t", IMAGE, "."], { timeoutMs: 900_000 });
    if (built.status !== 0) throw new Error(`docker build failed:\n${built.output.slice(-4000)}`);
    const up = compose(["up", "-d", "--wait", "--wait-timeout", "240"], 300_000);
    if (up.status !== 0) throw new Error(`compose up failed:\n${up.output.slice(-4000)}\n${compose(["logs", "--no-color"]).output.slice(-4000)}`);
    const caFile = join(tmpdir(), `${NAME}-root.crt`);
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

  it("the server container runs as node, read-only, with no capabilities and no published port", () => {
    const r = compose(["exec", "-T", "arena-server", "sh", "-c", "id -u; grep CapEff /proc/1/status; touch /app/x 2>&1 || true"]);
    expect(r.stdout).toMatch(/^1000\nCapEff:\s+0000000000000000\n.*Read-only file system/s);
    const ps = compose(["ps", "--format", "json", "arena-server"]);
    expect(ps.stdout).not.toMatch(/"PublishedPort":\s*[1-9]/);
  });
});
