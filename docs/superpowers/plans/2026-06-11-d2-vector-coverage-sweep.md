# D2: Vector-Integrity Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the semantic index self-healing — `fullReindex` detects observations missing their `vec_items` row and re-embeds them, bounded per sweep, with coverage reported in the reindex summary.

**Architecture:** Add a coverage-sweep pass to `fullReindex` (in `mcp/src/indexer.ts`) that runs *after* the existing change-driven embedding step and *before* the removal pass. The sweep finds orphans via `observations LEFT JOIN vec_items ... WHERE vec_items.observation_id IS NULL`, re-embeds up to a bounded count through the existing `embedObservation` path (whose delete-then-insert transaction is already idempotent and retry-safe), and surfaces `vec_missing_before` / `vec_missing_after` on the `ReindexSummary`. No schema change, no retrieval change, no new write path.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), better-sqlite3, sqlite-vec (vec0 virtual table), Vitest 2.x (`vitest run`). Embedder is mocked in tests (no 270MB model load) following the established `test/indexer.test.ts` / `test/reembed.test.ts` pattern.

---

## Source of Truth

This plan implements the PRD in **GitHub issue #33** (`feat: vector-integrity reconciliation — orphan-vector coverage sweep in the reindex backstop (D2)`). The PRD's five Implementation Decisions and five Testing Decisions are the requirement set. Verified against the live code on 2026-06-11:
- `embedObservation` catch-log-drops failures: `indexer.ts:227-244` ✅
- `fullReindex` embeds only `newlyIndexed` (changed) rows, never repairs orphans: `indexer.ts:317-335` ✅
- Live orphans on this machine: 3 of 250 observations (ids 14/15/16 — `context/jira.md`, `github.md`, `java.md`) ✅
- `vec_items` schema: `vec0(observation_id INTEGER PRIMARY KEY, embedding FLOAT[768])` — `db.ts:66-69` ✅

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `mcp/src/indexer.ts` | Modify | Add `MAX_VECTOR_SWEEP` const, `countMissingVectors()` helper, `vectorCoverageSweep()` function; extend `ReindexSummary` with `vecMissingBefore`/`vecMissingAfter`; call the sweep inside `fullReindex` after the existing embedding pass (after current line 335). |
| `mcp/test/indexer.test.ts` | Modify | Add a `describe("vectorCoverageSweep")` block with the five behavior tests from the PRD's Testing Decisions. Reuses the file's existing embedder mock, temp-`dataRoot` harness, and `fullReindex(db, config)` integration entry point. |

No new files — the sweep is a cohesive addition to the existing indexer module, and the test belongs in the existing indexer suite (closest analog: the `embedObservation freshness` block already in `indexer.test.ts`).

---

## Design Decisions (locked before tasks)

