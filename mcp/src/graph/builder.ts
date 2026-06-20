// The ts-morph graph builder (FR-C1..C4). Parses a target repo into a symbol graph
// (functions, exported entry points, call edges, imports), precomputes bounded-depth
// reach per symbol, evaluates per-repo contracts, and emits a repo-relative artifact.
//
// ts-morph is the settled parser (DIO-2 proved it fit). The two load-bearing
// findings carried from the DIO-2 spike, both enforced here:
//   1. getAliasedSymbol() MUST be called to resolve aliased cross-file imports —
//      the spike returned null on aliases until this was added. mcp/src uses aliased
//      imports (e.g. `import { rankCandidates } from "../ranking.js"`), so silent
//      under-resolution on aliases is the failure mode this prevents.
//   2. The artifact stores REPO-RELATIVE paths only — zero "/Users/" strings — so it
//      is byte-portable across Willis/Walter at the same commit.

import { Project, Node, SyntaxKind } from "ts-morph";
import type {
  CallExpression,
  FunctionDeclaration,
  MethodDeclaration,
  SourceFile,
} from "ts-morph";
import { execFileSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import {
  GRAPH_SCHEMA_VERSION,
  type CallEdge,
  type ContractDef,
  type GraphArtifact,
  type ReachEntry,
  type SymbolNode,
} from "./types.js";
import { evaluateContracts } from "./query.js";

/** A callable declaration the graph tracks: top-level functions and class methods. */
type Callable = FunctionDeclaration | MethodDeclaration;

export interface BuildOptions {
  /** Absolute path of the repo root (used to compute the build-commit stamp + relativize). */
  repoRootAbs: string;
  /** Absolute path of the root to parse, e.g. <repo>/mcp/src. */
  targetRootAbs: string;
  /** Absolute tsconfig path so ts-morph resolves types the way the project compiles. */
  tsConfigPathAbs: string;
  /** Per-repo contracts (already loaded from the audited repo; FR-C2). */
  contracts: ContractDef[];
  /** glob(s) of source files under targetRootAbs to include. Defaults to all .ts. */
  includeGlobs?: string[];
  /** Max BFS depth for the precomputed reach set (FR-C1 "bounded-depth"). */
  reachDepth?: number;
}

const DEFAULT_REACH_DEPTH = 6;

/** Normalize a path to forward-slash, repo-relative form. Never returns an absolute path. */
function toRepoRel(repoRootAbs: string, absPath: string): string {
  return relative(repoRootAbs, absPath).split(sep).join("/");
}

/** Read the build-commit stamp + dirty flag from git (FR-C3). */
function readBuildCommit(repoRootAbs: string): { commit: string; dirty: boolean } {
  try {
    // stdio: stderr 'ignore' so a non-repo dir (e.g. a test fixture) does not emit
    // git's "fatal: not a git repository" to the console — the catch handles it.
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRootAbs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRootAbs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { commit, dirty: status.trim().length > 0 };
  } catch {
    // Not a git repo / git unavailable: the stamp is unknown rather than a wrong value.
    return { commit: "unknown", dirty: false };
  }
}

/** Collect the top-level functions and class methods declared in a source file. */
function callablesOf(sf: SourceFile): Callable[] {
  const out: Callable[] = [];
  for (const fn of sf.getFunctions()) out.push(fn);
  for (const cls of sf.getClasses()) {
    for (const m of cls.getMethods()) out.push(m);
  }
  return out;
}

/** A stable, repo-relative, deterministic id for a callable, disambiguated on collision. */
function symbolId(
  repoRootAbs: string,
  node: Callable,
  perFileCounts: Map<string, number>,
): string {
  const file = toRepoRel(repoRootAbs, node.getSourceFile().getFilePath());
  const name = node.getName() ?? "<anonymous>";
  const key = `${file}#${name}`;
  const seen = perFileCounts.get(key) ?? 0;
  perFileCounts.set(key, seen + 1);
  return seen === 0 ? key : `${key}~${seen}`;
}

/**
 * Resolve a call expression to the symbol id of its target callable, type-aware.
 * LOAD-BEARING: calls getAliasedSymbol() so aliased cross-file imports resolve to the
 * real declaration rather than the import alias. Returns { id, aliased } or null when
 * the callee is not one of our tracked callables (e.g. a library call).
 */
function resolveCallee(
  call: CallExpression,
  declToId: Map<Node, string>,
): { id: string; aliased: boolean } | null {
  const expr = call.getExpression();
  let sym = expr.getSymbol();
  if (!sym) return null;

  // The DIO-2 load-bearing call: resolve through the import alias.
  let aliased = false;
  const aliasedSym = sym.getAliasedSymbol();
  if (aliasedSym) {
    sym = aliasedSym;
    aliased = true;
  }

  for (const decl of sym.getDeclarations()) {
    const id = declToId.get(decl);
    if (id) return { id, aliased };
  }
  return null;
}

/**
 * Collect the declared guard conditions that hold on the path reaching `call`
 * (FR-C4). A guard is an early-return / early-throw `if` (no else) that is a
 * preceding sibling of the call's statement, at any enclosing block. Reaching the
 * call implies each guard condition was false — so the call is resolved THROUGH the
 * guard. This is the contract-check case: a path reaching a provider either passes
 * the declared guard or violates the contract.
 */
function guardsReaching(call: CallExpression, fnRoot: Node): string[] {
  const guards: string[] = [];
  let node: Node | undefined = call;
  while (node && node !== fnRoot) {
    const parent = node.getParent();
    if (parent && Node.isBlock(parent)) {
      const stmts = parent.getStatements();
      const cur = node;
      const idx = stmts.findIndex(
        (s) => s === cur || (cur.getStart() >= s.getStart() && cur.getEnd() <= s.getEnd()),
      );
      for (let i = 0; i < idx; i++) {
        const s = stmts[i];
        if (Node.isIfStatement(s) && !s.getElseStatement()) {
          const then = s.getThenStatement();
          const inner = Node.isBlock(then) ? then.getStatements() : [then];
          if (inner.some((x) => Node.isReturnStatement(x) || Node.isThrowStatement(x))) {
            guards.push(s.getExpression().getText());
          }
        }
      }
    }
    node = parent;
  }
  return guards;
}

/** Bounded-depth BFS reach (FR-C1). Returns ids reachable from `start` within `depth`. */
function bfsReach(
  start: string,
  adjacency: Map<string, Set<string>>,
  depth: number,
): string[] {
  const seen = new Set<string>();
  let frontier = [start];
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const to of adjacency.get(id) ?? []) {
        if (!seen.has(to) && to !== start) {
          seen.add(to);
          next.push(to);
        }
      }
    }
    frontier = next;
  }
  return Array.from(seen).sort();
}

