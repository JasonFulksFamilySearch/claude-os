> **AI-generated work product** (Walter, 2026-06-11), pending human review. Produced from a memory-subsystem strategic research dispatch: a 4-agent web intelligence sweep (2026-06-10, ~30 dated primary sources) → code-grounded gap analysis → this recommendation hardened through a 4-cycle red-blue-judge gate ending **CLEAN** → PRD written via /write-a-prd and itself red-blue-judge **CLEAN**.

**Series:** Memory C-series, 2 of 3 — build order **C1 → C2 → C3** (issue numbers cross-linked in the first comment). **Depends on C1:** the index cutover is gated on (a) C1 presence non-regression against the recorded baseline (the eval runner's composed VERDICT) AND (b) the indexer unit suite passing (`npm test`) — where archive-exclusion (C1 Stage 1) now lives — and C1's Stage-2 superseded-entry probes, authored unarmed at C1, arm at this migration as its acceptance tests.

**Relationship to NOT_PLANNED #21:** rejected #21 proposed token-efficient *snippet serving* for topic files at read time. C2 is a different feature: it changes the *indexing and embedding unit* itself, driven by benchmark evidence (nomic-embed-text degrades sharply past ~4K chars; the 12KB agent learnings file is one mean-pooled vector) and verified by the C1 gate before cutover. It does not resurrect #21. Likewise, rejected #22's entity-boost is something this series' research explicitly recommends **against** (the field demoted graph/entity layers in 2026 — Mem0 removed its traversable graph interface).

**Gate history of this recommendation:** cycle 1 ESCALATE-evidence (migration path unspecified against `UNIQUE(source_path)`) → cycle 2 REVISE (red challenger killed a false claim that telemetry "re-keys via the existing reembed script" — rewritten to the explicit-id INSERT…SELECT mechanism, cold-start honestly disclosed) → cycle 4 CLEAN, red challenge no-grounded-fail.

**Machine-local artifacts (macelabs-macair, `~/.claude-data/`):** `_tmp_memory_briefing.md`, `_tmp_memory_research_payloads.md`, `_tmp_rbj_recs_cycle1..4.md`, `_tmp_rbj_prd_cycle1.md`, `2026-06-11-c2-entry-granular-indexing-prd.md` (this PRD's source file).

The full PRD follows verbatim.

---

# PRD — C2: Entry-Granular Indexing with Contextually-Enriched Chunk Embeddings

**Date:** 2026-06-11 · **Status:** Draft for adoption · **Series:** Memory C-series, item 2 of 3 (build order C1 → C2 → C3; C2's cutover is gated on C1)
**Provenance:** AI-generated (Walter); the underlying recommendation passed a 4-cycle red-blue-judge gate (CLEAN), and the consolidated PRD this derives from passed its own red-blue-judge gate (CLEAN at cycle 1). Pending human review.
**Naming note:** internally labeled "A2-chunk" during research; renamed C2 because A1/A2/B1 already name shipped memory-roadmap phases in this repo.

---

## Revision note (2026-06-16)

This body is reconciled to C1 **as it FINALIZED during C1's design gate and then SHIPPED** (PR #38 merged to master). #30 was written before those C1 changes, so it cited C1 mechanics that no longer match the merged code. Three reconciliations are applied; the C2 design itself (chunking rules, anchor design, migration mechanism, result shaping) is unchanged. Reviewers should diff against the prior body on three axes:

1. **C1 Stage 1 is now indexer-boundary UNIT ASSERTIONS, not a retrieval-layer absence probe.** Stage 1 (archive exclusion) is no longer a labeled-absence probe scored by the eval runner — it is three unit assertions in `mcp/test/indexer.test.ts` (classify guard + positive control ~:146; the exported `isWatchIgnored` predicate ~:186, wired into `watchAll` at `indexer.ts:398`; the post-`fullReindex` corpus assertion ~:410/430) gated by `npm test`. Every C2 reference to a "Stage-1 absence pass" from the eval runner is rewritten: the cutover criterion now reads (a) C1 presence non-regression against the recorded baseline via the eval runner's composed VERDICT, AND (b) the indexer unit suite passing (`npm test`). Source: `mcp/src/eval.ts:30-32` ("Stage 1 (archive exclusion) is NOT here — it is enforced by the indexer unit suite"), `mcp/src/scripts/eval.ts:8,180`.
2. **Stage-2 arming protocol settled.** Superseded-entry queries are authored UNARMED (`armed:false`) at C1 and ARMED (`armed:true`) at C2. C2 adds **no new queries** — it flips the existing `absence_stage_2` block to `armed:true` and supplies entry-anchor resolution (which doubles as C2's own acceptance tests). The block already exists, authored `armed:false`, in `mcp/eval/labeled-queries.json:17-21` (`depends_on:"C2"`, `granularity:"entry"`); its `forbidden` target stores `sourcePathContains` + `entryDate` + `noveltyStatus`, which C2's anchor-resolution work resolves to an entry anchor in the new entry-granular rows.
3. **Superseded-flag count corrected.** This PRD carries no explicit superseded-flag count in its body (no "9 superseded" citation to correct), so no count edit was applied; for the record, the verified live count (queried against `~/.claude-data/memory.db` novelty_flags on 2026-06-16) is **3 superseded + 1 dismissed**, and the live corpus is now **387 observations** (the PRD's `~30K-entry breakeven` framing is unaffected). The `absence_stage_2` block's own `description` already records "3 superseded + 1 dismissed (per AI-Scientist verification 2026-06-16)".

---

## Problem Statement

The memory index's retrieval unit is the whole file, and the embedding layer inherited that unit from a schema that predates it. Current state (evidence anchors as of 2026-06-11):

- One observation row per file: `UNIQUE(source_path)` (`mcp/src/db.ts:34`), upserted `ON CONFLICT(source_path)` (`mcp/src/indexer.ts`).
- One mean-pooled vector per file (`mcp/src/embedder.ts`): the agent learnings file (~12KB, dozens of dated entries on unrelated subjects) is a single 768-dim embedding — an average of everything it contains.
- The embedding model's measured limits make this a defect, not a style choice: an independent 10-model benchmark (2026-03-20) put nomic-embed-text-v1.5's needle-in-haystack retrieval at 0.633, degrading sharply past ~4K characters. The 2026 field consensus (sqlite-memory v1.3.5, OpenClaw built-in memory) chunks at 400–512 tokens with 80–100 overlap.
- The damage is visible in results: a vector-only hit on a long file falls back to a first-32-words snippet (`mcp/src/tools/search_memory.ts:81-84,199`) — for the learnings file, header boilerplate that doesn't show why the result matched. FTS keyword hits partially mask the loss (matched-context snippets still work), which is why the degradation has been easy to miss.
- The system already disagrees with itself about the right unit: the novelty/supersession machinery identifies content by **dated entry** — (source_path, entry_date, entry_hash), deliberately decoupled from observation ids (`mcp/src/db.ts:86-100`) — while retrieval can only return whole files. The write unit and the retrieval unit diverged.

Consequences: semantic recall over exactly the highest-value stores (learnings, topic docs) is systematically degraded and worsens as files grow; result pointers are file-coarse so the consumer re-reads whole files; entry-level absence probes (C1 Stage 2) are inexpressible.

## Solution

From Jason's perspective: search results point at the entry or section that matched, with a snippet from that entry — and the change has to prove itself against the armed eval gate (C1) before the old index is replaced.

Learnings and decisions files index one observation per dated entry — the same unit the novelty system already uses, parsed by the same shared code so the two can never diverge. Long topic documents split at heading boundaries sized to the embedding model's competence window. Small files and episodes stay whole. Each chunk embeds with its file and section title as context. The migration preserves every surviving row's identity so vectors and access telemetry survive untouched; a pre-migration database copy is the rollback.

## User Stories

1. As Jason, I want search results for my learnings to point at the specific dated entry that matched, so that I read one entry instead of scanning a 12KB file.
2. As Jason, I want snippets drawn from the matching entry or section, so that a result's preview shows why it matched instead of file-header boilerplate.
3. As Walter, I want long topic documents split at heading boundaries within the embedding model's competence window, so that semantic recall of domain knowledge stops degrading with document length.
4. As Walter, I want each chunk embedded with its file and section title as context, so that a chunk's vector carries enough identity to match topical queries.
5. As an implementer, I want learnings and decisions chunked by the same parser the novelty system uses, so that the retrieval unit and the novelty unit are definitionally identical.
6. As Jason, I want small files and episodes left as whole-file observations, so that granularity changes only where the evidence says it helps.
7. As Jason, I want the index migration to preserve every surviving observation's identity, so that vector rows and access telemetry survive the schema change without any re-keying invention.
8. As Jason, I want a pre-migration copy of the memory database retained, so that the cutover is reversible.
9. As Walter, I want the cutover gated on C1 presence non-regression (the eval runner's composed VERDICT) plus the indexer unit suite passing (`npm test`, where archive-exclusion / C1 Stage 1 now lives), so that the chunking change proves itself before it replaces the old index.
10. As Jason, I want the existing unarmed superseded-entry absence block (C1 Stage 2, authored `armed:false` in `labeled-queries.json`) flipped to `armed:true` at this migration and supplied with entry-anchor resolution, so that the new granularity is immediately regression-tested against the supersession lifecycle. No new probes are authored at C2 — C2 only arms the existing block and resolves its `forbidden` target to an entry anchor.
11. As Walter, I want at most two chunks per file in final results, so that one long document cannot flood the top-k.
12. As Jason, I want exact-title matching to keep working for whole files after chunking, so that existing recall behavior survives the granularity change.
13. As Walter, I want unchanged chunks skipped at re-index time by per-chunk content hash, so that the watcher's incremental economy survives row multiplication.

## Implementation Decisions

- **Chunking rules.** Learnings and decisions files: one observation per dated entry (entries are natural units; no overlap). Context topics and watched project docs longer than ~2,000 characters: split at heading boundaries targeting 400–512 tokens with 80–100 tokens of overlap between adjacent heading-split chunks. Files at or under the threshold, and all episodes, remain whole-file observations.
- **Shared parser (EntryChunker).** The dated-entry parser currently inside the novelty module is extracted into a shared module consumed by both the novelty system and the indexer. A parity test asserts both consumers see identical entry sets. This is the structural guarantee that the write unit and the retrieval unit stay one unit.
- **Anchor design.** Observation identity becomes (source path, anchor): empty-string anchor for whole-file rows; a date-based identifier for dated entries with an ordinal suffix on same-date collisions; a slugified heading path for section chunks. Anchors are unique within a file. Chunk rows store their section/entry title as title and the file's H1 in a new parent-title field.
- **Contextual embedding enrichment.** The embedded text is prefixed with the file and section title inside the existing document-prefix convention; the FTS-indexed content remains the raw chunk text (the FTS title column already indexes titles separately).
- **Migration (schema v2 → v3) — exact mechanism, no implicit machinery.** The canonical SQLite table-rebuild inside one transaction with foreign-key enforcement disabled: create the v3 table with the (source path, anchor) unique constraint; populate it with an explicit-id INSERT…SELECT so every existing row keeps its id — which keeps the per-observation side tables (vector index, access stats) valid with **no re-keying mechanism; none is claimed or required**. Drop old, rename, recreate the FTS external-content table and run its rebuild. Only then are qualifying long files chunk-split: each one's whole-file row is deleted — its access-stats row cascades away, so that file's telemetry restarts cold, an accepted and disclosed cost (reinforcement is a bounded ≤0.01 tie-breaker by design) — and anchored rows are inserted and embedded via the existing delete-then-insert vector pattern. The re-embed script is extended only to embed anchored rows; it carries no telemetry responsibility. The schema-version marker advances; the migration is idempotent (version-gated). A pre-migration copy of the database file is retained as rollback.
- **Indexer reconcile.** Per-path upsert becomes per-(path, anchor) set reconciliation: parse → chunk set; upsert chunks whose per-chunk content hash changed; delete vanished anchors; leave unchanged chunks untouched. File deletion still removes all rows for the path. The periodic full-reindex sweep reconciles stale rows on (path, anchor) pairs.
- **Result shaping.** After ranking, results collapse to the best-scored chunk per section with at most two chunks per file in the final top-k. Results gain an anchor field (additive; consumers reading path/title/snippet are unaffected). The exact-match title bonus matches the chunk title OR the parent title, preserving current behavior for whole-file rows. Snippets come from the matching chunk.
- **Untouched consumers (verified).** Episodes stay whole-file; the session-start hook reads episode files from disk, not observations; topic loading reads markdown from disk; novelty flags reference entries by (path, date, hash) and never by observation id, so the flag lifecycle is unaffected — chunk rows keep the same source path.
- **Cutover protocol.** Capture the C1 baseline on the v2 index → migrate → run the gate → accept only on (a) presence non-regression (the eval runner's composed VERDICT against the recorded baseline) AND (b) the indexer unit suite passing (`npm test`), which is where archive-exclusion / C1 Stage 1 is enforced — NOT a "Stage-1 absence pass" from the eval runner. As part of arming, flip the existing `absence_stage_2` block to `armed:true` and supply entry-anchor resolution; once armed, those Stage-2 superseded-entry probes are scored by the eval runner and join the composed VERDICT as acceptance evidence (the anchor-resolution work doubles as C2's own acceptance tests). On failure: restore the pre-migration copy, file findings.
- **Effort:** ~3–5 days including migration and eval verification.

## Testing Decisions

A good test asserts external behavior — inputs in, outputs or database state out — never implementation details. Prior art: the MCP package's existing per-module unit-test suite (indexer, db, novelty, ranking, reembed, tools all have dedicated test files).

- **EntryChunker:** golden markdown fixtures — dated entries, same-date collisions, files without headings, threshold boundary cases, overlap behavior on heading splits; the novelty/indexer parity test.
- **Migration:** fixture v2 database → migrate → assert id preservation for surviving rows, side-table survival (vectors, access stats), FTS integrity (post-rebuild queries return pre-migration results for whole-file content), chunk-split cascade behavior, schema-version advance, idempotence on re-run.
- **IndexerReconcile:** anchor-set diffs (added/changed/vanished), hash-gated skips, file-deletion sweep, full-reindex stale-pair reconciliation.
- **ResultShaper:** sibling collapse, per-file cap, anchor field presence, exact-match via parent title, snippet source.
- **Excluded:** the cutover protocol itself (operational, evidenced by the C1 gate report); rollback restore (file copy, exercised manually once).

## Out of Scope

- Embedding model replacement (nomic stays; it is competent within chunk-sized inputs — the dual-column migration playbook is future work).
- ANN/rescore indexes (corpus is ~2 orders of magnitude below the ~30K-entry breakeven).
- Re-ranking and query-intent classification (await C1 evidence).
- Episode chunking and episodic rollups (episodes are small single-session files; rollups are a separate bench item).
- Any change to ranking constants or the reinforcement design.

## Further Notes

- **Red-blue-judge history of the underlying recommendation:** cycle 1 ESCALATE (evidence) — the migration path was unspecified against the UNIQUE(source_path) constraint → the schema-and-migration block was added; cycle 2 REVISE — a red challenger landed a genuine kill: the draft claimed access-stats "re-keys via the existing reembed script," but that script has no telemetry logic and a naive rebuild would cascade-delete all telemetry → rewritten to the explicit-id INSERT…SELECT mechanism with cold-start honestly disclosed and no re-keying claimed; cycle 4 CLEAN with a no-grounded-fail red challenge.
- **Research grounding (retrieved 2026-06-10):** sqlite-memory v1.3.5 (2026-06-10) — markdown-structural chunking, 512-token/100-overlap defaults, content-hash re-embed gating; independent embedding benchmark (2026-03-20) — nomic needle-in-haystack 0.633, sharp degradation past ~4K chars; OpenClaw built-in memory defaults (2026) — 400–512/80–100 consensus; Morph Ollama embedding survey (2026-06-09) — nomic adequate for short English chunks. Full sweep record: `_tmp_memory_research_payloads.md` (machine-local).
- **Risk register:** (1) FTS external-content rebuild correctness is the riskiest step — covered by migration tests and the retained rollback copy; (2) parser divergence between novelty and indexer — structurally prevented by the shared module + parity test; (3) telemetry cold-start for chunked files — accepted, disclosed, bounded (≤0.01 rerank effect); (4) result flooding by one file — handled by the per-section collapse and per-file cap.
- **Deferred decisions:** overlap size tuning (default 80–100 tokens; revisit only with C1 evidence); per-source-type chunk thresholds (default ~2,000 chars universally); whether watched external project docs adopt heading-splits in v1 (default yes, same rule as topics).


