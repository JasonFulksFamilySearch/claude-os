# C2: Entry-Granular Indexing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change the memory index's retrieval unit from one-row-per-file to one-row-per-entry/chunk, so search points at the matching entry/section — shipped as code + unit tests with the behavior-changing cutover deferred behind a flag.

**Architecture:** A version-gated schema migration (run by `update.sh`, NOT on boot) rebuilds `observations` to a v3 shape that adds an `anchor` column and a `(source_path, anchor)` unique key — behavior-preserving (every surviving row keeps its id with `anchor=''`). The indexer/search code is **v3-only** (the anchor column is always present; the three `source_path`-identity sites become `(source_path, anchor)`-aware unconditionally). The behavior-changing **chunk-split** is gated behind a single persisted flag `c2_chunking_enabled` (default `'0'`), checked at exactly one chokepoint inside `indexFile`; with the flag off, every file yields exactly one `anchor=''` row (a true no-op — retrieval identical to today).

**Tech Stack:** TypeScript (ESM), better-sqlite3, sqlite-vec (vec0), FTS5 external-content, @huggingface/transformers (nomic-embed-text-v1.5, local), vitest.

## Global Constraints

- **Do NOT relocate `parseEntries`** — it stays exported from `mcp/src/novelty.ts:40-61` (consumed by `get_recent_learnings`, `append_learning`, `validate_experience_proposal`, `scan_novelty`). The chunker IMPORTS it and adds a parity test. (System Architect watch-item 1.)
- **Do NOT modify `mcp/src/search_config.ts`** — its weights are a HELD-OUT tuning target; touching them voids the eval gate. Ranking *logic* changes go in `ranking.ts`, never the constants.
- **Migration runs via `update.sh`, never in `openDb()`/on boot.** It must: back up via `VACUUM INTO` (WAL-safe; a file copy is torn under `journal_mode=WAL`); do the rebuild + FTS `'rebuild'` inside ONE transaction with `foreign_keys=OFF`; verify with `PRAGMA foreign_key_check` + `PRAGMA integrity_check` + an FTS known-term→known-rowid probe BEFORE advancing the version; abort-hard (never swallow-and-continue) on backup or verification failure.
- **Version precondition = DDL inspection (`PRAGMA table_info`) + `PRAGMA user_version`, NEVER the `meta.schema_version` marker** (it reads `'1'` on live, `db.ts:106` writes `'2'`, and no code has ever read it).
- **`vec_items` (vec0) ids must bind as `BigInt`** (`indexer.ts:212-213`); it has no FK, so id-preservation is the ONLY thing keeping vectors mapped.
- **The `c2_chunking_enabled` flag is checked at exactly ONE point: inside `indexFile`** (the chokepoint `watchAll` and `fullReindex` both flow through). Nowhere else.
- **DEFERRED (NOT in this run's verification, but code ships):** running the cutover against the live store; flipping `absence_stage_2` to `armed:true`; authoring real curated presence/Stage-2 queries. These wait for the human curation session.
- **No prettier pre-flight** — `mcp/` has no prettier/eslint config; TS style is hand-maintained and tsc-checked. Commit at the controller level with explicit `git add` of named files.
- Tests: vitest, temp-file DBs via `mkdtempSync(join(tmpdir(), ...))` + `openDb(dbPath)`, embedder mocked via `vi.mock("../src/embedder.js", ...)`. Mirror `mcp/test/indexer.test.ts` exactly.

---

## File Structure

**Create:**
- `mcp/src/chunker.ts` — pure chunking. `chunkFile(...)` → `Chunk[]`; imports `parseEntries` from `novelty.ts`; heading-split for long topic docs; anchor assignment. One responsibility: file text → ordered chunk set.
- `mcp/src/migrations.ts` — `runMigrations(db)`, `isV3Schema(db)`, the v3 rebuild, verification helpers. One responsibility: bring an existing DB to v3 safely.
- `mcp/src/scripts/migrate.ts` — operator entry point (called by `update.sh`): backup + `runMigrations` + logging.
- `mcp/src/scripts/cutover.ts` — DEFERRED chunk-split cutover (backup, flip flag, re-chunk via `fullReindex`, report). Ships; not run by `update.sh`.
- `mcp/src/result_shaper.ts` — `shapeResults(...)` pure function: collapse best chunk per section, ≤2 chunks/file, add `anchor`.
- `mcp/test/chunker.test.ts`, `mcp/test/migrations.test.ts`, `mcp/test/result_shaper.test.ts`.

**Modify:**
- `mcp/src/db.ts` — v3 fresh-DB schema (add `anchor TEXT NOT NULL DEFAULT ''`, `parent_title TEXT`; `UNIQUE(source_path, anchor)`); set `PRAGMA user_version = 3` on fresh create; `ObservationRow` gains `anchor`, `parent_title`.
- `mcp/src/index.ts` (or `openDb` in `db.ts`) — v3 fail-fast assertion after `initSchema`.
- `mcp/src/indexer.ts` — `indexFile` reconcile on `(source_path, anchor)`; `removeFile` deletes all rows for path; flag chokepoint; embed enriched text.
- `mcp/src/embedder.ts` — add `composeEmbedText(parentTitle, sectionTitle, content)`.
- `mcp/src/tools/search_memory.ts` — call `shapeResults`; add `anchor` to `SearchMemoryResult`; snippet from matching chunk.
- `mcp/src/ranking.ts` — exact-title bonus matches chunk title OR `parent_title`.
- `mcp/src/eval.ts`, `mcp/src/scripts/eval.ts` — **NOT modified this run.** Stage-2 entry-anchor resolution is deferred with the arming (Task 12); `absenceProbePass` keeps C1 substring behavior.
- `mcp/test/indexer.test.ts`, `mcp/test/db.test.ts` — extend for reconcile + v3 schema.
- `update.sh` — idempotent migrate step.
- `docs/2026-06-16-c2-entry-granular-indexing-prd.md` (PRD copy), `CLAUDE.md`, `README.md`, `docs/eval-gate-protocol.md`, agent `learnings.md` — post-impl docs.

---

### Task 1: v3 fresh-DB schema + `isV3Schema`

**Files:**
- Modify: `mcp/src/db.ts:19-109` (initSchema), `mcp/src/db.ts:120-132` (ObservationRow)
- Create: `mcp/src/migrations.ts` (isV3Schema only this task)
- Test: `mcp/test/db.test.ts`, `mcp/test/migrations.test.ts`

**Interfaces:**
- Produces: `observations` columns gain `anchor TEXT NOT NULL DEFAULT ''`, `parent_title TEXT`; table constraint `UNIQUE(source_path, anchor)` (replaces `UNIQUE(source_path)`). `isV3Schema(db: Database): boolean` — true iff `PRAGMA table_info(observations)` includes `anchor`. `ObservationRow` gains `anchor: string; parent_title: string | null`.

- [ ] **Step 1: Write failing tests** in `mcp/test/db.test.ts` (fresh DB) and `mcp/test/migrations.test.ts`:
```typescript
// db.test.ts
it("fresh DB has v3 observations schema", () => {
  const cols = db.prepare("PRAGMA table_info(observations)").all() as { name: string }[];
  expect(cols.map(c => c.name)).toContain("anchor");
  expect(cols.map(c => c.name)).toContain("parent_title");
  expect(db.pragma("user_version", { simple: true })).toBe(3);
});
it("fresh DB enforces (source_path, anchor) uniqueness, not source_path alone", () => {
  const ins = db.prepare(`INSERT INTO observations (source_type,source_path,anchor,content,content_hash,file_mtime,indexed_at) VALUES ('learning','/x.md',?, 'c','h',0,0)`);
  ins.run("");          // ok
  ins.run("2026-01-01");// same path, different anchor — must succeed
  expect(() => ins.run("")).toThrow(); // duplicate (path, '') — must fail
});
// migrations.test.ts
it("isV3Schema is true for a fresh DB", () => { expect(isV3Schema(db)).toBe(true); });
```
- [ ] **Step 2: Run — verify they fail.** `cd mcp && npx vitest run test/db.test.ts test/migrations.test.ts` → FAIL (no anchor column / isV3Schema undefined).
- [ ] **Step 3: Implement.** In `db.ts` initSchema: add `anchor TEXT NOT NULL DEFAULT ''` and `parent_title TEXT` to the `observations` CREATE, change `UNIQUE(source_path)` → `UNIQUE(source_path, anchor)`. Capture freshness BEFORE the CREATE: `const fresh = (db.prepare("PRAGMA table_info(observations)").all()).length === 0;` then after `db.exec(...)`: `if (fresh) db.pragma("user_version = 3");` — set user_version=3 ONLY on a fresh create, never unconditionally (an unconditional set would falsely mark an un-migrated v2 DB as v3). Note: `user_version` is a fast secondary marker only — the AUTHORITATIVE v3 gate everywhere is `isV3Schema` (the anchor-column DDL check, Task 2), so even a mis-set marker cannot cause v3-code-on-v2-schema. Add `anchor`/`parent_title` to `ObservationRow`. In `migrations.ts` add `export function isV3Schema(db){ return (db.prepare("PRAGMA table_info(observations)").all() as {name:string}[]).some(c => c.name === "anchor"); }`.
- [ ] **Step 4: Run — verify pass.** Same command → PASS.
- [ ] **Step 5: Commit.** `git add mcp/src/db.ts mcp/src/migrations.ts mcp/test/db.test.ts mcp/test/migrations.test.ts && git commit -m "feat(mcp): v3 observations schema with anchor column + isV3Schema"`

---

### Task 2: `openDb` v3 fail-fast assertion

**Files:** Modify `mcp/src/db.ts:9-17` (openDb). Test: `mcp/test/migrations.test.ts`.

**Interfaces:** Consumes `isV3Schema`. Produces: `openDb` throws a directive `Error` ("memory.db is pre-C2 … run `npm run migrate`") when an existing `observations` table is NOT v3. Fresh DBs (initSchema just created v3) pass.

- [ ] **Step 1: Failing test** — build a v2 DB (create observations WITHOUT anchor), then assert `openDb(path)` throws with /run `npm run migrate`/; assert a fresh `openDb` does NOT throw.
- [ ] **Step 2: Run — fails** (`openDb` currently never throws).
- [ ] **Step 3: Implement.** In `openDb`, after `initSchema(db)`: `if (!isV3Schema(db)) { throw new Error("memory.db schema is pre-C2 (no anchor column). Run `npm run migrate` to upgrade. The MCP server will not start against a v2 store."); }`. (initSchema's `CREATE IF NOT EXISTS` no-ops on an existing v2 table, so the column is genuinely absent there.)
- [ ] **Step 4: Run — passes.**
- [ ] **Step 5: Commit.** `feat(mcp): fail-fast in openDb when schema is pre-C2`

---

### Task 3: Migration framework — transactional v3 rebuild, backup, verify

**Files:** Modify `mcp/src/migrations.ts`. Test: `mcp/test/migrations.test.ts`.

**Interfaces:**
- Produces: `runMigrations(db: Database, opts?: { backupPath?: string }): { migrated: boolean }` — if `isV3Schema` already true, returns `{migrated:false}` (idempotent); else performs the rebuild and returns `{migrated:true}`. `backupDb(db, destPath): void` — `VACUUM INTO`, throws on failure. `verifyV3(db): void` — runs `PRAGMA foreign_key_check`, `PRAGMA integrity_check`, FTS probe; throws on any failure.

- [ ] **Step 1: Write failing tests** (fixture v2 DB → migrate → assert):
```typescript
function makeV2(dbPath: string) { /* open raw better-sqlite3, create v2 observations (UNIQUE(source_path), no anchor), FTS external-content + triggers, vec_items, access_stats; insert 2 rows with known ids 1,2; insert vec_items for both; insert access_stats(1, last, 5) */ }
it("migrates v2→v3 preserving every id", () => { const r = runMigrations(db); expect(r.migrated).toBe(true);
  expect(db.prepare("SELECT id FROM observations ORDER BY id").all().map(x=>x.id)).toEqual([1,2]);
  expect(isV3Schema(db)).toBe(true);
  expect(db.prepare("SELECT anchor FROM observations").all().every(x=>x.anchor==="")).toBe(true); });
it("preserves vec_items and access_stats by id", () => { runMigrations(db);
  expect(db.prepare("SELECT COUNT(*) c FROM vec_items").get().c).toBe(2);
  expect(db.prepare("SELECT access_count FROM access_stats WHERE observation_id=1").get().access_count).toBe(5); });
it("FTS returns pre-migration content after rebuild", () => { /* insert row content 'unicornfish' */ runMigrations(db);
  const hit = db.prepare("SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'unicornfish'").get();
  expect(hit.rowid).toBe(/* the known id */); });
it("is idempotent — second run is a no-op", () => { runMigrations(db); const r2 = runMigrations(db); expect(r2.migrated).toBe(false); });
it("backupDb writes a readable copy", () => { backupDb(db, backupPath); const c = openRaw(backupPath); expect(c.prepare("SELECT COUNT(*) c FROM observations").get().c).toBeGreaterThan(0); });
it("verifyV3 throws on a corrupted FTS mapping", () => { /* tamper, expect throw */ });
```
- [ ] **Step 2: Run — fail** (runMigrations undefined).
- [ ] **Step 3: Implement the rebuild.** Exact sequence (one transaction, FK off):
```typescript
export function runMigrations(db, opts = {}) {
  if (isV3Schema(db)) return { migrated: false };
  db.pragma("foreign_keys = OFF");
  const tx = db.transaction(() => {
    db.exec(`DROP TRIGGER IF EXISTS observations_ai; DROP TRIGGER IF EXISTS observations_ad; DROP TRIGGER IF EXISTS observations_au;`);
    db.exec(`CREATE TABLE observations_v3 ( id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL, source_path TEXT NOT NULL, project TEXT, topic TEXT, title TEXT, parent_title TEXT, anchor TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, content_hash TEXT NOT NULL, file_mtime INTEGER NOT NULL, indexed_at INTEGER NOT NULL, frontmatter TEXT, UNIQUE(source_path, anchor) );`);
    // explicit-id INSERT...SELECT — every id preserved; anchor='' default; parent_title NULL
    db.exec(`INSERT INTO observations_v3 (id,source_type,source_path,project,topic,title,content,content_hash,file_mtime,indexed_at,frontmatter) SELECT id,source_type,source_path,project,topic,title,content,content_hash,file_mtime,indexed_at,frontmatter FROM observations;`);
    db.exec(`DROP TABLE observations; ALTER TABLE observations_v3 RENAME TO observations;`);
    // recreate indexes + FTS external-content + triggers, then rebuild FTS INSIDE the txn
    db.exec(/* idx_obs_* CREATE INDEX statements */);
    db.exec(/* CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts ... ; recreate ai/ad/au triggers */);
    db.exec(`INSERT INTO observations_fts(observations_fts) VALUES('rebuild');`);
    db.pragma("user_version = 3");
  });
  tx();
  db.pragma("foreign_keys = ON");
  verifyV3(db);          // foreign_key_check + integrity_check + FTS probe; throws on failure
  return { migrated: true };
}
export function backupDb(db, destPath) { db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`); }
export function verifyV3(db) {
  const fk = db.prepare("PRAGMA foreign_key_check").all(); if (fk.length) throw new Error("FK check failed post-migration");
  const ic = db.pragma("integrity_check", { simple: true }); if (ic !== "ok") throw new Error("integrity_check failed: " + ic);
  // FTS probe: pick a known row, confirm its content is FTS-queryable at its rowid
  const row = db.prepare("SELECT id, content FROM observations LIMIT 1").get(); if (row) { const term = String(row.content).split(/\s+/).find(w => w.length > 3); if (term) { const m = db.prepare("SELECT rowid FROM observations_fts WHERE observations_fts MATCH ? LIMIT 1").get(term); if (!m) throw new Error("FTS probe failed — rebuild desynced"); } }
}
```
Note: `access_stats` and `vec_items` are NOT dropped — they key by `observation_id`; with ids byte-preserved they stay valid. FK off during the swap prevents the `access_stats` CASCADE from firing on `DROP observations`.
- [ ] **Step 4: Run — pass.** `cd mcp && npx vitest run test/migrations.test.ts`
- [ ] **Step 5: Commit.** `feat(mcp): transactional version-gated v2→v3 migration with backup + verify`

---

### Task 4: `migrate.ts` operator script + `update.sh` wiring

**Files:** Create `mcp/src/scripts/migrate.ts`; add `"migrate": "tsx src/scripts/migrate.ts"` to `mcp/package.json`; modify `update.sh`. Test: `mcp/test/migrations.test.ts` (smoke).

**Interfaces:** Consumes `openDb`-less raw open (the script opens the DB directly to avoid the v3 fail-fast), `backupDb`, `runMigrations`. Produces: `npm run migrate` → backs up to `~/.claude-data/memory.db.pre-c2.bak`, migrates, logs migrated/no-op; exit non-zero on backup or verify failure.

- [ ] **Step 1: Failing smoke test** — call the script's exported `main(dbPath, backupPath)` against a fixture v2 DB; assert it creates the backup and the DB becomes v3.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement.** `migrate.ts`: open raw `better-sqlite3` (NOT `openDb`, which would throw on v2), load sqlite-vec, `backupDb(db, backupPath)` (abort hard on throw), `runMigrations(db)`, log result. `update.sh`: after the MCP build step, add an idempotent block — if `~/.claude-data/memory.db` exists, run `(cd "$MCP_DIR" && npm run migrate)`; the script no-ops when already v3.
- [ ] **Step 4: Run — pass.**
- [ ] **Step 5: Commit.** `feat(mcp): migrate operator script + update.sh wiring (idempotent, backup-first)`

---

### Task 5: `chunker.ts` — whole-file chunk, `parseEntries` reuse, parity test

**Files:** Create `mcp/src/chunker.ts`, `mcp/test/chunker.test.ts`.

**Interfaces:**
- Consumes: `parseEntries` from `novelty.ts` (NOT relocated).
- Produces: `interface Chunk { anchor: string; title: string | null; parentTitle: string | null; content: string; }` and `chunkFile(args: { sourceType: SourceType; content: string; chunkingEnabled: boolean }): Chunk[]`. With `chunkingEnabled=false` → exactly one whole-file chunk `{ anchor: "", title: <existing title rule>, parentTitle: null, content }`.

- [ ] **Step 1: Failing tests:**
```typescript
it("flag off → single whole-file chunk with empty anchor", () => {
  const cs = chunkFile({ sourceType: "learning", content: "## 2026-01-01 — A\nx\n## 2026-01-02 — B\ny", chunkingEnabled: false });
  expect(cs).toHaveLength(1); expect(cs[0].anchor).toBe(""); });
