import type { Hex } from "viem";
import type { SignedState } from "./types.js";

/** Everything a session needs to resume after a crash. Saved before any signature leaves the session. */
export type SessionSnapshot = {
  channelId: Hex;
  /** Latest state that is supported: opening, fully signed checkpoint, or a move signed by its mover. */
  latest: SignedState;
  /** The state before `latest`, carrying the signature that proves the other player endorsed it. */
  prev: SignedState | null;
  /** NEW_GAME this player proposed and signed, awaiting the opponent's countersignature. */
  pendingCheckpoint: SignedState | null;
  /** NEW_GAME the opponent proposed and signed, awaiting this player's decision. */
  incomingCheckpoint: SignedState | null;
  /** Highest turnNum this player has signed (equivocation guard). */
  lastSignedTurn: bigint | null;
  /** State this player signed Close for; nothing is signed afterwards. */
  closeState: SignedState | null;
  /** Close signatures by player index ("0x" = absent). */
  closeSigs: [Hex, Hex];
  /**
   * The exact state hash each entry of `closeSigs` was verified against when it was stored (own signature: the
   * state just signed; opponent signature: the target checked in `receiveClose`). Cleared whenever `latest`
   * changes so a signature captured against a state that is no longer current can never be paired with a later
   * `closeState` in `closeTransaction` (fix for a stale-signature pairing defect).
   */
  closeSigTargets: [Hex, Hex];
};

export interface SessionStore {
  save(snapshot: SessionSnapshot): Promise<void>;
}

/**
 * A per-channel store that can also read back the last saved snapshot (file store in the daemon).
 *
 * `load()` returns `null` ONLY when no snapshot has ever been saved for this channel; a store that has one but
 * cannot read or parse it (corrupt file, I/O error) must throw rather than return `null`, since `ChannelSession
 * .open()` treats `null` as "create a fresh channel" — silently discarding a real, if unreadable, history.
 *
 * Exactly one `ChannelSession` must own a given store (and thus a given channel) at a time: `save()` calls are
 * not coordinated across instances, so two sessions sharing one store could interleave writes and each observe a
 * stale snapshot.
 */
export interface LoadableSessionStore extends SessionStore {
  load(): Promise<SessionSnapshot | null>;
}

/** In-memory store for tests and ephemeral sessions. The daemon (Plan 3) provides a file-backed store. */
export class MemoryStore implements LoadableSessionStore {
  readonly snapshots: SessionSnapshot[] = [];

  async save(snapshot: SessionSnapshot): Promise<void> {
    this.snapshots.push(structuredClone(snapshot));
  }

  async load(): Promise<SessionSnapshot | null> {
    const last = this.snapshots.at(-1);
    return last ? structuredClone(last) : null;
  }

  get last(): SessionSnapshot | undefined {
    return this.snapshots.at(-1);
  }
}
