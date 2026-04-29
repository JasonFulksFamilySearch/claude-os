import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  type IndexerConfig,
} from "../src/indexer.js";

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

  it("rejects archive files", () => {
    const p = join(dataRoot, "archive", "old.md");
    expect(classify(p, config)).toBeNull();
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

describe("fullReindex", () => {
  it("indexes all expected files in the data root", () => {
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

    const summary = fullReindex(db, config);
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
    expect(paths).not.toContain(join(dataRoot, "archive", "old.md"));
  });
});
