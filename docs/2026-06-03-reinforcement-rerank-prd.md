# PRD — Reinforcement-Weighted Hybrid Re-Rank for `search_memory` (A1)

**Date:** 2026-06-03
**Status:** Draft for implementation
**Scope:** `claude-os-mcp` memory retrieval
**Precedent:** `docs/2026-06-02-q8-embedding-quantization-prd.md`

> This PRD was written against verified codebase ground truth (three read-only
> exploration passes over `mcp/src`, `hooks/`, and the live `memory.db`). Where the
> originating strategic briefing's verbal model disagreed with the code, the code won —
> those corrections are called out inline.

---

## Problem Statement

When Willis searches memory, the results are not ranked the way a person would expect
"best match first" to work. The retrieval tool runs two searches — a keyword (FTS5/BM25)
search and a semantic (vector) search — but it does **not** combine them into a single
ranked list. It returns all keyword hits first, in keyword order, and then appends the
semantic-only hits at the end with a sentinel value, and the combined list is never
re-sorted. The practical consequence: **every keyword hit outranks every semantic-only
hit, no matter how strong the semantic match or how weak the keyword match.** A memory
that is obviously, semantically the right answer can sit below a memory that merely shares
a common word.

Two further problems compound this:

1. **The ranking is time-blind.** Each memory row already carries timestamps, but nothing
   about recency or how often a memory has actually been useful influences its rank. A
   thread of memories central to the task at hand gets no preference over a stale memory
   that happens to share vocabulary.

2. **There is no signal that a memory has proven useful.** Nothing is recorded when a
   memory is retrieved, so the system cannot let "this keeps coming up and being relevant"
   reinforce a memory's standing over time.

The result is a retrieval layer whose precision has a hard ceiling that better embeddings
cannot raise, because the ceiling is in the *ranking*, not the *recall*.

---

## Solution

Replace the keyword-first concatenation with a single fused ranking, computed in three
additive layers, then sorted best-first and truncated to the requested limit:

1. **Reciprocal Rank Fusion (RRF)** blends the keyword and semantic result sets into one
   relevance score. A memory found by *both* retrievers naturally rises; a strong
   semantic-only match is no longer trapped beneath weak keyword matches. This is the core
   fix.

2. **A bounded reinforcement bonus** gives a *small* lift to memories that were retrieved
   recently and/or often. Crucially this is an **additive bonus, never an age penalty** —
   an old-but-relevant fact (e.g., a stable repo convention) keeps its full relevance score
   and is never demoted for being old. Retrieving a memory reinforces it (updates its
   last-accessed time and increments its access count), so the threads of an active task
   stay close at hand. The bonus is bounded by `W_REINFORCE`, so it only reorders results whose
   relevance scores already sit within that small band of each other; it never lowers any
   score and can never substitute for relevance (see Bound invariants).

3. **An exact-match boost** lifts a memory whose title (or, more weakly, whose body)
   contains the query verbatim, so precise lookups of a known name land at the top.

Retrieving memory becomes self-reinforcing: the memories Willis actually uses become
marginally easier to find again, while relevance remains the dominant ordering signal and
nothing is ever buried merely for being old.

---

## User Stories

1. As Willis, I want keyword and semantic hits fused into one ranked list, so that a
   strongly semantic match is not buried beneath every weak keyword match.
2. As Willis, I want a memory I just retrieved to be slightly more likely to resurface
   soon, so that the threads of an ongoing task stay close at hand.
3. As Willis, I want frequently-used durable facts to stay highly ranked regardless of age,
   so that stable knowledge (repo conventions, workflow rules) is not penalized for being
   old.
4. As Jason, I want retrieval quality measured before and after the change, so that I can
   trust the re-rank improved results and did not regress them.
5. As Willis, I want an exact title match on my query to surface that memory near the top,
   so that precise lookups of a known topic name return the right document first.
6. As an implementer, I want the schema migration to be idempotent and safe to run on every
   server start, so that there is no duplicate-column crash and no manual migration step.
7. As an implementer, I want the new tuning weights as named, test-pinned constants, so
   that ranking can be calibrated without hunting through query strings.
8. As Jason, I want the re-rank to degrade gracefully if the embedder or the keyword query
   fails, so that search never returns nothing because of a ranking-layer error.
9. As Willis, I want results truncated to the requested limit after fusion, so that I get
   exactly the top-N I asked for, not a padded double-length list.
