# CCR three-store retrieval contract — DIO-11 / FR-D1..D4

**Status:** built (Phase 3). The reactive consumer of the DIO-7 SmartCrusher
envelope (`docs/dioscuri-smartcrusher-compression.md`). DIO-7 compresses and emits
the marker + `originalHash` + `retainedIndices` + `constants`; DIO-11 is the path
that SERVES the byte-exact original back when the agent reactively asks for it.

**Source (two files, split along the package boundary their deps live on):**
- `hooks/lib/ccr-retrieve.js` — the reactive contract, three-store resolution, the
  ephemeral session cache (store #3), constants rehydration. Pure node (no SQLite —
  the hook runtime has none).
- `mcp/src/ccr-query.ts` — the FR-D2 query path. Needs FTS5, which lives ONLY in
  `mcp/` (`better-sqlite3` is an mcp dependency). Injected as `queryFn` where SQLite
  is present; a dependency-free JS fallback covers the hook-only environment.

**Tests:**
- `hooks/lib/test/ccr-retrieve.test.js` — reactive contract, three-store resolution,
  ephemeral hygiene, AC-1 byte-exact + constants rehydration.
- `mcp/test/ccr-query.test.ts` — the tokenizer-parity falsification + the real-DB
  `observations`-row hygiene falsification (both need FTS5/SQLite).

---

## 1. Reactive, not proactive (FR-D1, FR-D4)

The contract is strictly **pull**. The agent sees a marker
(`[N items compressed to M. Retrieve more: hash=...]`), calls `retrieve(hash[, query])`,
and ONLY THEN is the original resolved and served. There is **no Context Tracker
auto-expansion** (FR-D4) — nothing injects un-asked-for content. `retrieve` does
nothing until called; the cache is empty until a compress writes to it.

`buildMarker` / `parseMarker` round-trip the hash; the marker is byte-identical to
the one DIO-7 already emits on its envelope, so the agent sees one consistent marker.

## 2. Three stores by LIFETIME (FR-D3 — the Gate-2 resolution)

`retrieve(hash)` asks three stores **in lifetime order** and the first owner wins:

| # | Store | Lifetime | Owns | Resolves by |
|---|-------|----------|------|-------------|
| **3** | Ephemeral session CCR cache | Session-scoped, auto-evicted / LRU-capped | freshly-compressed tool-output originals | file read from `~/.claude-data/ccr-cache/<sessionId>/<hash>.json` |
| **1** | Promoted durable memory (archive) | No TTL; prune-governed | already-archived originals | file read from the indexer-EXCLUDED `archive/` dir |
| **2** | `.dioscuri/graph/` | Rebuildable, throwaway | graph-query originals | **re-query**, DELEGATED to DIO-9 via a `graphResolver` seam |

