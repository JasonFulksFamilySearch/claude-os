# Per-File Error Isolation in fullReindex (C2-hardening D-a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chunk-split cutover/reindex robust to a single malformed file — `fullReindex` skips-and-reports the bad file instead of aborting the whole batch.

**Architecture:** Wrap the per-file `indexFile` call in a `try/catch` at the `fullReindex` loop boundary (the layer that owns batch semantics), mirroring the watcher's existing per-event isolation. Extend `ReindexSummary` with `errored`/`erroredPaths`; surface them at the cutover CLI with a loud warning and a non-zero exit code; preserve D-c's `backupPath` in `runCutover`'s return.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, better-sqlite3, gray-matter (js-yaml).

## Global Constraints

- **No formatter.** `mcp/` has no prettier/eslint config — style is hand-maintained and tsc-checked. Do NOT run a formatter. Verify with `npm run build` (tsc) and `npm test`.
- **ESM:** every import specifier ends in `.js`.
- **`errored` counts ONLY files that threw.** Benign skips (`skipped_unchanged` / `skipped_too_large` / `skipped_unclassified` / `skipped_missing`) stay in the existing `skipped` bucket. Never conflate the two.
- **Eval gate (out-of-band, not a task here):** `indexer.ts` is an indexing module, so before the PR the offline retrieval eval gate must pass — capture a baseline on the pre-change index, then `npm run eval` must compose a non-regressing PASS (`docs/eval-gate-protocol.md`). The change is expected eval-neutral on a clean corpus (adds a catch branch + two summary fields; no ranking/embedding/chunk-boundary change). Run at Gate 3.
- **Commits:** explicit `git add` of the named files only; conventional `fix:` subject; **no** `Co-Authored-By` footer; **no** issue/ticket numbers in code comments, test names, or commit subjects.
- **All production code below mirrors the Gate-1-CLEAN PRD's Implementation Decisions** (issue #43, amended to preserve `backupPath`). Do not re-derive it.

---

### Task 1: Per-file error isolation in `fullReindex` (`indexer.ts`)

**Files:**
- Modify: `mcp/src/indexer.ts` — interface `ReindexSummary` (currently :404-411); loop var decls (:460-464); per-file loop (:466-473); summary assembly (:494-501)
- Test: `mcp/test/indexer.test.ts` — add 4 tests (harness already imports `writeFileSync`, `join`, `mkdirSync`, `fullReindex`, `TWO_ENTRY_LEARNINGS`, `enableChunking`)

**Interfaces:**
- Produces: `ReindexSummary` extended with `errored: number` and `erroredPaths: string[]` — consumed by Task 2's `runCutover`.

- [ ] **Step 1: Write the core failing test (malformed-file isolation)**

Add to `mcp/test/indexer.test.ts` (inside the existing top-level `describe`, alongside the other `fullReindex` tests):

```ts
it("isolates a malformed file: completes over good files, reports the bad one", async () => {
  writeFileSync(join(dataRoot, "context", "good.md"), "# Good\n\nsome content\n", "utf8");
  writeFileSync(join(dataRoot, "projects", "demo", "learnings.md"), TWO_ENTRY_LEARNINGS, "utf8");
  // Unterminated double-quoted scalar → gray-matter (js-yaml) throws a YAMLException.
  const badPath = join(dataRoot, "context", "bad.md");
  writeFileSync(badPath, '---\ntitle: "unterminated\n---\n# Bad\n', "utf8");

  const summary = await fullReindex(db, config);

  expect(summary.errored).toBe(1);
  expect(summary.erroredPaths).toContain(badPath);
  expect(summary.indexed).toBeGreaterThanOrEqual(2);
  const bad = db
    .prepare("SELECT COUNT(*) AS n FROM observations WHERE source_path = ?")
    .get(badPath) as { n: number };
  expect(bad.n).toBe(0);
});
```

- [ ] **Step 2: Run it — confirm it fails (compile error: `errored` not on `ReindexSummary`)**

Run: `npm run build`
Expected: tsc error — `Property 'errored' does not exist on type 'ReindexSummary'`.

- [ ] **Step 3: Add the two new fields to `ReindexSummary` and the summary assembly (so it compiles; no behavior change yet)**

In `mcp/src/indexer.ts`, the interface (:404-411) becomes:

```ts
export interface ReindexSummary {
  total: number;
  indexed: number;
  unchanged: number;
  skipped: number;
  errored: number;
  removed: number;
  durationMs: number;
  erroredPaths: string[];
}
```

Add the accumulators with the other loop counters (:460-464), after `let skipped = 0;`:

```ts
  let errored = 0;
  const erroredPaths: string[] = [];
```

And the summary assembly (:494-501) becomes:

```ts
  const summary: ReindexSummary = {
    total: candidates.size,
    indexed,
    unchanged,
    skipped,
    errored,
    removed,
    erroredPaths,
    durationMs: Date.now() - start,
  };
```

