import Database from "better-sqlite3";
import chokidar, { FSWatcher } from "chokidar";
import { createHash } from "node:crypto";
import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { join, basename, dirname, relative, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import matter from "gray-matter";
import type { SourceType } from "./db.js";
import { log } from "./logger.js";
import { embedDocument, serializeVector } from "./embedder.js";

const MAX_FILE_BYTES = 1024 * 1024;

export interface WatchedProject {
  slug: string;
  path: string;
  files?: string[];
}

export interface IndexerConfig {
  dataRoot: string;
  watchedProjects: WatchedProject[];
}

export function defaultConfig(): IndexerConfig {
  return {
    dataRoot: join(homedir(), ".claude-data"),
    watchedProjects: [],
  };
}

export interface Classification {
  source_type: SourceType;
  topic: string | null;
  project: string | null;
}

export function classify(absPath: string, config: IndexerConfig): Classification | null {
  const dataRoot = resolve(config.dataRoot);
  const norm = resolve(absPath);

  if (norm.startsWith(resolve(dataRoot, "archive") + "/")) return null;

  const agentClaude = resolve(dataRoot, "agent", "CLAUDE.md");
  const agentLearnings = resolve(dataRoot, "agent", "learnings.md");
  const contextDir = resolve(dataRoot, "context");
  const projectsDir = resolve(dataRoot, "projects");
  const indexFile = resolve(contextDir, "_index.md");

  if (norm === agentClaude) {
    return { source_type: "agent", topic: null, project: null };
  }
  if (norm === agentLearnings) {
    return { source_type: "learning", topic: null, project: null };
  }
  if (norm === indexFile) {
    return null;
  }
  if (norm.startsWith(contextDir + "/") && norm.endsWith(".md")) {
    const topic = basename(norm, ".md");
    return { source_type: "context", topic, project: null };
  }
  if (norm.startsWith(projectsDir + "/")) {
    const rel = relative(projectsDir, norm);
    const parts = rel.split("/");
    if (parts.length >= 2) {
      const slug = parts[0];
      const fname = parts[parts.length - 1];
      if (fname === "CLAUDE.md") {
        return { source_type: "project_claude_md", topic: null, project: slug };
      }
      if (fname === "learnings.md") {
        return { source_type: "learning", topic: null, project: slug };
      }
      if (fname === "decisions.md") {
        return { source_type: "decision", topic: null, project: slug };
      }
    }
    return null;
  }

  // Episodes dir: ~/.claude-data/episodes/ — classified by path, project extracted in indexFile
  const episodesDir = resolve(dataRoot, "episodes");
  if (norm.startsWith(episodesDir + "/") && norm.endsWith(".md")) {
    return { source_type: "episode", topic: null, project: null };
  }

  for (const watched of config.watchedProjects) {
    const projRoot = resolve(watched.path);
    if (norm === resolve(projRoot, "CLAUDE.md")) {
      return { source_type: "project_claude_md", topic: null, project: watched.slug };
    }
    if (norm === resolve(projRoot, "README.md")) {
      return { source_type: "project_readme", topic: null, project: watched.slug };
    }
  }

  return null;
}

interface ParsedFile {
  body: string;
  frontmatter: string | null;
  title: string | null;
  data: Record<string, unknown>;
}

function parseFile(rawContent: string): ParsedFile {
  const parsed = matter(rawContent);
  const body = parsed.content;
  const frontmatter =
    parsed.matter && parsed.matter.length > 0 ? parsed.matter : null;
  const titleMatch = body.match(/^#\s+(.+?)\s*$/m);
  const title = titleMatch ? titleMatch[1].trim() : null;
  return { body, frontmatter, title, data: parsed.data as Record<string, unknown> };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const upsertSql = `
  INSERT INTO observations (
    source_type, source_path, project, topic, title,
    content, content_hash, file_mtime, indexed_at, frontmatter
  ) VALUES (
    @source_type, @source_path, @project, @topic, @title,
    @content, @content_hash, @file_mtime, @indexed_at, @frontmatter
  )
  ON CONFLICT(source_path) DO UPDATE SET
    source_type  = excluded.source_type,
    project      = excluded.project,
    topic        = excluded.topic,
    title        = excluded.title,
    content      = excluded.content,
    content_hash = excluded.content_hash,
    file_mtime   = excluded.file_mtime,
    indexed_at   = excluded.indexed_at,
    frontmatter  = excluded.frontmatter
  WHERE observations.content_hash != excluded.content_hash
`;

const selectExistingSql = `
  SELECT content_hash FROM observations WHERE source_path = ?
`;

export interface IndexResult {
  status: "indexed" | "skipped_unchanged" | "skipped_unclassified" | "skipped_too_large" | "skipped_missing";
  source_path: string;
}

export function indexFile(
  db: Database.Database,
  absPath: string,
  config: IndexerConfig,
): IndexResult {
  if (!isAbsolute(absPath)) {
    throw new Error(`indexFile requires absolute path, got: ${absPath}`);
  }
  if (!existsSync(absPath)) {
    return { status: "skipped_missing", source_path: absPath };
  }

  const cls = classify(absPath, config);
  if (!cls) {
    return { status: "skipped_unclassified", source_path: absPath };
  }

  const stat = statSync(absPath);
  if (stat.size > MAX_FILE_BYTES) {
    log("warn", "Skipping oversized file", { absPath, size: stat.size });
    return { status: "skipped_too_large", source_path: absPath };
  }

  const raw = readFileSync(absPath, "utf8");
  const { body, frontmatter, title, data } = parseFile(raw);

  const effectiveProject =
    cls.source_type === "episode"
      ? (typeof data.project === "string" && data.project.length > 0 ? data.project : null)
      : cls.project;

  const contentHash = sha256(body);

  const existing = db.prepare(selectExistingSql).get(absPath) as
    | { content_hash: string }
    | undefined;
  if (existing && existing.content_hash === contentHash) {
    return { status: "skipped_unchanged", source_path: absPath };
  }

  const now = Math.floor(Date.now() / 1000);
  db.prepare(upsertSql).run({
    source_type: cls.source_type,
    source_path: absPath,
    project: effectiveProject,
    topic: cls.topic,
    title: title ?? basename(absPath, ".md"),
    content: body,
    content_hash: contentHash,
    file_mtime: Math.floor(stat.mtimeMs / 1000),
    indexed_at: now,
    frontmatter,
  });

  return { status: "indexed", source_path: absPath };
}

export function removeFile(db: Database.Database, absPath: string): void {
  const row = db.prepare("SELECT id FROM observations WHERE source_path = ?").get(absPath) as { id: number } | undefined;
  db.prepare("DELETE FROM observations WHERE source_path = ?").run(absPath);
  if (row) db.prepare("DELETE FROM vec_items WHERE observation_id = ?").run(row.id);
}

export async function embedObservation(
  db: Database.Database,
  id: number,
  content: string,
): Promise<void> {
  // Skip if already embedded — content hash guard on observations means content hasn't changed
  const existing = db.prepare("SELECT observation_id FROM vec_items WHERE observation_id = ?").get(id);
  if (existing) return;

  try {
    const vector = await embedDocument(content);
    const bytes = serializeVector(vector);
    db.prepare("INSERT OR REPLACE INTO vec_items(observation_id, embedding) VALUES (?, ?)").run(id, bytes);
  } catch (err) {
    log("error", "embedObservation failed", {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

export interface ReindexSummary {
  total: number;
  indexed: number;
  unchanged: number;
  skipped: number;
  removed: number;
  durationMs: number;
}

export async function fullReindex(
  db: Database.Database,
  config: IndexerConfig,
): Promise<ReindexSummary> {
  const start = Date.now();
  const dataRoot = resolve(config.dataRoot);

  const candidates = new Set<string>();

  const agentDir = join(dataRoot, "agent");
  for (const f of walk(agentDir)) {
    if (basename(f).startsWith("_legacy")) continue;
    candidates.add(f);
  }

  const contextDir = join(dataRoot, "context");
  for (const f of walk(contextDir)) {
    candidates.add(f);
  }

  const projectsDir = join(dataRoot, "projects");
  for (const f of walk(projectsDir)) {
    candidates.add(f);
  }

  const episodesDir = join(dataRoot, "episodes");
  for (const f of walk(episodesDir)) {
    // Broader `_*` skip than the agent walk's `_legacy*` — convention for
    // any underscore-prefixed scratch/legacy file in episodes/ (so _archive.md,
    // _scratch.md, etc. can be parked without re-indexing).
    if (basename(f).startsWith("_")) continue;
    candidates.add(f);
  }

  for (const watched of config.watchedProjects) {
    const projRoot = resolve(watched.path);
    if (!existsSync(projRoot)) {
      log("warn", "Watched project path missing", { slug: watched.slug, path: projRoot });
      continue;
    }
    const files = watched.files ?? ["CLAUDE.md", "README.md"];
    for (const f of files) {
      const full = join(projRoot, f);
      if (existsSync(full)) candidates.add(full);
    }
  }

  let indexed = 0;
  let unchanged = 0;
  let skipped = 0;
  const newlyIndexed: Array<{ id: number; content: string }> = [];

  for (const file of candidates) {
    const r = indexFile(db, file, config);
    if (r.status === "indexed") {
      indexed++;
      const row = db.prepare("SELECT id, content FROM observations WHERE source_path = ?").get(file) as { id: number; content: string } | undefined;
      if (row) newlyIndexed.push(row);
    } else if (r.status === "skipped_unchanged") unchanged++;
    else skipped++;
  }

  // Async embedding pass for newly indexed docs — runs after sync FTS work
  for (const { id, content } of newlyIndexed) {
    await embedObservation(db, id, content);
  }

  const candidateSet = candidates;
  const existingPaths = db
    .prepare("SELECT source_path FROM observations")
    .all() as { source_path: string }[];
  let removed = 0;
  for (const row of existingPaths) {
    if (!candidateSet.has(row.source_path) || !existsSync(row.source_path)) {
      removeFile(db, row.source_path);
      removed++;
    }
  }

  const summary: ReindexSummary = {
    total: candidates.size,
    indexed,
    unchanged,
    skipped,
    removed,
    durationMs: Date.now() - start,
  };
  log("info", "fullReindex complete", { ...summary });
  return summary;
}

export function watchAll(
  db: Database.Database,
  config: IndexerConfig,
): FSWatcher {
  const dataRoot = resolve(config.dataRoot);
  const paths: string[] = [
    join(dataRoot, "agent"),
    join(dataRoot, "context"),
    join(dataRoot, "projects"),
    join(dataRoot, "episodes"),
  ];

  for (const watched of config.watchedProjects) {
    const projRoot = resolve(watched.path);
    const files = watched.files ?? ["CLAUDE.md", "README.md"];
    for (const f of files) {
      paths.push(join(projRoot, f));
    }
  }

  const watcher = chokidar.watch(paths, {
    ignored: (p: string) => {
      const norm = resolve(p);
      if (norm.includes("/archive/")) return true;
      if (basename(norm).startsWith("_legacy")) return true;
      // Episodes dir uses the broader `_*` skip — mirrors the fullReindex walk
      // filter so the watcher and the reindex pass stay symmetric.
      const episodesDir = resolve(dataRoot, "episodes");
      if (norm.startsWith(episodesDir + "/") && basename(norm).startsWith("_")) {
        return true;
      }
      return false;
    },
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    persistent: true,
  });

  const onChange = (p: string) => {
    if (!p.endsWith(".md")) return;
    void (async () => {
      try {
        const r = indexFile(db, p, config);
        log("info", "watcher event", { path: p, status: r.status });
        if (r.status === "indexed") {
          const row = db.prepare("SELECT id, content FROM observations WHERE source_path = ?").get(p) as { id: number; content: string } | undefined;
          if (row) await embedObservation(db, row.id, row.content);
        }
      } catch (err) {
        log("error", "watcher indexFile failed", {
          path: p,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  };

  watcher.on("add", onChange);
  watcher.on("change", onChange);
  watcher.on("unlink", (p: string) => {
    try {
      removeFile(db, p);
      log("info", "watcher unlink", { path: p });
    } catch (err) {
      log("error", "watcher removeFile failed", {
        path: p,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  watcher.on("error", (err: unknown) => {
    log("error", "watcher error", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return watcher;
}
