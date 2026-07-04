// Engine — the API the MCP tools call. Two paths:
//
//   query path:     search / read / reindex   (no source-of-truth mutation intent)
//   mutation path:  applyMutation()           (the SINGLE choke point for side-effects)
//
// applyMutation is where write → git commit → index happen, in that explicit order,
// synchronously, wrapped in real try/catch. Tools NEVER perform side-effects
// themselves; they only translate an MCP call into one of these methods. There is
// deliberately no event bus — the two current side-effects are mandatory and ordered.

import type {
  SearchOptions,
  SearchHit,
  ReadResult,
  Mutation,
  MutationResult,
  ReindexOptions,
  ReindexResult,
} from "../types.js";

export interface Engine {
  // ── query path ────────────────────────────────────────────────────────────
  search(query: string, opts?: SearchOptions): Promise<SearchHit[]>;
  read(uid: string): Promise<ReadResult | null>;
  reindex(opts?: ReindexOptions): Promise<ReindexResult>;

  // ── mutation path ─────────────────────────────────────────────────────────
  /** The one entry point for every mutation. Runs write → commit → index, in order. */
  applyMutation(mutation: Mutation): Promise<MutationResult>;
}
