/**
 * DEFERRED chunk-split cutover script — DO NOT run this in automated setup.
 *
 * This script is intentionally NOT wired into update.sh. It must be run manually
 * by the operator ONLY after the following preconditions are met:
 *
 *   1. The presence-query curation pass has armed the eval gate
 *      (labeled-queries.json is curated and the eval harness is ready).
 *
 *   2. THE BASELINE IS CAPTURED FIRST. Run `npm run eval` on the pre-chunk index
 *      (flag still '0') and save the results. The non-regression check is vacuous
 *      if the baseline was not captured before the flag flip (SA watch-item 3).
 *
 *   3. Only after baseline capture: run `npm run cutover` to flip the flag,
 *      re-chunk all files, and re-embed. Then run `npm run eval` again to confirm
 *      PASS (non-regressing recall/MRR relative to the saved baseline).
 *
 * Sequence:
 *   1. Guard: if the backup file already exists, skip backup (idempotent re-run).
 *   2. Backup the DB via VACUUM INTO to `<db>.pre-cutover.bak`. Uses a DISTINCT
 *      path from migrate.ts's `.pre-c2.bak` to avoid a VACUUM INTO collision when
 *      both scripts have been run on the same machine.
 *   3. Set meta.c2_chunking_enabled = '1'.
 *   4. fullReindex: with the flag ON, indexFile now routes learning/decision files
 *      through chunkByEntries and large context/project docs through chunkByHeadings.
 *   5. Return { rechunked: N } — N is the count of files that were re-indexed
 *      (status "indexed") by fullReindex.
 *
 * Usage:
 *   npm run cutover
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { existsSync } from "node:fs";
import { DEFAULT_DB_PATH } from "../db.js";
import { backupDb } from "../migrations.js";
import { fullReindex, type IndexerConfig, defaultConfig } from "../indexer.js";

/**
 * Exported entry point — parameterised so tests can drive it against fixture DBs.
 *
 * @param db     Open better-sqlite3 handle (caller owns open/close).
 * @param config IndexerConfig passed to fullReindex.
 * @param backupPath  Override the backup destination (default: `<DEFAULT_DB_PATH>.pre-cutover.bak`).
 *                    The default is used only for the CLI entry; tests supply the fixture path.
 * @returns { rechunked } — count of files fullReindex reported as "indexed" (newly chunked).
 */
export async function runCutover(
  db: Database.Database,
  config: IndexerConfig,
  backupPath?: string,
): Promise<{ rechunked: number }> {
  // Resolve the backup path from the DB filename when not supplied.
  // In test usage, callers pass an explicit path derived from the fixture DB path.
  // In CLI usage, we derive it from DEFAULT_DB_PATH.
  const resolvedBackupPath = backupPath ?? (DEFAULT_DB_PATH + ".pre-cutover.bak");

  // --- Step 1: Backup (idempotent guard) ---
  // VACUUM INTO throws if the destination already exists — guard prevents the throw
  // on a second run (idempotency). A pre-existing backup means the operator already
  // ran this once; skip re-backup rather than fail.
  if (!existsSync(resolvedBackupPath)) {
    backupDb(db, resolvedBackupPath);
  }

  // --- Step 2: Flip the chunking flag ---
  db.prepare(
    "INSERT INTO meta(key, value) VALUES ('c2_chunking_enabled', '1') " +
    "ON CONFLICT(key) DO UPDATE SET value = '1'",
  ).run();

  // --- Step 3: Re-index (now chunks because the flag is on) ---
  const summary = await fullReindex(db, config);

  return { rechunked: summary.indexed };
}

// CLI entry: resolve defaults from environment / DEFAULT_DB_PATH, then run.
// The import.meta.url guard prevents this from firing when the module is
// imported by tests — it only executes when tsx runs this file directly.
import { fileURLToPath } from "node:url";
import { argv } from "node:process";

const isDirectEntry =
  argv[1] != null &&
  fileURLToPath(import.meta.url).endsWith(
    argv[1].replace(/\\/g, "/").split("/").pop() ?? "",
  );

if (isDirectEntry) {
  const cliDbPath = process.env["CLAUDE_OS_DB_PATH"] ?? DEFAULT_DB_PATH;
  const cliBackupPath = cliDbPath + ".pre-cutover.bak";

  const cliDb = new Database(cliDbPath);
  cliDb.pragma("journal_mode = WAL");
  cliDb.pragma("foreign_keys = ON");
  sqliteVec.load(cliDb);

  try {
    console.log("cutover: starting — backup, flag flip, fullReindex");
    console.log(`cutover: DB path: ${cliDbPath}`);
    console.log(`cutover: backup path: ${cliBackupPath}`);

    const result = await runCutover(cliDb, defaultConfig(), cliBackupPath);
    console.log(`cutover: complete — ${result.rechunked} files re-chunked`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error("cutover: unexpected error:", msg);
    process.exitCode = 1;
  } finally {
    cliDb.close();
  }
}
