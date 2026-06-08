import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/embedder.js", () => ({
  embedDocument: vi.fn().mockResolvedValue(new Float32Array(768).fill(0)),
  embedQuery: vi.fn().mockResolvedValue(new Float32Array(768).fill(0)),
  serializeVector: (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength),
  EMBEDDING_DIM: 768,
  MODEL_ID: "nomic-ai/nomic-embed-text-v1.5",
}));
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { setLogPath } from "../src/logger.js";
import { fullReindex, type IndexerConfig } from "../src/indexer.js";
import { searchMemory } from "../src/tools/search_memory.js";
import { getTopic } from "../src/tools/get_topic.js";
import { appendLearning } from "../src/tools/append_learning.js";
import { listTopics } from "../src/tools/list_topics.js";
import { getRecentLearnings } from "../src/tools/get_recent_learnings.js";
import { listEpisodesImpl } from "../src/tools/list_episodes.js";
import { markEpisodePromotedImpl } from "../src/tools/mark_episode_promoted.js";
import { scanNovelty } from "../src/tools/scan_novelty.js";
import { resolveNoveltyFlag } from "../src/tools/resolve_novelty_flag.js";
import { scanExperience } from "../src/tools/scan_experience.js";
import { validateExperienceProposal } from "../src/tools/validate_experience_proposal.js";
import { embedDocument, serializeVector } from "../src/embedder.js";

let workDir: string;
let dataRoot: string;
let dbPath: string;
let db: Database.Database;
let config: IndexerConfig;
let contextDir: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "claude-os-tools-"));
  setLogPath(join(workDir, "test.log"));
  dataRoot = join(workDir, ".claude-data");
  dbPath = join(workDir, "test.db");
  mkdirSync(join(dataRoot, "agent"), { recursive: true });
  mkdirSync(join(dataRoot, "context"), { recursive: true });
  mkdirSync(join(dataRoot, "projects", "demo"), { recursive: true });
  mkdirSync(join(dataRoot, "archive"), { recursive: true });
  contextDir = join(dataRoot, "context");

  writeFileSync(
    join(contextDir, "_index.md"),
    [
      "# Context Index",
      "",
      "## Topics",
      "",
      "- **java** — keywords: java, maven, mvn, checkstyle — file: java.md",
      "- **jira** — keywords: jira, ticket, sprint — file: jira.md",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(contextDir, "java.md"),
    "# java\n\nKeywords: java, maven\n\nRun mvn clean test before committing. checkstyle violations matter.\n",
    "utf8",
  );
  writeFileSync(
    join(contextDir, "jira.md"),
    "# jira\n\nKeywords: jira, sprint\n\nUse jira CLI for tickets. Sprint planning happens weekly.\n",
    "utf8",
  );
  writeFileSync(
    join(dataRoot, "agent", "CLAUDE.md"),
    "# Agent\n\nidentity content\n",
    "utf8",
  );
  writeFileSync(
    join(dataRoot, "agent", "learnings.md"),
    [
      "# Learnings",
      "",
      "## 2026-04-01 — first lesson",
      "",
      "body of first lesson",
      "",
      "## 2026-04-15 — second lesson",
      "",
      "body of second lesson",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(dataRoot, "projects", "demo", "CLAUDE.md"),
    "# demo project\n\ndemo conventions: zoot",
    "utf8",
  );

  db = openDb(dbPath);
  config = { dataRoot, watchedProjects: [] };
  await fullReindex(db, config);
});

afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("search_memory", () => {
  it("returns ranked results with snippets for FTS query", async () => {
    const results = await searchMemory(db, { query: "checkstyle" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source_type).toBe("context");
    expect(results[0].topic).toBe("java");
    expect(results[0].snippet).toContain("checkstyle");
  });

  it("respects limit", async () => {
    const results = await searchMemory(db, { query: "lesson OR project", limit: 1 });
    expect(results.length).toBe(1);
  });

  it("respects source_filter", async () => {
    const all = await searchMemory(db, { query: "demo OR identity OR java" });
    const filtered = await searchMemory(db, {
      query: "demo OR identity OR java",
      source_filter: ["context"],
    });
    expect(filtered.every((r) => r.source_type === "context")).toBe(true);
    expect(filtered.length).toBeLessThan(all.length);
  });

  it("respects project_filter", async () => {
    const results = await searchMemory(db, {
      query: "zoot OR identity",
      project_filter: "demo",
    });
    expect(results.length).toBe(1);
    expect(results[0].project).toBe("demo");
  });

  it("returns a fused 'score' field, sorted descending, with no sentinel values", async () => {
    const results = await searchMemory(db, { query: "java OR jira OR lesson" });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(typeof r.score).toBe("number");
      expect(r.score).toBeLessThan(1); // never the old 999+distance sentinel
    }
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("reinforces exactly the returned rows in access_stats, and increments on re-query", async () => {
    const results = await searchMemory(db, { query: "checkstyle" });
    expect(results.length).toBeGreaterThan(0);

    // Exactly one access_stats row per returned row — and none for un-returned rows.
    const statsCount = (
      db.prepare("SELECT COUNT(*) AS c FROM access_stats").get() as { c: number }
    ).c;
    expect(statsCount).toBe(results.length);

    const topId = results[0].id;
    const row = db
      .prepare("SELECT access_count, last_accessed FROM access_stats WHERE observation_id = ?")
      .get(topId) as { access_count: number; last_accessed: number } | undefined;
    expect(row?.access_count).toBe(1);
    expect(row?.last_accessed).toBeGreaterThan(0);

    // Re-querying reinforces (increments), it does not duplicate or reset.
    await searchMemory(db, { query: "checkstyle" });
    const row2 = db
      .prepare("SELECT access_count FROM access_stats WHERE observation_id = ?")
      .get(topId) as { access_count: number };
    expect(row2.access_count).toBe(2);
  });

  it("reinforcement does not disturb the full-text index", async () => {
    const before = await searchMemory(db, { query: "checkstyle" });
    const topId = before[0].id;
    // After the reinforcement write, the row is still found by FTS unchanged.
    const again = await searchMemory(db, { query: "checkstyle" });
    expect(again[0].id).toBe(topId);
  });

  it("truncates to exactly limit when many candidates match", async () => {
    const results = await searchMemory(db, {
      query: "java OR jira OR lesson OR demo OR identity",
      limit: 2,
    });
    expect(results.length).toBe(2);
  });

  it("does not throw on a malformed FTS query", async () => {
    await expect(searchMemory(db, { query: '"unbalanced' })).resolves.toBeDefined();
  });
});

describe("get_topic", () => {
  it("returns full content for an existing topic", () => {
    const result = getTopic({ topic_name: "jira" }, contextDir);
    expect(result).not.toBeNull();
    expect(result!.content).toContain("Sprint planning");
  });

  it("returns null for a missing topic", () => {
    expect(getTopic({ topic_name: "nope" }, contextDir)).toBeNull();
  });

  it("rejects unsafe topic names", () => {
    expect(getTopic({ topic_name: "../etc/passwd" }, contextDir)).toBeNull();
    expect(getTopic({ topic_name: "java/../jira" }, contextDir)).toBeNull();
  });
});

describe("append_learning", () => {
  it("appends to agent learnings file", () => {
    const before = readFileSync(
      join(dataRoot, "agent", "learnings.md"),
      "utf8",
    );
    const result = appendLearning(
      db,
      {
        scope: "agent",
        content: "test body content xylophone",
        title: "test entry",
      },
      config,
    );
    expect(result.scope).toBe("agent");
    expect(result.bytes_appended).toBeGreaterThan(0);

    const after = readFileSync(result.path, "utf8");
    expect(after.length).toBeGreaterThan(before.length);
    expect(after).toMatch(/##\s+\d{4}-\d{2}-\d{2}\s+—\s+test entry/);
    expect(after).toContain("xylophone");
  });

  it("creates the project directory and file when missing", () => {
    const newProject = "fresh-proj";
    const path = join(dataRoot, "projects", newProject, "learnings.md");
    expect(existsSync(path)).toBe(false);

    const result = appendLearning(
      db,
      {
        scope: "project",
        project: newProject,
        content: "first ever learning",
        title: "kickoff",
      },
      config,
    );
    expect(existsSync(path)).toBe(true);
    expect(result.path).toBe(path);

    const text = readFileSync(path, "utf8");
    expect(text).toContain("# Learnings");
    expect(text).toMatch(/##\s+\d{4}-\d{2}-\d{2}\s+—\s+kickoff/);
  });

  it("makes the new entry searchable via search_memory", async () => {
    appendLearning(
      db,
      {
        scope: "agent",
        content: "very specific token unicornpotato",
        title: "fresh learning",
      },
      config,
    );
    const hits = await searchMemory(db, { query: "unicornpotato" });
    expect(hits.length).toBeGreaterThan(0);
  });

  it("rejects invalid project slug", () => {
    expect(() =>
      appendLearning(
        db,
        { scope: "project", project: "Bad Slug!", content: "x" },
        config,
      ),
    ).toThrow();
  });
});

describe("list_topics", () => {
  it("returns topics from disk with keywords parsed from _index.md", () => {
    const result = listTopics(contextDir);
    const names = result.topics.map((t) => t.name);
    expect(names).toContain("java");
    expect(names).toContain("jira");

    const java = result.topics.find((t) => t.name === "java")!;
    expect(java.keywords).toContain("java");
    expect(java.keywords).toContain("maven");
    expect(java.title).toBe("java");
  });

  it("warns when disk and index disagree", () => {
    writeFileSync(
      join(contextDir, "stray.md"),
      "# Stray\n\nNot in index.\n",
      "utf8",
    );
    const result = listTopics(contextDir);
    expect(
      result.warnings.some((w) => w.includes("stray.md")),
    ).toBe(true);
  });
});

describe("get_recent_learnings", () => {
  it("returns the most recent agent entries first", () => {
    const result = getRecentLearnings({ scope: "agent" }, dataRoot);
    expect(result.length).toBe(2);
    expect(result[0].date).toBe("2026-04-15");
    expect(result[0].title).toBe("second lesson");
    expect(result[1].date).toBe("2026-04-01");
  });

  it("respects limit", () => {
    const result = getRecentLearnings(
      { scope: "agent", limit: 1 },
      dataRoot,
    );
    expect(result.length).toBe(1);
    expect(result[0].date).toBe("2026-04-15");
  });

  it("returns empty for project scope when no project file exists", () => {
    const result = getRecentLearnings(
      { scope: "project", project: "demo" },
      dataRoot,
    );
    expect(result).toEqual([]);
  });

  it("merges agent and project entries when scope is 'all'", () => {
    writeFileSync(
      join(dataRoot, "projects", "demo", "learnings.md"),
      "# Learnings\n\n## 2026-05-01 — demo entry\n\nbody\n",
      "utf8",
    );
    const result = getRecentLearnings(
      { scope: "all", limit: 5 },
      dataRoot,
    );
    expect(result[0].date).toBe("2026-05-01");
    expect(result[0].project).toBe("demo");
  });
});

describe("listEpisodes", () => {
  let episodesDir: string;

  beforeEach(() => {
    episodesDir = join(dataRoot, "episodes");
    mkdirSync(episodesDir, { recursive: true });

    writeFileSync(join(episodesDir, "2026-05-13-aaa.md"), [
      "---",
      "date: 2026-05-13",
      "session_id: aaa",
      "project: arc",
      "turns: 10",
      "promoted: false",
      "---",
      "",
      "## Summary",
      "Debugged download stall in SplunkService.",
      "",
      "## Decisions",
      "- Used sliding window approach.",
      "",
    ].join("\n"), "utf8");

    writeFileSync(join(episodesDir, "2026-05-14-bbb.md"), [
      "---",
      "date: 2026-05-14",
      "session_id: bbb",
      "project: perch",
      "turns: 5",
      "promoted: true",
      "---",
      "",
      "## Summary",
      "Quick Perch config session.",
      "",
    ].join("\n"), "utf8");
  });

  it("returns all episodes sorted by date descending", () => {
    const results = listEpisodesImpl({}, episodesDir);
    expect(results).toHaveLength(2);
    expect(results[0].date).toBe("2026-05-14");
    expect(results[1].date).toBe("2026-05-13");
  });

  it("filters by project", () => {
    const results = listEpisodesImpl({ project: "arc" }, episodesDir);
    expect(results).toHaveLength(1);
    expect(results[0].project).toBe("arc");
  });

  it("filters by promoted status", () => {
    const unpromoted = listEpisodesImpl({ promoted: false }, episodesDir);
    expect(unpromoted).toHaveLength(1);
    expect(unpromoted[0].session_id).toBe("aaa");

    const promoted = listEpisodesImpl({ promoted: true }, episodesDir);
    expect(promoted).toHaveLength(1);
    expect(promoted[0].session_id).toBe("bbb");
  });

  it("extracts summary from body", () => {
    const results = listEpisodesImpl({ project: "arc" }, episodesDir);
    expect(results[0].summary).toContain("Debugged download stall");
  });

  it("returns empty array when episodes dir does not exist", () => {
    expect(listEpisodesImpl({}, join(dataRoot, "nonexistent"))).toEqual([]);
  });

  it("respects limit", () => {
    const results = listEpisodesImpl({ limit: 1 }, episodesDir);
    expect(results).toHaveLength(1);
  });

  it("session_id is null (not empty string) when frontmatter field is absent", () => {
    writeFileSync(join(episodesDir, "2026-05-15-nosessionid.md"), [
      "---",
      "date: 2026-05-15",
      "project: arc",
      "promoted: false",
      "---",
      "",
      "## Summary",
      "No session_id in frontmatter.",
      "",
    ].join("\n"), "utf8");
    const results = listEpisodesImpl({ project: "arc" }, episodesDir);
    const ep = results.find(r => r.date === "2026-05-15");
    expect(ep?.session_id).toBeNull();
  });

  it("falls back to filename date when frontmatter date is absent or is a Date object", () => {
    writeFileSync(join(episodesDir, "2026-05-16-nodatekey.md"), [
      "---",
      "session_id: nodatekey",
      "project: arc",
      "promoted: false",
      "---",
      "",
      "## Summary",
      "Episode with no date key.",
      "",
    ].join("\n"), "utf8");
    const results = listEpisodesImpl({ project: "arc" }, episodesDir);
    const ep = results.find(r => r.session_id === "nodatekey");
    expect(ep?.date).toBe("2026-05-16");
  });

  it("summary is null when Summary section is empty (Haiku produced no summary text)", () => {
    // Regression: without the trim()/startsWith('##') guard, the regex would
    // greedily span the blank line and trim() would yield '## Decisions...'
    // as the summary digest. Same guard as hooks/lib/episode-utils.js.
    writeFileSync(join(episodesDir, "2026-05-17-emptysummary.md"), [
      "---",
      "date: 2026-05-17",
      "session_id: emptysummary",
      "project: arc",
      "promoted: false",
      "---",
      "",
      "## Summary",
      "",
      "## Decisions",
      "- A decision was made.",
      "",
    ].join("\n"), "utf8");
    const results = listEpisodesImpl({ project: "arc" }, episodesDir);
    const ep = results.find(r => r.session_id === "emptysummary");
    expect(ep?.summary).toBeNull();
  });

  it("same-day episodes sort deterministically by session_id descending", () => {
    // Stable-sort regression: V8's sort is stable but its input order
    // depends on readdirSync, which is OS-dependent. Tie-break on session_id
    // gives a portable ordering.
    writeFileSync(join(episodesDir, "2026-05-18-aaa.md"), [
      "---", "date: 2026-05-18", "session_id: aaa", "project: arc", "promoted: false", "---",
      "", "## Summary", "First.", "",
    ].join("\n"), "utf8");
    writeFileSync(join(episodesDir, "2026-05-18-bbb.md"), [
      "---", "date: 2026-05-18", "session_id: bbb", "project: arc", "promoted: false", "---",
      "", "## Summary", "Second.", "",
    ].join("\n"), "utf8");
    writeFileSync(join(episodesDir, "2026-05-18-ccc.md"), [
      "---", "date: 2026-05-18", "session_id: ccc", "project: arc", "promoted: false", "---",
      "", "## Summary", "Third.", "",
    ].join("\n"), "utf8");

    const results = listEpisodesImpl({ project: "arc" }, episodesDir);
    const sameDay = results.filter(r => r.date === "2026-05-18");
    expect(sameDay.map(r => r.session_id)).toEqual(["ccc", "bbb", "aaa"]);
  });
});

describe("markEpisodePromoted", () => {
  let episodesDir: string;
  let promoConfig: IndexerConfig;

  beforeEach(() => {
    episodesDir = join(dataRoot, "episodes");
    mkdirSync(episodesDir, { recursive: true });
    // macOS tmpdir is /var/folders/... but /var → /private/var, so realpathSync
    // returns /private/var/.... The tool resolves through symlinks for security
    // (defeats symlink escapes), then calls indexFile, whose classify() uses
    // plain resolve() on config.dataRoot. Canonicalize the test's dataRoot so
    // both ends agree — mirrors production where ~/.claude-data has no /var
    // symlink layer. Episodes dir is realpath'd to match the tool's return.
    episodesDir = realpathSync(episodesDir);
    promoConfig = { dataRoot: realpathSync(dataRoot), watchedProjects: [] };
  });

  it("sets promoted: true in episode frontmatter using targeted regex (preserves all other fields)", () => {
    const path = join(episodesDir, "2026-05-14-promo.md");
    const original = [
      "---",
      "date: 2026-05-14",
      "session_id: promo001",
      "project: arc",
      "turns: 7",
      "promoted: false",
      "---",
      "",
      "## Summary",
      "A promotable session.",
      "",
    ].join("\n");
    writeFileSync(path, original, "utf8");

    const result = markEpisodePromotedImpl(db, { path }, promoConfig);
    expect(result.promoted).toBe(true);
    expect(result.path).toBe(path);

    const updated = readFileSync(path, "utf8");
    expect(updated).toContain("promoted: true");
    expect(updated).not.toContain("promoted: false");
    expect(updated).toContain("date: 2026-05-14");
    expect(updated).toContain("session_id: promo001");
    expect(updated).toContain("project: arc");
    expect(updated).toContain("turns: 7");
    expect(updated).toContain("A promotable session.");
  });

  it("re-indexes the file after promotion", () => {
    const path = join(episodesDir, "2026-05-14-reindex.md");
    writeFileSync(path, [
      "---",
      "date: 2026-05-14",
      "session_id: reindex",
      "project: arc",
      "turns: 4",
      "promoted: false",
      "---",
      "",
      "## Summary",
      "Session to be reindexed.",
      "",
    ].join("\n"), "utf8");

    markEpisodePromotedImpl(db, { path }, promoConfig);

    const row = db.prepare(
      "SELECT frontmatter FROM observations WHERE source_path = ?"
    ).get(path) as { frontmatter: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.frontmatter).toContain("promoted: true");
  });

  it("throws when the episode file does not exist", () => {
    expect(() =>
      markEpisodePromotedImpl(db, { path: join(episodesDir, "ghost.md") }, promoConfig)
    ).toThrow("Episode file not found");
  });

  it("rejects path outside the episodes directory", () => {
    expect(() =>
      markEpisodePromotedImpl(db, { path: "/etc/passwd" }, promoConfig)
    ).toThrow(/outside the episodes directory|not allowed/i);
  });

  it("rejects path traversal via ..", () => {
    // Create a real file OUTSIDE episodes so existsSync passes and the
    // containment check (not the "file not found" branch) is what fires.
    const outsidePath = join(dataRoot, "outside.md");
    writeFileSync(outsidePath, "---\ndate: 2026-05-14\n---\nbody\n", "utf8");

    const traversal = join(episodesDir, "..", "outside.md");
    expect(() =>
      markEpisodePromotedImpl(db, { path: traversal }, promoConfig)
    ).toThrow(/outside the episodes directory|not allowed/i);
  });

  it("rejects a file missing required frontmatter (session_id or date)", () => {
    const path = join(episodesDir, "2026-05-14-nofrontmatter.md");
    writeFileSync(path, "## Summary\nNo frontmatter here.\n", "utf8");
    expect(() =>
      markEpisodePromotedImpl(db, { path }, promoConfig)
    ).toThrow(/invalid episode|missing frontmatter/i);
  });

  it("round-trip preserves all frontmatter field types (date stays string, turns stays number)", () => {
    const path = join(episodesDir, "2026-05-14-roundtrip.md");
    writeFileSync(path, [
      "---",
      "date: 2026-05-14",
      "session_id: rt001",
      "project: arc",
      "turns: 42",
      "promoted: false",
      "---",
      "",
      "## Summary",
      "Round-trip test.",
      "",
    ].join("\n"), "utf8");

    markEpisodePromotedImpl(db, { path }, promoConfig);

    const updated = readFileSync(path, "utf8");
    expect(updated).toMatch(/^date: 2026-05-14$/m);
    expect(updated).not.toMatch(/2026-05-14T/);
    expect(updated).toMatch(/^turns: 42$/m);
  });

  it("replaces promoted line even when value is empty (does not eat adjacent field)", () => {
    // Regression: an earlier draft used /^promoted:\s*\S+/m which would walk
    // past the line break (\s includes \n) and consume the first token of the
    // next field's value. With `promoted:` empty and `turns: 7` immediately
    // after, the bug would have rewritten `turns: 7` → `turns: ` with `7`
    // glued to `promoted:`. The fix matches the whole line via `.` (no /s flag
    // so `.` does NOT match newlines).
    const path = join(episodesDir, "2026-05-14-emptyval.md");
    writeFileSync(path, [
      "---",
      "date: 2026-05-14",
      "session_id: emptyval",
      "promoted:",
      "turns: 7",
      "---",
      "",
      "## Summary",
      "Test for empty promoted value.",
      "",
    ].join("\n"), "utf8");

    markEpisodePromotedImpl(db, { path }, promoConfig);

    const updated = readFileSync(path, "utf8");
    expect(updated).toMatch(/^promoted: true$/m);
    expect(updated).toMatch(/^turns: 7$/m);
    // The original `promoted:` line should be fully replaced — no stray empty value
    expect(updated.match(/^promoted:/gm)).toHaveLength(1);
  });
});

describe("append_learning novelty flagging (A2)", () => {
  it("flags a near-duplicate entry at write time and records a pending novelty_flag", () => {
    // The agent learnings.md fixture already holds a "first lesson" entry whose body is
    // "body of first lesson"; re-recording that body should be flagged.
    const res = appendLearning(
      db,
      { scope: "agent", content: "body of first lesson", title: "re-record of first" },
      config,
    );
    expect(res.novelty_warning).toBeTruthy();
    const pending = (
      db.prepare("SELECT COUNT(*) AS c FROM novelty_flags WHERE status = 'pending'").get() as {
        c: number;
      }
    ).c;
    expect(pending).toBeGreaterThan(0);
  });

  it("does not flag a genuinely novel entry", () => {
    const res = appendLearning(
      db,
      { scope: "agent", content: "unrelated zebra quasar nimbus content", title: "novel" },
      config,
    );
    expect(res.novelty_warning).toBeUndefined();
  });

  it("does not fail the write when there are no prior entries to compare", () => {
    const res = appendLearning(
      db,
      { scope: "project", project: "fresh-novelty-proj", content: "first ever entry", title: "kickoff" },
      config,
    );
    expect(res.bytes_appended).toBeGreaterThan(0);
    expect(res.novelty_warning).toBeUndefined();
  });

  it("still succeeds when the novelty-flag write fails (best-effort)", () => {
    // Force the flagging INSERT to throw by removing its table; without the best-effort
    // catch in append_learning this call would throw. The write itself must still succeed.
    db.exec("DROP TABLE novelty_flags");
    const res = appendLearning(
      db,
      { scope: "agent", content: "body of first lesson", title: "dup under failure" },
      config,
    );
    expect(res.bytes_appended).toBeGreaterThan(0);
    expect(res.novelty_warning).toBeUndefined();
  });
});

describe("scan_novelty + resolve_novelty_flag (A2)", () => {
  it("returns pending flags re-located to current entries; resolve excludes them", async () => {
    // A write-time near-dup creates a pending flag (re-recording an existing entry's body).
    appendLearning(
      db,
      { scope: "agent", content: "body of first lesson", title: "re-record" },
      config,
    );
    let scan = await scanNovelty(db, {}, config);
    expect(scan.candidates.length).toBeGreaterThan(0);
    const flagId = scan.candidates[0].flag_id;
    expect(scan.candidates[0].a.title).toBeTruthy();
    expect(scan.candidates[0].b.title).toBeTruthy();

    const r = resolveNoveltyFlag(db, { id: flagId, status: "dismissed" });
    expect(r.updated).toBe(true);

    scan = await scanNovelty(db, {}, config);
    expect(scan.candidates.some((c) => c.flag_id === flagId)).toBe(false);
  });

  it("resolve_novelty_flag reports updated=false for an unknown id", () => {
    expect(resolveNoveltyFlag(db, { id: 999999, status: "superseded" }).updated).toBe(false);
  });

  it("clusters seeded entries at scan time and persists a scan-detected flag", async () => {
    // The default mock embeds everything to the zero vector, so the semantic-scan
    // persistence path never fires. Override it to a unit vector so the two distinct
    // fixture entries cosine to 1.0 and cluster — exercising the scan INSERT + canonical
    // pair ordering end-to-end (no write-time flag is created in this test).
    const unit = new Float32Array(768).fill(1 / Math.sqrt(768));
    vi.mocked(embedDocument).mockResolvedValue(unit);
    try {
      const scan = await scanNovelty(db, {}, config);
      expect(scan.candidates.some((c) => c.detected_by === "scan")).toBe(true);
      const persisted = (
        db.prepare("SELECT COUNT(*) AS c FROM novelty_flags WHERE detected_by = 'scan'").get() as {
          c: number;
        }
      ).c;
      expect(persisted).toBeGreaterThan(0);
    } finally {
      vi.mocked(embedDocument).mockResolvedValue(new Float32Array(768).fill(0));
    }
  });
});

describe("scan_experience (B1)", () => {
  const episodesDir = (): string => join(dataRoot, "episodes");
  const writeEpisode = (slug: string, promoted: boolean): string => {
    const dir = episodesDir();
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `2026-06-${slug}.md`);
    writeFileSync(
      p,
      `---\ndate: 2026-06-${slug}\nsession_id: sess-${slug}\npromoted: ${promoted}\n---\n\n## Summary\nepisode ${slug}\n`,
      "utf8",
    );
    return p;
  };
  // Insert an episode observation row (so scan_experience can resolve its id) and seed its
  // pre-computed embedding into vec_items — mirrors fullReindex + embedObservation. Seeding raw
  // serializeVector bytes here is what verifies scan_experience reads vec_items back correctly.
  const seed = (path: string, vec: Float32Array): void => {
    const now = Math.floor(Date.now() / 1000);
    const r = db
      .prepare(
        `INSERT INTO observations (source_type, source_path, project, topic, title, content, content_hash, file_mtime, indexed_at, frontmatter)
         VALUES ('episode', ?, NULL, NULL, 'ep', 'body', ?, ?, ?, NULL)`,
      )
      .run(path, path, now, now);
    db.prepare("INSERT OR REPLACE INTO vec_items(observation_id, embedding) VALUES (?, ?)").run(
      BigInt(Number(r.lastInsertRowid)),
      serializeVector(vec),
    );
  };
  const themeA = (): Float32Array => { const v = new Float32Array(768); v[0] = 1; return v; };
  const distinct = (): Float32Array => { const v = new Float32Array(768); v[1] = 1; return v; };

  // Route every scan_experience shadow-log write in this suite into the per-test temp dir, so the
  // tests never append to the real ~/.claude-data/experience-shadow.jsonl. Runs after the top-level
  // beforeEach that (re)assigns `config`, so this mutation lands on the current test's config.
  beforeEach(() => {
    (config as IndexerConfig & { shadowLogPath?: string }).shadowLogPath = join(workDir, "experience-shadow.jsonl");
  });

  it("clusters unpromoted episodes from vectors read back out of vec_items", () => {
    const a = writeEpisode("01", false);
    const b = writeEpisode("02", false);
    const c = writeEpisode("03", false);
    const d = writeEpisode("04", false);
    seed(a, themeA());
    seed(b, themeA());
    seed(c, themeA()); // 3 share a theme
    seed(d, distinct()); // 1 orthogonal
    const { clusters } = scanExperience(db, {}, config);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].size).toBe(3);
    expect(clusters[0].members.map((m) => m.session_id).sort()).toEqual([
      "sess-01",
      "sess-02",
      "sess-03",
    ]);
    expect(clusters[0].cohesion).toBeGreaterThan(0.99); // identical vectors → cosine 1
  });

  it("excludes promoted episodes from the synthesis backlog", () => {
    seed(writeEpisode("01", false), themeA());
    seed(writeEpisode("02", false), themeA());
    seed(writeEpisode("03", true), themeA()); // promoted → not in the backlog → only 2 left < minSize
    const { clusters } = scanExperience(db, {}, config);
    expect(clusters).toHaveLength(0);
  });

  it("skips an unpromoted episode that has no stored embedding (not fatal)", () => {
    seed(writeEpisode("01", false), themeA());
    seed(writeEpisode("02", false), themeA());
    seed(writeEpisode("03", false), themeA());
    writeEpisode("04", false); // file only — no observation/vec_items row → must be skipped
    const { clusters } = scanExperience(db, {}, config);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].size).toBe(3);
  });

  it("emits value_score on each returned ClusterMember (present and absent)", () => {
    const dir = episodesDir();
    mkdirSync(dir, { recursive: true });
    const scored = (slug: string, v: number): string => {
      const p = join(dir, `2026-06-${slug}.md`);
      writeFileSync(
        p,
        `---\ndate: 2026-06-${slug}\nsession_id: sess-${slug}\npromoted: false\nvalue_score: ${v}\n---\n\n## Summary\ns\n`,
        "utf8",
      );
      return p;
    };
    seed(scored("01", 4), themeA());
    seed(scored("02", 2), themeA());
    seed(writeEpisode("03", false), themeA()); // unscored → undefined
    const { clusters } = scanExperience(db, {}, config);
    expect(clusters).toHaveLength(1);
    const byId = Object.fromEntries(clusters[0].members.map((m) => [m.session_id, m.value_score]));
    expect(byId["sess-01"]).toBe(4);
    expect(byId["sess-02"]).toBe(2);
    expect(byId["sess-03"]).toBeUndefined();
  });

  it("surfaces value_score on EpisodeRecord when present, undefined when absent", () => {
    const dir = episodesDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-06-10.md"),
      `---\ndate: 2026-06-10\nsession_id: sess-10\npromoted: false\nvalue_score: 3\n---\n\n## Summary\nscored\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "2026-06-11.md"),
      `---\ndate: 2026-06-11\nsession_id: sess-11\npromoted: false\n---\n\n## Summary\nunscored\n`,
      "utf8",
    );
    const entries = listEpisodesImpl({}, episodesDir());
    const scored = entries.find((e) => e.session_id === "sess-10")!;
    const unscored = entries.find((e) => e.session_id === "sess-11")!;
    expect(scored.value_score).toBe(3);
    expect(unscored.value_score).toBeUndefined();
  });

  it("shadow mode never excludes, even below a live threshold", () => {
    const dir = episodesDir(); mkdirSync(dir, { recursive: true });
    const mk = (slug: string, v?: number) => {
      const p = join(dir, `2026-06-${slug}.md`);
      const vs = v === undefined ? "" : `value_score: ${v}\n`;
      writeFileSync(p, `---\ndate: 2026-06-${slug}\nsession_id: sess-${slug}\npromoted: false\n${vs}---\n\n## Summary\ns\n`, "utf8");
      return p;
    };
    seed(mk("01", 0), themeA()); seed(mk("02", 0), themeA()); seed(mk("03", 0), themeA());
    const { clusters } = scanExperience(db, {}, config); // config default = shadow
    expect(clusters).toHaveLength(1);
    expect(clusters[0].size).toBe(3);
  });

  it("a keyless episode is never excluded even in live mode", () => {
    const dir = episodesDir(); mkdirSync(dir, { recursive: true });
    const mk = (slug: string, v?: number) => {
      const p = join(dir, `2026-06-${slug}.md`);
      const vs = v === undefined ? "" : `value_score: ${v}\n`;
      writeFileSync(p, `---\ndate: 2026-06-${slug}\nsession_id: sess-${slug}\npromoted: false\n${vs}---\n\n## Summary\ns\n`, "utf8");
      return p;
    };
    seed(mk("01", 4), themeA()); seed(mk("02", 4), themeA()); seed(mk("03"), themeA()); // 03 keyless
    const live = { ...config, valueGate: { mode: "live" as const, minEpisode: 2, minCluster: 2 } };
    const { clusters } = scanExperience(db, {}, live);
    expect(clusters[0].members.map((m) => m.session_id)).toContain("sess-03");
  });

  it("live mode drops a cluster whose every scored member is below the floor", () => {
    const dir = episodesDir(); mkdirSync(dir, { recursive: true });
    const mk = (slug: string, v: number) => {
      const p = join(dir, `2026-06-${slug}.md`);
      writeFileSync(p, `---\ndate: 2026-06-${slug}\nsession_id: sess-${slug}\npromoted: false\nvalue_score: ${v}\n---\n\n## Summary\ns\n`, "utf8");
      return p;
    };
    seed(mk("01", 1), themeA()); seed(mk("02", 1), themeA()); seed(mk("03", 1), themeA());
    const live = { ...config, valueGate: { mode: "live" as const, minEpisode: null, minCluster: 3 } };
    const { clusters } = scanExperience(db, {}, live);
    expect(clusters).toHaveLength(0);
  });

  it("max-aggregation: one high-value member rescues its cluster in live mode", () => {
    const dir = episodesDir(); mkdirSync(dir, { recursive: true });
    const mk = (slug: string, v: number) => {
      const p = join(dir, `2026-06-${slug}.md`);
      writeFileSync(p, `---\ndate: 2026-06-${slug}\nsession_id: sess-${slug}\npromoted: false\nvalue_score: ${v}\n---\n\n## Summary\ns\n`, "utf8");
      return p;
    };
    seed(mk("01", 4), themeA()); seed(mk("02", 1), themeA()); seed(mk("03", 1), themeA());
    const live = { ...config, valueGate: { mode: "live" as const, minEpisode: null, minCluster: 3 } };
    const { clusters } = scanExperience(db, {}, live);
    expect(clusters).toHaveLength(1);
  });

  it("ACCEPTANCE: shadow≡no-gate+logs, live changes membership, unknown never excluded", () => {
    const dir = episodesDir(); mkdirSync(dir, { recursive: true });
    const mk = (slug: string, v?: number) => {
      const p = join(dir, `2026-06-${slug}.md`);
      const vs = v === undefined ? "" : `value_score: ${v}\n`;
      writeFileSync(p, `---\ndate: 2026-06-${slug}\nsession_id: sess-${slug}\npromoted: false\n${vs}---\n\n## Summary\ns\n`, "utf8");
      return p;
    };
    // 5 episodes: two value-0, one keyless, two high-value — all themeA
    seed(mk("01", 0), themeA()); seed(mk("02", 0), themeA()); seed(mk("03"), themeA());
    seed(mk("04", 4), themeA()); seed(mk("05", 4), themeA());

    // (1) shadow ≡ no-gate: all 5 returned, and a shadow-log line is written (suite beforeEach set the path)
    const shadow = scanExperience(db, {}, config);
    expect(shadow.clusters[0].size).toBe(5);
    const shadowPath = join(workDir, "experience-shadow.jsonl");
    expect(readFileSync(shadowPath, "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(1);

    // (2) live changes membership: episode floor 2 drops value-0 members, leaving {03 keyless, 04, 05} = 3
    const live = scanExperience(db, {}, { ...config, valueGate: { mode: "live", minEpisode: 2, minCluster: null } } as never);
    const liveSize = live.clusters[0]?.size ?? 0;
    expect(liveSize).toBeLessThan(5);
    expect(liveSize).toBe(3);

    // (3) unknown never excluded: the keyless sess-03 survives live filtering
    expect(live.clusters[0]?.members.map((m) => m.session_id)).toContain("sess-03");
  });

  it("shadow mode preserves recency order over the cap (inert); live mode value-prioritizes", () => {
    // 5 themeA episodes, dates 01..05. Values deliberately make recency and value DISAGREE:
    //   01=4 (oldest, highest), 02=4, 03=0, 04=0, 05=undefined (newest, keyless).
    // With max_episodes=3:
    //   SHADOW: strict recency → keeps the 3 most recent: 05, 04, 03.
    //   LIVE:   value-sort with absent=VALUE_MAX(4) → ranking is 05(4), 02(4), 01(4), 03(0), 04(0);
    //           recency tiebreak within same score: top 3 = 05, 02, 01.
    // Both considered sets have 3 identical-theme episodes → EXPERIENCE_MIN_CLUSTER_SIZE=3 → cluster forms.
    const dir = episodesDir(); mkdirSync(dir, { recursive: true });
    const mk = (slug: string, v?: number) => {
      const p = join(dir, `2026-06-${slug}.md`);
      const vs = v === undefined ? "" : `value_score: ${v}\n`;
      writeFileSync(p, `---\ndate: 2026-06-${slug}\nsession_id: sess-${slug}\npromoted: false\n${vs}---\n\n## Summary\ns\n`, "utf8");
      return p;
    };
    seed(mk("01", 4), themeA()); // oldest, value=4
    seed(mk("02", 4), themeA()); // value=4
    seed(mk("03", 0), themeA()); // value=0
    seed(mk("04", 0), themeA()); // value=0
    seed(mk("05"),    themeA()); // newest, keyless (no value_score)

    const shadow = scanExperience(db, { max_episodes: 3 }, config); // shadow (default mode)
    const liveCfg = { ...config, valueGate: { mode: "live" as const, minEpisode: null, minCluster: null } };
    const live = scanExperience(db, { max_episodes: 3 }, liveCfg);

    const memberIds = (r: { clusters: { members: { session_id: string | null }[] }[] }) =>
      (r.clusters[0]?.members ?? []).map((m) => m.session_id).sort();

    // Shadow: recency-only cap → {03, 04, 05} kept; {01, 02} evicted.
    const shadowIds = memberIds(shadow);
    expect(shadowIds).toEqual(["sess-03", "sess-04", "sess-05"]);

    // Live: value-aware cap with absent=top-band → {01(=4), 02(=4), 05(absent→4)} kept; {03(=0), 04(=0)} evicted.
    const liveIds = memberIds(live);
    expect(liveIds).toEqual(["sess-01", "sess-02", "sess-05"]);

    // Absence ≠ low: keyless sess-05 survives the live cap while value-0 sess-03/sess-04 are evicted.
    expect(liveIds).toContain("sess-05");
    expect(liveIds).not.toContain("sess-03");
    expect(liveIds).not.toContain("sess-04");

    // Shadow and live considered sets must differ (the gate is active over the cap).
    expect(shadowIds).not.toEqual(liveIds);
  });

  it("appends one shadow-log line per run with a bucketed histogram", () => {
    const dir = episodesDir(); mkdirSync(dir, { recursive: true });
    const shadowPath = join(workDir, "experience-shadow.jsonl");
    const mk = (slug: string, v?: number, date = `2026-06-${slug}`) => {
      const p = join(dir, `${date}.md`);
      const vs = v === undefined ? "" : `value_score: ${v}\n`;
      writeFileSync(p, `---\ndate: ${date}\nsession_id: sess-${slug}\npromoted: false\n${vs}---\n\n## Summary\ns\n`, "utf8");
      return p;
    };
    seed(mk("01", 3), themeA()); seed(mk("02", 3), themeA()); seed(mk("03", undefined, "2026-06-09"), themeA()); // one keyless, post-feature date
    scanExperience(db, {}, { ...config, shadowLogPath: shadowPath } as never);
    const lines = readFileSync(shadowPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.gate_mode).toBe("shadow");
    expect(rec.value_histogram["3"]).toBe(2);
    expect(rec.value_histogram.unknown_declined).toBe(1); // keyless + date ≥ 2026-06-08
    expect(Array.isArray(rec.would_exclude_clusters)).toBe(true);
  });
});

