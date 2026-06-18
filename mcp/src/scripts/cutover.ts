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
 *   1. Backup the DB via VACUUM INTO to a per-run timestamped destination
 *      `<db>.pre-cutover.<UTC-timestamp>.bak` (default), then VERIFY the snapshot
 *      (size floor, observation-count parity, integrity_check) — throwing before
 *      any mutation if it is incomplete. The timestamped path means a stale stub
 *      cannot suppress the backup and never collides with migrate.ts's `.pre-c2.bak`.
 *   2. Set meta.c2_chunking_enabled = '1'.
 *   3. fullReindex: with the flag ON, indexFile routes learning/decision files
 *      through chunkByEntries and large context/project docs through chunkByHeadings.
 *   4. Return { rechunked, backupPath } — rechunked is the count of re-indexed files;
 *      backupPath is the verified snapshot's path (logged for the rollback procedure).
 *
 * Usage:
 *   npm run cutover
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { DEFAULT_DB_PATH } from "../db.js";
import * as migrations from "../migrations.js";
import { fullReindex, type IndexerConfig, defaultConfig } from "../indexer.js";

/**
 * Exported entry point — parameterised so tests can drive it against fixture DBs.
 *
 * @param db     Open better-sqlite3 handle (caller owns open/close).
 * @param config IndexerConfig passed to fullReindex.
 * @param backupPath  Override the backup destination (default: timestamped path derived from `db.name`).
 *                    Tests inject an explicit path; only the default resolution is timestamped.
 * @returns { rechunked, backupPath } — rechunked is fullReindex's "indexed" count; backupPath is the verified snapshot.
 */
export async function runCutover(
  db: Database.Database,
  config: IndexerConfig,
  backupPath?: string,
): Promise<{ rechunked: number; backupPath: string }> {
  // Default the backup destination to a per-run TIMESTAMPED path derived from the
  // live DB's own filename. A stale file at the old fixed `<db>.pre-cutover.bak`
  // path can no longer suppress the backup (the destination is unique per run),
  // and the timestamp guarantees VACUUM INTO never collides. Tests inject an
  // explicit path; only the default resolution is timestamped.
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const resolvedBackupPath = backupPath ?? `${db.name}.pre-cutover.${ts}.bak`;

  // --- Step 1: Backup, then VERIFY before any mutation ---
  // Capture the live observation count on the untouched whole-file store; the
  // snapshot must match it. (This count is read pre-flip, so a file that a later
  // reindex would skip is counted identically on both sides and cannot perturb it.)
  const liveCount = (db.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n;
  migrations.backupDb(db, resolvedBackupPath);
  migrations.verifyBackup(resolvedBackupPath, liveCount); // throws → flag never flips, reindex never runs

  // --- Step 2: Flip the chunking flag ---
  db.prepare(
    "INSERT INTO meta(key, value) VALUES ('c2_chunking_enabled', '1') " +
    "ON CONFLICT(key) DO UPDATE SET value = '1'",
  ).run();

  // --- Step 3: Re-index (now chunks because the flag is on) ---
  const summary = await fullReindex(db, config);

  return { rechunked: summary.indexed, backupPath: resolvedBackupPath };
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

  const cliDb = new Database(cliDbPath);
  cliDb.pragma("journal_mode = WAL");
  cliDb.pragma("foreign_keys = ON");
  sqliteVec.load(cliDb);

  try {
    console.log("cutover: starting — backup, verify, flag flip, fullReindex");
    console.log(`cutover: DB path: ${cliDbPath}`);

    const result = await runCutover(cliDb, defaultConfig());
    console.log(`cutover: verified pre-cutover snapshot at ${result.backupPath}`);
    console.log(`cutover: complete — ${result.rechunked} files re-chunked`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error("cutover: unexpected error:", msg);
    process.exitCode = 1;
  } finally {
    cliDb.close();
  }
}
