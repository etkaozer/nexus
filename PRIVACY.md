# Nexus — Privacy Policy

**Effective date:** 29 July 2026
**Applies to:** the Nexus MCP server and its Claude Desktop extension (MCPB bundle), all versions.

Nexus is a local-first tool. It runs entirely on your own computer, reads and writes files you
already own, and has no server, no account, and no backend. There is nothing for us to collect,
because nothing is ever sent to us.

---

## 1. What Nexus collects

**Nothing.**

Nexus has no telemetry, no analytics, no crash reporting, no usage metrics, no update pings, and
no unique identifiers of any kind. The author receives no data about you, your notes, your
searches, or your use of the software — not in aggregate, not anonymised, not at all.

There is no account to create and no data to opt out of.

## 2. What Nexus stores, and where

Everything Nexus stores lives on your own disk, in locations you control:

| What | Where | Notes |
|---|---|---|
| Your notes | The vault folder you choose | Plain Markdown with YAML frontmatter. Yours, readable without Nexus. |
| Search index | `~/.cache/nexus/brain.db` | Derived and disposable. Delete it any time; `reindex` rebuilds it. |
| Embedding model | `~/.cache/nexus/models` | The downloaded model files (see §4). |
| Change history | A git repository inside your vault | Local commits only. Nexus never adds a remote and never pushes. |

You can move, back up, inspect, or delete any of it with ordinary file tools. The index and model
cache can be moved with the `NEXUS_DB` environment variable and the model cache path respectively.

Nexus stores nothing outside these locations, and writes nowhere else on your system.

## 3. Who Nexus shares data with

**No one.** Your notes are never transmitted to the author, to any hosting provider, to any
analytics service, or to any third party. Nexus has no code that uploads note content anywhere —
it makes exactly one outbound network request in its lifetime, described next.

## 4. The one external network request

**Nexus downloads its embedding model once, from Hugging Face.**

On first use, Nexus downloads [`Xenova/multilingual-e5-small`](https://huggingface.co/Xenova/multilingual-e5-small)
(approximately 110 MB) from `huggingface.co` and caches it under `~/.cache/nexus/models`. This is
the only time Nexus contacts the internet.

What that request involves:

- **What is sent:** an ordinary HTTPS request for public model files. As with any web request, the
  server you are downloading from can see your IP address and user agent. Hugging Face's handling
  of that is governed by [their privacy policy](https://huggingface.co/privacy).
- **What is *not* sent:** none of your notes, queries, filenames, or vault contents. The download
  happens before any of your data is read, and it is a plain file fetch — there is no upload
  channel in it.
- **After it completes:** Nexus never contacts Hugging Face, or any other host, again. All
  embedding runs locally on your CPU. The software is fully functional offline from that point on.

If you prefer to avoid this request entirely, you can pre-populate the model cache directory from
another machine, or from a mirror, before first run.

## 5. What your AI assistant sees

This is not something Nexus controls, and it matters, so it is stated plainly.

Nexus is an MCP server. It answers tool calls made by a host application — Claude Desktop, or any
other MCP client you connect it to. **When your assistant calls a Nexus tool, the arguments it
sends and the note content Nexus returns become part of that conversation**, and are therefore
transmitted to whoever operates the model, under their privacy policy — for Claude Desktop, that is
[Anthropic's](https://www.anthropic.com/legal/privacy).

In other words: Nexus never transmits your notes, but asking your assistant to read one does. This
is inherent to the purpose of the tool, not a property of Nexus specifically, and it is the same
as pasting the note into the chat yourself. Notes you never ask about are never read.

## 6. Retention and deletion

You control retention completely, because you hold the only copy.

- **Delete a note:** delete the `.md` file, or use `archive` to retire it while keeping the file.
- **Delete the index:** delete `~/.cache/nexus/brain.db`. It contains no information not derivable
  from your Markdown.
- **Delete the model cache:** delete `~/.cache/nexus/models`.
- **Delete everything:** remove the extension and delete `~/.cache/nexus/` and your vault folder.

Nothing survives elsewhere, because nothing was ever sent elsewhere. There is no server-side data
to request, export, or erase — the export is your vault folder, which you already have.

## 7. Children's privacy

Nexus collects no data from anyone, of any age.

## 8. Changes to this policy

If this policy changes, the revision will be published at the same URL and in the project
repository, with an updated effective date. Since Nexus collects nothing, any change can only
narrow what it does, and material changes will be noted in the release notes.

## 9. Contact

Questions about privacy in Nexus:

- **Email:** etkaozer0@gmail.com
- **Issues:** https://github.com/etkaozer/nexus/issues
- **Source:** https://github.com/etkaozer/nexus — the claims above are verifiable by reading it.
