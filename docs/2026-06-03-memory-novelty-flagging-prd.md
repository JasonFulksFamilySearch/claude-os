# PRD — Write-Time Novelty Flagging + Human-Gated Supersession (A2)

**Date:** 2026-06-03
**Status:** Draft for gate review
**Scope:** `claude-os-mcp` memory write path + the `/memory-merger` skill
**Predecessor:** A1 reinforcement-weighted hybrid re-rank (merged); A2 is the second roadmap item, reusing A1's embedder/vector plumbing.

> Verified against current code (post-A1): `mcp/src/{tools/append_learning.ts,indexer.ts,db.ts,embedder.ts,tools/search_memory.ts}`, the lifecycle hooks, the `/memory-merger` skill, and the live `memory.db`. Where the originating briefing's verbal model disagreed with the code, the code won — those corrections are flagged inline.

---

## Problem Statement

Memory writes are append-only with no awareness of what's already there. Three paths write liberally — the `append_learning` MCP tool, the Stop-hook `learnings-flush` (which drains the session's pending learnings), and the episodic worker — and none checks whether a new entry restates or contradicts an existing one. Over time `learnings.md` accumulates duplicate lessons and stale entries that later get contradicted by newer ones, but the old ones never get retired. This is the "unbounded write path": bloat grows, confidently-wrong stale facts keep surfacing in retrieval, and the entire curation burden falls on manual review with **no signal of what to review**. The user has no way to know, when writing a learning, that they've already recorded it — or that it conflicts with something they decided three weeks ago.

---

## Solution

A2 adds duplicate/contradiction **flagging** — never automatic mutation — at the unit users actually write: the dated learning *entry*.

