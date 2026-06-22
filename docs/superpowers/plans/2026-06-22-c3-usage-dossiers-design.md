# C3 Usage-Evidence Dossiers — Implementation Plan (DESIGN-ONLY, gated on C2 cutover)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> ⛔ **IMPLEMENTATION IS GATED.** Do NOT execute this plan until the deferred **C2 cutover** has run (`npm run cutover`, human-gated, after a curation session + eval baseline). Until then the live index holds whole-file rows (`anchor=''`), not the entry-granular rows C3's telemetry must bind to — accruing telemetry now would mis-attribute recall/distinct-query counts to whole-file observations. The **DESIGN below may proceed now** (it does not require the entry-granular rows to exist; only the implementation/telemetry-accrual does — per issue #31's 2026-06-17 PMO note). This document IS that design.

**Goal:** Give the monthly memory-merger (and experience-synthesis) human gate usage evidence — recall count, distinct-query count, recency, decay score, and an advisory graduation badge — for every graduate/keep/prune proposal, so the human decides on evidence instead of intuition. Evidence in, human decision out — always.

**Architecture:** A new `access_queries` side table (mirroring `access_stats`) tracks per-(observation, SHA-256 query-hash) access, written best-effort inside the existing post-search transaction. A new read-only MCP tool `get_usage_dossier` returns per-observation evidence including a server-side decay score (the exact existing reinforcement recency convention — `exp(-ageDays / HALF_LIFE_DAYS)`, `HALF_LIFE_DAYS = 30`, imported from `search_config.ts`, not re-derived — defined ONCE in the tool, not duplicated across skills). The memory-merger + experience-synthesis skills gain the tool in their allowed-tools and present its evidence with an advisory badge (recall≥3 AND distinct-queries≥3). Nothing auto-acts; retrieval scoring (the ≤0.01 reinforcement cap) is untouched.

**Tech Stack:** TypeScript, better-sqlite3, `node:crypto` (SHA-256, stdlib — no new dep), zod, vitest.

## Global Constraints

