// SqliteIndexProvider — the default IndexProvider. One file (brain.db) holding three
// derived, rebuildable structures:
//   • chunks     — a plain table of chunk rows (+ mirrored note metadata in `notes`)
//   • vec_chunks — a sqlite-vec vec0 table for cosine KNN over e5 vectors
//   • fts_chunks — an FTS5 table for exact/rare-token lexical (BM25) search
//
// It OWNS and USES an EmbeddingProvider: indexChunks embeds chunk content as "passage",
// vectorSearch/neighbors embed the query as "query". The passage:/query: prefixing is
// invisible here — this class only ever picks a `kind`.
//
// Everything here is derivable from Markdown; `reindex` (M4) rebuilds it with no loss.

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { nativeBindingOption } from "./native-binding.js";
import type {
  IndexProvider,
  NoteIndexMeta,
  NoteMetaPatch,
  NoteSummary,
  ChunkState,
  IndexSearchOptions,
  ScoredChunk,
} from "../interfaces/index-provider.js";
import type { EmbeddingProvider, SimilarityCalibration } from "../interfaces/embedding-provider.js";
import type { Chunk, NoteSource, NoteStatus, NoteType } from "../types.js";

type DB = Database.Database;

/** Convert an embedding vector to the compact float32 blob sqlite-vec stores/matches. */
function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Bind parameters shared by putNoteMeta and patchNoteMeta, so the two cannot drift. */
function metaParams(meta: NoteMetaPatch): Record<string, string | number | null> {
  return {
    uid: meta.uid,
    title: meta.title,
    type: meta.type,
    project: meta.project ?? null,
    source: meta.source,
    verified: meta.verified ? 1 : 0,
    status: meta.status,
    updated: meta.updated,
    superseded_by: meta.superseded_by ?? null,
  };
}

/** Build an FTS5 MATCH string: unicode-aware tokens, quoted, OR-joined for recall. */
function buildFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR ");
}

interface JoinRow {
  chunk_id: string;
  note_uid: string;
  heading: string | null;
  content: string;
  title: string;
  source: string;
  verified: number;
  type: string;
  project: string | null;
  status: string;
  superseded_by: string | null;
  metric: number; // distance (vector) or bm25 (lexical)
}

/** The note columns every retrieval join needs. One definition so the arms cannot drift apart. */
const NOTE_COLUMNS = `n.title, n.source, n.verified, n.type, n.project, n.status, n.superseded_by`;

export class SqliteIndexProvider implements IndexProvider {
  private readonly db: DB;
  private readonly embeddings: EmbeddingProvider;

  /** Live current model — reflects a model swap immediately, so reindex can heal stale vectors. */
  get embeddingModel(): string {
    return this.embeddings.model;
  }

  /** Proxied live, exactly like embeddingModel: a model swap brings its own calibration. */
  get similarityCalibration(): SimilarityCalibration | undefined {
    return this.embeddings.similarityCalibration;
  }

  constructor(dbPath: string, embeddings: EmbeddingProvider) {
    this.embeddings = embeddings;
    // nativeBindingOption() is empty in a dev checkout, so this is the plain `new Database(dbPath)`
    // it has always been. Inside a packed MCPB it names the binding built for THIS Node's ABI —
    // see native-binding.ts for why the bundled default cannot be trusted.
    this.db = new Database(dbPath, nativeBindingOption());
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    sqliteVec.load(this.db);
    this.migrate(embeddings.dim);
  }

