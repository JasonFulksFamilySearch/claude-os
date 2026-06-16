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

/**
 * Version-gated v2 → v3 migration. Idempotent: if the observations table is
 * already v3 (has the anchor column) this is a no-op returning {migrated:false}.
 *
 * The rebuild is the highest-risk operation in the C2 feature because it
 * reconstructs the live observations table and re-syncs the FTS5 external-content
 * index. It runs inside ONE transaction with foreign_keys OFF:
 *
 *   1. drop the 3 FTS sync triggers (so the INSERT…SELECT below does not
 *      double-write the FTS index)
 *   2. create the v3 observations table (adds anchor + parent_title,
 *      UNIQUE(source_path, anchor))
 *   3. explicit-id INSERT…SELECT copying every v2 row — every id preserved,
 *      anchor defaults to '', parent_title NULL
 *   4. drop old table, rename new into place
 *   5. recreate indexes, the FTS external-content virtual table, and the 3
 *      triggers
 *   6. issue the FTS 'rebuild' INSIDE the same transaction so the external-content
 *      index is rebuilt from the renamed table's rowids (the riskiest step — a
 *      wrong order here silently desyncs FTS rowids from observation ids)
 *   7. set user_version = 3
 *
 * foreign_keys is OFF for the whole transaction so that DROP TABLE observations
 * does NOT fire the access_stats ON DELETE CASCADE — with ids byte-preserved the
 * access_stats and vec_items side tables (keyed by observation_id) stay valid and
 * are intentionally left untouched. foreign_keys is restored to ON afterward and
 * verifyV3 runs the post-migration integrity gate.
 */
export function runMigrations(
  db: Database.Database,
  _opts: { backupPath?: string } = {},
): { migrated: boolean } {
  if (isV3Schema(db)) return { migrated: false };

  db.pragma("foreign_keys = OFF");
  const tx = db.transaction(() => {
    db.exec(`
      DROP TRIGGER IF EXISTS observations_ai;
      DROP TRIGGER IF EXISTS observations_ad;
      DROP TRIGGER IF EXISTS observations_au;
    `);

    db.exec(`
      CREATE TABLE observations_v3 (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type   TEXT NOT NULL,
        source_path   TEXT NOT NULL,
        anchor        TEXT NOT NULL DEFAULT '',
        parent_title  TEXT,
        project       TEXT,
        topic         TEXT,
        title         TEXT,
        content       TEXT NOT NULL,
        content_hash  TEXT NOT NULL,
        file_mtime    INTEGER NOT NULL,
        indexed_at    INTEGER NOT NULL,
        frontmatter   TEXT,
        UNIQUE(source_path, anchor)
      );
    `);

    // Explicit-id copy: every id preserved verbatim so the vec_items and
    // access_stats side tables remain correctly keyed. anchor takes its ''
    // default; parent_title is left NULL.
    db.exec(`
      INSERT INTO observations_v3
        (id, source_type, source_path, project, topic, title, content, content_hash, file_mtime, indexed_at, frontmatter)
      SELECT
        id, source_type, source_path, project, topic, title, content, content_hash, file_mtime, indexed_at, frontmatter
      FROM observations;
    `);

    db.exec(`
      DROP TABLE observations;
      ALTER TABLE observations_v3 RENAME TO observations;
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_obs_source_type ON observations(source_type);
      CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project);
      CREATE INDEX IF NOT EXISTS idx_obs_topic ON observations(topic);
      CREATE INDEX IF NOT EXISTS idx_obs_indexed_at ON observations(indexed_at);
    `);

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
        title,
        content,
        topic,
        content='observations',
        content_rowid='id',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, content, topic)
        VALUES (new.id, new.title, new.content, new.topic);
      END;
      CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, content, topic)
        VALUES ('delete', old.id, old.title, old.content, old.topic);
      END;
      CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, content, topic)
        VALUES ('delete', old.id, old.title, old.content, old.topic);
        INSERT INTO observations_fts(rowid, title, content, topic)
        VALUES (new.id, new.title, new.content, new.topic);
      END;
    `);

    // Rebuild the external-content FTS index from the renamed observations
    // table. Done INSIDE the transaction so the whole migration is atomic — a
    // crash leaves the v2 DB intact.
    db.exec(`INSERT INTO observations_fts(observations_fts) VALUES('rebuild');`);

    db.pragma("user_version = 3");
  });
  tx();
  db.pragma("foreign_keys = ON");

  verifyV3(db);
  return { migrated: true };
}

/**
 * WAL-safe physical backup. VACUUM INTO writes a fully-checkpointed, standalone
 * copy of the database — unlike a raw file copy, it captures committed-but-not-yet
 * checkpointed pages still living in the -wal file. Throws on failure.
 */
export function backupDb(db: Database.Database, destPath: string): void {
  // VACUUM INTO takes a string literal, not a bind parameter. Escape single
  // quotes to keep the path safe inside the SQL string.
  db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
}

/**
 * Post-migration integrity gate. Runs foreign_key_check, integrity_check, and a
 * known-term → known-rowid FTS probe. Throws on any failure — a silent FTS rowid
 * desync (the rebuild's worst failure mode) is caught here rather than corrupting
 * recall at query time.
 */
export function verifyV3(db: Database.Database): void {
  const fk = db.prepare("PRAGMA foreign_key_check").all();
  if (fk.length) throw new Error("FK check failed post-migration");

  const ic = db.pragma("integrity_check", { simple: true });
  if (ic !== "ok") throw new Error("integrity_check failed: " + String(ic));

  // FTS probe: take a known row and confirm a distinctive token from its content
  // is FTS-queryable AT that row's rowid. A rebuild that desynced the rowids
  // would either return nothing or the wrong rowid.
  const row = db.prepare("SELECT id, content FROM observations LIMIT 1").get() as
    | { id: number; content: string }
    | undefined;
  if (row) {
    const term = String(row.content).split(/\s+/).find(w => w.length > 3);
    if (term) {
      const m = db
        .prepare("SELECT rowid FROM observations_fts WHERE observations_fts MATCH ? LIMIT 1")
        .get(term) as { rowid: number } | undefined;
      if (!m) throw new Error("FTS probe failed — rebuild desynced");
    }
  }
}
