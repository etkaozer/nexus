// M4 tests: reindex (idempotent, hash-diff, model-change, add/remove/delete/rename) and
// the write guard. Uses a throwaway temp vault + brain.db, and a COUNTING embedding
// provider so "only changed chunks re-embedded" is observed via counts, not timing.
//
// Run: npm test

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, rename, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { FileSystemAdapter } from "../storage/file-system-adapter.js";
import { SqliteIndexProvider } from "../index/sqlite-index-provider.js";
import { MarkdownChunkManager } from "../core/markdown-chunk-manager.js";
import { NexusEngine } from "./nexus-engine.js";
import { WriteGuardError } from "./errors.js";
import type { EmbeddingProvider, EmbeddingKind } from "../interfaces/embedding-provider.js";
import type { UpsertMutation } from "../types.js";

// Deterministic, observable stand-in for the embedder.
class CountingEmbeddings implements EmbeddingProvider {
  model = "model-v1"; // mutable so tests can simulate a model swap
  readonly dim = 384;
  passageEmbeds = 0;
  queryEmbeds = 0;

  async embed(texts: string[], kind: EmbeddingKind): Promise<Float32Array[]> {
    if (kind === "passage") this.passageEmbeds += texts.length;
    else this.queryEmbeds += texts.length;
    return texts.map((t) => this.vec(t));
  }

  private vec(t: string): Float32Array {
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
  }
}

interface Ctx {
  engine: NexusEngine;
  storage: FileSystemAdapter;
  index: SqliteIndexProvider;
  embeddings: CountingEmbeddings;
  vault: string;
}

