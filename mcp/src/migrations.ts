import Database from "better-sqlite3";

/**
 * Returns true iff the observations table has the v3 `anchor` column.
 * This is the authoritative v3 schema check — more reliable than PRAGMA
 * user_version, which is only set on fresh creates and not on migrated DBs
 * until the v3 migration runs.
 */
export function isV3Schema(db: Database.Database): boolean {
  return (db.prepare("PRAGMA table_info(observations)").all() as { name: string }[])
    .some(c => c.name === "anchor");
}
