import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defaultConfig, type IndexerConfig } from "../indexer.js";
import { listEpisodeFiles } from "../episodes.js";
import { parseEntries, lexicalSimilarity } from "../novelty.js";
import {
  validateExperienceProposalShape,
  verifyCitations,
  type KnownEpisode,
} from "../experience.js";
import { NOVELTY_LEXICAL_DUP, EXPERIENCE_MIN_CLUSTER_SIZE } from "../search_config.js";

export const validateExperienceProposalInput = z.object({
  proposal: z.unknown(),
});

export type ValidateExperienceProposalInput = z.infer<typeof validateExperienceProposalInput>;

export interface DuplicateOf {
  path: string;
  date: string;
  similarity: number;
}

export interface ValidateExperienceResult {
  valid: boolean;
  errors: string[];
  resolved_citations: number;
  unresolved_citations: string[];
  duplicate_of: DuplicateOf | null;
}

export const validateExperienceProposalDefinition = {
  name: "validate_experience_proposal",
  description:
    "Gate 1 of experience synthesis (deterministic grounding). Validates a candidate experience-learning proposal on three counts: schema conformance (proposal-schema.json shape, EXPERIENCE_LEARNING category, APPEND_LEARNING action); citation grounding (every cited episode resolves to a real episode AND at least the minimum distinct episodes are cited — a fabricated citation fails); and that the proposed learning is not a lexical near-duplicate of an existing learning. Returns { valid, errors, resolved_citations, unresolved_citations, duplicate_of }. /experience-synthesis must pass a proposal through this before /grade-proposal and the red-blue-judge adversarial cross-check.",
  inputSchema: {
    type: "object" as const,
    properties: {
      proposal: {
        type: "object",
        description:
          "The candidate experience-learning proposal (proposal-schema.json proposal shape).",
      },
    },
    required: ["proposal"],
  },
};

function learningFiles(dataRoot: string): string[] {
  const files = [join(dataRoot, "agent", "learnings.md")];
  const projectsDir = join(dataRoot, "projects");
  if (existsSync(projectsDir)) {
    for (const slug of readdirSync(projectsDir)) {
      files.push(join(projectsDir, slug, "learnings.md"));
    }
  }
  return files.filter((f) => existsSync(f));
}

// Gate 1 — deterministic grounding. No embedder and no DB: schema conformance and citation
// resolution are pure, and the duplicate check is the cheap lexical (Jaccard) signal A2 uses at
// write time. The semantic-duplicate and "genuinely supported by the evidence" judgments are
// deferred to the red-blue-judge adversarial pass (gate 3).
export function validateExperienceProposal(
  rawArgs: unknown,
  config: IndexerConfig = defaultConfig(),
): ValidateExperienceResult {
  const args = validateExperienceProposalInput.parse(rawArgs);
  const proposal = args.proposal as Record<string, unknown> | null;

  // 1a — schema conformance.
  const shape = validateExperienceProposalShape(proposal);
  const errors = [...shape.errors];

  // 1b — citation grounding: every cited episode must resolve to a real episode on disk, and the
  // proposal must cite at least the minimum distinct episodes.
  const known: KnownEpisode[] = listEpisodeFiles(join(config.dataRoot, "episodes")).map((e) => ({
    session_id: e.session_id,
    path: e.path,
  }));
  const evidenceRaw = (proposal as { evidence?: unknown } | null)?.evidence;
  const evidence = Array.isArray(evidenceRaw)
    ? evidenceRaw.filter((x): x is string => typeof x === "string")
    : [];
  const citations = verifyCitations(evidence, known, EXPERIENCE_MIN_CLUSTER_SIZE);
  if (citations.unresolved.length > 0) {
    errors.push(
      `evidence cites ${citations.unresolved.length} reference(s) that resolve to no known episode`,
    );
  }
  if (citations.resolved < EXPERIENCE_MIN_CLUSTER_SIZE) {
    errors.push(
      `evidence cites only ${citations.resolved} distinct episode(s); need >= ${EXPERIENCE_MIN_CLUSTER_SIZE}`,
    );
  }

  // 1c — not a lexical near-duplicate of an existing learning entry.
  const content =
    typeof (proposal as { proposed_change?: { content?: unknown } } | null)?.proposed_change
      ?.content === "string"
      ? ((proposal as { proposed_change: { content: string } }).proposed_change.content)
      : "";
  let duplicate: DuplicateOf | null = null;
  if (content) {
    for (const file of learningFiles(config.dataRoot)) {
      for (const entry of parseEntries(readFileSync(file, "utf8"))) {
        const sim = lexicalSimilarity(content, entry.body);
        if (sim >= NOVELTY_LEXICAL_DUP && (duplicate === null || sim > duplicate.similarity)) {
          duplicate = { path: file, date: entry.date, similarity: sim };
        }
      }
    }
  }
  if (duplicate) {
    errors.push(
      `proposed learning duplicates an existing learning (${duplicate.path} ${duplicate.date}, similarity ${duplicate.similarity.toFixed(2)})`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    resolved_citations: citations.resolved,
    unresolved_citations: citations.unresolved,
    duplicate_of: duplicate,
  };
}
