// The MCP tool layer — thin. Each tool parses/validates input (zod), calls the engine,
// and formats the result as JSON text. NO business logic and NO side-effects here:
// git, indexing, and the write-guard all live in the engine's mutation path.
//
// Known engine errors (WriteGuardError, DuplicateUidError, "no note found …") surface as
// clean tool errors (isError) carrying an actionable message — never a raw stack trace.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Engine } from "../engine/engine.js";
import { guardForSearch, guardForRead } from "./guard.js";
import type { SimilarityCalibration } from "../interfaces/embedding-provider.js";
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

// ── tool annotations ──────────────────────────────────────────────────────────────────────
//
// Annotations are read by the HOST, not the model: they decide whether a call needs user
// confirmation, whether a failed call is safe to retry, and whether the call counts as reaching
// outside the machine. That makes them a behavioural claim, and every one of them has a spec
// DEFAULT that is wrong for this server in the unsafe direction:
//
//   readOnlyHint    default false  → search and read look like mutators
//   destructiveHint default TRUE   → upsert/link/reindex look like they can destroy data
//   openWorldHint   default TRUE   → a purely local vault looks like an outbound network call
//
// So silence here is not "unspecified", it is a false statement. Both helpers below therefore
// require the caller to CLASSIFY the tool, rather than letting one be registered unannotated.

/** The tool's title, carried on both surfaces (see `titledAnnotations`) plus its behaviour hints. */
type ToolMeta = { title: string; annotations: ToolAnnotations };

/**
 * The title goes in two places on purpose. The current spec puts it top-level on the tool, but it
 * lived in `annotations.title` first and hosts still read it from there. Populating only one shows
 * the raw tool name (`upsert`) in the other kind of host, so both are set — from one argument, so
 * they cannot drift apart.
 */
function titled(title: string, hints: ToolAnnotations): ToolMeta {
  return { title, annotations: { title, ...hints } };
}

/**
 * A tool that cannot change anything. `destructiveHint` / `idempotentHint` are deliberately
 * omitted: the spec scopes both to `readOnlyHint === false`, so stating them here would be noise
 * that asserts nothing.
 */
function readsOnly(title: string): ToolMeta {
  return titled(title, { readOnlyHint: true, openWorldHint: false });
}

/**
 * A tool that writes to the vault. Both hints are REQUIRED arguments rather than optional
 * overrides, because both are exactly what a caller forgets — and forgetting `destructive`
 * silently publishes the wrong claim instead of failing.
 *
 *   destructive — can this remove something a user would miss? Nexus never hard-deletes, so only
 *                 `archive` qualifies: it keeps the file but takes the note out of every active view.
 *   idempotent  — is calling it twice with the same arguments the same as calling it once?
 */
function writes(title: string, hints: { destructive: boolean; idempotent: boolean }): ToolMeta {
  return titled(title, {
    readOnlyHint: false,
    destructiveHint: hints.destructive,
    idempotentHint: hints.idempotent,
    openWorldHint: false,
  });
}

export interface ServerOptions {
  /**
   * Sent once, in the initialize response — the vault map and the standing rules. Built by the
   * composition root (which owns the snapshot moment), not here.
   */
  instructions?: string;
  /**
   * Calibration for the `similarity` numbers search returns, taken from whichever embedding
   * model is actually backing the index. Passed in rather than hardcoded so a model swap
   * carries its own numbers instead of leaving a confidently wrong sentence behind. Omitted →
   * the description makes no calibration claim at all.
   */
  similarity?: SimilarityCalibration;
}

