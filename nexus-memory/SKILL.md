---
name: nexus-memory
description: Gives the agent a durable, local Markdown memory via the Nexus MCP server. Use when the user refers to a past decision, prior work, something they already figured out, or asks about an ongoing project in a way that implies the answer may live in their notes rather than general knowledge — or when they want to save, keep, or not lose a decision or hard-won insight. Do NOT use for generic questions answerable from general knowledge alone.
when_to_use: |
  - The user refers to a past decision, prior work, an earlier conclusion, or something they already figured out
  - The user asks about an ongoing project in a way that implies stored context ("the trading bot", "how was I handling X", "where did I leave off")
  - The user asks to save, keep, note down, or not lose something worth remembering
  - A decision, solution, or hard-won outcome emerges that's worth keeping even without an explicit request
  - Do NOT use for generic questions answerable from general knowledge (syntax, definitions, "how does X work")
allowed-tools:
  - mcp__nexus__search
  - mcp__nexus__read
  - mcp__nexus__upsert
  - mcp__nexus__link
  - mcp__nexus__archive
  - mcp__nexus__reindex
---

# Nexus memory

Nexus is the user's second brain: a local vault of Markdown notes — decisions, principles, project notes, ideas — that persists their thinking across separate chats. It exposes six MCP tools: `search`, `read`, `upsert`, `link`, `archive`, `reindex`. Notes here were written in past conversations you have no memory of. Treat the vault as the record of what the user has already decided.

## Prerequisites

Everything below assumes the Nexus MCP server is installed. If the six tools are not available in this session, it isn't yet. Nexus runs locally over stdio and is installed from npm as `nexus-brain-mcp`. Walk the user through the setup below rather than running it unasked: the bootstrap rewrites every note once, so confirm the vault path, and confirm it's backed up, first.

**Check first:**

- **Node.js 22 or newer.** Run `node --version`.
- **git on PATH.** Run `git --version`. This is required, not optional: without git the first reindex fails with `spawn git ENOENT`, indexes nothing, and every tool is effectively dead.
- **A supported platform.** That means macOS on Apple Silicon, Linux x64 or arm64 (glibc), or Windows x64. Intel Macs, Windows on ARM and Alpine/musl are not supported.
- **About 1.1 GB of free disk.** That covers a ~487 MB embedding model plus ~640 MB of npm dependencies.

**1. Bootstrap once, from a terminal.** Back up the vault first: the first run adds a `uid` and invisible chunk anchors to every note.

```bash
npx -y nexus-brain-mcp reindex "/path/to/vault"
```

The first run installs the package and downloads the embedding model (~487 MB), so allow a few minutes. Wait until it prints `reindex complete`. After that, Nexus runs fully offline.

**2. Register the server with the MCP host.** The vault path is the only argument.

- **Claude Code:** `claude mcp add nexus -- npx -y --prefer-offline nexus-brain-mcp /path/to/vault`
- **JSON-configured hosts** (Claude Desktop, Cursor, …):
  ```json
  { "mcpServers": { "nexus": { "command": "npx", "args": ["-y", "--prefer-offline", "nexus-brain-mcp", "/path/to/vault"] } } }
  ```
- **Windows:** wrap the command, because `npx` is a `.cmd` shim: `"command": "cmd", "args": ["/c", "npx", "-y", "--prefer-offline", "nexus-brain-mcp", "C:\\path\\to\\vault"]` (Claude Code: `claude mcp add nexus -- cmd /c npx -y --prefer-offline nexus-brain-mcp C:\path\to\vault`).

Keep `--prefer-offline`. Without it, every launch first checks the npm registry, and with no network npm retries for about 70 seconds — longer than most hosts wait for a server to start. To update Nexus later, re-run step 1 while online.

Fully restart the host. If `search` returns nothing, call `reindex` once before concluding the vault is empty. For anything else — the host can't find `npx` or `node`, or skipping the GPU-library download on Linux x64 — see https://github.com/etkaozer/nexus#installation.

## Recall — search proactively, without being asked

Call `search` — on your own, without the user saying "search" or "nexus" — whenever EITHER holds:

1. The conversation refers to a project, topic, or decision the user is likely to have notes on. A casual reference counts: "the trading bot", a question about an ongoing project, "how was I handling X".
2. The user refers to a past decision, prior work, an earlier conclusion, or something they already figured out — in any way that implies stored knowledge.

This is the point of the tool: the user shouldn't have to remember that something is worth recalling. If they casually mention adding leverage to a project and they once decided to go spot-only, surface that decision — don't let them walk back into a choice they already made and reasoned through.

Do NOT search on generic questions answerable from general knowledge (a syntax question, a definition, "how does X work"). Searching those wastes a call and pulls in irrelevant context. When genuinely unsure, lean toward searching: the cost is one tool call, while a miss silently hands the user an answer that contradicts a decision they already made.

## Citing notes — read before you rely on one

Search results and note titles are POINTERS, not sources. A note title is a compressed claim: a title like "Spot-only for MVP, no leverage" looks like it contains the answer, and that is exactly the trap — the note behind it may qualify the claim, scope it to a date, or have been superseded. A snippet is one chunk of one note, not the note.

So: to state or rely on what a note says, `read` it first. Before then, you may say a relevant note appears to exist and offer to open it — you may not report what it says. Only cite a note by its `uid`, and only a `uid` you have actually `read` this session.

Every search hit carries `status`. If it's `superseded`, follow `superseded_by` and read the replacement before answering — never present a superseded note as current. If `archived`, treat it as historical context, not current practice.

## Capture — notice what's worth keeping, let the user decide

**When to capture:** When the user asks to save, keep, or not lose something, or when a decision, solution, or hard-won outcome emerges that clearly passes the keep-test — even without an explicit request.

**The keep-test:** Store it only if it'll be needed again in months and is lived experience or a real decision — not generic, re-derivable information. When in doubt, it's probably not worth keeping. Keep the bar high.

**Explicit vs. noticed:**
- If the user asks to save it, or clearly implies it, capture directly — don't ask again.
- If *you* notice something genuinely worth keeping that they didn't flag, **offer** to save it ("Want me to save this to your notes?") rather than saving silently. The user decides what enters the vault. Only offer when it clearly clears the keep-test — a high bar, so suggestions stay rare and worth acting on, never noise.

**How to capture — reconcile, don't just append:** Before creating a note, `search` for existing related notes. If one covers the same ground, update it — or `upsert ... supersedes` if a decision is being revised, which keeps the old version in the lineage instead of erasing it. Only create a new note when nothing matches. This is what keeps the vault from filling with near-duplicates: the path to a conclusion is as valuable as the conclusion, so revise and supersede rather than pile up.

## The note model

When creating or updating, the caller chooses `type` (decision | principle | project-note | idea | reference | inbox), `project` (optional slug), and `source`. Identity is the `uid`, never the filename. The engine never infers these — you do.
