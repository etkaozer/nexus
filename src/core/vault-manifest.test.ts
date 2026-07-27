// Unit tests for the vault map and the per-search context slice. Pure functions over a seeded
// note list — no vault, no index, no clock — so every assertion is about the algorithm and not
// about ambient state.
//
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVaultManifest, buildSearchContext, estimateTokens, NO_PROJECT } from "./vault-manifest.js";
import type { NoteSummary } from "../interfaces/index-provider.js";
import type { NoteStatus } from "../types.js";

const NOW = "2026-07-27T12:00:00.000Z";

/** Seeded note. `day` becomes the updated timestamp, so recency is readable in the test. */
function note(
  uid: string,
  title: string,
  project: string | undefined,
  day: number,
  status: NoteStatus = "active",
): NoteSummary {
  const s: NoteSummary = {
    uid,
    title,
    type: "decision",
    status,
    updated: `2026-07-${String(day).padStart(2, "0")}T00:00:00.000Z`,
  };
  if (project !== undefined) s.project = project;
  return s;
}

/**
 * A vault at the scale where truncation actually bites: ~190 active notes across projects of
 * very different sizes, with realistically long titles. Sized deliberately — a 60-note vault
 * fits inside the default budget whole, so it would exercise the fitting logic not at all.
 */
function seededVault(): NoteSummary[] {
  const notes: NoteSummary[] = [];
  const bulk = (prefix: string, project: string, count: number, dayOf: (i: number) => number): void => {
    for (let i = 1; i <= count; i++) {
      notes.push(
        note(
          `${prefix}-${i}`,
          `${project} decision ${String(i).padStart(2, "0")} — a realistically long note title`,
          project,
          dayOf(i),
        ),
      );
    }
  };
  bulk("tb", "trading-bot", 47, (i) => (i % 27) + 1);
  bulk("nx", "nexus", 60, (i) => (i % 27) + 1);
  bulk("rd", "reading", 40, (i) => (i % 20) + 1);
  bulk("ms", "misc", 30, (i) => (i % 15) + 1);
  bulk("na", "notes-app", 8, () => 5);
  bulk("hl", "health", 3, () => 2);
  notes.push(note("solo-1", "A thought with no project", undefined, 9));
  return notes;
}

test("manifest includes EVERY project slug, even when titles are truncated away", async () => {
  const manifest = buildVaultManifest(seededVault(), { now: NOW });

  // Coarse coverage is the non-negotiable part: "does my vault know about X" must always be
  // answerable, or the trigger rule silently fails for whichever project got cut.
  for (const slug of ["trading-bot", "notes-app", "health", NO_PROJECT]) {
    assert.ok(manifest.includes(slug), `slug ${slug} present`);
  }
  assert.match(manifest, /Projects \(active note counts\):/);
  assert.match(manifest, /trading-bot \(47\)/, "counts are exact, not rounded");
  assert.match(manifest, /health \(3\)/);
});

test("manifest respects the token budget", async () => {
  const vault = seededVault();
  for (const budget of [300, 600, 900, 1200]) {
    const manifest = buildVaultManifest(vault, { now: NOW, tokenBudget: budget });
    assert.ok(
      estimateTokens(manifest) <= budget,
      `budget ${budget}: got ${estimateTokens(manifest)} tokens`,
    );
  }
});

test("a bigger budget shows strictly more, and the default lands in the 800-1000 band", async () => {
  const vault = seededVault();
  const small = buildVaultManifest(vault, { now: NOW, tokenBudget: 300 });
  const large = buildVaultManifest(vault, { now: NOW, tokenBudget: 900 });
  assert.ok(large.length > small.length, "more budget → more titles");

  // On a vault big enough to saturate, the default should fill the band rather than stop short.
  const dflt = buildVaultManifest(vault, { now: NOW });
  const tokens = estimateTokens(dflt);
  assert.ok(tokens > 700 && tokens <= 1000, `default manifest is ${tokens} tokens, want ~800-1000`);
});