10. As Walter, I want my access reinforcement local to my own data store, so that my
    retrieval patterns neither depend on nor leak into Willis's.
11. As Jason, I want the access-count update to be best-effort, so that a write failure
    during a search never fails the read.
12. As an implementer, I want pre-existing rows to participate in recency scoring immediately
    via a sensible cold-start default (no backfill step required), so that existing memories
    are scored fairly from the first search.
13. As Willis, I want never-accessed memories to start from their content recency, so that
    fresh, never-retrieved notes are not ranked as if infinitely stale.
14. As Jason, I want the reinforcement bonus bounded so it cannot flip a clearly stronger
    relevance match, so that ranking stays relevance-first with recency as a tie-breaker.
15. As an implementer, I want the offline eval and its baseline committed, so that future
    ranking changes have a regression gate to run against.
16. As Willis, I want the fused result to expose a single "higher is better" score, so that
    ordering is unambiguous to whatever consumes the results.

---

## Implementation Decisions

### Ranking model

- **Candidate retrieval (oversample).** Each retriever fetches more candidates than the
  final limit: `C = min(CANDIDATE_CAP, limit × CANDIDATE_MULTIPLIER)`. The keyword
  retriever returns up to `C` rows in BM25 order; the semantic retriever returns up to `C`
  rows in ascending-distance order. Each retriever's output yields a 1-based ordinal
  position per memory.
- **RRF base score.** For a memory `d`, summed over the retrievers that returned it:
  `rrf(d) = Σ 1 / (RRF_K + position_r(d))`, with `RRF_K = 60`. A memory returned by both
  retrievers receives both terms, which boosts it relative to a comparable solo hit — though
  not unconditionally above *every* solo hit (a both-retriever hit deep in both candidate
  lists scores `2/(RRF_K+pos)`, which can fall below a strong rank-1 solo hit; see Bound
  invariants). RRF uses rank *position*, not the raw BM25/distance values, so the two
  incomparable score scales never need normalizing.
- **Reinforcement bonus (bounded, additive, non-penalizing).**
  `reinforce(d) = W_REINFORCE × (recency + frequency) / 2`, where
  `recency = exp(−age_days / HALF_LIFE_DAYS)` (age measured from last-accessed; range (0,1])
  and `frequency = min(1, ln(1 + access_count) / ln(1 + FREQ_SATURATION))` (range [0,1]).
  Defaults: `W_REINFORCE = 0.01`, `HALF_LIFE_DAYS = 30`, `FREQ_SATURATION = 20`.
  The `last_accessed`/`access_count` inputs are read by LEFT JOINing the `access_stats` side
  table; a candidate with no `access_stats` row coalesces to `last_accessed = indexed_at` and
  `access_count = 0` (never-accessed cold start).
- **Exact-match boost (rescaled).** If the normalized (trimmed, case-folded) query is a
  substring of the case-folded title, add `W_EXACT_TITLE`; else if it appears as an exact
  phrase in the case-folded body, add `W_EXACT_CONTENT`. Title takes precedence; the two are
  not additive. Defaults: `W_EXACT_TITLE = 0.016`, `W_EXACT_CONTENT = 0.008`.
  **Correction from the briefing:** the briefing's literal "+0.15" boost was lifted from a
  system that scores on a normalized 0–1 scale. RRF scores here are ~`1/(60+rank) ≈ 0.016`,
  so a literal 0.15 would dominate everything. The boost is rescaled to RRF-comparable
  units. Do not "fix" it back to 0.15.
- **Final score and order.** `score(d) = rrf(d) + reinforce(d) + exactmatch(d)`. Sort by
  `score` descending; break ties by `rrf` descending, then by `indexed_at` descending, then by
  `observations.id` ascending. The final `id` key is a **stable, unique total-order
  tiebreaker** and is load-bearing: the earlier keys genuinely collide — a keyword hit and a
  vector hit at the same ordinal position get identical `rrf` (`1/(RRF_K+pos)` each), and at
  the post-migration cold start every row shares the same `reinforce` and `indexed_at`
  defaults (and the live corpus already has large same-`indexed_at` clusters), so without a
  unique final key distinct rows could sort nondeterministically. Truncate to `limit` *after*
  this total ordering.
