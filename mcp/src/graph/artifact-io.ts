// Artifact emission to .dioscuri/graph/ (FR-C1, FR-C5, portability invariant).
//
// The artifact is written to <targetRoot>/.dioscuri/graph/graph.json — a REPO-RELATIVE
// location inside the audited repo, throwaway and rebuildable. It is structurally never
// indexed: the observations indexer only walks ~/.claude-data (indexer.ts classify()),
// so a .dioscuri/graph/ path under a code repo can never become an observations row.
// It is loaded on demand and never enters Layer 1 / the rendered prefix (AC-2).

import { mkdirSync, writeFileSync } from "node:fs";
import { join, posix as pathPosix, win32 as pathWin32 } from "node:path";
import type { GraphArtifact, GraphMeta } from "./types.js";

/**
 * Absolute-path test that is independent of the HOST OS. `path.isAbsolute` only
 * recognizes the running platform's form (on POSIX it would not catch "C:\…"; on
 * Windows it would not catch a bare leading "/"). We must reject BOTH forms wherever
 * the build runs, so we check the POSIX and Windows resolvers explicitly.
 */
function isAbsoluteAnyOs(value: string): boolean {
  return pathPosix.isAbsolute(value) || pathWin32.isAbsolute(value);
}

/** Directory (relative to the audited target root) the artifact is emitted into. */
export const GRAPH_DIR = ".dioscuri/graph";
/** Artifact filename. */
export const GRAPH_FILE = "graph.json";
/** Sidecar filename: per-build metadata kept OUT of the byte-deterministic graph.json. */
export const GRAPH_META_FILE = "graph.meta.json";

/** Absolute path of the artifact for a given target root. */
export function artifactPath(targetRootAbs: string): string {
  return join(targetRootAbs, GRAPH_DIR, GRAPH_FILE);
}

/** Absolute path of the per-build metadata sidecar for a given target root. */
export function metaPath(targetRootAbs: string): string {
  return join(targetRootAbs, GRAPH_DIR, GRAPH_META_FILE);
}

/**
 * Extract the CONTENTS of every string/template literal in a guard-condition's source
 * text. A guard is captured verbatim from `if`-condition `getText()` (builder.ts), so a
 * guard like `cfg === "/Users/secret/config.json"` arrives as the WHOLE expression — the
 * absolute path is embedded mid-string, NOT at position 0. `isAbsoluteAnyOs` only inspects
 * the leading characters, so it sees the whole expression as relative and the embedded
 * absolute literal slips through. We must therefore pull the literal CONTENTS out and test
 * each one individually. (Whole-string scanning the guard text would false-NEGATIVE on
 * exactly this leak — verified against the 32 real guards mcp/src captures, all of which
 * begin with an identifier, never a path.)
 */
function guardStringLiterals(guard: string): string[] {
  const out: string[] = [];
  // Matches "double", 'single', and `template` literals; captures the inner contents.
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(guard)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

/**
 * Collect every path-bearing value the portability invariant governs — each symbol's
 * `file` and `id`, the `target_root`, every edge endpoint (`from`/`to`), AND the path
 * literals embedded in each edge's `guards[]` conditions. All MUST be repo-relative.
 *
 * `guards[]` is captured verbatim from `if`-condition source text, so an absolute-path
 * literal inside a guard (`cfg === "/Users/secret/config.json"`) is path-bearing too — its
 * embedded literal is extracted (guardStringLiterals) and scanned alongside the structural
 * fields, so NO path-bearing position in the artifact is left unscanned.
 */
function pathBearingValues(artifact: GraphArtifact): string[] {
  const values: string[] = [artifact.target_root];
  for (const s of artifact.symbols) {
    values.push(s.file, s.id);
  }
  // Edge endpoints are symbol ids (the same `<relPath>#<name>` shape) — path-bearing too.
  // Guard conditions can embed a path literal verbatim; extract and scan those literals so
  // an absolute path hidden inside a guard cannot ship unscanned.
  for (const e of artifact.edges) {
    values.push(e.from, e.to);
    for (const g of e.guards) {
      values.push(...guardStringLiterals(g));
    }
  }
  return values;
}

/**
 * Guard: every path-bearing value in the artifact MUST be repo-relative — ZERO absolute
 * paths, regardless of prefix or OS. This is the DIO-2 Exit-b portability invariant
 * enforced STRUCTURALLY at the write boundary via node's path resolvers: it rejects
 * any absolute path (POSIX "/var/…", "/private/…", "/tmp/…", "/Users/…", "/home/…" AND
 * Windows "C:\…" / "C:/…" / "\\\\unc\…"), not just a hand-picked prefix denylist, and it
 * does so independent of the host OS (see isAbsoluteAnyOs). A leak fails the build loud
 * rather than silently shipping a non-portable artifact.
 *
 * COVERAGE (universal — no path-bearing position is exempt): target_root, every symbol
 * `file`/`id`, every edge `from`/`to`, AND the path literals embedded in every edge's
 * `guards[]` conditions (extracted from the verbatim `if`-condition text — see
 * pathBearingValues / guardStringLiterals). A guard such as
 * `cfg === "/Users/secret/config.json"` is scanned via its embedded literal, so it CANNOT
 * ship an absolute path unflagged. (Free-prose carriers like contract `description` and
 * finding `summary` are intentionally NOT scanned: they are documentation strings, not
 * path-bearing fields, and are not portability vectors.)
 */
export function assertNoAbsolutePaths(artifact: GraphArtifact): void {
  const offenders = pathBearingValues(artifact).filter(
    (v) => typeof v === "string" && isAbsoluteAnyOs(v),
  );
  if (offenders.length > 0) {
    const shown = Array.from(new Set(offenders)).slice(0, 5).join(", ");
    throw new Error(
      `graph: artifact contains machine-specific absolute path(s) [${shown}] — ` +
        `the portability invariant (DIO-2 Exit-b) requires repo-relative paths only`,
    );
  }
}

/**
 * Serialize + write the artifact and its per-build metadata sidecar. Returns the
 * absolute path of graph.json. Throws (before any write) if the artifact carries an
 * absolute path.
 *
 * graph.json is byte-deterministic at a commit. The wall-clock `built_at` is generated
 * HERE (write time) and written to the graph.meta.json sidecar — never into graph.json —
 * so two builds at the same commit produce a byte-identical graph.json.
 */
export function writeArtifact(targetRootAbs: string, artifact: GraphArtifact): string {
  assertNoAbsolutePaths(artifact);
  const serialized = JSON.stringify(artifact, null, 2);
  const dir = join(targetRootAbs, GRAPH_DIR);
  mkdirSync(dir, { recursive: true });

  const out = artifactPath(targetRootAbs);
  writeFileSync(out, serialized + "\n", "utf8");

  const meta: GraphMeta = {
    built_at: new Date().toISOString(),
    build_commit: artifact.build_commit,
  };
  writeFileSync(metaPath(targetRootAbs), JSON.stringify(meta, null, 2) + "\n", "utf8");

  return out;
}
