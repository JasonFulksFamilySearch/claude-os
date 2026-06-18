# Verified Pre-Cutover Backup (C2-hardening D-c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the C2 chunk-split cutover always produce a verified, complete pre-cutover snapshot before it flips `c2_chunking_enabled`, so a stale backup stub can never silently suppress the only rollback artifact.

**Architecture:** Repair the backup in place inside `runCutover` Step 1 (not a parallel rollback command). Two changes: (1) resolve the default backup destination to a per-run **timestamped** path derived from the live DB's own filename — a stale file at the old fixed path is then structurally incapable of suppressing `VACUUM INTO`; (2) immediately **verify** the snapshot (size floor → observation-count parity → `integrity_check`) and hard-throw *before* the flag flip if any check fails. The verification lives in a small shared `verifyBackup` helper in `migrations.ts`. The flag flip and `fullReindex` are untouched.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), Node ≥20, `better-sqlite3` ^11, vitest ^2, `tsx` runner. Tests run with `npm test` (`vitest run`) from `mcp/`.

## Global Constraints

- **Source of truth:** the approved PRD = the body of GitHub issue #45 (claude-os repo). Implement only what it specifies.
- **No new dependency.** Use `better-sqlite3` and `node:fs` only.
- **Distinct-backup-path invariant (inherited):** the cutover backup path must NEVER equal `migrate.ts`'s `.pre-c2.bak`. Timestamped `.pre-cutover.<ts>.bak` paths satisfy this trivially — do not reintroduce a fixed shared default.
- **`backupPath` parameter is a test-injection contract — retain it.** Only the *default resolution* (when the caller omits it) and the production/CLI behavior change.
- **No sqlite-vec load for verification** (PRD Implementation Decision): `COUNT(*)` and `PRAGMA integrity_check` run on a raw `better-sqlite3` handle without the extension. The snapshot's vec0 shadow tables are checked as ordinary b-trees by `integrity_check`; the virtual-table module is never invoked.
- **No `update.sh` / scheduled-job / hook wiring.** The cutover stays deferred and operator-run only.
- **Commit convention:** subject-prefix style `Fix:` / `Test:` / `Docs:` (match recent history); **no ticket numbers in the subject**; **no `Co-Authored-By` footer**. Commits go through the `/commit` skill.
- **Out of scope (do not build):** a standalone `npm run rollback` command; auto-rollback on a FAIL gate verdict; retention/pruning of old `.pre-cutover.<ts>.bak` files; any change to `migrate.ts`'s `.pre-c2.bak`, to `backupDb`, to `verifyV3`, to the flag-flip SQL, or to `fullReindex`.

---

## File Structure

- **Modify `mcp/src/migrations.ts`** — add and export `verifyBackup(path, expectedCount)`. New `node:fs` import for `statSync`. `backupDb`/`verifyV3` unchanged.
- **Modify `mcp/src/scripts/cutover.ts`** — rework Step 1 of `runCutover` (timestamped default path from `db.name`; capture live observation count; `backupDb` then `verifyBackup`; remove the `existsSync` skip-guard); widen the return to `{ rechunked, backupPath }`; update the CLI entry block to log the returned verified path; refresh the header doc comment.
- **Modify `mcp/test/migrations.test.ts`** — add `verifyBackup` unit tests; add/rework `runCutover` tests (stale-stub regression, corrupt-backup abort-before-flip, snapshot parity, no-collision idempotency, injected-path honored). Add a namespace import of migrations for spying on `backupDb`.
- **Modify `docs/eval-gate-protocol.md`** — add the operator rollback procedure under the C2 cutover section.

Dependency order: Task 1 (`verifyBackup`) → Task 2 (`runCutover` consumes it) → Task 3 (docs the behavior Task 2 implements). No task needs a later task's output.

---

### Task 1: `verifyBackup` helper in `migrations.ts`

**Files:**
- Modify: `mcp/src/migrations.ts` (add import + new exported function after `backupDb`, ~line 155)
- Test: `mcp/test/migrations.test.ts` (new `describe("verifyBackup", …)` block)

