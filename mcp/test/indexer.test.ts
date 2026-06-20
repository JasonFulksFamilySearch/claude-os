import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/embedder.js", async (importOriginal) => {
  // Import the real module so we get pure functions (composeEmbedText, serializeVector,
  // constants) without pulling in the heavyweight @huggingface/transformers pipeline.
  // We override only the async ML functions that would attempt to load a model.
  const actual = await importOriginal<typeof import("../src/embedder.js")>();
  return {
    ...actual,
    embedDocument: vi.fn().mockResolvedValue(new Float32Array(768).fill(0)),
    embedQuery: vi.fn().mockResolvedValue(new Float32Array(768).fill(0)),
  };
});
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { setLogPath } from "../src/logger.js";
import {
  classify,
  indexFile,
  fullReindex,
  countMissingVectors,
  vectorCoverageSweep,
  MAX_VECTOR_SWEEP,
  isWatchIgnored,
  removeFile,
  embedPathObservations,
  indexAndEmbed,
  type IndexerConfig,
} from "../src/indexer.js";
import { embedDocument, serializeVector, composeEmbedText } from "../src/embedder.js";

// Enable per-entry chunking by setting the meta flag the indexer reads at its
// single chokepoint. Default (no row) is '0' → flag off.
function enableChunking(): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES ('c2_chunking_enabled', '1') " +
      "ON CONFLICT(key) DO UPDATE SET value = '1'",
  ).run();
}

// A 2-entry learnings file: two dated entries → two anchors when chunking is on.
const TWO_ENTRY_LEARNINGS = [
  "# Learnings",
  "",
  "## 2026-01-01 — first",
  "",
  "body of the first entry",
  "",
  "## 2026-01-02 — second",
  "",
  "body of the second entry",
  "",
].join("\n");

let workDir: string;
let dataRoot: string;
let dbPath: string;
let db: Database.Database;
let config: IndexerConfig;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "claude-os-indexer-"));
  setLogPath(join(workDir, "test.log"));
  dataRoot = join(workDir, ".claude-data");
  dbPath = join(workDir, "test.db");
  mkdirSync(join(dataRoot, "agent"), { recursive: true });
  mkdirSync(join(dataRoot, "context"), { recursive: true });
  mkdirSync(join(dataRoot, "projects", "demo"), { recursive: true });
  mkdirSync(join(dataRoot, "archive"), { recursive: true });
  db = openDb(dbPath);
  config = { dataRoot, watchedProjects: [] };
});

afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("embedObservation freshness on content change", () => {
  const unit = (i: number): Float32Array => {
    const v = new Float32Array(768);
    v[i] = 1;
    return v;
  };
  const readVec = (id: number): Float32Array => {
    const row = db
      .prepare("SELECT embedding FROM vec_items WHERE observation_id = ?")
      .get(BigInt(id)) as { embedding: Buffer };
    return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
  };

  it("refreshes the stored vector when an already-indexed file's content changes", async () => {
    const file = join(dataRoot, "context", "jira.md");
    writeFileSync(file, "# jira\n\noriginal content about sprints\n", "utf8");
    vi.mocked(embedDocument).mockResolvedValue(unit(0)); // first embedding e0
    try {
      await fullReindex(db, config);
      const obs = db
        .prepare("SELECT id FROM observations WHERE source_path = ?")
        .get(file) as { id: number };
      expect(readVec(obs.id)[0]).toBe(1); // e0 stored on first index

      // Edit the body (content_hash changes) and re-index with a DIFFERENT embedding.
      writeFileSync(file, "# jira\n\ncompletely different content about tickets and triage\n", "utf8");
      vi.mocked(embedDocument).mockResolvedValue(unit(1)); // second embedding e1
      await fullReindex(db, config);

      // The stored vector must be the FRESH e1 — the bug left the stale e0 in place because
      // embedObservation early-returned on the existing vec_items row.
      const after = readVec(obs.id);
      expect(after[1]).toBe(1);
      expect(after[0]).toBe(0);
    } finally {
      vi.mocked(embedDocument).mockResolvedValue(new Float32Array(768).fill(0));
    }
  });
});

