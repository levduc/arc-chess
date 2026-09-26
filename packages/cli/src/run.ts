import type { Server } from "node:http";
import { startApi } from "./api.js";
import { loadConfig, loadToken, loadWalletKey } from "./config.js";
import { ArenaDaemon } from "./daemon.js";
import { connectHost, type HostConnection, type HostOptions } from "./host.js";
import { acquireHomeLock } from "./lock.js";

export type DaemonProcess = {
  daemon: ArenaDaemon;
  apiUrl: string;
  host: HostConnection;
  stop(): Promise<void>;
};

/**
 * Wires up one ARENA_HOME's daemon end to end (spec §6): the home lock, the host transports, the `ArenaDaemon`
 * and its local API. On any failure partway through, everything already started is torn down, in the reverse of
 * the order it was started, before the error propagates.
 */
export async function startDaemonProcess(
  home: string,
  opts: { log?: (l: string) => void; host?: HostOptions } = {},
): Promise<DaemonProcess> {
  const lock = acquireHomeLock(home);
  let host: HostConnection | undefined;
  let daemon: ArenaDaemon | undefined;
  let server: Server | undefined;
  try {
    const config = loadConfig(home);
    const walletKey = loadWalletKey(home);
    const token = loadToken(home);

    host = connectHost(config.serverUrl, { log: opts.log, ...opts.host });
    daemon = new ArenaDaemon({ home, config, walletKey, lobby: host.lobby, relay: host.relay, log: opts.log });
    await daemon.start();

    // 127.0.0.1 only: `host` is deliberately not configurable here (spec §6.1) -- `arena daemon` never exposes
    // a host override.
    const api = await startApi(daemon, { port: config.port, token });
    server = api.server;

    let stopped = false;
    const daemonRef = daemon;
    const hostRef = host;
    const serverRef = server;
    return {
      daemon: daemonRef,
      apiUrl: api.url,
      host: hostRef,
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
      if (host) host.close();
      lock.release();
    }
    throw err;
  }
}
