import Database from "better-sqlite3";
import chokidar, { FSWatcher } from "chokidar";
import { createHash } from "node:crypto";
import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { join, basename, dirname, relative, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import matter from "gray-matter";
import type { SourceType } from "./db.js";
import { log } from "./logger.js";
import { embedDocument, serializeVector, composeEmbedText } from "./embedder.js";
import { chunkFile } from "./chunker.js";

// THE single read of the c2_chunking_enabled flag lives in indexFile (the chokepoint).
// Default '0' (off) when the meta row is absent. No other call site reads the flag.
function readFlag(db: Database.Database, key: string): string {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? "0";
}

const MAX_FILE_BYTES = 1024 * 1024;

// Max orphan re-embeds attempted per sweep. A poisoned (permanently-failing) orphan costs
// one bounded attempt per sweep (named in the log), never a hot-loop; rows beyond the cap
// are the next sweep's work. (Within a single fullReindex a row that just failed the
// change-driven embed pass is also picked up here — that case sees two attempts in the run,
// not one — but each sweep itself attempts any given orphan at most once.)
export const MAX_VECTOR_SWEEP = 50;

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
    source_type, source_path, anchor, parent_title, project, topic, title,
    content, content_hash, file_mtime, indexed_at, frontmatter
  ) VALUES (
    @source_type, @source_path, @anchor, @parent_title, @project, @topic, @title,
    @content, @content_hash, @file_mtime, @indexed_at, @frontmatter
  )
  ON CONFLICT(source_path, anchor) DO UPDATE SET
    source_type  = excluded.source_type,
    parent_title = excluded.parent_title,
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
  SELECT anchor, content_hash FROM observations WHERE source_path = ?