describe("classify", () => {
  it("classifies agent CLAUDE.md", () => {
    const p = join(dataRoot, "agent", "CLAUDE.md");
    expect(classify(p, config)).toEqual({
      source_type: "agent",
      topic: null,
      project: null,
    });
  });

  it("classifies agent learnings.md as learning", () => {
    const p = join(dataRoot, "agent", "learnings.md");
    expect(classify(p, config)).toEqual({
      source_type: "learning",
      topic: null,
      project: null,
    });
  });

  it("classifies context topic files", () => {
    const p = join(dataRoot, "context", "jira.md");
    expect(classify(p, config)).toEqual({
      source_type: "context",
      topic: "jira",
      project: null,
    });
  });

  it("excludes _index.md from context classification", () => {
    const p = join(dataRoot, "context", "_index.md");
    expect(classify(p, config)).toBeNull();
  });

  it("classifies project CLAUDE.md and learnings.md and decisions.md", () => {
    expect(classify(join(dataRoot, "projects", "demo", "CLAUDE.md"), config))
      .toEqual({ source_type: "project_claude_md", topic: null, project: "demo" });
    expect(classify(join(dataRoot, "projects", "demo", "learnings.md"), config))
      .toEqual({ source_type: "learning", topic: null, project: "demo" });
    expect(classify(join(dataRoot, "projects", "demo", "decisions.md"), config))
      .toEqual({ source_type: "decision", topic: null, project: "demo" });
  });

  it("classifies watched-project CLAUDE.md and README.md", () => {
    const projectPath = join(workDir, "external-project");
    mkdirSync(projectPath, { recursive: true });
    const localConfig: IndexerConfig = {
      ...config,
      watchedProjects: [{ slug: "ext", path: projectPath }],
    };
    expect(
      classify(join(projectPath, "CLAUDE.md"), localConfig),
    ).toEqual({ source_type: "project_claude_md", topic: null, project: "ext" });
    expect(
      classify(join(projectPath, "README.md"), localConfig),
    ).toEqual({ source_type: "project_readme", topic: null, project: "ext" });
  });

  it("rejects archive files (and the guard is selective)", () => {
    // Asserts the archive->null invariant and, via the positive control, that the
    // classifier is selective. Note: the classify() archive guard is redundant with
    // classify's terminal `return null` (no archive path matches a positive branch),
    // so this assertion does not uniquely falsify that guard line — it pins the
    // invariant against a future catch-all branch. The load-bearing, falsifiable
    // archive-exclusion guards are the isWatchIgnored test and the post-fullReindex
    // corpus assertion below.
    const archived = join(dataRoot, "archive", "old.md");
    expect(classify(archived, config)).toBeNull();
    // Positive control: a non-archive context file still classifies non-null,
    // proving the guard rejects archive specifically, not everything.
    const context = join(dataRoot, "context", "jira.md");
    expect(classify(context, config)).not.toBeNull();
  });

  it("rejects the DIO-15 TOIN signal sink (.logs/mcp-server.log) — never an observations row", () => {
    // The TOIN observability log (hooks/lib/toin-log.js → ~/.claude-data/.logs/mcp-server.log,
    // the same sink as mcp/src/logger.ts) lives under .logs/, OUTSIDE every walked dir. The real
    // classify() must return null for it, so a TOIN signal record can NEVER become an
    // `observations` row and never enters the retrieval eval surface (DIO-15 AC: sink provably
    // off the eval-gated surface). This is the falsifiable proof, run against the real classifier.
    const sink = join(dataRoot, ".logs", "mcp-server.log");
    expect(classify(sink, config)).toBeNull();
    // A nested path under .logs/ is equally un-indexable (the whole dir is off-corpus).
    expect(classify(join(dataRoot, ".logs", "sub", "mcp-server.log"), config)).toBeNull();
    // Positive control: a sibling context file still classifies non-null — the rejection is
    // specific to the off-corpus location, not a blanket null.
    expect(classify(join(dataRoot, "context", "jira.md"), config)).not.toBeNull();
  });

  it("classifies episode files", () => {
    const p = join(dataRoot, "episodes", "2026-05-14-abc.md");
    expect(classify(p, config)).toEqual({
      source_type: "episode",
      topic: null,
      project: null,
    });
  });

  it("returns null for non-.md files in episodes dir", () => {
    const p = join(dataRoot, "episodes", "2026-05-14-abc.txt");
    expect(classify(p, config)).toBeNull();
  });

  it("classify returns project: null for episode even when file has project frontmatter (project extracted in indexFile, not classify)", () => {
    const p = join(dataRoot, "episodes", "2026-05-14-hasproject.md");
    expect(classify(p, config)).toEqual({
      source_type: "episode",
      topic: null,
      project: null,
    });
  });
});

describe("isWatchIgnored — watcher archive/legacy/episode predicate", () => {
  it("ignores files under archive/", () => {
    expect(isWatchIgnored(join(dataRoot, "archive", "old.md"), config)).toBe(true);
  });
  it("does NOT ignore a legitimately-watched context file (selective)", () => {
    expect(isWatchIgnored(join(dataRoot, "context", "jira.md"), config)).toBe(false);
  });
  it("ignores _legacy-prefixed basenames", () => {
    expect(isWatchIgnored(join(dataRoot, "agent", "_legacy.md"), config)).toBe(true);
  });
  it("ignores underscore-prefixed files in episodes/", () => {
    expect(isWatchIgnored(join(dataRoot, "episodes", "_scratch.md"), config)).toBe(true);
  });
  it("does NOT ignore a normal episode file", () => {
    expect(isWatchIgnored(join(dataRoot, "episodes", "2026-05-14-abc.md"), config)).toBe(false);
  });
});

