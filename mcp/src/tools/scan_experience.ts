import Database from "better-sqlite3";
import { join } from "node:path";
import { z } from "zod";
import { defaultConfig, type IndexerConfig } from "../indexer.js";
import { listEpisodeFiles } from "../episodes.js";
import { clusterByEmbedding } from "../experience.js";
import {
  EXPERIENCE_MAX_EPISODES,
  EXPERIENCE_MIN_EPISODE_VALUE,
  EXPERIENCE_MIN_CLUSTER_VALUE,
  EXPERIENCE_VALUE_GATE_MODE,
} from "../search_config.js";
import { buildHistogram, writeShadowRecord, DEFAULT_SHADOW_LOG, type ShadowMember } from "../experience-shadow.js";

export const scanExperienceInput = z.object({
  project: z.string().optional(),
  max_episodes: z.number().int().positive().max(1000).optional(),
});

export type ScanExperienceInput = z.infer<typeof scanExperienceInput>;

interface ClusterMember {
  path: string;
  session_id: string | null;
  date: string;
  summary: string | null;
  value_score: number | undefined;
}

export interface ExperienceCluster {
  size: number;
  cohesion: number; // mean intra-cluster cosine — higher = tighter theme
  members: ClusterMember[];
}

export const scanExperienceDefinition = {
  name: "scan_experience",
  description:
    "Cross-session experience synthesis (mechanical step). Clusters the UNPROMOTED episode backlog by thematic similarity, reusing each episode's pre-computed whole-body embedding from the vector index (no re-embedding), and returns the clusters with their member episodes (path, session_id, date, summary). It performs NO LLM synthesis and persists nothing — /experience-synthesis distills each returned cluster into a candidate learning, runs it through the grounding/grade/adversarial gates, and only then proposes it for human-gated promotion. Clusters smaller than the configured minimum are dropped.",
  inputSchema: {
    type: "object" as const,
    properties: {
      project: {
        type: "string",
        description:
          "Optional project label to scope the backlog to episodes tagged with that project. Omit to scan all unpromoted episodes.",
      },
      max_episodes: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
        description:
          "Cap on the most-recent unpromoted episodes considered this run (default from config).",
      },
    },
    required: [],
  },
};

export interface ValueGateOptions {
  mode: "shadow" | "live";
  minEpisode: number | null;
  minCluster: number | null;
}

function resolveValueGate(config: IndexerConfig & { valueGate?: ValueGateOptions }): ValueGateOptions {
  return (
    config.valueGate ?? {
      mode: EXPERIENCE_VALUE_GATE_MODE,
      minEpisode: EXPERIENCE_MIN_EPISODE_VALUE,
      minCluster: EXPERIENCE_MIN_CLUSTER_VALUE,
    }
  );
}

// Excluded only if it HAS a score strictly below the floor. Absent score => kept.
function episodeBelowFloor(v: number | undefined, floor: number | null): boolean {
  return floor !== null && typeof v === "number" && v < floor;
}

// Cluster value = max over scored members; no scored members => "unknown" => kept.
function clusterBelowFloor(memberValues: (number | undefined)[], floor: number | null): boolean {
  if (floor === null) return false;
  const scored = memberValues.filter((v): v is number => typeof v === "number");
  if (scored.length === 0) return false;
  return Math.max(...scored) < floor;
}

// sqlite-vec vec0 stores the embedding as raw little-endian float32 bytes (what serializeVector
// wrote). Read them back into a Float32Array, honoring the Buffer's offset into its backing store.
function deserializeVector(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4));
}