`;

export interface IndexResult {
  status: "indexed" | "skipped_unchanged" | "skipped_unclassified" | "skipped_too_large" | "skipped_missing";
  source_path: string;
  // The anchors upserted (created or content-changed) on THIS call — drives the
  // targeted re-embed. Empty when nothing changed.
  changedAnchors: string[];
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
    return { status: "skipped_missing", source_path: absPath, changedAnchors: [] };
  }

  const cls = classify(absPath, config);
  if (!cls) {
    return { status: "skipped_unclassified", source_path: absPath, changedAnchors: [] };
  }

  const stat = statSync(absPath);
  if (stat.size > MAX_FILE_BYTES) {
    log("warn", "Skipping oversized file", { absPath, size: stat.size });
    return { status: "skipped_too_large", source_path: absPath, changedAnchors: [] };
  }

  const raw = readFileSync(absPath, "utf8");
  const { body, frontmatter, data } = parseFile(raw);

  const effectiveProject =
    cls.source_type === "episode"
      ? (typeof data.project === "string" && data.project.length > 0 ? data.project : null)
      : cls.project;

  // THE single flag chokepoint — no other site reads c2_chunking_enabled.
  const chunks = chunkFile({
    sourceType: cls.source_type,
    content: body,
    chunkingEnabled: readFlag(db, "c2_chunking_enabled") === "1",
  });

  const now = Math.floor(Date.now() / 1000);
  const fileMtime = Math.floor(stat.mtimeMs / 1000);
  const upsert = db.prepare(upsertSql);

  // Wrap the full reconcile read-modify-write in a single transaction so a throw
  // mid-reconcile rolls back atomically (no half-updated path, no orphaned vec_items).
  // Embedding is intentionally excluded — it happens later via embedPathObservations.
  const reconcile = db.transaction(() => {
    // Existing rows for this path, keyed by anchor → content_hash, so we can hash-gate
    // each chunk (skip byte-identical) and detect which anchors no longer exist.
    const existingRows = db.prepare(selectExistingSql).all(absPath) as {
      anchor: string;
      content_hash: string;
    }[];
    const existingByAnchor = new Map(existingRows.map((r) => [r.anchor, r.content_hash]));

    const changedAnchors: string[] = [];
    const newAnchors = new Set<string>();

    for (const chunk of chunks) {
      newAnchors.add(chunk.anchor);
      const chunkHash = sha256(chunk.content);
      if (existingByAnchor.get(chunk.anchor) === chunkHash) {
        continue; // unchanged — hash-gate skip
      }
      upsert.run({
        source_type: cls.source_type,
        source_path: absPath,
        anchor: chunk.anchor,
        // Title fallback lives HERE (the chunker has no sourcePath):
        // - Whole-file rows (anchor="") fall back to the file basename (preserves
        //   flag-off parity: a file with no H1 got the basename before chunking).
        // - Chunk rows (anchor!="") fall back to the anchor (the date/slug) so
        //   each chunk has a distinct, meaningful label in composeEmbedText;
        //   using basename here would collapse every chunk in the file to the
        //   same label and strip the section identity from enrichment.
        title: chunk.title ?? (chunk.anchor !== "" ? chunk.anchor : basename(absPath, ".md")),
        parent_title: chunk.parentTitle,
        project: effectiveProject,
        topic: cls.topic,
        content: chunk.content,
        content_hash: chunkHash,
        file_mtime: fileMtime,
        indexed_at: now,
        frontmatter,
      });
      changedAnchors.push(chunk.anchor);
    }

    // Reconcile: remove rows for this path whose anchor is no longer present in the
    // new chunk set (an entry was deleted or its anchor changed). Collect their ids
    // FIRST so we can delete their vec_items by BigInt id before the row vanishes.
    const staleIds = (
      db.prepare("SELECT id, anchor FROM observations WHERE source_path = ?").all(absPath) as {
        id: number;
        anchor: string;
      }[]
    )
      .filter((r) => !newAnchors.has(r.anchor))
      .map((r) => r.id);

    if (staleIds.length > 0) {
      const delVec = db.prepare("DELETE FROM vec_items WHERE observation_id = ?");
      const delObs = db.prepare("DELETE FROM observations WHERE id = ?");
      for (const id of staleIds) {
        // BigInt: sqlite-vec vec0 PKs must bind as INTEGER; better-sqlite3 sends numbers as FLOAT.
        delVec.run(BigInt(id));
        delObs.run(id);
      }
    }

    return { changedAnchors, staleCount: staleIds.length };
  });

  const { changedAnchors, staleCount } = reconcile();

  // "indexed" when anything changed (a chunk upserted OR a stale row pruned);
  // otherwise the file is byte-for-byte the same set we already hold.
  if (changedAnchors.length === 0 && staleCount === 0) {
    return { status: "skipped_unchanged", source_path: absPath, changedAnchors: [] };
  }

  return { status: "indexed", source_path: absPath, changedAnchors };
}

export function removeFile(db: Database.Database, absPath: string): void {
  // Select ALL ids for the path (a chunked file holds N rows), delete each row's
  // vec_items by BigInt id, then delete every observation for the path.
  const ids = (
    db.prepare("SELECT id FROM observations WHERE source_path = ?").all(absPath) as {
      id: number;
    }[]
  ).map((r) => r.id);
  db.prepare("DELETE FROM observations WHERE source_path = ?").run(absPath);
  // BigInt: sqlite-vec vec0 PKs must bind as INTEGER; better-sqlite3 sends numbers as FLOAT.
  const delVec = db.prepare("DELETE FROM vec_items WHERE observation_id = ?");
  for (const id of ids) delVec.run(BigInt(id));
}

export async function embedObservation(
  db: Database.Database,
  id: number,
  content: string,
): Promise<void> {
  // Callers (fullReindex / the watcher) invoke this ONLY for newly-indexed or content-CHANGED
  // files (status "indexed") — never for unchanged ones — so always (re)compute the vector and
  // overwrite any prior row, which refreshes a stale vector when a file's body changed. Do NOT
  // early-return on an existing row: on a content change the prior (now stale) vec_items row still
  // exists, and the refresh must overwrite it rather than be skipped.
  // BigInt: sqlite-vec vec0 PKs must bind as INTEGER; better-sqlite3 sends numbers as FLOAT.
  try {
    const vector = await embedDocument(content);
    const bytes = serializeVector(vector);
    // Delete-then-insert in one transaction: the vec0 virtual table does not reliably honor
    // INSERT OR REPLACE on an existing PK, so a re-embed of changed content must remove the prior
    // (stale) row first. The transaction keeps the two writes atomic, so a failure between them
    // cannot orphan the observation's vector (mirrors reembedAll's swap).
    const swap = db.transaction((b: Buffer) => {
      db.prepare("DELETE FROM vec_items WHERE observation_id = ?").run(BigInt(id));
      db.prepare("INSERT INTO vec_items(observation_id, embedding) VALUES (?, ?)").run(BigInt(id), b);
    });
    swap(bytes);
  } catch (err) {
    log("error", "embedObservation failed", {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// THE single embed routine for a file's observations. Selects the rows for the path
// (only the given anchors when supplied — the targeted incremental re-embed; else
// every row for the path) and embeds each via embedObservation. Both production embed
// callers (fullReindex's post-index pass and the watcher's onChange) route through here,
// so a chunked file embeds ALL N of its chunks — never just the one a single-row .get()
// would have returned.
export async function embedPathObservations(
  db: Database.Database,
  sourcePath: string,
  anchors?: string[],
): Promise<void> {
  let rows: { id: number; content: string; title: string | null; parent_title: string | null; anchor: string }[];
  if (anchors && anchors.length > 0) {
    const placeholders = anchors.map(() => "?").join(", ");
    rows = db
      .prepare(
        `SELECT id, content, title, parent_title, anchor FROM observations
         WHERE source_path = ? AND anchor IN (${placeholders})`,
      )
      .all(sourcePath, ...anchors) as { id: number; content: string; title: string | null; parent_title: string | null; anchor: string }[];
  } else if (anchors && anchors.length === 0) {
    // anchors=[] → embed nothing: a stale-only prune yields status:"indexed" with empty
    // changedAnchors, and the deleted rows' vec_items were already removed in indexFile.
    return;
  } else {
    // anchors=undefined → embed all rows for the path (full path re-embed).
    rows = db
      .prepare(
        "SELECT id, content, title, parent_title, anchor FROM observations WHERE source_path = ?",
      )
      .all(sourcePath) as { id: number; content: string; title: string | null; parent_title: string | null; anchor: string }[];
  }

  for (const row of rows) {
    // Whole-file rows (anchor="") embed raw content — byte-identical to pre-chunking.
    // Chunked rows (anchor != "") embed contextually enriched text: title context
    // prepended so search can match on heading terms in addition to body content.
    await embedObservation(db, row.id, composeEmbedText(row.parent_title, row.anchor === "" ? null : row.title, row.content));
  }
}

// Index a file and, when its content changed, embed the changed chunks. THE single
// entry point used by the watcher (add/change) so the inline single-row read at the
// old watcher site is gone — a live-edited chunked file embeds every changed chunk.
export async function indexAndEmbed(
  db: Database.Database,
  absPath: string,
  config: IndexerConfig,
): Promise<IndexResult> {
  const result = indexFile(db, absPath, config);
  if (result.status === "indexed") {
    await embedPathObservations(db, absPath, result.changedAnchors);
  }
  return result;
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
  errored: number;
  removed: number;
  durationMs: number;
  vecMissingBefore: number;
  vecMissingAfter: number;
  erroredPaths: string[];
}

/** Count observations that have no vec_items row (orphaned embeddings). */
export function countMissingVectors(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT count(*) AS c
         FROM observations o
         LEFT JOIN vec_items v ON o.id = v.observation_id
        WHERE v.observation_id IS NULL`,
    )
    .get() as { c: number };
  return row.c;
}