test("archived and superseded notes never reach the manifest", async () => {
  const vault = [
    note("a", "Active and current", "proj", 10),
    note("b", "Archived thing", "proj", 11, "archived"),
    note("c", "Replaced by something newer", "proj", 12, "superseded"),
    note("d", "Only note in a dead project", "dead-proj", 13, "archived"),
  ];
  const manifest = buildVaultManifest(vault, { now: NOW });

  assert.ok(manifest.includes("Active and current"), "active note shown");
  assert.ok(!manifest.includes("Archived thing"), "archived title excluded");
  assert.ok(!manifest.includes("Replaced by something newer"), "superseded title excluded");
  // A project whose every note is retired is not a project the vault can answer about, so its
  // slug must not appear either — listing it would invite a search that can only disappoint.
  assert.ok(!manifest.includes("dead-proj"), "all-archived project excluded entirely");
  assert.match(manifest, /proj \(1\)/, "counts reflect active notes only");
});

test("truncation is marked explicitly per project, never silent", async () => {
  const manifest = buildVaultManifest(seededVault(), { now: NOW });

  // The marker is what converts "the budget ran out" into "there is more here — search for it".
  const truncated = /trading-bot — 47 active notes, (\d+) shown \(use search for the rest\)/.exec(manifest);
  assert.ok(truncated, "truncated project states total, shown, and what to do");
  assert.ok(Number(truncated[1]) < 47, "and it really is truncated");

  const shownCount = manifest.split("\n").filter((l) => l.startsWith("  - trading-bot decision")).length;
  assert.equal(Number(truncated[1]), shownCount, "the marker's count matches the titles actually listed");
});

test("a project that fits completely says so instead of implying more", async () => {
  const vault = [note("a", "Only note", "tiny", 10), note("b", "Second note", "tiny", 11)];
  const manifest = buildVaultManifest(vault, { now: NOW });
  assert.match(manifest, /tiny — 2 active notes, all shown/);
  assert.ok(!manifest.includes("use search for the rest"), "no false truncation marker");
});

test("the snapshot stamp makes staleness legible", async () => {
  const manifest = buildVaultManifest(seededVault(), { now: NOW });
  assert.match(manifest, /^Vault map — snapshot taken at session start/, "stamped as a snapshot");
  assert.ok(manifest.includes(NOW), "carries the moment it was taken");
  assert.match(manifest, /may have been added since/, "says it can be incomplete");
});

test("round-robin fill keeps small projects visible against a dominant one", async () => {
  // Pure global-recency ordering would let trading-bot's 47 notes eat the budget and leave the
  // small projects at zero shown — a map that only knows about this week.
  const manifest = buildVaultManifest(seededVault(), { now: NOW, tokenBudget: 500 });
  assert.ok(manifest.includes("notes-app decision"), "small project still shows a title");
  assert.ok(manifest.includes("health decision"), "smallest project still shows a title");
  assert.ok(manifest.includes("trading-bot decision"), "large project shows titles too");
});

test("recently-touched projects are biased earlier", async () => {
  const vault = [
    note("old-1", "Stale project note", "stale-proj", 1),
    note("new-1", "Fresh project note", "fresh-proj", 27),
  ];
  const manifest = buildVaultManifest(vault, { now: NOW });
  assert.ok(
    manifest.indexOf("fresh-proj") < manifest.indexOf("stale-proj"),
    "the recently-touched project is listed first",
  );
});

test("within a project, titles are ordered newest first", async () => {
  const vault = [
    note("a", "Oldest", "p", 1),
    note("c", "Newest", "p", 20),
    note("b", "Middle", "p", 10),
  ];
  const manifest = buildVaultManifest(vault, { now: NOW });
  assert.ok(manifest.indexOf("Newest") < manifest.indexOf("Middle"), "newest before middle");
  assert.ok(manifest.indexOf("Middle") < manifest.indexOf("Oldest"), "middle before oldest");
});

