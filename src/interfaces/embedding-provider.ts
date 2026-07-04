// EmbeddingProvider — turns text into vectors. One of the three orthogonal interfaces.
//
// This is a PROVEN independent axis of change (we already swapped Workers AI → local e5).
// It owns EVERY model-specific quirk so the model can change with zero impact on the
// index or storage:
//
//   • e5 requires "passage: " / "query: " prefixes  → applied HERE, keyed off `kind`.
//   • bge-m3 prefixes differently or not at all      → its impl handles that HERE.
//
// The IndexProvider must never learn what a prefix is; it only chooses a `kind`.

/**
 * Whether the text being embedded is document content to be stored ("passage")
 * or a search query ("query"). The provider maps this to whatever the underlying
 * model needs (a prefix, a different pooling, or nothing at all).
 */
export type EmbeddingKind = "passage" | "query";

export interface EmbeddingProvider {
  /**
   * Identifier of the underlying model, e.g. "Xenova/multilingual-e5-small".
   * Stored alongside every vector so a model swap can be detected and healed by reindex.
   */
  readonly model: string;

  /** Vector dimensionality, e.g. 384. Stored alongside every vector. */
  readonly dim: number;

  /**
   * Embed a batch of texts. `kind` lets the provider apply model-specific handling
   * (e5: prefix each text with "passage: " or "query: "). Returns one vector per
   * input, in order. Each vector has length `dim`.
   */
  embed(texts: string[], kind: EmbeddingKind): Promise<Float32Array[]>;
}