- **Bound invariants (the "relevance-first" guarantee).** Reinforcement is purely *additive*
  and *bounded* by `W_REINFORCE`, which yields exactly what the requirement's "mild
  tie-breaker, never penalize age" calls for: **(a) no memory is ever demoted for age** — the
  reinforcement term is non-negative, so a durable, rarely-accessed fact keeps its full RRF
  score and is never pushed down by the recency/frequency mechanism; and **(b) reinforcement
  can only reorder two candidates whose RRF scores differ by less than `W_REINFORCE`** — if
  `rrf(A) − rrf(B) ≥ W_REINFORCE`, no reinforcement lets `B` overtake `A` (`B` gains at most
  `W_REINFORCE`, `A` at least 0). A memory retrieved by *neither* retriever has `rrf = 0` and
  is never a candidate, so reinforcement can never summon an unretrieved memory. **What is
  deliberately NOT claimed:** that a both-retriever hit always outranks a solo hit — RRF gives
  no such guarantee. A weak both-retriever hit deep in both candidate lists scores
  `2/(RRF_K+pos)`, which can fall below a strong rank-1 solo hit with or without reinforcement
  (e.g. at pool depth 20, `2/80 = 0.0250 < 1/61 + 0.01 = 0.0264`). The protection the
  requirement needs is (a)+(b), not a tier guarantee; `W_REINFORCE` is kept small precisely so
  band (b) stays tie-breaker-class. The exact-match boost is deliberately relevance-strength (a
  verbatim title match is high precision) and may compete with a both-retriever hit; that is
  intended.
- All weights ship at **fixed, principled defaults** (`RRF_K = 60` is the standard RRF
  constant; `W_REINFORCE` is small enough to stay tie-breaker-class per invariant (b) above;
  the exact-match weights sit on the RRF rank-1 scale). They are **not** fit to the
  offline-eval labeled set — that set is a held-out regression gate, not a tuning target (see
  Testing). Any future tuning must use a **disjoint** query set (or k-fold), never the gate's
  own scoring set, to avoid train/test leakage.

### Result contract

- The result object exposes a single `score` field (the fused value, higher = better), and
  results are returned **pre-sorted best-first**. This replaces the previous `rank` field,
  whose meaning differed between keyword hits (negative BM25) and semantic hits
  (`999 + distance`). Consumers are internal (the agents and the tool description) and should
  rely on array order; the field-meaning change is documented in the tool description.

### Reinforcement write (access tracking)

- After truncation, the memories actually returned (the shown top-`limit`) are reinforced by a
  single set-based **UPSERT into `access_stats`** (insert with `access_count = 1` and
  `last_accessed = now`; on conflict, increment the count and refresh the timestamp).
  Oversampled-but-not-returned candidates are **not** bumped.
- **The write targets `access_stats`, never `observations`, so it does not fire the FTS-sync
  triggers.** This is the correction from the gate review: the earlier draft wrote the access
  columns onto `observations`, whose unguarded `AFTER UPDATE` trigger would have forced a
  full-text delete+reinsert of every returned row on every search. The cost is now one
  PK-indexed upsert over at most `limit` rows, with no full-text reindex.
- The upsert is **best-effort**: wrapped so any failure is swallowed and the results return
  regardless. This preserves the existing graceful-degradation posture (keyword and vector
  retrieval already each fail independently and silently) — a transient write-lock simply
  skips that reinforcement rather than failing the read.
- **Concurrency note.** `search_memory` becomes a (best-effort) writer to the WAL database
  alongside the chokidar watcher and the periodic reindex backstop. better-sqlite3 is
  synchronous (one writer at a time within the process) and WAL permits a single writer with
  concurrent readers; the best-effort wrapper absorbs the rare `database is locked` case. The
  write touches a tiny, FTS-free table, minimizing contention with the indexer.

### Access-state storage (side table, not columns on `observations`)

- Access state lives in a **new auxiliary table
  `access_stats(observation_id INTEGER PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE, last_accessed INTEGER, access_count INTEGER NOT NULL DEFAULT 0)`**,
  keyed one-to-one to `observations.id` — *not* as new columns on `observations`. This
  realizes the requirement's `last_accessed`/`access_count` tracking as the two columns of
  `access_stats`, and deliberately mirrors the existing `vec_items` table, which is likewise a
  derived, per-observation auxiliary table keyed by `observation_id`.
- **Why a side table (the gate-review fix).** Writing access state onto `observations` would
  fire its unguarded `AFTER UPDATE` FTS-sync trigger, forcing a full-text delete+reinsert of
  every returned row on every search. A separate table the FTS triggers do not watch
  eliminates that interaction. It also avoids the system's first-ever `ALTER TABLE`: the new
  table is created with the same idempotent `CREATE TABLE IF NOT EXISTS` pattern already used
  for `observations`, `vec_items`, and `meta`, so **no new migration primitive is introduced**
  and no column-add guard is needed.
