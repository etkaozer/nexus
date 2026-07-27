// M3 integration tests: SqliteIndexProvider + real E5 embeddings + HybridRetriever.
// Uses a throwaway temp-dir brain.db (never a real vault). The model is loaded once
// and shared. Per the determinism note, we assert on RANKING/PRESENCE, never raw scores.
//
// Run: npm test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { E5EmbeddingProvider } from "../embeddings/e5-embedding-provider.js";
import { SqliteIndexProvider } from "./sqlite-index-provider.js";
import { HybridRetriever } from "../core/hybrid-retriever.js";
import { MarkdownChunkManager } from "../core/markdown-chunk-manager.js";
import { sha256 } from "../core/hash.js";
import type { Note, NoteType } from "../types.js";
import type { EmbeddingProvider, EmbeddingKind } from "../interfaces/embedding-provider.js";

const MODEL = "Xenova/multilingual-e5-small";

// uids of the four seeded notes
const A = "note-acme";
const B = "note-bread";
const C = "note-notes";
const D = "note-git";

let dir: string;
let dbPath: string;
let index: SqliteIndexProvider;
let retriever: HybridRetriever;

function makeNote(uid: string, title: string, type: NoteType, project: string | undefined, body: string): Note {
  const now = "2026-01-01T00:00:00.000Z";
  const fm: Note["frontmatter"] = {
    uid,
    type,
    status: "active",
    source: "manual",
    verified: false,
    created: now,
    updated: now,
  };
  if (project !== undefined) fm.project = project;
  return { title, frontmatter: fm, body };
}

async function indexNote(cm: MarkdownChunkManager, note: Note): Promise<void> {
  const { body, chunks } = cm.chunk(note);
  const meta: Parameters<SqliteIndexProvider["putNoteMeta"]>[0] = {
    uid: note.frontmatter.uid,
    title: note.title,
    type: note.frontmatter.type,
    source: note.frontmatter.source,
    verified: note.frontmatter.verified,
    status: note.frontmatter.status,
    updated: note.frontmatter.updated,
    content_hash: sha256(body),
  };
  if (note.frontmatter.project !== undefined) meta.project = note.frontmatter.project;
  await index.putNoteMeta(meta);
  await index.indexChunks(chunks);
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "nexus-m3-"));
  dbPath = join(dir, "brain.db");

  const t0 = Date.now();
  const embeddings = new E5EmbeddingProvider();
  await embeddings.warmup();
  const tLoad = Date.now();

  index = new SqliteIndexProvider(dbPath, embeddings);
  retriever = new HybridRetriever(index);
  const cm = new MarkdownChunkManager();

  await indexNote(
    cm,
    makeNote(A, "AcmeAPI Rate Limits", "reference", "trading-bot", [
      "## Limits",
      "AcmeAPI caps public REST endpoints and returns HTTP 429 once you exceed the quota.",
      "",
      "## Backoff",
      "When throttled by AcmeAPI, wait and retry using exponential backoff.",
    ].join("\n")),
  );
  await indexNote(
    cm,
    makeNote(B, "Sourdough Bread", "reference", undefined, [
      "## Method",
      "Mix flour and water, let the dough ferment overnight, then bake in a hot oven.",
    ].join("\n")),
  );
  await indexNote(
    cm,
    makeNote(C, "Notes App Scheduling", "project-note", "notes-app", [
      "## Flow",
      "Users pick an available slot and the app books a video call for them.",
    ].join("\n")),
  );
  await indexNote(
    cm,
    makeNote(D, "Git Basics", "reference", undefined, [
      "## Commits",
      "Every change is a commit; the log is your audit trail and your undo.",
    ].join("\n")),
  );
  const tIndex = Date.now();

  console.log(
    `  [timing] model load (cached): ${((tLoad - t0) / 1000).toFixed(2)}s | ` +
      `index 4 notes: ${((tIndex - tLoad) / 1000).toFixed(2)}s`,
  );
});

after(async () => {
  index.close();
  await rm(dir, { recursive: true, force: true });
});

test("vector search finds the semantically related note even when words differ", async () => {
  // No "AcmeAPI", no "429", no "rate limit" — purely semantic.
  const hits = await index.vectorSearch("how do web APIs throttle client requests", { k: 4 });
  assert.ok(hits.length > 0, "returns hits");
  assert.equal(hits[0]?.note_uid, A, "top vector hit is the AcmeAPI/limits note");
});

