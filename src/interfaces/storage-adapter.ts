// StorageAdapter — dumb document I/O. One of the three orthogonal interfaces.
//
// "Dumb" means NO derived intelligence: there is deliberately no search here
// (search belongs to IndexProvider). The adapter only knows how to persist and
// retrieve whole notes, and how to version those writes.
//
// It resolves a note's uid → its on-disk location internally, so an Obsidian file
// rename never breaks a reference (identity = frontmatter.uid, not the filename).
//
// Swapping FileSystemAdapter → GitHubAdapter/S3Adapter must require ZERO changes to
// tools or engine. That is why versioning lives behind this seam:
//
//   • commit() is a separate step from write() so the engine can order side-effects
//     explicitly (write → commit → index) with real try/catch. The engine calls
//     storage.commit(msg); it does NOT know the implementation is simple-git.
//   • A GitHubAdapter versions inherently (an API write IS a commit); a FileSystem
//     adapter uses simple-git. Either way the engine code is identical.

import type { Note, StoredNote, NoteRef, NoteStat, Frontmatter } from "../types.js";

/** A Markdown file that has no frontmatter uid yet — a bootstrap candidate. */
export interface RawNote {
  path: string;
  title: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

/**
 * Result of a checkpoint. `hash` is an OPAQUE identifier for it (a git SHA for
 * FileSystemAdapter). It MAY be an empty string for adapters that do not version.
 */
export interface CommitInfo {
  hash: string;
  message: string;
}

export interface StorageAdapter {
  /**
   * Read a note by its uid. Returns null if no note with that uid exists.
   * Resolution is by frontmatter uid, not filename.
   */
  read(uid: string): Promise<StoredNote | null>;

  /**
   * Persist a note (create or overwrite), keyed by note.frontmatter.uid.
   * PURE I/O: this does NOT commit and does NOT touch the index — the engine
   * orchestrates those. Returns the stored note including its new content_hash,
   * so the engine can refresh the write-guard baseline without a second stat.
   */
  write(note: Note): Promise<StoredNote>;

  /** List lightweight metadata for every note in the vault (drives reindex / scanning). */
  list(): Promise<NoteRef[]>;

  /**
   * Read EVERY note in one pass. Same result as list() + read() per uid, but a single scan
   * instead of one full scan per note — read() resolves a uid by scanning the whole vault, so
   * the naive loop is quadratic. Enforces the same uid-uniqueness contract as read().
   */
  readAll(): Promise<StoredNote[]>;

  /** Stat a single note (content hash + timestamps) for external-edit detection. Null if absent. */
  stat(uid: string): Promise<NoteStat | null>;

  /**
   * Record a durable, message-tagged CHECKPOINT of the current state and return it.
   *
   * Weak contract, by design: the engine must NOT assume git-specific atomic or
   * staged semantics. Implementations are free to no-op —
   *   • a GitHubAdapter where write() already IS a commit returns that commit and
   *     no-ops here;
   *   • an S3Adapter with no native versioning no-ops and returns an empty hash.
   * FileSystemAdapter implements it as a git commit. Called by the engine as the
   * second step of applyMutation, immediately after write().
   */
  commit(message: string): Promise<CommitInfo>;

  /**
   * Bootstrap: for every Markdown file lacking a frontmatter uid, rewrite it IN PLACE with
   * frontmatter produced by `assign` (the caller mints the uid and chooses defaults — the
   * adapter never decides a note's type). Title/body/path are preserved. Returns assigned uids.
   */
  identifyAll(assign: (raw: RawNote) => Frontmatter): Promise<string[]>;
}
