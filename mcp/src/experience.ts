// B1 experience-synthesis helpers — pure clustering + proposal-shaping / grounding logic.
// No DB and no embedder here: callers supply the embeddings (clustering) and the known-episode
// set (citation grounding), so the logic stays unit-testable. See
// docs/2026-06-03-experience-synthesis-prd.md.

import { cosine } from "./novelty.js";
import { EXPERIENCE_CLUSTER_COSINE, EXPERIENCE_MIN_CLUSTER_SIZE } from "./search_config.js";

// --- Clustering (union-find over pairwise cosine edges) ---

export interface ClusterOptions {
  threshold?: number;
  minSize?: number;
}

export interface Cluster<T> {
  members: T[];
  indices: number[];
  cohesion: number; // mean pairwise cosine within the cluster
}

// Group items into thematic clusters: union i and j whenever cosine(vectors[i], vectors[j]) >=
// threshold, take the connected components (so a chain A~B~C clusters even when A and C are not
// directly similar), and keep components of size >= minSize. Largest cluster first; ties broken
// by first member index for deterministic output.
export function clusterByEmbedding<T>(
  items: T[],
  vectors: Float32Array[],
  opts: ClusterOptions = {},
): Cluster<T>[] {
  const threshold = opts.threshold ?? EXPERIENCE_CLUSTER_COSINE;
  const minSize = opts.minSize ?? EXPERIENCE_MIN_CLUSTER_SIZE;
  const n = items.length;

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cosine(vectors[i], vectors[j]) >= threshold) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }

  const clusters: Cluster<T>[] = [];
  for (const indices of groups.values()) {
    if (indices.length < minSize) continue;
    let sum = 0;
    let count = 0;
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        sum += cosine(vectors[indices[a]], vectors[indices[b]]);
        count++;
      }
    }
    clusters.push({
      members: indices.map((i) => items[i]),
      indices: indices.slice(),
      cohesion: count === 0 ? 1 : sum / count,
    });
  }

  clusters.sort((a, b) => b.members.length - a.members.length || a.indices[0] - b.indices[0]);
  return clusters;
}

// --- Proposal shaping & grounding (gate 1) ---

// The proposal object shape /grade-proposal scores (proposal-schema.json), narrowed to what an
// experience-learning proposal carries. `category` and `proposed_change.action` use the additive
// EXPERIENCE_LEARNING / APPEND_LEARNING enum values added to the schema for B1.
export interface ProposedChange {
  file: string;
  action: string;
  scope?: string;
  content?: string;
  rationale?: string;
}

export interface ExperienceProposal {
  id: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  category: string;
  title: string;
  description: string;
  evidence: string[];
  proposed_change: ProposedChange;
  estimated_weekly_savings_minutes: number;
}

export interface ShapeCheck {
  valid: boolean;
  errors: string[];
}

const ID_RE = /^P\d{3}$/;
const PRIORITIES = new Set(["HIGH", "MEDIUM", "LOW"]);

// Deterministic schema-conformance check — the half of gate 1 that needs no embedder. Mirrors
// proposal-schema.json's required fields plus the EXPERIENCE_LEARNING / APPEND_LEARNING enum
// values, so a malformed proposal fails here before it ever reaches /grade-proposal.
export function validateExperienceProposalShape(proposal: unknown): ShapeCheck {
  const errors: string[] = [];
  if (typeof proposal !== "object" || proposal === null) {
    return { valid: false, errors: ["proposal is not an object"] };
  }
  const p = proposal as Record<string, unknown>;

  if (typeof p.id !== "string" || !ID_RE.test(p.id)) errors.push("id must match /^P[0-9]{3}$/");
  if (typeof p.priority !== "string" || !PRIORITIES.has(p.priority))
    errors.push("priority must be HIGH|MEDIUM|LOW");
  if (p.category !== "EXPERIENCE_LEARNING") errors.push("category must be EXPERIENCE_LEARNING");
  if (typeof p.title !== "string" || p.title.length === 0 || p.title.length > 120)
    errors.push("title must be a non-empty string <= 120 chars");
  if (typeof p.description !== "string" || p.description.length < 50)
    errors.push("description must be a string >= 50 chars");
  if (
    !Array.isArray(p.evidence) ||
    p.evidence.length < 2 ||
    !p.evidence.every((e) => typeof e === "string")
  )
    errors.push("evidence must be an array of >= 2 strings");

  const pc = p.proposed_change as Record<string, unknown> | undefined;
  if (typeof pc !== "object" || pc === null) {
    errors.push("proposed_change is required");
  } else {
    if (typeof pc.file !== "string" || pc.file.length === 0)
      errors.push("proposed_change.file is required");
    if (pc.action !== "APPEND_LEARNING")
      errors.push("proposed_change.action must be APPEND_LEARNING for an experience learning");
  }

  const minutes = p.estimated_weekly_savings_minutes;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0 || minutes > 600)
    errors.push("estimated_weekly_savings_minutes must be an integer in [0, 600]");

  return { valid: errors.length === 0, errors };
}

export interface KnownEpisode {
  session_id: string | null;
  path: string;
}

export interface CitationCheck {
  valid: boolean;
  resolved: number; // distinct known episodes cited
  unresolved: string[]; // evidence strings matching no known episode (fabricated/dangling)
}

// The grounding half of gate 1: every evidence string must reference a real source episode, and
// the proposal must cite at least `minDistinct` DISTINCT episodes. A fabricated citation lands in
// `unresolved` and fails the check — the deterministic anti-"insight-inflation" guard the
// briefing's Phase-4 ruling requires.
//
// Distinctness is keyed on the episode's UNIQUE PATH, not its session_id: a single session emits
// several episode files that all carry the same session_id, so counting session_id strings would
// collapse same-session episodes into one and wrongly reject a legitimate proposal. A citation is
// matched by unique full path first; session_id is only a fallback for a path-less mention (and,
// being non-unique, resolves to a single episode — so establishing N distinct episodes requires
// citing them by path, which is what the synthesis skill instructs).
export function verifyCitations(
  evidence: string[],
  known: KnownEpisode[],
  minDistinct: number = EXPERIENCE_MIN_CLUSTER_SIZE,
): CitationCheck {
  const resolved = new Set<string>(); // distinct episode paths
  const unresolved: string[] = [];

  for (const e of evidence) {
    let matchedPath: string | null = null;
    for (const k of known) {
      if (e.includes(k.path)) {
        matchedPath = k.path;
        break;
      }
    }
    if (matchedPath === null) {
      for (const k of known) {
        if (k.session_id && e.includes(k.session_id)) {
          matchedPath = k.path;
          break;
        }
      }
    }
    if (matchedPath === null) unresolved.push(e);
    else resolved.add(matchedPath);
  }

  return {
    valid: unresolved.length === 0 && resolved.size >= minDistinct,
    resolved: resolved.size,
    unresolved,
  };
}
