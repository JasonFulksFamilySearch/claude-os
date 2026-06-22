# D3 Single-Writer Index Maintenance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Elect exactly one MCP instance to run index maintenance (startup reindex, file watcher, 15-min backstop) via an mkdir-based heartbeat lock, so N concurrent sessions stop duplicating maintenance against one SQLite/WAL writer slot.

**Architecture:** A new `WriterElection` module (`mcp/src/election.ts`) implements an mkdir-based lock (atomic `mkdirSync`, EEXIST → one winner; heartbeat via `utimesSync`; identity-guarded `rmdir`+`mkdir` takeover of a stale lock). `main()` in `index.ts` gates the three maintenance operations on holder status; non-holders skip them and poll. `db.ts` gains a `busy_timeout` pragma so any residual concurrent writer serializes instead of throwing `SQLITE_BUSY`. The two-holder takeover window is bounded (≤1 refresh interval), rare, and non-corrupting — an accepted residual (the irreducible cost of a userspace heartbeat lock; `flock` would eliminate it but is unavailable).

**Tech Stack:** TypeScript, Node ≥20 (`fs.mkdirSync`/`rmdirSync`/`utimesSync`/`readFileSync`/`writeFileSync`, all stdlib), better-sqlite3, vitest.

## Global Constraints

- **No new npm dependency** — the lock uses only `node:fs` stdlib primitives.
- **`mkdirSync` for the lock MUST be called WITHOUT `recursive: true`** — recursive mode returns silently instead of throwing `EEXIST`, destroying the atomicity the whole design rests on. (`db.ts:11` uses `recursive: true` for the data dir — do not copy that idiom for the lock.)
- **Local-only** — the lock is a machine-local directory; no network.
- **Tool surface unchanged** — the election scopes MAINTENANCE only. Searches, query embedding, `append_learning`'s own `indexFile`+embed, and access-stat bumps still run in every instance.
- **Ranking weights (`search_config.ts`) and the held-out eval set are untouched.**
- **Eval-gate:** baseline already captured pre-change (recall@5=0.9286, MRR=0.9286). After implementation, `npm run eval` must compose a non-regressing PASS (expected byte-identical — this is a lifecycle change, not a ranking change).
- Tests mirror the raw-fd temp-dir harness in `mcp/test/migrations.test.ts` (`mkdtempSync` + `mkdirSync`/`writeFileSync`/`utimesSync`/`rmSync`, `beforeEach`/`afterEach` temp-dir lifecycle).

---

### Task 1: WriterElection module — acquire (atomic mkdir test-and-set)

