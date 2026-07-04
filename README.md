# Nexus

A local-first "second brain" that lives in your Obsidian vault. Nexus is an [MCP](https://modelcontextprotocol.io) server that sits between an LLM (Claude today) and your Markdown notes, and gives it a small, deterministic set of tools to search, read, and curate knowledge.

## The core idea

Your Markdown files are the single source of truth. Nexus is a **stateless intelligence layer** on top of them: it manages knowledge *mechanically* (chunking, indexing, linking, versioning) and lets the calling LLM do all the *interpreting* (what a note means, whether two notes are the same idea, what type something is).

Everything Nexus derives — embeddings, the vector index, the lexical index, the backlink graph — is a **projection** that can be rebuilt from the Markdown at any time with zero information loss. Nothing important lives only in the database.

The practical payoff: the reasoning model is a swappable client, and the embedding model is a swappable implementation detail. You can change Claude for something else tomorrow, or swap `multilingual-e5-small` for `bge-m3`, without touching a single note. Your knowledge outlives the tools that read it.

---

## Design principles

These are the decisions that make Nexus what it is. Each was chosen deliberately; most are enforced by the type system and the tests.

### 1. Markdown is the source of truth; the index is a rebuildable projection

The vault is plain `.md` files with YAML frontmatter. The search index (`brain.db`) is derived and disposable — `reindex` rebuilds it from the Markdown, and it deliberately lives **outside** the vault so it never pollutes your notes or their git history.

*Why:* a second brain should be readable, greppable, and portable in twenty years, long after this particular index format is obsolete. Tying knowledge to a database schema is how you lose it. If the DB is corrupt or the format changes, you delete it and reindex.

### 2. Non-destructive by design

There is no hard delete. `archive` sets `status: archived` and keeps the file. `upsert … supersedes` marks the old note `status: superseded`, links it to its replacement (`superseded_by`) and back (`supersedes`), and keeps both. Real deletion is something you do by hand, in Obsidian, deliberately.

The **write-guard** is the local equivalent of an overlapping-write lock: before overwriting a note, Nexus compares a fresh on-disk hash against the hash it last indexed. If they differ, you edited that note in Obsidian since Nexus last saw it — so the write is refused with a clear error ("run reindex first") rather than silently clobbering your edit.

*Why:* the value of a thinking log is not only the latest accepted fact — it's the **path of how the thinking got there**. A decision is more useful when you can see what it superseded and why. Destroying that lineage to save disk space is a bad trade. The vault is an append-mostly record of how your understanding evolved, and git makes every step recoverable.

### 3. The LLM interprets; the engine manages

The engine contains **no reasoning model** and never auto-merges notes on embedding similarity. When you search, it returns *candidates*; the caller (the LLM) decides whether something is a duplicate, a supersession, a new idea, or a refinement — and then issues an explicit `upsert`/`supersedes` that the engine executes **deterministically**.

*Why:* "these two vectors are close" is not the same as "these are the same idea." Similarity is a hint, not a decision. Automating the merge is where knowledge bases quietly corrupt themselves. Nexus keeps the mechanical part deterministic and testable, and leaves judgment to the thing that can actually judge.

### 4. Storage and embeddings live behind interfaces

Three orthogonal seams:

- **`StorageAdapter`** — dumb document I/O (read/write/list/stat/commit). No search lives here. The default is a filesystem + git adapter; a `GitHubAdapter` or `S3Adapter` is a drop-in that requires no changes to the engine or tools.
- **`IndexProvider`** — the derived search index (vector + lexical). It *uses* an `EmbeddingProvider`; it is not a sibling of it.
- **`EmbeddingProvider`** — turns text into vectors, and owns every model-specific quirk. e5's `passage:` / `query:` prefixes live *inside* this class and nowhere else, so a model that prefixes differently (or not at all) is a change confined to one file.

*Why:* these are proven independent axes of change (this project already swapped a remote embedding API for a local model). Putting each behind a narrow interface means a future change to one never ripples into the others.

### 5. Chunk identity is anchored in the source, not derived from heading text

Each chunk gets a stable id `<note-uid>::<slug>#<ordinal>`. The slug is an opaque value minted **once** and persisted as an invisible HTML comment directly under the heading:

```markdown
## Rate limits
<!-- cid:a1b2 -->
MEXC returns HTTP 429 when throttled.
```

On every subsequent pass the slug is *read* from that anchor, never recomputed from the heading text. So renaming a heading re-embeds its text (the content changed) but keeps the same chunk id — no orphaned or duplicated chunks. Two identical headings each carry their own anchor, so their ids can never collide.

*Why:* this is exactly where naive chunkers produce dedup bugs — recompute an id from a title, rename the title, and suddenly you have a duplicate or a dangling reference. Anchoring identity in the source removes the whole class of bug. The comment is invisible in Obsidian's reading mode and doesn't disturb heading parsing.

---

## Architecture

```
MCP stdio server        6 tools — thin: validate input, call the engine, format output.
  (src/mcp)             No business logic, no side-effects here.
      │
Engine  (src/engine)    query path:    search · read · reindex
  NexusEngine           mutation path: applyMutation() ──► write → commit → index
      │                                 (every side-effect, in this order, one place)
Core    (src/core)      ChunkManager · HybridRetriever · ChangeDetector
      │
Stores                  StorageAdapter (filesystem + git)   IndexProvider (SQLite)
                                                                 ├─ sqlite-vec (vectors)
                                                                 ├─ FTS5        (lexical)
                                                                 └─ EmbeddingProvider (local e5)
```

Tools never touch `fs` / `git` / `sqlite` / the embedding model directly — they only call the engine. The engine only knows the three interfaces.

### The mutation pipeline

Every mutation goes through one method, `engine.applyMutation()`, which performs its side-effects **synchronously and in a fixed order**:

```
write (StorageAdapter)  →  commit (git)  →  index (IndexProvider)
```

All three happen in one place, wrapped in real error handling. There is deliberately **no event bus / pub-sub**. The two side-effects an MVP has (persist the Markdown, update the index) are mandatory and ordered, not optional and loose — an event bus would only hide the sequencing and the error handling behind indirection. The single `applyMutation` entry point is the seam where an `emit(event)` *could* later be added if genuinely optional, async side-effects (analytics, webhooks) ever appear. Until then, it stays explicit.

`reindex` is on the query/maintenance path, not the mutation path: it rebuilds derived state from Markdown and is safe to run any time.

---

## The 6 tools

The surface is exactly these six — no more.

| Tool | Intent | Params |
|------|--------|--------|
| `search` | Find knowledge by meaning **or** exact term. Hybrid fuses semantic + lexical; returns note-level hits. | `query`, `type?`, `project?`, `k?`, `mode?` (`hybrid`\|`vector`\|`lexical`) |
| `read` | Read a full note: frontmatter, body, authored backlinks, and live semantic neighbours. | `uid` |
| `upsert` | Create (omit `uid`) or overwrite (give `uid`, write-guarded) a whole note. `supersedes` replaces + archives an older note. | `uid?`, `title`, `type`, `project?`, `body`, `source`, `supersedes?` |
| `archive` | Mark `status: archived`, keep the file. No hard delete. | `uid` |
| `link` | Add an authored `[[wikilink]]` in a `## Links` section (idempotent). | `from_uid`, `to_uid`, `relation?` |
| `reindex` | Rebuild the derived index from Markdown. Idempotent, hash-diff based. Run after editing in Obsidian. | `uid?` |

The **caller** chooses a note's `type` and `source`; the engine never infers them. Errors that need a human decision (a write-guard conflict, a duplicate uid) come back as clean, actionable tool errors — not stack traces.

### The note model

Every note carries this frontmatter (identity is `uid`, never the filename — so Obsidian renames can't break references):

```yaml
uid:            # stable ULID — the real identity
type:           # decision | principle | project-note | idea | reference | inbox
project:        # optional slug, e.g. "trading-bot"
status:         # active | archived | superseded
source:         # claude | chatgpt | gemini | repo | manual
verified:       # false = captured as-is, true = human-curated
supersedes:     # optional uid this note replaces
superseded_by:  # optional reverse pointer
created:        # ISO
updated:        # ISO
tags:           # optional []
```

---

## How it works under the hood

**Hybrid retrieval.** A query runs two ways at once: cosine KNN over e5 vectors (`sqlite-vec`) for meaning, and BM25 (`FTS5`) for exact/rare tokens (`MEXC`, `SessionDO`, `HTTP 429`) that embeddings tend to blur. The two ranked lists are fused with **Reciprocal Rank Fusion** (`1/(k+rank)`, k=60), then **rolled up to note level** — a note that matched on several chunks appears once, at its best score. Fusion and roll-up happen in the `HybridRetriever` (core layer), never inside the index.

**Semantic chunking.** The body is split on the **shallowest heading level actually present** — a note whose sections are `#` splits on `#`, one whose sections are `##` splits on `##`. Content before the first heading becomes a `__preamble` chunk. Headings deeper than the split level are content, not boundaries. A section over the embedder's token budget (~450 for e5) is sub-split on the next-deeper level, then a fixed-size fallback. Chunk `content_hash` is computed over anchor-stripped text, so injecting a `<!-- cid -->` anchor is semantically inert and never triggers a spurious re-embed.

**Git as the audit log.** Every mutation is a commit, tagged `tool | uid | action`, so `git log` in your vault is a legible history of what changed and why, and every state is recoverable. The adapter stages Markdown only (`git add -- '*.md' '.gitignore'`) and writes a `.gitignore` on init, so the derived index, `.obsidian/`, and `.trash/` can never enter that history.

**reindex is a hash-diff.** It compares the chunks a note currently produces against what the index holds and re-embeds **only** what changed:

- content changed → re-embed the changed chunk;
- chunk added / removed → index / delete it;
- note deleted from disk → drop it from the index;
- **stored `embedding_model` ≠ current model → re-embed** (so swapping the embedding model is a safe, automatic operation — no manual migration).

Unchanged chunks are left untouched; running `reindex` twice does nothing the second time. Notes matched by `uid`, so an Obsidian rename is "same uid, new path" — a metadata update, not a delete-and-recreate. `reindex` with no `uid` also **bootstraps** externally-authored notes: any Markdown without a `uid` gets one minted (defaulting `type: inbox` for you to reclassify), and its anchors injected, in a one-time commit.

---

## Setup & first run

Requires Node ≥ 20.

```bash
git clone <repo> nexus && cd nexus
npm install
npm run build
npm test          # 26 tests, incl. real local-embedding integration tests
```

**Bootstrap an existing vault** (do this before wiring up Claude, so the model downloads and your notes get uids):

```bash
# back up first — this makes one-time edits (uids + anchors) to your notes
cp -R "/path/to/YourVault" "/path/to/YourVault-backup-$(date +%Y%m%d)"

NEXUS_VAULT="/path/to/YourVault" node ./dist/main.js reindex
```

The first run downloads `multilingual-e5-small` (~110 MB, ~3 min) into `~/.cache/nexus/models`, then works fully offline. The index is written to `~/.cache/nexus/brain.db` (override with `NEXUS_DB`).

**Register with Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json` (use an absolute `node` path; Claude Desktop doesn't inherit your shell PATH):

```json
{
  "mcpServers": {
    "nexus": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/nexus/dist/main.js"],
      "env": { "NEXUS_VAULT": "/path/to/YourVault" }
    }
  }
}
```

Fully quit and reopen Claude Desktop. On startup the server **pre-warms the model in the background**, so the first search doesn't block on the download.

---

## Tech stack

- **Language/runtime:** TypeScript (strict), Node LTS, ESM.
- **MCP:** `@modelcontextprotocol/sdk` over stdio; `zod` for tool input schemas.
- **Storage:** `fs` + `gray-matter` (frontmatter) + `simple-git` (commit-on-write).
- **Index:** `better-sqlite3` + `sqlite-vec` (cosine KNN) + FTS5 (BM25), one file `brain.db`.
- **Embeddings:** `@huggingface/transformers` running `Xenova/multilingual-e5-small` (384-dim, multilingual for mixed-language notes) locally — offline after first download.

---

## Status & roadmap

**Personal-use / pre-release.** It works end-to-end and is covered by tests, but it has been built for and used by one person and one vault. Treat it as a well-structured MVP, not a hardened product.

### Deliberate MVP simplifications (called out honestly)

- **`upsert` re-chunks and re-embeds the whole note.** A whole-note write provides a fresh body with fresh anchors, so it doesn't diff against the previous chunks. The hash-diff *efficiency* is realized in `reindex` (the sync path for external edits), which is the intended pattern. Fine for personal-scale notes; revisit if notes get large.
- **Backlinks are computed by scanning the vault on each `read`** (O(n) file reads) rather than from a maintained graph. Correct and simple; would be indexed if the vault grew large.
- **Backlinks resolve by title.** Like Obsidian's own `[[wikilinks]]`, a rename can break an inbound link's text until re-authored.
- **One embedding dimension per index.** The vector table's dimension is fixed at creation. A model swap of the *same* dimension is automatic; a different dimension requires deleting `brain.db` and reindexing.
- **The `<!-- cid -->` anchor is invisible in reading mode**, which is where notes are read — but it is visible in Obsidian's source/edit view.

### Future ideas

- **Frontmatter-anchor alternative** — store chunk slugs in a frontmatter map instead of inline comments, for people who spend most of their time in Live Preview and want zero visible artifacts in the body.
- **Block-level granularity** — anchor and retrieve at the paragraph/list-item level, not just the heading section.
- **Non-MCP ingesters** — standalone importers that pour ChatGPT exports, repositories, or web clippings into the vault as `source`-tagged notes, so Nexus becomes the merge point for knowledge from many tools, not just the one talking to it live.
- **A `GitHubAdapter` / `S3Adapter`** — the `StorageAdapter` seam already exists for this; the vault could live in a remote repo or bucket with no engine changes.

---

## License

Not yet chosen — treat as all-rights-reserved until a license is added. Pick one before publishing.
