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

/**
 * How THIS model's cosine similarities are actually distributed — a model-specific quirk,
 * so it lives on the same axis of change as the prefixes above.
 *
 * Cosine is nominally [−1, 1], but real sentence encoders occupy a much narrower band:
 * multilingual-e5-small scores ~0.70 between completely unrelated texts. Publishing a raw
 * cosine without saying so invites the reader to apply a 0–1 intuition that is simply wrong
 * for the model in use. This is descriptive calibration, not classification: it reports where
 * the numbers actually land and leaves every judgement to the caller.
 *
 * A provider that omits this says "I don't know my distribution" — callers then present the
 * cosine with no calibration claim at all, rather than inheriting some other model's numbers.
 */
export interface SimilarityCalibration {
  /** Cosine that unrelated text still reaches — the practical floor, NOT 0. */
  floor: number;
  /** Cosine at/above which a hit is typically a genuine topical match. */
  strong: number;
  /** One sentence naming the model and its band, for a human or an LLM to read. */
  note: string;
}

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

  /**
   * Where this model's cosines actually land. Optional: omit it rather than guess —
   * a wrong calibration is worse than none, because it is stated with confidence.
   */
  // `| undefined` is explicit because exactOptionalPropertyTypes is on: an implementation may
  // satisfy this with a GETTER, and a getter is always present — it can only return undefined.
  readonly similarityCalibration?: SimilarityCalibration | undefined;
}
