import type { Server } from "node:http";
import { join } from "node:path";
import type { Hex } from "viem";
import type { RelayClient, RelayMessage } from "@arena/sdk";
import { startApi } from "./api.js";
import { loadToken, loadWalletKey, readConfig, type XmtpConfig } from "./config.js";
import { ArenaDaemon } from "./daemon.js";
import { connectHost, type HostConnection, type HostOptions } from "./host.js";
import { acquireHomeLock } from "./lock.js";
import { FallbackRelay, type ChannelTransport } from "./xmtp/fallback.js";
import { loadXmtpSdk, type XmtpSdkLoad } from "./xmtp/loader.js";
import { createNodeSdkTransport, type XmtpTransport } from "./xmtp/transport.js";

export type DaemonProcess = {
  daemon: ArenaDaemon;
  apiUrl: string;
  host: HostConnection;
  /** Plan 5.7: the relay the daemon was given -- `host.relay` itself, or a `FallbackRelay` over it. */
  relay: RelayClient;
  /** Plan 5.7 (spec §2): `"xmtp"` when `config.xmtp` is set and the SDK loaded, else `"off"`. */
  fallback: "xmtp" | "off";
  /** Plan 5.7 (I-2): why `fallback` is `"off"` (absent when it is `"xmtp"`). */
  fallbackReason?: string;
  stop(): Promise<void>;
};

/** Plan 5.7: seams for tests -- the SDK loader and the transport factory (defaults: the real ones). */
export type XmtpWiring = {
  load?: (home: string) => Promise<XmtpSdkLoad>;
  transport?: (opts: { sdk: unknown; dbDir: string; config: XmtpConfig; log(l: string): void }) => XmtpTransport;
};

/**
 * Wires up one ARENA_HOME's daemon end to end (spec §6): the home lock, the host transports, the `ArenaDaemon`
 * and its local API. On any failure partway through, everything already started is torn down, in the reverse of
 * the order it was started, before the error propagates.
 */
export async function startDaemonProcess(
  home: string,
  opts: { log?: (l: string) => void; host?: HostOptions; xmtp?: XmtpWiring } = {},
): Promise<DaemonProcess> {
  const lock = acquireHomeLock(home);
  let host: HostConnection | undefined;
  let fallback: FallbackRelay | undefined;
  let daemon: ArenaDaemon | undefined;
  let server: Server | undefined;
  try {
    const { config, xmtpProblem } = readConfig(home);
    const walletKey = loadWalletKey(home);
    const token = loadToken(home);

    host = connectHost(config.serverUrl, { log: opts.log, ...opts.host });
    const hostRelay = host.relay;
    let relay: RelayClient = hostRelay;
    let transportOf = (id: Hex): ChannelTransport => (hostRelay.isJoined(id) ? "relay" : "none");
    let relayRejected: ((msg: RelayMessage) => boolean) | undefined;
    let relayUndetermined: ((msg: RelayMessage) => boolean) | undefined;
    let armFallback: ((id: Hex) => void) | undefined;
    let xmtpDroppedOf: ((id: Hex) => number) | undefined;
    let fallbackReason: string | undefined = "the XMTP fallback is not configured (config.json has no xmtp)";
    // Plan 5.7 (m-7): an invalid `xmtp` in config.json turns the fallback off, logged once -- never stops the daemon.
    if (xmtpProblem !== null) {
      (opts.log ?? (() => undefined))(`xmtp: fallback off: ${xmtpProblem}`);
      fallbackReason = xmtpProblem;
    }
    // Plan 5.7 (spec §4): the XMTP fallback, only when the host published `xmtp` (cached by init) and the SDK
    // loads. Otherwise the daemon gets the host relay itself, exactly as before.
    if (config.xmtp) {
      const log = opts.log ?? (() => undefined);
      const loaded = await (opts.xmtp?.load ?? loadXmtpSdk)(home);
      if (loaded.ok) {
        const transport = (opts.xmtp?.transport ?? createNodeSdkTransport)({
          sdk: loaded.sdk,
          dbDir: join(home, "xmtp", "db"),
          config: config.xmtp,
          log,
        });
        const fb = new FallbackRelay({ host: hostRelay, xmtp: transport, log });
        fallback = fb;
        relay = fb;
        transportOf = (id) => fb.transportOf(id);
        relayRejected = (msg) => fb.countRejected(msg);
        relayUndetermined = (msg) => fb.isUndetermined(msg);
        // Spec §3 (I-1): a channel's XMTP client starts once the daemon sees it Open on chain, never at match time.
        armFallback = (id) => fb.arm(id);
        xmtpDroppedOf = (id) => fb.dropped(id);
        fallbackReason = undefined;
        log(`xmtp: fallback on (env ${config.xmtp.env}, node-sdk ${loaded.version})`);
      } else {
        fallbackReason = loaded.reason;
        log(`xmtp: fallback off: ${loaded.reason}`);
      }
    }
    daemon = new ArenaDaemon({
      home,
      config,
      walletKey,
      lobby: host.lobby,
      relay,
      log: opts.log,
      transportOf,
      fallback: fallback ? "xmtp" : "off",
      relayRejected,
      relayUndetermined,
      armFallback,
      xmtpDroppedOf,
      fallbackReason,
    });
    await daemon.start();

    // 127.0.0.1 only: `host` is deliberately not configurable here (spec §6.1) -- `arena daemon` never exposes
    // a host override.
    const api = await startApi(daemon, { port: config.port, token });
    server = api.server;

    let stopped = false;
    const daemonRef = daemon;
    const hostRef = host;
    const serverRef = server;
    const fallbackRef = fallback;
    return {
      daemon: daemonRef,
      apiUrl: api.url,
      host: hostRef,
      relay,
      fallback: fallbackRef ? "xmtp" : "off",
      ...(fallbackReason !== undefined ? { fallbackReason } : {}),
      stop: async () => {
        if (stopped) return;
        stopped = true;
        // `host.close()` and `lock.release()` must run even if closing the api server or stopping the daemon
        // throws -- otherwise a failed shutdown step would leave the reconnect loop running and/or the home
        // permanently locked.
        try {
          serverRef.closeAllConnections();
          await new Promise<void>((resolve) => serverRef.close(() => resolve()));
          await daemonRef.stop();
        } finally {
          await stopFallback(fallbackRef, opts.log);
          hostRef.close();
          lock.release();
        }
      },
    };
  } catch (err) {
    // Reverse of the start order: server, then daemon, then host, then the lock. `host.close()` and
    // `lock.release()` are in their own `finally` so they always run, even if closing the server or stopping the
    // daemon throws partway through this cleanup.
    try {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
      }
      if (daemon) await daemon.stop();
    } finally {
      await stopFallback(fallback, opts.log);
      if (host) host.close();
      lock.release();
    }
    throw err;
  }
}

/** How long a shutdown waits for the XMTP clients to stop (a client mid-start on a slow network) before moving on. */
const XMTP_STOP_WAIT_MS = 5_000;

/** Stops the XMTP clients, if any. Never throws and waits at most `XMTP_STOP_WAIT_MS`, so the host close and the
 *  lock release after it always run, and promptly. */
async function stopFallback(fallback: FallbackRelay | undefined, log?: (l: string) => void): Promise<void> {
  if (!fallback) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopping = fallback.stop().catch((err: unknown) => {
    log?.(`xmtp: stop failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log?.(`xmtp: stop still pending after ${XMTP_STOP_WAIT_MS} ms; moving on`);
      resolve();
    }, XMTP_STOP_WAIT_MS);
    timer.unref?.();
  });
  await Promise.race([stopping, waited]);
  clearTimeout(timer);
}
