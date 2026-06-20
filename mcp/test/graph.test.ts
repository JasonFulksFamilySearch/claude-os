import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildGraph } from "../src/graph/builder.js";
import { loadContracts } from "../src/graph/contracts.js";
import { writeArtifact, assertNoAbsolutePaths, artifactPath, metaPath } from "../src/graph/artifact-io.js";
import { reachQuery, callPath, evaluateContracts } from "../src/graph/query.js";
import type { GraphArtifact, GraphMeta } from "../src/graph/types.js";

// Repo + target roots. This test runs the REAL builder over the REAL mcp/src — the
// target the DIO-9 brief names — and additionally over a synthetic fixture to prove
// the contract mechanism fires in BOTH directions (guard present → clean; absent → flagged).
const HERE = dirname(fileURLToPath(import.meta.url)); // <repo>/mcp/test
const REPO_ROOT = resolve(HERE, "..", ".."); // <repo>
const MCP_SRC = resolve(REPO_ROOT, "mcp", "src");
const TSCONFIG = resolve(REPO_ROOT, "mcp", "tsconfig.json");

describe("graph builder over real mcp/src", () => {
  let artifact: GraphArtifact;

  beforeAll(() => {
    const contracts = loadContracts(MCP_SRC);
    artifact = buildGraph({
      repoRootAbs: REPO_ROOT,
      targetRootAbs: MCP_SRC,
      tsConfigPathAbs: TSCONFIG,
      contracts,
    });
  });

  it("parses functions, exported entry points, and call edges (FR-C1)", () => {
    expect(artifact.symbols.length).toBeGreaterThan(50);
    expect(artifact.edges.length).toBeGreaterThan(50);
    const searchMemory = artifact.symbols.find((s) => s.name === "searchMemory");
    expect(searchMemory).toBeDefined();
    expect(searchMemory?.exported).toBe(true);
    expect(searchMemory?.file).toBe("mcp/src/tools/search_memory.ts");
  });

  it("answers a reach query returning the CALL PATH as evidence (FR-C1 / exit-a)", () => {
    const result = reachQuery(artifact, "shapeResults", "reachedBy");
    // searchMemory reaches shapeResults; the multi-hop index.ts#main path is the evidence.
    const viaMain = result.results.find((r) => r.symbol_id.endsWith("index.ts#main"));
    expect(viaMain).toBeDefined();
    expect(viaMain?.call_path).toEqual([
      "mcp/src/index.ts#main",
      "mcp/src/tools/search_memory.ts#searchMemory",
      "mcp/src/result_shaper.ts#shapeResults",
    ]);
  });

  it("resolves a call site THROUGH a declared guard AND through an aliased import (FR-C4, exit-b)", () => {
    // searchMemory -> shapeResults crosses an aliased import (../result_shaper.js) and
    // is reached only after the `unionIds.length === 0` early-return guard. BOTH must hold.
    const edge = artifact.edges.find(
      (e) => e.from.endsWith("#searchMemory") && e.to.endsWith("#shapeResults"),
    );
    expect(edge).toBeDefined();
    // getAliasedSymbol() resolution: the aliased import was followed to the real target.
    expect(edge?.aliased).toBe(true);
    // Guard-through resolution: reaching shapeResults implies the empty-pool guard passed.
    expect(edge?.guards).toContain("unionIds.length === 0");

    // Independently, the rankCandidates hop is ALSO aliased-and-guarded (ranking.js).
    const rankEdge = artifact.edges.find(
      (e) => e.from.endsWith("#searchMemory") && e.to.endsWith("#rankCandidates"),
    );
    expect(rankEdge?.aliased).toBe(true);
    expect(rankEdge?.guards).toContain("unionIds.length === 0");
  });

  it("carries a build-commit stamp for two-machine reproducibility (FR-C3)", () => {
    expect(artifact.build_commit).toMatch(/^[0-9a-f]{40}$|^unknown$/);
    expect(typeof artifact.build_dirty).toBe("boolean");
  });

  it("stores ZERO machine-specific absolute paths (portability invariant, DIO-2 Exit-b)", () => {
    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("/home/");
    // assertNoAbsolutePaths is the write-boundary guard — it must accept this artifact.
    expect(() => assertNoAbsolutePaths(artifact)).not.toThrow();
    // Every symbol/edge path is repo-relative.
    for (const s of artifact.symbols) {
      expect(s.file.startsWith("/")).toBe(false);
      expect(s.id.startsWith("/")).toBe(false);
    }
  });

  it("graph.json carries NO built_at — wall-clock metadata is excluded from the artifact", () => {
    // Defect-1 fix: built_at moved to the graph.meta.json sidecar so graph.json is
    // byte-deterministic. The artifact object must not carry the field at all.
    expect("built_at" in artifact).toBe(false);
    expect(JSON.stringify(artifact)).not.toContain("built_at");
  });

  it("the real repo's guarded path produces ZERO contract violations (the healthy case)", () => {
    // mcp/src/.dioscuri/contracts.json declares search-pool-guarded. Because searchMemory
    // DOES pass the declared guard before shapeResults, the contract is satisfied.
    const findings = artifact.findings.filter((f) => f.rule_id === "search-pool-guarded");
    expect(findings).toHaveLength(0);
  });

  it("contracts are read from the audited repo, never hardcoded (FR-C2)", () => {
    // The contract definitions echoed in the artifact came from the repo's contracts.json.
    const fromDisk = loadContracts(MCP_SRC);
    expect(artifact.contracts).toEqual(fromDisk);
    expect(artifact.contracts.some((c) => c.rule_id === "search-pool-guarded")).toBe(true);
  });

  it("BFS callPath returns a concrete path or null, never a fabricated one", () => {
    const sm = artifact.symbols.find((s) => s.name === "searchMemory")!.id;
    const sr = artifact.symbols.find((s) => s.name === "shapeResults")!.id;
    const cp = callPath(artifact, sm, sr);
    expect(cp?.path).toEqual([sm, sr]);
    // An unreachable target returns null (shapeResults does not call searchMemory).
    expect(callPath(artifact, sr, sm)).toBeNull();
  });
});

