// NexusEngine — concrete Engine. All side-effects (write → commit → index) and all
// safety (write guard) live here; the MCP tools are a thin layer that only calls these.
//
// The engine sees only the abstractions — never fs / git / sqlite / the embedding model.
// The IndexProvider owns its EmbeddingProvider, so "current model" is read live from
// index.embeddingModel, and search goes through the HybridRetriever over that index.

import type {
  Frontmatter,
  StoredNote,
  Chunk,
  NoteType,
  NoteStatus,
  NoteSource,
  SearchOptions,
  SearchResult,
  ReadResult,
  Backlink,
  RelatedNote,
  LineageRef,
  Mutation,
  MutationResult,
  MutationAction,
  UpsertMutation,
  ArchiveMutation,
  LinkMutation,
  ReindexOptions,
  ReindexResult,
} from "../types.js";
import type { StorageAdapter, RawNote } from "../interfaces/storage-adapter.js";
import type { IndexProvider, NoteIndexMeta, NoteMetaPatch } from "../interfaces/index-provider.js";
import type { ChunkManager } from "../core/chunk-manager.js";
import type { Engine } from "./engine.js";
import { ChangeDetector, type ChunkDiff } from "../core/change-detector.js";
import { HybridRetriever } from "../core/hybrid-retriever.js";
import {
  buildVaultManifest,
  buildSearchContext,
  type VaultManifestOptions,
} from "../core/vault-manifest.js";
import { WriteGuardError } from "./errors.js";
import { newUid } from "../core/id.js";

/** Everything the engine needs, injected as abstractions. */
export interface EngineDeps {
  storage: StorageAdapter;
  index: IndexProvider;
  chunker: ChunkManager;
  /** Optional — defaults to a HybridRetriever over the given index. */
  retriever?: HybridRetriever;
}

export class NexusEngine implements Engine {
  private readonly storage: StorageAdapter;
  private readonly index: IndexProvider;
  private readonly chunker: ChunkManager;
  private readonly retriever: HybridRetriever;
  private readonly detector = new ChangeDetector();

  constructor(deps: EngineDeps) {
    this.storage = deps.storage;
    this.index = deps.index;
    this.chunker = deps.chunker;
    this.retriever = deps.retriever ?? new HybridRetriever(deps.index);
  }

