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
  /**
   * Whole-note content hash as of the last index. The write guard compares this to
   * the current on-disk hash to detect an out-of-band Obsidian edit.
   */
  content_hash: string;
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
  heading: string | null;
  /** Chunk text, used to build the snippet. */
  content: string;
  source: NoteSource;
  verified: boolean;
  score: number;
}

export interface IndexProvider {
  /** Mirror a note's filterable/returnable metadata into the index. */
  putNoteMeta(meta: NoteIndexMeta): Promise<void>;

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
}