async function setup(t: TestContext): Promise<Ctx> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-m4-"));
  const vault = join(dir, "vault");
  const embeddings = new CountingEmbeddings();
  const storage = new FileSystemAdapter(vault);
  const index = new SqliteIndexProvider(join(dir, "brain.db"), embeddings);
  const engine = new NexusEngine({ storage, index, chunker: new MarkdownChunkManager() });
  t.after(async () => {
    index.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { engine, storage, index, embeddings, vault };
}

function upsert(fields: Partial<UpsertMutation> & { title: string; body: string }): UpsertMutation {
  return { kind: "upsert", type: "reference", source: "manual", ...fields };
}

const twoSection = ["## A", "Alpha original text.", "", "## B", "Beta text here."].join("\n");

/** Remove a whole `## <headingText>` section (heading + anchor + content) from a body. */
function removeSection(body: string, headingText: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) skipping = new RegExp(`^##\\s+${headingText}\\b`).test(line);
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

test("edit one chunk → reindex re-embeds only that chunk", async (t) => {
  const { engine, storage, index, embeddings } = await setup(t);
  const { uid } = await engine.applyMutation(upsert({ title: "Note", body: twoSection }));
  assert.equal(embeddings.passageEmbeds, 2, "both chunks embedded on create");

  // External edit: change only section A's text, keep anchors intact.
  const stored = await storage.read(uid);
  assert.ok(stored);
  await storage.write({
    title: stored.title,
    frontmatter: stored.frontmatter,
    body: stored.body.replace("Alpha original text.", "Alpha EDITED text."),
  });

  embeddings.passageEmbeds = 0;
  const r = await engine.reindex({ uid });
  assert.equal(embeddings.passageEmbeds, 1, "only the edited chunk re-embedded");
  assert.equal(r.chunks_reembedded, 1);
  assert.equal((await index.getChunkStates(uid)).length, 2, "still two chunks");
});

test("reindex twice with no change is idempotent (re-embeds nothing)", async (t) => {
  const { engine, embeddings } = await setup(t);
  const { uid } = await engine.applyMutation(upsert({ title: "Note", body: twoSection }));

  embeddings.passageEmbeds = 0;
  const r1 = await engine.reindex({ uid });
  assert.equal(embeddings.passageEmbeds, 0, "first reindex after upsert re-embeds nothing");
  assert.equal(r1.chunks_reembedded, 0);

  const r2 = await engine.reindex();
  assert.equal(embeddings.passageEmbeds, 0, "second reindex idempotent");
  assert.equal(r2.chunks_reembedded, 0);
});

test("bumping the embedding model re-embeds affected chunks despite unchanged content", async (t) => {
  const { engine, embeddings } = await setup(t);
  const { uid } = await engine.applyMutation(upsert({ title: "Note", body: twoSection }));

  embeddings.passageEmbeds = 0;
  embeddings.model = "model-v2"; // swap the model

  const r = await engine.reindex({ uid });
  assert.equal(embeddings.passageEmbeds, 2, "all chunks re-embedded on model change");
  assert.equal(r.chunks_reembedded_model_change, 2, "counted as model-change re-embeds");

  // Now stored model matches → reindex is a no-op again.
  embeddings.passageEmbeds = 0;
  await engine.reindex({ uid });
  assert.equal(embeddings.passageEmbeds, 0, "healed; no further re-embedding");
});

test("adding and removing chunks is reflected in the index", async (t) => {
  const { engine, storage, index, embeddings } = await setup(t);
  const { uid } = await engine.applyMutation(upsert({ title: "Note", body: twoSection }));
  assert.equal((await index.getChunkStates(uid)).length, 2);

  // ADD a section (no anchor yet) → reindex injects it + embeds only the new chunk.
  let stored = await storage.read(uid);
  assert.ok(stored);
  await storage.write({ title: stored.title, frontmatter: stored.frontmatter, body: `${stored.body}\n\n## C\nGamma new.` });
  embeddings.passageEmbeds = 0;
  const rAdd = await engine.reindex({ uid });
  assert.equal((await index.getChunkStates(uid)).length, 3, "new chunk indexed");
  assert.equal(embeddings.passageEmbeds, 1, "only the new chunk embedded");
  assert.equal(rAdd.chunks_reembedded, 1);

  // REMOVE section B → reindex deletes just that chunk, embeds nothing.
  stored = await storage.read(uid);
  assert.ok(stored);
  await storage.write({ title: stored.title, frontmatter: stored.frontmatter, body: removeSection(stored.body, "B") });
  embeddings.passageEmbeds = 0;
  const rDel = await engine.reindex({ uid });
  assert.equal((await index.getChunkStates(uid)).length, 2, "removed chunk gone (A, C remain)");
  assert.equal(rDel.chunks_deleted, 1);
  assert.equal(embeddings.passageEmbeds, 0, "removal embeds nothing");
});

test("deleting a note on disk purges it from the index on full reindex", async (t) => {
  const { engine, storage, index } = await setup(t);
  const { uid } = await engine.applyMutation(upsert({ title: "Disposable", body: twoSection }));
  assert.equal((await index.getChunkStates(uid)).length, 2);

  const stat = await storage.stat(uid);
  assert.ok(stat);
  await rm(stat.path); // simulate a manual Obsidian deletion

  await engine.reindex(); // full rebuild
  assert.equal((await index.getChunkStates(uid)).length, 0, "chunks purged");
  assert.equal(await index.getNoteHash(uid), null, "note metadata purged");
});

test("renaming a note (same uid, new path) is a metadata update, not delete+create", async (t) => {
  const { engine, storage, index, embeddings } = await setup(t);
  const { uid } = await engine.applyMutation(upsert({ title: "Old Title", body: "## Only\nSingle section." }));
  const before = await storage.stat(uid);
  assert.ok(before);
  const chunksBefore = (await index.getChunkStates(uid)).map((s) => s.chunk_id).sort();

  // Rename the file on disk; frontmatter uid is unchanged.
  await rename(before.path, join(dirname(before.path), "Renamed Title.md"));

  embeddings.passageEmbeds = 0;
  const r = await engine.reindex();
  assert.equal(embeddings.passageEmbeds, 0, "rename re-embeds nothing");
  assert.equal(r.chunks_deleted, 0, "not treated as a deletion");

  const after = await storage.read(uid);
  assert.ok(after);
  assert.equal(after.frontmatter.uid, uid, "same uid");
  assert.equal(after.title, "Renamed Title", "title (from filename) updated");
  assert.deepEqual((await index.getChunkStates(uid)).map((s) => s.chunk_id).sort(), chunksBefore, "same chunk ids");
});

test("reindex bootstraps a uid-less note: injects uid + anchors, defaults type to inbox", async (t) => {
  const { engine, storage, index, embeddings, vault } = await setup(t);

  // An externally-authored note with NO frontmatter (as if written directly in Obsidian).
  await mkdir(vault, { recursive: true });
  await writeFile(join(vault, "Legacy Note.md"), "# Idea\nOlder content with no frontmatter.\n", "utf8");

  const r = await engine.reindex(); // full rebuild → bootstrap runs first
  assert.equal(r.notes_scanned, 1);

  const raw = await readFile(join(vault, "Legacy Note.md"), "utf8");
  assert.match(raw, /^uid: [0-9A-Z]{26}/m, "a ULID uid was injected");
  assert.match(raw, /type: inbox/, "type defaulted to inbox (unclassified)");
  assert.match(raw, /<!-- cid:/, "a cid anchor was injected");

  const refs = await storage.list();
  assert.equal(refs.length, 1);
  const uid = refs[0]?.uid ?? "";
  assert.ok((await index.getChunkStates(uid)).length >= 1, "the note is now indexed");

  embeddings.passageEmbeds = 0;
  const r2 = await engine.reindex();
  assert.equal(r2.chunks_reembedded, 0, "second reindex is idempotent (no re-mint, no re-embed)");
});

test("write guard: an external edit makes a subsequent upsert refuse rather than clobber", async (t) => {
  const { engine, storage } = await setup(t);
  const { uid } = await engine.applyMutation(upsert({ title: "Guarded", body: twoSection }));

  // External edit behind the engine's back (index baseline is now stale).
  const stored = await storage.read(uid);
  assert.ok(stored);
  await storage.write({ title: stored.title, frontmatter: stored.frontmatter, body: `${stored.body}\n\nEXTERNAL EDIT.` });

  await assert.rejects(
    engine.applyMutation(upsert({ uid, title: "Guarded", body: "caller's replacement body" })),
    (err: unknown) => {
      assert.ok(err instanceof WriteGuardError, "throws WriteGuardError");
      assert.equal(err.uid, uid);
      assert.match(err.message, /reindex/i, "tells the caller to reindex first");
      return true;
    },
  );

  // The external edit must still be on disk — not clobbered.
  const after = await storage.read(uid);
  assert.match(after?.body ?? "", /EXTERNAL EDIT\./, "external edit preserved");
  assert.doesNotMatch(after?.body ?? "", /caller's replacement body/, "caller's write did not land");
});
