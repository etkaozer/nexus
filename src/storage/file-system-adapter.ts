// FileSystemAdapter — the default StorageAdapter. Dumb document I/O over an
// Obsidian vault directory, using gray-matter for frontmatter and simple-git for
// the commit-on-write audit log.
//
// Identity is frontmatter.uid, NEVER the filename. All lookups resolve by scanning
// for a matching uid, so an Obsidian rename is transparent: same uid, new path.

import { readFile, writeFile, mkdir, readdir, stat as fsStat } from "node:fs/promises";
import { join, basename, dirname, relative } from "node:path";
import matter from "gray-matter";
import * as yaml from "js-yaml";
import { simpleGit, type SimpleGit } from "simple-git";
import type { StorageAdapter, CommitInfo, RawNote } from "../interfaces/storage-adapter.js";
import type { Note, StoredNote, NoteRef, NoteStat, Frontmatter } from "../types.js";
import { sha256 } from "../core/hash.js";

/** Directories we never treat as note content. */
const IGNORED_DIRS = new Set([".git", ".obsidian", ".trash", ".nexus"]);

/** Entries that must never enter the vault's git history (derived / editor-local / OS cruft). */
const GITIGNORE_ENTRIES = [".obsidian/", ".trash/", ".nexus/", "brain.db", "brain.db-*", ".DS_Store"];

// Force js-yaml's JSON schema for BOTH parse and stringify so that ISO date strings
// (created/updated) survive a round-trip AS STRINGS. The default YAML schema would
// silently coerce them into Date objects and violate the Frontmatter type.
const GM = {
  engines: {
    yaml: {
      parse: (s: string): object => (yaml.load(s, { schema: yaml.JSON_SCHEMA }) as object) ?? {},
      stringify: (o: object): string => yaml.dump(o, { schema: yaml.JSON_SCHEMA }),
    },
  },
};

/**
 * Thrown when the same frontmatter uid appears in more than one note. Identity must
 * be unique, so we refuse to guess which file the caller meant rather than silently
 * returning one (which could lead to overwriting the wrong note).
 */
export class DuplicateUidError extends Error {
  constructor(
    readonly uid: string,
    /** Vault-relative paths of every note carrying this uid. */
    readonly paths: string[],
  ) {
    super(
      `Duplicate uid "${uid}" found in ${paths.length} notes: ${paths.join(", ")}. ` +
        `Note identity (frontmatter uid) must be unique — resolve the conflict in Obsidian, then reindex.`,
    );
    this.name = "DuplicateUidError";
  }
}

interface ScannedNote {
  uid: string;
  path: string;
  title: string;
  raw: string;
  content_hash: string;
  frontmatter: Frontmatter;
  body: string;
}

export class FileSystemAdapter implements StorageAdapter {
  private gitInstance: SimpleGit | null = null;
  private repoReady = false;

  constructor(private readonly vaultPath: string) {}

  // Lazy so constructing the adapter never requires the vault dir to exist yet —
  // ensureRepo() creates the directory before this is first used.
  private git(): SimpleGit {
    this.gitInstance ??= simpleGit(this.vaultPath);
    return this.gitInstance;
  }

  async read(uid: string): Promise<StoredNote | null> {
    const found = await this.findByUid(uid);
    return found ? this.toStored(found) : null;
  }

  async write(note: Note): Promise<StoredNote> {
    await mkdir(this.vaultPath, { recursive: true });
    const existing = await this.findByUid(note.frontmatter.uid);

    let targetPath: string;
    let title: string;
    if (existing) {
      // Same uid → overwrite in place. This also absorbs an Obsidian rename: the
      // file may have moved, but we keep it where it now lives rather than renaming
      // it back. Filename stays; identity was never the filename.
      targetPath = existing.path;
      title = existing.title;
    } else {
      targetPath = await this.freshPath(note.title, note.frontmatter.uid);
      title = basename(targetPath, ".md");
    }

    const raw = matter.stringify(note.body, note.frontmatter, GM);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, raw, "utf8");

