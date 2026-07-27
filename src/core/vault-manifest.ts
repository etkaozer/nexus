// VaultManifest — a compact, budgeted MAP of what the vault contains, projected off the
// note metadata already mirrored in the index. Pure formatting: no I/O, no query, no clock.
//
// Why this exists. A model with an opaque vault cannot estimate the value of searching it,
// so under uncertainty it rationally skips the search — which is indistinguishable, from the
// outside, from the vault being useless. The map removes the uncertainty: deciding whether to
// search becomes a lookup against a list already in context, not a gamble.
//
// Three properties do the work, and each is a deliberate defence:
//
//   • EVERY project slug appears, always, whatever the vault's size. Coarse coverage must never
//     be the thing that gets truncated, because "is there anything about X?" is the exact
//     question the map exists to answer. Only the fine-grained titles compete for budget.
//   • Truncation is stated per project, never silent. A cut list that looks complete causes
//     UNDER-searching ("I can see all of it, no need to look"); a list that says 12 of 47
//     turns the budget limit into a reason to search.
//   • Archived and superseded notes are excluded. They are the richest source of confidently
//     outdated answers — a retired title read as current is worse than no map at all.
//
// The map is a POINTER STRUCTURE, not a source. Titles are compressed claims ("Spot-only for
// MVP, no leverage" contains an answer), and answering from one without reading the note is
// the failure mode the citation rule in the instructions exists to prevent.

import type { NoteSummary } from "../interfaces/index-provider.js";
import type { NoteStatus } from "../types.js";

/** Notes with no project slug are still real notes; they get an explicit bucket, not silence. */
export const NO_PROJECT = "(no project)";

/**
 * Normalise a project slug to its bucket key. A blank or whitespace-only `project:` in
 * frontmatter is *absence* spelled differently — without this it would render as a nameless
 * group, which reads as a corrupted map rather than as "these notes have no project".
 */
function projectKey(project: string | undefined): string {
  const trimmed = project?.trim();
  return trimmed === undefined || trimmed === "" ? NO_PROJECT : trimmed;
}

export interface VaultManifestOptions {
  /** Total budget for the whole map. Titles are fitted to it; slugs and header are not. */
  tokenBudget?: number;
  /** ISO-8601 stamp of when the snapshot was taken. Injected, never read from a clock here. */
  now?: string;
  /** Rough chars-per-token divisor for the estimator. */
  charsPerToken?: number;
}

const DEFAULT_BUDGET = 900;
const DEFAULT_CHARS_PER_TOKEN = 4;

interface ProjectGroup {
  name: string;
  /** Active notes only, newest first. */
  notes: NoteSummary[];
  /** Most recent `updated` in the group; null when no note in it has one. */
  recency: string | null;
}

/**
 * Estimate tokens from characters. Deliberately crude and dependency-free — the budget is a
 * guard rail, not an accounting system, and a real tokenizer would be a dependency plus a
 * model-coupling for no decision-relevant gain.
 */
