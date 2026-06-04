// A2 novelty helpers — dated-entry parsing, entry identity / re-location, and the
// lexical (write-time) + semantic (review-time) duplicate detectors. Kept pure (no DB,
// no embedder) so the logic is unit-testable; callers supply embeddings for the semantic
// detector. See docs/2026-06-03-memory-novelty-flagging-prd.md.

import { createHash } from "node:crypto";
import { NOVELTY_NEAR_DUP_COSINE } from "./search_config.js";

export interface ParsedEntry {
  date: string; // YYYY-MM-DD from the heading
  title: string | null; // null when the heading has no "— title"
  body: string; // text after the heading line, trimmed (heading excluded)
  raw: string; // full block (heading + body) as it appears, trimmed — basis for the hash
  hash: string; // sha256(raw): two blocks collide only when byte-identical
}

export interface EntryIdentity {
  date: string;
  hash: string;
}

export interface DuplicatePair {
  a: ParsedEntry;
  b: ParsedEntry;
  cosine: number;
  kind: "duplicate" | "contradiction";
}

// `## YYYY-MM-DD — title` with the title optional and flexible spacing — matches what
// append_learning / the flush hook write AND hand-edited variants. This is the single shared
// dated-entry parser (get_recent_learnings imports it), so "what is an entry" is defined once.
const HEADING_RE = /^##\s+(\d{4}-\d{2}-\d{2})(?:\s+—\s+(.+?))?\s*$/;

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Parse dated-entry markdown (a learnings.md) into its blocks. `body` excludes the heading
// line; `raw` is the full block used for the identity hash.
export function parseEntries(markdown: string): ParsedEntry[] {
  const lines = markdown.split(/\r?\n/);
  const entries: ParsedEntry[] = [];
  let cur: { date: string; title: string | null; start: number } | null = null;

  const flush = (end: number): void => {
    if (!cur) return;
    const raw = lines.slice(cur.start, end).join("\n").trim();
    const body = lines.slice(cur.start + 1, end).join("\n").trim();
    entries.push({ date: cur.date, title: cur.title, body, raw, hash: sha256(raw) });
  };

  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (m) {
      flush(i);
      cur = { date: m[1], title: m[2] ? m[2].trim() : null, start: i };
    }
  }
  flush(lines.length);
  return entries;
}

export function entryIdentity(entry: ParsedEntry): EntryIdentity {
  return { date: entry.date, hash: entry.hash };
}

// Re-location + collapse primitive: the current blocks matching a stored identity.
// 0 ⇒ stale (entry was edited/removed); 1 ⇒ unique; N>1 ⇒ byte-identical duplicates (collapse).
export function matchByIdentity(entries: ParsedEntry[], id: EntryIdentity): ParsedEntry[] {
  return entries.filter((e) => e.date === id.date && e.hash === id.hash);
}

// A flag's two sides reference entries by (path, date, content-hash). The write-time and
// review-time detectors may discover the SAME pair in opposite (entry, match) order;
// canonicalPairOrder imposes a stable total order so both emit the identical tuple and the
// order-sensitive novelty_flags UNIQUE constraint dedups across detectors.
export interface FlagSide {
  path: string;
  date: string;
  hash: string;
}

export function canonicalPairOrder(x: FlagSide, y: FlagSide): [FlagSide, FlagSide] {
  const key = (s: FlagSide): string => `${s.path}\u0000${s.date}\u0000${s.hash}`;
  return key(x) <= key(y) ? [x, y] : [y, x];
}

// Token-overlap (Jaccard) ratio over lowercased alphanumeric tokens — the cheap write-time
// near-duplicate signal (no embedding). Two empty texts are trivially identical.
export function lexicalSimilarity(a: string, b: string): number {
  const toks = (s: string): Set<string> => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const sa = toks(a);
  const sb = toks(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Cosine similarity for the embedder's unit-normalized vectors (reduces to the dot product).
// Exported as the single shared cosine helper (experience.ts reuses it for clustering).
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

// Review-time detector: given entries and their parallel embeddings, return near-duplicate
// pairs (cosine >= NEAR_DUP). v1 surfaces only near-duplicates; the lower-similarity
// contradiction band is deferred — a real-corpus run showed it is mostly thematically-related
// noise, and vectors give proximity, not polarity. The agent still labels a flagged pair
// duplicate/contradiction/distinct during human-gated review.
export function findNearDuplicateEntries(
  entries: ParsedEntry[],
  vectors: Float32Array[],
): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const c = cosine(vectors[i], vectors[j]);
      if (c >= NOVELTY_NEAR_DUP_COSINE) {
        pairs.push({ a: entries[i], b: entries[j], cosine: c, kind: "duplicate" });
      }
    }
  }
  return pairs;
}
