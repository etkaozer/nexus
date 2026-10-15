# Nexus — reviewer setup and test script

Everything needed to install Nexus cold and exercise all six tools. No prior knowledge assumed.
Budget about 15 minutes, most of which is one download.

**What Nexus is:** a local MCP server that turns a folder of Markdown notes into a searchable,
curatable memory. Six tools — `search` and `read` (read-only), `upsert`, `link`, `reindex`
(non-destructive writes), and `archive` (marks a note retired, keeps the file). Nothing leaves the
machine except a one-time model download; see [PRIVACY.md](PRIVACY.md).

---

## 0 · Prerequisites — please check these first

Two of these are the difference between a working install and a dead one.

| Requirement | Check | Why it matters |
|---|---|---|
| **macOS on Apple Silicon** | `uname -sm` → `Darwin arm64` | This bundle ships `darwin-arm64` native binaries only. Intel Macs, Windows and Linux are not covered by this build. |
| **Node.js 22, 24, 25 or 26** | `node --version` | The bundle carries a SQLite binding per Node ABI. Outside that set the server exits immediately with a message naming your version. |
| **`git` on `PATH`** | `git --version` | **Nothing works without it.** The first `reindex` commits to a git repo inside the vault, so without git it fails with `spawn git ENOENT` and indexes nothing: `search` and `read` have nothing to return, and every write (`upsert`, `link`, `archive`) fails too. On a fresh Mac, run `xcode-select --install` if the check fails. |
| **~600 MB free disk** | — | Bundle ~90 MB unpacked, embedding model ~487 MB, index a few MB. |

No API keys, no accounts, no network configuration.

---

## 1 · Install the extension

Open `nexus.mcpb` (double-click, or Claude Desktop → **Settings → Extensions → Install
Extension…**). Claude Desktop will ask for one setting:

> **Vault folder** — the folder holding your Markdown notes.

Do not point this at a real notes folder you care about. Set up the sample vault first (next
step), then come back and select it.

---

## 2 · Set up the sample vault

An empty vault shows nothing, so review against the five-note sample vault. It is built to
exercise every tool: it contains a superseded/superseding decision pair, a wikilink, two projects,
and rare tokens for keyword search.

```bash
git clone --depth 1 https://github.com/etkaozer/nexus.git /tmp/nexus-review
cp -R /tmp/nexus-review/examples/sample-vault ~/Documents/nexus-sample-vault
```

Then set the extension's **Vault folder** to `~/Documents/nexus-sample-vault` and **fully quit and
reopen Claude Desktop** (closing the window is not enough).

*The same folder also ships inside the bundle at `examples/sample-vault`, if you would rather copy
it from there. Copy it out rather than using it in place — Nexus writes to its vault, and the
extension directory is replaced on update.*

What is in it:

| Note | Type | Project | Notable |
|---|---|---|---|
| Spot-only for the MVP, no leverage | decision | trading-bot | **superseded** by the next one |
| Leverage allowed up to 2x | decision | trading-bot | supersedes the above; linked to from the circuit breaker note |
| Circuit breaker design | project-note | trading-bot | contains a `[[wikilink]]` |
| AcmeAPI rate limits | reference | notes-app | rare tokens: `AcmeAPI`, `HTTP 429`, `SessionStore` |
| Write it down or it did not happen | principle | — | no project, for the "no project" bucket |

---

## 3 · First run — reindex before anything else

**This step is required, and it is the one that takes time.**

Nothing is searchable until the index is built, and building it downloads the embedding model
(~487 MB from Hugging Face) the first time. **Allow a few minutes** — under a minute on a fast
connection, several on a slow one. The server pre-warms the model in the background at startup,
but a `search` issued before the download finishes may time out — run this first and let it
finish.

In Claude Desktop:

> **Reindex my Nexus vault.**

Claude calls `reindex`. Expect roughly:

```json
{ "notes_scanned": 5, "chunks_reembedded": 15, "chunks_deleted": 0, "chunks_reembedded_model_change": 0 }
```

If you would rather watch it happen, the same thing from a terminal:

```bash
NEXUS_VAULT=~/Documents/nexus-sample-vault node "<extension dir>/dist/main.js" reindex
```

Everything after this is fast and fully offline.

---

## 4 · Exercise the six tools

Copy-paste each prompt. Expected results are what this build actually returns.

> **A note on prompting.** Nexus sends a map of your vault in the MCP `initialize` instructions,
> but Claude Desktop currently discards that field, so the assistant does not know what is in the
> vault until it searches. Please prompt explicitly, as below, rather than expecting it to
> volunteer. This is a documented host limitation, not a fault in the server — see the README.

### `search` — read-only

> **Search my notes for how much leverage is allowed.**

Three hits. Note that the **superseded** note comes back too, labelled `status: "superseded"` with
a pointer to what replaced it — search deliberately does not hide retired notes, so lineage stays
findable, and the label is what stops one being read as current.