test("lexical search for AcmeAPI hits exactly (and only) the note that contains it", async () => {
  const hits = await index.lexicalSearch("AcmeAPI", { k: 10 });
  const notes = new Set(hits.map((h) => h.note_uid));
  assert.equal(hits[0]?.note_uid, A, "top lexical hit is the AcmeAPI note");
  assert.deepEqual([...notes], [A], "no other note matches the rare token AcmeAPI");
});

test("hybrid fuses both arms and rolls up to note level (no duplicate notes)", async () => {
  const hits = await retriever.search("AcmeAPI rate limits", { k: 10 });
  const uids = hits.map((h) => h.uid);
  assert.equal(new Set(uids).size, uids.length, "each note appears at most once");
  assert.equal(hits[0]?.uid, A, "the AcmeAPI note ranks first");
  // A has two matching chunks but must appear as a single SearchHit
  assert.equal(uids.filter((u) => u === A).length, 1, "the multi-chunk note is a single hit");
  assert.ok(hits[0]?.snippet.length > 0, "hit carries a snippet");
});

test("embedding_model and dim are stored per vector", async () => {
  const states = await index.getChunkStates();
  assert.ok(states.length >= 5, "all chunks recorded");
  assert.ok(states.every((s) => s.embedding_model === MODEL), "every chunk records its embedding model");

  // Inspect the raw db to confirm dim is persisted alongside each chunk.
  const raw = new Database(dbPath);
  sqliteVec.load(raw); // vec_chunks is a vec0 virtual table — the extension must be loaded to read it
  try {
    const dims = raw.prepare("SELECT DISTINCT dim FROM chunks").all() as { dim: number }[];
    assert.deepEqual(dims, [{ dim: 384 }], "every chunk stores dim=384");
    const chunkCount = (raw.prepare("SELECT COUNT(*) c FROM chunks").get() as { c: number }).c;
    const vecCount = (raw.prepare("SELECT COUNT(*) c FROM vec_chunks").get() as { c: number }).c;
    assert.equal(vecCount, chunkCount, "one stored vector per chunk");
  } finally {
    raw.close();
  }
});

test("anchor text (<!-- cid -->) never reaches the embedder", async (t) => {
  // A recording fake stands in for the embedder so we can inspect exactly what it receives.
  class RecordingEmbeddings implements EmbeddingProvider {
    readonly model = "fake-recording";
    readonly dim = 384;
    passages: string[] = [];
    queries: string[] = [];
    async embed(texts: string[], kind: EmbeddingKind): Promise<Float32Array[]> {
      (kind === "passage" ? this.passages : this.queries).push(...texts);
      return texts.map(() => {
        const v = new Float32Array(this.dim);
        v[0] = 1; // non-zero so cosine is well-defined
        return v;
      });
    }
  }

  const subDir = await mkdtemp(join(tmpdir(), "nexus-m3-anchor-"));
  t.after(() => rm(subDir, { recursive: true, force: true }));

  const fake = new RecordingEmbeddings();
  const idx = new SqliteIndexProvider(join(subDir, "brain.db"), fake);
  t.after(() => idx.close());

  // Two sections → two injected anchors in the body; content is anchor-stripped.
  let n = 0;
  const cm = new MarkdownChunkManager({ mintSlug: () => `cid${++n}` });
  const { body, chunks } = cm.chunk(
    makeNote("Z", "Anchor demo", "reference", undefined, "## Setup\nInstall it.\n\n## Notes\nAcmeAPI 429 here."),
  );

  await idx.putNoteMeta({
    uid: "Z",
    title: "Anchor demo",
    type: "reference",
    source: "manual",
    verified: false,
    status: "active",
    updated: "2026-01-01T00:00:00.000Z",
    content_hash: sha256(body),
  });
  await idx.indexChunks(chunks);

  assert.match(body, /<!-- cid:cid1 -->/, "anchors WERE injected into the persisted body");
  assert.ok(fake.passages.length >= 2, "the embedder received the chunk passages");
  assert.ok(
    fake.passages.every((p) => !p.includes("<!-- cid")),
    "no anchor text reached the embedder",
  );
  assert.ok(fake.passages.some((p) => p.includes("AcmeAPI 429 here.")), "real content did reach the embedder");
});
