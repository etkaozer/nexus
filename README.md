# Nexus

LLM chats are great at reasoning but bad at remembering. Context dies when a chat ends, gets compacted away in long sessions, and doesn't follow you when you switch models. Nexus gives any MCP-compatible setup a durable memory that lives in your own Markdown files instead of inside a single conversation.

Nexus is an [MCP](https://modelcontextprotocol.io) server that sits between your LLM host and your Markdown notes, exposing a small, deterministic set of tools to search, read, and curate knowledge. The point is simple: your knowledge shouldn't disappear because you switched models or closed a chat.

## Example — a minute of real use

Capturing a decision mid-project, as you make it:

> **You:** Save this as a decision in `trading-bot`: going spot-only for the MVP, no leverage. Keeps the risk envelope simple and the kill-switch logic trivial — revisit once paper-trading is stable.
>
> **Claude** → `upsert` → *new note created (`type: decision`, `project: trading-bot`).*

Tracking roadmap progress across a long build session:

> **You:** Mark the "circuit breaker" milestone complete — Claude Code shipped it and the tests pass.
>
> **Claude** → `search` → `upsert` → *finds the roadmap note, marks that milestone done.*

Three weeks later, coming back cold:

> **You:** I'm back on the trading bot. Where did I leave off, and why did I go spot-only?
>
> **Claude** → `search` → `read` → *"You were on the news-integration milestone; circuit breaker and paper-trading are done. You went spot-only for the MVP to keep the risk envelope simple — here's the decision note and what it links to."*

No re-explaining, no scrolling back through old chats. The knowledge was in your Markdown, not trapped in a closed conversation.

## Quick start

```bash
git clone https://github.com/etkaozer/nexus.git nexus && cd nexus
npm install && npm run build
NEXUS_VAULT="/path/to/YourVault" node ./dist/main.js reindex   # back up your vault first
```

Then add Nexus to your MCP host's config (absolute paths — see [Installation](#installation) for details), restart it, and you're set. Full setup, prerequisites, and troubleshooting are in [Installation](#installation) below.

## The core idea

Your Markdown files are the single source of truth. Nexus is a **stateless intelligence layer** on top of them: it manages knowledge *mechanically* (chunking, indexing, linking, versioning) and lets the calling LLM do all the *interpreting* (what a note means, whether two notes are the same idea, what type something is).

Everything Nexus derives — embeddings, the vector index, the lexical index, the backlink graph — is a **projection** that can be rebuilt from the Markdown at any time with zero information loss. Nothing important lives only in the database.

The practical payoff: the reasoning model is a swappable client, and the embedding model is a swappable implementation detail. You can move to a different reasoning model tomorrow, or swap `multilingual-e5-small` for `bge-m3`, without touching a single note. Your knowledge outlives the tools that read it.

## What Nexus is — and isn't

Nexus isn't a RAG pipeline with notes bolted on. Retrieval is one component; the point is a durable knowledge base that evolves over time and stays independent of any single LLM, embedding model, or database. Search exists to *retrieve* knowledge — the rest of Nexus exists to *preserve, organize, version, and evolve* it.

---

## Compatibility

Nexus has **no model-specific code** — it exposes a standard set of [MCP](https://modelcontextprotocol.io) tools, so the reasoning model is genuinely swappable. The requirement is on the *host*, not the model:

> **Any MCP host that can launch a local stdio server** (a `command` + `args` + `env`), driving **any tool-calling model.**

An LLM doesn't connect to an MCP server itself — the host application does, then exposes the tools to whatever model it runs. So the model behind the host (Claude, GPT, Gemini, Llama, …) is irrelevant to Nexus. It works with Claude Desktop, Claude Code, Cursor, VS Code (Copilot), Cline, Zed, the Gemini CLI, and other stdio-capable MCP hosts.

Two caveats:

- **Transport is stdio only.** A host that accepts *only* a remote MCP server (an `https://…` URL) can't launch Nexus directly — wrap it with a stdio↔HTTP bridge (e.g. `mcp-remote`) or add a `StreamableHTTPServerTransport` (the MCP SDK supports it; it's a small, localized change). Local hosts need nothing extra.
- **Curation quality tracks the model.** By design Nexus does the mechanics and the model does the judgment (duplicate vs. supersession vs. new idea). Any tool-calling model *works*; a more capable one curates better.

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
AcmeAPI returns HTTP 429 when throttled.
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
| `search` | Find knowledge by meaning **or** exact term. Hybrid fuses semantic + lexical; returns `{ hits, context }` — note-level hits plus a complementary context slice. | `query`, `type?`, `project?`, `k?`, `mode?` (`hybrid`\|`vector`\|`lexical`) |
| `read` | Read a full note: frontmatter, body, authored backlinks, live semantic neighbours, and resolved supersession pointers. | `uid` |
| `upsert` | Create (omit `uid`) or overwrite (give `uid`, write-guarded) a whole note. `supersedes` replaces + archives an older note. | `uid?`, `title`, `type`, `project?`, `body`, `source`, `supersedes?` |
| `archive` | Mark `status: archived`, keep the file. No hard delete. | `uid` |
| `link` | Add an authored `[[wikilink]]` in a `## Links` section (idempotent). | `from_uid`, `to_uid`, `relation?` |
| `reindex` | Rebuild the derived index from Markdown. Idempotent, hash-diff based. Run after editing in Obsidian. | `uid?` |

`read` returns `related_auto` computed live from the index at call time; it's empty for a note with no indexed neighbours yet (a single-note vault, or before the first `reindex`). It also returns `supersedes` / `superseded_by` as `{ uid, title }` (or `null`), so a supersession chain is walkable without a second lookup — a non-null `superseded_by` means the note you just read is **not** the current one.

Each search hit carries `similarity` (the raw cosine for the chunk shown, or `null` when the chunk came from the lexical arm only — which computes no cosine, so none is invented), `match` (`vector`\|`lexical`\|`both`), `rrf_score` (what ordered the list), and `status` + `superseded_by`. Search deliberately does **not** filter by status, so lineage stays findable; carrying `status` on the hit is what stops a retired note from being read as current.

The **caller** chooses a note's `type` and `source`; the engine never infers them. Errors that need a human decision (a write-guard conflict, a duplicate uid) come back as clean, actionable tool errors — not stack traces.

Every tool declares its behaviour to the host through MCP annotations, so a client can tell a query from a write without reading prose:

| | `search` | `read` | `upsert` | `link` | `reindex` | `archive` |
|---|---|---|---|---|---|---|
| `readOnlyHint` | `true` | `true` | `false` | `false` | `false` | `false` |
| `destructiveHint` | — | — | `false` | `false` | `false` | **`true`** |
| `idempotentHint` | — | — | `false` | `true` | `true` | `true` |
| `openWorldHint` | `false` | `false` | `false` | `false` | `false` | `false` |

Three of these are load-bearing because the spec's *defaults* are wrong for a local memory server. `destructiveHint` defaults to **true**, so `upsert`/`link`/`reindex` state `false` explicitly or they advertise themselves as capable of destroying data. `openWorldHint` defaults to **true**, which would describe a purely local vault as an outbound network call. And `reindex` is a writer despite reading like maintenance — it mints uids and injects chunk anchors into your notes. `archive` is the one tool marked destructive: it soft-deletes, but it removes the note from every active view, and that is the effect worth warning a user about. `upsert` is the one writer that is *not* idempotent — without a `uid` it creates a new note every call.

The dashes are deliberate: the MCP spec scopes `destructiveHint` and `idempotentHint` to `readOnlyHint == false`, so stating them on a read-only tool would assert nothing.

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

**Hybrid retrieval.** A query runs two ways at once: cosine KNN over e5 vectors (`sqlite-vec`) for meaning, and BM25 (`FTS5`) for exact/rare tokens (`AcmeAPI`, `SessionStore`, `HTTP 429`) that embeddings tend to blur. The two ranked lists are fused with **Reciprocal Rank Fusion** (`1/(k+rank)`, k=60), then **rolled up to note level** — a note that matched on several chunks appears once, at its best score. Fusion and roll-up happen in the `HybridRetriever` (core layer), never inside the index.

**Recall priming.** The model almost never searches an *opaque* vault — not from laziness, but because a search of unknown expected value is a rational thing to skip. So at session start the server sends a **vault map** in the MCP `initialize` instructions: every project slug (always — coarse coverage is never the thing that gets truncated), then active note titles filled round-robin across projects in recency order until a ~900-token budget runs out, with per-project truncation stated explicitly (`nexus — 60 active notes, 56 shown (use search for the rest)`). Archived and superseded notes are excluded; the map is stamped as a snapshot, because a note written in another chat afterwards genuinely won't be in it. Deciding whether to search becomes a lookup instead of a gamble. The map is sent **once** — re-sending identical text on every tool response just trains a reader to skim it. The one per-call exception is search's `context` slice, whose content differs every call and describes what the results *leave out*.

> **Host caveat, stated plainly.** `initialize.instructions` is the correct channel for this, and Nexus emits it correctly — but a host is not obliged to forward it to the model, and **Claude Desktop currently discards it**, so the map does not reach the model there. This is accepted rather than worked around: the map is far too large to weld into a tool description, and per-response injection would defeat its own purpose. It starts working with zero code change once a host honours instructions. Until then, one line of prompting does the same job — *"start by asking Nexus what's in my vault."* Anything that **must** reach the model regardless — the citation guard, the staleness rule, the `similarity` calibration — lives in the `search` and `read` **tool descriptions**, which are always delivered.

**Semantic chunking.** The body is split on the **shallowest heading level actually present** — a note whose sections are `#` splits on `#`, one whose sections are `##` splits on `##`. Content before the first heading becomes a `__preamble` chunk. Headings deeper than the split level are content, not boundaries. A section over the embedder's token budget (~450 for e5) is sub-split on the next-deeper level, then a fixed-size fallback. Chunk `content_hash` is computed over anchor-stripped text, so injecting a `<!-- cid -->` anchor is semantically inert and never triggers a spurious re-embed.

**Git as the audit log.** Every mutation is a commit, tagged `tool | uid | action`, so `git log` in your vault is a legible history of what changed and why, and every state is recoverable. The adapter stages Markdown only (`git add -- '*.md' '.gitignore'`) and writes a `.gitignore` on init, so the derived index, `.obsidian/`, and `.trash/` can never enter that history.

**reindex is a hash-diff.** It compares the chunks a note currently produces against what the index holds and re-embeds **only** what changed:

- content changed → re-embed the changed chunk;
- chunk added / removed → index / delete it;
- note deleted from disk → drop it from the index;
- **stored `embedding_model` ≠ current model → re-embed** (so swapping the embedding model is a safe, automatic operation — no manual migration).

Unchanged chunks are left untouched; running `reindex` twice does nothing the second time. Notes matched by `uid`, so an Obsidian rename is "same uid, new path" — a metadata update, not a delete-and-recreate. `reindex` with no `uid` also **bootstraps** externally-authored notes: any Markdown without a `uid` gets one minted (defaulting `type: inbox` for you to reclassify), and its anchors injected, in a one-time commit.

---

## Installation

### Prerequisites

- **Node ≥ 22** — check with `node --version`. (Node 20 reached end-of-life in April 2026, and `better-sqlite3` no longer publishes a prebuilt binary for it.)
- **A C/C++ toolchain**, *only* if `npm install` can't use prebuilt binaries for the native modules (`better-sqlite3`, `onnxruntime-node`). Most platforms get prebuilds and need nothing extra; if a source build is triggered, install: macOS → `xcode-select --install`; Debian/Ubuntu → `sudo apt install build-essential python3`; Windows → Visual Studio's "Desktop development with C++" workload.
- **`git` on your `PATH`** — check with `git --version`. Not optional: every mutation (`upsert`, `link`, `archive`) and the bootstrap pass of `reindex` commits to a git repo inside your vault, so without git those tools fail. macOS → `xcode-select --install`; Debian/Ubuntu → `sudo apt install git`; Windows → [git-scm.com](https://git-scm.com).
- **~150 MB free disk** for the embedding model and index (fetched/built once, then reused).
- **Claude Desktop** (or any MCP client) to use it interactively — optional if you only run the CLI.
- **An Obsidian vault** — or any folder of Markdown files, or even an empty folder Nexus will create and manage for you.

### Option A · Desktop Extension (`.mcpb`) — no terminal needed

Claude Desktop installs Nexus as a bundle: double-click `nexus.mcpb`, or **Settings → Extensions →
Install Extension…**, and pick your vault folder when prompted. Node and git still have to be
present (above), but nothing needs to be cloned, installed, or built.

The bundle is macOS/Apple Silicon only, and carries a SQLite binding for each of Node 22/24/25/26 —
if you are on some other Node, the server says so by name at startup instead of failing obscurely.
Building it yourself is one command:

```bash
npm run pack:mcpb        # build → fetch native bindings → preflight → nexus.mcpb
```

For the full install-and-exercise walkthrough — including a five-note sample vault that makes every
tool testable on a fresh install — see **[REVIEWERS.md](REVIEWERS.md)**.

### Option B · From source

Use this for any other platform, any other MCP host, or to develop on Nexus.

#### 1 · Clone, install, build

```bash
git clone https://github.com/etkaozer/nexus.git nexus && cd nexus
npm install      # fetches/compiles native deps (better-sqlite3, onnxruntime)
npm run build    # compiles TypeScript → dist/
```

`dist/` is git-ignored, so `npm run build` is required after every clone (and after pulling changes).

#### 2 · Run the tests (recommended)

```bash
npm test         # 96 tests
```

The integration tests exercise the **real** local embedding model, so the *first* `npm test` needs network access and a few minutes while `multilingual-e5-small` (~110 MB) downloads to `~/.cache/nexus/models`. Every run after that is offline and takes ~20s. All 96 should pass.

#### 3 · Point Nexus at a vault and bootstrap it

A "vault" is just a directory of `.md` files. Bootstrapping does three one-time things to it: mints a stable `uid` in each note's frontmatter, injects invisible `<!-- cid -->` chunk anchors, and builds the search index.

```bash
# BACK UP FIRST — bootstrap rewrites every note once (adds uid + anchors).
cp -R "/path/to/YourVault" "/path/to/YourVault-backup-$(date +%Y%m%d)"

# Build the index and prepare the notes. Downloads the model on first run.
NEXUS_VAULT="/path/to/YourVault" node ./dist/main.js reindex
```

What this does and where things go:

- The index is written **outside** the vault, to `~/.cache/nexus/brain.db` (override with `NEXUS_DB`), so your vault's git history stays Markdown-only.
- Nexus writes a `.gitignore` into the vault so the derived index, `.obsidian/`, and `.trash/` can never be committed.
- `reindex` is **idempotent** — safe to run any time; running it twice does nothing the second time.
- Starting fresh? Point `NEXUS_VAULT` at an empty (or not-yet-existing) folder; Nexus creates it and manages notes there through the tools.

#### 4 · Register with Claude Desktop

Claude Desktop launches the server for you over stdio. Add Nexus to its MCP config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Use an **absolute path to `node`** (find it with `which node` on macOS/Linux, `where node` on Windows) and an absolute path to `dist/main.js` — Claude Desktop does **not** inherit your shell's `PATH`.

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

Replace the three placeholder paths, then **fully quit and reopen** Claude Desktop (closing the window isn't enough). On startup Nexus pre-warms the model in the background, so your first search doesn't block on the download.

#### 5 · Verify it works

In Claude Desktop, open the tools (🔨) menu — you should see the six `nexus` tools. Ask something like *"search my notes for rate limiting"* and Claude will call the `search` tool. If the tools don't appear, see [Troubleshooting](#troubleshooting).

---

## Usage

Once registered, you just talk to Claude normally — it decides when to call the tools. The everyday loop is **capture → recall → curate**, with an occasional **reindex** after you edit in Obsidian.

| You say something like… | Claude calls | Effect |
|---|---|---|
| "Save this as a decision in project `trading-bot`: …" | `upsert` | Creates a note (mints a uid). |
| "What did I decide about rate limiting?" | `search` → `read` | Finds candidates, reads the best one. |
| "This replaces my old note `01J…`." | `upsert … supersedes` | Writes the new note, archives + cross-links the old. |
| "Link this to my AcmeAPI note." | `link` | Adds an authored `[[wikilink]]`. |
| "Archive that note." | `archive` | Sets `status: archived`, keeps the file. |
| "I edited some notes in Obsidian — resync." | `reindex` | Rebuilds the index from Markdown. |

You never call tools by hand; you describe intent and Claude picks the tool. The [6 tools table](#the-6-tools) above is the full surface.

### Editing in Obsidian

Markdown is the source of truth, so edit notes directly in Obsidian whenever you like. Afterwards, bring the index up to date — either ask Claude to *"reindex"* (it calls the `reindex` tool) or run it from the shell:

```bash
NEXUS_VAULT="/path/to/YourVault" node ./dist/main.js reindex
```

**Write-guard:** if you changed a note in Obsidian and then ask Claude to overwrite it *before* reindexing, the write is refused with a clear message rather than clobbering your edit. Run `reindex`, then retry.

### CLI reference

```bash
# One-shot reindex / bootstrap, then exit (safe to re-run).
NEXUS_VAULT=<vault> node ./dist/main.js reindex

# Run the MCP server in the foreground (normally Claude Desktop does this for you).
NEXUS_VAULT=<vault> node ./dist/main.js
```

| Env var | Purpose | Default |
|---|---|---|
| `NEXUS_VAULT` | Path to your vault (**required**). | — |
| `NEXUS_DB` | Where the index file lives. | `~/.cache/nexus/brain.db` |

### Troubleshooting

- **`npm install` fails compiling `better-sqlite3` / `onnxruntime-node`** — install a C/C++ toolchain (see [Prerequisites](#prerequisites)), then `rm -rf node_modules && npm install`.
- **First search seems to hang** — the ~110 MB model is still downloading on first use; watch the server's stderr. It's a one-time cost, then fully offline.
- **"Refusing to overwrite … modified on disk"** — you edited that note in Obsidian; run `reindex` and retry.
- **The `nexus` tools don't appear in Claude Desktop** — confirm the config JSON is valid, both paths are absolute (`node` **and** `dist/main.js`), `dist/` exists (`npm run build`), and that you *fully quit* and reopened the app.

---

## Privacy Policy

Nexus is local-first, and that is a technical fact about the code rather than a promise: there is
no server, no account, no backend, and nothing to sign in to. The full policy is in
**[PRIVACY.md](PRIVACY.md)**; the short version:

- **Collection — none.** No telemetry, no analytics, no crash reporting, no usage metrics, no
  update pings, no identifiers. The author receives nothing about you or your notes, in any form.
- **Storage — your disk only.** Notes stay as plain Markdown in the vault folder you chose. The
  search index lives at `~/.cache/nexus/brain.db` and is disposable — delete it and `reindex`
  rebuilds it. The change history is git commits inside your vault; Nexus never adds a remote and
  never pushes.
- **Third-party sharing — none.** No note content is transmitted to anyone, ever.
- **Retention — yours.** Delete a `.md` file, delete the index, delete `~/.cache/nexus/`. Nothing
  survives elsewhere, because nothing was sent elsewhere.
- **Embeddings run locally**, on your CPU, offline.

**The one external network call.** On first use Nexus downloads
[`Xenova/multilingual-e5-small`](https://huggingface.co/Xenova/multilingual-e5-small) (~110 MB)
from `huggingface.co` and caches it under `~/.cache/nexus/models`. It is a plain fetch of public
files — none of your notes, queries, or filenames are involved, and it happens before any of your
data is read. After it completes Nexus never contacts the network again. You can pre-populate that
cache from elsewhere if you would rather it never happened at all.

**One honest caveat.** Nexus never transmits your notes — but *asking your assistant to read one
does*. Tool arguments and results become part of the conversation, so they go to whoever runs the
model, under their privacy policy. That is inherent to what an MCP server is for, and identical to
pasting the note into the chat yourself. Notes you never ask about are never read.

Questions: etkaozer0@gmail.com · [issues](https://github.com/etkaozer/nexus/issues).

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

- **Move the index to `node:sqlite`** — the highest-value item here, and it is a packaging fix, not a feature. `better-sqlite3` is not an N-API addon: each prebuilt binary is locked to one Node ABI, which is why the `.mcpb` bundle has to ship four of them and is pinned to a single platform. Node's built-in `node:sqlite` (with `loadExtension` for `sqlite-vec`) needs no prebuilds at all, which would make the bundle genuinely cross-platform and delete `scripts/fetch-prebuilds.mjs` and `src/index/native-binding.ts` outright. The cost is a rewrite of `SqliteIndexProvider` against a different API, and a Node ≥ 24 floor.
- **Frontmatter-anchor alternative** — store chunk slugs in a frontmatter map instead of inline comments, for people who spend most of their time in Live Preview and want zero visible artifacts in the body.
- **Block-level granularity** — anchor and retrieve at the paragraph/list-item level, not just the heading section.
- **Non-MCP ingesters** — standalone importers that pour ChatGPT exports, repositories, or web clippings into the vault as `source`-tagged notes, so Nexus becomes the merge point for knowledge from many tools, not just the one talking to it live.
- **A `GitHubAdapter` / `S3Adapter`** — the `StorageAdapter` seam already exists for this; the vault could live in a remote repo or bucket with no engine changes.

---

## License

[MIT](LICENSE) © 2026 etkaozer. Do what you like with it — just keep the copyright notice.
