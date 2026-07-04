// M1 smoke test: create a note via the FileSystemAdapter → assert the file lands
// on disk AND a commit appears in the vault's git log. Also verifies uid round-trip,
// string-preservation of ISO dates, and the title-collision suffix strategy.
//
// Run: npm run build && node dist/scripts/m1-smoke.js

import { mkdtemp, stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { FileSystemAdapter } from "../storage/file-system-adapter.js";
import { newUid } from "../core/id.js";
import type { Note } from "../types.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    throw new Error(msg);
  }
  console.log(`  ✓ ${msg}`);
}

async function main(): Promise<void> {
  const vault = await mkdtemp(join(tmpdir(), "nexus-m1-"));
  console.log(`vault: ${vault}\n`);

  const adapter = new FileSystemAdapter(vault);
  const now = new Date().toISOString();
  const uid = newUid();

  const note: Note = {
    title: "MEXC API Rate Limits",
    frontmatter: {
      uid,
      type: "reference",
      project: "trading-bot",
      status: "active",
      source: "manual",
      verified: false,
      created: now,
      updated: now,
      tags: ["mexc", "api"],
    },
    body: "## Summary\nMEXC caps public REST endpoints; back off on HTTP 429.\n",
  };

  console.log("write + commit:");
  const stored = await adapter.write(note);
  const commit = await adapter.commit(`upsert | ${uid} | create`);

  // 1. file exists on disk
  await fsStat(stored.path); // throws if missing
  assert(true, `file exists at ${stored.path.replace(`${vault}/`, "")}`);

  // 2. a commit appears, tagged tool | uid | action
  const git = simpleGit(vault);
  const log = await git.log();
  assert(log.total === 1, `exactly one commit in the log (got ${log.total})`);
  assert(log.latest?.hash === commit.hash, "commit() hash matches git log HEAD");
  assert(log.latest?.message === `upsert | ${uid} | create`, "commit message is `tool | uid | action`");

  // 3. round-trips by uid, with ISO dates preserved as strings (no YAML Date coercion)
  const back = await adapter.read(uid);
  assert(back !== null, "read(uid) returns the note");
  assert(back.frontmatter.uid === uid, "uid preserved");
  assert(typeof back.frontmatter.created === "string", "created stayed a string (no Date coercion)");
  assert(back.frontmatter.project === "trading-bot", "project preserved");
  assert(back.content_hash === stored.content_hash, "on-disk hash matches the written hash");

  // 4. title collision (different uid, same title) → distinct, uid-suffixed filename
  const other: Note = { ...note, frontmatter: { ...note.frontmatter, uid: newUid() } };
  const stored2 = await adapter.write(other);
  assert(stored2.path !== stored.path, "second note with same title gets a distinct filename");

  console.log("\nM1 smoke: PASS");
}

main().catch((err: unknown) => {
  console.error("\nM1 smoke: FAIL");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
