#!/usr/bin/env node
// Nexus MCP server entry point (stdio transport).
//
//   nexus-mcp <vault-path>          → run the MCP server (vault also via NEXUS_VAULT)
//   nexus-mcp reindex [vault-path]  → one-shot reindex/bootstrap, then exit
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
  console.error(`Nexus: reindexing ${vaultPath} (db=${dbPath}). First run downloads the model (~110MB, ~3 min)…`);
  await embeddings.warmup();
  const result = await engine.reindex();
  console.error(`Nexus: reindex complete — ${JSON.stringify(result)}`);
  index.close();
}

async function runServer(vaultArg: string): Promise<void> {
  const { vaultPath, dbPath } = await resolvePaths(vaultArg);
  const { embeddings, engine } = build(vaultPath, dbPath);

  // Pre-warm in the BACKGROUND so the first real tool call doesn't silently block ~3 min.
  // A concurrent embed() awaits the same in-flight load — no double download.
  console.error("Nexus: pre-warming embedding model in the background (first run downloads ~110MB)…");
  void embeddings
    .warmup()
    .then(() => console.error("Nexus: embedding model ready."))
    .catch((e: unknown) => console.error("Nexus: model warmup failed (will retry on first use):", errMsg(e)));

  const server = createServer(engine);
  await server.connect(new StdioServerTransport());
  console.error(`Nexus MCP server ready. vault=${vaultPath} db=${dbPath}`);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;

  if (cmd === "reindex") {
    const vaultArg = process.env["NEXUS_VAULT"] ?? rest[0];
    if (!vaultArg) {
      console.error("Nexus reindex: no vault path. Usage: nexus-mcp reindex <vault> (or set NEXUS_VAULT).");
      process.exit(1);
    }
    await runReindex(vaultArg);
    return;
  }

  const vaultArg = process.env["NEXUS_VAULT"] ?? cmd;
  if (!vaultArg) {
    console.error("Nexus: no vault path. Usage: nexus-mcp <vault> (or set NEXUS_VAULT).");
    process.exit(1);
  }
  await runServer(vaultArg);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

main().catch((err: unknown) => {
  console.error("Nexus failed to start:", errMsg(err));
  process.exit(1);
});