export function scanExperience(
  db: Database.Database,
  rawArgs: unknown,
  config: IndexerConfig = defaultConfig(),
): { clusters: ExperienceCluster[] } {
  const args = scanExperienceInput.parse(rawArgs);
  const episodesDir = join(config.dataRoot, "episodes");

  // 1. The backlog = unpromoted episodes (most-recent first), capped for cost.
  const gate = resolveValueGate(config as IndexerConfig & { valueGate?: ValueGateOptions });
  const backlog = listEpisodeFiles(episodesDir, { promoted: false, project: args.project });
  backlog.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const cap = args.max_episodes ?? EXPERIENCE_MAX_EPISODES;
  // Cap selection. SHADOW mode is byte-identical to pre-feature (strict recency). LIVE mode, when
  // over capacity, prioritizes by value — but an ABSENT score is "unknown, not low": it ranks with
  // the top band (treated as max) so a keyless episode is never evicted in favour of a scored-low
  // one (absence ≠ low). Below the cap, both modes return the recency-ordered backlog unchanged.
  const VALUE_MAX = 4;
  const ordered =
    gate.mode === "live" && backlog.length > cap
      ? backlog.slice().sort(
          (a, b) =>
            (b.value_score ?? VALUE_MAX) - (a.value_score ?? VALUE_MAX) ||
            (a.date < b.date ? 1 : a.date > b.date ? -1 : 0),
        )
      : backlog;
  const episodes = ordered.slice(0, cap);

  // 2. Resolve each episode's pre-computed embedding from vec_items (no re-embedding). Episodes
  //    not yet indexed/embedded are skipped — a missing vector is never fatal.
  const idStmt = db.prepare("SELECT id FROM observations WHERE source_path = ?");
  const vecStmt = db.prepare("SELECT embedding FROM vec_items WHERE observation_id = ?");
  const members: typeof episodes = [];
  const vectors: Float32Array[] = [];
  for (const ep of episodes) {
    const obs = idStmt.get(ep.path) as { id: number } | undefined;
    if (!obs) continue;
    // BigInt: sqlite-vec vec0 PKs must bind as INTEGER; better-sqlite3 sends numbers as FLOAT.
    const row = vecStmt.get(BigInt(obs.id)) as { embedding: Buffer } | undefined;
    if (!row || !row.embedding) continue;
    if (gate.mode === "live" && episodeBelowFloor(ep.value_score, gate.minEpisode)) continue;
    members.push(ep);
    vectors.push(deserializeVector(row.embedding as Buffer));
  }

  // 3. Cluster by theme and shape the output. Singletons / sub-minimum clusters are dropped.
  const shaped = clusterByEmbedding(members, vectors).map((c) => ({
    size: c.members.length,
    cohesion: c.cohesion,
    members: c.members.map((ep) => ({
      path: ep.path,
      session_id: ep.session_id,
      date: ep.date,
      summary: ep.summary,
      value_score: ep.value_score,
    })),
  }));
  const clusters =
    gate.mode === "live"
      ? shaped.filter((c) => !clusterBelowFloor(c.members.map((m) => m.value_score), gate.minCluster))
      : shaped;

  const cfg = config as IndexerConfig & { shadowLogPath?: string; runTs?: string };
  try {
    const allMembers: ShadowMember[] = episodes.map((ep) => ({ date: ep.date, value_score: ep.value_score }));
    // Note: in shadow mode `shaped` is clustered from the FULL member set (the episode floor only
    // skips in live mode), so `would_exclude_clusters` projects the cluster-floor effect but NOT the
    // combined effect of also applying the episode floor pre-clustering. This is a known fidelity
    // caveat for the eventual floor-tuning phase — shadow clusters are a superset of live clusters.
    writeShadowRecord(
      {
        run_ts: cfg.runTs ?? new Date().toISOString(),
        gate_mode: gate.mode,
        rubric_version: "v1",
        episodes_considered: episodes.length,
        value_histogram: buildHistogram(allMembers),
        would_exclude_episodes: episodes
          .filter((ep) => episodeBelowFloor(ep.value_score, gate.minEpisode))
          .map((ep) => ep.path),
        would_exclude_clusters: shaped
          .filter((c) => clusterBelowFloor(c.members.map((m) => m.value_score), gate.minCluster))
          .map((c) => {
            const scored = c.members.map((m) => m.value_score).filter((v): v is number => typeof v === "number");
            return { size: c.size, max_member_value: scored.length ? Math.max(...scored) : null };
          }),
      },
      cfg.shadowLogPath ?? DEFAULT_SHADOW_LOG,
    );
  } catch {
    // shadow logging is diagnostic; never let it break synthesis
  }

  return { clusters };
}
