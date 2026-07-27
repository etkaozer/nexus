// HybridRetriever — a Core component that sits ABOVE the IndexProvider (never inside it).
// It fuses the index's vector and lexical result lists with Reciprocal Rank Fusion,
// then rolls chunk-level hits up to note level: a note that matched on several chunks
// appears as ONE SearchHit carrying its best (highest-RRF) chunk's score/heading/snippet.

import type { IndexProvider, ScoredChunk, IndexSearchOptions } from "../interfaces/index-provider.js";
import type { SearchHit, SearchOptions, MatchArm } from "../types.js";

export interface HybridRetrieverOptions {
  /** RRF constant; 60 is the widely-used default. Larger = flatter contribution by rank. */
  rrfK?: number;
  /** Candidate chunks to pull from each arm before fusion (≥ final k). */
  candidateK?: number;
  /** Max snippet length in characters. */
  snippetLength?: number;
}

interface Fused {
  chunk: ScoredChunk;
  score: number;
}

export class HybridRetriever {
  private readonly rrfK: number;
  private readonly candidateK: number;
  private readonly snippetLength: number;

  constructor(
    private readonly index: IndexProvider,
    opts: HybridRetrieverOptions = {},
  ) {
    this.rrfK = opts.rrfK ?? 60;
    this.candidateK = opts.candidateK ?? 50;
    this.snippetLength = opts.snippetLength ?? 200;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const mode = opts.mode ?? "hybrid";
    const k = opts.k ?? 10;

    const indexOpts: IndexSearchOptions = { k: Math.max(this.candidateK, k) };
    if (opts.type !== undefined) indexOpts.type = opts.type;
    if (opts.project !== undefined) indexOpts.project = opts.project;

    const [vec, lex] = await Promise.all([
      mode === "lexical" ? Promise.resolve<ScoredChunk[]>([]) : this.index.vectorSearch(query, indexOpts),
      mode === "vector" ? Promise.resolve<ScoredChunk[]>([]) : this.index.lexicalSearch(query, indexOpts),
    ]);

    // Keep the vector arm's cosine BEFORE fusion dissolves it. RRF still does all the ranking —
    // this is purely so the caller gets a number that means something in absolute terms, instead
    // of an RRF score that only encodes "rank 3 of this particular query".
    // Only the vector arm's `score` is a cosine; the lexical arm's is a negated BM25, which is
    // unbounded and not a similarity. Nothing here reads a cosine off `lex`.
    const cosine = new Map<string, number>(vec.map((c) => [c.chunk_id, c.score]));
    const inLexical = new Set(lex.map((c) => c.chunk_id));

    // Reciprocal Rank Fusion over chunks: each list contributes 1/(rrfK + rank).
    const perChunk = new Map<string, Fused>();
    const fuse = (list: ScoredChunk[]): void => {
      list.forEach((chunk, i) => {
        const inc = 1 / (this.rrfK + (i + 1));
        const prev = perChunk.get(chunk.chunk_id);
        if (prev) prev.score += inc;
        else perChunk.set(chunk.chunk_id, { chunk, score: inc });
      });
    };
    fuse(vec);
    fuse(lex);

    // Roll up to note level: keep each note's single best chunk.
    const perNote = new Map<string, Fused>();
    for (const f of perChunk.values()) {
      const prev = perNote.get(f.chunk.note_uid);
      if (!prev || f.score > prev.score) perNote.set(f.chunk.note_uid, f);
    }

    return [...perNote.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ chunk, score }) => {
        // The similarity reported is the one for the chunk actually being SHOWN. A note's other
        // chunks may score higher, but quoting their cosine next to this snippet would describe
        // text the caller cannot see.
        const cos = cosine.get(chunk.chunk_id);
        const arm: MatchArm =
          cos === undefined ? "lexical" : inLexical.has(chunk.chunk_id) ? "both" : "vector";
        const hit: SearchHit = {
          uid: chunk.note_uid,
          title: chunk.title,
          heading: chunk.heading,
          snippet: this.snippet(chunk.content),
          similarity: cos === undefined ? null : round3(cos),
          match: arm,
          rrf_score: round4(score),
          status: chunk.status,
          source: chunk.source,
          verified: chunk.verified,
        };
        if (chunk.project !== undefined) hit.project = chunk.project;
        if (chunk.superseded_by !== undefined) hit.superseded_by = chunk.superseded_by;
        return hit;
      });
  }

  private snippet(content: string): string {
    const oneLine = content.replace(/\s+/g, " ").trim();
    return oneLine.length <= this.snippetLength ? oneLine : `${oneLine.slice(0, this.snippetLength)}…`;
  }
}

// Trim float noise so the caller reads 0.881, not 0.8810000000000001. Rounding is
// presentational only — it happens after ranking, so it can never reorder anything.
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