**Interfaces:**
- Consumes: `better-sqlite3` default export (already imported at `migrations.ts:1`); `statSync` from `node:fs`.
- Produces: `export function verifyBackup(path: string, expectedCount: number): void` — throws `Error` if the file at `path` is `< 4096` bytes, if its `observations` row count `!== expectedCount`, or if `PRAGMA integrity_check !== "ok"`; returns `void` on success. Task 2 calls it immediately after `backupDb`.

- [ ] **Step 1: Write the failing tests**

In `mcp/test/migrations.test.ts`, add the `verifyBackup` import to the existing migrations import (line 8) and a new describe block. (`mkdtempSync`, `writeFileSync`, `join`, `tmpdir`, `Database`, `openDb` are already imported.)

```ts
// line 8 becomes:
import { isV3Schema, runMigrations, backupDb, verifyV3, verifyBackup } from "../src/migrations.js";
```

```ts
describe("verifyBackup", () => {
  let vbDir: string;
  let liveDbPath: string;
  let liveDb: Database.Database;

  beforeEach(() => {
    vbDir = mkdtempSync(join(tmpdir(), "claude-os-verifybackup-"));
    liveDbPath = join(vbDir, "live.db");
    liveDb = openDb(liveDbPath); // fresh v3 DB, 0 observations
  });

  afterEach(() => {
    liveDb.close();
    rmSync(vbDir, { recursive: true, force: true });
  });

  it("passes for a complete VACUUM INTO snapshot with matching count", () => {
    // Seed one observation so the count is non-trivial.
    liveDb.prepare(`
      INSERT INTO observations
        (source_type, source_path, anchor, parent_title, project, topic, title,
         content, content_hash, file_mtime, indexed_at, frontmatter)
      VALUES ('learning', ?, '', NULL, NULL, NULL, 'T', 'body', 'h', 1, 2, NULL)
    `).run(join(vbDir, "x.md"));
    const dest = join(vbDir, "good.bak");
    backupDb(liveDb, dest);
    expect(() => verifyBackup(dest, 1)).not.toThrow();
  });

  it("throws when the file is below the 4096-byte size floor", () => {
    const dest = join(vbDir, "tiny.bak");
    writeFileSync(dest, "not a db"); // 8 bytes
    expect(() => verifyBackup(dest, 0)).toThrow(/4096/);
  });

  it("throws when the snapshot observation count does not match expected", () => {
    const dest = join(vbDir, "count.bak");
    backupDb(liveDb, dest); // snapshot has 0 observations
    expect(() => verifyBackup(dest, 5)).toThrow(/observations/);
  });

  it("throws when integrity_check fails (corrupt file above the floor)", () => {
    const dest = join(vbDir, "corrupt.bak");
    backupDb(liveDb, dest);          // start from a real, > 4096-byte SQLite file
    // Overwrite the SQLite header magic with garbage to fail integrity_check
    // while keeping the file size above the floor.
    const fd = openSync(dest, "r+");
    writeSync(fd, Buffer.from("XXXXXXXXXXXXXXXX"), 0, 16, 0);
    closeSync(fd);
    expect(() => verifyBackup(dest, 0)).toThrow();
  });
});
```

Add the `node:fs` test imports needed above (extend the existing line 2 import):

```ts
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd mcp && npx vitest run test/migrations.test.ts -t verifyBackup`
Expected: FAIL — `verifyBackup` is not exported (`TypeError: verifyBackup is not a function` / import error).

- [ ] **Step 3: Implement `verifyBackup`**

In `mcp/src/migrations.ts`, add the `node:fs` import at the top (after line 1):

```ts
import { statSync } from "node:fs";
```

Add the function immediately after `backupDb` (after line 155):

