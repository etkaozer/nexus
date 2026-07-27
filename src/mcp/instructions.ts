// The `instructions` string sent once, in the MCP initialize response.
//
// This is the ONLY once-per-session channel available to us, which is exactly what the vault
// map needs: the map is a snapshot, and re-sending it on every tool response would (a) be
// identical text repeated, which trains a reader to skim it, and (b) cost tokens on every call
// to restate something already in context. The one deliberate exception is the search context
// slice, which is per-call because its content genuinely differs per call.
//
// Three rules ride along with the map. Each is written as a CHECKABLE CONDITION rather than an
// exhortation, because "search when relevant" is unfalsifiable — the reader cannot tell whether
// they have complied — whereas "did the conversation name something in this list?" can be
// answered by looking.

import { guardForInstructions } from "./guard.js";

/** Compose the initialize instructions: the standing rules wrapped around a session-start map. */
export function buildInstructions(vaultMap: string): string {
  return [
    PREAMBLE,
    "",
    "═══ VAULT MAP ═══",
    vaultMap,
    "",
    "═══ WHEN TO SEARCH ═══",
    WHEN_TO_SEARCH,
    "",
    "═══ CITING NOTES ═══",
    CITATION_RULE,
    "",
    "═══ STALENESS ═══",
    STALENESS_RULE,
  ].join("\n");
}

const PREAMBLE = [
  "Nexus is this user's second brain: a local vault of Markdown notes — decisions, principles,",
  "project notes, ideas, references — that persists their thinking across separate chats. Notes",
  "here were written in past conversations you have no memory of. Treat the vault as the record",
  "of what this user has already decided.",
].join("\n");

// Two clauses, and the second one is load-bearing. A rule of the form "search only if the slug
// appears in the map above" would be perfectly checkable and would reintroduce the exact silent
// failure this layer exists to remove: a project created in another chat is absent from THIS
// session's snapshot, so the strict rule would confidently decline to look for it.
//
// The asymmetry justifies the looser second clause. An unnecessary search costs one tool call.
// A missed one costs the user a decision they already made and will now unknowingly re-make —
// and neither of you will ever find out it happened.
const WHEN_TO_SEARCH = [
  "Call `search` — without being asked to, and without the user saying 'search' or 'nexus' —",
  "whenever EITHER of these holds:",
  "",
  "  1. The conversation refers to a project or topic that appears in the vault map above.",
  "     (Casual reference counts. 'the trading bot' is a reference. So is a question about it.)",
  "",
  "  2. The user refers to a past decision, prior work, an earlier conclusion, or something they",
  "     already figured out — in any way that implies stored knowledge — EVEN IF nothing in the",
  "     map matches. The map is a snapshot from session start and may be missing notes written",
  "     since, including in other chats. Absence from the map is not evidence of absence.",
  "",
  "Do not search on unrelated topics — that wastes a call and pulls in irrelevant context.",
  "But when the two conditions are in doubt, search: the cost is one tool call, while a miss",
  "silently hands the user an answer that contradicts a decision they already made.",
].join("\n");

// Composed from the shared clauses in guard.ts — the SAME wording the search and read tool
// descriptions carry. Written out separately here once before, the two copies drifted within a
// single change, and the weaker one was the copy that actually reached the model.
const CITATION_RULE = guardForInstructions();

const STALENESS_RULE = [
  "`search` deliberately does NOT filter by status, so superseded and archived notes stay findable",
  "and lineage stays walkable. Every hit therefore carries `status`.",
  "",
  "  • status 'superseded' — this note was REPLACED. Follow `superseded_by` and read the",
  "    replacement before answering. Never present a superseded note as current.",
  "  • status 'archived' — retired but kept. Treat as historical context, not current practice.",
  "",
  "`read` returns resolved `supersedes` / `superseded_by` pointers (uid + title), so you can walk a",
  "chain to its current end. If a note you read has a non-null `superseded_by`, you are not yet at",
  "the current answer.",
].join("\n");
