import type { LoadableSessionStore, SessionSnapshot } from "@arena/sdk";
import { readJson, writeJsonAtomic } from "./jsonfile.js";

/** One channel's session snapshot on disk; written atomically before any signature leaves the session. */
export class FileSessionStore implements LoadableSessionStore {
  constructor(private readonly path: string) {}

  async save(snapshot: SessionSnapshot): Promise<void> {
    writeJsonAtomic(this.path, snapshot);
  }

  async load(): Promise<SessionSnapshot | null> {
    return readJson<SessionSnapshot>(this.path);
  }
}
