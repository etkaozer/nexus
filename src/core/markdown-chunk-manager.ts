// MarkdownChunkManager — the default ChunkManager. Pure, in-memory Markdown → Chunk[]
// derivation. No I/O, no embeddings, no git.
//
// Identity model:
//   • Split the body on the SHALLOWEST heading level actually present (outside code
//     fences): a note whose sections are `#` splits on `#`, `##` on `##`, etc. Content
//     before the first heading of that level becomes a dedicated `__preamble` chunk.
//     Headings DEEPER than the split level are content, not boundaries. A note with no
//     headings at all is a single preamble chunk.
//   • Every boundary heading gets an OPAQUE slug, minted once and then persisted as an
//     invisible HTML comment on the line directly below the heading: `<!-- cid:a1b2 -->`.
//     On re-chunk the slug is READ from that anchor, never recomputed from heading text —
//     so renaming a heading keeps the chunk id stable. Two identical headings each carry
//     their own anchor, so their ids never collide.
//   • chunk_id = `<uid>::<slug>#<ordinal>`. The ordinal indexes sub-chunks within a
//     section: 0 for a normal section, 0..N for an oversize section split on the
//     next-deeper heading level (then a fixed-size fallback).
//   • The returned `body` differs from the input ONLY by injected `<!-- cid -->` anchors.
//     Nothing else derived (no related_auto) is ever written into the body.
//   • The anchor is stripped from a chunk's `content` before it could reach an embedder.

import { randomBytes } from "node:crypto";
import type { Note, Chunk } from "../types.js";
import type { ChunkManager, ChunkResult } from "./chunk-manager.js";
import { sha256 } from "./hash.js";

export interface ChunkManagerOptions {
  /** Token budget per chunk before a section is sub-split. Default 450 (e5). */
  maxTokens?: number;
  /** Mints a fresh opaque slug. Default: random 4-char base36. Injectable for deterministic tests. */
  mintSlug?: () => string;
  /** Approximate token counter. Default: ~chars/4 heuristic (no model needed at this layer). */
  countTokens?: (text: string) => number;
}

const PREAMBLE_SLUG = "__preamble";

// Any ATX heading: 1–6 leading `#` (7+ is not a heading), a space, then non-empty text.
// Optional trailing closing hashes (`## Foo ##`) are dropped from the text.
const HEADING_RE = /^ {0,3}(#{1,6})(?!#)[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const ANCHOR_RE = /^[ \t]*<!--[ \t]*cid:([A-Za-z0-9_-]+)[ \t]*-->[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

interface HeadingSection {
  headingLine: string;
  headingText: string;
  slug: string;
  /** Lines below the anchor, up to the next boundary heading. Excludes the heading's own anchor. */
  bodyLines: string[];
}

interface SubSection {
  line: string;
  lines: string[];
}

export class MarkdownChunkManager implements ChunkManager {
  private readonly maxTokens: number;
  private readonly mintSlug: () => string;
  private readonly countTokens: (text: string) => number;

  constructor(opts: ChunkManagerOptions = {}) {
    this.maxTokens = opts.maxTokens ?? 450;
    this.mintSlug = opts.mintSlug ?? randomSlug;
    this.countTokens = opts.countTokens ?? ((t) => Math.max(1, Math.ceil(t.trim().length / 4)));
  }

  chunk(note: Note): ChunkResult {
    const uid = note.frontmatter.uid;
    const lines = note.body.split("\n");

    // The boundary is the shallowest heading level present; deeper headings are content.
    // null → the note has no headings, so the whole body is one preamble chunk.
    const splitLevel = detectSplitLevel(lines);

    // Reserve every slug already present anywhere in the body so newly minted slugs
    // can never collide with an existing anchor.
    const used = new Set<string>();
    for (const line of lines) {
      const s = parseAnchor(line);
      if (s) used.add(s);
    }

    const outLines: string[] = [];
    const headingSections: HeadingSection[] = [];
    const preambleLines: string[] = [];
    let cur: HeadingSection | null = null;
    let inFence = false;
    let fence = "";

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line === undefined) break;

      const h = inFence ? null : parseHeading(line);
      if (h !== null && h.level === splitLevel) {
        const next = lines[i + 1];
        const existing = next !== undefined ? parseAnchor(next) : null;
        const anchorPresent = existing !== null;
        const slug = anchorPresent ? existing : this.mintUnique(used);

        outLines.push(line);
        outLines.push(anchorPresent ? (next as string) : `<!-- cid:${slug} -->`);

        cur = { headingLine: line, headingText: h.text, slug, bodyLines: [] };
        headingSections.push(cur);
        i += anchorPresent ? 2 : 1;
        continue;
      }

      // Non-boundary line (plain content OR a deeper heading): track fenced code blocks
      // so `#`-anything inside a code block never splits.
      const fc = fenceChar(line);
      if (fc !== null) {
        if (!inFence) {
          inFence = true;
          fence = fc;
        } else if (fc === fence) {
          inFence = false;
          fence = "";
        }
      }

      outLines.push(line);
      if (cur) cur.bodyLines.push(line);
      else preambleLines.push(line);
      i += 1;
    }

    const chunks: Chunk[] = [];

    // Preamble (content before the first boundary heading).
    if (preambleLines.some((l) => l.trim().length > 0)) {
      const text = stripAnchorLines(preambleLines).join("\n").trim();
      if (text.length > 0) {
        const pieces = this.countTokens(text) <= this.maxTokens ? [text] : this.splitFixed(text);
        this.pushChunks(chunks, uid, PREAMBLE_SLUG, null, pieces);
      }
    }

    // Heading sections. Oversize sections sub-split on the next-deeper heading level.
    const subLevel = (splitLevel ?? 1) + 1;
    for (const s of headingSections) {
      const cleanBody = stripAnchorLines(s.bodyLines);
      const fullText = [s.headingLine, ...cleanBody].join("\n").trim();
      const pieces =
        this.countTokens(fullText) <= this.maxTokens
          ? [fullText]
          : this.subSplit(s.headingLine, cleanBody, subLevel);
      this.pushChunks(chunks, uid, s.slug, s.headingText, pieces);
    }

    return { body: outLines.join("\n"), chunks };
  }

  private pushChunks(
    out: Chunk[],
    uid: string,
    slug: string,
    heading: string | null,
    pieces: string[],
  ): void {
    const clean = pieces.map((p) => p.trim()).filter((p) => p.length > 0);
    clean.forEach((content, ordinal) => {
      out.push({
        chunk_id: `${uid}::${slug}#${ordinal}`,
        note_uid: uid,
        heading,
        slug,
        ordinal,
        content,
        content_hash: sha256(content),
      });
    });
  }

  private mintUnique(used: Set<string>): string {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const s = this.mintSlug();
      if (s !== PREAMBLE_SLUG && !used.has(s)) {
        used.add(s);
        return s;
      }
    }
    throw new Error("ChunkManager: unable to mint a unique chunk slug");
  }

  // Oversize section → sub-split on the next-deeper level, then a fixed-size fallback.
  // The parent heading line is prepended to each segment so every sub-chunk keeps context.
  private subSplit(headingLine: string, cleanBody: string[], subLevel: number): string[] {
    const { lead, subs } = segmentBySubheading(cleanBody, subLevel);

    const segments: string[] = [];
    if (lead.join("\n").trim().length > 0) segments.push([headingLine, ...lead].join("\n"));
    for (const sub of subs) segments.push([headingLine, sub.line, ...sub.lines].join("\n"));
    if (segments.length === 0) segments.push([headingLine, ...cleanBody].join("\n"));

    const pieces: string[] = [];
    for (const seg of segments) {
      if (this.countTokens(seg) > this.maxTokens) pieces.push(...this.splitFixed(seg));
      else pieces.push(seg);
    }
    return pieces;
  }

  // Fixed-size fallback: greedily pack whole lines into ≤ maxTokens windows; hard-split
  // any single line that itself exceeds the budget.
  private splitFixed(text: string): string[] {
    const lines = text.split("\n");
    const windows: string[] = [];
    let cur: string[] = [];
    let curTok = 0;

    const flush = (): void => {
      if (cur.length) {
        windows.push(cur.join("\n"));
        cur = [];
        curTok = 0;
      }
    };

    for (const line of lines) {
      const lt = this.countTokens(line);
      if (lt > this.maxTokens) {
        flush();
        for (const piece of this.hardSplit(line)) windows.push(piece);
        continue;
      }
      if (curTok + lt > this.maxTokens) flush();
      cur.push(line);
      curTok += lt;
    }
    flush();
    return windows;
  }

  private hardSplit(line: string): string[] {
    const maxChars = Math.max(1, this.maxTokens * 4);
    const out: string[] = [];
    for (let k = 0; k < line.length; k += maxChars) out.push(line.slice(k, k + maxChars));
    return out;
  }
}