1. **Cap = attempts per sweep, not a failure.** `MAX_VECTOR_SWEEP = 50`. The orphan query is `LIMIT`-ed to this. Rows beyond the cap are simply next sweep's work — `vecMissingAfter > 0` is a normal, reported state, not an error. (PRD Decision 2: "51 missing → 50 healed, 1 reported".)
2. **Reuse `embedObservation` unchanged.** The sweep calls the existing `embedObservation(db, id, content)`. Its `catch`-log behavior is unchanged; the *sweep itself is the retry*, so a transient failure self-heals next cycle by construction. A permanently-failing row consumes exactly one bounded attempt per sweep and is named in the log (PRD Decisions 1 & 2).
3. **Two coverage numbers.** `vecMissingBefore` = orphan count before the sweep; `vecMissingAfter` = orphan count after. Both added to `ReindexSummary` and logged in the existing `fullReindex complete` line (PRD Decision 3 — the subsystem's first health metric).
4. **Named-failure log line.** After the sweep, if any rows remain orphaned, log a `warn` naming up to the first N source_paths so a poisoned input is debuggable rather than silent (PRD User Story 3).
5. **No behavior change elsewhere.** No schema, no retrieval, no ranking, no new write path (PRD Decision 4).

---

## Task 1: Add the missing-vector count helper

**Files:**
- Modify: `mcp/src/indexer.ts` (add helper + `MAX_VECTOR_SWEEP` const near the other module constants/top of file)
- Test: `mcp/test/indexer.test.ts` (new `describe` block)

- [ ] **Step 1: Write the failing test**

Add to `mcp/test/indexer.test.ts` (the existing embedder mock, `beforeEach`/`afterEach`, and `vi`/`writeFileSync`/`join` imports already cover this). Import symbols **as each task introduces them** — this task uses only `countMissingVectors` (and `serializeVector` for the `seedVec` helper); Task 2 adds `vectorCoverageSweep` + `MAX_VECTOR_SWEEP` to the same import line when it introduces tests that use them. (Staging the imports keeps an intermediate `tsc --noEmit` clean between tasks — `vitest run` itself is esbuild-transformed and does not type-check, but a mid-build typecheck would flag a not-yet-existing export.) For this task, update the two existing import statements so they read:

```typescript
import {
  classify,
  indexFile,
  fullReindex,
  countMissingVectors,
  type IndexerConfig,
} from "../src/indexer.js";
import { embedDocument, serializeVector } from "../src/embedder.js";
```

```typescript
describe("vectorCoverageSweep", () => {
  // Insert an observation row directly (bypassing indexFile) so we control vector presence.
  let seq = 0;
  function insertObs(content: string): number {
    seq++;
    const now = Math.floor(Date.now() / 1000);
    const r = db
      .prepare(
        `INSERT INTO observations
          (source_type, source_path, project, topic, title, content, content_hash, file_mtime, indexed_at, frontmatter)
         VALUES ('context', @sp, NULL, 't', 'T', @c, @h, @m, @m, NULL)`,
      )
      .run({ sp: `/tmp/sweep-o${seq}.md`, c: content, h: `h${seq}`, m: now });
    return Number(r.lastInsertRowid);
  }
  // vec0 PK must bind as BigInt (better-sqlite3 sends numbers as FLOAT).
  function seedVec(id: number): void {
    db.prepare("INSERT INTO vec_items(observation_id, embedding) VALUES (?, ?)").run(
      BigInt(id),
      serializeVector(new Float32Array(768).fill(0.1)),
    );
  }

  it("countMissingVectors counts observations with no vec_items row", () => {
    const a = insertObs("alpha");
    const b = insertObs("beta");
    insertObs("gamma"); // orphan
    seedVec(a);
    seedVec(b);

    expect(countMissingVectors(db)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && npx vitest run test/indexer.test.ts -t "countMissingVectors counts"`
Expected: FAIL — `countMissingVectors is not a function` (not yet exported).

- [ ] **Step 3: Write minimal implementation**

In `mcp/src/indexer.ts`, add near the top of the file (after the imports / alongside existing module constants):

```typescript
// Max orphan re-embeds attempted per sweep. A poisoned row costs one bounded attempt
// per cycle (named in the log), never a hot-loop; rows beyond the cap are next sweep's work.
export const MAX_VECTOR_SWEEP = 50;
```

And add this exported helper (place it just above `fullReindex`):

```typescript
/** Count observations that have no vec_items row (orphaned embeddings). */
export function countMissingVectors(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT count(*) AS c
         FROM observations o
         LEFT JOIN vec_items v ON o.id = v.observation_id
        WHERE v.observation_id IS NULL`,
    )
    .get() as { c: number };
  return row.c;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && npx vitest run test/indexer.test.ts -t "countMissingVectors counts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/indexer.ts mcp/test/indexer.test.ts
