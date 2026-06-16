import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { isV3Schema } from "../src/migrations.js";

let workDir: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "claude-os-migrations-"));
  dbPath = join(workDir, "test.db");
  db = openDb(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("isV3Schema", () => {
  it("isV3Schema is true for a fresh DB", () => { expect(isV3Schema(db)).toBe(true); });
});
