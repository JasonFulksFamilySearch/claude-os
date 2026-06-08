import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { EXPERIENCE_VALUE_FEATURE_DATE } from "./search_config.js";

export const DEFAULT_SHADOW_LOG = join(homedir(), ".claude-data", "experience-shadow.jsonl");

export interface ShadowMember { date: string; value_score: number | undefined; }
export interface ShadowRecord {
  run_ts: string;
  gate_mode: "shadow" | "live";
  rubric_version: string;
  episodes_considered: number;
  value_histogram: Record<string, number>;
  would_exclude_episodes: string[];
  would_exclude_clusters: { size: number; max_member_value: number | null }[];
}

// Keyless episodes split by the feature-ship date so the 136 pre-feature episodes are not
// mistaken for judge declines (calibration null-rate = unknown_declined / post-feature).
export function buildHistogram(members: ShadowMember[]): Record<string, number> {
  const h: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, unknown_pre_feature: 0, unknown_declined: 0 };
  for (const m of members) {
    if (typeof m.value_score === "number") h[String(m.value_score)] = (h[String(m.value_score)] ?? 0) + 1;
    else if (m.date < EXPERIENCE_VALUE_FEATURE_DATE) h.unknown_pre_feature++;
    else h.unknown_declined++;
  }
  return h;
}

export function writeShadowRecord(record: ShadowRecord, logPath: string = DEFAULT_SHADOW_LOG): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8");
}
