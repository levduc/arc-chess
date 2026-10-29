/**
 * The self-host image's entry point (`scripts/build-server.ts` bundles this file into `arena-host.mjs`): reads the
 * assets the build wrote next to the bundle (`share/assets.json`), then runs `hostMain` (selfhost.ts) on the
 * container's environment. A refusal, and `print-config` once it has printed, end the process; a running server
 * keeps it alive until SIGTERM.
 */
import { readFileSync } from "node:fs";
import { hostMain, type HostAssets } from "./selfhost.js";

const assets = JSON.parse(readFileSync(new URL("./share/assets.json", import.meta.url), "utf8")) as HostAssets;
const argv = process.argv.slice(2);
const code = await hostMain(argv, process.env, assets);
if (code !== 0 || argv[0] === "print-config") process.exit(code);
