// IndexProvider — the DERIVED search index (vector + lexical). One of the three
// orthogonal interfaces. Entirely separate from StorageAdapter.
//
// It DEPENDS ON an EmbeddingProvider (it uses it; they are not siblings):
//   • indexChunks() embeds each chunk's content as a "passage" — internally.
//   • vectorSearch()/neighbors() embed the query as a "query" — internally.
// The passage:/query: prefixing is therefore invisible here; this interface only
// ever picks a `kind`, never a prefix string. Swapping the embedding model must
// require zero changes to this interface or its callers (reindex heals stale rows).
//
// Everything this store holds is derived from Markdown and rebuildable by `reindex`
// with zero information loss.

import type { Chunk, NoteType, NoteSource, NoteStatus } from "../types.js";
import type { SimilarityCalibration } from "./embedding-provider.js";

/**
 * Filterable / returnable note-level metadata, mirrored into the index so search
 * can filter (type/project) and build SearchHits (title/source/verified) without a
 * round-trip to storage. Purely derived from frontmatter.
 */
export interface NoteIndexMeta {
  uid: string;
  title: string;
  type: NoteType;
  project?: string;
  source: NoteSource;
  verified: boolean;
  status: NoteStatus;
  /** frontmatter.updated (ISO-8601). Orders the vault manifest by recency. */
  updated: string;
  /** uid of the note that replaced this one, so search hits can carry the pointer. */
  superseded_by?: string;
  /**
   * Whole-note content hash as of the last index. The write guard compares this to
   * the current on-disk hash to detect an out-of-band Obsidian edit.
   */
  content_hash: string;
}

/**
 * Everything the mirrored note metadata knows EXCEPT content_hash. Used by the
 * metadata backfill, which must never touch the write-guard baseline: rewriting
 * content_hash from disk would silently forgive an unindexed Obsidian edit and let
 * the next upsert clobber it.
 */
export type NoteMetaPatch = Omit<NoteIndexMeta, "content_hash">;

/**
 * One row of the vault manifest — note-level metadata only, no chunks, no vectors,
 * no query. A projection of what is already mirrored here, not a new source of truth.
 */
export interface NoteSummary {
  uid: string;
  title: string;
  type: NoteType;
  project?: string;
  status: NoteStatus;
  /** null for rows written before `updated` was mirrored; such rows sort last. */
  updated: string | null;
}

/** Stored state of a chunk, for hash-diff reindex decisions (made by the ChangeDetector). */
export interface ChunkState {
  chunk_id: string;
  note_uid: string;
  content_hash: string;
  /** Model that produced this chunk's vector. If ≠ current model, the chunk is stale. */
  embedding_model: string;
}

export interface IndexSearchOptions {
  k: number;
  /** Metadata filter. */
  type?: NoteType;
  /** Metadata filter. */
  project?: string;
}

/** A raw retrieval hit at chunk granularity. HybridRetriever fuses these; the engine maps to SearchHit. */
export interface ScoredChunk {
  chunk_id: string;
  note_uid: string;
  title: string;
  project?: string;
  heading: string | null;
  /** Chunk text, used to build the snippet. */
  content: string;
  source: NoteSource;
  verified: boolean;
  status: NoteStatus;
  superseded_by?: string;
  /**
   * Arm-dependent, and NOT comparable across arms: a cosine similarity from
   * vectorSearch/neighbors, a negated BM25 from lexicalSearch. Only the caller knows
   * which arm produced it, so only the caller may interpret it as a similarity.
   */
  score: number;
}

export interface IndexProvider {
  /** Mirror a note's filterable/returnable metadata into the index. */
  putNoteMeta(meta: NoteIndexMeta): Promise<void>;

  /**
   * Refresh mirrored metadata for an ALREADY-INDEXED note, leaving content_hash untouched
   * (see NoteMetaPatch). No-ops when the uid is not in the index — an unindexed note is
   * reindex's job, not this one's. Returns true when a row was updated.
   */
  patchNoteMeta(meta: NoteMetaPatch): Promise<boolean>;

  /**
   * Note-level rows for the vault manifest, newest-updated first. A pure projection —
   * no query, no embedding, no chunk access.
   */
  listNoteSummaries(): Promise<NoteSummary[]>;

  /**
   * How many indexed notes predate the metadata the manifest needs (no mirrored `updated`).
   * Non-zero means an index written by an older build: the manifest would be recency-blind
   * until a backfill runs. Zero on a fresh or already-backfilled index.
   */
  countUnbackfilledNotes(): Promise<number>;

  /**
   * Add/update the given chunks: embed each as a "passage" (via the EmbeddingProvider),
   * write the vector row + the FTS5 row, and record embedding_model + content_hash.
   * The CALLER (ChangeDetector) passes only the chunks that actually need (re)embedding;
   * this method does not decide staleness itself.
   */
  indexChunks(chunks: Chunk[]): Promise<void>;

  /** Remove specific chunks (e.g. sections deleted from a note during reindex). */
  deleteChunks(chunkIds: string[]): Promise<void>;

  /** Remove every chunk + metadata belonging to a note. */
  deleteNote(uid: string): Promise<void>;

  /**
   * Current stored chunk state, scoped to one note when `uid` is given, else the whole
   * index. Lets the ChangeDetector decide what changed (content_hash) or went stale
   * (embedding_model ≠ current model).
   */
  getChunkStates(uid?: string): Promise<ChunkState[]>;

  /** Last-indexed whole-note content hash, for the write guard. Null if the note is not indexed. */
  getNoteHash(uid: string): Promise<string | null>;

  /** Vector KNN over chunk embeddings. Embeds `query` as a "query" internally. */
  vectorSearch(query: string, opts: IndexSearchOptions): Promise<ScoredChunk[]>;

  /** Lexical BM25 (FTS5) search over chunk content + headings. No embeddings involved. */
  lexicalSearch(query: string, opts: IndexSearchOptions): Promise<ScoredChunk[]>;

  /** Vector neighbours of a note (feeds related_auto). Excludes the note's own chunks. */
  neighbors(uid: string, k: number): Promise<ScoredChunk[]>;

  /** The embedding model currently backing this index (proxied from its EmbeddingProvider). */
  readonly embeddingModel: string;

  /**
   * Calibration for the cosines this index's vector arm returns, proxied from the same
   * EmbeddingProvider. Travels with the model, so a swap carries its own numbers instead of
   * leaving a stale sentence behind. Undefined when the provider declines to state one.
   */
  readonly similarityCalibration?: SimilarityCalibration | undefined;
}
