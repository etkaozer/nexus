// E5EmbeddingProvider — the default EmbeddingProvider. Runs Xenova/multilingual-e5-small
// (384-dim, multilingual for mixed Turkish/English notes) locally in Node via
// @huggingface/transformers. Downloads the model once, then works fully offline.
//
// This is the ONLY place e5's "passage: " / "query: " prefixes exist. Nothing above
// this class (IndexProvider, engine, tools) knows a prefix is applied — swapping to a
// model that prefixes differently (or not at all) is a change confined to here.

import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  EmbeddingProvider,
  EmbeddingKind,
  SimilarityCalibration,
} from "../interfaces/embedding-provider.js";

const MODEL = "Xenova/multilingual-e5-small";
const DIM = 384;

// Measured on this model, not assumed: embedding three unrelated passages and probing them
// with matched and mismatched queries puts every pair in [0.69, 0.89] — an unrelated pair
// still scores ~0.75. So the honest floor is ~0.70 and a real topical match is ~0.85+.
// These numbers belong to multilingual-e5-small ALONE; a different model must measure its own.
const E5_CALIBRATION: SimilarityCalibration = {
  floor: 0.7,
  strong: 0.85,
  note:
    "Similarity is a raw cosine from multilingual-e5-small. This model's scores occupy a narrow " +
    "high band: ~0.70 is its floor (two unrelated texts still score that), and ~0.85+ indicates a " +
    "genuine topical match. Do not read these as 0-1 percentages — compare hits against each other " +
    "and against the ~0.70 floor.",
};

export interface E5Options {
  /** Where the model is cached. Default: ~/.cache/nexus/models (stable regardless of cwd). */
  cacheDir?: string;
  /** When true, model download/load progress is logged to stderr (for the server; off in tests). */
  logProgress?: boolean;
}

export class E5EmbeddingProvider implements EmbeddingProvider {
  readonly model = MODEL;
  readonly dim = DIM;
  readonly similarityCalibration = E5_CALIBRATION;

  private readonly logProgress: boolean;
  private extractor: FeatureExtractionPipeline | null = null;
  private loading: Promise<FeatureExtractionPipeline> | null = null;

  constructor(opts: E5Options = {}) {
    env.cacheDir = opts.cacheDir ?? join(homedir(), ".cache", "nexus", "models");
    env.allowRemoteModels = true; // needed for the one-time download; disk cache used thereafter
    this.logProgress = opts.logProgress ?? false;
  }

  /** Load (and cache) the model. Safe to call repeatedly; the pipeline is built once. */
  async warmup(): Promise<void> {
    await this.pipe();
  }

  async embed(texts: string[], kind: EmbeddingKind): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await this.pipe();

    // e5 REQUIRES these prefixes; this is the seam that owns them.
    const prefixed = texts.map((t) => `${kind}: ${t}`);
    const output = await extractor(prefixed, { pooling: "mean", normalize: true });

    const [rows, dim] = output.dims as [number, number];
    const data = output.data as Float32Array; // flat, row-major [rows * dim]
    const out: Float32Array[] = [];
    for (let r = 0; r < rows; r++) {
      // copy each row into a standalone Float32Array (byteOffset 0) for a clean SQLite blob
      out.push(Float32Array.from(data.subarray(r * dim, (r + 1) * dim)));
    }
    return out;
  }

  private async pipe(): Promise<FeatureExtractionPipeline> {
    if (this.extractor) return this.extractor;
    if (!this.loading) {
      // A single in-flight load: warmup() and a concurrent embed() share this promise, so the
      // model is never downloaded twice.
      const options = this.logProgress ? { progress_callback: progressLogger() } : undefined;
      this.loading = pipeline("feature-extraction", MODEL, options).then((p) => {
        this.extractor = p;
        return p;
      });
    }
    return this.loading;
  }
}

/** Logs each distinct model-load step to stderr once (skips the high-frequency byte updates). */
function progressLogger(): (progress: unknown) => void {
  const seen = new Set<string>();
  return (progress) => {
    const info = (progress ?? {}) as { status?: string; file?: string; name?: string };
    if (info.status === "progress") return;
    const file = info.file ?? info.name ?? "";
    const key = `${info.status ?? ""}:${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    const line = [info.status, file].filter(Boolean).join(" ");
    if (line) console.error(`Nexus[e5]: ${line}`);
  };
}
