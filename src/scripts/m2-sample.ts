// Prints a real note with <!-- cid --> anchors injected by the ChunkManager, so you
// can paste it straight into Obsidian and confirm with your own eyes that the anchors
// are invisible in reading mode.
//
// Run: npm run build && node dist/scripts/m2-sample.js

import { MarkdownChunkManager } from "../core/markdown-chunk-manager.js";
import { newUid } from "../core/id.js";
import type { Note } from "../types.js";

const uid = newUid();
const note: Note = {
  title: "Chunk anchor demo",
  frontmatter: {
    uid,
    type: "reference",
    status: "active",
    source: "manual",
    verified: false,
    created: "2026-07-04T00:00:00.000Z",
    updated: "2026-07-04T00:00:00.000Z",
  },
  body: [
    "A quick capture before any section — this is the preamble.",
    "",
    "# Trading Bot",
    "Use MEXC for spot; back off on HTTP 429 rate limits.",
    "",
    "# VisionCall",
    "Ship the call-scheduling flow first.",
    "",
  ].join("\n"),
};

const { body, chunks } = new MarkdownChunkManager().chunk(note);

console.log("=== PASTE EVERYTHING BETWEEN THE LINES INTO OBSIDIAN ===");
console.log("--------------------------------------------------------");
console.log("---");
console.log(`uid: ${uid}`);
console.log("type: reference");
console.log("---");
console.log(body);
console.log("--------------------------------------------------------");
console.log("\n=== chunk ids derived from it ===");
for (const c of chunks) {
  console.log(`${c.chunk_id}   heading=${JSON.stringify(c.heading)}`);
}
