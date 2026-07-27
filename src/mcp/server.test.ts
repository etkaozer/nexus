// M5 integration test: boot the MCP server in-process over the SDK's in-memory transport,
// connect a real Client, and drive all 6 tools end-to-end against a throwaway vault.
// A deterministic fake embedder keeps it fast; lexical (FTS) makes search hits reliable.
//
// Run: npm test

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FileSystemAdapter } from "../storage/file-system-adapter.js";
import { SqliteIndexProvider } from "../index/sqlite-index-provider.js";
import { MarkdownChunkManager } from "../core/markdown-chunk-manager.js";
import { NexusEngine } from "../engine/nexus-engine.js";
import { E5EmbeddingProvider } from "../embeddings/e5-embedding-provider.js";
import { createServer } from "./server.js";
import { buildInstructions } from "./instructions.js";
import { GUARD } from "./guard.js";
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

interface Harness {
  client: Client;
  storage: FileSystemAdapter;
  index: SqliteIndexProvider;
  engine: NexusEngine;
  dir: string;
}

async function setup(t: TestContext, opts: { instructions?: string } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-m5-"));
  const storage = new FileSystemAdapter(join(dir, "vault"));
  const index = new SqliteIndexProvider(join(dir, "brain.db"), new FakeEmbeddings());
  const engine = new NexusEngine({ storage, index, chunker: new MarkdownChunkManager() });

  const server = createServer(engine, opts.instructions !== undefined ? { instructions: opts.instructions } : {});
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
  return { client, storage, index, engine, dir };
}

/** Connect a throwaway client to an already-built server and read back the search description. */
async function describeSearch(t: TestContext, server: McpServer): Promise<string | undefined> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "desc-probe", version: "1.0.0" });
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const { tools } = await client.listTools();
  return tools.find((x) => x.name === "search")?.description;
}

