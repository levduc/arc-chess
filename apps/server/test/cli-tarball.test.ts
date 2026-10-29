/**
 * Remote agents (testnet): a host that serves the CLI tarball itself (`cliTarball`), and listens on more than one
 * address (`extraHosts`). The tarball is a throwaway file here; nothing is built or installed.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { WebSocket as WsClient } from "ws";
import { cliTarballCommand, parseServerConfig } from "../src/config.js";
import { startServer, type ArenaServer } from "../src/server.js";
import { FakeChain, testConfig } from "./helpers/fakeChain.js";

let server: ArenaServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const dir = mkdtempSync(join(tmpdir(), "arena-cli-tarball-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NAME = "arena-cli-0.1.0-0123456789abcdef.tgz";
const BODY = Buffer.from("not really a tarball, but bytes all the same\n");
const SHA = createHash("sha256").update(BODY).digest("hex");
const PATH = join(dir, NAME);
writeFileSync(PATH, BODY);
writeFileSync(join(dir, "server.json"), "{\"secret\": true}\n");

const CLI = { package: "@arena/cli", version: "0.1.0" };
const PUBLIC = "http://100.70.62.92:8700";

function base(): Record<string, unknown> {
  return { rpcUrl: "http://x", chainId: 5042002, audit: "unaudited; testnet", hub: "0x" + "11".repeat(20), usdc: "0x" + "22".repeat(20), rules: "0x" + "33".repeat(20) };
}

describe("the cliTarball config", () => {
  it("is absent without the key, and parses a path and sha256 with cli and publicUrl", () => {
    expect(parseServerConfig(base()).cliTarball).toBeUndefined();
    const c = parseServerConfig({ ...base(), publicUrl: PUBLIC, cli: CLI, cliTarball: { path: PATH, sha256: SHA } });
    expect(c.cliTarball).toEqual({ path: PATH, sha256: SHA });
  });

  it("derives the npx tarball command (it wins over the npm pin); an explicit cliCommand still wins", () => {
    const c = parseServerConfig({ ...base(), publicUrl: PUBLIC, cli: CLI, cliTarball: { path: PATH, sha256: SHA } });
    expect(c.cliCommand).toBe(`npx -y --prefer-offline --package=${PUBLIC}/cli/${NAME} arena`);
    expect(c.cliCommand).toBe(cliTarballCommand(`${PUBLIC}/cli/${NAME}`));
    // A trailing slash on publicUrl never doubles the one before cli/.
    expect(parseServerConfig({ ...base(), publicUrl: `${PUBLIC}/`, cli: CLI, cliTarball: { path: PATH, sha256: SHA } }).cliCommand).toBe(c.cliCommand);
    const explicit = parseServerConfig({ ...base(), publicUrl: PUBLIC, cli: CLI, cliTarball: { path: PATH, sha256: SHA }, cliCommand: "my-arena" });
    expect(explicit.cliCommand).toBe("my-arena");
    // Without the tarball, the npm pin is unchanged.
    expect(parseServerConfig({ ...base(), publicUrl: PUBLIC, cli: CLI }).cliCommand).toBe("npx -y @arena/cli@0.1.0");
  });

  it("needs cli and publicUrl", () => {
    expect(() => parseServerConfig({ ...base(), publicUrl: PUBLIC, cliTarball: { path: PATH, sha256: SHA } })).toThrow(/^cliTarball: needs cli/);
    expect(() => parseServerConfig({ ...base(), cli: CLI, cliTarball: { path: PATH, sha256: SHA } })).toThrow(/^cliTarball: needs publicUrl/);
  });

  it("refuses a relative path, a name with anything but [A-Za-z0-9._-], a non-.tgz name and a malformed sha256", () => {
    const ok = { ...base(), publicUrl: PUBLIC, cli: CLI };
    expect(() => parseServerConfig({ ...ok, cliTarball: "x.tgz" })).toThrow(/^cliTarball: must be an object/);
    expect(() => parseServerConfig({ ...ok, cliTarball: { path: NAME, sha256: SHA } })).toThrow(/^cliTarball\.path: must be an absolute path/);
    for (const bad of ["a b.tgz", "a;rm.tgz", "a$(x).tgz", ".hidden.tgz", "arena.tar", "-x.tgz"]) {
      expect(() => parseServerConfig({ ...ok, cliTarball: { path: join(dir, bad), sha256: SHA } }), bad).toThrow(/^cliTarball\.path: must name a \.tgz file/);
    }
    for (const bad of [SHA.toUpperCase(), SHA.slice(1), `0x${SHA.slice(2)}`, 42]) {
      expect(() => parseServerConfig({ ...ok, cliTarball: { path: PATH, sha256: bad } })).toThrow(/^cliTarball\.sha256/);
    }
  });

  it("refuses a publicUrl that would put credentials, a query or a shell metacharacter into the command", () => {
    for (const bad of ["http://u:p@100.70.62.92:8700", "http://100.70.62.92:8700/?x=1", "http://100.70.62.92:8700/a b", "ftp://100.70.62.92", "http://h/$(id)"]) {
      expect(() => parseServerConfig({ ...base(), publicUrl: bad, cli: CLI, cliTarball: { path: PATH, sha256: SHA } }), bad).toThrow(/^publicUrl: must be a plain http\(s\) URL/);
    }
  });
});

describe("extraHosts", () => {
  it("is absent without the key; takes IP literals other than host, each once", () => {
    expect(parseServerConfig(base()).extraHosts).toBeUndefined();
    expect(parseServerConfig({ ...base(), extraHosts: ["100.70.62.92"] }).extraHosts).toEqual(["100.70.62.92"]);
    expect(() => parseServerConfig({ ...base(), extraHosts: "100.70.62.92" })).toThrow(/^extraHosts: must be a list/);
    expect(() => parseServerConfig({ ...base(), extraHosts: ["tailnet.example"] })).toThrow(/^extraHosts: must be a list/);
    expect(() => parseServerConfig({ ...base(), extraHosts: ["127.0.0.1"] })).toThrow(/^extraHosts: lists 127\.0\.0\.1 twice/);
    expect(() => parseServerConfig({ ...base(), extraHosts: ["10.0.0.1", "10.0.0.1"] })).toThrow(/^extraHosts: lists 10\.0\.0\.1 twice/);
  });

  it("serves the same routes and WebSocket hub on every address, on one port", async () => {
    // 127.0.0.2 is on the loopback interface on Linux (all of 127/8 is), so this needs no real second interface.
    server = await startServer(testConfig({ extraHosts: ["127.0.0.2"] }), { chain: new FakeChain() });
    for (const host of ["127.0.0.1", "127.0.0.2"]) {
      const res = await fetch(`http://${host}:${server.port}/healthz`);
      expect(res.status, host).toBe(200);
      const ws = new WsClient(`ws://${host}:${server.port}/ws`);
      const hello = await new Promise<{ type: string }>((resolve, reject) => {
        ws.once("message", (d) => resolve(JSON.parse(String(d)) as { type: string }));
        ws.once("error", reject);
      });
      expect(hello.type, host).toBe("hello");
      ws.close();
    }
  });

  it("an address that cannot be bound fails the start, and leaves nothing listening", async () => {
    // TEST-NET-1 (192.0.2.0/24) is never assigned to a local interface: listen fails with EADDRNOTAVAIL.
    await expect(startServer(testConfig({ extraHosts: ["192.0.2.1"] }), { chain: new FakeChain() })).rejects.toThrow(/EADDRNOTAVAIL/);
  });
});

describe("GET /cli/<name>", () => {
  const tarball = { path: PATH, sha256: SHA };

  it("serves exactly the configured file, with its sha256, as gzip, cacheable for good", async () => {
    server = await startServer(testConfig({ cli: CLI, cliTarball: tarball }), { chain: new FakeChain() });
    const res = await fetch(`${server.url}/cli/${NAME}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(res.headers.get("x-content-sha256")).toBe(SHA);
    expect(res.headers.get("etag")).toBe(`"${SHA}"`);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-length")).toBe(String(BODY.length));
    expect(Buffer.from(await res.arrayBuffer()).equals(BODY)).toBe(true);
  });

  it("nothing else under /cli: no directory, no other file, no traversal, no other method", async () => {
    server = await startServer(testConfig({ cli: CLI, cliTarball: tarball }), { chain: new FakeChain() });
    for (const path of ["/cli", "/cli/", "/cli/server.json", "/cli/arena-cli-0.1.0.tgz", `/cli/${NAME}/`, `/cli/x/../${NAME}x`, "/cli/..%2fserver.json", "/cli/%2e%2e/server.json"]) {
      const res = await fetch(`${server.url}${path}`);
      expect(res.status, path).toBe(404);
    }
    // A raw `..` path (fetch would normalize it away): the request line carries it as is.
    const raw = await new Promise<string>((resolve, reject) => {
      const s = connect(server!.port, "127.0.0.1", () => s.write(`GET /cli/../server.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
      let out = "";
      s.on("data", (c: Buffer) => (out += c.toString("utf8")));
      s.on("end", () => resolve(out));
      s.on("error", reject);
    });
    expect(raw.split("\r\n")[0]).toBe("HTTP/1.1 404 Not Found");
    expect(raw).not.toContain("secret");
    const post = await fetch(`${server.url}/cli/${NAME}`, { method: "POST" });
    expect(post.status).toBe(404);
  });

  it("/templates publishes its URL and sha256; a host without a tarball publishes none and serves no /cli", async () => {
    server = await startServer(testConfig({ cli: CLI, cliTarball: tarball }), { chain: new FakeChain() });
    const [t] = (await (await fetch(`${server.url}/templates`)).json()) as Array<Record<string, unknown>>;
    expect(t!.cliTarball).toEqual({ url: `${server.url}/cli/${NAME}`, sha256: SHA });
    expect(t!.cli).toEqual(CLI);
    await server.close();
    server = await startServer(testConfig({ cli: CLI }), { chain: new FakeChain() });
    const [plain] = (await (await fetch(`${server.url}/templates`)).json()) as Array<Record<string, unknown>>;
    expect(plain).not.toHaveProperty("cliTarball");
    expect((await fetch(`${server.url}/cli/${NAME}`)).status).toBe(404);
  });

  it("Arc mainnet (5042): no tarball unless one is configured -- none is served and none is published", async () => {
    const mainnet = parseServerConfig({
      ...base(),
      chainId: 5042,
      audit: "unaudited; guarded launch",
      indexer: { startBlock: "1000" },
      cli: { package: "@x/arena", version: "0.1.0" },
    });
    expect(mainnet.cliTarball).toBeUndefined();
    expect(mainnet.cliCommand).toBe("npx -y @x/arena@0.1.0");
    const chain = new FakeChain();
    chain.rpcChainId = 5042;
    server = await startServer({ ...mainnet, dbPath: ":memory:", port: 0, indexer: { ...mainnet.indexer, pollMs: 0 } }, { chain });
    const [t] = (await (await fetch(`${server.url}/templates`)).json()) as Array<Record<string, unknown>>;
    expect(t).not.toHaveProperty("cliTarball");
    for (const path of [`/cli/${NAME}`, "/cli/", "/cli/arena-cli-0.1.0.tgz"]) expect((await fetch(`${server.url}${path}`)).status, path).toBe(404);
  });

  it("refuses to start when the file is missing or its sha256 is not the configured one", async () => {
    await expect(startServer(testConfig({ cli: CLI, cliTarball: { path: join(dir, "missing.tgz"), sha256: SHA } }), { chain: new FakeChain() })).rejects.toThrow(
      /cliTarball\.path .*missing\.tgz cannot be read \(ENOENT\)\. Nothing was started/,
    );
    const other = "0".repeat(64);
    await expect(startServer(testConfig({ cli: CLI, cliTarball: { path: PATH, sha256: other } }), { chain: new FakeChain() })).rejects.toThrow(
      new RegExp(`has sha256 ${SHA}, not the configured ${other}\\. Nothing was started`),
    );
  });

  it("skill.md's step 0 names the tarball, Node 24, the sha256 check and the command", async () => {
    server = await startServer(testConfig({ cli: CLI, cliTarball: tarball, cliCommand: cliTarballCommand(`http://127.0.0.1:1/cli/${NAME}`) }), {
      chain: new FakeChain(),
    });
    const text = await (await fetch(`${server.url}/skill.md`)).text();
    const recipe = text.slice(text.indexOf("## Recipe: play N games at $X per game"), text.indexOf("## Setup (once)"));
    const step0 = recipe.slice(recipe.indexOf("0. **Install"), recipe.indexOf("1. `"));
    const url = `${server.url}/cli/${NAME}`;
    expect(step0).toContain("node --version` is 24 or newer");
    expect(step0).toContain("This host serves the CLI itself");
    expect(step0).toContain("never another package, never @latest");
    expect(step0).toContain(`its first run downloads ${url}`);
    expect(step0).toContain(`To check that the download arrives intact: \`curl -fsSL ${url} | sha256sum\` prints\n   \`${SHA}\``);
    expect(step0).toContain("That checks the file, not where it came\n   from: the digest comes from this same host.");
    expect(recipe).toContain(`${cliTarballCommand(`http://127.0.0.1:1/cli/${NAME}`)} init --server`);
    expect(text).toContain("with\n  the tarball pinned there");
  });
});
