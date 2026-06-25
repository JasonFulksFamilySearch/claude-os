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

// ---------------------------------------------------------------------------
// Task 5: index/cutover checks
// ---------------------------------------------------------------------------
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { checkChunkingMarker, checkSchemaCurrent, checkChunkShapeDivergence } from "../src/doctor.js";

const ONE_ENTRY = ["# L", "", "## 2026-01-10 — a", "", "body a", ""].join("\n");
const TWO_ENTRY = ["# L", "", "## 2026-01-10 — a", "", "body a", "", "## 2026-01-11 — b", "", "body b", ""].join("\n");

describe("index/cutover checks", () => {
  let dir: string, db: any, dbPath: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "doctor-idx-")); dbPath = join(dir, "memory.db"); db = openDb(dbPath); });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  function setMarker(on: boolean) { db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('c2_chunking_enabled',?)").run(on ? "1" : "0"); }
  function indexAnchors(sourceType: string, path: string, content: string, anchors: string[]) {
    writeFileSync(path, content, "utf8");
    const ins = db.prepare(`INSERT INTO observations (source_type,source_path,anchor,parent_title,project,topic,title,content,content_hash,file_mtime,indexed_at,frontmatter)
      VALUES (?,?,?,NULL,NULL,NULL,'T',?,?,1,2,NULL)`);
    anchors.forEach((a, i) => ins.run(sourceType, path, a, content, "h" + path + i));
  }

  it("marker on AND anchored rows exist => PASS", async () => {
    setMarker(true);
    db.prepare(`INSERT INTO observations (source_type,source_path,anchor,parent_title,project,topic,title,content,content_hash,file_mtime,indexed_at,frontmatter)
      VALUES ('learning','/l.md','2026-01-10',NULL,NULL,NULL,'T','b','h',1,2,NULL)`).run();
    expect((await checkChunkingMarker({ db } as any)).status).toBe("PASS");
  });
  it("marker claims chunked but NO anchored rows => FAIL", async () => {
    setMarker(true);
    const res = await checkChunkingMarker({ db } as any);
    expect(res.status).toBe("FAIL");
  });
  it("marker off and no anchored rows => PASS", async () => {
    setMarker(false);
    expect((await checkChunkingMarker({ db } as any)).status).toBe("PASS");
  });

  it("fresh v3 DB => schema current => PASS", async () => {
    expect((await checkSchemaCurrent({ db } as any)).status).toBe("PASS");
  });
  it("pre-C2 v2 DB (no anchor column) => FAIL fixable by run-migrate", async () => {
    const v2dir = mkdtempSync(join(tmpdir(), "doctor-v2-"));
    const v2 = new Database(join(v2dir, "v2.db"));
    v2.pragma("journal_mode = WAL"); sqliteVec.load(v2);
    v2.exec(`CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL,
      source_path TEXT NOT NULL, project TEXT, topic TEXT, title TEXT, frontmatter TEXT, content TEXT NOT NULL,
      content_hash TEXT NOT NULL, file_mtime INTEGER NOT NULL, indexed_at INTEGER NOT NULL, UNIQUE(source_path));`);
    try {
      const res = await checkSchemaCurrent({ db: v2 } as any);
      expect(res.status).toBe("FAIL");
      expect(res.remediation?.id).toBe("run-migrate");
    } finally { v2.close(); rmSync(v2dir, { recursive: true, force: true }); }
  });

  it("indexed anchors match chunkFile output => divergence 0 => PASS", async () => {
    setMarker(true);
    indexAnchors("learning", join(dir, "match.md"), TWO_ENTRY, ["2026-01-10", "2026-01-11"]);
    expect((await checkChunkShapeDivergence({ db } as any)).status).toBe("PASS");
  });
  it("an episode indexed whole-file (anchor '') does NOT count as divergence", async () => {
    setMarker(true);
    indexAnchors("episode", join(dir, "ep.md"), "# E\n\nsome episode body", [""]);
    expect((await checkChunkShapeDivergence({ db } as any)).status).toBe("PASS");
  });
  it("on-disk content grew a dated entry the index lacks => divergence 1 => FAIL, never claims cutover failed", async () => {
    setMarker(true);
    const p = join(dir, "drift.md");
    indexAnchors("learning", p, ONE_ENTRY, ["2026-01-10"]);
    writeFileSync(p, TWO_ENTRY, "utf8");
    const res = await checkChunkShapeDivergence({ db } as any);
    expect(res.status).toBe("FAIL");
    expect(res.detail).toMatch(/1\b/);
    expect(res.detail).not.toMatch(/cutover failed/i);
  });
});