it("parity: chunker entry set == novelty parseEntries for a learnings file (flag on)", () => {
  const md = "## 2026-01-01 — A\nx\n## 2026-01-02 — B\ny";
  const novelty = parseEntries(md);
  const cs = chunkFile({ sourceType: "learning", content: md, chunkingEnabled: true });
  expect(cs.map(c => c.anchor)).toEqual(novelty.map(e => e.date)); /* 1:1, same order */ });
```
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement** the whole-file path + the flag-on learnings/decisions path delegating to `parseEntries`; anchor = entry `date` (ordinal suffix `-2`, `-3` on same-date collisions); `title` = entry title; `parentTitle` = file H1. Leave heading-split (topics) as a stub returning whole-file for now (Task 6 fills it). Keep the existing whole-file `title` derivation identical to today's indexer behavior.
- [ ] **Step 4: Run — pass.**
- [ ] **Step 5: Commit.** `feat(mcp): chunker with parseEntries reuse + novelty parity test`

---

### Task 6: `chunker.ts` — heading-split for long topic docs + boundaries

**Files:** Modify `mcp/src/chunker.ts`, `mcp/test/chunker.test.ts`.

**Interfaces:** Produces: for `context`/`project_claude_md`/`project_readme` longer than ~2000 chars, heading-boundary splits targeting 400–512 tokens with 80–100 token overlap; anchor = slugified heading path; `parentTitle` = H1. Files ≤2000 chars and all `episode`/`agent` → whole-file.

- [ ] **Step 1: Failing golden-fixture tests** — dated-entry same-date collision (`-2` suffix); file without headings → whole-file; threshold boundary (1999 vs 2001 chars); heading split produces ≥2 chunks with slug anchors; adjacent heading chunks share overlap text.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement** heading-split (split on `^#{1,6} ` boundaries, pack to ~512-token target via a char≈4-tokens heuristic, carry 80–100 tokens overlap), slug anchors (`section-title` → `section-title`, dedupe with ordinal), threshold gate.
- [ ] **Step 4: Run — pass.**
- [ ] **Step 5: Commit.** `feat(mcp): heading-split chunking for long topic docs`