/** Wire the 6 Nexus tools over an Engine and return the (unconnected) MCP server. */
export function createServer(engine: Engine, opts: ServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "nexus", version: "0.1.0" },
    opts.instructions !== undefined ? { instructions: opts.instructions } : {},
  );

  server.registerTool(
    "search",
    {
      ...readsOnly("Search the second brain"),
      description: searchDescription(opts.similarity),
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
      // Read-only despite doing real work: `related_auto` is computed live from the index at call
      // time and is never written back into the note.
      ...readsOnly("Read a note"),
      description:
        "Read a full note by its uid: frontmatter, body, authored backlinks (notes that wikilink to " +
        "it), and related_auto (semantically similar notes, computed live at read time — never stored " +
        "in the body). Use the uid returned by search or upsert. Also returns resolved supersedes / " +
        "superseded_by pointers (uid + title) so a supersession chain is walkable: a non-null " +
        "superseded_by means THIS NOTE IS NOT CURRENT — read the replacement before answering from it.\n\n" +
        // The other end of the same transaction: search says "you may not cite without reading",
        // read is where that right is actually earned.
        guardForRead(),
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
      // Additive: a supersede archives the old note and cross-links it, it never deletes.
      // Not idempotent — the uid-less form MINTS A NEW NOTE on every call, so a blind retry
      // after a timeout would leave two.
      ...writes("Create or update a note", { destructive: false, idempotent: false }),
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
      // The one destructive tool, by INTENT rather than by mechanism. It is a soft delete — the
      // file survives and git holds every prior state — but it removes the note from search's
      // active view and from the vault map, which is the effect a user would want warned about.
      // Marking it non-destructive because "nothing is really lost" would be arguing with the
      // user's expectation instead of describing it. Re-archiving an archived note is a no-op.
      ...writes("Archive a note", { destructive: true, idempotent: true }),
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
      // Idempotent by construction, not by promise: the body is returned untouched when the
      // wikilink is already present.
      ...writes("Link two notes", { destructive: false, idempotent: true }),
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
      // NOT read-only, however much it reads like maintenance: a full reindex mints uids for
      // uid-less Markdown and injects <!-- cid --> anchors into note bodies, then commits. It
      // writes to the user's vault, so it is declared a writer. Hash-diff based, so the second
      // run genuinely changes nothing.
      ...writes("Reindex from Markdown", { destructive: false, idempotent: true }),
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

/**
 * The search tool description. Two things beyond "what it does":
 *
 *  • the citation guard, repeated from the initialize instructions on purpose — this is where a
 *    reader is standing at the exact moment the temptation applies, holding titles and snippets
 *    that look like answers;
 *  • the similarity calibration, taken from the live model. A raw cosine invites a 0-1 reading
 *    that is wrong for every sentence encoder in practice, so the number ships with a statement
 *    of where that model's scores actually land — descriptive, leaving all judgement to the reader.
 */
function searchDescription(calibration?: SimilarityCalibration): string {
  const base =
    "Find knowledge by meaning OR exact term. Hybrid mode (default) fuses semantic vector " +
    "search with exact lexical search, so both conceptual questions and rare proper nouns " +
    "(AcmeAPI, SessionStore, HTTP 429) hit. Returns note-level results (each matching note once, at " +
    "its best score), not raw chunks, plus a `context` slice describing what the results leave out. " +
    "Filter by type or project when you know them.\n\n" +
    "Each hit carries: `similarity` (raw cosine for the chunk shown, or null when the chunk was " +
    "found by the lexical arm only — which computes no cosine, so none is invented), `match` " +
    "(vector | lexical | both), `rrf_score` (what ordered the list; meaningless in absolute terms), " +
    "and `status`.\n\n" +
    "Results are NOT filtered by status, so lineage stays findable. A hit with status 'superseded' " +
    "was replaced — follow its `superseded_by` and read the replacement instead of answering from it.\n\n" +
    // Carried HERE, not only in the initialize instructions: hosts may discard instructions, but
    // tool descriptions are always delivered — and this is the exact moment the temptation applies,
    // with titles and snippets in hand that read like finished answers.
    guardForSearch();

  return calibration === undefined
    ? base
    : `${base}\n\nInterpreting \`similarity\`: ${calibration.note}`;
}