export function estimateTokens(text: string, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Build the vault map. Runs the SAME algorithm at every vault size: a 5-note vault and a
 * 5000-note vault differ only in how much of the title budget gets used and how many
 * truncation markers appear.
 */
export function buildVaultManifest(notes: NoteSummary[], opts: VaultManifestOptions = {}): string {
  const budget = opts.tokenBudget ?? DEFAULT_BUDGET;
  const cpt = opts.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;

  // Archived and superseded notes never reach the map — see the header comment.
  const active = notes.filter((n) => n.status === "active");
  const groups = groupByProject(active);

  const header = buildHeader(opts.now, active.length, groups);
  if (groups.length === 0) return header;

  // Round-robin, not global recency. Global recency ordering lets one busy project consume the
  // entire title budget and leave every other project at zero shown — technically honest, but it
  // hands back a map that only knows about this week. Round-robin over recency-SORTED projects
  // keeps the bias (hot projects pick first, so they survive truncation) without the starvation.
  const shown = fitTitles(groups, header, budget, cpt);

  const sections = groups
    .filter((g) => (shown.get(g.name) ?? 0) > 0)
    .map((g) => renderSection(g, shown.get(g.name) ?? 0));

  return sections.length === 0 ? header : `${header}\n\n${sections.join("\n\n")}`;
}

// ── header: the parts that are never truncated ──────────────────────────────────

function buildHeader(now: string | undefined, activeCount: number, groups: ProjectGroup[]): string {
  // Staleness is stamped, not hidden. The map is generated once per session, so a note created
  // in a DIFFERENT chat after this moment is genuinely absent — and the model can only reason
  // about that if it is told the map is a snapshot rather than an inventory.
  const stamp = now === undefined ? "at session start" : `at session start (${now})`;
  const lines = [
    `Vault map — snapshot taken ${stamp}; projects/notes may have been added since (e.g. from another chat).`,
  ];

  if (groups.length === 0) {
    lines.push("This vault has no active notes yet (or the index has not been built — run reindex).");
    return lines.join("\n");
  }

  lines.push(
    `${activeCount} active note${activeCount === 1 ? "" : "s"} across ` +
      `${groups.length} project${groups.length === 1 ? "" : "s"}. Archived and superseded notes are omitted here.`,
  );
  // Every slug, every time — this line is exempt from the budget on purpose.
  lines.push(`Projects (active note counts): ${groups.map((g) => `${g.name} (${g.notes.length})`).join(", ")}`);
  return lines.join("\n");
}

// ── title fitting ────────────────────────────────────────────────────────────────

/**
 * Decide how many titles each project shows. Greedy round-robin: measure the whole rendered
 * map after each tentative title and stop at the first one that would break the budget.
 * Re-rendering per candidate is O(n²) on a list the budget caps at a few dozen — chosen because
 * it measures the ACTUAL output rather than a running estimate that could drift from it.
 */
function fitTitles(
  groups: ProjectGroup[],
  header: string,
  budget: number,
  cpt: number,
): Map<string, number> {
  const shown = new Map<string, number>(groups.map((g) => [g.name, 0]));
  const maxRounds = Math.max(...groups.map((g) => g.notes.length));

  for (let round = 0; round < maxRounds; round++) {
    for (const g of groups) {
      if (g.notes.length <= round) continue;
      const next = (shown.get(g.name) ?? 0) + 1;
      shown.set(g.name, next);
      if (estimateTokens(render(groups, shown, header), cpt) > budget) {
        shown.set(g.name, next - 1); // undo the overflowing title and stop entirely
        return shown;
      }
    }
  }
  return shown;
}

function render(groups: ProjectGroup[], shown: Map<string, number>, header: string): string {
  const sections = groups
    .filter((g) => (shown.get(g.name) ?? 0) > 0)
    .map((g) => renderSection(g, shown.get(g.name) ?? 0));
  return sections.length === 0 ? header : `${header}\n\n${sections.join("\n\n")}`;
}

function renderSection(g: ProjectGroup, count: number): string {
  const total = g.notes.length;
  // An explicit marker converts "the budget ran out" into "there is more here worth searching for".
  const marker =
    count < total
      ? `${total} active notes, ${count} shown (use search for the rest)`
      : `${total} active note${total === 1 ? "" : "s"}, all shown`;
  const titles = g.notes.slice(0, count).map((n) => `  - ${n.title}`);
  return [`${g.name} — ${marker}:`, ...titles].join("\n");
}

// ── grouping ─────────────────────────────────────────────────────────────────────

function groupByProject(active: NoteSummary[]): ProjectGroup[] {
  const byName = new Map<string, NoteSummary[]>();
  for (const n of active) {
    const key = projectKey(n.project);
    const bucket = byName.get(key);
    if (bucket) bucket.push(n);
    else byName.set(key, [n]);
  }

  const groups: ProjectGroup[] = [...byName.entries()].map(([name, notes]) => {
    const sorted = [...notes].sort(byRecencyThenTitle);
    return { name, notes: sorted, recency: sorted[0]?.updated ?? null };
  });

  // Recently-touched projects first, so they win the round-robin's earliest picks.
  return groups.sort((a, b) => compareRecency(a.recency, b.recency) || a.name.localeCompare(b.name));
}

function byRecencyThenTitle(a: NoteSummary, b: NoteSummary): number {
  // Title is the tie-break so the map is deterministic — the same vault must produce the same
  // map twice, or a test cannot distinguish "the vault changed" from "the sort was unstable".
  return compareRecency(a.updated, b.updated) || a.title.localeCompare(b.title);
}

/** Newest first; a missing timestamp sorts last rather than pretending to be the epoch. */
function compareRecency(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? 1 : -1;
}

// ── the per-search context slice ─────────────────────────────────────────────────

export interface SearchContextOptions {
  /** Projects listed on a zero-hit search before the list itself is truncated. */
  maxProjectsOnMiss?: number;
}

/**
 * The slice's view of one hit. `status` is REQUIRED, and that is the whole point: search
 * deliberately returns superseded and archived notes, so a hit count that ignores status is
 * not comparable to a vault count that excludes them.
 */
export interface ContextHit {
  uid: string;
  project?: string;
  status: NoteStatus;
}

/**
 * Build the COMPLEMENTARY slice that accompanies a result set.
 *
 * Complementary is the whole point: this never restates a returned title. Its value is exactly
 * what the hits cannot show — how much of each project the caller is NOT looking at, and that
 * the vault may have moved since the session-start snapshot. Restating the results would train
 * the reader to skim the block; telling them what is missing gives them a reason to read it.
 *
 * This is the one place the manifest layer runs per call, and it earns that: search is the
 * active recall moment, and the content differs on every call rather than repeating verbatim.
 */
export function buildSearchContext(
  hits: ContextHit[],
  allNotes: NoteSummary[],
  opts: SearchContextOptions = {},
): string {
  const maxProjects = opts.maxProjectsOnMiss ?? 12;
  const activeByProject = new Map<string, number>();
  for (const n of allNotes) {
    if (n.status !== "active") continue;
    activeByProject.set(projectKey(n.project), (activeByProject.get(projectKey(n.project)) ?? 0) + 1);
  }

  // A miss usually means the query missed the vault's vocabulary, not that the vault is empty.
  // This is the cheapest possible moment to correct that, so spend the tokens on the slug list.
  if (hits.length === 0) {
    if (activeByProject.size === 0) {
      return "Context: no hits, and the index holds no active notes — the vault may be empty or unindexed (run reindex).";
    }
    const listed = [...activeByProject.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, maxProjects);
    const more = activeByProject.size - listed.length;
    const slugs = listed.map(([name, n]) => `${name} (${n})`).join(", ");
    return [
      `Context: 0 hits — nothing in the index matched this query.`,
      `The vault does contain these projects (active note counts): ${slugs}${more > 0 ? `, +${more} more` : ""}.`,
      `A miss is usually a vocabulary mismatch rather than an empty vault; retrying with a project slug or a broader concept often lands.`,
    ].join("\n");
  }

  // Active and retired hits are counted SEPARATELY. Folding them together would compare an
  // all-status hit count against an active-only vault count, so a result set full of superseded
  // notes would subtract its way to "you have seen everything" — manufacturing exactly the
  // false sense of completeness this slice exists to prevent.
  const shownActive = new Map<string, number>();
  const shownRetired = new Map<string, number>();
  for (const h of hits) {
    const key = projectKey(h.project);
    const bucket = h.status === "active" ? shownActive : shownRetired;
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
  }

  const names = [...new Set([...shownActive.keys(), ...shownRetired.keys()])];
  const lines = names
    .sort((a, b) => (shownActive.get(b) ?? 0) - (shownActive.get(a) ?? 0) || a.localeCompare(b))
    .map((name) => {
      // No `?? shown` fallback: a project with no active notes must report zero, not invent a
      // count from however many retired notes happened to match.
      const total = activeByProject.get(name) ?? 0;
      const active = shownActive.get(name) ?? 0;
      const retired = shownRetired.get(name) ?? 0;
      const tail = retired === 0 ? "" : ` (+${retired} archived/superseded hit${retired === 1 ? "" : "s"} above)`;

      if (total === 0) {
        return `  ${name}: no active notes in the vault — every hit above is archived or superseded.`;
      }
      const rest = Math.max(0, total - active);
      const head = `  ${name}: ${total} active note${total === 1 ? "" : "s"} in the vault, ${active} in this result set`;
      return rest > 0 ? `${head} — ${rest} not shown here.${tail}` : `${head} (all of them).${tail}`;
    });

  return [
    "Context around this result set (not part of the results — no titles are repeated here):",
    ...lines,
    // Precisely what these numbers are: read from the index, which lags the vault until a
    // reindex, and counting active notes only. The earlier wording claimed a session-start
    // snapshot, which was simply not where the counts came from.
    "Counts are read from the index (which lags the vault until reindex) and count active notes only.",
  ].join("\n");
}