```ts
/**
 * Verify a freshly-written backup is a complete, openable, populated SQLite
 * database BEFORE the caller relies on it for rollback. Throws on any of:
 *   - file below the 4096-byte (one SQLite page) size floor — cheap reject for
 *     zero-byte / truncated writes;
 *   - observation-row count != the live count captured just before the backup
 *     (the load-bearing check — a stale stub fails here even if it is a valid,
 *     above-floor SQLite file);
 *   - PRAGMA integrity_check != "ok" — structural corruption.
 *
 * Opens its own read-only handle (sqlite-vec NOT required for COUNT +
 * integrity_check) and always closes it.
 *
 * @param path          Path to the backup file just written by backupDb.
 * @param expectedCount observations row count of the live DB immediately before backup.
 */
export function verifyBackup(path: string, expectedCount: number): void {
  const size = statSync(path).size;
  if (size < 4096) {
    throw new Error(
      `backup verification failed: ${path} is ${size} bytes (< 4096-byte floor)`,
    );
  }

  const snap = new Database(path, { readonly: true });
  try {
    const { n } = snap.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number };
    if (n !== expectedCount) {
      throw new Error(
        `backup verification failed: snapshot has ${n} observations, expected ${expectedCount}`,
      );
    }
    const ic = snap.pragma("integrity_check", { simple: true });
    if (ic !== "ok") {
      throw new Error(`backup verification failed: integrity_check returned ${String(ic)}`);
    }
  } finally {
    snap.close();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd mcp && npx vitest run test/migrations.test.ts -t verifyBackup`
Expected: PASS (4 tests). Then `cd mcp && npx tsc --noEmit` → no type errors.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/migrations.ts mcp/test/migrations.test.ts
# via /commit — representative message:
# "Fix: add verifyBackup snapshot integrity helper"
```

---

### Task 2: Rework `runCutover` Step 1 — timestamped path + verified backup

**Files:**
- Modify: `mcp/src/scripts/cutover.ts` (header comment; `runCutover` Step 1 at lines 53–64; return type at line 52/75; CLI entry block at lines 90–112)
- Test: `mcp/test/migrations.test.ts` (extend the `describe("runCutover", …)` block; rework the idempotency test)

**Interfaces:**
- Consumes: `migrations.verifyBackup(path, expectedCount)` (Task 1) and `migrations.backupDb` — both reached via a **namespace import** of `../migrations.js`. The namespace call site (`migrations.backupDb(...)`) is what makes `backupDb` reliably interceptable by the abort test's `vi.spyOn`; a named-import binding is not reliably spy-able under vitest's ESM transform. Also consumes `db.name` (better-sqlite3 returns the DB file path).
- Produces: `runCutover(db, config, backupPath?): Promise<{ rechunked: number; backupPath: string }>` — `backupPath` is the resolved (timestamped-by-default) destination of the verified snapshot. Existing callers reading `.rechunked` are unaffected (additive field).

- [ ] **Step 1: Write the failing tests**

In `mcp/test/migrations.test.ts`, add a namespace import of migrations (for spying on `backupDb`) near the existing imports:

```ts
import * as migrations from "../src/migrations.js";
```

Add these tests inside the existing `describe("runCutover", …)` block (the `beforeEach` already seeds one whole-file `anchor=''` row and writes the file to disk):

```ts
it("takes a fresh verified snapshot at a timestamped path even when a stale stub sits at the legacy fixed path", async () => {
  // Arm the defect: a stale junk file at the OLD fixed default path.
  const legacy = cutoverDbPath + ".pre-cutover.bak";
  writeFileSync(legacy, "x".repeat(100_000)); // ~100KB stub, not a SQLite DB
  const liveCount = (cutoverDb.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n;

  // Call WITHOUT an explicit path → default timestamped resolution kicks in.
  const result = await runCutover(cutoverDb, cutoverConfig);

  // A fresh snapshot at a distinct timestamped path was produced and verified.
  expect(result.backupPath).toMatch(/\.pre-cutover\.\d{8}T\d{6}Z\.bak$/);
  expect(result.backupPath).not.toBe(legacy);
  expect(existsSync(result.backupPath)).toBe(true);
  const snap = new Database(result.backupPath, { readonly: true });
  try {
    const { n } = snap.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number };
    expect(n).toBe(liveCount); // snapshot is the pre-cutover whole-file store
  } finally {
    snap.close();
  }
  // Flag flipped, reindex ran.
  const flag = cutoverDb.prepare("SELECT value FROM meta WHERE key='c2_chunking_enabled'").get() as { value: string } | undefined;
  expect(flag?.value).toBe("1");
});