describe("validate_experience_proposal (B1, gate 1)", () => {
  const mkEpisode = (slug: string): string => {
    const dir = join(dataRoot, "episodes");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `2026-06-${slug}.md`);
    writeFileSync(
      p,
      `---\ndate: 2026-06-${slug}\nsession_id: sess-${slug}\npromoted: false\n---\n\n## Summary\nepisode ${slug}\n`,
      "utf8",
    );
    return p;
  };
  const baseProposal = () => ({
    id: "P001",
    priority: "MEDIUM",
    category: "EXPERIENCE_LEARNING",
    title: "A recurring cross-session lesson",
    description:
      "A higher-order lesson distilled from three sessions that recurred across the backlog and is worth keeping.",
    evidence: ["session sess-01: detail", "session sess-02: detail", "session sess-03: detail"],
    proposed_change: {
      file: join(dataRoot, "agent", "learnings.md"),
      action: "APPEND_LEARNING",
      content: "totally novel zlorptal wibblefnord guidance",
    },
    estimated_weekly_savings_minutes: 8,
  });

  it("passes a well-formed, well-grounded, non-duplicate proposal", () => {
    mkEpisode("01");
    mkEpisode("02");
    mkEpisode("03");
    const r = validateExperienceProposal({ proposal: baseProposal() }, config);
    expect(r.valid).toBe(true);
    expect(r.resolved_citations).toBe(3);
    expect(r.duplicate_of).toBeNull();
  });

  it("fails when evidence cites an episode that does not exist (anti-fabrication)", () => {
    mkEpisode("01");
    mkEpisode("02"); // sess-03 cited by the proposal is never created
    const r = validateExperienceProposal({ proposal: baseProposal() }, config);
    expect(r.valid).toBe(false);
    expect(r.unresolved_citations.length).toBeGreaterThan(0);
  });

  it("flags a proposal that duplicates an existing learning", () => {
    mkEpisode("01");
    mkEpisode("02");
    mkEpisode("03");
    const p = baseProposal();
    p.proposed_change.content = "body of first lesson"; // matches the agent/learnings.md fixture entry
    const r = validateExperienceProposal({ proposal: p }, config);
    expect(r.valid).toBe(false);
    expect(r.duplicate_of).not.toBeNull();
  });

  it("rejects a schema-invalid proposal (wrong category)", () => {
    mkEpisode("01");
    mkEpisode("02");
    mkEpisode("03");
    const r = validateExperienceProposal(
      { proposal: { ...baseProposal(), category: "CLAUDE_MD_RULE" } },
      config,
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/category/);
  });
});