describe("indexFile", () => {
  it("upserts a context file and is a no-op when content unchanged", () => {
    const p = join(dataRoot, "context", "java.md");
    writeFileSync(p, "# Java\n\nUse mvn clean test.\n", "utf8");
    const r1 = indexFile(db, p, config);
    expect(r1.status).toBe("indexed");
    const r2 = indexFile(db, p, config);
    expect(r2.status).toBe("skipped_unchanged");

    const count = db
      .prepare("SELECT COUNT(*) as c FROM observations WHERE source_path = ?")
      .get(p) as { c: number };
    expect(count.c).toBe(1);
  });

  it("updates the row when content changes", () => {
    const p = join(dataRoot, "context", "github.md");
    writeFileSync(p, "# GitHub\n\nVersion A\n", "utf8");
    indexFile(db, p, config);

    writeFileSync(p, "# GitHub\n\nVersion B with extra text\n", "utf8");
    const r = indexFile(db, p, config);
    expect(r.status).toBe("indexed");

    const row = db
      .prepare("SELECT content FROM observations WHERE source_path = ?")
      .get(p) as { content: string };
    expect(row.content).toContain("Version B");
  });

  it("skips files larger than 1MB", () => {
    const p = join(dataRoot, "context", "huge.md");
    const big = "x".repeat(1024 * 1024 + 100);
    writeFileSync(p, `# Huge\n\n${big}`, "utf8");
    const r = indexFile(db, p, config);
    expect(r.status).toBe("skipped_too_large");
  });

  it("skips files under archive/", () => {
    const p = join(dataRoot, "archive", "old.md");
    writeFileSync(p, "# Old\n\nstale content\n", "utf8");
    const r = indexFile(db, p, config);
    expect(r.status).toBe("skipped_unclassified");
  });
});

describe("indexFile — episode", () => {
  it("indexes an episode file and extracts project from frontmatter", () => {
    mkdirSync(join(dataRoot, "episodes"), { recursive: true });
    const p = join(dataRoot, "episodes", "2026-05-14-abc123.md");
    writeFileSync(p, [
      "---",
      "date: 2026-05-14",
      "session_id: abc123",
      "project: arc",
      "turns: 12",
      "promoted: false",
      "---",
      "",
      "## Summary",
      "Fixed a stall detection bug.",
      "",
      "## Decisions",
      "- Used sliding window over fixed interval.",
      "",
    ].join("\n"), "utf8");

    const r = indexFile(db, p, config);
    expect(r.status).toBe("indexed");

    const row = db.prepare(
      "SELECT source_type, project FROM observations WHERE source_path = ?"
    ).get(p) as { source_type: string; project: string } | undefined;
    expect(row?.source_type).toBe("episode");
    expect(row?.project).toBe("arc");
  });

  it("indexes episode with null project when frontmatter project is absent", () => {
    mkdirSync(join(dataRoot, "episodes"), { recursive: true });
    const p = join(dataRoot, "episodes", "2026-05-14-noproj.md");
    writeFileSync(p, [
      "---",
      "date: 2026-05-14",
      "promoted: false",
      "---",
      "",
      "## Summary",
      "General session with no project context.",
      "",
    ].join("\n"), "utf8");

    const r = indexFile(db, p, config);
    expect(r.status).toBe("indexed");

    const row = db.prepare(
      "SELECT project FROM observations WHERE source_path = ?"
    ).get(p) as { project: string | null } | undefined;
    expect(row?.project).toBeNull();
  });

  it("indexes episode with empty-string project as null", () => {
    mkdirSync(join(dataRoot, "episodes"), { recursive: true });
    const p = join(dataRoot, "episodes", "2026-05-14-emptyproj.md");
    writeFileSync(p, [
      "---",
      "date: 2026-05-14",
      "project: ",
      "promoted: false",
      "---",
      "",
      "## Summary",
      "Empty project test.",
      "",
    ].join("\n"), "utf8");

    const r = indexFile(db, p, config);
    const row = db.prepare(
      "SELECT project FROM observations WHERE source_path = ?"
    ).get(p) as { project: string | null } | undefined;
    expect(row?.project).toBeNull();
  });
});

describe("fullReindex — episodes", () => {
  it("indexes episode files during full reindex and includes them in indexed count", async () => {
    mkdirSync(join(dataRoot, "episodes"), { recursive: true });
    const p = join(dataRoot, "episodes", "2026-05-14-reindex.md");
    writeFileSync(p, [
      "---",
      "date: 2026-05-14",
      "session_id: reindex001",
      "project: arc",
      "turns: 8",
      "promoted: false",
      "---",
      "",
      "## Summary",
      "Reindex test session.",
      "",
    ].join("\n"), "utf8");

    const summary = await fullReindex(db, config);

    const row = db.prepare(
      "SELECT source_type, project FROM observations WHERE source_path = ?"
    ).get(p) as { source_type: string; project: string } | undefined;
    expect(row?.source_type).toBe("episode");
    expect(row?.project).toBe("arc");
    expect(summary.indexed).toBeGreaterThanOrEqual(1);
  });

  it("fullReindex skips files whose basename starts with underscore (e.g. _legacy.md)", async () => {
    // walk() in indexer.ts already filters to .md only, so _index.json is
    // skipped for free. This test exercises the explicit underscore-prefix
    // skip — the only reachable case is a .md file that begins with _.
    mkdirSync(join(dataRoot, "episodes"), { recursive: true });
    const legacyPath = join(dataRoot, "episodes", "_legacy.md");
    writeFileSync(legacyPath, [
      "---",
      "date: 2026-05-14",
      "session_id: legacy",
      "promoted: false",
      "---",
      "",
      "## Summary",
      "Legacy file that must be skipped by the _* filter.",
      "",
    ].join("\n"), "utf8");

    await fullReindex(db, config);

    const row = db.prepare(
      "SELECT * FROM observations WHERE source_path = ?"
    ).get(legacyPath);
    expect(row).toBeUndefined();
  });
});

