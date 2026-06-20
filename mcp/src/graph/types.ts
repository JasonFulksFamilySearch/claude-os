// Schema for the Dioscuri code-graph artifact (FR-C1..C5).
//
// The artifact is a static, per-repo, repo-relative symbol graph emitted at
// .dioscuri/graph/graph.json. It is queried on demand; it never enters Layer 1 /
// the rendered identity-rules prefix (FR-C5 / AC-2) and is never indexed into the
// observations corpus (it lives outside every indexer-walked dir).
//
// PORTABILITY INVARIANT (DIO-2 Exit-b, load-bearing): every path in this artifact
// is REPO-RELATIVE — zero machine-specific absolute paths, no "/Users/" strings.
// Two machines (Willis/Walter) at the same commit produce a byte-identical graph.json.
// This is unqualified: the graph.json artifact carries nothing wall-clock or
// machine-varying. Per-build metadata that CANNOT be byte-identical across machines
// (the wall-clock built_at) lives in a SIDECAR file (graph.meta.json, GraphMeta below),
// NOT in graph.json — so cross-machine byte-equality on graph.json is structurally true,
// not merely asserted. build_commit (deterministic at a commit) stays IN graph.json
// because it IS part of the reproducibility contract.

/** Schema version of the on-disk artifact. Bump on any breaking shape change. */
export const GRAPH_SCHEMA_VERSION = 1 as const;

/**
 * A symbol node: a function or method declaration the graph reasons about.
 * `id` is a stable, repo-relative, deterministic key: `<relPath>#<name>` (plus a
 * `~N` disambiguator only when a name repeats within one file). Stability across
 * machines is what makes the build-commit stamp meaningful (FR-C3).
 */
export interface SymbolNode {
  /** Stable repo-relative symbol id, e.g. "tools/search_memory.ts#searchMemory". */
  id: string;
  /** Declared name, e.g. "searchMemory". */
  name: string;
  /** Repo-relative source file, e.g. "tools/search_memory.ts". Never absolute. */
  file: string;
  /** 1-based line of the declaration, for evidence. */
  line: number;
  /** True if this symbol is an exported entry point of its module. */
  exported: boolean;
}

/**
 * A directed call edge `from` → `to`, resolved type-aware via ts-morph.
 *
 * `aliased` records that the callee was reached through an aliased import — the
 * DIO-2 load-bearing case (`getAliasedSymbol()` was required to resolve it; the
 * spike returned null on aliases until that call was added).
 *
 * `guards` is the list of declared guard conditions that hold on the path to this
 * call site (early-return / early-throw `if`s that execute before the call in its
 * control-flow block). Reaching the call implies each guard condition was false —
 * this is how a call site is "resolved THROUGH a declared guard" (FR-C4).
 */
export interface CallEdge {
  /** Caller symbol id. */
  from: string;
  /** Callee symbol id. */
  to: string;
  /** 1-based line of the call site, for evidence. */
  line: number;
  /** True iff the callee was resolved through an aliased import (getAliasedSymbol). */
  aliased: boolean;
  /** Declared guard conditions that hold on the path reaching this call site. */
  guards: string[];
}

/**
 * Bounded-depth reach, precomputed per symbol so blast-radius queries are a map
 * lookup, not a live re-traversal (FR-C1).
 *   reaches  = symbols THIS symbol can reach (forward, what it calls transitively).
 *   reachedBy = symbols that can reach THIS symbol (reverse, what touches it).
 */
export interface ReachEntry {
  reaches: string[];
  reachedBy: string[];
}

/**
 * A configurable provider/consumer contract READ FROM THE AUDITED REPO (FR-C2).
 * The capability ships the MECHANISM; these definitions are per-repo inputs — never
 * hardcoded, never project-specific. A contract names a provider symbol and the
 * declared invariant a path must satisfy before reaching it.
 */
export interface ContractDef {
  /** Stable id for the contract, e.g. "search-pool-nonempty". */
  rule_id: string;
  /** Severity the auditor attaches to a violation. */
  severity: "error" | "warning" | "info";
  /**
   * Provider match: a symbol the contract governs. Matched by symbol name or by the
   * `file#name` id suffix. The provider is the "must be guarded" sink.
   */
  provider: string;
  /**
   * Consumer match (optional): the symbol(s) expected to use the provider. When set,
   * the contract flags consumers with no matching provider and providers with no
   * consumer.
   */
  consumer?: string;
  /**
   * Declared invariant: a guard condition (by substring) that every path reaching the
   * provider MUST pass through. A path reaching the provider WITHOUT a guard whose text
   * contains this string is a violation. NEVER hardcoded in the capability — supplied
   * by the audited repo's contracts file.
   */
  requiresGuard?: string;
  /** Human-readable description carried into findings. */
  description?: string;
}

/** Why a contract fired, for one violation. */
export type ViolationKind =
  | "consumer_without_provider"
  | "provider_without_consumer"
  | "unguarded_path_to_provider";

/**
 * One structured contract finding (FR-C2 / FR-H3 shape). Carries a concrete call
 * path as evidence — a finding without a call path is not shippable (FR-H4).
 */
export interface ContractFinding {
  rule_id: string;
  severity: ContractDef["severity"];
  kind: ViolationKind;
  /** The symbol at the focus of the violation. */
  symbol_id: string;
  /** Concrete call path (symbol ids) that evidences the finding. */
  call_path: string[];
  summary: string;
  /** The build-commit stamp of the index this finding was raised against (FR-C3). */
  index_commit: string;
}

/**
 * The on-disk artifact (graph.json). Repo-relative throughout; loaded on demand only.
 *
 * BYTE-DETERMINISTIC: every field here is a deterministic function of the commit +
 * source. Two machines at the same commit serialize this object byte-for-byte
 * identically. Wall-clock / per-build metadata (built_at) is structurally excluded —
 * it lives in the GraphMeta sidecar (graph.meta.json), never here.
 */
export interface GraphArtifact {
  schema_version: typeof GRAPH_SCHEMA_VERSION;
  /** Build-commit stamp for two-machine reproducibility (FR-C3). Deterministic at a commit. */
  build_commit: string;
  /** Whether the working tree was dirty at build time (the stamp is then advisory). */
  build_dirty: boolean;
  /** Repo-relative root the graph was built over, e.g. "mcp/src". Never absolute. */
  target_root: string;
  symbols: SymbolNode[];
  edges: CallEdge[];
  /** Reach precomputed per symbol id. */
  reach: Record<string, ReachEntry>;
  /** The contracts read from the audited repo at build time (echoed for provenance). */
  contracts: ContractDef[];
  /** Findings produced by evaluating `contracts` against the graph. */
  findings: ContractFinding[];
}

/**
 * Per-build sidecar metadata, written to graph.meta.json next to graph.json.
 *
 * This is the home for build facts that are genuinely per-build and CANNOT be
 * byte-identical across machines — deliberately kept OUT of graph.json so the
 * artifact stays byte-deterministic at a commit (see the PORTABILITY INVARIANT
 * note at the top of this file). Informational only: NOT part of the comparable
 * artifact and NOT consulted by any query or reproducibility comparison.
 *
 * build_commit is echoed here for convenience/provenance, but it is graph.json's
 * value that is authoritative for the reproducibility contract.
 */
export interface GraphMeta {
  /** ISO-8601 wall-clock build time. Per-build; never byte-stable across machines. */
  built_at: string;
  /** The build-commit the adjacent graph.json was built at (echoed for provenance). */
  build_commit: string;
}
