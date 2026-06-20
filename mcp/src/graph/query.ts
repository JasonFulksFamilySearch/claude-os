// On-demand query over the graph artifact (FR-C1 reach, FR-C2 contracts, FR-H2).
// Loaded on demand only — this module is NEVER imported into the identity/rules
// prefix path (FR-C5 / AC-2). It reads the static artifact and answers questions.
//
// Reach queries return the CALL PATH as evidence (exit criterion (a) / FR-H2 /
// FR-H4: a finding without a concrete call path is not shippable).

import { existsSync, readFileSync } from "node:fs";
import type {
  CallEdge,
  ContractDef,
  ContractFinding,
  GraphArtifact,
  SymbolNode,
} from "./types.js";

/** Load a graph artifact from disk (absolute path). Throws if missing/malformed. */
export function loadArtifact(artifactPathAbs: string): GraphArtifact {
  if (!existsSync(artifactPathAbs)) {
    throw new Error(`graph: artifact not found at ${artifactPathAbs} (build it first)`);
  }
  const parsed = JSON.parse(readFileSync(artifactPathAbs, "utf8")) as GraphArtifact;
  return parsed;
}

/** Index symbols by id and by bare name for flexible lookup. */
function symbolIndex(artifact: GraphArtifact): {
  byId: Map<string, SymbolNode>;
  byName: Map<string, SymbolNode[]>;
} {
  const byId = new Map<string, SymbolNode>();
  const byName = new Map<string, SymbolNode[]>();
  for (const s of artifact.symbols) {
    byId.set(s.id, s);
    const list = byName.get(s.name) ?? [];
    list.push(s);
    byName.set(s.name, list);
  }
  return { byId, byName };
}

/**
 * Resolve a query string to a symbol id. Accepts a full id ("file#name"), a
 * "file#name" suffix, or a bare name (unique-resolve; ambiguous names throw).
 */
export function resolveSymbol(artifact: GraphArtifact, query: string): string {
  const { byId, byName } = symbolIndex(artifact);
  if (byId.has(query)) return query;

  // suffix match on id (e.g. "search_memory.ts#searchMemory" or "#searchMemory")
  const suffixMatches = artifact.symbols.filter((s) => s.id.endsWith(query));
  if (suffixMatches.length === 1) return suffixMatches[0].id;
  if (suffixMatches.length > 1) {
    throw new Error(
      `graph: "${query}" is ambiguous: ${suffixMatches.map((s) => s.id).join(", ")}`,
    );
  }

  const named = byName.get(query);
  if (named && named.length === 1) return named[0].id;
  if (named && named.length > 1) {
    throw new Error(`graph: "${query}" is ambiguous: ${named.map((s) => s.id).join(", ")}`);
  }
  throw new Error(`graph: no symbol matches "${query}"`);
}

/** Adjacency over edges in the given direction. */
function adjacency(edges: CallEdge[], reverse: boolean): Map<string, CallEdge[]> {
  const adj = new Map<string, CallEdge[]>();
  for (const e of edges) {
    const key = reverse ? e.to : e.from;
    const list = adj.get(key) ?? [];
    list.push(e);
    adj.set(key, list);
  }
  return adj;
}

export interface CallPath {
  /** Symbol ids in order: forward = [source, …, target]; reverse = [origin, …, target]. */
  path: string[];
  /** The edges traversed, carrying guard + aliased evidence for each hop. */
  edges: CallEdge[];
}

/**
 * Shortest call path from `fromId` to `toId` (BFS over forward edges). Returns the
 * path AND the edges traversed — so callers can see guards crossed and whether any
 * hop went through an aliased import. null if unreachable.
 */
export function callPath(
  artifact: GraphArtifact,
  fromId: string,
  toId: string,
): CallPath | null {
  if (fromId === toId) return { path: [fromId], edges: [] };
  const adj = adjacency(artifact.edges, false);
  const prev = new Map<string, CallEdge>();
  const queue = [fromId];
  const seen = new Set<string>([fromId]);
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const e of adj.get(cur) ?? []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      prev.set(e.to, e);
      if (e.to === toId) {
        // Reconstruct.
        const edges: CallEdge[] = [];
        let at = toId;
        while (at !== fromId) {
          const pe = prev.get(at) as CallEdge;
          edges.unshift(pe);
          at = pe.from;
        }
        return { path: [fromId, ...edges.map((x) => x.to)], edges };
      }
      queue.push(e.to);
    }
  }
  return null;
}

