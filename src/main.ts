#!/usr/bin/env node
// Nexus MCP server entry point (stdio transport).
//
//   nexus-brain-mcp <vault-path>          → run the MCP server (vault also via NEXUS_VAULT)
//   nexus-brain-mcp reindex [vault-path]  → one-shot reindex/bootstrap, then exit
//
// The derived index lives OUTSIDE the vault by default (~/.cache/nexus/brain.db), so the
// vault git history stays Markdown-only. Override with NEXUS_DB.
//
// IMPORTANT: stdout is the MCP JSON-RPC channel — everything logged here goes to stderr.

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileSystemAdapter } from "./storage/file-system-adapter.js";
import { SqliteIndexProvider } from "./index/sqlite-index-provider.js";
import { E5EmbeddingProvider } from "./embeddings/e5-embedding-provider.js";
import { MarkdownChunkManager } from "./core/markdown-chunk-manager.js";
import { NexusEngine } from "./engine/nexus-engine.js";
import { createServer } from "./mcp/server.js";
import { buildInstructions } from "./mcp/instructions.js";
import { resolveVaultPath } from "./config.js";
import type { Engine } from "./engine/engine.js";
import type { IndexProvider } from "./interfaces/index-provider.js";

async function resolvePaths(vaultArg: string): Promise<{ vaultPath: string; dbPath: string }> {
  const vaultPath = resolve(vaultArg);
  const dbPath = process.env["NEXUS_DB"] ?? join(homedir(), ".cache", "nexus", "brain.db");
  await mkdir(dirname(dbPath), { recursive: true });
  return { vaultPath, dbPath };
}

function build(vaultPath: string, dbPath: string) {
  const embeddings = new E5EmbeddingProvider({ logProgress: true });
  const storage = new FileSystemAdapter(vaultPath);
  const index = new SqliteIndexProvider(dbPath, embeddings);
  const engine = new NexusEngine({ storage, index, chunker: new MarkdownChunkManager() });
  return { embeddings, index, engine };
}

async function runReindex(vaultArg: string): Promise<void> {
  const { vaultPath, dbPath } = await resolvePaths(vaultArg);
  const { embeddings, index, engine } = build(vaultPath, dbPath);
  console.error(`Nexus: reindexing ${vaultPath} (db=${dbPath}). First run downloads the embedding model (~487 MB, one time)…`);
  await embeddings.warmup();
  const result = await engine.reindex();
  console.error(`Nexus: reindex complete — ${JSON.stringify(result)}`);
  index.close();
}

/**
 * Bring an index written by an older build up to what the vault map needs.
 *
 * The schema migration itself already happened (SqliteIndexProvider ALTERs on open), but the new
 * columns are empty until something writes them. Left alone, a user who pulls this build gets a
 * map with no recency ordering and NO explanation — the exact silent-degradation failure the map
 * exists to remove. So it is backfilled automatically, and every branch says what it did.
 *
 * Metadata only: no chunking, no embedding, no writes to the vault, and never the write-guard
 * baseline. Cheap enough to run before the transport connects.
 */
async function backfillIfNeeded(engine: Engine, index: IndexProvider): Promise<void> {
  let stale: number;
  try {
    stale = await index.countUnbackfilledNotes();
  } catch (e: unknown) {
    console.error("Nexus: could not check index metadata; the vault map may be degraded:", errMsg(e));
    return;
  }
  if (stale === 0) return;

  console.error(`Nexus: index predates the vault-map metadata (${stale} note(s)). Backfilling — no re-embedding…`);
  try {
    const n = await engine.refreshMetadata();
    const left = await index.countUnbackfilledNotes();
    console.error(`Nexus: backfilled ${n} note(s).`);
    if (left > 0) {
      console.error(
        `Nexus: ${left} note(s) are indexed but missing from the vault on disk — run 'nexus-brain-mcp reindex <vault>' to reconcile.`,
      );
    }
  } catch (e: unknown) {
    console.error(
      "Nexus: metadata backfill failed — the vault map will be missing recency ordering.",
      "Run 'nexus-brain-mcp reindex <vault>' to fix it. Cause:",
      errMsg(e),
    );
  }
}

async function runServer(vaultArg: string): Promise<void> {
  const { vaultPath, dbPath } = await resolvePaths(vaultArg);
  const { embeddings, index, engine } = build(vaultPath, dbPath);

  // Pre-warm in the BACKGROUND so the first real tool call doesn't silently block on the ~487 MB download.
  // A concurrent embed() awaits the same in-flight load — no double download.
  console.error("Nexus: pre-warming embedding model in the background (first run downloads ~487 MB)…");
  void embeddings
    .warmup()
    .then(() => console.error("Nexus: embedding model ready."))
    .catch((e: unknown) => console.error("Nexus: model warmup failed (will retry on first use):", errMsg(e)));

  await backfillIfNeeded(engine, index);

  // The map is a SNAPSHOT, taken here, once. For stdio that is exactly one process per client
  // session, so "session start" is literal. It is built before connect() because the SDK reads
  // `instructions` when it constructs the initialize response — and it needs no embedding model,
  // so it does not wait on the warmup above.
  // Checked against the DATA, not by pattern-matching the rendered map: a wording change in the
  // manifest must not silently switch this warning off.
  if (!(await index.listNoteSummaries()).some((n) => n.status === "active")) {
    console.error("Nexus: the index has no active notes — run 'nexus-brain-mcp reindex <vault>' or recall will not fire.");
  }
  const vaultMap = await engine.vaultManifest({ now: new Date().toISOString() });

  const server = createServer(engine, {
    instructions: buildInstructions(vaultMap),
    ...(index.similarityCalibration !== undefined ? { similarity: index.similarityCalibration } : {}),
  });
  await server.connect(new StdioServerTransport());
  console.error(`Nexus MCP server ready. vault=${vaultPath} db=${dbPath}`);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;

  if (cmd === "reindex") {
    await runReindex(resolveVaultPath(process.env, rest[0]));
    return;
  }

  await runServer(resolveVaultPath(process.env, cmd));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

main().catch((err: unknown) => {
  console.error("Nexus failed to start:", errMsg(err));
  process.exit(1);
});
