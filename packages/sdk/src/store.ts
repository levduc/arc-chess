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
};

export interface SessionStore {
  save(snapshot: SessionSnapshot): Promise<void>;
}

/** In-memory store for tests and ephemeral sessions. The daemon (Plan 3) provides a file-backed store. */
export class MemoryStore implements SessionStore {
  readonly snapshots: SessionSnapshot[] = [];

  async save(snapshot: SessionSnapshot): Promise<void> {
    this.snapshots.push(structuredClone(snapshot));
  }

  get last(): SessionSnapshot | undefined {
    return this.snapshots.at(-1);
  }
}
