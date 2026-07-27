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
  SearchResult,
  ReadResult,
  Mutation,
  MutationResult,
  ReindexOptions,
  ReindexResult,
} from "../types.js";
import type { VaultManifestOptions } from "../core/vault-manifest.js";

export interface Engine {
  // ── query path ────────────────────────────────────────────────────────────
  /** Ranked hits PLUS a complementary context slice describing what the hits leave out. */
  search(query: string, opts?: SearchOptions): Promise<SearchResult>;
  read(uid: string): Promise<ReadResult | null>;
  reindex(opts?: ReindexOptions): Promise<ReindexResult>;

  /**
   * A compact, budgeted map of the vault, for the once-per-session initialize instructions.
   * Read-only projection off the index — never mutates, never embeds.
   */
  vaultManifest(opts?: VaultManifestOptions): Promise<string>;

  /**
   * Backfill mirrored note metadata for an index written by an older build. Refreshes only
   * derived fields — it deliberately does NOT touch the write-guard baseline, so it can run at
   * startup without weakening the external-edit guard. Returns how many rows it refreshed.
   */
  refreshMetadata(): Promise<number>;

  // ── mutation path ─────────────────────────────────────────────────────────
  /** The one entry point for every mutation. Runs write → commit → index, in order. */
  applyMutation(mutation: Mutation): Promise<MutationResult>;
}