git commit -m "feat: add countMissingVectors helper for index health"
```

---

## Task 2: Implement the bounded coverage sweep

**Files:**
- Modify: `mcp/src/indexer.ts` (add `vectorCoverageSweep`)
- Test: `mcp/test/indexer.test.ts` (extend the `vectorCoverageSweep` block)

- [ ] **Step 1: Write the failing tests**

First, extend the test's indexer import to add the two symbols this task introduces — `vectorCoverageSweep` and `MAX_VECTOR_SWEEP` — so the import line now reads:

```typescript
import {
  classify,
  indexFile,
  fullReindex,
  countMissingVectors,
  vectorCoverageSweep,
  MAX_VECTOR_SWEEP,
  type IndexerConfig,
} from "../src/indexer.js";
```

Then add these tests inside the existing `describe("vectorCoverageSweep")` block:

```typescript
it("re-embeds all orphans when under the cap and reports counts", async () => {
  const ids = [insertObs("a"), insertObs("b"), insertObs("c")];
  seedVec(ids[0]); // one already covered; two orphaned

  const result = await vectorCoverageSweep(db);

  expect(result.before).toBe(2);
  expect(result.healed).toBe(2);
  expect(result.after).toBe(0);
  expect(countMissingVectors(db)).toBe(0);
});

it("honors the per-sweep cap — heals up to the cap, leaves the rest reported", async () => {
  // Cap+1 orphans → cap healed, 1 remains.
  for (let i = 0; i < MAX_VECTOR_SWEEP + 1; i++) insertObs(`o${i}`);

  const result = await vectorCoverageSweep(db);

  expect(result.before).toBe(MAX_VECTOR_SWEEP + 1);
  expect(result.healed).toBe(MAX_VECTOR_SWEEP);
  expect(result.after).toBe(1);
});

it("is a no-op at full coverage (idempotent)", async () => {
  const id = insertObs("a");
  seedVec(id);

  const first = await vectorCoverageSweep(db);
  expect(first.before).toBe(0);
  expect(first.healed).toBe(0);

  const second = await vectorCoverageSweep(db);
  expect(second.before).toBe(0);
  expect(second.after).toBe(0);
});