// Synthetic fixture: proves the contract mechanism FIRES when the guard is ABSENT —
// so the clean result above is meaningful, not vacuous. The guard-resolution is
// load-bearing: remove the guard, the contract flags an unguarded path with a call path.
describe("contract mechanism fires on an unguarded path (FR-C2 negative case)", () => {
  let tmp: string;
  let artifact: GraphArtifact;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "dio9-fixture-"));
    const srcDir = join(tmp, "src");
    mkdirSync(srcDir, { recursive: true });

    // A provider (sink) and a consumer that reaches it WITHOUT the declared guard.
    writeFileSync(
      join(srcDir, "sink.ts"),
      `export function shape(x: number[]): number { return x.length; }\n`,
    );
    writeFileSync(
      join(srcDir, "consumer.ts"),
      // Aliased import of the provider; NO guard before the call.
      `import { shape } from "./sink.js";\n` +
        `export function run(items: number[]): number {\n` +
        `  return shape(items);\n` +
        `}\n`,
    );
    writeFileSync(
      join(srcDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ES2022",
          moduleResolution: "bundler",
          strict: true,
        },
        include: ["**/*.ts"],
      }),
    );

    // Contract declared as a per-repo input file (read, not hardcoded).
    mkdirSync(join(srcDir, ".dioscuri"), { recursive: true });
    writeFileSync(
      join(srcDir, ".dioscuri", "contracts.json"),
      JSON.stringify({
        contracts: [
          {
            rule_id: "must-guard-shape",
            severity: "error",
            provider: "sink.ts#shape",
            consumer: "consumer.ts#run",
            requiresGuard: "items.length === 0",
            description: "run must guard empty input before calling shape",
          },
        ],
      }),
    );

    const contracts = loadContracts(srcDir);
    artifact = buildGraph({
      repoRootAbs: tmp,
      targetRootAbs: srcDir,
      tsConfigPathAbs: join(srcDir, "tsconfig.json"),
      contracts,
    });
  });

  it("flags the unguarded path to the provider, with a concrete call path (FR-C2, FR-H4)", () => {
    const finding = artifact.findings.find((f) => f.rule_id === "must-guard-shape");
    expect(finding).toBeDefined();
    expect(finding?.kind).toBe("unguarded_path_to_provider");
    expect(finding?.call_path).toEqual(["src/consumer.ts#run", "src/sink.ts#shape"]);
    expect(finding?.index_commit).toBe(artifact.build_commit);
  });

  it("resolves the consumer→provider hop through the aliased import (getAliasedSymbol)", () => {
    const edge = artifact.edges.find(
      (e) => e.from.endsWith("#run") && e.to.endsWith("#shape"),
    );
    expect(edge?.aliased).toBe(true);
  });

  it("adding the declared guard clears the violation (proves the guard is load-bearing)", () => {
    // Re-emit the consumer WITH the guard, rebuild, expect zero findings.
    const srcDir = join(tmp, "src");
    writeFileSync(
      join(srcDir, "consumer.ts"),
      `import { shape } from "./sink.js";\n` +
        `export function run(items: number[]): number {\n` +
        `  if (items.length === 0) return 0;\n` +
        `  return shape(items);\n` +
        `}\n`,
    );
    const contracts = loadContracts(srcDir);
    const guarded = buildGraph({
      repoRootAbs: tmp,
      targetRootAbs: srcDir,
      tsConfigPathAbs: join(srcDir, "tsconfig.json"),
      contracts,
    });
    expect(guarded.findings.filter((f) => f.rule_id === "must-guard-shape")).toHaveLength(0);
  });
});

