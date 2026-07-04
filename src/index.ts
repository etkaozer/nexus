// MCP stdio entry point. Wired to the @modelcontextprotocol/sdk server and the 6
// tools in M5. For M0 this only proves the dependency graph compiles and exports
// the engine surface.

export { NexusEngine } from "./engine/nexus-engine.js";
export type { Engine } from "./engine/engine.js";
export type { EngineDeps } from "./engine/nexus-engine.js";

export type { StorageAdapter, CommitInfo } from "./interfaces/storage-adapter.js";
export type {
  IndexProvider,
  NoteIndexMeta,
  ChunkState,
  ScoredChunk,
  IndexSearchOptions,
} from "./interfaces/index-provider.js";
export type { EmbeddingProvider, EmbeddingKind } from "./interfaces/embedding-provider.js";
export { E5EmbeddingProvider } from "./embeddings/e5-embedding-provider.js";
export type { E5Options } from "./embeddings/e5-embedding-provider.js";
export { SqliteIndexProvider } from "./index/sqlite-index-provider.js";
export { HybridRetriever } from "./core/hybrid-retriever.js";
export type { HybridRetrieverOptions } from "./core/hybrid-retriever.js";
export type { ChunkManager, ChunkResult } from "./core/chunk-manager.js";
export { MarkdownChunkManager } from "./core/markdown-chunk-manager.js";
export type { ChunkManagerOptions } from "./core/markdown-chunk-manager.js";
export { ChangeDetector } from "./core/change-detector.js";
export type { ChunkDiff } from "./core/change-detector.js";
export { WriteGuardError } from "./engine/errors.js";
export { createServer } from "./mcp/server.js";

export type * from "./types.js";
