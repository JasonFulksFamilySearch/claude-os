import { describe, it, expect } from "vitest";
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