/** Create a note through the tool boundary and return its uid. */
async function create(
  client: Client,
  args: { title: string; body: string; project?: string; type?: string; supersedes?: string },
): Promise<string> {
  const { title, body, project, type, supersedes } = args;
  const argv: Record<string, unknown> = { title, body, type: type ?? "decision", source: "manual" };
  if (project !== undefined) argv["project"] = project;
  if (supersedes !== undefined) argv["supersedes"] = supersedes;
  return jsonOf(await client.callTool({ name: "upsert", arguments: argv })).uid;
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
        title: "AcmeAPI Notes",
        type: "reference",
        source: "manual",
        body: "## Limits\nAcmeAPI returns HTTP 429 for SessionStore when throttled.",
      },
    }),
  );
  const uid1: string = created.uid;
  assert.equal(created.action, "create");
  assert.ok(uid1);

  // search finds it (exact rare token via lexical arm). Search now returns { hits, context } —
  // the bare array is gone, because the context slice has nowhere to live in an array.
  const found = jsonOf(await client.callTool({ name: "search", arguments: { query: "AcmeAPI" } }));
  const hits = found.hits;
  assert.ok(Array.isArray(hits) && hits.some((h: { uid: string }) => h.uid === uid1), "search finds the note");
  assert.equal(new Set(hits.map((h: { uid: string }) => h.uid)).size, hits.length, "note-level (no dup notes)");
  assert.equal(typeof found.context, "string", "search carries a context slice");

  // read returns it with backlinks + related_auto arrays
  const read1 = jsonOf(await client.callTool({ name: "read", arguments: { uid: uid1 } }));
  assert.equal(read1.frontmatter.uid, uid1);
  assert.ok(Array.isArray(read1.backlinks) && read1.backlinks.length === 0, "no backlinks yet");
  assert.ok(Array.isArray(read1.related_auto), "related_auto is a live array");

  // second note, then link note2 → note1
  const uid2: string = jsonOf(
    await client.callTool({
      name: "upsert",
      arguments: { title: "Notes App", type: "project-note", source: "manual", body: "## Plan\nUse the service." },
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
        title: "AcmeAPI Notes v2",
        type: "reference",
        source: "manual",
        body: "## Limits\nUpdated AcmeAPI limits.",
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

// ── the recall-priming layer: manifest, score interpretability, staleness signals ──────────

test("search hits carry a real cosine similarity, not just the RRF score", async (t) => {
  const { client } = await setup(t);
  await create(client, { title: "Rate limits", body: "## Limits\nAcmeAPI returns HTTP 429 when throttled." });

  const { hits } = jsonOf(await client.callTool({ name: "search", arguments: { query: "AcmeAPI throttling" } }));
  assert.ok(hits.length > 0, "found something to inspect");

  for (const h of hits) {
    // RRF is retained because it is what actually ordered the list — but it is no longer the
    // only number, because 1/(60+rank) says nothing about whether a hit is any good.
    assert.equal(typeof h.rrf_score, "number", "rrf_score still exposed");
    assert.ok(!("score" in h), "the ambiguous `score` field is gone");
    assert.ok(["vector", "lexical", "both"].includes(h.match), `match arm is declared: ${h.match}`);

    if (h.match === "lexical") {
      // The chosen convention: a missing cosine is reported as missing. The lexical arm computes
      // no cosine, and inventing one would be a fabricated measurement.
      assert.equal(h.similarity, null, "lexical-only hit reports similarity: null, never a faked number");
    } else {
      assert.equal(typeof h.similarity, "number", "vector-touched hit carries a cosine");
      assert.ok(h.similarity >= -1 && h.similarity <= 1, `cosine in range: ${h.similarity}`);
    }
  }
});

test("a lexical-only search reports every similarity as null", async (t) => {
  const { client } = await setup(t);
  await create(client, { title: "Rare token note", body: "## X\nSessionStore is the identifier." });

  const { hits } = jsonOf(
    await client.callTool({ name: "search", arguments: { query: "SessionStore", mode: "lexical" } }),
  );
  assert.ok(hits.length > 0, "lexical mode still finds the note");
  for (const h of hits) {
    assert.equal(h.match, "lexical");
    assert.equal(h.similarity, null);
  }
});

test("surfacing the cosine does not change ranking order — RRF still ranks", async (t) => {
  const { client, index, engine } = await setup(t);
  await create(client, { title: "AcmeAPI limits", body: "## Limits\nAcmeAPI returns HTTP 429 for SessionStore." });
  await create(client, { title: "Unrelated note", body: "## Other\nSomething entirely different here." });
  await create(client, { title: "Partial overlap", body: "## Mixed\nAcmeAPI is mentioned once." });

  const { hits } = await engine.search("AcmeAPI limits", { k: 10 });

  // Recompute the ranking from RRF alone and confirm the emitted order matches it: the extra
  // fields are reporting, not an input to ordering.
  const byRrf = [...hits].sort((a, b) => b.rrf_score - a.rrf_score).map((h) => h.uid);
  assert.deepEqual(hits.map((h) => h.uid), byRrf, "emitted order is exactly the RRF order");
  assert.ok(index.embeddingModel.length > 0);
});

test("a superseded note shows status + superseded_by on the search hit", async (t) => {
  const { client } = await setup(t);
  const oldUid = await create(client, {
    title: "Spot-only for MVP, no leverage",
    body: "## Decision\nUniqueTokenZzz: the trading bot stays spot-only. No leverage.",
    project: "trading-bot",
  });
  const newUid = await create(client, {
    title: "Leverage allowed up to 2x",
    body: "## Decision\nUniqueTokenZzz: revised — leverage up to 2x is now permitted.",
    project: "trading-bot",
    supersedes: oldUid,
  });

  const { hits } = jsonOf(await client.callTool({ name: "search", arguments: { query: "UniqueTokenZzz", k: 10 } }));

  // Search deliberately does NOT filter by status, so the retired note IS reachable. The defence
  // is structural: the wrongness is visible in the payload rather than left to be remembered.
  const stale = hits.find((h: { uid: string }) => h.uid === oldUid);
  assert.ok(stale, "the superseded note is still findable (lineage stays searchable)");
  assert.equal(stale.status, "superseded", "and it announces that it was replaced");
  assert.equal(stale.superseded_by, newUid, "with a pointer to what replaced it");

  const current = hits.find((h: { uid: string }) => h.uid === newUid);
  assert.equal(current.status, "active");
  assert.ok(!("superseded_by" in current), "the current note carries no reverse pointer");
});

test("search hits carry project and status for every hit", async (t) => {
  const { client } = await setup(t);
  await create(client, { title: "Projected", body: "## A\nDistinctWordAaa here.", project: "trading-bot" });
  const { hits } = jsonOf(await client.callTool({ name: "search", arguments: { query: "DistinctWordAaa" } }));
  const hit = hits.find((h: { title: string }) => h.title === "Projected");
  assert.ok(hit, "found the note");
  assert.equal(hit.project, "trading-bot", "project rides on the hit (the context slice needs it)");
  assert.equal(hit.status, "active");
});

test("read returns walkable lineage pointers on both ends of a supersession", async (t) => {
  const { client } = await setup(t);
  const oldUid = await create(client, { title: "Original decision", body: "## D\nThe first call." });
  const newUid = await create(client, { title: "Revised decision", body: "## D\nThe better call.", supersedes: oldUid });

  const oldNote = jsonOf(await client.callTool({ name: "read", arguments: { uid: oldUid } }));
  assert.deepEqual(
    oldNote.superseded_by,
    { uid: newUid, title: "Revised decision" },
    "the retired note names its replacement, so a reader knows it is not current",
  );
  assert.equal(oldNote.supersedes, null);

  const newNote = jsonOf(await client.callTool({ name: "read", arguments: { uid: newUid } }));
  assert.deepEqual(newNote.supersedes, { uid: oldUid, title: "Original decision" }, "chain walks backwards too");
  assert.equal(newNote.superseded_by, null, "the current note is the end of the chain");
});

test("read reports a dangling lineage pointer as dangling rather than inventing a title", async (t) => {
  const { client, storage, engine } = await setup(t);
  const uid = await create(client, { title: "Orphan", body: "## D\nBody." });

  const stored = await storage.read(uid);
  assert.ok(stored);
  await storage.write({
    title: stored.title,
    frontmatter: { ...stored.frontmatter, supersedes: "no-such-uid" },
    body: stored.body,
  });

  const result = await engine.read(uid);
  assert.deepEqual(result?.supersedes, { uid: "no-such-uid", title: null }, "null title, not a fabricated one");
});

test("the search response carries a complementary context slice, not a restatement", async (t) => {
  const { client } = await setup(t);
  await create(client, { title: "Alpha decision", body: "## A\nSharedTermBbb one.", project: "trading-bot" });
  await create(client, { title: "Beta decision", body: "## A\nSharedTermBbb two.", project: "trading-bot" });
  await create(client, { title: "Gamma decision", body: "## A\nSharedTermBbb three.", project: "trading-bot" });

  const res = jsonOf(await client.callTool({ name: "search", arguments: { query: "SharedTermBbb", k: 1 } }));
  assert.equal(res.hits.length, 1, "k=1 so most of the project is deliberately not shown");

  for (const h of res.hits) {
    assert.ok(!res.context.includes(h.title), "the slice must not repeat a returned title");
  }
  assert.match(res.context, /trading-bot: 3 active notes in the vault, 1 in this result set — 2 not shown here\./);
});

test("a zero-hit search answers with the vault's project slugs", async (t) => {
  const { client } = await setup(t);
  await create(client, { title: "Something", body: "## A\nContent.", project: "trading-bot" });
  await create(client, { title: "Else", body: "## A\nContent.", project: "notes-app" });

  const res = jsonOf(
    await client.callTool({ name: "search", arguments: { query: "zzzznomatchqqqq", mode: "lexical" } }),
  );
  assert.equal(res.hits.length, 0, "genuinely no hits");
  assert.match(res.context, /0 hits/);
  assert.ok(res.context.includes("trading-bot") && res.context.includes("notes-app"), "slugs offered on a miss");
});

test("the server EMITS the vault map in its initialize instructions (delivery is host-dependent)", async (t) => {
  // SCOPE — read this before trusting the test name. It proves the SERVER sends `instructions`
  // over the MCP boundary and that the payload is well-formed. It CANNOT prove the model ever
  // sees it: a host is free to receive `instructions` and discard them, and Claude Desktop does
  // exactly that. This test passed green while the map was reaching the model not at all.
  //
  // That is a known, accepted host limitation, not a bug to route around here: the map is far too
  // large to weld into a tool description, and a "check the map" trigger rule is worthless without
  // the map. The correct channel is instructions; this asserts we use it correctly, and the feature
  // starts working with zero code change once a host honours it.
  //
  // Anything that MUST reach the model lives in a tool description instead — see the guard tests,
  // which assert against listTools() and would fail if a clause regressed into instructions-only.
  const probe = await setup(t);
  await create(probe.client, { title: "Spot-only for MVP", body: "## D\nNo leverage.", project: "trading-bot" });
  const vaultMap = await probe.engine.vaultManifest({ now: "2026-07-27T12:00:00.000Z" });

  const { client } = await setup(t, { instructions: buildInstructions(vaultMap) });
  const instructions = client.getInstructions();
  assert.ok(instructions, "the server sent instructions at initialize");

  assert.match(instructions, /VAULT MAP/, "the map is delivered");
  assert.match(instructions, /trading-bot/, "with the actual project slugs in it");
  assert.match(instructions, /snapshot taken at session start/, "stamped as possibly stale");

  // The trigger rule's two clauses. The second is what keeps a project created in another chat
  // findable, so its absence would reintroduce the silent miss.
  assert.match(instructions, /appears in the vault map above/, "clause 1: map-driven trigger");
  assert.match(instructions, /EVEN IF nothing in the\s+map matches/, "clause 2: judgement escape hatch");

  // The citation guard, checkable against the reader's own transcript.
  assert.match(instructions, /only a uid you\s+have actually read with `read` during THIS session/);
  assert.match(instructions, /POINTERS, not sources/);
});

// Every assertion below reads client.listTools() and NEVER the instructions string. That is the
// point: a host may discard initialize.instructions entirely (Claude Desktop does), so a guard that
// lives only there reaches the model not at all. Asserting against the delivered tool description is
// the only check that tracks what the model can actually see.
test("the full citation guard is delivered in the search tool description, not just initialize", async (t) => {
  const { client } = await setup(t);
  const { tools } = await client.listTools();
  const search = tools.find((x) => x.name === "search");
  assert.ok(search?.description);

  // Each clause defends a distinct failure; all four must survive the instructions channel being dropped.
  assert.match(search.description, /POINTERS, not sources/, "titles/results are not sources");
  assert.match(
    search.description,
    /only a uid you have actually read with `read` during THIS session/,
    "session-scoping — the clause that makes the rule checkable at all",
  );
  assert.match(search.description, /A snippet is one chunk of one note, not the note\./, "snippet-seduction");
  assert.match(
    search.description,
    /you may say that a relevant note appears to exist and offer to open it/,
    "the permitted fallback, so the guard is not purely prohibitive",
  );
  assert.match(search.description, /Spot-only for MVP, no leverage/, "the concrete worked example");
  assert.match(search.description, /superseded/, "and the staleness rule too");
});

test("the citation rule is also on read — the end of the transaction where it is earned", async (t) => {
  const { client } = await setup(t);
  const { tools } = await client.listTools();
  const read = tools.find((x) => x.name === "read");
  assert.ok(read?.description);
  assert.match(read.description, /only tool that lets you state what a note says/);
  assert.match(
    read.description,
    /only a uid you have actually read with `read` during THIS session/,
    "the same session-scoped rule, verbatim",
  );
});

test("the guard's clauses are single-sourced — no drift between instructions and tool descriptions", async (t) => {
  // The regression this pins: the guard was written out twice, the copies diverged within one
  // change, and the weaker copy was the one delivered. Both surfaces must quote the SAME strings.
  const { client } = await setup(t);
  const { tools } = await client.listTools();
  const search = tools.find((x) => x.name === "search")?.description ?? "";
  const instructions = buildInstructions("Vault map — test.");

  const read = tools.find((x) => x.name === "read")?.description ?? "";
  for (const [name, clause] of Object.entries(GUARD)) {
    assert.ok(search.includes(clause), `search carries GUARD.${name} verbatim`);
    assert.ok(instructions.includes(clause), `instructions carry GUARD.${name} verbatim`);
  }
  assert.ok(read.includes(GUARD.uidOnly), "read carries GUARD.uidOnly verbatim");
});

test("the guard is NOT pasted into the four tools it does not apply to", async (t) => {
  // Repeating a rule in all six descriptions is how descriptions get skimmed.
  const { client } = await setup(t);
  const { tools } = await client.listTools();
  for (const name of ["upsert", "archive", "link", "reindex"]) {
    const desc = tools.find((x) => x.name === name)?.description ?? "";
    assert.ok(!desc.includes(GUARD.pointers), `${name} does not restate the guard`);
    assert.ok(!desc.includes(GUARD.uidOnly), `${name} does not restate the citation rule`);
  }
});

test("the similarity calibration is model-bound, not hardcoded in the tool layer", async (t) => {
  // A future model swap must carry its own numbers rather than leave a confidently wrong
  // sentence behind — so the description is built from whatever the provider declares.
  const dir = await mkdtemp(join(tmpdir(), "nexus-cal-"));
  const storage = new FileSystemAdapter(join(dir, "vault"));
  const index = new SqliteIndexProvider(join(dir, "brain.db"), new FakeEmbeddings());
  const engine = new NexusEngine({ storage, index, chunker: new MarkdownChunkManager() });
  t.after(async () => {
    index.close();
    await rm(dir, { recursive: true, force: true });
  });

  // FakeEmbeddings declares no calibration → no calibration claim is made at all.
  assert.equal(index.similarityCalibration, undefined, "a provider may decline to state one");
  const bare = createServer(engine);
  const bareDesc = (await describeSearch(t, bare)) ?? "";
  assert.ok(!bareDesc.includes("Interpreting `similarity`"), "no calibration invented when none is declared");

  // A provider that declares one gets ITS numbers, verbatim.
  const madeUp = { floor: 0.11, strong: 0.99, note: "Totally different band for this made-up model." };
  const withCal = createServer(engine, { similarity: madeUp });
  const calDesc = (await describeSearch(t, withCal)) ?? "";
  assert.match(calDesc, /Totally different band for this made-up model\./, "the provider's own sentence is used");
  assert.ok(!calDesc.includes("0.70"), "no e5 numbers leak into a different model's description");
});

test("the real e5 provider ships a calibration measured for e5", async () => {
  const e5 = new E5EmbeddingProvider({});
  const cal = e5.similarityCalibration;
  assert.ok(cal, "e5 declares its band");
  assert.ok(cal.floor > 0.5 && cal.floor < 0.8, `floor ~0.70, got ${cal.floor}`);
  assert.ok(cal.strong > cal.floor && cal.strong < 1, `strong above floor, got ${cal.strong}`);
  assert.match(cal.note, /multilingual-e5-small/, "the sentence names the model it belongs to");
});

test("an index written by an older build migrates and backfills without losing the write guard", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-legacy-"));
  const dbPath = join(dir, "brain.db");
  const storage = new FileSystemAdapter(join(dir, "vault"));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  // Build a normal index, then strip it back to the OLD schema to stand in for a user's
  // existing brain.db: drop the two columns this feature added.
  {
    const index = new SqliteIndexProvider(dbPath, new FakeEmbeddings());
    const engine = new NexusEngine({ storage, index, chunker: new MarkdownChunkManager() });
    await engine.applyMutation({
      kind: "upsert",
      title: "Legacy note",
      type: "decision",
      project: "trading-bot",
      body: "## D\nA decision made before the upgrade.",
      source: "manual",
    });
    index.close();
  }
  const legacy = new Database(dbPath);
  legacy.exec(`ALTER TABLE notes DROP COLUMN updated; ALTER TABLE notes DROP COLUMN superseded_by;`);
  const baselineBefore = (legacy.prepare(`SELECT content_hash FROM notes`).get() as { content_hash: string })
    .content_hash;
  legacy.close();

  // Reopening runs the migration automatically — no manual step, no crash on the old file.
  const index = new SqliteIndexProvider(dbPath, new FakeEmbeddings());
  const engine = new NexusEngine({ storage, index, chunker: new MarkdownChunkManager() });
  t.after(() => index.close());

  assert.equal(await index.countUnbackfilledNotes(), 1, "the old row is detected as needing a backfill");
  const degraded = await engine.vaultManifest({ now: "2026-07-27T12:00:00.000Z" });
  assert.match(degraded, /trading-bot/, "even pre-backfill the map is complete, just recency-blind");

  assert.equal(await engine.refreshMetadata(), 1, "backfill refreshed the row");
  assert.equal(await index.countUnbackfilledNotes(), 0, "and nothing is left stale");

  const after = (
    new Database(dbPath).prepare(`SELECT content_hash, updated FROM notes`).get() as {
      content_hash: string;
      updated: string;
    }
  );
  assert.ok(after.updated, "updated is populated");
  // The critical one: the backfill must not adopt the on-disk hash as the new guard baseline,
  // or an unindexed Obsidian edit would be silently forgiven and clobbered by the next upsert.
  assert.equal(after.content_hash, baselineBefore, "write-guard baseline untouched by the backfill");
});

test("the metadata backfill does not disarm the write guard on an externally edited note", async (t) => {
  const { client, storage, engine } = await setup(t);
  const uid = await create(client, { title: "Guarded too", body: "## A\nOriginal." });

  // Edit on disk behind the engine's back, then run the backfill over it.
  const stored = await storage.read(uid);
  assert.ok(stored);
  await storage.write({
    title: stored.title,
    frontmatter: stored.frontmatter,
    body: `${stored.body}\n\nEDITED IN OBSIDIAN.`,
  });
  await engine.refreshMetadata();

  const guarded = await client.callTool({
    name: "upsert",
    arguments: { uid, title: "Guarded too", type: "decision", source: "manual", body: "clobbering body" },
  });
  assert.equal((guarded as ResultShape).isError, true, "the guard still fires after a backfill");
  const after = jsonOf(await client.callTool({ name: "read", arguments: { uid } }));
  assert.match(after.body, /EDITED IN OBSIDIAN\./, "the external edit survived");
});

test("the metadata backfill scans the vault once, not once per note", async (t) => {
  // The naive loop (list() then read() per uid) was O(N^2): read() rescans the ENTIRE vault per
  // lookup, so the backfill cost ~92s at 800 notes — on the path that runs BEFORE the server
  // answers initialize. Asserted by CALL COUNT rather than elapsed time: the mechanism is what
  // was wrong, and a wall-clock ratio at small N is just machine noise.
  const { client, storage, index, engine: seed } = await setup(t);
  const n = 12;
  for (let i = 0; i < n; i++) await create(client, { title: `Note ${i}`, body: `## S\nBody ${i}.` });
  assert.equal((await seed.vaultManifest()).length > 0, true);

  let perUidReads = 0;
  let fullScans = 0;
  const counting: typeof storage = Object.create(storage);
  counting.read = async (uid: string) => {
    perUidReads += 1;
    return storage.read(uid);
  };
  counting.readAll = async () => {
    fullScans += 1;
    return storage.readAll();
  };
  counting.list = async () => {
    fullScans += 1;
    return storage.list();
  };

  const engine = new NexusEngine({ storage: counting, index, chunker: new MarkdownChunkManager() });
  assert.equal(await engine.refreshMetadata(), n, "every note refreshed");

  assert.equal(perUidReads, 0, "no per-uid read() — each one would rescan the whole vault");
  assert.equal(fullScans, 1, `exactly one full scan for the whole backfill, got ${fullScans}`);
});

test("the backfill gate closes even when the index holds rows for deleted notes", async (t) => {
  // Such a row keeps `updated IS NULL` forever, so countUnbackfilledNotes() stayed > 0 and the
  // whole backfill re-ran on EVERY server start rather than once.
  const { client, storage, index, engine } = await setup(t);
  const keep = await create(client, { title: "Kept", body: "## A\nStays." });
  const gone = await create(client, { title: "Deleted", body: "## A\nWill be removed." });

  const stored = await storage.read(gone);
  assert.ok(stored);
  await rm(stored.path, { force: true });

  await engine.refreshMetadata();
  assert.equal(await index.countUnbackfilledNotes(), 0, "gate closes — no perpetual re-run");

  const summaries = await index.listNoteSummaries();
  assert.deepEqual(summaries.map((s) => s.uid), [keep], "the orphaned index row was purged");
});

test("the backfill refuses to purge the index when the vault is unreachable", async (t) => {
  // An unmounted drive or a wrong path makes readAll() return [] — an unguarded purge would
  // then wipe the entire index instead of doing nothing.
  const dir = await mkdtemp(join(tmpdir(), "nexus-empty-"));
  const realVault = new FileSystemAdapter(join(dir, "vault"));
  const index = new SqliteIndexProvider(join(dir, "brain.db"), new FakeEmbeddings());
  const seeded = new NexusEngine({ storage: realVault, index, chunker: new MarkdownChunkManager() });
  t.after(async () => {
    index.close();
    await rm(dir, { recursive: true, force: true });
  });
  await seeded.applyMutation({
    kind: "upsert",
    title: "Precious",
    type: "decision",
    body: "## A\nMust survive.",
    source: "manual",
  });
  assert.equal((await index.listNoteSummaries()).length, 1);

  const missingVault = new FileSystemAdapter(join(dir, "does-not-exist"));
  const engine = new NexusEngine({ storage: missingVault, index, chunker: new MarkdownChunkManager() });
  assert.equal(await engine.refreshMetadata(), 0, "nothing refreshed");
  assert.equal((await index.listNoteSummaries()).length, 1, "the index was NOT wiped");
});

test("readAll returns every note in one pass and still rejects duplicate uids", async (t) => {
  const { client, storage } = await setup(t);
  await create(client, { title: "One", body: "## A\nFirst." });
  await create(client, { title: "Two", body: "## A\nSecond." });

  const all = await storage.readAll();
  assert.equal(all.length, 2, "both notes returned");
  assert.ok(all.every((n) => n.body.length > 0 && n.frontmatter.uid && n.content_hash), "fully hydrated");

  // Same uniqueness contract as read(): refuse to guess rather than pick one arbitrarily.
  const first = all[0];
  assert.ok(first);
  await writeFile(join(dirname(first.path), "clone.md"), await readFile(first.path, "utf8"));
  await assert.rejects(() => storage.readAll(), /Duplicate uid/);
});
