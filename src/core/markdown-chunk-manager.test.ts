// ChunkManager edge-case tests. These are PURE (operate on an in-memory Note),
// so no filesystem/vault is touched at all — nothing to clean up.
//
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { MarkdownChunkManager } from "./markdown-chunk-manager.js";
import type { Chunk, Note } from "../types.js";

function makeNote(uid: string, body: string): Note {
  return {
    title: "T",
    frontmatter: {
      uid,
      type: "reference",
      status: "active",
      source: "manual",
      verified: false,
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
    },
    body,
  };
}

/** Deterministic slug minter: s1, s2, s3, … */
function seq(prefix = "s"): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;
const ids = (cs: Chunk[]): string[] => cs.map((c) => c.chunk_id);

test("golden note → expected chunk ids and injected anchors", () => {
  const cm = new MarkdownChunkManager({ mintSlug: seq() });
  const body = ["Intro paragraph.", "", "## Alpha", "Alpha body.", "", "## Beta", "Beta body."].join("\n");

  const { body: out, chunks } = cm.chunk(makeNote("U", body));

  assert.deepEqual(ids(chunks), ["U::__preamble#0", "U::s1#0", "U::s2#0"]);
  // anchors injected on the line directly below each heading
  assert.match(out, /## Alpha\n<!-- cid:s1 -->/);
  assert.match(out, /## Beta\n<!-- cid:s2 -->/);
  // preamble content is the pre-heading text, anchors/headings excluded
  assert.equal(chunks.find((c) => c.slug === "__preamble")?.content, "Intro paragraph.");
});

test("renaming a heading keeps chunk ids identical (ids come from anchors, not text)", () => {
  // First pass mints and persists the anchors.
  const anchored = new MarkdownChunkManager({ mintSlug: seq() }).chunk(
    makeNote("U", ["Intro.", "", "## Alpha", "A.", "", "## Beta", "B."].join("\n")),
  ).body;

  // Rename the heading TEXT in the persisted body.
  const renamed = anchored.replace("## Alpha", "## Alpha (renamed heading)");

  // Use a minter that would yield an obviously different slug IF it were ever called.
  const cm = new MarkdownChunkManager({ mintSlug: () => "MINTED" });
  const { chunks } = cm.chunk(makeNote("U", renamed));

  assert.deepEqual(ids(chunks), ["U::__preamble#0", "U::s1#0", "U::s2#0"]);
  assert.ok(!ids(chunks).some((id) => id.includes("MINTED")), "no slug was minted; all came from anchors");
  // the id is stable even though the heading text (and thus the embedded content) changed
  assert.match(chunks.find((c) => c.slug === "s1")?.heading ?? "", /renamed heading/);
});

test("two identical headings → distinct ids, no collision", () => {
  const cm = new MarkdownChunkManager({ mintSlug: seq() });
  const body = ["## Same", "First.", "", "## Same", "Second."].join("\n");

  const { chunks } = cm.chunk(makeNote("U", body));
  const headingChunks = chunks.filter((c) => c.slug !== "__preamble");

  assert.equal(headingChunks.length, 2);
  assert.deepEqual(ids(headingChunks), ["U::s1#0", "U::s2#0"]);
  assert.equal(new Set(ids(headingChunks)).size, 2, "ids are distinct");
  assert.ok(headingChunks.every((c) => c.heading === "Same"));
});

test("preamble before the first ## becomes its own __preamble chunk", () => {
  const cm = new MarkdownChunkManager({ mintSlug: seq() });
  const body = ["Just an intro, no heading yet.", "spanning two lines.", "", "## H", "Body."].join("\n");

  const { chunks } = cm.chunk(makeNote("U", body));
  const pre = chunks.find((c) => c.slug === "__preamble");

  assert.ok(pre, "has a __preamble chunk");
  assert.equal(pre?.chunk_id, "U::__preamble#0");
  assert.equal(pre?.heading, null);
  assert.equal(pre?.content, "Just an intro, no heading yet.\nspanning two lines.");
  assert.ok(chunks.some((c) => c.heading === "H"), "the heading section is still chunked");
});

test("a note whose sections are # splits on # (not lumped into one preamble)", () => {
  const cm = new MarkdownChunkManager({ mintSlug: seq() });
  const body = ["Intro before headings.", "", "# Alpha", "Alpha body.", "", "# Beta", "Beta body."].join("\n");

  const { body: out, chunks } = cm.chunk(makeNote("U", body));

  assert.deepEqual(ids(chunks), ["U::__preamble#0", "U::s1#0", "U::s2#0"]);
  assert.match(out, /^# Alpha\n<!-- cid:s1 -->/m);
  assert.match(out, /^# Beta\n<!-- cid:s2 -->/m);
  assert.equal(chunks.find((c) => c.slug === "s1")?.heading, "Alpha");
  assert.equal(chunks.find((c) => c.slug === "__preamble")?.content, "Intro before headings.");
});

test("a note mixing # sections with ## subheadings splits on #; the ## stays inside its parent chunk", () => {
  const cm = new MarkdownChunkManager({ mintSlug: seq() });
  const body = [
    "# Alpha",
    "Intro to alpha.",
    "## Alpha detail",
    "More alpha.",
    "# Beta",
    "Beta body.",
  ].join("\n");

  const { chunks } = cm.chunk(makeNote("U", body));

  // two top-level (#) sections, no preamble
  assert.deepEqual(ids(chunks), ["U::s1#0", "U::s2#0"]);
  const alpha = chunks.find((c) => c.slug === "s1");
  assert.equal(alpha?.heading, "Alpha");
  // the ## subheading and its text are CONTENT inside the # chunk, not a boundary
  assert.match(alpha?.content ?? "", /## Alpha detail/);
  assert.match(alpha?.content ?? "", /More alpha\./);
  // Beta is its own chunk and doesn't absorb alpha's ## content
  const beta = chunks.find((c) => c.slug === "s2");
  assert.equal(beta?.heading, "Beta");
  assert.doesNotMatch(beta?.content ?? "", /Alpha detail/);
});

test("regression: a note whose sections are ## still splits on ## exactly as before", () => {
  const cm = new MarkdownChunkManager({ mintSlug: seq() });
  const body = ["Intro.", "", "## Alpha", "A body.", "", "## Beta", "B body."].join("\n");

  const { body: out, chunks } = cm.chunk(makeNote("U", body));

  assert.deepEqual(ids(chunks), ["U::__preamble#0", "U::s1#0", "U::s2#0"]);
  assert.match(out, /^## Alpha\n<!-- cid:s1 -->/m);
  assert.equal(chunks.find((c) => c.slug === "s1")?.heading, "Alpha");
});

test("one oversize section is sub-split on ### with sub-ordinals", () => {
  // Tiny budget + word counter so the split is fully deterministic.
  const cm = new MarkdownChunkManager({ mintSlug: seq(), maxTokens: 12, countTokens: wordCount });
  const body = [
    "## Big",
    "### Alpha",
    "one two three four",
    "### Beta",
    "five six seven eight",
    "### Gamma",
    "nine ten eleven twelve",
  ].join("\n");

  const { chunks } = cm.chunk(makeNote("U", body));

  assert.equal(chunks.length, 3, "split into one chunk per ### subsection");
  assert.deepEqual(chunks.map((c) => c.ordinal), [0, 1, 2], "contiguous sub-ordinals");
  assert.deepEqual(ids(chunks), ["U::s1#0", "U::s1#1", "U::s1#2"], "same slug, distinct ordinals");
  assert.ok(chunks.every((c) => c.heading === "Big"), "all carry the parent heading");
  assert.match(chunks[0]!.content, /Alpha/);
  assert.match(chunks[1]!.content, /Beta/);
  assert.match(chunks[2]!.content, /Gamma/);
  assert.ok(chunks.every((c) => wordCount(c.content) <= 12), "every sub-chunk is within budget");
});
