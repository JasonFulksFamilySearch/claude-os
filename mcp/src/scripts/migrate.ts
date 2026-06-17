/**
 * Operator-run v2 → v3 migration script.
 *
 * Usage:
 *   npm run migrate
 *
 * Sequence:
 *   1. Open the database with a raw better-sqlite3 handle (NOT openDb — openDb
 *      throws on a pre-C2 schema by design; this script is the escape hatch).
 *   2. Backup via VACUUM INTO (abort hard on failure — no migration if backup fails).
 *   3. Run the idempotent v2 → v3 migration.
 *   4. Log whether the DB was migrated or was already v3.
 *
 * Exports `main(dbPath, backupPath)` for testability.
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { DEFAULT_DB_PATH } from "../db.js";
import { backupDb, runMigrations } from "../migrations.js";

/**
 * Exported entry point — parameterised so tests can drive it against fixture DBs.
 * The CLI entry below resolves defaults and calls this.
 */
export async function main(dbPath: string, backupPath: string): Promise<void> {
  // Open raw — not through openDb. openDb's fail-fast rejects v2 stores; that is
  // exactly the condition this script is designed to fix. Mirror the pragmas and
  // sqlite-vec load that openDb applies so runMigrations and verifyV3 have the
  // state they expect (WAL, foreign_keys, vec0 extension loaded).
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  sqliteVec.load(db);

  try {
    // --- Step 1: backup (abort hard on failure) ---
    console.log(`migrate: backing up ${dbPath} → ${backupPath}`);
    try {
      backupDb(db, backupPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`migrate: BACKUP FAILED — aborting (no migration applied): ${msg}`);
      process.exitCode = 1;
      return;
    }
    console.log("migrate: backup complete");

    // --- Step 2: migrate ---
    const { migrated } = runMigrations(db);
    if (migrated) {
      console.log("migrate: v2 → v3 migration applied successfully");
    } else {
      console.log("migrate: DB is already v3 — no migration needed (backup still written)");
    }
  } finally {
    db.close();
  }
}

// CLI entry: resolve defaults from environment / DEFAULT_DB_PATH, then run.
// The import.meta.url guard prevents this from firing when the module is
// imported by tests — it only executes when tsx runs this file directly.
import { fileURLToPath } from "node:url";
import { argv } from "node:process";

const isDirectEntry = argv[1] != null &&
  fileURLToPath(import.meta.url).endsWith(argv[1].replace(/\\/g, "/").split("/").pop() ?? "");

if (isDirectEntry) {
  const cliDbPath = process.env["CLAUDE_OS_DB_PATH"] ?? DEFAULT_DB_PATH;
  const cliBackupPath = cliDbPath + ".pre-c2.bak";

  main(cliDbPath, cliBackupPath).catch((err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error("migrate: unexpected error:", msg);
    process.exitCode = 1;
  });
}
