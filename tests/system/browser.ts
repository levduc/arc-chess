/**
 * Plan 5 Task 4: a small launcher for the browser end-to-end tests. It drives the locally installed Google Chrome
 * through playwright-core. No browser is ever downloaded (`playwright install` is forbidden, Global Constraints):
 * the executable is `/usr/bin/google-chrome-stable`, or `$ARENA_CHROME` if set. When it is missing, the tests skip
 * with a message instead of failing.
 */
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext } from "playwright-core";

export const CHROME_PATH = process.env.ARENA_CHROME ?? "/usr/bin/google-chrome-stable";

/** True when there is no Chrome to drive: the browser suites `describe.skip`, naming the path they looked for. */
export const skipIfNoChrome = !existsSync(CHROME_PATH);

export const NO_CHROME_MESSAGE = `skipped: no Chrome at ${CHROME_PATH} (set ARENA_CHROME to a Chrome/Chromium executable)`;

/**
 * Launches headless Chrome. `args` are extra command-line switches, e.g. `--host-resolver-rules` so that a
 * made-up host name resolves to a loopback address (the hostile-origin and DNS-rebinding checks).
 */
export async function launchChrome(opts: { args?: string[] } = {}): Promise<Browser> {
  return chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    ...(opts.args && opts.args.length > 0 ? { args: opts.args } : {}),
  });
}

/**
 * Final fix wave (M1): headless Chrome on a real, on-disk profile (`userDataDir`), so a test can read what the browser
 * persisted -- its `Default/History` SQLite database -- once the context is closed.
 */
export async function launchChromeWithProfile(userDataDir: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, { executablePath: CHROME_PATH, headless: true });
}
