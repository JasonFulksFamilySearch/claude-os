import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the embedder so no real model loads (prior art: test/indexer.test.ts).
vi.mock("../src/embedder.js", () => ({
  embedDocument: vi.fn().mockResolvedValue(new Float32Array(768).fill(0.1)),
  embedQuery: vi.fn().mockResolvedValue(new Float32Array(768).fill(0.1)),
  serializeVector: (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength),
  EMBEDDING_DIM: 768,
  MODEL_ID: "nomic-ai/nomic-embed-text-v1.5",
}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { setLogPath } from "../src/logger.js";
import { embedDocument, serializeVector } from "../src/embedder.js";
import { reembedAll } from "../src/reembed.js";

let workDir: string;
let dbPath: string;
let db: Database.Database;
let seq = 0;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "claude-os-reembed-"));
  setLogPath(join(workDir, "test.log"));
  dbPath = join(workDir, "test.db");
  db = openDb(dbPath);
  seq = 0;
  vi.mocked(embedDocument).mockReset();
  vi.mocked(embedDocument).mockResolvedValue(new Float32Array(768).fill(0.1));
});

afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

function insertObservation(overrides: Record<string, unknown> = {}): number {
  const now = Math.floor(Date.now() / 1000);
  seq++;
  const r = db
    .prepare(
      `INSERT INTO observations
        (source_type, source_path, project, topic, title, content, content_hash, file_mtime, indexed_at, frontmatter)
       VALUES
        (@source_type, @source_path, @project, @topic, @title, @content, @content_hash, @file_mtime, @indexed_at, @frontmatter)`,
    )
    .run({
      source_type: "context",
      source_path: `/tmp/o${seq}.md`,
      project: null,
      topic: "t",
      title: "T",
      content: "body",
      content_hash: `h${seq}`,
      file_mtime: now,
      indexed_at: now,
      frontmatter: null,
      ...overrides,
    });
  return Number(r.lastInsertRowid);
}

// sqlite-vec vec0 PK must be bound as BigInt (better-sqlite3 sends numbers as FLOAT).
function seedVector(id: number, fill: number): void {
  db.prepare("INSERT INTO vec_items(observation_id, embedding) VALUES (?, ?)").run(
    BigInt(id),
    serializeVector(new Float32Array(768).fill(fill)),
  );
}

function readVecRows(): { observation_id: number; embedding: Buffer }[] {
  return db
    .prepare("SELECT observation_id, embedding FROM vec_items ORDER BY observation_id")
    .all() as { observation_id: number; embedding: Buffer }[];
}

describe("reembedAll", () => {
  it("embeds every observation and reports cleared + reembedded counts", async () => {
    const ids = [
      insertObservation({ content: "alpha" }),
      insertObservation({ content: "beta" }),
      insertObservation({ content: "gamma" }),
    ];
    seedVector(ids[0], 0.9); // one stale vector to be cleared

    const result = await reembedAll(db);

    expect(result.reembedded).toBe(3);
    expect(result.cleared).toBe(1);
    expect(typeof result.durationMs).toBe("number");
    // Regression guard: the index is actually populated (this is what the old bug failed silently to do).
    const count = (db.prepare("SELECT count(*) AS c FROM vec_items").get() as { c: number }).c;
    expect(count).toBe(3);
  });

  it("is idempotent across repeated runs", async () => {
    insertObservation({ content: "alpha" });
    insertObservation({ content: "beta" });

    await reembedAll(db);
    const first = readVecRows();
    const second = await reembedAll(db);
    const after = readVecRows();

    expect(second.reembedded).toBe(2);
    expect(after.map((r) => r.observation_id)).toEqual(first.map((r) => r.observation_id));
    expect(after.every((r, i) => Buffer.compare(r.embedding, first[i].embedding) === 0)).toBe(true);
  });

  it("regenerates only vectors — observations and FTS are untouched", async () => {
    const id = insertObservation({ content: "checkstyle violations matter", source_path: "/tmp/c.md" });
    const obsBefore = db.prepare("SELECT * FROM observations ORDER BY id").all();

    await reembedAll(db);

    const obsAfter = db.prepare("SELECT * FROM observations ORDER BY id").all();
    expect(obsAfter).toEqual(obsBefore);
    const hits = db
      .prepare("SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?")
      .all("checkstyle") as { rowid: number }[];
    expect(hits.map((h) => h.rowid)).toContain(id);
  });

  it("leaves vec_items untouched when embedding fails in Phase A (no write attempted)", async () => {
    const ids = [
      insertObservation({ content: "a" }),
      insertObservation({ content: "b" }),
      insertObservation({ content: "c" }),
    ];
    for (const id of ids) seedVector(id, 0.7);

    // Throw during embedding (Phase A) — before the transaction opens.
    vi.mocked(embedDocument)
      .mockResolvedValueOnce(new Float32Array(768).fill(0.1))
      .mockRejectedValueOnce(new Error("embed boom"));

    await expect(reembedAll(db)).rejects.toThrow("embed boom");

    const rows = readVecRows();
    expect(rows.length).toBe(3);
    const old = serializeVector(new Float32Array(768).fill(0.7));
    expect(rows.every((r) => Buffer.compare(r.embedding, old) === 0)).toBe(true);
  });

  it("rolls back the swap when an insert fails inside the transaction (atomic clear+insert)", async () => {
    const ids = [
      insertObservation({ content: "a" }),
      insertObservation({ content: "b" }),
      insertObservation({ content: "c" }),
    ];
    for (const id of ids) seedVector(id, 0.7);

    // Phase A succeeds for all, but the 2nd vector has the wrong dimension, so the
    // INSERT throws *inside* the transaction (after the DELETE) — exercising rollback.
    vi.mocked(embedDocument)
      .mockResolvedValueOnce(new Float32Array(768).fill(0.1))
      .mockResolvedValueOnce(new Float32Array(4).fill(0.1))
      .mockResolvedValueOnce(new Float32Array(768).fill(0.1));

    await expect(reembedAll(db)).rejects.toThrow(/dimension mismatch/i);

    const rows = readVecRows();
    expect(rows.length).toBe(3);
    const old = serializeVector(new Float32Array(768).fill(0.7));
    expect(rows.every((r) => Buffer.compare(r.embedding, old) === 0)).toBe(true);
  });
});
