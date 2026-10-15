// Cross-lingual retrieval, measured rather than assumed.
//
// The vault is mixed Turkish/English, and multilingual-e5-small was chosen FOR that. But "the
// model is multilingual" was only ever an assumption about this repo — nothing exercised the real
// model through the real search path, so nobody knew which cross-lingual queries actually work.
// These tests were written from measurements, and they encode a result that is ASYMMETRIC:
//
//   • English query → Turkish note, by meaning alone: WORKS. The same-topic Turkish note beats a
//     same-language, different-topic English note.
//   • Turkish query → English note, by meaning alone: DOES NOT. Language dominates topic — a
//     Turkish query pulls a WRONG-TOPIC Turkish note above the right-topic English one.
//   • That weak direction is rescued by the hybrid default whenever the query carries a rare token
//     that survives translation (AcmeAPI, HTTP 429) — which is what real queries about code and
//     APIs look like. The lexical arm does not care what language anything is in.
//
// The third test is the load-bearing one: it is the reason `hybrid` is the default mode and not a
// nicety. Test two deliberately pins a LIMITATION. If a future model swap fixes it, that test
// fails — and that failure is the notification, not a regression.
//
// These use the REAL model (~110MB, downloaded once to ~/.cache/nexus/models), because a fake
// embedder cannot have a language bias to find. Everything else in the suite stays fake and fast.
//
// Run: npm test

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemAdapter } from "../storage/file-system-adapter.js";
import { SqliteIndexProvider } from "../index/sqlite-index-provider.js";
import { MarkdownChunkManager } from "../core/markdown-chunk-manager.js";
import { NexusEngine } from "../engine/nexus-engine.js";
import { E5EmbeddingProvider } from "./e5-embedding-provider.js";
import type { SearchHit } from "../types.js";

/** A throwaway vault indexed with the real e5 model, plus title↔uid lookup both ways. */
async function vaultOf(t: TestContext, notes: Array<[title: string, body: string]>) {
  const dir = await mkdtemp(join(tmpdir(), "nexus-xlingual-"));
  const storage = new FileSystemAdapter(join(dir, "vault"));
  const index = new SqliteIndexProvider(join(dir, "brain.db"), new E5EmbeddingProvider({}));
  const engine = new NexusEngine({ storage, index, chunker: new MarkdownChunkManager() });
  t.after(async () => {
    index.close();
    await rm(dir, { recursive: true, force: true });
  });

  const titleOf = new Map<string, string>();
  for (const [title, body] of notes) {
    const { uid } = await engine.applyMutation({ kind: "upsert", title, type: "decision", body, source: "manual" });
    titleOf.set(uid, title);
  }

  /** Search and return the ranked titles — the ordering IS the claim being tested. */
  const ranked = async (query: string, mode: "hybrid" | "vector" | "lexical"): Promise<string[]> => {
    const { hits } = await engine.search(query, { mode, k: 10 });
    return hits.map((h: SearchHit) => titleOf.get(h.uid) ?? h.uid);
  };
  return { engine, ranked, titleOf };
}

// Same content, two topics, two languages. The 2x2 is what separates "clusters by topic"
// (what we want) from "clusters by language" (what actually happens in one direction).
const EN_BICYCLE: [string, string] = [
  "EN bicycle",
  "## Maintenance\nThe chain needs regular lubrication. Check the brake pads every month and replace them when worn.",
];
const TR_BICYCLE: [string, string] = [
  "TR bicycle",
  "## Bakim\nZincirin duzenli olarak yaglanmasi gerekiyor. Fren balatalarini her ay kontrol et ve asinmissa degistir.",
];
const EN_RATELIMIT: [string, string] = [
  "EN ratelimit",
  "## Decision\nThe payment service returns 429 once a client exceeds its hourly quota. Clients must back off exponentially and retry later.",
];
const TR_COOKING: [string, string] = [
  "TR cooking",
  "## Tarif\nSogani yagda kavur, sonra domatesi ekle ve kisik ateste pisir. Tuzu en sona birak.",
];

