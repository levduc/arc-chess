/**
 * The parts of `scripts/arc-rehearsal.ts` that touch nothing on import, so `tests/system/arc-rehearsal.test.ts` can
 * test them: the environment every child process gets, how a recorded pid is matched to the process it was, the
 * checkout a child runs, and which explorer-listed transactions belong to the run.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * T5 review I-1: the variables a child of the rehearsal may inherit from this process. Each is listed for a reason:
 * - `PATH`: the children find `node`, and `arena xmtp enable` finds `npm`;
 * - the locale and terminal ones: tool output stays readable;
 * - `TMPDIR` and `TZ`: where temporary files go, and how times print;
 * - the proxy and CA ones: the network still works where it needs them;
 * - `NODE_*`: the Node runtime's own options.
 * Everything else, a deploy key exported in the operator's shell included, never reaches a child.
 * `childEnv`'s `set` adds `HOME`, `ARENA_HOME` and `npm_config_cache` on top.
 */
const INHERITED = new Set([
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

/** A name that suggests a secret is never passed on, even one that matched the allowlist (`NODE_AUTH_TOKEN`, …). */
const SECRET_NAME = /KEY|PRIVATE|SECRET|TOKEN|PASSWORD|PASSPHRASE|MNEMONIC|SEED/i;
/** A value that looks like a raw private key is never passed on, whatever its name. */
const KEY_LIKE = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * The environment of one child: the allowlisted variables of `parent` (`INHERITED`, plus every `NODE_*`), minus any
 * whose name or value looks like a secret, then `set` on top (`HOME`, `ARENA_HOME`, `npm_config_cache`, an
 * `XMTP_SDK_URL`, …). An `undefined` in `set` removes that variable.
 */
export function childEnv(parent: NodeJS.ProcessEnv, set: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (!INHERITED.has(name) && !name.startsWith("NODE_")) continue;
    if (SECRET_NAME.test(name) || KEY_LIKE.test(value.trim())) continue;
    env[name] = value;
  }
  for (const [name, value] of Object.entries(set)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

/** A process this script started: its pid and its start time (`/proc/<pid>/stat` field 22, clock ticks since boot).
 *  Together they name one process; the pid alone can be reused by the kernel. */
export type ProcEntry = { pid: number; startTime: string };

/** `/proc/<pid>/stat`'s start time, or null if there is no such process (or no `/proc`). */
export function procStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) is parenthesised and may hold spaces: count from the last ")".
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

function procState(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? null;
  } catch {
    return null;
  }
}

function procArgs(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((s) => s !== "");
  } catch {
    return [];
  }
}

/**
 * T5 review I-2: true only if `entry` is still the process this script started. That means its start time matches,
 * it is not a zombie, and its command line holds every string in `args` (the server's bin and config, or the CLI bin
 * and `daemon`). A pid recorded without a start time (a `state.json` from before this check) is never ours. Any doubt
 * reads as "not ours", so nothing else is ever signalled.
 */
export function isOurs(entry: ProcEntry | number | undefined, args: readonly string[]): boolean {
  if (entry === undefined || typeof entry === "number") return false;
  if (!Number.isInteger(entry.pid) || entry.pid <= 1) return false;
  if (procStartTime(entry.pid) !== entry.startTime) return false;
  if (procState(entry.pid) === "Z") return false;
  const cmd = procArgs(entry.pid);
  return args.every((a) => cmd.includes(a));
}

/**
 * The checkout's HEAD and its uncommitted source files right now: other agents commit to this checkout while a run is
 * going, and a child runs whatever is on disk when it is spawned. Final review C (t5-rereview): `git` runs with `env`,
 * the same allowlist as every other child, never this process's whole environment.
 */
export function checkoutNow(repoRoot: string, env: NodeJS.ProcessEnv): string {
  // trimEnd, not trim: porcelain lines start with a status column that may be a space.
  const git = (args: string[]) => spawnSync("git", args, { cwd: repoRoot, env, encoding: "utf8" }).stdout.trimEnd();
  const dirty = git(["status", "--porcelain", "--", "packages", "apps", "contracts/src", "scripts"])
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3));
  return `${git(["rev-parse", "--short", "HEAD"])}${dirty.length > 0 ? ` + uncommitted: ${dirty.join(", ")}` : ""}`;
}

/** One transaction of a Blockscout address listing (`/api/v2/addresses/<a>/transactions`), as far as it is read. */
export type ListedTx = { hash: `0x${string}`; block_number?: number; block?: number; from?: { hash: string } };

/**
 * Final review C m-12: the hashes in one listing page that `address` sent in blocks `fromBlock`..`toBlock`, both
 * included. The run's own window: a transaction the deployer sends after the run (another stack paying with the same
 * key) is not the run's, and a `--collect-only` rerun days later must not count it.
 */
export function sentInRange(items: readonly ListedTx[], address: string, fromBlock: bigint, toBlock: bigint): Array<`0x${string}`> {
  const out: Array<`0x${string}`> = [];
  for (const t of items) {
    const b = BigInt(t.block_number ?? t.block ?? 0);
    if (b >= fromBlock && b <= toBlock && t.from?.hash?.toLowerCase() === address.toLowerCase()) out.push(t.hash);
  }
  return out;
}
