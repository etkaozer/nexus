// ChunkManager — a Core component (not one of the three stores). Pure, deterministic
// Markdown → Chunk[] derivation. No I/O, no embeddings, no git.
//
// Chunking rules it must enforce (this is where past dedup bugs lived):
//   • Split the body on the shallowest heading level actually present (outside code
//     fences): `#`-sectioned notes split on `#`, `##`-sectioned on `##`, etc. Content
//     before the first heading of that level → a `__preamble` chunk. Deeper headings are
//     content, not boundaries.
//   • Chunk id = `<note-uid>::<stable-slug>#<ordinal>`. The stable-slug is derived ONCE and
//     PERSISTED (an invisible `<!-- cid:xxxx -->` HTML comment on the line below the
//     heading). It is NEVER recomputed from heading text — so a heading rename re-embeds
//     the text but keeps the same chunk id.
//   • Duplicate headings in one note → each carries its own slug, so ids never collide.
//   • Oversize section (> ~450 tokens for e5) → sub-split on the next-deeper level, then a
//     fixed-size fallback, using sub-ordinals.

import type { Note, Chunk } from "../types.js";

export interface ChunkResult {
  /**
   * The note body, possibly UPDATED: on first chunking, stable `^cid-xxxx` refs are appended
   * to headings that lack them. When this differs from the input body the engine must persist
   * it (write → commit) so the slugs become part of the source of truth.
   */
  body: string;
  chunks: Chunk[];
}

export interface ChunkManager {
  /** Deterministically derive chunks from a note. Pure — same input always yields the same output. */
  chunk(note: Note): ChunkResult;
}