describe("fullReindex", () => {
  it("indexes all expected files in the data root", async () => {
    writeFileSync(
      join(dataRoot, "agent", "CLAUDE.md"),
      "# Agent\n\nidentity\n",
      "utf8",
    );
    writeFileSync(
      join(dataRoot, "agent", "learnings.md"),
      "# Learnings\n\n## 2026-01-01 — first\n\nbody\n",
      "utf8",
    );
    writeFileSync(
      join(dataRoot, "context", "jira.md"),
      "# jira\n\nticket talk\n",
      "utf8",
    );
    writeFileSync(
      join(dataRoot, "context", "_index.md"),
      "# index\n",
      "utf8",
    );
    writeFileSync(
      join(dataRoot, "projects", "demo", "CLAUDE.md"),
      "# demo\n\nproject rules\n",
      "utf8",
    );
    writeFileSync(
      join(dataRoot, "archive", "old.md"),
      "# old\n\nignored\n",
      "utf8",
    );

    const summary = await fullReindex(db, config);
    expect(summary.indexed).toBe(4);

    const rows = db.prepare("SELECT source_path FROM observations").all() as {
      source_path: string;
    }[];
    const paths = rows.map((r) => r.source_path);
    expect(paths).toContain(join(dataRoot, "agent", "CLAUDE.md"));
    expect(paths).toContain(join(dataRoot, "agent", "learnings.md"));
    expect(paths).toContain(join(dataRoot, "context", "jira.md"));
    expect(paths).toContain(join(dataRoot, "projects", "demo", "CLAUDE.md"));
    expect(paths).not.toContain(join(dataRoot, "context", "_index.md"));
    // C1 archive-exclusion invariant (Stage 1): archived files never enter the
    // corpus. Control-backed — the toContain assertions above prove this is not
    // vacuously satisfied by an empty result set.
    expect(paths).not.toContain(join(dataRoot, "archive", "old.md"));
  });
});

describe("fullReindex — vector index", () => {
  it("populates vec_items for indexed observations", async () => {
    writeFileSync(
      join(dataRoot, "context", "vec.md"),
      "# Vec\n\nembed me into the vector store\n",
      "utf8",
    );

    await fullReindex(db, config);

    const obs = db
      .prepare("SELECT id FROM observations WHERE source_path = ?")
      .get(join(dataRoot, "context", "vec.md")) as { id: number } | undefined;
    expect(obs).toBeDefined();

    const vec = db
      .prepare("SELECT count(*) AS c FROM vec_items WHERE observation_id = ?")
      .get(BigInt(obs!.id)) as { c: number };
    expect(vec.c).toBe(1);
  });
});