test("adding a note and renaming a note change the manifest correctly", async () => {
  const before = buildVaultManifest([note("a", "Original title", "p", 10)], { now: NOW });
  assert.ok(before.includes("Original title"));
  assert.match(before, /p — 1 active note, all shown/);

  // Rename: identity (uid) is unchanged, only the display title moves.
  const renamed = buildVaultManifest([note("a", "Renamed title", "p", 10)], { now: NOW });
  assert.ok(renamed.includes("Renamed title") && !renamed.includes("Original title"), "rename tracked");

  const added = buildVaultManifest([note("a", "Renamed title", "p", 10), note("b", "Brand new", "p", 11)], {
    now: NOW,
  });
  assert.match(added, /p — 2 active notes, all shown/, "count moved with the addition");
  assert.ok(added.indexOf("Brand new") < added.indexOf("Renamed title"), "newer note sorts first");
});

test("the manifest is deterministic for the same input", async () => {
  const vault = seededVault();
  assert.equal(buildVaultManifest(vault, { now: NOW }), buildVaultManifest(vault, { now: NOW }));
});

test("an empty vault says so rather than pretending to be a map", async () => {
  const manifest = buildVaultManifest([], { now: NOW });
  assert.match(manifest, /no active notes yet/);
  assert.match(manifest, /reindex/, "tells the operator how to fix it");
});

test("notes with no project get an explicit bucket, not silence", async () => {
  const manifest = buildVaultManifest([note("a", "Homeless thought", undefined, 5)], { now: NOW });
  assert.ok(manifest.includes(NO_PROJECT), "the bucket is named");
  assert.ok(manifest.includes("Homeless thought"), "and its notes are listed");
});

test("notes missing an `updated` timestamp still appear, sorted last", async () => {
  // The legacy-index case: an older brain.db has no mirrored `updated`. The map must degrade to
  // "unordered but complete" rather than dropping notes it cannot sort.
  const legacy: NoteSummary = { uid: "x", title: "Legacy note", type: "decision", status: "active", updated: null };
  const manifest = buildVaultManifest([legacy, note("b", "Timestamped note", undefined, 5)], { now: NOW });
  assert.ok(manifest.includes("Legacy note"), "undated note is not dropped");
  assert.ok(
    manifest.indexOf("Timestamped note") < manifest.indexOf("Legacy note"),
    "undated sorts last instead of pretending to be the epoch",
  );
});

// ── the per-search context slice ─────────────────────────────────────────────────

/** Shorthand for an active hit in a project. */
const hit = (uid: string, project: string | undefined, status: NoteStatus = "active") => ({
  uid,
  status,
  ...(project !== undefined ? { project } : {}),
});

test("the search context slice does not restate the returned titles", async () => {
  const vault = seededVault();
  const hitUids = ["tb-1", "tb-2", "na-1"];
  const hitTitles = vault.filter((n) => hitUids.includes(n.uid)).map((n) => n.title);
  const context = buildSearchContext(
    [hit("tb-1", "trading-bot"), hit("tb-2", "trading-bot"), hit("na-1", "notes-app")],
    vault,
  );

  // This is the whole point of "complementary": the slice's value is what the hits CANNOT show.
  for (const title of hitTitles) {
    assert.ok(!context.includes(title), `slice must not repeat the hit title "${title}"`);
  }
  assert.match(context, /trading-bot: 47 active notes in the vault, 2 in this result set — 45 not shown here\./);
  assert.match(context, /notes-app: 8 active notes in the vault, 1 in this result set — 7 not shown here\./);
  assert.match(context, /lags the vault until reindex/, "states exactly where the counts come from");
});

test("the context slice stays inside its ~100-200 token budget", async () => {
  const context = buildSearchContext(
    [hit("tb-1", "trading-bot"), hit("na-1", "notes-app"), hit("hl-1", "health")],
    seededVault(),
  );
  const tokens = estimateTokens(context);
  assert.ok(tokens <= 200, `slice is ${tokens} tokens, want <= 200`);
});

test("a zero-hit search returns the project slugs", async () => {
  // A miss usually means the query missed the vault's vocabulary. This is the cheapest possible
  // moment to correct that, so the slugs are worth the tokens here specifically.
  const context = buildSearchContext([], seededVault());
  assert.match(context, /0 hits/);
  for (const slug of ["trading-bot", "notes-app", "health"]) {
    assert.ok(context.includes(slug), `miss lists ${slug}`);
  }
  assert.match(context, /vocabulary mismatch/, "names the likely cause");
});

