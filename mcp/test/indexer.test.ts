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
  isWatchIgnored,
  removeFile,
  embedPathObservations,
  indexAndEmbed,
  type IndexerConfig,
} from "../src/indexer.js";
import { embedDocument } from "../src/embedder.js";

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