test("an English query retrieves a Turkish note on the same topic, by meaning alone", async (t) => {
  // The genuine cross-lingual guarantee. `vector` mode, and the query shares no token with the
  // Turkish note, so nothing here can be lexical luck — the only way this passes is if the two
  // languages land near each other in the embedding space.
  const { ranked } = await vaultOf(t, [TR_BICYCLE, EN_RATELIMIT, TR_COOKING]);

  const hits = await ranked("how often should the bicycle chain be lubricated", "vector");
  assert.equal(hits[0], "TR bicycle", "the Turkish note about bicycles wins, over two off-topic notes");

  // And it is not merely present — it beats the note written in the QUERY's own language.
  assert.ok(hits.indexOf("TR bicycle") < hits.indexOf("EN ratelimit"), "topic beats language in this direction");
});

test("a Turkish query does NOT reliably retrieve an English note by meaning alone", async (t) => {
  // A pinned LIMITATION, not a wish. Measured: the Turkish query scores the wrong-topic Turkish
  // note ~0.83 and the right-topic English note ~0.75, so language wins over topic.
  //
  // This is why the vault map and the tool descriptions matter more than raw recall for a
  // Turkish-speaking user, and why the next test exists. If a future embedding model fixes this,
  // THIS TEST WILL FAIL — that is the intended notification, not a regression to suppress.
  const { ranked } = await vaultOf(t, [EN_RATELIMIT, TR_BICYCLE, TR_COOKING]);

  const hits = await ranked("saatlik istek kotasi asilinca ne yapmali", "vector");
  assert.equal(hits.length, 3, "all three notes come back; the question is the ORDER");
  assert.notEqual(
    hits[0],
    "EN ratelimit",
    "known limitation: a same-language off-topic note outranks the English note that answers the question",
  );
  assert.ok(
    (hits[0] ?? "").startsWith("TR"),
    `language dominates topic in this direction — top hit was ${hits[0]}`,
  );
});

test("hybrid rescues the weak direction whenever the query carries a rare shared token", async (t) => {
  // The mitigation, and the reason `hybrid` is the DEFAULT rather than an option. Identifiers
  // survive translation intact: a Turkish sentence about an English-documented API still says
  // "AcmeAPI" and "429". The lexical arm is language-blind, so it lands the hit the vector arm
  // could not, and RRF fuses it to the top.
  const { ranked } = await vaultOf(t, [
    ["EN ratelimit", "## Decision\nThe AcmeAPI returns HTTP 429 once a client exceeds its hourly quota. Back off exponentially."],
    TR_BICYCLE,
    TR_COOKING,
  ]);
  const query = "AcmeAPI 429 donunce ne yapmali";

  // Vector alone puts the two Turkish notes within ~0.005 of the answer — far too close to rely on.
  const lexical = await ranked(query, "lexical");
  assert.deepEqual(lexical, ["EN ratelimit"], "the lexical arm finds it across languages, on the shared token");

  const hybrid = await ranked(query, "hybrid");
  assert.equal(hybrid[0], "EN ratelimit", "so the default mode answers a Turkish question from an English note");
});

test("the same-language, same-topic note always wins — cross-lingual never displaces it", async (t) => {
  // The guarantee that must hold in BOTH directions, or the asymmetry above would be a real
  // retrieval bug rather than a ranking preference among second-best answers.
  const { ranked } = await vaultOf(t, [EN_BICYCLE, TR_BICYCLE, EN_RATELIMIT, TR_COOKING]);

  assert.equal(
    (await ranked("how often should the bicycle chain be lubricated", "vector"))[0],
    "EN bicycle",
    "English query, English note on the same topic",
  );
  assert.equal(
    (await ranked("bisiklet zinciri ne siklikta yaglanmali", "vector"))[0],
    "TR bicycle",
    "Turkish query, Turkish note on the same topic",
  );
});