/**
 * Build the graph artifact over the target root. Pure with respect to the filesystem
 * except for the git stamp read; emission to disk is a separate step (see graph-build
 * script / writeArtifact). Returns a fully repo-relative artifact.
 */
export function buildGraph(opts: BuildOptions): GraphArtifact {
  const { repoRootAbs, targetRootAbs, tsConfigPathAbs, contracts } = opts;
  const reachDepth = opts.reachDepth ?? DEFAULT_REACH_DEPTH;

  const project = new Project({ tsConfigFilePath: tsConfigPathAbs });
  const targetAbs = resolve(targetRootAbs);

  // Restrict to source files under the target root (the tsconfig may include more).
  const sourceFiles = project
    .getSourceFiles()
    .filter((sf) => {
      const p = resolve(sf.getFilePath());
      return (
        p.startsWith(targetAbs + sep) &&
        p.endsWith(".ts") &&
        !p.endsWith(".d.ts")
      );
    })
    .sort((a, b) => a.getFilePath().localeCompare(b.getFilePath()));

  // Pass 1: collect symbols and a declaration → id map for callee resolution.
  const symbols: SymbolNode[] = [];
  const declToId = new Map<Node, string>();
  const idToNode = new Map<string, Callable>();
  const perFileCounts = new Map<string, number>();

  for (const sf of sourceFiles) {
    for (const node of callablesOf(sf)) {
      const id = symbolId(repoRootAbs, node, perFileCounts);
      const exported =
        (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) &&
        "isExported" in node
          ? Boolean((node as FunctionDeclaration).isExported?.())
          : false;
      symbols.push({
        id,
        name: node.getName() ?? "<anonymous>",
        file: toRepoRel(repoRootAbs, sf.getFilePath()),
        line: node.getStartLineNumber(),
        exported,
      });
      declToId.set(node, id);
      idToNode.set(id, node);
    }
  }

  // Pass 2: resolve call edges (type-aware, through aliases + guards).
  const edges: CallEdge[] = [];
  for (const [fromId, node] of idToNode) {
    const body = node.getBody();
    if (!body) continue;
    for (const call of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = resolveCallee(call, declToId);
      if (!callee) continue;
      edges.push({
        from: fromId,
        to: callee.id,
        line: call.getStartLineNumber(),
        aliased: callee.aliased,
        guards: guardsReaching(call, node),
      });
    }
  }
  edges.sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.line - b.line,
  );

  // Build forward + reverse adjacency, then precompute bounded-depth reach per symbol.
  const fwd = new Map<string, Set<string>>();
  const rev = new Map<string, Set<string>>();
  for (const s of symbols) {
    fwd.set(s.id, new Set());
    rev.set(s.id, new Set());
  }
  for (const e of edges) {
    fwd.get(e.from)?.add(e.to);
    rev.get(e.to)?.add(e.from);
  }

  const reach: Record<string, ReachEntry> = {};
  for (const s of symbols) {
    reach[s.id] = {
      reaches: bfsReach(s.id, fwd, reachDepth),
      reachedBy: bfsReach(s.id, rev, reachDepth),
    };
  }

  const { commit, dirty } = readBuildCommit(repoRootAbs);

  const partial: Omit<GraphArtifact, "findings"> = {
    schema_version: GRAPH_SCHEMA_VERSION,
    build_commit: commit,
    build_dirty: dirty,
    target_root: toRepoRel(repoRootAbs, targetAbs),
    symbols,
    edges,
    reach,
    contracts,
  };

  // Evaluate contracts against the assembled graph (shared with the on-demand query path).
  const findings = evaluateContracts(
    { ...partial, findings: [] },
    contracts,
    commit,
  );

  return { ...partial, findings };
}