---

### Task 7: Indexer reconcile on `(source_path, anchor)` + flag chokepoint + BOTH embed paths

**Files:** Modify `mcp/src/indexer.ts` — `indexFile` upsert (~122-207), `removeFile` (~209-214), the `fullReindex` embed pass (~326-334), AND the `watchAll.onChange`/add embed read (~404-413, the single-row `.get()` at **`indexer.ts:411`**). Test: `mcp/test/indexer.test.ts`.

**Interfaces:**
- Consumes: `chunkFile` (T5/T6), `readFlag(db, "c2_chunking_enabled")` (a tiny meta reader; default `'0'`), existing `embedObservation`.
- Produces:
  - `indexFile(...)` reconciles the chunk set per `(source_path, anchor)` and returns `{ status: "indexed"|"unchanged"|..., changedAnchors: string[] }` (the anchors upserted this call — empty when unchanged).
  - `embedPathObservations(db, sourcePath, anchors?: string[]): Promise<void>` — selects `(id, content, title, parent_title, anchor)` rows for the path (only `anchors` if given, else all) and embeds EACH via `embedObservation`. THE single embed routine.
  - `indexAndEmbed(db, path, config): Promise<IndexResult>` — calls `indexFile`, then on `status==="indexed"` calls `embedPathObservations(db, path, result.changedAnchors)`. Both `watchAll.onChange` and the `add` handler call THIS (replacing the inline `.get()`+embed at `indexer.ts:411`), and `fullReindex` routes its post-index pass through `embedPathObservations` too — so chunk embedding lives in ONE place, not two.