// ---------------------------------------------------------------------------
// Task 6: corpus checks
// ---------------------------------------------------------------------------
import { mkdirSync } from "node:fs";
import { checkIntegrity, checkCorpusShape, checkOrphanEmbeddings, checkExpectedContextFiles } from "../src/doctor.js";

function vec(fill: number) { const v = new Float32Array(768).fill(fill); return Buffer.from(v.buffer, v.byteOffset, v.byteLength); }

describe("corpus checks", () => {
  let dir: string, db: any, dbPath: string, repoRoot: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doctor-corpus-")); dbPath = join(dir, "memory.db"); db = openDb(dbPath);
    repoRoot = join(dir, "repo"); mkdirSync(join(repoRoot, "context-templates"), { recursive: true });
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  function seedContext(name: string) {
    return db.prepare(`INSERT INTO observations (source_type,source_path,anchor,parent_title,project,topic,title,content,content_hash,file_mtime,indexed_at,frontmatter)
      VALUES ('context',?, '',NULL,NULL,NULL,'T','b',?,1,2,NULL)`).run("/data/context/" + name, "h" + name).lastInsertRowid;
  }

  it("integrity_check ok => PASS", async () => {
    expect((await checkIntegrity({ db } as any)).status).toBe("PASS");
  });
  it("empty corpus => FAIL", async () => {
    const res = await checkCorpusShape({ db } as any);
    expect(res.status).toBe("FAIL");
    expect(res.detail).toMatch(/empty/i);
  });
  it("non-empty corpus => PASS", async () => {
    seedContext("java.md"); seedContext("github.md");
    expect((await checkCorpusShape({ db } as any)).status).toBe("PASS");
  });
  it("every observation has a vec_items row => PASS", async () => {
    const id = seedContext("a.md");
    db.prepare("INSERT INTO vec_items(observation_id, embedding) VALUES (?,?)").run(BigInt(id), vec(0.1));
    expect((await checkOrphanEmbeddings({ db } as any)).status).toBe("PASS");
  });
  it("an observation with no vec_items row => FAIL fixable by re-embed", async () => {
    seedContext("a.md");
    const res = await checkOrphanEmbeddings({ db } as any);
    expect(res.status).toBe("FAIL");
    expect(res.remediation?.id).toBe("re-embed");
  });
  it("a template whose context copy is absent from the index => FAIL naming the missing file", async () => {
    writeFileSync(join(repoRoot, "context-templates", "java.md"), "x");
    writeFileSync(join(repoRoot, "context-templates", "github.md"), "x");
    seedContext("java.md");
    const res = await checkExpectedContextFiles({ db, repoRoot } as any);
    expect(res.status).toBe("FAIL");
    expect(res.detail).toMatch(/github\.md/);
  });
  it("every template present in the index => PASS", async () => {
    writeFileSync(join(repoRoot, "context-templates", "java.md"), "x");
    seedContext("java.md");
    expect((await checkExpectedContextFiles({ db, repoRoot } as any)).status).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Task 7: election / deps / backup / advisory checks
// ---------------------------------------------------------------------------
import { utimesSync } from "node:fs";
import { HEARTBEAT_REFRESH_MS, STALENESS_MULTIPLE } from "../src/election.js";
import {
  checkStaleLock, checkNpmAudit, checkBuild, checkTestSuite,
  checkBackupPresent, checkAdvisorySingleRowContext,
} from "../src/doctor.js";

const auditRunner = (r: any) => () => Promise.resolve(r);
const subRunner = (r: any) => () => Promise.resolve(r);

describe("election / deps / backup / advisory checks", () => {
  let dir: string, db: any, dbPath: string, lockPath: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "doctor-misc-")); dbPath = join(dir, "memory.db"); db = openDb(dbPath); lockPath = join(dir, "memory.db.writer.lock.d"); });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("no lock dir => PASS", async () => {
    expect((await checkStaleLock({ lockPath, now: 1_000_000 } as any)).status).toBe("PASS");
  });
  it("stale lock => FAIL fixable by clear-stale-lock", async () => {
    mkdirSync(lockPath);
    const now = 100 * HEARTBEAT_REFRESH_MS;
    const old = (now - (STALENESS_MULTIPLE * HEARTBEAT_REFRESH_MS + 5000)) / 1000;
    utimesSync(lockPath, old, old);
    const res = await checkStaleLock({ lockPath, now } as any);
    expect(res.status).toBe("FAIL");
    expect(res.remediation?.id).toBe("clear-stale-lock");
  });
  it("fresh lock => PASS", async () => {
    mkdirSync(lockPath);
    const now = 100 * HEARTBEAT_REFRESH_MS;
    utimesSync(lockPath, now / 1000, now / 1000);
    expect((await checkStaleLock({ lockPath, now } as any)).status).toBe("PASS");
  });

  it("npm audit with vulns => ADVISORY, never offers --force, names #84", async () => {
    const res = await checkNpmAudit({ runAudit: auditRunner({ ok: true, vulnerabilities: { critical: 1, high: 1, moderate: 0, low: 0 }, devOnly: true }) } as any);
    expect(res.status).toBe("ADVISORY");
    expect(res.fixable).toBe(false);
    expect(res.detail).toMatch(/1 critical/);
    expect(res.detail).toMatch(/#84/);
    expect(res.detail).not.toMatch(/--force/);
  });
  it("npm audit itself failed => INCONCLUSIVE, never PASS", async () => {
    expect((await checkNpmAudit({ runAudit: auditRunner({ ok: false, reason: "registry unreachable" }) } as any)).status).toBe("INCONCLUSIVE");
  });
  it("tsc/test are ADVISORY when --full off", async () => {
    expect((await checkBuild({ full: false } as any)).status).toBe("ADVISORY");
    expect((await checkTestSuite({ full: false } as any)).status).toBe("ADVISORY");
  });
  it("tsc passes under --full => PASS; test fails => FAIL; can't-run => INCONCLUSIVE", async () => {
    expect((await checkBuild({ full: true, runBuild: subRunner({ ok: true, passed: true }) } as any)).status).toBe("PASS");
    expect((await checkTestSuite({ full: true, runTest: subRunner({ ok: true, passed: false }) } as any)).status).toBe("FAIL");
    expect((await checkBuild({ full: true, runBuild: subRunner({ ok: false, passed: false, reason: "tsc missing" }) } as any)).status).toBe("INCONCLUSIVE");
  });

  it("a .pre-cutover backup present => PASS; a .pre-c2.bak => PASS; none => FAIL", async () => {
    writeFileSync(dbPath + ".pre-cutover.20260622T120000Z.bak", "x");
    expect((await checkBackupPresent({ dbPath } as any)).status).toBe("PASS");
    rmSync(dbPath + ".pre-cutover.20260622T120000Z.bak");
    writeFileSync(dbPath + ".pre-c2.bak", "x");
    expect((await checkBackupPresent({ dbPath } as any)).status).toBe("PASS");
    rmSync(dbPath + ".pre-c2.bak");
    expect((await checkBackupPresent({ dbPath } as any)).status).toBe("FAIL");
  });

  it("single-row context standing condition is ADVISORY, references #82", async () => {
    db.prepare(`INSERT INTO observations (source_type,source_path,anchor,parent_title,project,topic,title,content,content_hash,file_mtime,indexed_at,frontmatter)
      VALUES ('context','/data/context/tiny.md','',NULL,NULL,NULL,'T','b','h',1,2,NULL)`).run();
    const res = await checkAdvisorySingleRowContext({ db } as any);
    expect(res.status).toBe("ADVISORY");
    expect(res.detail).toMatch(/#82/);
  });
});

// ---------------------------------------------------------------------------
// Task 8: registry end-to-end composition
// ---------------------------------------------------------------------------
import { diagnose } from "../src/doctor.js";

// buildHealthyCtx assembles a fully-healthy DoctorContext in a fresh temp dir.
// Returns { ctx, cleanup } where cleanup closes the db and rmSyncs the temp dir.
function buildHealthyCtx(): { ctx: any; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "doctor-reg-"));
  const dbPath = join(dir, "memory.db");
  const db = openDb(dbPath);

  // Seed one context observation (source_type='context', source_path ends with the template name).
  const contextPath = "/data/context/java.md";
  const rowId = db.prepare(`INSERT INTO observations
    (source_type, source_path, anchor, parent_title, project, topic, title, content, content_hash, file_mtime, indexed_at, frontmatter)
    VALUES ('context', ?, '', NULL, NULL, NULL, 'T', 'body', 'h1', 1, 2, NULL)`)
    .run(contextPath).lastInsertRowid;

  // Each observation needs a vec_items row so orphan-embeddings PASSes.
  // vec_items requires an INTEGER primary key — use BigInt to match better-sqlite3's integer type.
  const embBuf = Buffer.from(new Float32Array(768).fill(0.1).buffer);
  db.prepare("INSERT INTO vec_items(observation_id, embedding) VALUES (?,?)").run(BigInt(rowId), embBuf);

  // Baseline: chunking_enabled=false (live index is also non-chunked), so stale check
  // sees isCutoverBoundary(false, false)=false → PASS.
  const baselinePath = join(dir, "eval-baseline.json");
  writeFileSync(baselinePath, JSON.stringify({ corpus: { chunking_enabled: false } }));

  // Labels: corpus_snapshot must equal distinctSourcePaths(db).length (= 1), and every
  // query must resolve to ≥1 row via resolveRelevantIds (instr on source_path).
  const labelsPath = join(dir, "labeled-queries.json");
  writeFileSync(labelsPath, JSON.stringify({
    curation: { corpus_snapshot: 1 },
    queries: [{ query: "find java", expectedPathContains: ["java.md"] }],
  }));

  // context-templates/ in repoRoot: one .md file matching the indexed observation.
  const repoRoot = join(dir, "repo");
  mkdirSync(join(repoRoot, "context-templates"), { recursive: true });
  writeFileSync(join(repoRoot, "context-templates", "java.md"), "# Java context");

  // Backup file: .pre-c2.bak present.
  writeFileSync(dbPath + ".pre-c2.bak", "backup");

  // lockPath: absent (no dir) → stale-lock PASS.
  const lockPath = join(dir, "memory.db.writer.lock.d");

  const ctx = {
    db,
    dbPath,
    baselinePath,
    labelsPath,
    lockPath,
    repoRoot,
    full: false,
    runEval: () => Promise.resolve({ verdict: "PASS" as const, ok: true }),
    runAudit: () => Promise.resolve({ ok: true, vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 } }),
    runBuild: () => Promise.resolve({ ok: true, passed: true }),
    runTest: () => Promise.resolve({ ok: true, passed: true }),
  };

  return {
    ctx,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe("registry end-to-end composition", () => {
  it("a fully healthy installation composes PASS", async () => {
    const { ctx, cleanup } = buildHealthyCtx();
    try { expect((await diagnose(ctx)).verdict).toBe("PASS"); } finally { cleanup(); }
  });

  it("HONESTY AT THE REGISTRY LEVEL: one un-runnable check (eval throws) drops the verdict to INCONCLUSIVE, not PASS", async () => {
    const { ctx, cleanup } = buildHealthyCtx();
    ctx.runEval = () => Promise.reject(new Error("eval exited 1"));
    try {
      const { results, verdict } = await diagnose(ctx);
      expect(verdict).toBe("INCONCLUSIVE");
      expect(verdict).not.toBe("PASS");
      expect(results.find((r) => r.id === "eval/last-verdict")?.status).toBe("INCONCLUSIVE");
      expect(results.filter((r) => r.status === "FAIL")).toHaveLength(0);
    } finally { cleanup(); }
  });

  it("a real FAIL (orphan embedding) composes FAIL, outranking any INCONCLUSIVE", async () => {
    const { ctx, cleanup } = buildHealthyCtx();
    ctx.db.prepare("DELETE FROM vec_items").run();
    try { expect((await diagnose(ctx)).verdict).toBe("FAIL"); } finally { cleanup(); }
  });
});