export interface ReachResult {
  symbol_id: string;
  /** Each reached/reaching symbol with a concrete call path as evidence. */
  results: Array<{ symbol_id: string; call_path: string[]; via_edges: CallEdge[] }>;
}

/**
 * "What reaches X" (reverse) or "what does X reach" (forward), each result carrying
 * its CALL PATH as evidence (FR-H2 / exit criterion (a)). Bounded by the precomputed
 * reach set; the path is reconstructed via BFS for the evidence trail.
 */
export function reachQuery(
  artifact: GraphArtifact,
  query: string,
  direction: "reaches" | "reachedBy",
): ReachResult {
  const id = resolveSymbol(artifact, query);
  const reachSet = artifact.reach[id]?.[direction] ?? [];
  const results: ReachResult["results"] = [];
  for (const other of reachSet) {
    // For "reaches": path id → other. For "reachedBy": path other → id.
    const cp = direction === "reaches" ? callPath(artifact, id, other) : callPath(artifact, other, id);
    if (cp) results.push({ symbol_id: other, call_path: cp.path, via_edges: cp.edges });
  }
  return { symbol_id: id, results };
}

/** Does a symbol's id or name match a contract's provider/consumer selector? */
function matchesSelector(symbol: SymbolNode, selector: string): boolean {
  return symbol.id === selector || symbol.id.endsWith(selector) || symbol.name === selector;
}

/**
 * Evaluate per-repo contracts against the graph (FR-C2). Each contract flags:
 *  - consumers with no matching provider,
 *  - providers with no consumer,
 *  - paths reaching a provider WITHOUT satisfying its declared invariant (guard).
 * Every finding carries a concrete call path (FR-H4). The mechanism is repo-agnostic;
 * the contract definitions are inputs.
 */
export function evaluateContracts(
  artifact: GraphArtifact,
  contracts: ContractDef[],
  indexCommit: string,
): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const symbols = artifact.symbols;

  for (const c of contracts) {
    const providers = symbols.filter((s) => matchesSelector(s, c.provider));
    const consumers = c.consumer
      ? symbols.filter((s) => matchesSelector(s, c.consumer as string))
      : [];

    // (1) consumer declared but no provider exists.
    if (c.consumer && providers.length === 0 && consumers.length > 0) {
      for (const cons of consumers) {
        findings.push({
          rule_id: c.rule_id,
          severity: c.severity,
          kind: "consumer_without_provider",
          symbol_id: cons.id,
          call_path: [cons.id],
          summary: `${cons.id} consumes "${c.provider}" but no provider symbol matches it`,
          index_commit: indexCommit,
        });
      }
    }

    // (2) provider exists but nothing consumes it (only checked when a consumer is declared).
    if (c.consumer && consumers.length === 0 && providers.length > 0) {
      for (const prov of providers) {
        findings.push({
          rule_id: c.rule_id,
          severity: c.severity,
          kind: "provider_without_consumer",
          symbol_id: prov.id,
          call_path: [prov.id],
          summary: `${prov.id} is declared a provider but no consumer "${c.consumer}" matches`,
          index_commit: indexCommit,
        });
      }
    }

    // (3) unguarded path to a provider: a consumer reaches the provider via a path whose
    //     edges never satisfy the declared invariant guard. This is the load-bearing
    //     "resolve through a guard" contract: the path must pass the declared guard.
    if (c.requiresGuard) {
      const required = c.requiresGuard;
      const reachingSources = c.consumer
        ? consumers
        : // No consumer declared: any symbol that reaches a provider is a candidate path origin.
          symbols.filter((s) =>
            providers.some((p) => (artifact.reach[s.id]?.reaches ?? []).includes(p.id)),
          );

      for (const src of reachingSources) {
        for (const prov of providers) {
          if (src.id === prov.id) continue;
          const cp = callPath(artifact, src.id, prov.id);
          if (!cp) continue;
          const guardSatisfied = cp.edges.some((e) =>
            e.guards.some((g) => g.includes(required)),
          );
          if (!guardSatisfied) {
            findings.push({
              rule_id: c.rule_id,
              severity: c.severity,
              kind: "unguarded_path_to_provider",
              symbol_id: prov.id,
              call_path: cp.path,
              summary:
                `path ${cp.path.join(" → ")} reaches provider ${prov.id} ` +
                `without satisfying required guard "${required}"`,
              index_commit: indexCommit,
            });
          }
        }
      }
    }
  }

  findings.sort(
    (a, b) => a.rule_id.localeCompare(b.rule_id) || a.symbol_id.localeCompare(b.symbol_id),
  );
  return findings;
}
