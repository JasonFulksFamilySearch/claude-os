import Database from "better-sqlite3";
import { join } from "node:path";
import { z } from "zod";
import { defaultConfig, type IndexerConfig } from "../indexer.js";
import { listEpisodeFiles } from "../episodes.js";
import { clusterByEmbedding } from "../experience.js";
import { EXPERIENCE_MAX_EPISODES } from "../search_config.js";

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
  const backlog = listEpisodeFiles(episodesDir, { promoted: false, project: args.project });
  backlog.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const cap = args.max_episodes ?? EXPERIENCE_MAX_EPISODES;
  const episodes = backlog.slice(0, cap);

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
    members.push(ep);
    vectors.push(deserializeVector(row.embedding as Buffer));
  }

  // 3. Cluster by theme and shape the output. Singletons / sub-minimum clusters are dropped.
  const clusters = clusterByEmbedding(members, vectors);
  return {
    clusters: clusters.map((c) => ({
      size: c.members.length,
      cohesion: c.cohesion,
      members: c.members.map((ep) => ({
        path: ep.path,
        session_id: ep.session_id,
        date: ep.date,
        summary: ep.summary,
      })),
    })),
  };
}
