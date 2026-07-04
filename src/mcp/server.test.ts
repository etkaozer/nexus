// M5 integration test: boot the MCP server in-process over the SDK's in-memory transport,
// connect a real Client, and drive all 6 tools end-to-end against a throwaway vault.
// A deterministic fake embedder keeps it fast; lexical (FTS) makes search hits reliable.
//
// Run: npm test

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FileSystemAdapter } from "../storage/file-system-adapter.js";
import { SqliteIndexProvider } from "../index/sqlite-index-provider.js";
import { MarkdownChunkManager } from "../core/markdown-chunk-manager.js";
import { NexusEngine } from "../engine/nexus-engine.js";
import { createServer } from "./server.js";
import type { EmbeddingProvider, EmbeddingKind } from "../interfaces/embedding-provider.js";

class FakeEmbeddings implements EmbeddingProvider {
  readonly model = "fake";
  readonly dim = 384;
  async embed(texts: string[], _kind: EmbeddingKind): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dim);
      let h = 2166136261;
      for (let i = 0; i < t.length; i++) {
        h ^= t.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      for (let i = 0; i < this.dim; i++) {
        h ^= h << 13;
        h ^= h >>> 17;
        h ^= h << 5;
        v[i] = ((h >>> 0) / 4294967295) * 2 - 1;
      }
      let n = 0;
      for (const x of v) n += x * x;
      n = Math.sqrt(n) || 1;
      for (let i = 0; i < this.dim; i++) v[i] = (v[i] ?? 0) / n;
      return v;
    });
  }
}

interface ResultShape {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function textOf(res: unknown): string {
  const first = (res as ResultShape).content?.[0];
  return first && first.type === "text" && first.text ? first.text : "";
}

function jsonOf(res: unknown): any {
  return JSON.parse(textOf(res));
}

async function setup(t: TestContext): Promise<{ client: Client; storage: FileSystemAdapter }> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-m5-"));
  const storage = new FileSystemAdapter(join(dir, "vault"));
  const index = new SqliteIndexProvider(join(dir, "brain.db"), new FakeEmbeddings());
  const engine = new NexusEngine({ storage, index, chunker: new MarkdownChunkManager() });

  const server = createServer(engine);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "nexus-test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  t.after(async () => {
    await client.close();
    await server.close();
    index.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { client, storage };
}

test("all 6 tools work end-to-end over the MCP boundary", async (t) => {
  const { client } = await setup(t);

  // exactly the 6 tools, no extras
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((x) => x.name).sort(),
    ["archive", "link", "read", "reindex", "search", "upsert"],
  );

  // upsert (create) — omit uid
  const created = jsonOf(
    await client.callTool({
      name: "upsert",
      arguments: {
        title: "MEXC Notes",
        type: "reference",
        source: "manual",
        body: "## Limits\nMEXC returns HTTP 429 for SessionDO when throttled.",
      },
    }),
  );
  const uid1: string = created.uid;
  assert.equal(created.action, "create");
  assert.ok(uid1);

  // search finds it (exact rare token via lexical arm)
  const hits = jsonOf(await client.callTool({ name: "search", arguments: { query: "MEXC" } }));
  assert.ok(Array.isArray(hits) && hits.some((h: { uid: string }) => h.uid === uid1), "search finds the note");
  assert.equal(new Set(hits.map((h: { uid: string }) => h.uid)).size, hits.length, "note-level (no dup notes)");

  // read returns it with backlinks + related_auto arrays
  const read1 = jsonOf(await client.callTool({ name: "read", arguments: { uid: uid1 } }));
  assert.equal(read1.frontmatter.uid, uid1);
  assert.ok(Array.isArray(read1.backlinks) && read1.backlinks.length === 0, "no backlinks yet");
  assert.ok(Array.isArray(read1.related_auto), "related_auto is a live array");

  // second note, then link note2 → note1
  const uid2: string = jsonOf(
    await client.callTool({
      name: "upsert",
      arguments: { title: "Trading Bot", type: "project-note", source: "manual", body: "## Plan\nUse the exchange." },
    }),
  ).uid;
  const linked = jsonOf(
    await client.callTool({ name: "link", arguments: { from_uid: uid2, to_uid: uid1, relation: "references" } }),
  );
  assert.equal(linked.action, "link");
  assert.deepEqual(linked.affected_uids, [uid2, uid1]);

  // now note1 has an authored backlink from note2
  const read1b = jsonOf(await client.callTool({ name: "read", arguments: { uid: uid1 } }));
  assert.ok(read1b.backlinks.some((b: { uid: string }) => b.uid === uid2), "backlink from note2 present");

  // archive note2 — file kept, status flips
  assert.equal(jsonOf(await client.callTool({ name: "archive", arguments: { uid: uid2 } })).action, "archive");
  assert.equal(jsonOf(await client.callTool({ name: "read", arguments: { uid: uid2 } })).frontmatter.status, "archived");

  // supersede: new note replaces note1 → note1 archived + cross-linked
  const superseder = jsonOf(
    await client.callTool({
      name: "upsert",
      arguments: {
        title: "MEXC Notes v2",
        type: "reference",
        source: "manual",
        body: "## Limits\nUpdated MEXC limits.",
        supersedes: uid1,
      },
    }),
  );
  assert.equal(superseder.action, "supersede");
  const uid3: string = superseder.uid;
  const read1c = jsonOf(await client.callTool({ name: "read", arguments: { uid: uid1 } }));
  assert.equal(read1c.frontmatter.status, "superseded", "old note marked superseded");
  assert.equal(read1c.frontmatter.superseded_by, uid3, "reverse pointer set");
  const read3 = jsonOf(await client.callTool({ name: "read", arguments: { uid: uid3 } }));
  assert.equal(read3.frontmatter.supersedes, uid1, "forward pointer set");

  // reindex is idempotent
  await client.callTool({ name: "reindex", arguments: {} });
  const reindexed = jsonOf(await client.callTool({ name: "reindex", arguments: {} }));
  assert.equal(reindexed.chunks_reembedded, 0, "second full reindex re-embeds nothing");
});

test("the write-guard error surfaces cleanly through the tool boundary", async (t) => {
  const { client, storage } = await setup(t);

  const uid: string = jsonOf(
    await client.callTool({
      name: "upsert",
      arguments: { title: "Guarded", type: "reference", source: "manual", body: "## A\nOriginal." },
    }),
  ).uid;

  // Edit the file on disk behind the engine's back (simulates an Obsidian edit).
  const stored = await storage.read(uid);
  assert.ok(stored);
  await storage.write({
    title: stored.title,
    frontmatter: stored.frontmatter,
    body: `${stored.body}\n\nEDITED IN OBSIDIAN.`,
  });

  // A tool-level overwrite must come back as a clean, actionable error — not a crash.
  const guarded = await client.callTool({
    name: "upsert",
    arguments: { uid, title: "Guarded", type: "reference", source: "manual", body: "clobbering body" },
  });
  assert.equal((guarded as ResultShape).isError, true, "surfaced as a tool error");
  assert.match(textOf(guarded), /reindex/i, "message tells the caller to reindex first");
  assert.doesNotMatch(textOf(guarded), /\bat \/|Error:\s*\n|\.ts:\d+/, "no raw stack trace");

  // The external edit is intact — nothing was clobbered.
  const after = jsonOf(await client.callTool({ name: "read", arguments: { uid } }));
  assert.match(after.body, /EDITED IN OBSIDIAN\./);
  assert.doesNotMatch(after.body, /clobbering body/);
});