- **Gated on C2 cutover** — see the banner above. The design is complete now; execution waits for `npm run cutover`.
- **Never store raw query text** — only `crypto.createHash("sha256")` of the case-folded, trimmed query.
- **Never change retrieval scoring** — `W_REINFORCE = 0.01` (`search_config.ts:27`), `reinforcementBonus` (`ranking.ts:42-56`), and `rankCandidates` (`ranking.ts:98`) are READ-ONLY for this work. C3 is read-side reporting, not a ranking input.
- **Evidence in, human decision out** — no auto-promote/prune/demote driven by telemetry. The badge is advisory; the tool is read-only.
- **No new npm dependency** — SHA-256 is `node:crypto` stdlib.
- **The telemetry write is best-effort** — it rides the existing `try/catch` post-search transaction; a telemetry write must NEVER fail a search (read-path isolation).
- **Decay score lives server-side** (in the tool), reusing the exact reinforcement recency formula `exp(-ageDays / HALF_LIFE_DAYS)` (`HALF_LIFE_DAYS = 30`, imported from `search_config.ts`) — one definition, both skills consume it consistently (the repo's "define once" convention, cf. shared `parseEntries`). NOT a true half-life (`exp(-ln2·age/30)`) — that would diverge from `ranking.ts:50`.

---

### Task 1: `access_queries` side table (additive, via initSchema)

**Files:**
- Modify: `mcp/src/db.ts` (initSchema, after the `access_stats` block at `:103-107`)
- Test: `mcp/test/db.test.ts`

**Interfaces:**
- Produces a new table:
  ```sql
  CREATE TABLE IF NOT EXISTS access_queries (
    observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
    query_hash     TEXT    NOT NULL,
    access_count   INTEGER NOT NULL DEFAULT 0,
    first_seen     INTEGER,
    last_seen      INTEGER,
    PRIMARY KEY (observation_id, query_hash)
  );
  ```
  Mirrors `access_stats` (per-observation, FK-cascade, FTS-trigger-free — additive like `novelty_flags` at `db.ts:114-128`, NOT a migration). The composite PK gives distinct-query count via `COUNT(*)` per observation.

- [ ] **Step 1: Write the failing test** — in `db.test.ts`, after `openDb(tmp)`, assert `access_queries` exists (`PRAGMA table_info(access_queries)` returns the 5 columns) and that deleting an observation cascade-deletes its `access_queries` rows (insert obs + query row, delete obs, assert the query row is gone — proves `ON DELETE CASCADE` + foreign_keys ON).
- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/db.test.ts -t "access_queries"` → FAIL (table missing).
- [ ] **Step 3: Implement** — add the `CREATE TABLE IF NOT EXISTS access_queries (...)` block in `initSchema` immediately after `access_stats` (`db.ts:107`).
- [ ] **Step 4: Run to verify it passes** — same command → PASS.
- [ ] **Step 5: Commit** — `Feat: add access_queries telemetry side table (C3)`.

---

### Task 2: Best-effort per-query telemetry write (rides the existing transaction)

**Files:**
- Modify: `mcp/src/tools/search_memory.ts` (the best-effort `access_stats` bump transaction at `:228-242`)
- Test: `mcp/test/tools.test.ts` (mirror the reinforcement tests at `:154-185`)

**Interfaces:**
- Consumes: the `access_queries` table (Task 1); `args.query`; and two in-scope values at the bump site — `now` (defined at `search_memory.ts:191`) and the materialized `results` array (built at `:210-223`, the ranked+shaped rows the bump loops over at `:236-239`). NOTE: only `now` exists at `:191`; `results` is materialized later (`:210-223`), so add the per-query UPSERT inside the existing transaction at `:228-242`, NOT up at `:191`.
- Produces: a `query_hash` helper — `sha256(query.trim().toLowerCase())` via `node:crypto`. Writes one UPSERT per (observation_id, query_hash) inside the SAME `db.transaction(...)` closure as the `access_stats` bump.

- [ ] **Step 1: Write the failing tests** — `now` is computed inside `searchMemory` (`Math.floor(Date.now()/1000)`) and the existing tests do NOT freeze time, so **freeze it** before asserting timestamps: `vi.useFakeTimers(); vi.setSystemTime(new Date(FIXED_MS))` in the test (restore with `vi.useRealTimers()` in teardown), OR assert a bounded range (`first_seen` within `[t0, t1]` captured around the call) instead of exact equality — never assert `=== now` against an unfrozen clock (flaky). Tests: (a) after `searchMemory(db, {query})`, `access_queries` has one row per returned observation, all sharing the SHA-256 of the normalized query, `access_count=1`, and `first_seen === last_seen` equal to the frozen time. (b) re-querying with the SAME query (advance the fake clock first) increments `access_count` and bumps `last_seen` to the new time while `first_seen` is unchanged. (c) a DIFFERENT query for an overlapping observation adds a SECOND (obs, hash) row → `COUNT(DISTINCT query_hash)` for that obs is 2. (d) raw query text is NEVER stored — assert no column contains the literal query string (only the hash). (e) read-path isolation — an injected telemetry-write failure does NOT fail the search (mirror the best-effort `catch`).
- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/tools.test.ts -t "access_queries"` → FAIL.
- [ ] **Step 3: Implement** — add a `query_hash` const (sha256 of normalized `args.query`) and a second prepared UPSERT inside the existing `db.transaction((rows)=>{...})` closure (the bump at `search_memory.ts:236-239`, inside the best-effort `try` at `:228-242`), looping the same returned rows. Keep it inside that same `try/catch` so it never fails the read.
- [ ] **Step 4: Run to verify they pass** — same command → PASS.
- [ ] **Step 5: Commit** — `Feat: record per-query access telemetry best-effort on search (C3)`.

---

### Task 3: `get_usage_dossier` read-only MCP tool (with server-side decay)

**Files:**
- Create: `mcp/src/tools/get_usage_dossier.ts` (mirror `resolve_novelty_flag.ts` — zod `*Input`, `*Definition`, exported fn)
- Test: `mcp/test/tools.test.ts` (mirror an existing **pure-SELECT, write-free** tool test — e.g. the `get_recent_learnings` / `list_episodes` read-only blocks. NOTE: do NOT mirror the `scan_novelty + resolve_novelty_flag` block at `:890-913` as a "read-only" pattern — `scan_novelty` performs INSERTs into `novelty_flags`, so it is not write-free; using it as the read-only template would mislead. The read-only contract test (Step 1d) is the authority for the no-writes assertion.)

**Interfaces:**
- Consumes: `access_stats`, `access_queries`, `observations` (joins). Takes `db` + zod-validated args.
- Produces:
  ```ts
  export const getUsageDossierDefinition; // name: "get_usage_dossier", read-only
  export function getUsageDossier(db, rawArgs): UsageDossier[];
  // args (all optional filters), snake_case to match every existing MCP tool input
  // (cf. search_memory's source_filter/project_filter, scan_experience's max_episodes —
  //  do NOT use camelCase, it would make the public tool API inconsistent):
  //   { source_type?, project?, path_prefix?, limit? }
  // each result row (the JSON the tool returns) — field naming follows the existing
  // tool-result convention; keep it consistent with neighbouring tools:
  //   { source_path, anchor, title, access_count, distinct_queries,
  //     days_since_last_access, decay_score, badge: boolean }
  // decay_score: REUSE the exact reinforcement recency convention so the dossier and
  //   the re-ranker never diverge — exp(-ageDays / HALF_LIFE_DAYS), where
  //   HALF_LIFE_DAYS = 30 (import it from search_config.ts; do NOT re-derive). This is
  //   an exponential decay with a 30-day *e-folding* constant, NOT a true half-life:
  //   at 30 days the score is e^-1 ≈ 0.368, not 0.5. Do NOT write exp(-ln(2)*age/30) —
  //   that would diverge from ranking.ts:50. badge = access_count>=3 && distinct_queries>=3.
  //
  // COLD-START (never-accessed rows): match reinforcementBonus EXACTLY. ranking.ts:48
  //   uses `effectiveLast = lastAccessed ?? indexedAt` — i.e. when access_stats has no
  //   row / last_accessed IS NULL, age is measured from the observation's indexed_at,
  //   NOT from a NULL. The dossier MUST do the same: ageDays =
  //   max(0, (now - (last_accessed ?? observations.indexed_at)) / 86400). If you key
  //   ageDays off last_accessed alone, never-accessed rows get a NULL/ambiguous
  //   decay_score that diverges from reinforcement. days_since_last_access likewise:
  //   report it off the SAME effectiveLast (document that for a never-accessed row it
  //   is "days since indexed", and consider access_count===0 the signal that the row
  //   was never recalled). Round consistently (e.g. ageDays via floating-point as
  //   ranking does; round days_since_last_access for display only, never for the math).
  ```
  Pure SELECT — performs NO writes (read-only contract). `access_count`/`last_accessed`
  from `access_stats` (LEFT JOIN — a never-searched observation has NO access_stats row,
  so `access_count` defaults to 0 and `last_accessed` is NULL → cold-start fallback to
  `observations.indexed_at`); `distinct_queries` = `COUNT(DISTINCT query_hash)` from
  `access_queries` (also LEFT JOIN; 0 for never-recalled rows); `decay_score` +
  `days_since_last_access` computed in TS off `effectiveLast = last_accessed ?? indexed_at`.

- [ ] **Step 1: Write the failing tests** — (a) on a fixture corpus (seed observations + access_stats + access_queries), the dossier returns correct `access_count`, `distinct_queries` (the COUNT(DISTINCT) math), `days_since_last_access`, and `decay_score` — assert the decay against the exact `Math.exp(-ageDays / HALF_LIFE_DAYS)` value on a known last-accessed time (e.g. at 30 days ≈ 0.368, NOT 0.5). (b) badge true iff `access_count`≥3 AND `distinct_queries`≥3; false otherwise (test the boundary: 3/2 → false, 3/3 → true). (c) filters (`source_type` / `path_prefix`) narrow the result set. (d) **read-only contract** — call the tool, assert it performed NO writes (e.g. wrap db in a proxy that throws on `.run` of INSERT/UPDATE/DELETE, or snapshot row counts before/after). (e) **cold-start parity** — seed an observation with NO `access_stats` row and NO `access_queries` rows (never recalled), with a known `indexed_at`. Assert `access_count===0`, `distinct_queries===0`, and that `decay_score`/`days_since_last_access` are computed off `indexed_at` (the `effectiveLast` fallback) — NOT NaN/NULL — matching exactly what `reinforcementBonus(null, 0, indexedAt, now)` would produce for the recency term. This pins the divergence-from-reinforcement that a `last_accessed`-only implementation would introduce.
- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/tools.test.ts -t "get_usage_dossier"` → FAIL (tool not defined).
- [ ] **Step 3: Implement** — write `get_usage_dossier.ts` mirroring `resolve_novelty_flag.ts`'s structure; the SELECT **LEFT JOINs** observations → access_stats and selects `observations.indexed_at` (needed for the cold-start fallback), plus a `COUNT(DISTINCT query_hash)` subquery on access_queries (also LEFT, 0 for never-recalled rows). Compute `decay_score` + `days_since_last_access` + badge in TS off `effectiveLast = last_accessed ?? indexed_at`. For decay, **import `HALF_LIFE_DAYS` from `search_config.ts`** and compute `Math.exp(-ageDays / HALF_LIFE_DAYS)` where `ageDays = max(0, (now - effectiveLast) / 86400)` — the identical formula AND cold-start fallback as `ranking.ts:48-50` — so the dossier and the re-ranker never diverge, including for never-accessed rows. Do not re-derive a constant, use a true-half-life formula, or key age off `last_accessed` alone.
- [ ] **Step 4: Run to verify they pass** — same command → PASS.
- [ ] **Step 5: Commit** — `Feat: add read-only get_usage_dossier tool with server-side decay + badge (C3)`.

---

### Task 4: Register the tool in the MCP server

**Files:**
- Modify: `mcp/src/index.ts` (3 steps: import, list, switch case — mirror `resolve_novelty_flag` at `:41-45`, `:201`, `:228-229`)

**Interfaces:** Consumes Task 3's `getUsageDossier` + `getUsageDossierDefinition`.

- [ ] **Step 1: Verification target** — like the index.ts wiring in #34, there is no isolated `main()` test; the verifying evidence is `npm run build` (tsc) + the tool appearing in the ListTools response + the green suite. Disclose this (no faked test).
- [ ] **Step 2: Baseline** — `npm run build` clean before the change.
- [ ] **Step 3: Implement** — (1) import `getUsageDossier, getUsageDossierDefinition` (`index.ts:~45`); (2) add `getUsageDossierDefinition` to the `tools:[]` array (`index.ts:~206`); (3) add `case "get_usage_dossier": return jsonResult(getUsageDossier(db, args ?? {}));` to the switch (`index.ts:~234`).
- [ ] **Step 4: Verify** — `npm run build && npm test` → build clean, suite green (+ the new db/tool tests).
- [ ] **Step 5: Commit** — `Feat: register get_usage_dossier in the MCP server (C3)`.

---

### Task 5: Wire the dossier into the consumer skills (prose, not code)

**Files:**
- Modify: `skills/memory-merger/SKILL.md` (allowed-tools `:10` + the graduate/keep/prune proposal step)
- Modify: `skills/experience-synthesis/SKILL.md` (allowed-tools `:11` + the cluster-summary step)

**Interfaces:** Consumes the registered `get_usage_dossier` tool.

- [ ] **Step 1: No unit test** (prose changes — instructions to the agent, not executable code; the PRD's Testing Decisions EXCLUDE skill prose). Verifying evidence: the allowed-tools line includes the tool and the step text instructs presenting the evidence + badge.
- [ ] **Step 2: Implement** — add `mcp__claude-os-mcp__get_usage_dossier` to BOTH allowed-tools lines. In memory-merger's proposal step, instruct: call the dossier for each graduate/keep/prune candidate, present recall/distinct-queries/recency/decay beside the proposal, and show the advisory badge (recall≥3 AND distinct-queries≥3) — emphasizing the decision stays the human's, the badge informs and never filters. In experience-synthesis's cluster-summary step, instruct: surface member-episode recall counts in the summary presented to the human gate.
- [ ] **Step 3: Commit** — `Docs: present usage dossiers in memory-merger + experience-synthesis (C3)`.

---

### Task 6: Eval-gate non-regression (verification)

**Files:** none (verification only).

- [ ] **Step 1** — C3 changes telemetry recording + a read-only reporting tool; it does NOT touch ranking/embedding math (the ≤0.01 cap, `reinforcementBonus`, `rankCandidates` are untouched). Per the project memory-engine rule, run `npm run eval` and confirm a non-regressing PASS (byte-identical expected). Capture for the PR audit trail.
- [ ] **Step 2** — `npm test` green (Stage-1 archive exclusion + all suites + the new C3 tests).

---

## The unblock sequence (for whoever executes this)

1. **Sir's curation session** — finalize the held-out labeled query set (per `docs/eval-gate-protocol.md` C2 cutover note).
2. **`npm run eval -- --rebaseline`** — capture the whole-file baseline.
3. **`npm run cutover`** — the C2 chunk-split (one-way; produces a verified pre-cutover snapshot).
4. **`npm run eval`** — confirm the cutover did not regress retrieval (PASS required).
5. **THEN execute this plan** — telemetry now binds to the entry-granular rows the design assumes.

Until step 5, C3 stays design-only. This document is the verified design (red-blue-judge `plan`-gated); the code does not exist yet by deliberate sequencing.

## Self-Review

**Spec coverage (PRD #31 user stories → tasks):** US1 (recall/distinct-queries/recency per proposal) → Tasks 2+3+5; US2 (decay score ranks prune candidates) → Task 3; US3 (advisory badge) → Task 3+5; US4 (distinct queries per observation) → Tasks 1+2; US5 (best-effort write, never fails a search) → Task 2 (read-path isolation test); US6 (hashes only, never raw text) → Task 2 (test d); US7 (episode usage in synthesis) → Task 5; US8 (read-only tool) → Task 3 (read-only contract test); US9 (built after C2) → the gating banner + unblock sequence; US10 (threshold calibration on a disjoint set) → noted: the badge thresholds (3/3) are the OpenClaw shipped defaults, NOT tuned against the held-out eval set (no `search_config.ts` change). ✓

**Invariants:** retrieval untouched (Global Constraints), archive-before-delete unaffected, local-only, human-gated promotion unchanged. ✓

**Placeholder scan:** Tasks 1-3+6 are TDD with concrete assertions; Task 4 (index.ts wiring) + Task 5 (skill prose) honestly disclose no isolated unit test and name verifying evidence — disclosed, not faked. ✓

**Type consistency:** `getUsageDossier`/`getUsageDossierDefinition`, `UsageDossier` row shape, `access_queries` columns consistent across Tasks 1-4. ✓