  // ── query path ───────────────────────────────────────────────────────────────

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
    const hits = await this.retriever.search(query, opts);
    // The slice is assembled HERE, not in the tool layer: it is derived from vault state, which
    // makes it engine work. The tool stays a formatter.
    const summaries = await this.index.listNoteSummaries();
    // status travels with each hit: the slice compares hit counts against ACTIVE vault counts,
    // and search returns retired notes on purpose, so the two are only comparable once split.
    const context = buildSearchContext(
      hits.map((h) => ({ uid: h.uid, status: h.status, ...(h.project !== undefined ? { project: h.project } : {}) })),
      summaries,
    );
    return { hits, context };
  }

  async read(uid: string): Promise<ReadResult | null> {
    const stored = await this.storage.read(uid);
    if (stored === null) return null;
    const fm = stored.frontmatter;
    const [backlinks, related_auto, supersedes, superseded_by] = await Promise.all([
      this.computeBacklinks(uid, stored.title),
      this.computeRelated(uid),
      this.resolveLineage(fm.supersedes),
      this.resolveLineage(fm.superseded_by),
    ]);
    return {
      frontmatter: fm,
      body: stored.body,
      backlinks,
      related_auto,
      supersedes,
      superseded_by,
    };
  }

  // Frontmatter carries bare uids; a bare uid is not walkable by a reader deciding whether it is
  // holding the current version. Resolving to uid + title makes the chain legible in the response
  // itself, rather than requiring another read just to learn what the pointer points at.
  private async resolveLineage(uid: string | undefined): Promise<LineageRef | null> {
    if (uid === undefined) return null;
    const target = await this.storage.read(uid);
    // A dangling pointer is reported as dangling. Inventing a title would be worse than a null.
    return { uid, title: target?.title ?? null };
  }

  async vaultManifest(opts: VaultManifestOptions = {}): Promise<string> {
    return buildVaultManifest(await this.index.listNoteSummaries(), opts);
  }

  // Backfill for an index written before `updated`/`superseded_by` were mirrored. Uses
  // patchNoteMeta, which cannot write content_hash — refreshing the write-guard baseline from
  // disk here would silently forgive an unindexed Obsidian edit and let the next upsert clobber it.
  async refreshMetadata(): Promise<number> {
    // readAll(), not list()+read() per uid: read() resolves a uid by scanning the entire vault,
    // so the per-note loop is quadratic — measured at ~92s for 800 notes, on a path that runs
    // before the server answers initialize.
    const notes = await this.storage.readAll();
    const live = new Set<string>();
    let refreshed = 0;
    for (const stored of notes) {
      live.add(stored.frontmatter.uid);
      const { content_hash: _ignored, ...patch } = this.buildMeta(stored);
      if (await this.index.patchNoteMeta(patch as NoteMetaPatch)) refreshed += 1;
    }

    // Drop index rows whose Markdown is gone. Two reasons: such a row is garbage by definition
    // (Markdown is the source of truth, and reindex already purges these), and while it survives
    // its `updated` stays NULL — which would keep the startup backfill gate open forever and
    // re-run this on every single launch.
    //
    // Guarded on a non-empty read: if the vault were unreachable (unmounted drive, wrong path)
    // readAll() returns [] and an unguarded purge would wipe the whole index.
    if (notes.length > 0) {
      for (const summary of await this.index.listNoteSummaries()) {
        if (!live.has(summary.uid)) await this.index.deleteNote(summary.uid);
      }
    }
    return refreshed;
  }

  // Authored wikilink graph: notes that link TO this note. Derived by scanning the vault.
  private async computeBacklinks(targetUid: string, targetTitle: string): Promise<Backlink[]> {
    const refs = await this.storage.list();
    const out: Backlink[] = [];
    for (const ref of refs) {
      if (ref.uid === targetUid) continue;
      const note = await this.storage.read(ref.uid);
      if (note === null) continue;
      if (wikilinkTargets(note.body).has(targetTitle)) {
        out.push({ uid: note.frontmatter.uid, title: note.title });
      }
    }
    return out;
  }

  // related_auto: vector neighbours, computed LIVE from the index at read time, rolled up
  // to note level. Never stored in the body.
  private async computeRelated(uid: string): Promise<RelatedNote[]> {
    const neighbors = await this.index.neighbors(uid, 20);
    const perNote = new Map<string, RelatedNote>();
    for (const n of neighbors) {
      const prev = perNote.get(n.note_uid);
      if (!prev || n.score > prev.score) {
        perNote.set(n.note_uid, { uid: n.note_uid, title: n.title, score: n.score });
      }
    }
    return [...perNote.values()].sort((a, b) => b.score - a.score).slice(0, 5);
  }

  // ── reindex: keep the derived index in sync with Markdown ─────────────────────

  async reindex(opts?: ReindexOptions): Promise<ReindexResult> {
    const acc: ReindexResult = {
      notes_scanned: 0,
      chunks_reembedded: 0,
      chunks_deleted: 0,
      chunks_reembedded_model_change: 0,
    };

    if (opts?.uid !== undefined) {
      await this.reindexNote(opts.uid, acc);
      return acc;
    }

    // Bootstrap: mint uids for externally-authored Markdown that has none yet, so those
    // notes become Nexus-managed. One-time; recorded as a single commit.
    const assigned = await this.storage.identifyAll((raw) => bootstrapFrontmatter(raw));
    if (assigned.length > 0) await this.storage.commit(`bootstrap | assigned ${assigned.length} uid(s)`);

    const refs = await this.storage.list();
    const live = new Set(refs.map((r) => r.uid));
    const indexedUids = new Set((await this.index.getChunkStates()).map((s) => s.note_uid));
    for (const uid of indexedUids) {
      if (!live.has(uid)) await this.index.deleteNote(uid);
    }
    for (const ref of refs) await this.reindexNote(ref.uid, acc);
    return acc;
  }

  private async reindexNote(uid: string, acc: ReindexResult): Promise<void> {
    const stored = await this.storage.read(uid);
    if (stored === null) {
      await this.index.deleteNote(uid);
      return;
    }
    acc.notes_scanned += 1;

    const { body: anchoredBody, chunks } = this.chunker.chunk(stored);
    let finalStored = stored;
    if (anchoredBody !== stored.body) {
      finalStored = await this.storage.write({
        title: stored.title,
        frontmatter: stored.frontmatter,
        body: anchoredBody,
      });
      await this.storage.commit(`reindex | ${uid} | anchors`);
    }

    const diff = await this.indexNote(finalStored, chunks);
    acc.chunks_reembedded += diff.toIndex.length;
    acc.chunks_deleted += diff.toDelete.length;
    acc.chunks_reembedded_model_change += diff.modelStale;
  }

  // ── mutation path: the single side-effect choke point ─────────────────────────

  async applyMutation(mutation: Mutation): Promise<MutationResult> {
    switch (mutation.kind) {
      case "upsert":
        return this.upsert(mutation);
      case "archive":
        return this.archive(mutation);
      case "link":
        return this.link(mutation);
    }
  }

  private async upsert(m: UpsertMutation): Promise<MutationResult> {
    const isCreate = m.uid === undefined;
    const uid = m.uid ?? newUid();
    const now = new Date().toISOString();

    let created = now;
    let verified = false;

    if (!isCreate) {
      // Write guard: FRESH disk hash vs last-indexed baseline. Mismatch = external edit.
      const baseline = await this.index.getNoteHash(uid);
      const stat = await this.storage.stat(uid);
      if (baseline !== null && stat !== null && baseline !== stat.content_hash) {
        throw new WriteGuardError(uid);
      }
      const existing = await this.storage.read(uid);
      if (existing !== null) {
        created = existing.frontmatter.created;
        verified = existing.frontmatter.verified;
      }
    }

    const frontmatter: Frontmatter = {
      uid,
      type: m.type,
      status: "active",
      source: m.source,
      verified,
      created,
      updated: now,
    };
    if (m.project !== undefined) frontmatter.project = m.project;
    if (m.supersedes !== undefined) frontmatter.supersedes = m.supersedes;

    // Chunk BEFORE writing so anchors are part of the single write we commit.
    const { body: anchoredBody, chunks } = this.chunker.chunk({ title: m.title, frontmatter, body: m.body });

    const stored = await this.storage.write({ title: m.title, frontmatter, body: anchoredBody });
    let action: MutationAction = isCreate ? "create" : "update";
    const commit = await this.storage.commit(`upsert | ${uid} | ${action}`);
    await this.indexNote(stored, chunks);

    const affected = [uid];

    // supersede: archive the replaced note and set the reverse pointer (both ways).
    if (m.supersedes !== undefined) {
      const superseded = await this.storage.read(m.supersedes);
      if (superseded !== null) {
        await this.rewriteFrontmatter(
          superseded,
          { status: "superseded", superseded_by: uid },
          `supersede | ${m.supersedes} | superseded-by ${uid}`,
        );
        affected.push(m.supersedes);
        action = "supersede";
      }
    }

    return { uid, action, affected_uids: affected, commit: commit.hash };
  }

  private async archive(m: ArchiveMutation): Promise<MutationResult> {
    const existing = await this.storage.read(m.uid);
    if (existing === null) throw new Error(`archive: no note found with uid ${m.uid}`);
    const commit = await this.rewriteFrontmatter(existing, { status: "archived" }, `archive | ${m.uid} | archive`);
    return { uid: m.uid, action: "archive", affected_uids: [m.uid], commit };
  }

  private async link(m: LinkMutation): Promise<MutationResult> {
    const from = await this.storage.read(m.from_uid);
    if (from === null) throw new Error(`link: no source note found with uid ${m.from_uid}`);
    const to = await this.storage.read(m.to_uid);
    if (to === null) throw new Error(`link: no target note found with uid ${m.to_uid}`);

    const linkLine = m.relation !== undefined ? `- [[${to.title}]] (${m.relation})` : `- [[${to.title}]]`;
    const newBody = addAuthoredLink(from.body, to.title, linkLine);

    const frontmatter: Frontmatter = { ...from.frontmatter, updated: new Date().toISOString() };
    const { body, chunks } = this.chunker.chunk({ title: from.title, frontmatter, body: newBody });
    const stored = await this.storage.write({ title: from.title, frontmatter, body });
    const commit = await this.storage.commit(`link | ${m.from_uid} | -> ${m.to_uid}`);
    await this.indexNote(stored, chunks);

    return { uid: m.from_uid, action: "link", affected_uids: [m.from_uid, m.to_uid], commit: commit.hash };
  }

  // ── shared internals ──────────────────────────────────────────────────────────

  // Read-fresh, patch frontmatter, write → commit → index. Preserves the current on-disk
  // body (so it never clobbers an external edit), and re-chunk is a no-op if body unchanged.
  private async rewriteFrontmatter(
    existing: StoredNote,
    patch: Partial<Frontmatter>,
    commitMsg: string,
  ): Promise<string> {
    const frontmatter: Frontmatter = { ...existing.frontmatter, ...patch, updated: new Date().toISOString() };
    const { body, chunks } = this.chunker.chunk({ title: existing.title, frontmatter, body: existing.body });
    const stored = await this.storage.write({ title: existing.title, frontmatter, body });
    const commit = await this.storage.commit(commitMsg);
    await this.indexNote(stored, chunks);
    return commit.hash;
  }

  private async indexNote(stored: StoredNote, chunks: Chunk[]): Promise<ChunkDiff> {
    await this.index.putNoteMeta(this.buildMeta(stored));
    const states = await this.index.getChunkStates(stored.frontmatter.uid);
    const diff = this.detector.diff(chunks, states, this.index.embeddingModel);
    if (diff.toDelete.length > 0) await this.index.deleteChunks(diff.toDelete);
    if (diff.toIndex.length > 0) await this.index.indexChunks(diff.toIndex);
    return diff;
  }

  private buildMeta(stored: StoredNote): NoteIndexMeta {
    const fm = stored.frontmatter;
    const meta: NoteIndexMeta = {
      uid: fm.uid,
      title: stored.title,
      type: fm.type,
      source: fm.source,
      verified: fm.verified,
      status: fm.status,
      updated: fm.updated,
      content_hash: stored.content_hash,
    };
    if (fm.project !== undefined) meta.project = fm.project;
    if (fm.superseded_by !== undefined) meta.superseded_by = fm.superseded_by;
    return meta;
  }
}

