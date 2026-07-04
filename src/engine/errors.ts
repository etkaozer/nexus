// Engine-level errors.

/**
 * Thrown by the write guard when an upsert would overwrite a note that was edited on
 * disk (in Obsidian) since Nexus last indexed it. Nexus never clobbers an external edit;
 * the caller must reindex first so the change is absorbed, then retry.
 */
export class WriteGuardError extends Error {
  constructor(readonly uid: string) {
    super(
      `Refusing to overwrite note ${uid}: it was modified on disk since it was last indexed ` +
        `(an external Obsidian edit). Run reindex({ uid: "${uid}" }) first to absorb the change, ` +
        `then retry — Nexus never clobbers an external edit.`,
    );
    this.name = "WriteGuardError";
  }
}