Then, for the keyword arm:

> **Search my notes for AcmeAPI.**

The AcmeAPI note returns with `match: "both"` — found by semantic *and* exact-term search. Rare
identifiers that embeddings blur are exactly what the keyword arm is for.

### `read` — read-only

> **Read the note about leverage being allowed up to 2x.**

Returns the full note plus: a **backlink** from "Circuit breaker design", a resolved
**`supersedes`** pointer to the older spot-only decision, and **`related_auto`** — semantically
similar notes computed live, never stored in the file.

Then the other end of the chain:

> **Now read the older spot-only decision it replaced.**

Comes back `status: "superseded"` with `superseded_by` naming its replacement, so the chain is
walkable in both directions.

### `upsert` — write, non-destructive

> **Save this as an idea in project trading-bot: try a paper-trading dry run before enabling
> leverage on altcoins.**

Returns `"action": "create"` with a new `uid` and a git commit hash. A new `.md` file appears in
the vault. **Keep this uid** — the next two tools use it.

### `link` — write, idempotent

> **Link the note you just created to the circuit breaker design note.**

Returns `"action": "link"`. A `## Links` section with a `[[wikilink]]` is added to the new note,
and reading the circuit breaker note now shows a backlink from it. Running it twice changes
nothing — that is what `idempotentHint: true` on this tool advertises.

### `archive` — write, destructive

> **Archive the note you just created.**

Returns `"action": "archive"`. The note's status becomes `archived` and it drops out of active
views. **The file is not deleted** — Nexus has no hard delete, and the change is a git commit, so
it is fully recoverable. This tool is marked `destructiveHint: true` because it removes the note
from view, which is the effect worth warning a user about, even though nothing is lost.

### `reindex` — write, idempotent

> **Reindex again.**

Returns `"chunks_reembedded": 0`. It is a hash diff: nothing changed, so nothing is recomputed.

---

## 5 · Error handling worth checking

Nexus refuses to clobber edits made outside it. To see the guard fire, edit a note in a text
editor — add a line to `~/Documents/nexus-sample-vault/AcmeAPI rate limits.md` — then:

> **Rewrite my AcmeAPI rate limits note to say the limit is 900 requests per minute.**

The write is refused with an actionable error, not a stack trace:

```
ERROR: Refusing to overwrite note 01KWY0AB80Y15HYQG2KZXQCJZ1: it was modified on disk since it
was last indexed (an external Obsidian edit). Run reindex({ uid: "..." }) first to absorb the
change, then retry — Nexus never clobbers an external edit.
```

Ask Claude to reindex and retry, and it succeeds. Your external edit is intact either way.

---

## 6 · Tool annotations

Every tool declares its behaviour, visible in Claude Desktop's tool list:

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
|---|---|---|---|---|
| `search` | `true` | — | — | `false` |
| `read` | `true` | — | — | `false` |
| `upsert` | `false` | `false` | `false` | `false` |
| `link` | `false` | `false` | `true` | `false` |
| `reindex` | `false` | `false` | `true` | `false` |
| `archive` | `false` | **`true`** | `true` | `false` |

`destructiveHint` and `idempotentHint` are omitted on the read-only tools because the MCP
specification scopes both to `readOnlyHint == false`. `openWorldHint` is `false` everywhere: the
vault is local and closed, and no tool reaches an external service.

`upsert` is the one writer that is **not** idempotent — called without a `uid` it creates a new
note every time, so a blind retry would produce two.

---

## 7 · Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Extension installs, no tools appear | Fully quit and reopen Claude Desktop. Check the vault folder is set in the extension's settings. |
| `no SQLite binding for the Node.js it was started with` | Your `node` is outside 22/24/25/26. The message names your version and the supported set. Install a supported Node and restart. |
| `reindex` fails with `spawn git ENOENT`; nothing is searchable and every write fails | `git` is not on `PATH`, so the index was never built. Run `git --version`; on macOS `xcode-select --install`. Then reindex again. |
| First search hangs or times out | The model is still downloading (~487 MB, one time). Run the reindex in §3 and let it finish. |
| `search` returns nothing | The index has not been built — see §3. Search itself says so: *"the vault may be empty or unindexed (run reindex)"*. |
| `unsubstituted config template` on startup | The vault folder setting is empty. Set it in the extension's settings and restart. |

---

## 8 · Cleanup

```bash
rm -rf ~/Documents/nexus-sample-vault   # the sample vault
rm -rf ~/.cache/nexus                   # index + downloaded model
rm -rf /tmp/nexus-review                # the clone from step 2
```

Then remove the extension in Claude Desktop. Nothing else is written anywhere on the system.

---

## Questions

etkaozer0@gmail.com · https://github.com/etkaozer/nexus/issues