it("aborts BEFORE flipping the flag when the backup fails verification", async () => {
  // Force a bad backup: stub backupDb to write a sub-floor junk file.
  // cutover.ts calls `migrations.backupDb(...)` through the namespace import (Step 3a),
  // so this spy reliably intercepts the production call.
  const spy = vi.spyOn(migrations, "backupDb").mockImplementation((_db, dest: string) => {
    writeFileSync(dest, "bogus"); // 5 bytes < 4096 floor → verifyBackup throws
  });
  try {
    await expect(runCutover(cutoverDb, cutoverConfig)).rejects.toThrow();
    // Flag was never flipped.
    const flag = cutoverDb.prepare("SELECT value FROM meta WHERE key='c2_chunking_enabled'").get() as { value: string } | undefined;
    expect(flag?.value).not.toBe("1");
    // Live store is still whole-file (original anchor='' row, no anchored rows) → fullReindex never ran.
    const rows = cutoverDb.prepare("SELECT anchor FROM observations").all() as { anchor: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.anchor === "")).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

it("snapshot passes integrity_check and matches the pre-cutover observation count", async () => {
  const liveCount = (cutoverDb.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n;
  const result = await runCutover(cutoverDb, cutoverConfig);
  const snap = new Database(result.backupPath, { readonly: true });
  try {
    const { n } = snap.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number };
    expect(n).toBe(liveCount);
    expect(snap.pragma("integrity_check", { simple: true })).toBe("ok");
  } finally {
    snap.close();
  }
});

it("honors an explicitly injected backup path (test-injection contract)", async () => {
  const explicit = cutoverDbPath + ".injected.bak";
  const result = await runCutover(cutoverDb, cutoverConfig, explicit);
  expect(result.backupPath).toBe(explicit);
  expect(existsSync(explicit)).toBe(true);
});
```

Now **rework the existing idempotency test** (currently `migrations.test.ts:512-522`, which passes the same fixed path twice and depends on the removed skip-guard). Replace it with a distinct-destination no-collision test:

```ts
it("two runs with distinct destinations do not collide or throw", async () => {
  const first = cutoverDbPath + ".run1.bak";
  const second = cutoverDbPath + ".run2.bak";
  await expect(runCutover(cutoverDb, cutoverConfig, first)).resolves.toBeTruthy();
  // Second run on the already-chunked store, distinct destination → no VACUUM INTO collision.
  await expect(runCutover(cutoverDb, cutoverConfig, second)).resolves.toBeTruthy();
  expect(existsSync(first)).toBe(true);
  expect(existsSync(second)).toBe(true);
  const flag = cutoverDb.prepare("SELECT value FROM meta WHERE key='c2_chunking_enabled'").get() as { value: string } | undefined;
  expect(flag?.value).toBe("1");
});
```

> NOTE on the existing tests at `migrations.test.ts:480-510`: they inject `cutoverDbPath + ".pre-cutover.bak"` and call `runCutover` once each. Under the new code they still pass — the injected backup is a real `VACUUM INTO` of the 1-row fixture (well above the floor, count matches, integrity ok), so `verifyBackup` succeeds. Leave them as-is.

- [ ] **Step 2: Run the tests to verify they fail (for the right reason)**

Run: `cd mcp && npx vitest run test/migrations.test.ts -t runCutover`
Expected: the four NEW tests FAIL (`result.backupPath` is `undefined` — the field doesn't exist yet; the stale-stub test's regex match fails). The reworked idempotency test compiles but the **production `runCutover` still has the `existsSync` guard and the old return type** — confirm the new behavior is absent. (The pre-existing 480-510 tests still pass.)

- [ ] **Step 3: Rework `runCutover` Step 1 and the return type**

In `mcp/src/scripts/cutover.ts`:

(a) Change the migrations import (line 36) to a **namespace import**. This is required for the abort test: the test does `vi.spyOn(migrations, "backupDb")`, which reliably intercepts a call written as `migrations.backupDb(...)` but not a named-import binding under vitest's ESM transform.

```ts
import * as migrations from "../migrations.js";
```

(b) Replace the function body from the signature through the return (current lines 48–76) with:

```ts
export async function runCutover(
  db: Database.Database,
  config: IndexerConfig,
  backupPath?: string,
): Promise<{ rechunked: number; backupPath: string }> {
  // Default the backup destination to a per-run TIMESTAMPED path derived from the
  // live DB's own filename. A stale file at the old fixed `<db>.pre-cutover.bak`
  // path can no longer suppress the backup (the destination is unique per run),
  // and the timestamp guarantees VACUUM INTO never collides. Tests inject an
  // explicit path; only the default resolution is timestamped.
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const resolvedBackupPath = backupPath ?? `${db.name}.pre-cutover.${ts}.bak`;

  // --- Step 1: Backup, then VERIFY before any mutation ---
  // Capture the live observation count on the untouched whole-file store; the
  // snapshot must match it. (This count is read pre-flip, so a file that a later
  // reindex would skip is counted identically on both sides and cannot perturb it.)
  const liveCount = (db.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n;
  migrations.backupDb(db, resolvedBackupPath);
  migrations.verifyBackup(resolvedBackupPath, liveCount); // throws → flag never flips, reindex never runs

  // --- Step 2: Flip the chunking flag ---
  db.prepare(
    "INSERT INTO meta(key, value) VALUES ('c2_chunking_enabled', '1') " +
    "ON CONFLICT(key) DO UPDATE SET value = '1'",
  ).run();

  // --- Step 3: Re-index (now chunks because the flag is on) ---
  const summary = await fullReindex(db, config);

  return { rechunked: summary.indexed, backupPath: resolvedBackupPath };
}
```

(c) Update the header doc comment (lines 18–27) so the "Sequence" reflects the new design — replace the old guard/fixed-path bullets:

```ts
 * Sequence:
 *   1. Backup the DB via VACUUM INTO to a per-run timestamped destination
 *      `<db>.pre-cutover.<UTC-timestamp>.bak` (default), then VERIFY the snapshot
 *      (size floor, observation-count parity, integrity_check) — throwing before
 *      any mutation if it is incomplete. The timestamped path means a stale stub
 *      cannot suppress the backup and never collides with migrate.ts's `.pre-c2.bak`.
 *   2. Set meta.c2_chunking_enabled = '1'.
 *   3. fullReindex: with the flag ON, indexFile routes learning/decision files
 *      through chunkByEntries and large context/project docs through chunkByHeadings.
 *   4. Return { rechunked, backupPath } — rechunked is the count of re-indexed files;
 *      backupPath is the verified snapshot's path (logged for the rollback procedure).
```

Remove the now-stale `node:fs` `existsSync` import if it is no longer used anywhere in the file (it was only used by the removed guard at line 62) — check first; the CLI block (Step 4 below) does not use it.

(d) Update the CLI entry block (lines 90–112) to drop the fixed `cliBackupPath` and log the returned verified path:

```ts
if (isDirectEntry) {
  const cliDbPath = process.env["CLAUDE_OS_DB_PATH"] ?? DEFAULT_DB_PATH;

  const cliDb = new Database(cliDbPath);
  cliDb.pragma("journal_mode = WAL");
  cliDb.pragma("foreign_keys = ON");
  sqliteVec.load(cliDb);

  try {
    console.log("cutover: starting — backup, verify, flag flip, fullReindex");
    console.log(`cutover: DB path: ${cliDbPath}`);

    const result = await runCutover(cliDb, defaultConfig());
    console.log(`cutover: verified pre-cutover snapshot at ${result.backupPath}`);
    console.log(`cutover: complete — ${result.rechunked} files re-chunked`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error("cutover: unexpected error:", msg);
    process.exitCode = 1;
  } finally {
    cliDb.close();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd mcp && npx vitest run test/migrations.test.ts -t runCutover`
Expected: PASS (the 4 pre-existing single-run tests + the 4 new tests + the reworked no-collision test). Then:
Run: `cd mcp && npx tsc --noEmit`
Expected: no type errors (the widened return type compiles; CLI uses `result.backupPath`).

- [ ] **Step 5: Run the FULL suite to confirm no regressions**

Run: `cd mcp && npm test`
Expected: all tests green (the suite was 295 green pre-change; expect that plus the net-new tests, with the old idempotency test replaced).

- [ ] **Step 6: Commit**

```bash
git add mcp/src/scripts/cutover.ts mcp/test/migrations.test.ts
# via /commit — representative message:
# "Fix: verify and timestamp the pre-cutover backup before flag flip"
```

---

### Task 3: Document the operator rollback procedure

**Files:**
- Modify: `docs/eval-gate-protocol.md` (under the "## C2 cutover" section, after the existing one-way-migration note at lines 193–195)

**Interfaces:** none (documentation). This is User Story 4 — the written procedure the fix makes trustworthy.

- [ ] **Step 1: Add the rollback procedure**

Append, after the existing paragraph ending "...never overwrite it with `--rebaseline` until a PASS is in hand." (line 195):

```markdown

### Rollback (abandoning a chunked index)

`runCutover` now guarantees a verified snapshot at a known timestamped path
(`<db>.pre-cutover.<UTC-timestamp>.bak`, logged on success). To roll back a cutover
whose gate came back FAIL/INCONCLUSIVE or whose rechunk corrupted retrieval:

1. Stop any process holding the live DB (the MCP server).
2. Locate the most recent verified snapshot — the path the cutover logged
   (`cutover: verified pre-cutover snapshot at …`).
3. Move the live `memory.db` aside and copy the snapshot into its place. Because
   `VACUUM INTO` produced a single fully-checkpointed file with no `-wal`/`-shm`
   siblings, a plain file copy is sufficient.
4. Confirm `c2_chunking_enabled` is `'0'` (or absent) in the restored DB — the
   snapshot predates the flag flip, so it is whole-file by construction.
5. Re-run the eval gate (`npm run eval`) to confirm the restored index matches the
   pre-cutover baseline.

This is an operational procedure, not new code: the cutover's job is to guarantee
step 2 always has a real, verified file to point at.
```

- [ ] **Step 2: Verify the doc**

Run: `grep -n "Rollback (abandoning a chunked index)" docs/eval-gate-protocol.md`
Expected: one match. Visually confirm the 5 steps render under the C2 cutover section.

- [ ] **Step 3: Commit**

```bash
git add docs/eval-gate-protocol.md
# via /commit — representative message:
# "Docs: add C2 cutover rollback procedure to eval-gate-protocol"
```

---

## Self-Review

**1. Spec coverage** (PRD = issue #45 body):
- Solution change 1 (unique timestamped path) → Task 2 Step 3(b). ✅
- Solution change 2 (verify before flag flip: size floor / count parity / integrity_check; throw before mutation) → Task 1 (`verifyBackup`) + Task 2 Step 3(b) call site. ✅
- Solution change 3 (flag flip + reindex unchanged) → preserved verbatim in Task 2. ✅
- Shared `verifyBackup(path, expectedCount)` helper in `migrations.ts` (LOCKED) → Task 1. ✅
- Size floor = 4096 (LOCKED) → Task 1 impl + test. ✅
- Count parity against live-count-read-pre-backup (load-bearing) → Task 2 captures `liveCount` before `backupDb`; `verifyBackup` asserts it. ✅
- Reuse `integrity_check`, not `verifyV3` wholesale → Task 1 uses the PRAGMA directly. ✅
- Open-and-close snapshot handle (finally) → Task 1 impl. ✅
- `backupPath` retained for test injection → Task 2 keeps the param; test "honors an explicitly injected backup path". ✅
- `.pre-c2.bak` collision invariant preserved → timestamped default never overlaps; Global Constraints + header comment. ✅
- `backupDb` unchanged → not touched. ✅
- Cutover logs the verified snapshot path (User Story 3) → return `backupPath` + CLI log (Task 2 Step 3d). ✅
- Rollback procedure documented (User Story 4) → Task 3. ✅
- Testing Decisions #1–#5 → stale-stub regression, corrupt abort-before-flip, happy parity, no-collision idempotency (reworked existing test), injected-path honored. ✅
- Out-of-scope items (rollback command, auto-rollback, retention, migrate.ts) → none built; Global Constraints. ✅

**2. Placeholder scan:** every code step shows complete, runnable code; every command has expected output. No TBD/TODO/"handle edge cases". ✅

**3. Type consistency:** `verifyBackup(path: string, expectedCount: number): void` is defined in Task 1 and called identically in Task 2. `runCutover` return `{ rechunked: number; backupPath: string }` is defined in Task 2's signature and consumed as `result.backupPath` in the same task's CLI block and tests. `db.name` is a `better-sqlite3` property. ✅

**Non-blocking nit carried from Gate 1:** the issue-body PRD cites `docs/eval-gate-protocol.md:130` for the one-way-migration definition; it actually lives at lines 193–195 (line 130 is file-granularity scoring). Task 3 appends to the correct section (after line 195), so the doc stays internally correct; no action needed beyond awareness.