- **No backfill; lazy cold start.** A memory with no `access_stats` row is simply
  never-accessed: the scoring read LEFT JOINs `access_stats` and coalesces a missing
  last-accessed to the row's existing index-time and a missing count to 0. Existing rows thus
  participate immediately with sensible defaults — no one-time backfill, no manual command
  (unlike q8's `reembed`). The create is self-idempotent and needs no version gate, so A1 does
  **not** rely on `meta.schema_version` at all — deliberately: the existing `INSERT OR IGNORE`
  meta pattern cannot update an already-present row, so the marker is unreliable on
  initialized stores (the live DB still reads `schema_version = 1` though the source declares
  `'2'`). That is a pre-existing quirk A1 sidesteps, not one it inherits. The
  `ON DELETE CASCADE` on `access_stats` (foreign keys are already enabled on the database
  connection in `openDb`, before schema init) means removing an observation cleans up its
  access row automatically, so no orphaned stats accumulate when files are deleted or
  re-indexed.

### Configuration

- A new **search-config constants module** holds the tunables (`RRF_K`,
  `CANDIDATE_MULTIPLIER`, `CANDIDATE_CAP`, `HALF_LIFE_DAYS`, `FREQ_SATURATION`,
  `W_REINFORCE`, `W_EXACT_TITLE`, `W_EXACT_CONTENT`) as named exports. This mirrors the
  existing embedder constants module and is the system's first search-config surface (today
  every search value is hardcoded inline).

### Modules built or modified (this feature only)

- **`search_memory` tool (modified):** the sole behavioral edit site. New flow — oversample
  both retrievers → assign rank ordinals → RRF fuse → add reinforcement + exact-match bonuses
  → sort → truncate → best-effort access bump.
- **Schema-init routine (modified):** adds the `access_stats` table via the existing
  idempotent `CREATE TABLE IF NOT EXISTS` pattern (mirroring `vec_items`), with an
  `ON DELETE CASCADE` foreign key to `observations` — no `ALTER TABLE`, no new migration
  primitive, no backfill, and no reliance on the (unreliable) `meta.schema_version` marker.
- **Search-config constants module (new):** the tuning surface.
- **Offline eval harness (new):** a labeled query set plus a recall@k / MRR scorer (see
  Testing).
- **Tool description (modified):** documents the new `score` semantics and that
  `search_memory` now reinforces accessed memories.

---

## Testing Decisions

A good test asserts **external behavior** — result ordering, truncation, the score field's
meaning, and observable side-effects (access-count and last-accessed changes visible in the
database) — not internal mechanics. Ranking math is exercised through its effect on output
order, not by reaching into private functions.

**Prior art to extend.** The existing tool test suite already calls `search_memory` against
a seeded temporary database with a mocked embedder, asserting relevance ordering, limit, and
filters. The existing schema test already asserts schema idempotency and keyword-index
trigger correctness. Both are the templates for A1's tests.

**Modules that get unit tests:**

- **`search_memory` behavior:** fused results are a single sorted list with no sentinel
  values; a memory matched by *both* retrievers receives both RRF terms; results truncate to
  `limit`; ordering is a deterministic total order — distinct candidates that tie on
  `score`/`rrf`/`indexed_at` still sort stably by `id` (seed a same-`indexed_at` cold-start
  pair and assert a fixed order independent of input order); reinforcement obeys the
  bounded-band invariant — assert it directly: two candidates whose RRF scores differ by more
  than `W_REINFORCE` never swap due to reinforcement, and the reinforcement term never lowers
  any candidate's score; an exact title match surfaces the
  intended memory; the reinforcement upsert touches only the returned rows' `access_stats`
  (incrementing count, refreshing last-accessed) and leaves non-returned rows untouched;
  keyword-error and vector-error paths still return results.
- **Access-state storage / schema:** opening the database twice creates `access_stats`
  idempotently with no error; a memory with no `access_stats` row scores with the cold-start
  defaults (last-accessed coalesced to index-time, count 0); deleting an `observations` row
  cascades to remove its `access_stats` row; and the reinforcement upsert does **not** alter
  the returned row's full-text index (guarding the gate-review fix).
