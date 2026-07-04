// FileSystemAdapter edge-case tests. Uses node:test (built-in) and a fresh
// throwaway vault per test under the OS temp dir — never touches a real vault.
//
// Run: npm test   (builds, then `node --test dist/**/*.test.js`)

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { FileSystemAdapter, DuplicateUidError } from "./file-system-adapter.js";
import { newUid } from "../core/id.js";
import type { Note } from "../types.js";

/** A disposable vault dir, auto-removed when the test finishes. */
async function tempVault(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-fsa-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeNote(title: string, uid: string, body: string): Note {
  const now = new Date().toISOString();
  return {
    title,
    frontmatter: {
      uid,
      type: "idea",
      status: "active",
      source: "manual",
      verified: false,
      created: now,
      updated: now,
    },
    body,
  };
}

test("read(uid) throws a clear error when two files carry the same uid", async (t) => {
  const vault = await tempVault(t);
  const uid = newUid();

  // Bypass the adapter to seed the corrupt state: two distinct files, one uid.
  const raw = (marker: string): string =>
    `---\nuid: ${uid}\ntype: idea\nstatus: active\nsource: manual\n` +
    `verified: false\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\n---\n${marker}\n`;
  await writeFile(join(vault, "first.md"), raw("first"), "utf8");
  await writeFile(join(vault, "second.md"), raw("second"), "utf8");

  const adapter = new FileSystemAdapter(vault);

  await assert.rejects(adapter.read(uid), (err: unknown) => {
    assert.ok(err instanceof DuplicateUidError, "throws DuplicateUidError, not a silent return");
    assert.equal(err.uid, uid, "error carries the offending uid");
    assert.deepEqual(err.paths, ["first.md", "second.md"], "error names both conflicting files");
    assert.match(err.message, /duplicate uid/i, "message is human-readable");
    assert.ok(
      err.message.includes("first.md") && err.message.includes("second.md"),
      "message lists both filenames",
    );
    return true;
  });
});

test("title collision suffixes the second note and leaves the first file untouched", async (t) => {
  const vault = await tempVault(t);
  const adapter = new FileSystemAdapter(vault);

  const uid1 = newUid();
  const first = await adapter.write(makeNote("Ideas", uid1, "first body"));
  assert.equal(basename(first.path), "Ideas.md", "first note takes the plain filename");
  const firstBytesBefore = await readFile(first.path, "utf8");

  // A different note that wants the same title.
  const uid2 = newUid();
  const second = await adapter.write(makeNote("Ideas", uid2, "second body"));

  const expectedSuffixed = `Ideas-${uid2.slice(-6).toLowerCase()}.md`;
  assert.equal(basename(second.path), expectedSuffixed, "second note gets a uid-suffixed filename");
  assert.notEqual(second.path, first.path, "the two notes are distinct files");

  // The first file must be completely untouched: same name, same bytes.
  await fsStat(first.path); // still exists at its original path — throws if renamed/removed
  const firstBytesAfter = await readFile(first.path, "utf8");
  assert.equal(firstBytesAfter, firstBytesBefore, "first file's contents are unchanged");
  assert.equal(basename(first.path), "Ideas.md", "first file's name is unchanged");

  // Both still resolve to their own uids.
  assert.equal((await adapter.read(uid1))?.title, "Ideas");
  assert.equal((await adapter.read(uid2))?.title, expectedSuffixed.replace(/\.md$/, ""));
});
