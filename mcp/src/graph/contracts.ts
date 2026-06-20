// Per-repo contract loading (FR-C2). Contracts are READ FROM THE AUDITED REPO —
// the capability ships the MECHANISM, definitions are inputs. There is NO
// project-specific (mcp/src-specific) invariant baked in here; baking one in would
// be a defect (PRD §1 repo-agnostic; FR-C2).
//
// A repo declares its contracts in `.dioscuri/contracts.json` at the target root.
// When that file is absent, the graph builds with zero contracts (and therefore zero
// contract findings) — reach is still computed. Contracts are opt-in, per-repo data.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContractDef } from "./types.js";

/** Conventional location of a repo's contract definitions, relative to the target root. */
export const CONTRACTS_FILENAME = ".dioscuri/contracts.json";

function isContractDef(value: unknown): value is ContractDef {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["rule_id"] !== "string") return false;
  if (v["severity"] !== "error" && v["severity"] !== "warning" && v["severity"] !== "info") {
    return false;
  }
  if (typeof v["provider"] !== "string") return false;
  if (v["consumer"] !== undefined && typeof v["consumer"] !== "string") return false;
  if (v["requiresGuard"] !== undefined && typeof v["requiresGuard"] !== "string") return false;
  if (v["description"] !== undefined && typeof v["description"] !== "string") return false;
  return true;
}

/**
 * Load contracts declared by the audited repo. `targetRootAbs` is the absolute path
 * of the root being audited (used only for filesystem reads — never stored in the
 * artifact). Returns [] when no contracts file exists. Throws on a malformed file so
 * a bad contract definition fails loud rather than silently auditing nothing.
 */
export function loadContracts(targetRootAbs: string): ContractDef[] {
  const path = join(targetRootAbs, CONTRACTS_FILENAME);
  if (!existsSync(path)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`contracts: ${CONTRACTS_FILENAME} is not valid JSON: ${msg}`);
  }

  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { contracts?: unknown })?.contracts)
      ? (parsed as { contracts: unknown[] }).contracts
      : null;
  if (list === null) {
    throw new Error(
      `contracts: ${CONTRACTS_FILENAME} must be an array or { contracts: [...] }`,
    );
  }

  const seen = new Set<string>();
  const out: ContractDef[] = [];
  for (const item of list) {
    if (!isContractDef(item)) {
      throw new Error(
        `contracts: malformed contract in ${CONTRACTS_FILENAME}: ${JSON.stringify(item)}`,
      );
    }
    if (seen.has(item.rule_id)) {
      throw new Error(`contracts: duplicate rule_id "${item.rule_id}" in ${CONTRACTS_FILENAME}`);
    }
    seen.add(item.rule_id);
    out.push(item);
  }
  return out;
}
