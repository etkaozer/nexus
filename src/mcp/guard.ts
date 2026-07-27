// The citation / title-seduction guard — ONE definition, consumed by every surface that states it.
//
// Why a shared constant rather than prose written twice. This guard has to appear in two places
// with different framing (the initialize instructions, and the search/read tool descriptions), and
// when it was written out twice the two copies immediately drifted: the instructions carried the
// session-scoping and the permitted fallback, the tool description carried neither. Since hosts
// vary in which channel they honour, the weaker copy was the one some models actually saw.
//
// So the CLAUSES are single-sourced and the composition is per-surface. Each clause has exactly one
// wording; a surface picks which clauses it needs. Substance cannot diverge, framing still can.
//
// ── Delivery, and why this lives in tool descriptions at all ──────────────────────────────────
//
// `initialize.instructions` is the semantically correct home for standing rules, and it is where
// the vault map necessarily lives (it is too large to weld into a tool description). But hosts are
// not obliged to forward instructions to the model, and at least one major host silently discards
// them. Tool descriptions ARE always delivered. Anything that must reach the model — as opposed to
// merely being sent correctly — therefore has to survive in a tool description.
//
// That makes the guard's placement a deliberate redundancy, not duplication: instructions for hosts
// that honour them, tool descriptions for the rest.

/**
 * The individual rules. Kept as separate clauses because each defends a distinct failure:
 * a title that reads like an answer, a snippet mistaken for the whole note, a citation with no
 * actual read behind it, and a model that — forbidden to answer — says nothing useful at all.
 */
export const GUARD = {
  /**
   * The structural core. Unlike "do not assume", this is checkable against the reader's own
   * transcript: either a `read` call for that uid appears in this session, or it does not.
   * The session-scoping is the load-bearing part — "cite only after read" without "this session"
   * is satisfiable by a vague feeling of having read something.
   */
  uidOnly:
    "You may state, quote, or rely on a note's contents ONLY by its `uid`, and only a uid you have " +
    "actually read with `read` during THIS session.",

  /** Titles are compressed claims, and a compressed claim looks exactly like an answer. */
  pointers:
    "Search results and the vault map are POINTERS, not sources. A note title is a compressed claim: " +
    "\"Spot-only for MVP, no leverage\" looks like it contains the answer, and that is the trap — the " +
    "note behind it may qualify that claim, scope it to a date, or have been superseded outright.",

  /** Distinct from title-seduction: a snippet is real note text, which makes it more tempting. */
  snippet: "A snippet is one chunk of one note, not the note.",

  /**
   * Without this the guard is purely prohibitive, and a model that cannot cite tends to fall
   * silent rather than offer the one genuinely useful move — naming that the note exists.
   */
  fallback:
    "Before reading, you may say that a relevant note appears to exist and offer to open it — you " +
    "may not report what it says.",
} as const;

/** Guard as it appears on `search`: the full rule, because search is where the temptation is. */
export function guardForSearch(): string {
  return [GUARD.pointers, GUARD.snippet, GUARD.uidOnly, GUARD.fallback].join(" ");
}

/** Guard as it appears on `read`: read is where the right to cite is EARNED, so the rule belongs here too. */
export function guardForRead(): string {
  return [
    "This is the only tool that lets you state what a note says — search snippets and titles do not.",
    GUARD.uidOnly,
  ].join(" ");
}

/** Guard as it appears in the initialize instructions, laid out with breathing room. */
export function guardForInstructions(): string {
  return [GUARD.uidOnly, "", GUARD.pointers, GUARD.snippet, "", `So: to answer FROM a note, \`read\` it first. ${GUARD.fallback}`].join(
    "\n",
  );
}
