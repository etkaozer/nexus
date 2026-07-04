// M6 test: the vault's git history must stay Markdown-only — the derived index (brain.db*),
// .obsidian/, .nexus/, and .trash/ can never enter it, even when present in the vault.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { FileSystemAdapter } from "./file-system-adapter.js";
import type { Note } from "../types.js";

function makeNote(uid: string, title: string, body: string): Note {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    title,
    frontmatter: { uid, type: "reference", status: "active", source: "manual", verified: false, created: now, updated: now },
    body,
  };
}

test("vault git history stays Markdown-only (no db / .obsidian / .trash noise)", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-git-"));
  const vault = join(dir, "vault");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const storage = new FileSystemAdapter(vault);

  // First mutation.
  await storage.write(makeNote("uidA", "Note A", "## X\nAlpha."));
  await storage.commit("upsert | uidA | create");

  // Simulate Obsidian + the derived index dropping noise into the vault.
  await mkdir(join(vault, ".obsidian"), { recursive: true });
  await writeFile(join(vault, ".obsidian", "workspace.json"), "{}");
  await writeFile(join(vault, "brain.db"), "db");
  await writeFile(join(vault, "brain.db-wal"), "wal");
  await mkdir(join(vault, ".nexus"), { recursive: true });
  await writeFile(join(vault, ".nexus", "brain.db"), "db");
  await mkdir(join(vault, ".trash"), { recursive: true });
  await writeFile(join(vault, ".trash", "old.md"), "trashed markdown"); // .md but under .trash/

  // Second mutation.
  await storage.write(makeNote("uidB", "Note B", "## Y\nBeta."));
  await storage.commit("upsert | uidB | create");

  const git = simpleGit(vault);
  const tracked = (await git.raw(["ls-files"]))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();

  assert.deepEqual(tracked, [".gitignore", "Note A.md", "Note B.md"], "only markdown + .gitignore is tracked");
  for (const noise of [".obsidian/workspace.json", "brain.db", "brain.db-wal", ".nexus/brain.db", ".trash/old.md"]) {
    assert.ok(!tracked.includes(noise), `${noise} must not be tracked`);
  }

  const log = await git.raw(["log", "--pretty=%s"]);
  assert.match(log, /upsert \| uidA \| create/);
  assert.match(log, /upsert \| uidB \| create/);
});