test("a zero-hit search against an empty index says the index is empty", async () => {
  const context = buildSearchContext([], []);
  assert.match(context, /no active notes/);
  assert.match(context, /reindex/);
});

test("the context slice counts only active notes", async () => {
  const vault = [
    note("a", "Current", "p", 10),
    note("b", "Retired", "p", 11, "archived"),
    note("c", "Replaced", "p", 12, "superseded"),
  ];
  const context = buildSearchContext([hit("a", "p")], vault);
  assert.match(context, /p: 1 active note in the vault, 1 in this result set \(all of them\)\./);
});

// ── regressions: a retired hit must not be credited as an active one ─────────────

test("retired hits do not inflate the shown count into a false 'you have seen it all'", async () => {
  // The bug this pins: `shown` counted hits of ANY status against an ACTIVE-only vault total, so
  // a lineage-flavoured query returning mostly superseded notes subtracted its way to "all of
  // them" — manufacturing the exact under-searching the slice exists to prevent.
  const vault: NoteSummary[] = [];
  for (let i = 1; i <= 5; i++) vault.push(note(`a${i}`, `Active ${i}`, "trading-bot", 10 + i));
  for (let i = 1; i <= 4; i++) vault.push(note(`s${i}`, `Replaced ${i}`, "trading-bot", i, "superseded"));

  const hits = [
    hit("a1", "trading-bot"),
    hit("s1", "trading-bot", "superseded"),
    hit("s2", "trading-bot", "superseded"),
    hit("s3", "trading-bot", "superseded"),
    hit("s4", "trading-bot", "superseded"),
  ];
  const context = buildSearchContext(hits, vault);

  // Only ONE active note was actually shown, so four are still unseen.
  assert.match(context, /trading-bot: 5 active notes in the vault, 1 in this result set — 4 not shown here\./);
  assert.ok(!context.includes("all of them"), "must not claim the result set covered everything");
  assert.match(context, /\+4 archived\/superseded hits above/, "retired hits are reported, not silently folded in");
});

test("a project whose hits are all retired reports zero active instead of inventing a count", async () => {
  // The `?? shown` fallback used to assert N active notes that did not exist at all.
  const vault = [note("d1", "Dead one", "dead-proj", 3, "archived"), note("d2", "Dead two", "dead-proj", 4, "archived")];
  const context = buildSearchContext([hit("d1", "dead-proj", "archived"), hit("d2", "dead-proj", "archived")], vault);

  assert.match(context, /dead-proj: no active notes in the vault — every hit above is archived or superseded\./);
  assert.ok(!/dead-proj: 2 active/.test(context), "no fabricated active count");
});

test("a single retired hit still under-reports nothing in the non-degenerate case", async () => {
  const vault: NoteSummary[] = [];
  for (let i = 1; i <= 47; i++) vault.push(note(`a${i}`, `Active ${i}`, "p", (i % 20) + 1));
  vault.push(note("s1", "Replaced", "p", 1, "superseded"));

  const context = buildSearchContext([hit("a1", "p"), hit("s1", "p", "superseded")], vault);
  assert.match(context, /p: 47 active notes in the vault, 1 in this result set — 46 not shown here\./);
});

test("a blank project slug is treated as absence, not as a nameless project", async () => {
  const blank: NoteSummary = { uid: "b", title: "Blank slug", type: "decision", project: "  ", status: "active", updated: "2026-07-05T00:00:00.000Z" };
  const manifest = buildVaultManifest([blank, note("x", "Normal", "real-proj", 6)], { now: NOW });

  assert.ok(manifest.includes(NO_PROJECT), "routed to the explicit no-project bucket");
  assert.ok(!/Projects \(active note counts\).*,\s+\(\d+\)/.test(manifest), "no nameless group in the slug line");

  const context = buildSearchContext([{ uid: "b", project: "  ", status: "active" }], [blank]);
  assert.match(context, /\(no project\): 1 active note in the vault/, "the slice normalises it the same way");
});