1. **Write-time (immediate, cheap).** When `append_learning` writes a new entry, it runs a fast *lexical* near-duplicate check against the target file's existing entries, records any hit as a pending candidate, and returns a warning in its result so the writer sees "this looks like your 2026-05-12 entry" right away.
2. **Review-time (thorough, human-gated).** `/memory-merger` gains a supersession-review phase: a server-side *semantic* scan embeds every learning entry and clusters **near-duplicates** (cosine ≥ the near-duplicate threshold). Because vectors show proximity, not polarity, the agent labels each flagged pair *duplicate / contradiction / distinct* during review. These, merged with the persisted write-time flags, are presented in `/memory-merger`'s existing propose-then-wait gate. (Surfacing the lower-similarity *possible-contradiction* band is deferred — see Out of Scope.)
3. **Supersession (human-gated, reversible).** For each pair the user approves, the older entry is **archived then retired** from the live file (reusing `/memory-merger`'s archive-before-delete discipline), so it stops surfacing in retrieval — nothing is destroyed, and the file reindexes automatically.

Nothing is auto-deleted or auto-invalidated; write-time only *flags*. The whole-file row model is left untouched — A2 operates on parsed dated entries in application code.

---

## User Stories

1. As the writer of a learning, I want to be warned at write time when my new entry closely matches an existing one, so that I don't silently duplicate a lesson I already recorded.
2. As Jason, I want duplicate and contradictory learnings surfaced as candidates during memory maintenance, so that I have a concrete list of what to review instead of re-reading everything.
3. As Jason, I want to approve each supersession individually, so that the system never retires a learning without my say-so.
4. As Jason, I want a retired (superseded) entry archived, not destroyed, so that I can recover it if a supersession was wrong.
5. As Willis, I want the agent to label each flagged pair duplicate/contradiction/distinct, so that the proposal distinguishes "you said the same thing twice" from "this reverses an earlier decision."
6. As the writer, I want the write-time check to be fast, so that recording a learning isn't slowed by a heavy scan.
7. As an implementer, I want the write-time novelty check to be best-effort, so that a flagging failure never fails the underlying memory write.
8. As Jason, I want the review scan to catch duplicates regardless of how they were written (MCP tool, Stop-hook flush, or manual edit), so that coverage doesn't depend on the write path.
9. As an implementer, I want flagged candidates persisted across sessions, so that a write-time flag raised today is still reviewable at the next `/memory-merger` run.
10. As Jason, I want to dismiss a false-positive flag and have it stay dismissed, so that the same non-issue isn't re-proposed every run.
11. As Willis, I want novelty detection to operate on dated entries, not whole files, so that "duplicate" means a duplicate lesson, not two giant files that happen to overlap.
12. As an implementer, I want the entry parser shared with the existing recent-learnings reader, so that "what is an entry" is defined once.
13. As Jason, I want supersession applied as a markdown edit that reindexes, so that retrieval immediately reflects the retirement with no separate migration.
14. As an implementer, I want the flag store added without disturbing the FTS-sync triggers, so that flagging never triggers a full-text reindex of the observations it references.
15. As Jason, I want the detection thresholds to be fixed, documented defaults, so that flagging behavior is predictable and tunable in one place.
16. As Willis, I want episodes and context topics left out of v1 novelty flagging, so that the feature stays focused on the learnings bloat it was scoped to fix.

---

## Implementation Decisions

### Unit and granularity
- A2 operates on **dated learning entries** (`## YYYY-MM-DD — title` blocks), not on `observations` rows. Verified ground truth: a `learning` row is an entire `learnings.md` file (3 rows, ~29K chars each), so row-level comparison is useless for dedup. The whole-file row model is **not** changed (splitting learnings into per-entry rows is explicitly out of scope).
- Entry parsing reuses the existing dated-entry parser already used by the recent-learnings reader, extracted into a shared helper so "what is an entry" is defined once.

### Write-time detection (lexical, in `append_learning`)
- After `append_learning` writes the block and calls the indexer, it runs a **best-effort, cheap lexical** check of the new block against the target file's previously-existing entries: exact block-hash match, plus a token-overlap ratio above a fixed threshold. No embedding at write time — the vector index still holds the *old whole-file* vector at append time (embedding is deferred to the watcher), so a write-time KNN cannot see entry-level duplicates.
- On a hit, it records a **pending** candidate in the flag store and returns a new optional `novelty_warning` field (the matched entry's date/title + similarity) in its result. The write itself never fails on a flagging error.
- This catches the common bloat case (re-recording a near-verbatim lesson). Semantic-but-reworded duplicates are left to the review scan.

### Review-time detection (semantic, server-side)
- A new MCP tool performs the thorough scan: parse all learning entries, embed each with the document-prefixed embedder (reusing A1's embedder), and cluster by cosine similarity at or above a fixed near-duplicate threshold. Distance is L2 over unit-normalized vectors (cosine-equivalent), matching A1. **v1 surfaces near-duplicates only**; the lower-similarity *possible-contradiction* band is deferred (see Out of Scope), so its threshold constant is reserved but unused by the scan.
- The scan **merges** its findings with persisted pending flags (from write-time) and returns candidate pairs with both entries' text, similarity, and provenance. It does not itself judge duplicate-vs-contradiction — that is the agent's job in the skill (vectors give proximity, not polarity).
- Embeddings are computed fresh per scan run (no persistent per-entry embedding cache); acceptable for a periodic, human-initiated maintenance operation.

### Flag store
- A new standalone `novelty_flags` side table (own primary key) records each candidate pair: each side's **entry identity** = (source path, entry date-heading, content-hash of the block), plus the similarity score, the two entries' dates (to decide which is older), detection source (write vs scan), status (`pending` / `dismissed` / `superseded`), and a timestamp. It references entries (not observation rows), so it has no foreign key to `observations`.
- **Entry identity, collisions, and re-location.** The content-hash makes identity unique for *distinct* entries (different text ⟹ different hash); two entries collide on identity only when they are **byte-identical**, which is exactly the exact-duplicate case A2 targets — not a defect to disambiguate but the finding itself. Supersession therefore never relies on a stored offset: it **re-locates** by re-parsing the *current* `learnings.md` at review time and matching on identity. If the identity matches **one** current block, retire that block; if it matches **N > 1** blocks, they are interchangeable duplicates and the resolution is to **collapse to a single occurrence** (retire all but the first); if it matches **zero** (the entry was since edited or removed), the flag is **stale** and is skipped, to be re-derived by the next scan. Near-duplicates with distinct content have unique identities, so the human/agent picks which to retire (defaulting to the older date).
- Added via an idempotent `CREATE TABLE IF NOT EXISTS` in the schema-init routine, mirroring how A1 added `access_stats`. A2 does **not** rely on the `schema_version` marker (verified: the existing `INSERT OR IGNORE` never updates it, so it is unreliable on initialized DBs — same finding as A1).
- **Correction from the briefing:** the briefing's literal "add `valid` + `supersedes` columns to observations" assumed per-entry rows. Since learnings are whole-file rows and supersession is a markdown edit, per-row `valid`/`supersedes` columns are dropped in favor of the entry-level `novelty_flags` table.

### Human-gated supersession (in `/memory-merger`)
- `/memory-merger` gains a supersession-review phase that calls the scan tool, has the agent label each candidate pair (duplicate / contradiction / distinct), and presents them inside the skill's **existing** propose-then-`STOP`-and-wait gate (the same granular `go` / per-phase / name-to-skip approval).
- For each approved supersession, the skill **re-locates** the target by re-parsing the current `learnings.md` (per *Entry identity* above), **archives** the block(s) being retired (appending to the dated archive file, per the skill's existing archive-before-delete rule), then **retires** them from the live file — for an exact-duplicate flag, removing all but the first occurrence; for a near-duplicate pair, removing the chosen (older) entry — which reindexes via the existing watcher/append path, and calls a small MCP tool to set that flag's status to `superseded`. A flag whose identity no longer matches any current block is reported as stale and skipped. Dismissed candidates have their flag set to `dismissed` so they aren't re-proposed.
- A second new MCP tool persists a flag's resolution (status update), built in the narrow, path/shape-validated, atomic style of the existing episode-promotion tool. Supersession of the markdown itself is done by the skill via its existing file-edit tools — not auto-fired anywhere.

### Configuration
- Detection thresholds (lexical overlap ratio, near-duplicate cosine, a reserved contradiction-candidate cosine, scan neighbor count) are fixed, documented defaults added to the existing search-config constants module, following A1's "principled defaults, not fit to any eval set" discipline. The contradiction-candidate threshold is defined but unused by v1's scan (contradiction surfacing deferred).

### Modules built or modified (this feature only)
- **Entry/novelty helper module (new):** `parseEntries` (shared dated-entry parser), `entryIdentity` + `matchByIdentity` (compute an entry's (path, date, content-hash) identity and find the 0 / 1 / N current blocks matching a stored identity — the re-location and collapse primitive), `lexicalSimilarity` (write-time), and `findNearDuplicateEntries` (embed + cosine cluster, review-time). Pure/near-pure, unit-tested.
- **Schema-init routine (modified):** add the `novelty_flags` table via `CREATE TABLE IF NOT EXISTS`.
- **`append_learning` (modified):** best-effort write-time lexical check → record pending flag + return `novelty_warning`.
- **Novelty-scan MCP tool (new):** review-time semantic scan returning candidate clusters merged with persisted flags.
- **Flag-resolution MCP tool (new):** atomic status update (`dismissed` / `superseded`) for a flag.
- **Tool registration (modified):** register the two new tools server-side (in the MCP server's tool list) with descriptions.
- **`/memory-merger` skill (modified):** add the supersession-review phase (propose → wait → archive+retire+resolve) **and grant the two new MCP tools in the skill's `allowed-tools` frontmatter** — its allowlist today names only `append_learning`, `list_topics`, `search_memory`, and a skill cannot invoke a tool absent from that list, so without this grant the phase is non-functional. (Server-side registration above makes the tools callable in general; this grant makes them callable *by this skill*.)

---

## Testing Decisions

A good test asserts external behavior — parsed entries, similarity verdicts above/below threshold, flags persisted with the right status, the write never failing on a flagging error — not internal mechanics.

**Modules that get unit tests:**
- **Entry/novelty helper:** `parseEntries` splits a multi-entry `learnings.md` into the correct dated blocks (including edge cases: no entries, malformed heading, trailing content); `lexicalSimilarity` scores an exact re-add as duplicate and unrelated text as non-duplicate against the threshold; `findNearDuplicateEntries` clusters identical/near-identical entries and separates clearly-distinct ones; `matchByIdentity` returns exactly one block for a unique entry, N blocks for byte-identical duplicates (the collapse case), and zero for an identity no longer present in the file (stale). (Note: like A1, the embedder is mocked to a constant vector in tests, so *semantic* cluster quality isn't unit-testable — the lexical and structural behavior is; semantic quality is validated by hand via the review scan on the real corpus.)
- **`append_learning` novelty path:** writing a near-duplicate of an existing entry records a pending `novelty_flags` row and returns a `novelty_warning`; writing a genuinely novel entry records none; a forced flagging error still returns a successful write (best-effort).
- **Flag store / schema:** opening the DB twice creates `novelty_flags` idempotently; the resolution tool flips a flag's status atomically and is idempotent.
- **Scan tool:** returns persisted pending flags and clusters seeded duplicate entries; excludes resolved (dismissed/superseded) flags.

**Prior art to extend:** `tools.test.ts` (seeded tmp DB + mocked embedder), `db.test.ts` (schema idempotency), and A1's `ranking.test.ts` (pure-module testing pattern). The flag-resolution tool mirrors `mark_episode_promoted` and its tests.

**Excluded from unit tests:** the `/memory-merger` skill flow (a markdown skill, exercised by hand) and the semantic cluster *quality* (mocked embedder limitation; validated manually on the real corpus).

---

## Out of Scope

- **Splitting learnings into per-entry observation rows.** Deferred (chosen design: entry-level handling in application code). A larger indexer re-architecture, not part of A2.
- **`valid` / `supersedes` columns on `observations`.** Dropped — the briefing's column idea assumed per-entry rows; superseded by the `novelty_flags` table + markdown supersession.
- **Write-time flagging on the Stop-hook flush path and episodic worker.** Those write off-disk with no DB handle. They are covered instead by the review-time scan (which sees every entry regardless of write path), so write-time flagging is `append_learning`-only and this gap is intentional, not silent.
- **Novelty flagging of episodes and context topics.** v1 is learnings-focused (the documented bloat source). The scan could extend later.
- **Automatic supersession or invalidation.** Never. Write-time only flags; supersession is always human-approved.
- **Contradiction-candidate *surfacing* (deferred from v1).** v1's scan surfaces only near-duplicates (cosine ≥ the near-duplicate threshold). The lower-similarity contradiction band is **not** surfaced: a real-corpus run showed it is mostly thematically-related noise (≈34 candidates from ~80 entries, none true contradictions), and vectors give proximity, not polarity. The threshold constant is reserved for a future iteration that adds polarity judgment. During review the agent may still label a flagged near-duplicate a contradiction if it genuinely reverses an earlier entry.
- **A persistent per-entry embedding cache.** The review scan embeds fresh each run; acceptable for a periodic manual operation.

---

## Further Notes

- **Scope is larger than the briefing's "Medium ~2 days" estimate.** The whole-file-row reality forces entry-level handling (parser, lexical write-time check, semantic review scan, two MCP tools, a skill change) that the briefing's verbal model didn't anticipate. Honest re-estimate: Medium-High.
- **Deployment** mirrors A1: rebuild `mcp/` and start a new session; the `novelty_flags` table migrates itself on first open. No effect on the live server until rebuilt + restarted; nothing reaches Walter until `/transmit`.
- **Reuses A1** directly: the embedder, the serialized-vector + vec0 KNN pattern, the side-table migration convention, and the search-config constants surface.
- **Verification provenance:** current-state claims were verified against `mcp/src` and the live `memory.db` (learning rows = 3 whole files; `append_learning` calls `indexFile` synchronously; the flush hook and episodic worker have no DB handle; `/memory-merger` is a propose→STOP→approve→execute markdown skill that archives before deleting and never touches the observations DB directly).