    return {
      title,
      frontmatter: note.frontmatter,
      body: note.body,
      path: targetPath,
      content_hash: sha256(raw),
    };
  }

  async list(): Promise<NoteRef[]> {
    const notes = await this.scanAll();
    return notes.map((n) => ({
      uid: n.uid,
      path: n.path,
      content_hash: n.content_hash,
      updated: n.frontmatter.updated,
    }));
  }

  // Always reads fresh from disk — never a cached hash. The write guard relies on
  // this returning the TRUE current on-disk state so an external Obsidian edit is
  // detected rather than masked by a stale value.
  async stat(uid: string): Promise<NoteStat | null> {
    const found = await this.findByUid(uid);
    if (!found) return null;
    return {
      uid: found.uid,
      path: found.path,
      content_hash: found.content_hash,
      updated: found.frontmatter.updated,
    };
  }

  async commit(message: string): Promise<CommitInfo> {
    await this.ensureRepo();
    // Stage Markdown changes (at any depth) + the .gitignore only. Everything else is also
    // gitignored, so the derived index / .obsidian / .trash can never enter history either way.
    await this.git().raw(["add", "-A", "--", "*.md", ".gitignore"]);
    const res = await this.git().commit(message);
    let hash = res.commit;
    if (!hash) {
      // Nothing to commit (no changes). Fall back to current HEAD if one exists.
      try {
        hash = (await this.git().revparse(["HEAD"])).trim();
      } catch {
        hash = "";
      }
    }
    return { hash, message };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private toStored(n: ScannedNote): StoredNote {
    return {
      title: n.title,
      frontmatter: n.frontmatter,
      body: n.body,
      path: n.path,
      content_hash: n.content_hash,
    };
  }

  private async freshPath(title: string, uid: string): Promise<string> {
    const base = toFilename(title);
    const first = join(this.vaultPath, `${base}.md`);
    if (!(await pathExists(first))) return first;
    // Filename collision with a DIFFERENT uid → disambiguate with a short uid suffix.
    return join(this.vaultPath, `${base}-${shortUid(uid)}.md`);
  }

  // Scans the WHOLE vault (no early exit) so a duplicated uid is detected and
  // rejected rather than silently resolved to whichever file happened to be first.
  private async findByUid(uid: string): Promise<ScannedNote | null> {
    const matches: ScannedNote[] = [];
    for await (const path of this.walk(this.vaultPath)) {
      const parsed = await this.parse(path);
      if (parsed && parsed.uid === uid) matches.push(parsed);
    }
    if (matches.length > 1) {
      throw new DuplicateUidError(
        uid,
        matches.map((m) => relative(this.vaultPath, m.path)).sort(),
      );
    }
    return matches[0] ?? null;
  }

  private async scanAll(): Promise<ScannedNote[]> {
    const out: ScannedNote[] = [];
    for await (const path of this.walk(this.vaultPath)) {
      const parsed = await this.parse(path);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  private async parse(path: string): Promise<ScannedNote | null> {
    const raw = await readFile(path, "utf8");
    const file = matter(raw, GM);
    const data = file.data as Partial<Frontmatter>;
    if (!data.uid) return null; // not a Nexus-managed note — ignore
    return {
      uid: data.uid,
      path,
      title: basename(path, ".md"),
      raw,
      content_hash: sha256(raw),
      frontmatter: data as Frontmatter,
      body: file.content,
    };
  }

  private async *walk(dir: string): AsyncGenerator<string> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // directory doesn't exist yet
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        yield* this.walk(join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith(".md")) {
        yield join(dir, e.name);
      }
    }
  }

  private async ensureRepo(): Promise<void> {
    if (this.repoReady) return;
    await mkdir(this.vaultPath, { recursive: true });
    let isRepo = false;
    try {
      isRepo = await this.git().checkIsRepo();
    } catch {
      isRepo = false;
    }
    if (!isRepo) {
      await this.git().init();
      // Deterministic identity for MCP-authored commits, set on a FRESH repo only.
      // An existing vault repo keeps whatever identity it already has.
      await this.git().addConfig("user.name", "Nexus", false, "local");
      await this.git().addConfig("user.email", "nexus@localhost", false, "local");
    }
    await this.ensureGitignore();
    this.repoReady = true;
  }

  // Idempotently make sure the vault .gitignore excludes derived/editor-local files.
  // Non-destructive: appends only the entries that are missing.
  private async ensureGitignore(): Promise<void> {
    const path = join(this.vaultPath, ".gitignore");
    let existing = "";
    try {
      existing = await readFile(path, "utf8");
    } catch {
      existing = "";
    }
    const present = new Set(
      existing
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    );
    const missing = GITIGNORE_ENTRIES.filter((e) => !present.has(e));
    if (missing.length === 0) return;

    const banner = existing.length === 0 ? "# Managed by Nexus — derived index & editor-local files (never source of truth)\n" : "";
    const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await writeFile(path, `${existing}${sep}${banner}${missing.join("\n")}\n`, "utf8");
  }

  async identifyAll(assign: (raw: RawNote) => Frontmatter): Promise<string[]> {
    const assigned: string[] = [];
    for await (const path of this.walk(this.vaultPath)) {
      const raw = await readFile(path, "utf8");
      const file = matter(raw, GM);
      const data = file.data as Record<string, unknown>;
      if (data["uid"]) continue; // already Nexus-managed
      const frontmatter = assign({ path, title: basename(path, ".md"), body: file.content, frontmatter: data });
      await writeFile(path, matter.stringify(file.content, frontmatter, GM), "utf8");
      assigned.push(frontmatter.uid);
    }
    return assigned;
  }
}

/**
 * Turn a title into an Obsidian-friendly filename: keep human-readable text
 * (spaces, case, Turkish/Unicode) and only strip characters illegal on disk or
 * problematic in wikilinks. This is NOT slugification — the filename is cosmetic.
 */
function toFilename(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : "untitled";
}

function shortUid(uid: string): string {
  return uid.slice(-6).toLowerCase();
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsStat(p);
    return true;
  } catch {
    return false;
  }
}
