// The MCP tool layer — thin. Each tool parses/validates input (zod), calls the engine,
// and formats the result as JSON text. NO business logic and NO side-effects here:
// git, indexing, and the write-guard all live in the engine's mutation path.
//
// Known engine errors (WriteGuardError, DuplicateUidError, "no note found …") surface as
// clean tool errors (isError) carrying an actionable message — never a raw stack trace.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Engine } from "../engine/engine.js";
import type {
  SearchOptions,
  ReindexOptions,
  UpsertMutation,
  ArchiveMutation,
  LinkMutation,
} from "../types.js";

const NOTE_TYPE = z.enum(["decision", "principle", "project-note", "idea", "reference", "inbox"]);
const NOTE_SOURCE = z.enum(["claude", "chatgpt", "gemini", "repo", "manual"]);
const SEARCH_MODE = z.enum(["hybrid", "vector", "lexical"]);

function ok(data: unknown): CallToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(e: unknown): CallToolResult {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: `ERROR: ${message}` }], isError: true };
}

/** Wire the 6 Nexus tools over an Engine and return the (unconnected) MCP server. */
export function createServer(engine: Engine): McpServer {
  const server = new McpServer({ name: "nexus", version: "0.1.0" });

  server.registerTool(
    "search",
    {
      title: "Search the second brain",
      description:
        "Find knowledge by meaning OR exact term. Hybrid mode (default) fuses semantic vector " +
        "search with exact lexical search, so both conceptual questions and rare proper nouns " +
        "(AcmeAPI, SessionStore, HTTP 429) hit. Returns note-level results (each matching note once, at " +
        "its best score), not raw chunks. Filter by type or project when you know them.",
      inputSchema: {
        query: z.string().min(1).describe("A concept, question, or exact term to look for."),
        type: NOTE_TYPE.optional().describe("Optional filter to a single note type."),
        project: z.string().optional().describe("Optional filter to a single project slug."),
        k: z.number().int().positive().max(50).optional().describe("Max results (default 10)."),
        mode: SEARCH_MODE.optional().describe("hybrid (default) | vector (semantic only) | lexical (exact only)."),
      },
    },
    async (args) => {
      try {
        const opts: SearchOptions = {};
        if (args.type) opts.type = args.type;
        if (args.project) opts.project = args.project;
        if (args.k) opts.k = args.k;
        if (args.mode) opts.mode = args.mode;
        return ok(await engine.search(args.query, opts));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "read",
    {
      title: "Read a note",
      description:
        "Read a full note by its uid: frontmatter, body, authored backlinks (notes that wikilink to " +
        "it), and related_auto (semantically similar notes, computed live at read time — never stored " +
        "in the body). Use the uid returned by search or upsert.",
      inputSchema: {
        uid: z.string().min(1).describe("The note's stable frontmatter uid."),
      },
    },
    async (args) => {
      try {
        const result = await engine.read(args.uid);
        if (result === null) return fail(new Error(`no note found with uid ${args.uid}`));
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "upsert",
    {
      title: "Create or update a note",
      description:
        "Create or update a whole note. Omit uid to CREATE a new note (a uid is minted). Pass uid to " +
        "OVERWRITE that exact note — this is guarded: if the note was edited in Obsidian since it was " +
        "last indexed, the write is refused and you must reindex first. Pass supersedes with a uid to " +
        "replace an older note: the old one is archived (status: superseded) and cross-linked. The " +
        "CALLER chooses type/source — the server never infers them.",
      inputSchema: {
        uid: z.string().optional().describe("Omit to create; provide to overwrite that note."),
        title: z.string().min(1).describe("Display title (also the Obsidian filename)."),
        type: NOTE_TYPE.describe("decision | principle | project-note | idea | reference | inbox."),
        project: z.string().optional().describe("Optional project slug, e.g. trading-bot."),
        body: z.string().describe("Markdown body (no frontmatter)."),
        source: NOTE_SOURCE.describe("Where this came from: claude | chatgpt | gemini | repo | manual."),
        supersedes: z.string().optional().describe("uid of a note this one replaces (it gets archived)."),
      },
    },
    async (args) => {
      try {
        const mut: UpsertMutation = {
          kind: "upsert",
          title: args.title,
          type: args.type,
          body: args.body,
          source: args.source,
        };
        if (args.uid) mut.uid = args.uid;
        if (args.project) mut.project = args.project;
        if (args.supersedes) mut.supersedes = args.supersedes;
        return ok(await engine.applyMutation(mut));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "archive",
    {
      title: "Archive a note",
      description:
        "Mark a note status: archived. The file is kept (no hard delete — real deletion is done by hand " +
        "in Obsidian). Use for notes that are stale but worth keeping.",
      inputSchema: {
        uid: z.string().min(1).describe("uid of the note to archive."),
      },
    },
    async (args) => {
      try {
        const mut: ArchiveMutation = { kind: "archive", uid: args.uid };
        return ok(await engine.applyMutation(mut));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "link",
    {
      title: "Link two notes",
      description:
        "Add an authored [[wikilink]] from one note to another, in a ## Links section of the source " +
        "note. This is an explicit, human-style link (distinct from related_auto). Optionally label the " +
        "relation. Idempotent — linking the same pair twice does nothing.",
      inputSchema: {
        from_uid: z.string().min(1).describe("uid of the note the link is added to."),
        to_uid: z.string().min(1).describe("uid of the note being linked to."),
        relation: z.string().optional().describe("Optional label, e.g. 'supersedes', 'references'."),
      },
    },
    async (args) => {
      try {
        const mut: LinkMutation = { kind: "link", from_uid: args.from_uid, to_uid: args.to_uid };
        if (args.relation) mut.relation = args.relation;
        return ok(await engine.applyMutation(mut));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "reindex",
    {
      title: "Reindex from Markdown",
      description:
        "Rebuild the derived search index from the Markdown source of truth. Idempotent and hash-diff " +
        "based: only chunks whose content actually changed (or whose embedding model changed) are " +
        "re-embedded. Pass a uid to reindex one note; omit for a full rebuild. Run this after editing " +
        "notes directly in Obsidian, or when the write-guard tells you to.",
      inputSchema: {
        uid: z.string().optional().describe("Reindex a single note; omit for a full rebuild."),
      },
    },
    async (args) => {
      try {
        const opts: ReindexOptions = {};
        if (args.uid) opts.uid = args.uid;
        return ok(await engine.reindex(opts));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