it("does not hot-loop a permanently-failing row — counts it as still-missing", async () => {
  insertObs("poison");
  // embedObservation swallows the throw (catch-log-drop), so the row stays orphaned.
  vi.mocked(embedDocument).mockRejectedValueOnce(new Error("embed boom"));

  const result = await vectorCoverageSweep(db);

  expect(result.before).toBe(1);
  expect(result.healed).toBe(0); // attempted once, still missing
  expect(result.after).toBe(1);
  expect(countMissingVectors(db)).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && npx vitest run test/indexer.test.ts -t "vectorCoverageSweep"`
Expected: FAIL — `vectorCoverageSweep is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `mcp/src/indexer.ts`, add this interface and function (place above `fullReindex`, below `countMissingVectors`):

```typescript
export interface CoverageSweepResult {
  /** Orphan count before the sweep. */
  before: number;
  /** Orphans successfully re-embedded this sweep (bounded by MAX_VECTOR_SWEEP). */
  healed: number;
  /** Orphan count after the sweep (remaining work + any permanently-failing rows). */
  after: number;
}

/**
 * Self-healing pass: re-embed observations that have no vec_items row, bounded per sweep.
 * Reuses embedObservation (its catch-log-drop is unchanged; THIS sweep is the retry, so a
 * transient embed failure self-heals next cycle). A permanently-failing row costs one
 * bounded attempt per sweep and is named in the warn log rather than hot-looped.
 */
export async function vectorCoverageSweep(db: Database.Database): Promise<CoverageSweepResult> {
  const before = countMissingVectors(db);
  if (before === 0) return { before: 0, healed: 0, after: 0 };

  const orphans = db
    .prepare(
      `SELECT o.id, o.content
         FROM observations o
         LEFT JOIN vec_items v ON o.id = v.observation_id
        WHERE v.observation_id IS NULL
        ORDER BY o.id
        LIMIT ?`,
    )
    .all(MAX_VECTOR_SWEEP) as { id: number; content: string }[];

  for (const { id, content } of orphans) {
    await embedObservation(db, id, content); // failures are swallowed inside; sweep is the retry
  }

  const after = countMissingVectors(db);
  const healed = before - after;

  if (after > 0) {
    // Name the rows still missing (capped log) so a poisoned input is debuggable.
    const stillMissing = db
      .prepare(
        `SELECT o.source_path
           FROM observations o
           LEFT JOIN vec_items v ON o.id = v.observation_id
          WHERE v.observation_id IS NULL
          ORDER BY o.id
          LIMIT 20`,
      )
      .all() as { source_path: string }[];
    log("warn", "vectorCoverageSweep: observations still missing vectors", {
      remaining: after,
      paths: stillMissing.map((r) => r.source_path),
    });
  }

  return { before, healed, after };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && npx vitest run test/indexer.test.ts -t "vectorCoverageSweep"`
Expected: PASS (all five tests in the block).

- [ ] **Step 5: Commit**

```bash
git add mcp/src/indexer.ts mcp/test/indexer.test.ts
git commit -m "feat: add bounded vector-coverage sweep with named-failure logging"
```

---

## Task 3: Wire the sweep into fullReindex and report coverage

**Files:**
- Modify: `mcp/src/indexer.ts` (extend `ReindexSummary`; call sweep in `fullReindex`)
- Test: `mcp/test/indexer.test.ts` (integration test through `fullReindex`)

- [ ] **Step 1: Write the failing test**

Add inside the `describe("vectorCoverageSweep")` block (it exercises the real `fullReindex` entry point and the temp-`dataRoot` harness from the suite's `beforeEach`):

```typescript
it("fullReindex heals a pre-existing orphan and reports coverage", async () => {
  // Index a file so it has an observation + vector, then delete its vector to simulate
  // a past terminal embed failure (an orphan no change-driven pass would ever repair).
  const file = join(dataRoot, "context", "github.md");
  writeFileSync(file, "# github\n\ngh cli command patterns\n", "utf8");
  await fullReindex(db, config);
  const obs = db.prepare("SELECT id FROM observations WHERE source_path = ?").get(file) as { id: number };
  db.prepare("DELETE FROM vec_items WHERE observation_id = ?").run(BigInt(obs.id));
  expect(countMissingVectors(db)).toBe(1);

  // A reindex with NO content change must still heal the orphan via the coverage sweep.
  const summary = await fullReindex(db, config);

  expect(summary.vecMissingBefore).toBe(1);
  expect(summary.vecMissingAfter).toBe(0);
  expect(countMissingVectors(db)).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && npx vitest run test/indexer.test.ts -t "fullReindex heals"`
Expected: FAIL — `summary.vecMissingBefore` is `undefined` (property not on `ReindexSummary` yet; sweep not wired in).

- [ ] **Step 3: Write minimal implementation**

In `mcp/src/indexer.ts`, extend the `ReindexSummary` interface (currently at lines 261-268):

```typescript
export interface ReindexSummary {
  total: number;
  indexed: number;
  unchanged: number;
  skipped: number;
  removed: number;
  durationMs: number;
  vecMissingBefore: number;
  vecMissingAfter: number;
}
```

In `fullReindex`, after the existing change-driven embedding pass (the `for (const { id, content } of newlyIndexed)` loop ending at current line 335) and before the removal pass (`const candidateSet = candidates;` at current line 337), insert:

```typescript
  // Self-healing coverage pass: repair any observation missing its vector (a past terminal
  // embed failure that no change-driven pass would ever touch). Bounded per sweep.
  const coverage = await vectorCoverageSweep(db);
```

Then extend the `summary` object literal (currently lines 349-356) to include the coverage numbers:

```typescript
  const summary: ReindexSummary = {
    total: candidates.size,
    indexed,
    unchanged,
    skipped,
    removed,
    durationMs: Date.now() - start,
    vecMissingBefore: coverage.before,
    vecMissingAfter: coverage.after,
  };
```

The existing `log("info", "fullReindex complete", { ...summary });` line automatically picks up the two new fields — no change needed there.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && npx vitest run test/indexer.test.ts -t "fullReindex heals"`
Expected: PASS.

- [ ] **Step 5: Run the full indexer suite (no regressions)**

Run: `cd mcp && npx vitest run test/indexer.test.ts`
Expected: PASS — all pre-existing indexer tests still green (the new `vecMissingBefore`/`vecMissingAfter` fields are additive; no existing test asserts the summary's exact shape in a way that breaks on added keys).

- [ ] **Step 6: Commit**

```bash
git add mcp/src/indexer.ts mcp/test/indexer.test.ts
git commit -m "feat: wire vector-coverage sweep into fullReindex with health metrics"
```

---

## Task 4: Full suite + typecheck verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole package**

Run: `cd mcp && npx tsc --noEmit`
Expected: no errors. (Confirms the `ReindexSummary` extension and new exports type-resolve across the package — `index.ts` consumes `fullReindex`.)

- [ ] **Step 2: Run the full test suite**

Run: `cd mcp && npx vitest run`
Expected: all suites PASS, zero new failures vs. the pre-change baseline.

- [ ] **Step 3: Genuineness check (Gate-3 pre-confirmation)**

Confirm the keystone test actually guards the behavior: temporarily comment out the `const coverage = await vectorCoverageSweep(db);` call in `fullReindex` and re-run `npx vitest run test/indexer.test.ts -t "fullReindex heals"`. Expected: FAIL (proves the test fails when the production change is reverted — i.e., it is not tautological). Restore the line immediately; do NOT commit the reverted state.

- [ ] **Step 4: No commit** — this task is verification only. If anything failed, return to the relevant task; do not proceed to the gate.

---

## Self-Review

**1. Spec coverage** (PRD Implementation + Testing Decisions → task):
- VectorCoverageSweep after change-driven step, reuses `embedObservation` → Task 2 + Task 3 wiring ✅
- Per-sweep cap (50), named remaining rows → Task 2 (`MAX_VECTOR_SWEEP`, LIMIT, warn log) ✅
- Coverage metric `vec_missing_before`/`after` in summary → Task 3 (`ReindexSummary` extension) ✅
- No schema/retrieval/write-path change → confirmed: only additive const, helper, function, two summary fields ✅
- Test: sweep restores coverage → Task 2 test 1 ✅
- Test: per-sweep bound (cap+1 → cap healed, 1 reported) → Task 2 test 2 ✅
- Test: repeated-failure row reported, not looped → Task 2 test 4 ✅
- Test: coverage numbers present + correct in summary → Task 3 test ✅
- Test: idempotence (second sweep no-op at full coverage) → Task 2 test 3 ✅
- Excluded by PRD (log formats; live one-time healing of the 3 rows) → not tested, healed operationally at rollout ✅
- User Story 4 (the live 3 orphans healed by first sweep) → covered operationally; re-run the read-only orphan count after rollout to confirm `orphanCount: 0` (acceptance evidence, not a unit test) ✅

**2. Placeholder scan:** No TBDs, no "add error handling", every code step shows complete code, every command has expected output. ✅

**3. Type consistency:** `countMissingVectors(db) → number`, `vectorCoverageSweep(db) → Promise<CoverageSweepResult>` with `{before, healed, after}`, `ReindexSummary` gains `vecMissingBefore`/`vecMissingAfter`, `MAX_VECTOR_SWEEP` used identically in impl and tests. Names consistent across all four tasks. ✅

---

## Notes for the implementer

- **Run prettier before each `/commit`:** `npx prettier --write` on the changed `.ts` files (covered by the global `Bash(npx:*)` allow entry). Both changed files are TypeScript — non-Java — so prettier applies.
- **Do not modify `embedObservation`** — its catch-log-drop is load-bearing for this design (the sweep relies on it not throwing).
- **vec0 measurement caveat:** if you hand-verify coverage against the live DB, the plain `sqlite3` CLI cannot read vec0 (`no such module: vec0`) — count via node with the project's better-sqlite3 + sqlite-vec, read-only.