- [ ] **Step 4: Run the test — confirm it now fails for the RIGHT reason (runtime abort)**

Run: `npx vitest run test/indexer.test.ts -t "isolates a malformed file"`
Expected: FAIL — `fullReindex` rejects with a `YAMLException` (the bad file aborts the loop). This is the abort being fixed; `errored`/`erroredPaths` are still 0/empty because the catch does not exist yet.

- [ ] **Step 5: Implement the per-file `try/catch` in the loop**

Replace the loop (:466-473) with:

```ts
  for (const file of candidates) {
    try {
      const r = indexFile(db, file, config);
      if (r.status === "indexed") {
        indexed++;
        newlyIndexed.push({ path: file, changedAnchors: r.changedAnchors });
      } else if (r.status === "skipped_unchanged") unchanged++;
      else skipped++;
    } catch (err) {
      errored++;
      erroredPaths.push(file);
      log("error", "fullReindex skipped file (parse/index failed)", {
        path: file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
```

- [ ] **Step 6: Run the core test — confirm it passes**

Run: `npx vitest run test/indexer.test.ts -t "isolates a malformed file"`
Expected: PASS — resolves; `errored === 1`; `erroredPaths` contains `bad.md`; ≥2 good files indexed; 0 rows for `bad.md`.

- [ ] **Step 7: Add the remaining three tests**

Add to `mcp/test/indexer.test.ts`:

```ts
it("malformed-file isolation holds with the chunking flag ON (the cutover path)", async () => {
  enableChunking();
  writeFileSync(join(dataRoot, "agent", "learnings.md"), TWO_ENTRY_LEARNINGS, "utf8");
  const badPath = join(dataRoot, "context", "bad.md");
  writeFileSync(badPath, '---\ntitle: "unterminated\n---\n# Bad\n', "utf8");

  const summary = await fullReindex(db, config);

  expect(summary.errored).toBe(1);
  expect(summary.erroredPaths).toContain(badPath);
  expect(summary.indexed).toBeGreaterThanOrEqual(1);
});

it("a clean corpus reports zero errors", async () => {
  writeFileSync(join(dataRoot, "context", "good.md"), "# Good\n\nsome content\n", "utf8");
  writeFileSync(join(dataRoot, "agent", "learnings.md"), TWO_ENTRY_LEARNINGS, "utf8");

  const summary = await fullReindex(db, config);

  expect(summary.errored).toBe(0);
  expect(summary.erroredPaths).toEqual([]);
});

it("counts error-skips and benign skips in separate buckets", async () => {
  writeFileSync(join(dataRoot, "context", "good.md"), "# Good\n\nsome content\n", "utf8");
  // Oversized file → skipped_too_large → counted in `skipped`, NOT `errored`.
  writeFileSync(join(dataRoot, "context", "big.md"), "x".repeat(1024 * 1024 + 100), "utf8");
  const badPath = join(dataRoot, "context", "bad.md");
  writeFileSync(badPath, '---\ntitle: "unterminated\n---\n# Bad\n', "utf8");

  const summary = await fullReindex(db, config);

  expect(summary.errored).toBe(1);
  expect(summary.erroredPaths).toContain(badPath);
  expect(summary.skipped).toBe(1);
});
```

- [ ] **Step 8: Run the full indexer suite + tsc**

Run: `npm run build && npx vitest run test/indexer.test.ts`
Expected: tsc clean; all `indexer.test.ts` tests PASS (existing + 4 new).

- [ ] **Step 9: Commit**

```bash
git add mcp/src/indexer.ts mcp/test/indexer.test.ts
git commit -m "fix: isolate per-file errors in fullReindex so one bad file does not abort the batch"
```

---

### Task 2: Surface skipped files at the cutover CLI + widen `runCutover` return (`cutover.ts`)

**Files:**
- Modify: `mcp/src/scripts/cutover.ts` — `runCutover` return-type annotation (:55) + `@returns` docstring (:30,:49); return statement (:82); CLI block success path (after :111)
- Test: `mcp/test/migrations.test.ts` — add 1 test to the existing `describe("runCutover", …)` block (:438); harness already imports `writeFileSync`, `mkdirSync`, `join`, `runCutover`

**Interfaces:**
- Consumes: `ReindexSummary.errored` / `ReindexSummary.erroredPaths` from Task 1.
- Produces: `runCutover` returns `{ rechunked: number; backupPath: string; errored: number; erroredPaths: string[] }`.

- [ ] **Step 1: Write the failing test (runCutover passes the error report through)**

Add inside `describe("runCutover", …)` in `mcp/test/migrations.test.ts`:

```ts
it("reports a malformed file without aborting, preserving backupPath/rechunked", async () => {
  // The malformed fixture MUST go in a dir whose .md files classify() accepts so it
  // reaches parseFile and throws. context/*.md classifies any .md (indexer.ts:69);
  // agent/ classifies ONLY CLAUDE.md/learnings.md (:54-64), so agent/bad.md would be
  // skipped_unclassified and never throw. The runCutover fixture only creates agent/,
  // so create context/ here.
  mkdirSync(join(dataRoot, "context"), { recursive: true });
  const badPath = join(dataRoot, "context", "bad.md");
  writeFileSync(badPath, '---\ntitle: "unterminated\n---\n# Bad\n', "utf8");

  const result = await runCutover(cutoverDb, cutoverConfig, cutoverDbPath + ".pre-cutover.bak");

  expect(result.errored).toBe(1);
  expect(result.erroredPaths).toContain(badPath);
  expect(result.backupPath).toBe(cutoverDbPath + ".pre-cutover.bak");
  expect(result.rechunked).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run it — confirm it fails (compile error: `errored` not on `runCutover`'s return)**

Run: `npm run build`
Expected: tsc error — `Property 'errored' does not exist on type '{ rechunked: number; backupPath: string; }'`.

- [ ] **Step 3: Widen `runCutover`'s return shape, type annotation, and docstring**

In `mcp/src/scripts/cutover.ts`:

Return-type annotation (:55):

```ts
): Promise<{ rechunked: number; backupPath: string; errored: number; erroredPaths: string[] }> {
```

Return statement (:82):

```ts
  return {
    rechunked: summary.indexed,
    backupPath: resolvedBackupPath,
    errored: summary.errored,
    erroredPaths: summary.erroredPaths,
  };
```

Update the `@returns` lines (the docstring at :49 and the header comment at :30) to name all four fields, e.g.:

```ts
 * @returns { rechunked, backupPath, errored, erroredPaths } — rechunked is fullReindex's
 *          "indexed" count; backupPath is the verified snapshot; errored/erroredPaths report
 *          files skipped because they threw during parse/index (the batch still completed).
```

- [ ] **Step 4: Run the test — confirm it passes**

Run: `npx vitest run test/migrations.test.ts -t "reports a malformed file"`
Expected: PASS — `runCutover` resolves; `errored === 1`; `erroredPaths` contains `bad.md`; `backupPath` and `rechunked` intact.

- [ ] **Step 5: Surface the skipped files at the CLI with a non-zero exit code**

In `mcp/src/scripts/cutover.ts`, in the `if (isDirectEntry)` `try` block, immediately after the existing `console.log(\`cutover: complete — ${result.rechunked} files re-chunked\`);` line (:111), add:

```ts
    if (result.erroredPaths.length > 0) {
      console.warn(
        `cutover: WARNING — ${result.errored} file(s) skipped due to parse/index errors:`,
      );
      for (const p of result.erroredPaths) console.warn(`  - ${p}`);
      console.warn("cutover: fix the above file(s) and re-run the reindex to pick them up.");
      // Untrustworthy terminal state: the cutover finished, but the index does not match
      // the corpus (≥1 file is missing). Signal it the way eval.ts and migrate.ts signal an
      // untrustworthy/failed run — a non-zero exit code.
      process.exitCode = 1;
    }
```

(Behavior verified by inspection against the `eval.ts` / `migrate.ts` exit-code convention; the CLI block is guarded by `import.meta.url` and is not unit-tested — consistent with how those scripts' exit codes are themselves untested at the unit level.)

- [ ] **Step 6: Run the full suite + tsc**

Run: `npm run build && npm test`
Expected: tsc clean; entire vitest suite PASS (no regressions).

- [ ] **Step 7: Commit**

```bash
git add mcp/src/scripts/cutover.ts mcp/test/migrations.test.ts
git commit -m "fix: surface cutover reindex per-file skips with a loud warning and non-zero exit"
```

---

## Self-Review

**Spec coverage** (against issue #43 PRD): per-file `try/catch` at the loop (Task 1 Step 5 ✓); `ReindexSummary.errored`/`erroredPaths` (Task 1 Step 3 ✓); summary assembly carries them into the completion log (Task 1 Step 3 ✓); CLI warning + non-zero exit (Task 2 Step 5 ✓); `runCutover` return extended preserving `backupPath` (Task 2 Step 3 ✓); 4 indexer tests + 1 cutover test matching the PRD's Testing Decisions (Tasks 1 & 2 ✓); watcher path untouched (no task modifies it ✓); `errored` vs benign `skipped` separation (Task 1 Step 7 third test ✓). No spec item left unmapped.

**Placeholder scan:** none — every code/test step shows complete code and an exact command with expected output.

**Type consistency:** `errored: number` / `erroredPaths: string[]` are named identically in the interface (Task 1 Step 3), the accumulators (Task 1 Step 3), the assembly (Task 1 Step 3), and `runCutover`'s return + annotation (Task 2 Step 3). The cutover test reads `result.errored` / `result.erroredPaths` / `result.backupPath` / `result.rechunked` — all present on the widened return.