**Why this is bigger than cycle-1 implied (Gate 2 / cycle-2 catch):** there are TWO production embed reads — `fullReindex` (~326) and the watcher `onChange` (`indexer.ts:411`) — and they share no helper today (`grep "WHERE source_path = ?"` → 144, 210, 326, 411). If only `fullReindex` is made multi-chunk, a learnings/topic file edited LIVE during a session embeds only one of its N chunks (the `.get()` returns one row), leaving N-1 chunks with no `vec_items` row → semantically unretrievable. That silently breaks US13 (per-chunk incremental re-embed) and US1/US3 (entry-pointed retrieval) on the watcher path once chunking is armed. Both reads must route through `embedPathObservations`.

- [ ] **Step 1: Failing tests** in `mcp/test/indexer.test.ts`:
```typescript
it("flag off → editing a learnings file keeps exactly one anchor='' row", () => { /* write 2-entry file, indexFile, assert 1 row anchor='' */ });
it("flag on → a 2-entry learnings file produces 2 anchored rows", () => { /* assert 2 rows, anchors = the two dates */ });
it("indexFile reports only the changed anchor on a single-entry edit (US13)", () => {
  /* flag on; index 2-entry file; edit entry B; */ const r = indexFile(db, p, config);
  expect(r.changedAnchors).toEqual(["2026-01-02"]); });
it("watcher path (indexAndEmbed) embeds ALL N chunks on first index", async () => {
  /* flag on; */ await indexAndEmbed(db, p, config);
  const vecCount = db.prepare("SELECT COUNT(*) c FROM vec_items v JOIN observations o ON o.id=v.observation_id WHERE o.source_path=?").get(p).c;
  expect(vecCount).toBe(2); /* both chunks embedded — would be 1 with the old single-row .get() */ });
it("watcher path re-embeds ONLY the changed chunk on edit (US13)", async () => {
  /* index, capture vec for A; edit B; */ await indexAndEmbed(db, p, config);
  /* assert embedObservation called once, for B's id only */ });
it("removeFile deletes ALL chunks for a path + their vec_items", () => { /* flag on, 2 rows; removeFile; assert 0 observations AND 0 vec_items for path */ });
it("fullReindex reconciles stale (path, anchor) pairs", () => { /* anchor removed from file → row + vec gone after fullReindex */ });
```
- [ ] **Step 2: Run — verify fail.** `cd mcp && npx vitest run test/indexer.test.ts`
- [ ] **Step 3: Implement.** Add `readFlag`. In `indexFile`: `const chunks = chunkFile({ sourceType, content, chunkingEnabled: readFlag(db,"c2_chunking_enabled")==="1" })` — **THE single flag chokepoint**. Replace the single-row upsert with reconcile: fetch existing `(anchor, content_hash)` for the path; upsert each chunk `ON CONFLICT(source_path, anchor)` hash-gated, accumulating `changedAnchors`; `DELETE` rows for the path whose anchor ∉ new set (collect their ids first to delete `vec_items` by `BigInt(id)`); return `{ status, changedAnchors }`. Add `embedPathObservations(db, path, anchors?)` (the ONE embed routine — embeds raw `content` via `embedObservation`; Task 8 changes only the embed-text composition inside `embedObservation`'s caller here). Add `indexAndEmbed`. Replace the inline embed at `indexer.ts:411` (watcher) and the add handler with `indexAndEmbed`; route `fullReindex`'s post-index pass through `embedPathObservations`. Update `removeFile` to select ALL ids for the path, delete each `vec_items` (BigInt id), then delete observations by path.
- [ ] **Step 4: Run — verify pass.** `cd mcp && npx vitest run test/indexer.test.ts`
- [ ] **Step 5: Commit.** `git add mcp/src/indexer.ts mcp/test/indexer.test.ts && git commit -m "feat(mcp): per-(path,anchor) reconcile + unified multi-chunk embed on both fullReindex and watcher paths (gated by c2_chunking_enabled)"`

---

### Task 8: Embedder contextual enrichment

**Files:** Modify `mcp/src/embedder.ts` (add composeEmbedText), `mcp/src/indexer.ts` (embedObservation call). Test: `mcp/test/embedder.test.ts`.

**Interfaces:**
- Consumes: `embedPathObservations` (T7, the single embed routine).
- Produces: `composeEmbedText(parentTitle: string|null, sectionTitle: string|null, content: string): string` — returns `content` UNCHANGED when `sectionTitle` is null/empty (whole-file row → byte-identical to today's `embedDocument(content)` input); else returns `\`${[parentTitle, sectionTitle].filter(Boolean).join(" > ")}\n\n${content}\``. `embedDocument` still prepends `DOC_PREFIX` (unchanged). The section-title is derived as `anchor === "" ? null : title` — so every whole-file row (always `anchor=''`) embeds content-only, making flag-off provably behavior-preserving.

- [ ] **Step 1: Failing tests** in `mcp/test/embedder.test.ts`:
```typescript
it("whole-file row (sectionTitle null) → composeEmbedText returns content unchanged", () => {
  expect(composeEmbedText("File H1", null, "body")).toBe("body"); }); // flag-off embeddings unchanged
it("chunk row → 'Parent > Section\\n\\ncontent'", () => {
  expect(composeEmbedText("File H1", "Section A", "body")).toBe("File H1 > Section A\n\nbody"); });
it("chunk row with null parent → 'Section\\n\\ncontent'", () => {
  expect(composeEmbedText(null, "Section A", "body")).toBe("Section A\n\nbody"); });
```
- [ ] **Step 2: Run — verify fail.** `cd mcp && npx vitest run test/embedder.test.ts`
- [ ] **Step 3: Implement** `composeEmbedText` in `embedder.ts`. In `embedPathObservations` (indexer.ts, from T7) change the per-row embed call to `embedObservation(db, row.id, composeEmbedText(row.parent_title, row.anchor === "" ? null : row.title, row.content))` — this single change covers BOTH the fullReindex and watcher embed paths (they share the routine). `embedObservation` itself is unchanged (it embeds the text it is given).
- [ ] **Step 4: Run — verify pass.** Also re-run `cd mcp && npx vitest run test/indexer.test.ts` to confirm T7's tests still hold with enriched text.
- [ ] **Step 5: Commit.** `git add mcp/src/embedder.ts mcp/src/indexer.ts mcp/test/embedder.test.ts && git commit -m "feat(mcp): contextual embedding enrichment for chunked rows (flag-off byte-identical)"`

---

### Task 9: `result_shaper.ts`

**Files:** Create `mcp/src/result_shaper.ts`, `mcp/test/result_shaper.test.ts`.

**Interfaces:** Produces: `shapeResults<T extends { source_path: string; anchor: string; score: number }>(ranked: T[], maxPerFile = 2): T[]` — keep best-scored per `(source_path, anchor)` (collapse siblings), then cap to `maxPerFile` per `source_path`, preserving score order.

- [ ] **Step 1: Failing tests:** two rows same `(path, anchor)` → best kept; three rows same path different anchors → top 2 by score; all `anchor=''` (one per path) → input returned unchanged (no-op); order preserved.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement** the pure function.
- [ ] **Step 4: Run — pass.**
- [ ] **Step 5: Commit.** `feat(mcp): result shaper — per-section collapse + per-file cap`

---

### Task 10: Wire shaper into `search_memory` + `anchor` on results

**Files:** Modify `mcp/src/tools/search_memory.ts` (SearchMemoryResult ~16-27, assembly ~149-202). Test: `mcp/test/tools.test.ts`.

**Interfaces:** Consumes `shapeResults`. Produces: `SearchMemoryResult` gains `anchor: string`. Results pass through `shapeResults` after ranking; snippet drawn from the matching chunk's content/FTS snippet.

- [ ] **Step 1: Failing tests:** result objects include `anchor`; with whole-file rows (all `anchor=''`) the result list is identical to pre-shaper order/content (no-op proof); a fixture with 3 chunks of one file returns ≤2.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement** — add `anchor` to the meta fetch + result mapping; apply `shapeResults` to the ranked candidates before final assembly.
- [ ] **Step 4: Run — pass.**
- [ ] **Step 5: Commit.** `feat(mcp): search_memory returns anchor + applies result shaper`

---

### Task 11: Exact-match bonus matches `parent_title`

**Files:** Modify `mcp/src/ranking.ts` (exact-title logic only). Test: `mcp/test/ranking.test.ts`. **Do NOT touch `search_config.ts`.**

**Interfaces:** Produces: the exact-title bonus fires when the query exactly matches the chunk `title` OR the `parent_title` (preserving whole-file behavior where `parent_title` is null and `title` is the file title).

- [ ] **Step 1: Failing test:** a chunk row whose `parent_title` equals the query earns the same exact-title bonus as a title match; weights pulled from `search_config` unchanged.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement** — extend the title-comparison in `ranking.ts` to also test `parent_title`; reuse `W_EXACT_TITLE` from `search_config` (import, do not redefine).
- [ ] **Step 4: Run — pass.**
- [ ] **Step 5: Commit.** `feat(mcp): exact-title bonus matches parent_title for chunked rows`

---

### Task 12: Stage-2 entry-anchor resolution — DEFERRED to the arming follow-on (NO code this run)

**Decision (Gate 2, cycle 5; confirmed with Sir):** the entry-anchor resolution code is **descoped from this run** — deferred together with the `armed:true` flip and the curation session, not shipped separately. `mcp/src/eval.ts`, `mcp/src/scripts/eval.ts`, and `eval/labeled-queries.json` are **UNCHANGED** this run; `absenceProbePass` keeps its C1 substring behavior (`eval.ts:57-62`).

**Why deferred (not just unscoped):** the gate established that correct entry-anchor *absence* semantics depend on the supersession-**retirement** lifecycle — `resolve_novelty_flag` (`resolve_novelty_flag.ts:20`) defines `superseded` as "the older entry has been retired," with the markdown edit done separately by the skill; once the entry leaves the file, the indexer reconcile (Task 7) **deletes** its anchored `observations` row, and only the `novelty_flags` record survives (`db.ts:86-100`, no FK to observations). So the resolver cannot key off a live observations row, and "absence" must be defined against an entry whose row may be gone. That semantics is only safely designable and testable against **real superseded data**, which exists at the curation/arming step. Building it now (three failed spec attempts proved this) commits to a lifecycle model with no real case to validate against.

**What the follow-on (arming) must do** (recorded here so the deferral is actionable):
1. Decide the resolution semantics: derive the forbidden anchor **deterministically from `entryDate`** (the date IS the dated-entry anchor) rather than by an observations lookup; define "pass" = that anchor is absent from top-k (which holds after retirement), "fail" = present, "inconclusive" only when the anchor genuinely cannot be derived.
2. Make `absenceProbePass` tri-state (`"pass"|"fail"|"inconclusive"`) and widen `aggregateAbsenceStage`'s second param to `ProbeOutcome[]` while preserving its `StageResult` object return + `armed`/`SKIPPED` branches (so `composeVerdict`/runner consumers are unchanged).
3. Thread top-k `anchor`s (now on `SearchMemoryResult` from Task 10) into the runner call site (`scripts/eval.ts`).
4. Flip `absence_stage_2.armed:true` and resolve its `forbidden` target against real superseded entries.

- [ ] **Step 1:** No implementation. Confirm `eval.ts`/`scripts/eval.ts`/`labeled-queries.json` are untouched by the C2 diff (`git diff --name-only master..HEAD` lists none of them). The follow-on spec above is captured in the docs task (Task 14) and the issue closeout.

---

### Task 13: `cutover.ts` deferred script (ships, not run)

**Files:** Create `mcp/src/scripts/cutover.ts`; add `"cutover": "tsx src/scripts/cutover.ts"` to `mcp/package.json`. Test: `mcp/test/migrations.test.ts` (re-chunk mechanics).

**Interfaces:** Produces: `runCutover(db, config): { rechunked: number }` — backup, set `meta.c2_chunking_enabled='1'`, `fullReindex` (now chunks), report. NOT wired into `update.sh`; NOT run in this PR.

- [ ] **Step 1: Failing test:** fixture DB with whole-file learnings rows → `runCutover` → that file now has N anchored rows; flag persisted `'1'`; idempotent on re-run.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement** `runCutover` (backup via `backupDb`, set flag, `fullReindex`). Header comment: DEFERRED — run only after the presence-query curation arms the eval gate and the baseline is captured (SA watch-item 3: baseline BEFORE flag flip).
- [ ] **Step 4: Run — pass.**
- [ ] **Step 5: Commit.** `feat(mcp): deferred chunk-split cutover script (not wired to update.sh)`

---

### Task 14: Documentation

**Files:** Create `docs/2026-06-16-c2-entry-granular-indexing-prd.md` (copy of the issue PRD); modify `CLAUDE.md` (eval-gate rule note on entry-granular rows + the migrate step), `README.md` (C-series: C2 shipped, cutover deferred), `docs/eval-gate-protocol.md` (cutover/baseline-before-flag note), agent `learnings.md` (the migration-not-on-boot decision).

- [ ] **Step 1:** Write the PRD copy + doc edits (no tests; docs task).
- [ ] **Step 2: Verify build + full suite still green.** `cd mcp && npx tsc --noEmit && npx vitest run`
- [ ] **Step 3: Commit.** `docs: C2 entry-granular indexing — PRD copy, eval-gate + cutover notes`

---

## Self-Review

**Spec coverage** (PRD §Implementation/Testing Decisions → task): chunking rules → T5/T6; shared parser reuse + parity → T5 (Global Constraint honored); anchor design → T5/T6; contextual enrichment → T8; migration mechanism → T3/T4; indexer reconcile → T7; result shaping → T9/T10; exact-match parent title → T11; untouched consumers → preserved (episodes whole-file via chunker whole-file path; novelty unaffected — parseEntries not relocated); cutover protocol → T13 (deferred); Stage-2 / US10 (entry-anchor resolution + arming) → FULLY deferred to the arming follow-on (T12 placeholder; `absenceProbePass` unchanged this run — descoped at Gate 2 cycle 5 because its semantics depend on the supersession-retirement lifecycle, best validated with real superseded data at arming). AI Scientist WARN (version gate) → T1/T2/T3 (DDL + user_version, not the marker). SA watch-items → 1: T5; 2: T3 (FTS probe + integrity_check); 3: T13 header.

**Placeholders:** Implementation bodies for the load-bearing/dangerous steps (migration SQL, reconcile, enrichment, shaper) carry full code; mechanical bodies carry exact signatures + behavior + real test assertions for a TDD implementer to drive. No "TBD"/"handle edge cases".

**Type consistency:** `Chunk` fields (`anchor`, `title`, `parentTitle`, `content`) consistent T5→T7; DB columns `anchor`/`parent_title` consistent T1→T10; `shapeResults` shape consistent T9→T10; `composeEmbedText` signature consistent T8→T7.

**Out of scope (PRD):** no embedding-model change; no ANN/rescore; no ranking-constant changes (T11 reuses, never edits, `search_config`); no episode chunking; no reinforcement changes.
