// Shared domain types for Nexus. Types only — no behaviour lives here.
//
// The Markdown files on disk are the single source of truth. Everything in this
// file describes either (a) how a note is represented in memory, or (b) the shape
// of the DERIVED, rebuildable index. Nothing here should imply that any of it is
// authoritative over the Markdown.

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter — the authoritative, on-disk metadata of every note.
// ─────────────────────────────────────────────────────────────────────────────

/** The kind of a note. The CALLER decides this — the MCP never infers a note's type. */
export type NoteType =
  | "decision"
  | "principle"
  | "project-note"
  | "idea"
  | "reference"
  | "inbox";

export type NoteStatus = "active" | "archived" | "superseded";

export type NoteSource = "claude" | "chatgpt" | "gemini" | "repo" | "manual";

/**
 * Frontmatter present on every note. Property names match the YAML keys 1:1 so
 * there is no hidden mapping layer between disk and memory.
 */
export interface Frontmatter {
  /** Stable ULID/UUID — the REAL identity of the note. Never the filename. */
  uid: string;
  type: NoteType;
  /** Optional project slug, e.g. "trading-bot", "visioncall". */
  project?: string;
  status: NoteStatus;
  source: NoteSource;
  /** false = captured as-is (unverified); true = human-curated/verified. */
  verified: boolean;
  /** uid of the note this one replaces (set on the superseding note). */
  supersedes?: string;
  /** uid of the note that replaced this one (reverse pointer, set on the superseded note). */
  superseded_by?: string;
  /** ISO-8601 creation timestamp. */
  created: string;
  /** ISO-8601 last-update timestamp. */
  updated: string;
  tags?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Note — a note as it lives in memory / on the storage medium.
// ─────────────────────────────────────────────────────────────────────────────

/** A note in memory: display title + frontmatter + markdown body (frontmatter stripped). */
export interface Note {
  /**
   * Display title. Maps to the note's filename in Obsidian. Purely cosmetic —
   * identity always lives in `frontmatter.uid`, so an Obsidian rename cannot
   * break references.
   */
  title: string;
  frontmatter: Frontmatter;
  /** Markdown body with the YAML frontmatter block removed. */
  body: string;
}

/** A note as it currently exists on the storage medium. */
export interface StoredNote extends Note {
  /** Storage-internal locator (filesystem path / object key). Surfaced for logs & debugging. */
  path: string;
  /**
   * Hash of the RAW on-disk document (frontmatter + body). This is the value the
   * write guard compares against to detect out-of-band edits made in Obsidian.
   */
  content_hash: string;
}

/** Lightweight note metadata — lets reindex scan the vault without loading every body. */
export interface NoteRef {
  uid: string;
  path: string;
  content_hash: string;
  updated: string;
}

/** Single-note stat, used by the write guard's external-edit detection. */
export interface NoteStat {
  uid: string;
  path: string;
  content_hash: string;
  updated: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunk — a unit of retrievable text derived from a note body.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produced by the ChunkManager. Embeddings are NOT part of a Chunk — they are
 * added later, inside the IndexProvider. A Chunk is pure derived text + identity.
 */
export interface Chunk {
  /**
   * `<note-uid>::<stable-slug>#<ordinal>`. Stable across heading renames because
   * the slug is persisted (as an invisible `^cid-xxxx` block-ref) and never
   * recomputed from the heading text.
   */
  chunk_id: string;
  note_uid: string;
  /** Heading text this chunk lives under; `null` for the pre-heading `__preamble` chunk. */
  heading: string | null;
  /** The persisted stable slug (the `cid-xxxx` value). Never derived from heading text. */
  slug: string;
  /** Disambiguates duplicate headings and oversize sub-splits within a single note. */
  ordinal: number;
  /** The chunk's text — this is what gets embedded (as a "passage"). */
  content: string;
  /** Hash of `content`. Drives idempotent, diff-based reindex. */
  content_hash: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Query path — search & read result shapes.
// ─────────────────────────────────────────────────────────────────────────────

export type SearchMode = "hybrid" | "vector" | "lexical";

export interface SearchOptions {
  /** Metadata filter. */
  type?: NoteType;
  /** Metadata filter. */
  project?: string;
  /** Number of hits to return. */
  k?: number;
  /** hybrid (default) fuses vector + lexical so rare proper nouns (MEXC, SessionDO) still hit. */
  mode?: SearchMode;
}

export interface SearchHit {
  uid: string;
  title: string;
  heading: string | null;
  snippet: string;
  score: number;
  source: NoteSource;
  verified: boolean;
}

export interface Backlink {
  uid: string;
  title: string;
}

export interface RelatedNote {
  uid: string;
  title: string;
  score: number;
}

export interface ReadResult {
  frontmatter: Frontmatter;
  body: string;
  /** Authored wikilink graph: notes that link TO this note. Kept strictly separate from related_auto. */
  backlinks: Backlink[];
  /** Vector neighbours (derived, regenerable). Never merged into the authored links. */
  related_auto: RelatedNote[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutation path — the only shapes accepted by engine.applyMutation().
// ─────────────────────────────────────────────────────────────────────────────

export type MutationAction = "create" | "update" | "archive" | "link" | "supersede";

export interface UpsertMutation {
  kind: "upsert";
  /** Omitted → create a NEW note (mint a uid). Present → overwrite exactly that note, nothing else. */
  uid?: string;
  title: string;
  type: NoteType;
  project?: string;
  body: string;
  source: NoteSource;
  /** uid this note replaces; the superseded note is archived and the two are cross-linked. */
  supersedes?: string;
}

export interface ArchiveMutation {
  kind: "archive";
  uid: string;
}

export interface LinkMutation {
  kind: "link";
  from_uid: string;
  to_uid: string;
  relation?: string;
}

/** Discriminated union of every mutation the engine can apply. */
export type Mutation = UpsertMutation | ArchiveMutation | LinkMutation;

export interface MutationResult {
  /** Primary note affected (created/updated/archived, or the `from` note of a link). */
  uid: string;
  action: MutationAction;
  /** Every note touched by this mutation (e.g. includes the superseded note on a supersede). */
  affected_uids: string[];
  /** Hash of the git commit that recorded this mutation — the audit-log entry. */
  commit: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reindex — rebuild the derived index from Markdown.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReindexOptions {
  /** Reindex a single note; omit for a full rebuild from Markdown. */
  uid?: string;
}

export interface ReindexResult {
  notes_scanned: number;
  chunks_reembedded: number;
  chunks_deleted: number;
  /** Of the re-embedded chunks, how many were stale ONLY because the embedding model changed. */
  chunks_reembedded_model_change: number;
}
