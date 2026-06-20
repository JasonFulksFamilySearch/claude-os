/**
 * Operator-run graph build (DIO-9 / FR-C1..C5).
 *
 * Usage:
 *   npm run graph:build                      # build over mcp/src (default target)
 *   npm run graph:build -- <targetRel>       # build over a different repo-relative root
 *
 * Parses the target repo into a symbol graph with ts-morph, precomputes bounded-depth
 * reach per symbol, evaluates per-repo contracts read from <target>/.dioscuri/contracts.json,
 * and emits a repo-relative artifact at <target>/.dioscuri/graph/graph.json.
 *
 * The artifact is throwaway and rebuildable, never indexed into the observations corpus,
 * and carries a build-commit stamp for two-machine reproducibility. Exports `main()` for
 * testability; the CLI entry resolves defaults and calls it.
 */
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { argv } from "node:process";
import { buildGraph } from "../graph/builder.js";
import { loadContracts } from "../graph/contracts.js";
import { writeArtifact } from "../graph/artifact-io.js";

/** Repo root = two levels up from this script's mcp/src/scripts/ dir → <repo>. */
function repoRootFromScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <repo>/mcp/src/scripts (tsx) or <repo>/mcp/dist/scripts (built)
  return resolve(here, "..", "..", "..");
}

export interface MainResult {
  artifactPath: string;
  symbolCount: number;
  edgeCount: number;
  findingCount: number;
  buildCommit: string;
}

/**
 * Build + emit. `repoRootAbs` is the audited repo root; `targetRel` is the repo-relative
 * root to parse (e.g. "mcp/src"); `tsConfigPathAbs` is the tsconfig ts-morph compiles with.
 */
export function main(
  repoRootAbs: string,
  targetRel: string,
  tsConfigPathAbs: string,
): MainResult {
  const targetRootAbs = resolve(repoRootAbs, targetRel);
  const contracts = loadContracts(targetRootAbs);

  const artifact = buildGraph({
    repoRootAbs,
    targetRootAbs,
    tsConfigPathAbs,
    contracts,
  });

  const out = writeArtifact(targetRootAbs, artifact);
  return {
    artifactPath: out,
    symbolCount: artifact.symbols.length,
    edgeCount: artifact.edges.length,
    findingCount: artifact.findings.length,
    buildCommit: artifact.build_commit,
  };
}

// CLI entry — only fires when tsx/node runs this file directly, not when imported by tests.
const isDirectEntry =
  argv[1] != null &&
  fileURLToPath(import.meta.url).endsWith(argv[1].replace(/\\/g, "/").split("/").pop() ?? "");

if (isDirectEntry) {
  const repoRootAbs = repoRootFromScript();
  const targetRel = process.argv[2] ?? "mcp/src";
  const tsConfigPathAbs = join(repoRootAbs, "mcp", "tsconfig.json");

  try {
    const result = main(repoRootAbs, targetRel, tsConfigPathAbs);
    console.log(`graph: built ${result.symbolCount} symbols, ${result.edgeCount} edges, ` +
      `${result.findingCount} findings @ ${result.buildCommit}`);
    console.log(`graph: artifact → ${result.artifactPath}`);
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error("graph: build failed:", msg);
    process.exitCode = 1;
  }
}