// The write boundary: the artifact lands at .dioscuri/graph/ and the absolute-path
// guard is enforced before any bytes hit disk.
describe("artifact emission and the portability guard", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "dio9-emit-"));
  });

  // Minimal valid artifact with one symbol whose `file`/`id` we can poison per-case.
  const artifactWithSymbolFile = (file: string): GraphArtifact => ({
    schema_version: 1,
    build_commit: "unknown",
    build_dirty: false,
    target_root: "src",
    symbols: [{ id: `${file}#f`, name: "f", file, line: 1, exported: true }],
    edges: [],
    reach: {},
    contracts: [],
    findings: [],
  });

  it("rejects an artifact carrying a machine-specific absolute path (write-boundary guard)", () => {
    expect(() => assertNoAbsolutePaths(artifactWithSymbolFile("/Users/someone/x.ts"))).toThrow(
      /absolute path/,
    );
  });

  it("rejects an absolute path the old prefix denylist MISSED (/private/var/...) — structural guard", () => {
    // Defect-2 fix: the guard is now structural (path.isAbsolute), so it catches absolute
    // prefixes the old /Users//home/ denylist never covered. /private/var/... is a real
    // macOS temp prefix that would have slipped through before.
    expect(() =>
      assertNoAbsolutePaths(artifactWithSymbolFile("/private/var/folders/zz/x.ts")),
    ).toThrow(/absolute path/);
    // And /tmp/... (another previously-missed POSIX prefix).
    expect(() => assertNoAbsolutePaths(artifactWithSymbolFile("/tmp/x.ts"))).toThrow(
      /absolute path/,
    );
    // And a Windows drive path — caught regardless of the host OS this test runs on.
    expect(() => assertNoAbsolutePaths(artifactWithSymbolFile("C:/Users/x.ts"))).toThrow(
      /absolute path/,
    );
  });

  it("accepts a fully repo-relative artifact (no false positive on legitimate paths)", () => {
    expect(() =>
      assertNoAbsolutePaths(artifactWithSymbolFile("mcp/src/tools/search_memory.ts")),
    ).not.toThrow();
  });

  // A minimal artifact carrying ONE edge whose guards[] we poison per-case. The endpoints
  // and symbol are repo-relative; only the guard condition varies, so these cases isolate
  // the guard-literal scan from the symbol/endpoint scan.
  const artifactWithGuard = (guard: string): GraphArtifact => ({
    schema_version: 1,
    build_commit: "unknown",
    build_dirty: false,
    target_root: "src",
    symbols: [
      { id: "a.ts#f", name: "f", file: "a.ts", line: 1, exported: true },
      { id: "b.ts#g", name: "g", file: "b.ts", line: 1, exported: true },
    ],
    edges: [{ from: "a.ts#f", to: "b.ts#g", line: 2, aliased: false, guards: [guard] }],
    reach: {},
    contracts: [],
    findings: [],
  });

  it("rejects an absolute-path literal EMBEDDED in an edge guard condition (guard scan)", () => {
    // A guard captured verbatim from `if (cfg === "/Users/secret/config.json") return` —
    // the absolute path is embedded mid-expression. Whole-string scanning the guard text
    // would miss it (the expression starts with `cfg`, not `/`); the embedded literal is
    // extracted and scanned, so the build fails loud.
    expect(() =>
      assertNoAbsolutePaths(artifactWithGuard('cfg === "/Users/secret/config.json"')),
    ).toThrow(/absolute path/);
    // Independent of OS / prefix: a Windows-drive literal inside a guard is caught too.
    expect(() =>
      assertNoAbsolutePaths(artifactWithGuard('cfg === "C:/Users/secret/config.json"')),
    ).toThrow(/absolute path/);
  });

  it("does NOT false-positive on a guard embedding a RELATIVE path literal", () => {
    // Relative literals (the only kind the real mcp/src guards embed, e.g. ".md") are
    // legitimately repo-relative and must not fail the build.
    expect(() => assertNoAbsolutePaths(artifactWithGuard('!p.endsWith(".md")'))).not.toThrow();
    expect(() =>
      assertNoAbsolutePaths(artifactWithGuard('mod === "./sink.js"')),
    ).not.toThrow();
    // And a guard with no string literal at all is untouched.
    expect(() => assertNoAbsolutePaths(artifactWithGuard("unionIds.length === 0"))).not.toThrow();
  });

  it("writes the artifact to <target>/.dioscuri/graph/graph.json (FR-C1) repo-relative", () => {
    const srcDir = join(tmp, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "a.ts"), `export function f(): void {}\n`);
    writeFileSync(
      join(srcDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, include: ["**/*.ts"] }),
    );
    const art = buildGraph({
      repoRootAbs: tmp,
      targetRootAbs: srcDir,
      tsConfigPathAbs: join(srcDir, "tsconfig.json"),
      contracts: [],
    });
    const out = writeArtifact(srcDir, art);
    expect(out).toBe(artifactPath(srcDir));
    const onDisk = readFileSync(out, "utf8");
    expect(onDisk).not.toContain("/Users/");
    expect(onDisk).not.toContain(tmp); // the absolute temp path must not appear
    expect(onDisk).not.toContain("built_at"); // built_at is in the sidecar, not graph.json
    const parsed = JSON.parse(onDisk) as GraphArtifact;
    expect(parsed.target_root).toBe("src");

    // The per-build sidecar exists next to graph.json and carries built_at.
    const sidecar = JSON.parse(readFileSync(metaPath(srcDir), "utf8")) as GraphMeta;
    expect(typeof sidecar.built_at).toBe("string");
    expect(sidecar.built_at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601
    expect(sidecar.build_commit).toBe(art.build_commit);
  });

  it("two builds at the same commit produce a BYTE-IDENTICAL graph.json (built_at gone)", () => {
    // Defect-1 fix proof: graph.json is byte-deterministic now that the wall-clock
    // built_at has moved to the sidecar. Two independent writes of the same artifact
    // (the build is deterministic at a commit) yield identical bytes on disk.
    const srcDir = join(tmp, "src2");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "a.ts"), `export function f(): void { g(); }\nexport function g(): void {}\n`);
    writeFileSync(
      join(srcDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, include: ["**/*.ts"] }),
    );
    const build = () =>
      buildGraph({
        repoRootAbs: tmp,
        targetRootAbs: srcDir,
        tsConfigPathAbs: join(srcDir, "tsconfig.json"),
        contracts: [],
      });

    const out1 = writeArtifact(srcDir, build());
    const bytes1 = readFileSync(out1, "utf8");
    const out2 = writeArtifact(srcDir, build());
    const bytes2 = readFileSync(out2, "utf8");

    expect(bytes2).toBe(bytes1); // byte-for-byte identical graph.json
  });
});

// Eval-corpus isolation: a .dioscuri/graph/ path under a code repo is structurally
// outside the observations indexer's walk (it only walks ~/.claude-data), so the
// graph artifact can NEVER become an observations row. Asserted via the engine's own
// classify() with the artifact path as input.
describe("graph artifact never enters the observations corpus (AC-2, eval isolation)", () => {
  it("the indexer classify() returns null for a .dioscuri/graph/ path under a repo", async () => {
    const { classify, defaultConfig } = await import("../src/indexer.js");
    const cfg = defaultConfig();
    // A graph artifact path inside a code repo, NOT under the data root.
    const graphPath = join(REPO_ROOT, "mcp", "src", ".dioscuri", "graph", "graph.json");
    expect(classify(graphPath, cfg)).toBeNull();
  });
});
