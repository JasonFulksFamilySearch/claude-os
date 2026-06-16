import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBaseline, writeBaseline, type Baseline } from "../src/scripts/eval.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-os-baseline-"));
  path = join(dir, "eval-baseline.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sample: Baseline = {
  captured_at: "2026-06-16T00:00:00.000Z",
  captured_on_ref: "abc1234",
  corpus: { db_path: "/x/memory.db", observation_count: 242 },
  presence: { mean_recall_at_k: 0.8, mrr: 0.7, k: 5 },
  absence: { absence_stage_2: { armed: false, pass_rate: null, n: 0 } },
};

describe("baseline round-trip", () => {
  it("readBaseline returns null when the file is absent", () => {
    expect(readBaseline(path)).toBeNull();
  });
  it("writeBaseline then readBaseline returns an equal object", () => {
    writeBaseline(path, sample);
    expect(existsSync(path)).toBe(true);
    expect(readBaseline(path)).toEqual(sample);
  });
});