**Resolution order is (3) → (1) → (2).** The ephemeral working set is the freshest
and most likely owner of a just-compressed tool output; the archive owns promoted
content; the graph is the re-query fallback. Store #2 is delegated — this module
never reaches into `.dioscuri/graph/` (DIO-9's lane); it routes a graph-originated
hash to the injected `graphResolver`.

**Fail-closed (AC-1).** Whatever a store returns MUST hash back to the requested key
or it is not the original — a resolver returning a non-byte-exact blob fails closed
(`found: false, reason: 'hash-mismatch-on-resolve'`), never served as if real.

## 3. The hard hygiene rule — an ephemeral write is NEVER an `observations` row

Store #3 is materialized at `~/.claude-data/ccr-cache/`, a **sibling of
`capture-queue/`** and **outside every indexer-walked dir**. The indexer walks only
`agent/`, `context/`, `projects/`, `episodes/`, and explicitly excludes `archive/`
(`indexer.ts:59`). `ccr-cache/` is none of those, so `fullReindex` never visits it.
It is a plain **file** cache — no FTS table, no sqlite-vec, no `memory.db` write.

This closes the eval-pollution boundary AND the AC-4 boundary at once — they are the
same line: *a write is clean iff it never becomes an `observations` row.*

**Falsification (proven, `mcp/test/ccr-query.test.ts`):** after a CCR write,
`SELECT COUNT(*) FROM observations WHERE source_path LIKE '%<ccr-hash>%'` = 0 against
a real disposable `memory.db` (and the seeded-unrelated-row check proves the query is
not vacuously zero). The eval baseline `file_set_hash` is unchanged because the CCR
write adds no `source_path` the eval keys on.

## 4. AC-1 byte-exact reconstruction + the constants-rehydration rule (DIO-7 carry-forward)

`retrieve(hash)` returns the **byte-exact full original** — every row, including the
ones SmartCrusher dropped. The ephemeral store holds the canonical original verbatim
(the exact bytes DIO-7 hashed), so byte-exactness is a file read that re-verifies its
own hash on the way out. The envelope's retained rows alone could never reproduce the
dropped rows — which is exactly why store #3 exists.

**The constants-rehydration trap (LOAD-BEARING).** DIO-7's SmartCrusher factors
fields that are constant across EVERY row into a `constants` block and **removes them
from each retained row**. A retrieve consumer reading a retained row **in isolation**
would be missing those fields. Worse — per the DIO-7 QA warning — **if an error-signal
field is constant across every row, it lives in `constants`, NOT inline on any row**, so
a bare-row consumer would silently miss the error signal.

Therefore the retrieve path **NEVER returns bare retained rows**. `rehydrateRows` /
`rehydrateEnvelope` **merge the constants block back into every retained row** before
returning, reconstructing full per-row state (row's own fields win on any collision,
though DIO-7 strips exactly the constant keys so the union is clean). Both the
factored-constant case and the error-signal-in-constants case are asserted in the
hook test.

## 5. The query path + tokenizer parity (FR-D2 — cold-eye Flaw 3)

`retrieve(hash, query)` narrows the resolved original to the relevant rows.

**Where SQLite is available** (`mcp/src/ccr-query.ts`, injected as `queryFn`): the
query builds a **throwaway, single-blob, in-memory FTS5 index** over just the resolved
blob, runs the query as a MATCH, orders by `bm25()` within the blob, and discards the
index. Two hard rules:

1. **Never writes `observations_fts`.** The index is `:memory:`, so it cannot touch
   `memory.db` at all — no eval-corpus pollution through the query path.
2. **Tokenizer parity.** The throwaway index uses a tokenizer **byte-identical** to
   the main index's `tokenize='porter unicode61'` (`db.ts:66`). The exact string is a
   single source of truth (`CCR_FTS_TOKENIZE`); the parity test asserts it equals the
   literal `db.ts` declares, then runs identical case-fold / diacritic / Porter-stem
   queries (`crush`/`crushing`/`crushed`, `Crusher`/`crusher`, `café`/`cafe`) against
   both the main `observations_fts` and the throwaway index and asserts the **match
   set is identical**. The failure mode prevented (proven real in the test): a default
   tokenizer would silently miss `retrieve("crushing")` against a blob containing
   `crushed`, while `search_memory` (which stems) matches it.

**Explicit non-claim.** This is **tokenizer/match parity, NOT BM25 score-magnitude
equivalence.** The throwaway index has N≈1 documents, so its IDF is degenerate and its
absolute scores are corpus-size-dependent and not comparable to the full-corpus index
by construction. `bm25()` ordering WITHIN the single blob is self-consistent and used
only to rank the returned subset.

**Where SQLite is NOT available** (the hook runtime): a dependency-free JS fallback
(`jsFallbackQuery`) does AND-token substring matching. It is correct-but-coarse and
**deliberately does not claim parity** — the parity guarantee belongs to the injected
`queryFn`. The hook wires the FTS path when it has SQLite; otherwise it degrades
loudly-in-design (a documented coarser matcher), never silently-wrong about parity.

## 6. What DIO-11 deliberately does NOT do

- **No proactive expansion** — reactive `retrieve` only (FR-D4).
- **No graph internals** — store #2 is a delegation seam to DIO-9, not graph code here.
- **No capture-path write** — that is DIO-18 / FR-B5 (default-off, separately gated).
- **No `observations` / `observations_fts` write on any path** — the storage hygiene
  rule (§3) and the query hygiene rule (§5) are the two halves of the same boundary.
