// ChangeDetector — pure, deterministic reindex diff. Given the chunks a note CURRENTLY
// produces (from the ChunkManager) and the chunk state the index ALREADY holds, it
// decides what must change. No I/O, no embeddings.
//
// A chunk is (re)embedded when it is new, when its content_hash changed, or when its
// stored embedding_model differs from the current model (so swapping models is a safe,
// automatic re-embed). A chunk the note no longer produces is deleted. Everything else
// is left exactly as-is — no wasted embedding.

import type { Chunk } from "../types.js";
import type { ChunkState } from "../interfaces/index-provider.js";

export interface ChunkDiff {
  /** New / changed / model-stale chunks to (re)embed and upsert. */
  toIndex: Chunk[];
  /** chunk_ids the note no longer produces — remove from the index. */
  toDelete: string[];
  /** Chunks left untouched (identical hash and model). */
  unchanged: number;
  /** Subset of toIndex re-embedded ONLY because the embedding model changed (hash unchanged). */
  modelStale: number;
}

export class ChangeDetector {
  diff(current: Chunk[], stored: ChunkState[], currentModel: string): ChunkDiff {
    const storedById = new Map(stored.map((s) => [s.chunk_id, s]));
    const currentIds = new Set(current.map((c) => c.chunk_id));

    const toIndex: Chunk[] = [];
    let unchanged = 0;
    let modelStale = 0;

    for (const c of current) {
      const s = storedById.get(c.chunk_id);
      if (!s) {
        toIndex.push(c); // new chunk
        continue;
      }
      if (s.content_hash !== c.content_hash) {
        toIndex.push(c); // content changed
        continue;
      }
      if (s.embedding_model !== currentModel) {
        toIndex.push(c); // model changed → re-embed despite identical content
        modelStale++;
        continue;
      }
      unchanged++; // identical hash + model → leave as-is
    }

    const toDelete = stored.filter((s) => !currentIds.has(s.chunk_id)).map((s) => s.chunk_id);
    return { toIndex, toDelete, unchanged, modelStale };
  }
}