// ── module-level helpers ──────────────────────────────────────────────────────

function parseHeading(line: string): { level: number; text: string } | null {
  const m = HEADING_RE.exec(line);
  if (!m) return null;
  const level = (m[1] ?? "").length;
  const text = (m[2] ?? "").trim();
  return level >= 1 && text.length > 0 ? { level, text } : null;
}

/** The shallowest ATX heading level used outside code fences, or null if there are none. */
function detectSplitLevel(lines: string[]): number | null {
  let inFence = false;
  let fence = "";
  let min: number | null = null;
  for (const line of lines) {
    const fc = fenceChar(line);
    if (fc !== null) {
      if (!inFence) {
        inFence = true;
        fence = fc;
      } else if (fc === fence) {
        inFence = false;
        fence = "";
      }
      continue;
    }
    if (inFence) continue;
    const h = parseHeading(line);
    if (h && (min === null || h.level < min)) min = h.level;
  }
  return min;
}

function parseAnchor(line: string): string | null {
  const m = ANCHOR_RE.exec(line);
  return m ? (m[1] ?? null) : null;
}

function fenceChar(line: string): string | null {
  const m = FENCE_RE.exec(line);
  if (!m) return null;
  return (m[1] ?? "").charAt(0) || null;
}

/** Drop any full-line `<!-- cid:... -->` anchors so they never reach an embedder. */
function stripAnchorLines(lines: string[]): string[] {
  return lines.filter((l) => parseAnchor(l) === null);
}

// Segment a section body on headings at exactly `subLevel`. Headings deeper than
// subLevel stay as content within a sub-section.
function segmentBySubheading(
  bodyLines: string[],
  subLevel: number,
): { lead: string[]; subs: SubSection[] } {
  const lead: string[] = [];
  const subs: SubSection[] = [];
  let cur: SubSection | null = null;
  let inFence = false;
  let fence = "";

  for (const line of bodyLines) {
    const fc = fenceChar(line);
    if (fc !== null) {
      if (!inFence) {
        inFence = true;
        fence = fc;
      } else if (fc === fence) {
        inFence = false;
        fence = "";
      }
    }

    const isSub = !inFence && parseHeading(line)?.level === subLevel;
    if (isSub) {
      cur = { line, lines: [] };
      subs.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    } else {
      lead.push(line);
    }
  }
  return { lead, subs };
}

function randomSlug(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(4);
  let s = "";
  for (const b of bytes) s += alphabet.charAt(b % 36);
  return s;
}