// ── module-level helpers ────────────────────────────────────────────────────────

const NOTE_TYPES: readonly NoteType[] = ["decision", "principle", "project-note", "idea", "reference", "inbox"];
const NOTE_STATUSES: readonly NoteStatus[] = ["active", "archived", "superseded"];
const NOTE_SOURCES: readonly NoteSource[] = ["claude", "chatgpt", "gemini", "repo", "manual"];

function pick<T extends string>(allowed: readonly T[], v: unknown, fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

// Build frontmatter for a bootstrapped (uid-less) note: preserve any valid existing fields,
// mint a uid, and default the rest. type defaults to "inbox" (unclassified / needs triage) —
// the engine never assigns a semantic type on the caller's behalf.
function bootstrapFrontmatter(raw: RawNote): Frontmatter {
  const now = new Date().toISOString();
  const fm = raw.frontmatter;
  const out: Frontmatter = {
    uid: newUid(),
    type: pick(NOTE_TYPES, fm["type"], "inbox"),
    status: pick(NOTE_STATUSES, fm["status"], "active"),
    source: pick(NOTE_SOURCES, fm["source"], "manual"),
    verified: typeof fm["verified"] === "boolean" ? fm["verified"] : false,
    created: typeof fm["created"] === "string" ? fm["created"] : now,
    updated: now,
  };
  if (typeof fm["project"] === "string") out.project = fm["project"];
  if (Array.isArray(fm["tags"])) out.tags = (fm["tags"] as unknown[]).filter((t): t is string => typeof t === "string");
  return out;
}

/** Extract wikilink targets ([[Target]], [[Target|alias]], [[Target#heading]]) from a body. */
function wikilinkTargets(body: string): Set<string> {
  const out = new Set<string>();
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const target = (m[1] ?? "").split(/[|#]/)[0]?.trim();
    if (target) out.add(target);
  }
  return out;
}

/** Append an authored [[wikilink]] to a `## Links` section (idempotent). Never touches other content. */
function addAuthoredLink(body: string, toTitle: string, linkLine: string): string {
  if (hasWikilink(body, toTitle)) return body;

  const lines = body.split("\n");
  const headingIdx = lines.findIndex((l) => /^##\s+Links\s*$/.test(l));
  if (headingIdx === -1) {
    return `${body.replace(/\s+$/, "")}\n\n## Links\n${linkLine}\n`;
  }

  // Find the end of the Links section: the next `#`/`##` heading, or EOF.
  let end = lines.length;
  for (let j = headingIdx + 1; j < lines.length; j++) {
    if (/^#{1,2}(?!#)\s+/.test(lines[j] ?? "")) {
      end = j;
      break;
    }
  }
  let insertAt = end;
  while (insertAt > headingIdx + 1 && (lines[insertAt - 1] ?? "").trim() === "") insertAt--;
  lines.splice(insertAt, 0, linkLine);
  return lines.join("\n");
}

function hasWikilink(body: string, title: string): boolean {
  return new RegExp(`\\[\\[${escapeRegExp(title)}(\\||#|\\])`).test(body);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