export interface CoverageSweepResult {
  /** Orphan count before the sweep. */
  before: number;
  /** Orphans successfully re-embedded this sweep (bounded by MAX_VECTOR_SWEEP). */
  healed: number;
  /** Orphan count after the sweep (remaining work + any permanently-failing rows). */
  after: number;
}

/**
 * Self-healing pass: re-embed observations that have no vec_items row, bounded per sweep.
 * Reuses embedObservation (its catch-log-drop is unchanged; THIS sweep is the retry, so a
 * transient embed failure self-heals next cycle). A permanently-failing row costs one
 * bounded attempt per sweep and is named in the warn log rather than hot-looped.
 */
export async function vectorCoverageSweep(
  db: Database.Database,
): Promise<CoverageSweepResult> {
  const before = countMissingVectors(db);
  if (before === 0) return { before: 0, healed: 0, after: 0 };

  const orphans = db
    .prepare(
      `SELECT o.id, o.content, o.title, o.parent_title, o.anchor
         FROM observations o
         LEFT JOIN vec_items v ON o.id = v.observation_id
        WHERE v.observation_id IS NULL
        ORDER BY o.id
        LIMIT ?`,
    )
    .all(MAX_VECTOR_SWEEP) as {
    id: number;
    content: string;
    title: string | null;
    parent_title: string | null;
    anchor: string;
  }[];

  for (const { id, content, title, parent_title, anchor } of orphans) {
    // Failures are swallowed inside embedObservation (catch-log-drop); the sweep is the retry.
    // Compose embed text identically to embedPathObservations so a healed orphan's vector
    // matches what the change-driven path produces — raw for whole-file rows (anchor=""),
    // title-enriched for chunk rows. Embedding raw content here would let re-embedded
    // orphans drift from the live index.
    await embedObservation(
      db,
      id,
      composeEmbedText(parent_title, anchor === "" ? null : title, content),
    );
  }

  const after = countMissingVectors(db);
  const healed = before - after;

  if (after > 0) {
    // Name the rows still missing (capped log) so a poisoned input is debuggable. Include the
    // anchor: post-C2 a chunked file holds multiple rows per path, so source_path alone cannot
    // identify which specific row is poisoned.
    const stillMissing = db
      .prepare(
        `SELECT o.source_path, o.anchor
           FROM observations o
           LEFT JOIN vec_items v ON o.id = v.observation_id
          WHERE v.observation_id IS NULL
          ORDER BY o.id
          LIMIT 20`,
      )
      .all() as { source_path: string; anchor: string }[];
    log("warn", "vectorCoverageSweep: observations still missing vectors", {
      remaining: after,
      rows: stillMissing.map((r) => ({ source_path: r.source_path, anchor: r.anchor })),
    });
  }

  return { before, healed, after };
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
  let errored = 0;
  const erroredPaths: string[] = [];
  // Per-path changed anchors — drives the targeted multi-chunk embed pass below.
  const newlyIndexed: Array<{ path: string; changedAnchors: string[] }> = [];

  for (const file of candidates) {
    try {
      const r = indexFile(db, file, config);
      if (r.status === "indexed") {
        indexed++;
        newlyIndexed.push({ path: file, changedAnchors: r.changedAnchors });
      } else if (r.status === "skipped_unchanged") unchanged++;
      else skipped++;
    } catch (err) {
      errored++;
      erroredPaths.push(file);
      log("error", "fullReindex skipped file (parse/index failed)", {
        path: file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Async embedding pass for newly indexed docs — runs after sync FTS work.
  // Routes through embedPathObservations (THE single embed routine) so a chunked
  // file embeds every changed chunk, identically to the watcher path.
  for (const { path, changedAnchors } of newlyIndexed) {
    await embedPathObservations(db, path, changedAnchors);
  }

  // Self-healing coverage pass: repair any observation missing its vector (a past terminal
  // embed failure that no change-driven pass would ever touch). Bounded per sweep.
  const coverage = await vectorCoverageSweep(db);

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

  // vecMissingAfter reflects the FINAL DB state — recomputed after the removal pass. Removals
  // can delete orphaned observations the sweep could not heal (e.g. a poisoned row whose file
  // is now gone), so coverage.after — measured before removals — would overstate the holes
  // remaining in the reported summary.
  const vecMissingAfter = countMissingVectors(db);

  const summary: ReindexSummary = {
    total: candidates.size,
    indexed,
    unchanged,
    skipped,
    errored,
    removed,
    durationMs: Date.now() - start,
    vecMissingBefore: coverage.before,
    vecMissingAfter,
    erroredPaths,
  };
  log("info", "fullReindex complete", { ...summary });
  return summary;
}

// Watcher ignore predicate, extracted behavior-for-behavior from watchAll's inline
// arrow so it can be unit-asserted (it recomputes dataRoot, which the arrow captured
// from its enclosing scope). Three branches: archive paths, _legacy* basenames, and
// underscore-prefixed files under episodes/ (mirrors the fullReindex walk filters).
export function isWatchIgnored(p: string, config: IndexerConfig): boolean {
  const dataRoot = resolve(config.dataRoot);
  const norm = resolve(p);
  if (norm.includes("/archive/")) return true;
  if (basename(norm).startsWith("_legacy")) return true;
  const episodesDir = resolve(dataRoot, "episodes");
  if (norm.startsWith(episodesDir + "/") && basename(norm).startsWith("_")) {
    return true;
  }
  return false;
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
    ignored: (p: string) => isWatchIgnored(p, config),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    persistent: true,
  });

  const onChange = (p: string) => {
    if (!p.endsWith(".md")) return;
    void (async () => {
      try {
        // indexAndEmbed routes both index + multi-chunk embed through ONE path, so a
        // live-edited chunked file embeds every changed chunk (not just one row).
        const r = await indexAndEmbed(db, p, config);
        log("info", "watcher event", { path: p, status: r.status });
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