- **Search-config constants:** pinned by a test (mirrors the embedder-constant pin), so a
  weight change is a deliberate, reviewed act.

**Known unit-test limitation.** The embedder mock returns a constant vector, so all semantic
distances are equal under unit tests — true semantic-vs-keyword *fusion quality* cannot be
validated in unit tests. The reinforcement/exact-match/fusion-ordering math is fully testable
on keyword + metadata; semantic fusion quality is the offline eval's job.

**Offline eval (built new; run by hand, not in CI).** Formalizes — and repairs — the ad-hoc
recall@5 gate the q8 PRD established. A small labeled set (~12–15 representative queries
spanning topics, episodes, and learnings, each with known expected document(s)) serves as
**held-out ground truth**: the ranking weights are frozen at their principled defaults and are
**not** fit to this set, so scoring against it measures generalization rather than fit — the
same property that made the q8 gate sound (q8 scored against an independent fp32 ground truth,
not a set its parameters were tuned to). A **baseline is captured against the current ranker
before the change** and recorded. **Acceptance gate:** new recall@5 ≥ baseline (no regression)
and MRR ≥ baseline; the target is improvement on both. Tuning the weights and scoring the gate
on the *same* set is prohibited — that makes the gate pass by construction; any future
calibration must use a **disjoint** query set (or k-fold). The eval harness is itself the
measuring instrument and is therefore **excluded from unit testing**.

---

## Out of Scope

- **Importance term.** Dropped from v1. The briefing's primary importance signal —
  presence of `[[wikilinks]]` — fires on only 1 of 763 live rows, so it is effectively dead
  on the real corpus. A source-type/length-based importance is a possible fast-follow once a
  real signal exists.
- **Per-entry learning rows.** A `learning` row is currently an entire `learnings.md` file
  (3 rows hold all learnings, versus 747 per-file episode rows). v1 accepts **coarse,
  whole-file reinforcement** for learnings — access counting on a learning reflects hits to
  the file, not the specific entry retrieved. Splitting learnings into per-entry rows is a
  separate, larger feature that touches indexing, not just search.
- **Reinforcing disk-bypass retrieval paths.** The session-start episode injection and the
  recent-learnings / list-episodes tools read markdown directly off disk and never touch the
  database, so they do not reinforce in v1. Reinforcement is **`search_memory`-only**; this
  gap is documented, not closed here.
- **Switching the vector index to cosine distance.** It stays L2 over L2-normalized vectors
  (rank-monotonic with cosine); no metric change.
- **Continuous multiplicative decay that penalizes old memories.** Explicitly rejected.
  Recency is a bounded additive bonus only; nothing is demoted for age.
- **Cross-machine sync of access statistics.** Access counts and last-accessed are per-store;
  Willis and Walter reinforce independently. The `access_stats` table is local, regenerable
  state — not synced content.
- **Changing the embedding model or quantization.** The q8 nomic embedder is unchanged.
- **CI integration of the offline eval.** Run manually, mirroring the q8 precedent.

---

## Further Notes

- **Deployment.** A1 is a code change: rebuild the server (the standard build step the
  assimilate/update path already runs when the `mcp/` tree changes) and restart the session
  so it loads the new build. The migration runs automatically on the first database open of
  the new server — there is **no manual reembed or migration command**, unlike q8.
- **Propagation to Walter.** This PRD and the eventual implementation live in the shared
  genome under `~/.claude-os/`. Use `/transmit-claude-os` to publish; on Walter's next server
  start the schema-init routine creates `access_stats` on his store independently (lazy
  cold-start — no backfill).
- **The `score` rename.** Internal consumers should rely on result array order, which is now
  authoritative (best-first). The old `rank` field's dual meaning is gone.
- **Tuning.** All weights live in the search-config module and ship at fixed, principled
  defaults (deliberately conservative — `W_REINFORCE` is tie-breaker-class per invariant (b)).
  The offline-eval set is a **held-out regression gate, not a tuning target**; any future
  calibration must use a disjoint query set (or k-fold) to avoid train/test leakage.
- **Verification provenance.** Current-state claims in this PRD were verified against
  `mcp/src` (`tools/search_memory.ts`, `db.ts`, `indexer.ts`, `embedder.ts`, `reembed.ts`),
  the lifecycle hooks, and the live `memory.db` (763 rows). The "no fusion today," "wikilink
  signal is dead," "learnings are whole-file rows," and "no eval harness exists" findings each
  corrected a briefing-level assumption.