describe("vectorCoverageSweep", () => {
  // Insert an observation row directly (bypassing indexFile) so we control vector presence.
  let seq = 0;
  function insertObs(content: string): number {
    seq++;
    const now = Math.floor(Date.now() / 1000);
    const r = db
      .prepare(
        `INSERT INTO observations
          (source_type, source_path, project, topic, title, content, content_hash, file_mtime, indexed_at, frontmatter)
         VALUES ('context', @sp, NULL, 't', 'T', @c, @h, @m, @m, NULL)`,
      )
      .run({ sp: `/tmp/sweep-o${seq}.md`, c: content, h: `h${seq}`, m: now });
    return Number(r.lastInsertRowid);
  }
  // vec0 PK must bind as BigInt (better-sqlite3 sends numbers as FLOAT).
  function seedVec(id: number): void {
    db.prepare("INSERT INTO vec_items(observation_id, embedding) VALUES (?, ?)").run(
      BigInt(id),
      serializeVector(new Float32Array(768).fill(0.1)),
    );
  }

  it("countMissingVectors counts observations with no vec_items row", () => {
    const a = insertObs("alpha");
    const b = insertObs("beta");
    insertObs("gamma"); // orphan
    seedVec(a);
    seedVec(b);

    expect(countMissingVectors(db)).toBe(1);
  });

  it("re-embeds all orphans when under the cap and reports counts", async () => {
    const ids = [insertObs("a"), insertObs("b"), insertObs("c")];
    seedVec(ids[0]); // one already covered; two orphaned

    const result = await vectorCoverageSweep(db);

    expect(result.before).toBe(2);
    expect(result.healed).toBe(2);
    expect(result.after).toBe(0);
    expect(countMissingVectors(db)).toBe(0);
  });

  it("honors the per-sweep cap — heals up to the cap, leaves the rest reported", async () => {
    // Cap+1 orphans → cap healed, 1 remains.
    for (let i = 0; i < MAX_VECTOR_SWEEP + 1; i++) insertObs(`o${i}`);

    const result = await vectorCoverageSweep(db);

    expect(result.before).toBe(MAX_VECTOR_SWEEP + 1);
    expect(result.healed).toBe(MAX_VECTOR_SWEEP);
    expect(result.after).toBe(1);
  });

  it("is a no-op at full coverage (idempotent)", async () => {
    const id = insertObs("a");
    seedVec(id);

    const first = await vectorCoverageSweep(db);
    expect(first.before).toBe(0);
    expect(first.healed).toBe(0);

    const second = await vectorCoverageSweep(db);
    expect(second.before).toBe(0);
    expect(second.after).toBe(0);
  });

  it("does not hot-loop a permanently-failing row — counts it as still-missing", async () => {
    insertObs("poison");
    // embedObservation swallows the throw (catch-log-drop), so the row stays orphaned.
    vi.mocked(embedDocument).mockRejectedValueOnce(new Error("embed boom"));

    const result = await vectorCoverageSweep(db);

    expect(result.before).toBe(1);
    expect(result.healed).toBe(0); // attempted once, still missing
    expect(result.after).toBe(1);
    expect(countMissingVectors(db)).toBe(1);
  });

  it("fullReindex heals a pre-existing orphan and reports coverage", async () => {
    // Index a file so it has an observation + vector, then delete its vector to simulate
    // a past terminal embed failure (an orphan no change-driven pass would ever repair).
    const file = join(dataRoot, "context", "github.md");
    writeFileSync(file, "# github\n\ngh cli command patterns\n", "utf8");
    await fullReindex(db, config);
    const obs = db
      .prepare("SELECT id FROM observations WHERE source_path = ?")
      .get(file) as { id: number };
    db.prepare("DELETE FROM vec_items WHERE observation_id = ?").run(
      BigInt(obs.id),
    );
    expect(countMissingVectors(db)).toBe(1);

    // A reindex with NO content change must still heal the orphan via the coverage sweep.
    const summary = await fullReindex(db, config);

    expect(summary.vecMissingBefore).toBe(1);
    expect(summary.vecMissingAfter).toBe(0);
    expect(countMissingVectors(db)).toBe(0);
  });

  it("embeds a chunk-row orphan with the same enriched text as the production path", async () => {
    // A chunk row (anchor != "") with a section + parent title. The sweep must embed the SAME
    // title-enriched text embedPathObservations produces — not raw content — so a healed orphan's
    // vector matches the live index. The other sweep tests insert whole-file rows (anchor=""),
    // where composed == raw, so only this case exercises (and guards) the enrichment.
    const now = Math.floor(Date.now() / 1000);
    const content = "body of the dated entry";
    db.prepare(
      `INSERT INTO observations
        (source_type, source_path, anchor, parent_title, project, topic, title,
         content, content_hash, file_mtime, indexed_at, frontmatter)
       VALUES ('learning', '/tmp/sweep-chunk.md', '2026-01-01', 'Learnings', NULL, NULL,
         '2026-01-01 — first', @c, 'hchunk', @m, @m, NULL)`,
    ).run({ c: content, m: now });

    vi.mocked(embedDocument).mockClear();
    vi.mocked(embedDocument).mockResolvedValue(new Float32Array(768).fill(0));

    const result = await vectorCoverageSweep(db);
    expect(result.healed).toBe(1);

    const calls = vi.mocked(embedDocument).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(composeEmbedText("Learnings", "2026-01-01 — first", content));
    // Direct regression guard: a revert to embedding raw content would make these equal.
    expect(calls[0][0]).not.toBe(content);
  });

  it("reports vecMissingAfter from the post-removal state, not the pre-removal sweep count", async () => {
    // Index a file so it has an observation + vector.
    vi.mocked(embedDocument).mockResolvedValue(new Float32Array(768).fill(0));
    const file = join(dataRoot, "context", "doomed.md");
    writeFileSync(file, "# doomed\n\nthis file is about to be deleted\n", "utf8");
    await fullReindex(db, config);
    const obs = db
      .prepare("SELECT id FROM observations WHERE source_path = ?")
      .get(file) as { id: number };

    // Orphan it AND make re-embedding fail (sweep can't heal it), then delete the file so the
    // removal pass prunes the orphan row within the same reindex.
    db.prepare("DELETE FROM vec_items WHERE observation_id = ?").run(BigInt(obs.id));
    expect(countMissingVectors(db)).toBe(1);
    vi.mocked(embedDocument).mockRejectedValueOnce(new Error("poison"));
    rmSync(file);

    const summary = await fullReindex(db, config);

    // The un-healable orphan was removed (its file is gone), so the FINAL state has zero holes.
    // vecMissingAfter must reflect that — coverage.after (measured before removal) reports 1.
    expect(summary.vecMissingBefore).toBe(1);
    expect(summary.vecMissingAfter).toBe(0);
    expect(summary.removed).toBeGreaterThanOrEqual(1);
    expect(countMissingVectors(db)).toBe(0);
  });
});