**Files:**
- Create: `mcp/src/election.ts`
- Test: `mcp/test/election.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module; takes an injectable lock path for testability, mirroring how `openDb(dbPath)` takes an injectable path).
- Produces:
  ```ts
  // The lock directory path is derived from the data root, sibling of memory.db.
  export function defaultLockPath(): string; // join(homedir(), ".claude-data", "memory.db.writer.lock.d")
  export interface ElectionHandle {
    isHolder: boolean;      // mutable: flips to false if this holder loses its lock (see refresh)
    refresh(): void;        // holder: utimesSync the lock dir to "now". If utimesSync throws ENOENT
                            //   (our lock dir was removed by a takeover), this holder LOST the lock —
                            //   flip isHolder to false (self-heal). No-op + safe if already not holder.
    release(): void;        // holder: rmdirSync the lock dir (guarded on isHolder); no-op otherwise
  }
  // Attempt to acquire. Returns a holder handle if mkdir succeeded, else a non-holder handle.
  export function tryAcquire(lockPath: string, now: number): ElectionHandle;
  ```
  The holder writes `{ pid, startedAt }` JSON to a `meta` file INSIDE the lock dir after a successful `mkdirSync`. `tryAcquire` catches `EEXIST` from `mkdirSync` and returns a non-holder handle.

- [ ] **Step 1: Write the failing test** — in `election.test.ts`, mirror the `migrations.test.ts` temp-dir harness. Test: `tryAcquire` on a fresh lock path returns a handle with `isHolder === true`, the lock directory now exists, and its inner `meta` file contains the current pid. A second `tryAcquire` on the same path returns `isHolder === false` and does NOT disturb the first holder's meta.

- [ ] **Step 2: Run test to verify it fails** — Run: `npx vitest run test/election.test.ts -t "acquire"` · Expected: FAIL (module/function not defined).

- [ ] **Step 3: Write minimal implementation** — implement `defaultLockPath`, `tryAcquire`, and `ElectionHandle` in `election.ts`. `tryAcquire`: `try { mkdirSync(lockPath); /* NON-recursive */ writeFileSync(metaPath, JSON.stringify({pid, startedAt: now})); return holderHandle } catch (e) { if (e.code === 'EEXIST') return nonHolderHandle; throw e }`. `refresh()` on a holder `utimesSync(lockPath, now, now)`; `release()` on a holder `rmdirSync(lockPath)` (the `meta` file must be removed first — `rmSync(metaPath, {force:true})` then `rmdirSync(lockPath)`, or use `rmSync(lockPath, {recursive:true,force:true})` for release only).

- [ ] **Step 4: Run test to verify it passes** — Run: `npx vitest run test/election.test.ts -t "acquire"` · Expected: PASS.

- [ ] **Step 5: Commit** — `git add mcp/src/election.ts mcp/test/election.test.ts && /commit` ("Feat: add WriterElection mkdir-lock acquire").

---

### Task 2: Concurrent acquire elects exactly one holder (the EEXIST contract — pins recursive:false)

**Files:**
- Modify: `mcp/src/election.ts` (only if Task 1's impl needs hardening; likely no change)
- Test: `mcp/test/election.test.ts`

**Interfaces:** Consumes Task 1's `tryAcquire`. Produces nothing new.

- [ ] **Step 1: Write the failing test** — two `tryAcquire(samePath, now)` calls in sequence (simulating two contenders before either's maintenance starts): assert EXACTLY ONE returns `isHolder === true` and the other `isHolder === false`. Add a second assertion that directly proves the recursive:false contract: calling `mkdirSync(lockPath)` twice throws `EEXIST` on the second call (a guard test so a future refactor adding `recursive:true` fails loudly).

- [ ] **Step 2: Run test to verify it fails (or passes if Task 1 already correct)** — Run: `npx vitest run test/election.test.ts -t "one holder"` · Expected: PASS if Task 1's mkdir is non-recursive; this test exists to LOCK that property.

- [ ] **Step 3: Implementation** — none expected if Task 1 is correct; if the test fails because `tryAcquire` used `recursive:true`, fix to non-recursive.

- [ ] **Step 4: Run test to verify it passes** — Run: `npx vitest run test/election.test.ts -t "one holder"` · Expected: PASS.

- [ ] **Step 5: Commit** — `/commit` ("Test: pin single-holder EEXIST contract for the election mkdir-lock").

---

### Task 3: Staleness detection + identity-guarded takeover

**Files:**
- Modify: `mcp/src/election.ts`
- Test: `mcp/test/election.test.ts`

**Interfaces:**
- Consumes: Task 1's `tryAcquire`, `ElectionHandle`, lock-dir + meta layout.
- Produces:
  ```ts
  // Refresh interval + staleness multiple as module constants (mirror REINDEX_INTERVAL_MS at index.ts:46).
  export const HEARTBEAT_REFRESH_MS: number;   // default 60_000
  export const STALENESS_MULTIPLE: number;     // default 3
  // Returns true if the lock's heartbeat (lock-dir mtime) is older than STALENESS_MULTIPLE * HEARTBEAT_REFRESH_MS.
  export function isStale(lockPath: string, now: number): boolean;
  // Full election entry point: acquire, or if EEXIST and stale, take over (identity-guarded), else non-holder.
  export function elect(lockPath: string, now: number): ElectionHandle;
  ```
  `elect`: try `tryAcquire`; if holder → done. If non-holder, read the meta `{pid,startedAt}` and check `isStale`. If stale: **identity-guarded takeover** — re-read meta, and ONLY if the `{pid,startedAt}` still matches the stale identity just observed, `rmdirSync` the lock dir (catch `ENOENT` — benign) then `tryAcquire` again (the same atomic mkdir; EEXIST → a concurrent reaper won, stand down). If fresh → non-holder.

- [ ] **Step 1: Write the failing tests** — (a) `isStale` true when lock-dir mtime is set (via `utimesSync`) older than `STALENESS_MULTIPLE * HEARTBEAT_REFRESH_MS` before `now`, false when fresh. (b) `elect` on a stale lock takes over → `isHolder === true`, new meta has the current pid. (c) **identity-guarded unlink:** seed a stale lock, then between the staleness read and the rmdir, simulate the lock going fresh (rewrite meta with a different pid + bump mtime); assert `elect` does NOT rmdir/clobber it and returns `isHolder === false`. (d) **concurrent takeover elects one holder:** two `elect` calls against the same stale lock → exactly one `isHolder === true`. (e) **takeover self-heal (pins the bounded-window upper bound — rev-5 Testing Decision):** acquire a holder handle, then simulate a takeover by another instance — `rmSync(lockPath, {recursive:true,force:true})` then re-`mkdirSync(lockPath)` with a different pid's meta (a new holder claimed it). Call the original holder's `refresh()`; assert it catches the `ENOENT` from `utimesSync` on its (now-replaced) dir, flips `isHolder` to `false`, and does NOT clobber the new holder's lock. This is the mechanism that bounds the two-holder window to one heartbeat interval.

- [ ] **Step 2: Run tests to verify they fail** — Run: `npx vitest run test/election.test.ts -t "takeover"` · Expected: FAIL (`isStale`/`elect` not defined; `refresh()` self-heal not implemented).

- [ ] **Step 3: Write minimal implementation** — add `HEARTBEAT_REFRESH_MS`, `STALENESS_MULTIPLE`, `isStale` (`statSync(lockPath).mtimeMs < now - STALENESS_MULTIPLE*HEARTBEAT_REFRESH_MS`), and `elect` with the identity-guarded takeover described in Interfaces. The identity guard re-reads meta immediately before `rmdirSync` and compares `{pid,startedAt}`. **Make `refresh()` self-healing:** wrap the holder's `utimesSync(lockPath,...)` in a try/catch; on `ENOENT` (the lock dir was removed out from under this holder by a takeover), set `this.isHolder = false` and return — this is the self-heal that lets a clobbered holder detect its loss on the next heartbeat tick and stop running maintenance, bounding the two-holder window to ≤1 refresh interval. (Re-throw non-ENOENT errors.)

- [ ] **Step 4: Run tests to verify they pass** — Run: `npx vitest run test/election.test.ts -t "takeover"` · Expected: PASS.

- [ ] **Step 5: Commit** — `/commit` ("Feat: add staleness detection + identity-guarded takeover to WriterElection").

---

### Task 4: Add busy_timeout to openDb

**Files:**
- Modify: `mcp/src/db.ts:12-14` (after the `new Database` + before/with the other pragmas)
- Test: `mcp/test/db.test.ts` (add to the existing suite)

**Interfaces:** Consumes nothing new. Produces no new export — behavior change to `openDb`.

- [ ] **Step 1: Write the failing test** — in `db.test.ts`, open a temp DB via `openDb(dbPath)` and assert `db.pragma("busy_timeout", { simple: true })` returns a non-zero value (e.g. 5000). (better-sqlite3 exposes `db.pragma`.)

- [ ] **Step 2: Run test to verify it fails** — Run: `npx vitest run test/db.test.ts -t "busy_timeout"` · Expected: FAIL (default busy_timeout is 0).

- [ ] **Step 3: Write minimal implementation** — in `openDb` (`db.ts`), add `db.pragma("busy_timeout = 5000");` alongside the existing `journal_mode`/`foreign_keys` pragmas (after `new Database`, before `sqliteVec.load` is fine).

- [ ] **Step 4: Run test to verify it passes** — Run: `npx vitest run test/db.test.ts -t "busy_timeout"` · Expected: PASS.

- [ ] **Step 5: Commit** — `/commit` ("Fix: set busy_timeout so a concurrent writer waits instead of throwing SQLITE_BUSY").

---

### Task 5: Non-holder shutdown safety (refactor shutdown before wiring election)

**Files:**
- Modify: `mcp/src/index.ts:173-185` (the `shutdown` closure)

**Interfaces:** Consumes nothing new yet. Produces a shutdown closure safe for an undefined watcher and an optional election handle.

- [ ] **Step 1: Write the failing test** — this is hard to unit-test against `main()` (no `index.test.ts`, and `main()` boots the server). Instead, make the change SAFE BY CONSTRUCTION and rely on Task 6's wiring + the type checker: the `watcher` binding becomes `FSWatcher | undefined`, and `shutdown` uses `watcher?.close()`. Because there's no isolated test target for `main()`, the verifying evidence here is `npm run build` (tsc proves `watcher?.close()` typechecks against `FSWatcher | undefined`) + the Task 6 integration. NOTE in the commit that this task has no standalone unit test by design (main() is untested today; see PRD Testing Decisions).

- [ ] **Step 2: Establish the baseline** — Run: `npm run build` · confirm current state compiles.

- [ ] **Step 3: Refactor `shutdown`** — declare BOTH forward bindings this task so `index.ts` compiles at THIS task's checkpoint (the assignments land in Task 6's holder branch):
  - `let watcher: FSWatcher | undefined;` (replaces `const watcher = watchAll(...)` at `:99`).
  - `let election: ElectionHandle | undefined;` — declare it here too, even though `elect(...)` is called in Task 6. This is required: the shutdown closure below references `election`, and `tsc` (=`npm run build`) errors `TS2304: Cannot find name 'election'` for an UNDECLARED identifier — `?.` guards a null/undefined *value*, not an undeclared *name*. Declaring it `undefined` here makes Task 5 compile standalone; Task 6 assigns it.
  - Add the imports: `import type { FSWatcher } from "chokidar";` (the return type of `watchAll`, per `indexer.ts:2`/`:651`) and `import type { ElectionHandle } from "./election.js";` (from Task 1).
  - Change the shutdown closure: `void (watcher?.close() ?? Promise.resolve()).finally(() => { election?.release(); try { db.close(); } catch {} process.exit(0); });` — close the watcher null-safely, release the lock if held (`election?.release()` is a no-op when `election` is undefined or not the holder), then close the db.

- [ ] **Step 4: Verify it compiles** — Run: `npm run build` · Expected: PASS (tsc accepts the optional watcher + optional election).

- [ ] **Step 5: Commit** — `/commit` ("Refactor: make shutdown null-safe for a non-holder (no watcher) and release the lock").

---

### Task 6: Wire the election into main() — gate the three maintenance ops

**Files:**
- Modify: `mcp/src/index.ts` (`main()`, lines ~93-111 + heartbeat timer + non-holder poll)

**Interfaces:** Consumes `elect`, `ElectionHandle`, `defaultLockPath`, `HEARTBEAT_REFRESH_MS` from `election.ts`.

- [ ] **Step 1: Write the failing test** — same constraint as Task 5 (no `main()` test target). The verifying evidence is `npm run build` + `npm test` (full suite stays green) + manual reasoning against the plan. Document this explicitly in the commit. (The election LOGIC is fully unit-tested in Tasks 1-3; Task 6 is the wiring, verified by tsc + the green suite + the Gate-3 diff review.)

- [ ] **Step 2: Establish baseline** — Run: `npm test` · confirm 369/369 green before wiring.

- [ ] **Step 3: Implement the wiring** — in `main()`, after `openDb()`/`buildConfig()`:
  - `election = elect(defaultLockPath(), Date.now());` — ASSIGN the `let election` declared in Task 5 (do NOT re-declare with `const`, or it shadows Task 5's binding and the shutdown closure sees `undefined`).
  - Gate the three maintenance ops on `election.isHolder`:
    - startup `await fullReindex(...)` (`:96`) → only when holder; non-holders skip the awaited reindex (connect faster).
    - `watcher = watchAll(...)` (`:99`) → only when holder (ASSIGN the `let watcher` from Task 5, not a new `const`).
    - the `backstop` `setInterval` (`:104-111`) → only when holder.
  - When holder: also start a `heartbeat` `setInterval(() => { election.refresh(); if (!election.isHolder) { /* lost the lock to a takeover — stop maintenance, become a non-holder poller */ clearInterval(heartbeat); clearInterval(backstop); void watcher?.close(); watcher = undefined; /* start the non-holder poll below */ } }, HEARTBEAT_REFRESH_MS)` and `heartbeat.unref()` (mirror `backstop.unref()` at `:111`). This is the self-heal wiring: when `refresh()` detects ENOENT and flips `isHolder` (Task 3), the holder tears down its maintenance and reverts to polling — bounding the two-holder window. Mark with a `yagni:` comment if the teardown is kept minimal.
  - When NOT holder: start a `poll` `setInterval` on the same `HEARTBEAT_REFRESH_MS` cadence that calls `elect(...)` again; if it becomes holder, run the catch-up `await fullReindex(...)`, start the watcher + backstop + heartbeat, and clear the poll. (Keep this minimal; a non-holder that never becomes holder just serves tools.) Mark any deliberate simplification with a `yagni:` comment.
  - Shutdown (Task 5) already releases `election`.
  - **The election mkdir is non-recursive (Task 1) — do not change that.**

- [ ] **Step 4: Verify** — Run: `npm run build && npm test` · Expected: build PASS, suite still 369/369 (+ the new election tests from Tasks 1-3) green. No existing test regresses.

- [ ] **Step 5: Commit** — `/commit` ("Feat: elect a single index-maintenance holder via the WriterElection lock").

---

### Task 7: Eval-gate verification (non-regression)

**Files:** none (verification only).

- [ ] **Step 1: Run the eval gate** — Run: `npm run eval` · Expected: composes a verdict against the pre-change baseline (recall@5=0.9286, MRR=0.9286 in `~/.claude-data/eval-baseline.json`).
- [ ] **Step 2: Confirm PASS** — Expected: `Presence: PASS` with recall@5 ≥ 0.9286 AND MRR ≥ 0.9286 (byte-identical expected — D3 changes lifecycle, not ranking). If INCONCLUSIVE for a file-set-shape reason unrelated to D3, note it; a presence FAIL would be a real red flag to investigate (D3 should not move retrieval).
- [ ] **Step 3: Record** — capture the eval output for the Gate-3 / PR audit trail. No commit (verification step).

---

## Self-Review

**Spec coverage:** PRD user stories → Task 6 (one holder runs the 3 ops; non-holders skip+poll), Task 3 (stale takeover + catch-up + **self-heal**), Task 1+2 (acquire/EEXIST), Task 5 (non-holder shutdown safety — rev 1), Task 4 (busy_timeout — rev 4/5), Task 7 (eval non-regression). All FIVE rev-5 Testing Decisions are covered: concurrent-acquire+EEXIST (Task 2), identity-guarded rmdir (Task 3c), **takeover self-heal (Task 3e + the ENOENT-aware `refresh()` impl + Task 6 teardown wiring)**, busy_timeout (Task 4), non-holder clean shutdown (Task 5, disclosed-no-isolated-test). The bounded-window framing (rev 5) is an accepted residual — no task "fixes" it; Task 3's identity guard shrinks it, Task 3's self-heal + Task 6 teardown BOUND it to ≤1 refresh interval, and Task 4's busy_timeout makes it safe. ✓

**Placeholder scan:** test bodies are described with concrete assertions; the two wiring tasks (5, 6) honestly state they have no isolated `main()` unit test and name their verifying evidence (tsc + green suite + the unit-tested election logic + Gate-3) rather than faking a test — this is disclosed, not a placeholder. ✓

**Type consistency:** `ElectionHandle` (`isHolder`, `refresh()`, `release()`), `tryAcquire`/`elect`/`isStale`/`defaultLockPath`/`HEARTBEAT_REFRESH_MS`/`STALENESS_MULTIPLE` are used consistently across Tasks 1, 3, 6. `watcher: FSWatcher | undefined` consistent across Tasks 5, 6. ✓