  private migrate(dim: number): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        uid          TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        type         TEXT NOT NULL,
        project      TEXT,
        source       TEXT NOT NULL,
        verified     INTEGER NOT NULL,
        status       TEXT NOT NULL,
        content_hash TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        chunk_id        TEXT UNIQUE NOT NULL,
        note_uid        TEXT NOT NULL,
        heading         TEXT,
        ordinal         INTEGER NOT NULL,
        content         TEXT NOT NULL,
        content_hash    TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        dim             INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_note ON chunks(note_uid);

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(heading, content);
    `);
    // vec0 dimension must be a literal in the DDL; take it from the provider.
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(` +
        `chunk_id TEXT PRIMARY KEY, embedding float[${dim}] distance_metric=cosine)`,
    );

    // Additive migrations. Deliberately NOT folded into the CREATE TABLE above: running the
    // same ALTER path on a fresh database and on a user's existing brain.db means both end up
    // with byte-identical schemas, and the legacy path is exercised by every test run rather
    // than only on a real upgrade. Both columns are nullable — an index written by an older
    // build stays readable, it just reports itself unbackfilled (see countUnbackfilledNotes).
    this.addColumn("notes", "updated", "TEXT");
    this.addColumn("notes", "superseded_by", "TEXT");
  }

  /** Add a column if the table lacks it. Idempotent, and safe on a populated table. */
  private addColumn(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  async putNoteMeta(meta: NoteIndexMeta): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO notes (uid, title, type, project, source, verified, status, updated, superseded_by, content_hash)
         VALUES (@uid, @title, @type, @project, @source, @verified, @status, @updated, @superseded_by, @content_hash)
         ON CONFLICT(uid) DO UPDATE SET
           title=@title, type=@type, project=@project, source=@source,
           verified=@verified, status=@status, updated=@updated,
           superseded_by=@superseded_by, content_hash=@content_hash`,
      )
      .run({ ...metaParams(meta), content_hash: meta.content_hash });
  }

  async patchNoteMeta(meta: NoteMetaPatch): Promise<boolean> {
    // UPDATE, never UPSERT, and content_hash is absent from the SET list on purpose: this runs
    // against notes already on disk, and rewriting the write-guard baseline here would forgive
    // an unindexed Obsidian edit — the next upsert would clobber it instead of refusing.
    const info = this.db
      .prepare(
        `UPDATE notes SET title=@title, type=@type, project=@project, source=@source,
           verified=@verified, status=@status, updated=@updated, superseded_by=@superseded_by
         WHERE uid=@uid`,
      )
      .run(metaParams(meta));
    return info.changes > 0;
  }

  async listNoteSummaries(): Promise<NoteSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT uid, title, type, project, status, updated FROM notes
         ORDER BY updated IS NULL, updated DESC, title ASC`,
      )
      .all() as {
      uid: string;
      title: string;
      type: string;
      project: string | null;
      status: string;
      updated: string | null;
    }[];
    return rows.map((r) => {
      const s: NoteSummary = {
        uid: r.uid,
        title: r.title,
        type: r.type as NoteType,
        status: r.status as NoteStatus,
        updated: r.updated,
      };
      if (r.project !== null) s.project = r.project;
      return s;
    });
  }

  async countUnbackfilledNotes(): Promise<number> {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM notes WHERE updated IS NULL`).get() as {
      n: number;
    };
    return row.n;
  }

  async indexChunks(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;

    // Embed anchor-stripped chunk content as passages. (Anchors were already removed by
    // the ChunkManager; nothing here re-introduces them.)
    const vectors = await this.embeddings.embed(
      chunks.map((c) => c.content),
      "passage",
    );

    const model = this.embeddings.model;
    const dim = this.embeddings.dim;

    const selRowid = this.db.prepare(`SELECT rowid FROM chunks WHERE chunk_id = ?`);
    const delFts = this.db.prepare(`DELETE FROM fts_chunks WHERE rowid = ?`);
    const delVec = this.db.prepare(`DELETE FROM vec_chunks WHERE chunk_id = ?`);
    const updChunk = this.db.prepare(
      `UPDATE chunks SET note_uid=@note_uid, heading=@heading, ordinal=@ordinal,
        content=@content, content_hash=@content_hash, embedding_model=@model, dim=@dim
       WHERE chunk_id=@chunk_id`,
    );
    const insChunk = this.db.prepare(
      `INSERT INTO chunks (chunk_id, note_uid, heading, ordinal, content, content_hash, embedding_model, dim)
       VALUES (@chunk_id, @note_uid, @heading, @ordinal, @content, @content_hash, @model, @dim)`,
    );
    const insFts = this.db.prepare(`INSERT INTO fts_chunks (rowid, heading, content) VALUES (?, ?, ?)`);
    const insVec = this.db.prepare(`INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)`);

    const tx = this.db.transaction(() => {
      chunks.forEach((c, i) => {
        const v = vectors[i];
        if (v === undefined) return;

        const existing = selRowid.get(c.chunk_id) as { rowid: number } | undefined;
        const params = {
          chunk_id: c.chunk_id,
          note_uid: c.note_uid,
          heading: c.heading,
          ordinal: c.ordinal,
          content: c.content,
          content_hash: c.content_hash,
          model,
          dim,
        };

        let rowid: number;
        if (existing) {
          rowid = existing.rowid;
          delFts.run(rowid);
          updChunk.run(params);
        } else {
          rowid = Number(insChunk.run(params).lastInsertRowid);
        }
        delVec.run(c.chunk_id);
        insVec.run(c.chunk_id, toBlob(v));
        insFts.run(rowid, c.heading, c.content);
      });
    });
    tx();
  }

  async deleteChunks(chunkIds: string[]): Promise<void> {
    if (chunkIds.length === 0) return;
    const selRowid = this.db.prepare(`SELECT rowid FROM chunks WHERE chunk_id = ?`);
    const delFts = this.db.prepare(`DELETE FROM fts_chunks WHERE rowid = ?`);
    const delVec = this.db.prepare(`DELETE FROM vec_chunks WHERE chunk_id = ?`);
    const delChunk = this.db.prepare(`DELETE FROM chunks WHERE chunk_id = ?`);
    const tx = this.db.transaction(() => {
      for (const id of chunkIds) {
        const existing = selRowid.get(id) as { rowid: number } | undefined;
        if (existing) delFts.run(existing.rowid);
        delVec.run(id);
        delChunk.run(id);
      }
    });
    tx();
  }

  async deleteNote(uid: string): Promise<void> {
    const rows = this.db.prepare(`SELECT rowid, chunk_id FROM chunks WHERE note_uid = ?`).all(uid) as {
      rowid: number;
      chunk_id: string;
    }[];
    const delFts = this.db.prepare(`DELETE FROM fts_chunks WHERE rowid = ?`);
    const delVec = this.db.prepare(`DELETE FROM vec_chunks WHERE chunk_id = ?`);
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        delFts.run(r.rowid);
        delVec.run(r.chunk_id);
      }
      this.db.prepare(`DELETE FROM chunks WHERE note_uid = ?`).run(uid);
      this.db.prepare(`DELETE FROM notes WHERE uid = ?`).run(uid);
    });
    tx();
  }

  async getChunkStates(uid?: string): Promise<ChunkState[]> {
    const sql =
      `SELECT chunk_id, note_uid, content_hash, embedding_model FROM chunks` +
      (uid !== undefined ? ` WHERE note_uid = ?` : ``);
    const stmt = this.db.prepare(sql);
    const rows = (uid !== undefined ? stmt.all(uid) : stmt.all()) as {
      chunk_id: string;
      note_uid: string;
      content_hash: string;
      embedding_model: string;
    }[];
    return rows;
  }

  async getNoteHash(uid: string): Promise<string | null> {
    const row = this.db.prepare(`SELECT content_hash FROM notes WHERE uid = ?`).get(uid) as
      | { content_hash: string }
      | undefined;
    return row?.content_hash ?? null;
  }

  async vectorSearch(query: string, opts: IndexSearchOptions): Promise<ScoredChunk[]> {
    const [qv] = await this.embeddings.embed([query], "query");
    if (!qv) return [];

    const candidateK = this.candidateK(opts);
    // Isolate the KNN in a CTE so the join doesn't disturb sqlite-vec's k selection.
    const rows = this.db
      .prepare(
        `WITH knn AS (
           SELECT chunk_id, distance FROM vec_chunks
           WHERE embedding MATCH ? ORDER BY distance LIMIT ?
         )
         SELECT knn.chunk_id, knn.distance AS metric,
                c.note_uid, c.heading, c.content, ${NOTE_COLUMNS}
         FROM knn
         JOIN chunks c ON c.chunk_id = knn.chunk_id
         JOIN notes  n ON n.uid = c.note_uid
         ORDER BY knn.distance`,
      )
      .all(toBlob(qv), candidateK) as JoinRow[];

    // cosine distance → similarity in [−1, 1]; higher is better.
    return this.toScored(rows, opts, (d) => 1 - d);
  }

  async lexicalSearch(query: string, opts: IndexSearchOptions): Promise<ScoredChunk[]> {
    const match = buildFtsQuery(query);
    if (match === "") return [];

    const rows = this.db
      .prepare(
        `SELECT c.chunk_id, bm25(fts_chunks) AS metric,
                c.note_uid, c.heading, c.content, ${NOTE_COLUMNS}
         FROM fts_chunks
         JOIN chunks c ON c.rowid = fts_chunks.rowid
         JOIN notes  n ON n.uid = c.note_uid
         WHERE fts_chunks MATCH ?
         ORDER BY bm25(fts_chunks)
         LIMIT ?`,
      )
      .all(match, this.candidateK(opts)) as JoinRow[];

    // bm25 is lower-is-better (typically negative); negate so higher is better.
    return this.toScored(rows, opts, (b) => -b);
  }

  async neighbors(uid: string, k: number): Promise<ScoredChunk[]> {
    const own = this.db.prepare(`SELECT chunk_id FROM chunks WHERE note_uid = ?`).all(uid) as {
      chunk_id: string;
    }[];
    if (own.length === 0) return [];

    const getVec = this.db.prepare(`SELECT embedding FROM vec_chunks WHERE chunk_id = ?`);
    const knn = this.db.prepare(
      `WITH knn AS (
         SELECT chunk_id, distance FROM vec_chunks
         WHERE embedding MATCH ? ORDER BY distance LIMIT ?
       )
       SELECT knn.chunk_id, knn.distance AS metric,
              c.note_uid, c.heading, c.content, ${NOTE_COLUMNS}
       FROM knn
       JOIN chunks c ON c.chunk_id = knn.chunk_id
       JOIN notes  n ON n.uid = c.note_uid`,
    );

    // Best (highest) similarity per neighbouring chunk, excluding this note's own chunks.
    const best = new Map<string, ScoredChunk>();
    for (const { chunk_id } of own) {
      const vrow = getVec.get(chunk_id) as { embedding: Buffer } | undefined;
      if (!vrow) continue;
      const rows = knn.all(vrow.embedding, k + own.length) as JoinRow[];
      for (const r of rows) {
        if (r.note_uid === uid) continue;
        const score = 1 - r.metric;
        const prev = best.get(r.chunk_id);
        if (!prev || score > prev.score) best.set(r.chunk_id, this.row(r, score));
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k);
  }

  close(): void {
    this.db.close();
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private candidateK(opts: IndexSearchOptions): number {
    // Over-fetch when filtering, since filters apply after KNN/BM25.
    return opts.type !== undefined || opts.project !== undefined ? Math.min(200, opts.k * 8) : opts.k;
  }

  private toScored(
    rows: JoinRow[],
    opts: IndexSearchOptions,
    score: (metric: number) => number,
  ): ScoredChunk[] {
    const filtered = rows.filter(
      (r) =>
        (opts.type === undefined || r.type === opts.type) &&
        (opts.project === undefined || r.project === opts.project),
    );
    return filtered.slice(0, opts.k).map((r) => this.row(r, score(r.metric)));
  }

  private row(r: JoinRow, score: number): ScoredChunk {
    const out: ScoredChunk = {
      chunk_id: r.chunk_id,
      note_uid: r.note_uid,
      title: r.title,
      heading: r.heading,
      content: r.content,
      source: r.source as NoteSource,
      verified: r.verified === 1,
      status: r.status as NoteStatus,
      score,
    };
    if (r.project !== null) out.project = r.project;
    if (r.superseded_by !== null) out.superseded_by = r.superseded_by;
    return out;
  }
}