describe("indexFile — per-(path,anchor) reconcile (C2)", () => {
  it("flag off → editing a 2-entry learnings file keeps exactly one anchor='' row", () => {
    // Default: no c2_chunking_enabled meta row → flag off → whole-file chunk.
    const p = join(dataRoot, "agent", "learnings.md");
    writeFileSync(p, TWO_ENTRY_LEARNINGS, "utf8");
    expect(indexFile(db, p, config).status).toBe("indexed");

    // Edit the file (content changes) and re-index — still one whole-file row.
    writeFileSync(p, TWO_ENTRY_LEARNINGS + "\nappended line\n", "utf8");
    expect(indexFile(db, p, config).status).toBe("indexed");

    const rows = db
      .prepare("SELECT anchor FROM observations WHERE source_path = ?")
      .all(p) as { anchor: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].anchor).toBe("");
  });

  it("flag on → a 2-entry learnings file produces 2 anchored rows", () => {
    enableChunking();
    const p = join(dataRoot, "agent", "learnings.md");
    writeFileSync(p, TWO_ENTRY_LEARNINGS, "utf8");
    expect(indexFile(db, p, config).status).toBe("indexed");

    const anchors = (
      db
        .prepare("SELECT anchor FROM observations WHERE source_path = ? ORDER BY anchor")
        .all(p) as { anchor: string }[]
    ).map((r) => r.anchor);
    expect(anchors).toEqual(["2026-01-01", "2026-01-02"]);
  });

  it("reports only the changed anchor on a single-entry edit (US13)", () => {
    enableChunking();
    const p = join(dataRoot, "agent", "learnings.md");
    writeFileSync(p, TWO_ENTRY_LEARNINGS, "utf8");
    indexFile(db, p, config);

    // Edit ONLY the second entry's body; the first is byte-identical (hash-skip).
    const edited = TWO_ENTRY_LEARNINGS.replace(
      "body of the second entry",
      "EDITED body of the second entry",
    );
    writeFileSync(p, edited, "utf8");
    const r = indexFile(db, p, config);
    expect(r.changedAnchors).toEqual(["2026-01-02"]);
  });

  it("deleting an entry removes its anchor row and its vec_items", async () => {
    enableChunking();
    const p = join(dataRoot, "agent", "learnings.md");
    writeFileSync(p, TWO_ENTRY_LEARNINGS, "utf8");
    await indexAndEmbed(db, p, config);

    // Capture the id of the second entry's row before removal.
    const second = db
      .prepare("SELECT id FROM observations WHERE source_path = ? AND anchor = ?")
      .get(p, "2026-01-02") as { id: number };
    expect(second).toBeDefined();

    // Drop the second entry from the file.
    const oneEntry = [
      "# Learnings",
      "",
      "## 2026-01-01 — first",
      "",
      "body of the first entry",
      "",
    ].join("\n");
    writeFileSync(p, oneEntry, "utf8");
    indexFile(db, p, config);

    const remaining = (
      db
        .prepare("SELECT anchor FROM observations WHERE source_path = ?")
        .all(p) as { anchor: string }[]
    ).map((r) => r.anchor);
    expect(remaining).toEqual(["2026-01-01"]);

    const vec = db
      .prepare("SELECT COUNT(*) c FROM vec_items WHERE observation_id = ?")
      .get(BigInt(second.id)) as { c: number };
    expect(vec.c).toBe(0);
  });
});

describe("embed unification — both production paths (C2)", () => {
  it("watcher path (indexAndEmbed) embeds ALL N chunks on first index", async () => {
    enableChunking();
    const p = join(dataRoot, "agent", "learnings.md");
    writeFileSync(p, TWO_ENTRY_LEARNINGS, "utf8");

    await indexAndEmbed(db, p, config);

    const vecCount = (
      db
        .prepare(
          "SELECT COUNT(*) c FROM vec_items v JOIN observations o ON o.id = v.observation_id WHERE o.source_path = ?",
        )
        .get(p) as { c: number }
    ).c;
    // Both chunks embedded — would be 1 with the old single-row .get() read.
    expect(vecCount).toBe(2);
  });

  it("watcher path re-embeds ONLY the changed chunk on edit (US13)", async () => {
    enableChunking();
    const p = join(dataRoot, "agent", "learnings.md");
    writeFileSync(p, TWO_ENTRY_LEARNINGS, "utf8");
    await indexAndEmbed(db, p, config);

    const secondId = (
      db
        .prepare("SELECT id FROM observations WHERE source_path = ? AND anchor = ?")
        .get(p, "2026-01-02") as { id: number }
    ).id;

    vi.mocked(embedDocument).mockClear();
    const edited = TWO_ENTRY_LEARNINGS.replace(
      "body of the second entry",
      "EDITED body of the second entry",
    );
    writeFileSync(p, edited, "utf8");
    await indexAndEmbed(db, p, config);

    // Only the changed anchor's row is re-embedded.
    expect(embedDocument).toHaveBeenCalledTimes(1);
    // And its vec_items row still exists for the changed chunk.
    const vec = db
      .prepare("SELECT COUNT(*) c FROM vec_items WHERE observation_id = ?")
      .get(BigInt(secondId)) as { c: number };
    expect(vec.c).toBe(1);
  });

  it("indexAndEmbed does not embed when the file is unchanged", async () => {
    enableChunking();
    const p = join(dataRoot, "agent", "learnings.md");
    writeFileSync(p, TWO_ENTRY_LEARNINGS, "utf8");
    await indexAndEmbed(db, p, config);

    vi.mocked(embedDocument).mockClear();
    const r = await indexAndEmbed(db, p, config);
    expect(r.status).toBe("skipped_unchanged");
    expect(embedDocument).not.toHaveBeenCalled();
  });
});

