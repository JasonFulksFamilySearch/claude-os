import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { composeVerdict, safeCheck, type CheckResult } from "../src/doctor.js";

const r = (status: CheckResult["status"]): CheckResult =>
  ({ id: "x", status, detail: "", fixable: false });

describe("composeVerdict — FAIL > INCONCLUSIVE > PASS, ADVISORY excluded", () => {
  it("all PASS => PASS", () => {
    expect(composeVerdict([r("PASS"), r("PASS")])).toBe("PASS");
  });
  it("any FAIL => FAIL even with INCONCLUSIVE present", () => {
    expect(composeVerdict([r("PASS"), r("INCONCLUSIVE"), r("FAIL")])).toBe("FAIL");
  });
  it("any INCONCLUSIVE (no FAIL) => INCONCLUSIVE", () => {
    expect(composeVerdict([r("PASS"), r("INCONCLUSIVE")])).toBe("INCONCLUSIVE");
  });
  it("ADVISORY never reddens the verdict", () => {
    expect(composeVerdict([r("PASS"), r("ADVISORY")])).toBe("PASS");
  });
  it("a lone ADVISORY composes PASS", () => {
    expect(composeVerdict([r("ADVISORY")])).toBe("PASS");
  });
});

describe("THE HONESTY INVARIANT — a check that cannot run is INCONCLUSIVE, poisoning the verdict, never PASS", () => {
  it("safeCheck turns a thrown error into INCONCLUSIVE", async () => {
    const res = await safeCheck("eval/last-verdict", () => {
      throw new Error("eval subprocess exited 1");
    });
    expect(res.status).toBe("INCONCLUSIVE");
    expect(res.detail).toMatch(/eval subprocess exited 1/);
    expect(res.fixable).toBe(false);
  });
  it("an underlying op that throws makes the COMPOSED verdict INCONCLUSIVE while every other check passed", async () => {
    const broken = await safeCheck("corpus/integrity", () => {
      throw new Error("database is locked");
    });
    const verdict = composeVerdict([r("PASS"), r("PASS"), broken]);
    expect(verdict).toBe("INCONCLUSIVE");
    expect(verdict).not.toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Shared seed helper — used by Tasks 4–12
// ---------------------------------------------------------------------------
import { openDb } from "../src/db.js";
function seed(db: import("better-sqlite3").Database, paths: string[], type = "context"): void {
  const ins = db.prepare(`INSERT INTO observations
    (source_type, source_path, anchor, parent_title, project, topic, title, content, content_hash, file_mtime, indexed_at, frontmatter)
    VALUES (?, ?, '', NULL, NULL, NULL, 'T', 'body', ?, 1, 2, NULL)`);
  paths.forEach((p, i) => ins.run(type, p, "h" + i));
}

// ---------------------------------------------------------------------------
// Task 4: eval-gate checks
// ---------------------------------------------------------------------------
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkBaselinePresent, checkBaselineStale, checkCorpusSnapshot,
  checkBrokenLabels, checkLastVerdict,
} from "../src/doctor.js";

const evalRunner = (r: any) => () => Promise.resolve(r);

describe("eval-gate checks", () => {
  let dir: string, db: any, dbPath: string, baselinePath: string, labelsPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doctor-eval-"));
    dbPath = join(dir, "memory.db");
    db = openDb(dbPath);
    seed(db, ["/a.md", "/b.md", "/c.md"]);
    baselinePath = join(dir, "eval-baseline.json");
    labelsPath = join(dir, "labeled-queries.json");
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("baseline absent => INCONCLUSIVE, fixable", async () => {
    const res = await checkBaselinePresent({ baselinePath } as any);
    expect(res.status).toBe("INCONCLUSIVE");
    expect(res.fixable).toBe(true);
  });
  it("baseline present => PASS", async () => {
    writeFileSync(baselinePath, JSON.stringify({ corpus: { chunking_enabled: true } }));
    expect((await checkBaselinePresent({ baselinePath } as any)).status).toBe("PASS");
  });
  it("baseline chunking=false while live chunked => FAIL fixable by recapture-baseline", async () => {
    writeFileSync(baselinePath, JSON.stringify({ corpus: { chunking_enabled: false } }));
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('c2_chunking_enabled','1')").run();
    const res = await checkBaselineStale({ db, baselinePath } as any);
    expect(res.status).toBe("FAIL");
    expect(res.remediation?.id).toBe("recapture-baseline");
  });
  it("baseline chunking matches live => PASS (guard retired)", async () => {
    writeFileSync(baselinePath, JSON.stringify({ corpus: { chunking_enabled: true } }));
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('c2_chunking_enabled','1')").run();
    expect((await checkBaselineStale({ db, baselinePath } as any)).status).toBe("PASS");
  });
  it("corpus_snapshot mismatch vs live COUNT(DISTINCT) => FAIL fixable, names both numbers", async () => {
    writeFileSync(labelsPath, JSON.stringify({ curation: { corpus_snapshot: 387 } }));
    const res = await checkCorpusSnapshot({ db, labelsPath } as any);
    expect(res.status).toBe("FAIL");
    expect(res.detail).toMatch(/387/);
    expect(res.detail).toMatch(/\b3\b/);
    expect(res.remediation?.id).toBe("recompute-corpus-snapshot");
  });
  it("corpus_snapshot matching live => PASS", async () => {
    writeFileSync(labelsPath, JSON.stringify({ curation: { corpus_snapshot: 3 } }));
    expect((await checkCorpusSnapshot({ db, labelsPath } as any)).status).toBe("PASS");
  });
  it("a label matching 0 rows => INCONCLUSIVE fixable, names the dead query + substring", async () => {
    writeFileSync(labelsPath, JSON.stringify({ queries: [
      { query: "find a", expectedPathContains: ["/a.md"] },
      { query: "the pruned episode", expectedPathContains: ["episodes/2026-05-01"] },
    ]}));
    const res = await checkBrokenLabels({ db, labelsPath } as any);
    expect(res.status).toBe("INCONCLUSIVE");
    expect(res.fixable).toBe(true);
    expect(res.detail).toMatch(/the pruned episode/);
    expect(res.remediation?.id).toBe("drop-dead-label");
  });
  it("all labels resolve to >=1 row => PASS", async () => {
    writeFileSync(labelsPath, JSON.stringify({ queries: [{ query: "find a", expectedPathContains: ["/a.md"] }] }));
    expect((await checkBrokenLabels({ db, labelsPath } as any)).status).toBe("PASS");
  });
  it("eval PASS => PASS; FAIL => FAIL; INCONCLUSIVE => INCONCLUSIVE", async () => {
    expect((await checkLastVerdict({ runEval: evalRunner({ verdict: "PASS", ok: true }) } as any)).status).toBe("PASS");
    expect((await checkLastVerdict({ runEval: evalRunner({ verdict: "FAIL", ok: true }) } as any)).status).toBe("FAIL");
    expect((await checkLastVerdict({ runEval: evalRunner({ verdict: "INCONCLUSIVE", ok: true }) } as any)).status).toBe("INCONCLUSIVE");
  });
  it("AMENDMENT: eval CAPTURING => doctor INCONCLUSIVE, never PASS", async () => {
    const res = await checkLastVerdict({ runEval: evalRunner({ verdict: "CAPTURING", ok: true }) } as any);
    expect(res.status).toBe("INCONCLUSIVE");
    expect(res.status).not.toBe("PASS");
    expect(res.detail).toMatch(/baseline/i);
  });
  it("eval subprocess errored => INCONCLUSIVE with reason, never PASS", async () => {
    const res = await checkLastVerdict({ runEval: () => Promise.reject(new Error("eval exited 1")) } as any);
    expect(res.status).toBe("INCONCLUSIVE");
    expect(res.detail).toMatch(/eval exited 1/);
  });
  it("runner ok:false => INCONCLUSIVE", async () => {
    const res = await checkLastVerdict({ runEval: evalRunner({ verdict: "INCONCLUSIVE", ok: false, reason: "embedder failed" }) } as any);
    expect(res.status).toBe("INCONCLUSIVE");
    expect(res.detail).toMatch(/embedder failed/);
  });
});
