/**
 * The house bot's output redactor (`scripts/build-server.ts` bundles this file into the image's `bot-run.mjs`;
 * deploy/host/bots/house-bot.sh runs every CLI command through it): see bot-run.ts.
 */
import { botRun } from "./bot-run.js";

process.exit(await botRun(process.argv.slice(2), process.env));