describe("removeFile — all chunks (C2)", () => {
  it("deletes ALL chunks for a path and their vec_items", async () => {
    enableChunking();
    const p = join(dataRoot, "agent", "learnings.md");
    writeFileSync(p, TWO_ENTRY_LEARNINGS, "utf8");
    await indexAndEmbed(db, p, config);

    const ids = (
      db.prepare("SELECT id FROM observations WHERE source_path = ?").all(p) as {
        id: number;
      }[]
    ).map((r) => r.id);
    expect(ids).toHaveLength(2);

    removeFile(db, p);

    const obsCount = (
      db
        .prepare("SELECT COUNT(*) c FROM observations WHERE source_path = ?")
        .get(p) as { c: number }
    ).c;
    expect(obsCount).toBe(0);

    for (const id of ids) {
      const vec = db
        .prepare("SELECT COUNT(*) c FROM vec_items WHERE observation_id = ?")
        .get(BigInt(id)) as { c: number };
      expect(vec.c).toBe(0);
    }
  });
});

describe("embedPathObservations — composeEmbedText applied per row (C2/T8)", () => {
  it("whole-file row (anchor='') embeds raw content unchanged (flag-off byte-identical)", async () => {
    // flag OFF → single whole-file chunk with anchor=""
    // The chunk's content is the full parsed body (including the H1 line) as stored by indexFile.
    const fileBody = "# jira\n\nbody text\n";
    const p = join(dataRoot, "context", "jira.md");
    writeFileSync(p, fileBody, "utf8");
    vi.mocked(embedDocument).mockClear();
    await indexAndEmbed(db, p, config);

    // The arg passed to embedDocument must be the raw content column — no context prefix.
    expect(embedDocument).toHaveBeenCalledTimes(1);
    const embeddedText = vi.mocked(embedDocument).mock.calls[0][0];
    // Whole-file rows: content is passed through unchanged (composeEmbedText with null sectionTitle).
    // Confirm it does NOT have a " > " prefix (which would indicate erroneous enrichment).
    expect(embeddedText).not.toContain(" > ");
    // And confirm the body text is present — this is what was stored in the observation.
    expect(embeddedText).toContain("body text");
  });

  it("chunked row (anchor != '') embeds enriched text with title context", async () => {
    enableChunking();
    const p = join(dataRoot, "agent", "learnings.md");
    writeFileSync(p, TWO_ENTRY_LEARNINGS, "utf8");
    vi.mocked(embedDocument).mockClear();
    await indexAndEmbed(db, p, config);

    // Two chunks embedded — each with title context prefix.
    expect(embedDocument).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(embedDocument).mock.calls.map((c) => c[0]);
    // Both calls should contain a " > " separator (parent > section prefix).
    for (const text of calls) {
      expect(text).toContain(" > ");
    }
    // Verify at least one call contains the parent title "Learnings" and section heading.
    expect(calls.some((t) => t.startsWith("Learnings > "))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 3: chunk title fallback to anchor (not basename) for chunk rows
// ---------------------------------------------------------------------------

describe("indexFile — Fix 3: chunk title falls back to anchor (not basename) for chunk rows", () => {
  it("date-only-heading entry: title stored in DB equals the anchor (not the file basename)", () => {
    // A learnings file with a date-only heading: parseEntries returns entry.title = null.
    // The indexer must fall back to the anchor string, not the file basename.
    enableChunking();
    const p = join(dataRoot, "agent", "learnings.md");
    const dateOnlyContent = [
      "# Agent Learnings",
      "",
      "## 2026-05-01",
      "",
      "Some learning body text here.",
      "",
    ].join("\n");
    writeFileSync(p, dateOnlyContent, "utf8");
    indexFile(db, p, config);

    const row = db
      .prepare("SELECT title, anchor FROM observations WHERE source_path = ? AND anchor != ''")
      .get(p) as { title: string; anchor: string } | undefined;
    expect(row).toBeDefined();
    // title must be the anchor ("2026-05-01"), not the basename ("learnings")
    expect(row!.title).toBe(row!.anchor);
    expect(row!.title).toBe("2026-05-01");
    expect(row!.title).not.toBe("learnings");
  });

  it("whole-file row (anchor='') still falls back to basename when title is null", () => {
    // Flag OFF → single whole-file row. A file with no H1 → chunk.title = null.
    // The fallback must remain the basename (flag-off parity).
    const p = join(dataRoot, "context", "no-h1-context.md");
    const noH1Content = "This file has no H1 heading.\n\nJust some body text.\n";
    writeFileSync(p, noH1Content, "utf8");
    indexFile(db, p, config); // chunking is OFF by default

    const row = db
      .prepare("SELECT title, anchor FROM observations WHERE source_path = ?")
      .get(p) as { title: string; anchor: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.anchor).toBe(""); // whole-file row
    // Basename without extension is "no-h1-context"
    expect(row!.title).toBe("no-h1-context");
  });

  it("chunk rows with non-null title keep their real title (not overwritten by anchor)", () => {
    // A normal learnings file where entries have titles.
    enableChunking();
    const p = join(dataRoot, "agent", "learnings.md");
    writeFileSync(p, TWO_ENTRY_LEARNINGS, "utf8");
    indexFile(db, p, config);

    const rows = db
      .prepare("SELECT title, anchor FROM observations WHERE source_path = ? AND anchor != '' ORDER BY anchor")
      .all(p) as { title: string; anchor: string }[];
    expect(rows).toHaveLength(2);
    // "## 2026-01-01 — first" → title = "first", anchor = "2026-01-01"
    expect(rows[0].title).toBe("first");
    expect(rows[0].anchor).toBe("2026-01-01");
    // "## 2026-01-02 — second" → title = "second", anchor = "2026-01-02"
    expect(rows[1].title).toBe("second");
    expect(rows[1].anchor).toBe("2026-01-02");
  });
});

describe("fullReindex — per-file error isolation", () => {
  it("isolates a malformed file: completes over good files, reports the bad one", async () => {
    writeFileSync(join(dataRoot, "context", "good.md"), "# Good\n\nsome content\n", "utf8");
    writeFileSync(join(dataRoot, "projects", "demo", "learnings.md"), TWO_ENTRY_LEARNINGS, "utf8");
    // Unterminated double-quoted scalar → gray-matter (js-yaml) throws a YAMLException.
    const badPath = join(dataRoot, "context", "bad.md");
    writeFileSync(badPath, '---\ntitle: "unterminated alpha\n---\n# Bad alpha\n', "utf8");

    const summary = await fullReindex(db, config);

    expect(summary.errored).toBe(1);
    expect(summary.erroredPaths).toContain(badPath);
    expect(summary.indexed).toBeGreaterThanOrEqual(2);
    const bad = db
      .prepare("SELECT COUNT(*) AS n FROM observations WHERE source_path = ?")
      .get(badPath) as { n: number };
    expect(bad.n).toBe(0);
  });

  it("malformed-file isolation holds with the chunking flag ON (the cutover path)", async () => {
    enableChunking();
    writeFileSync(join(dataRoot, "agent", "learnings.md"), TWO_ENTRY_LEARNINGS, "utf8");
    const badPath = join(dataRoot, "context", "bad.md");
    writeFileSync(badPath, '---\ntitle: "unterminated bravo\n---\n# Bad bravo\n', "utf8");

    const summary = await fullReindex(db, config);

    expect(summary.errored).toBe(1);
    expect(summary.erroredPaths).toContain(badPath);
    expect(summary.indexed).toBeGreaterThanOrEqual(1);
  });

  it("a clean corpus reports zero errors", async () => {
    writeFileSync(join(dataRoot, "context", "good.md"), "# Good\n\nsome content\n", "utf8");
    writeFileSync(join(dataRoot, "agent", "learnings.md"), TWO_ENTRY_LEARNINGS, "utf8");

    const summary = await fullReindex(db, config);

    expect(summary.errored).toBe(0);
    expect(summary.erroredPaths).toEqual([]);
  });

  it("counts error-skips and benign skips in separate buckets", async () => {
    writeFileSync(join(dataRoot, "context", "good.md"), "# Good\n\nsome content\n", "utf8");
    // Oversized file → skipped_too_large → counted in `skipped`, NOT `errored`.
    writeFileSync(join(dataRoot, "context", "big.md"), "x".repeat(1024 * 1024 + 100), "utf8");
    const badPath = join(dataRoot, "context", "bad.md");
    writeFileSync(badPath, '---\ntitle: "unterminated charlie\n---\n# Bad charlie\n', "utf8");

    const summary = await fullReindex(db, config);

    expect(summary.errored).toBe(1);
    expect(summary.erroredPaths).toContain(badPath);
    expect(summary.skipped).toBe(1);
  });
});

describe("fullReindex — reconciles stale (path, anchor) pairs (C2)", () => {
  it("removes a (path, anchor) row + vec when its entry is dropped from the file", async () => {
    enableChunking();
    const p = join(dataRoot, "agent", "learnings.md");
    writeFileSync(p, TWO_ENTRY_LEARNINGS, "utf8");
    await fullReindex(db, config);

    const second = db
      .prepare("SELECT id FROM observations WHERE source_path = ? AND anchor = ?")
      .get(p, "2026-01-02") as { id: number };
    expect(second).toBeDefined();

    // Drop the second entry, then run a full reindex.
    const oneEntry = [
      "# Learnings",
      "",
      "## 2026-01-01 — first",
      "",
      "body of the first entry",
      "",
    ].join("\n");
    writeFileSync(p, oneEntry, "utf8");
    await fullReindex(db, config);

    const anchors = (
      db
        .prepare("SELECT anchor FROM observations WHERE source_path = ?")
        .all(p) as { anchor: string }[]
    ).map((r) => r.anchor);
    expect(anchors).toEqual(["2026-01-01"]);

    const vec = db
      .prepare("SELECT COUNT(*) c FROM vec_items WHERE observation_id = ?")
      .get(BigInt(second.id)) as { c: number };
    expect(vec.c).toBe(0);
  });
});
