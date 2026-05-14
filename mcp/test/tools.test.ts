import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/embedder.js", () => ({
  embedDocument: vi.fn().mockResolvedValue(new Float32Array(768).fill(0)),
  embedQuery: vi.fn().mockResolvedValue(new Float32Array(768).fill(0)),
  serializeVector: (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength),
  EMBEDDING_DIM: 768,
  MODEL_ID: "nomic-ai/nomic-embed-text-v1.5",
}));
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
});
