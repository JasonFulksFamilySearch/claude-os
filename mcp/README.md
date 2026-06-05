# claude-os-mcp

Local MCP server backing Jason's `claude-os` memory system. Indexes curated
markdown under `~/.claude-data/` plus `CLAUDE.md` / `README.md` from a
configurable list of project repos, and exposes **eleven** tools to Claude Code
over the stdio transport.

Search is **hybrid**: BM25 full-text (FTS5) fused with semantic vector search
(sqlite-vec + a locally-run embedding model). The store is at `schema_version = 2`,
`phase = 4` — episodic memory (Haiku session digests) and vector embeddings are
both live; the claude.ai bridge (Phase 5) is the remaining future phase.

---

## What it does

- Reads markdown from `~/.claude-data/agent/`, `~/.claude-data/context/`,
  `~/.claude-data/projects/<slug>/`, `~/.claude-data/episodes/`, and the
  `CLAUDE.md` / `README.md` of every project listed in
  `~/.claude-os/config/watched-projects.json`.
- Stores a searchable mirror in `~/.claude-data/memory.db` (SQLite + FTS5 + sqlite-vec).
- Embeds each observation with **nomic-embed-text-v1.5** (loaded at int8 / `q8`
  quantization) into a 768-dim vector, so recall works by meaning as well as keyword.
- Exposes eleven MCP tools: `search_memory`, `get_topic`, `append_learning`,
  `list_topics`, `get_recent_learnings`, `list_episodes`, `mark_episode_promoted`,
  `scan_novelty`, `resolve_novelty_flag`, `scan_experience`,
  `validate_experience_proposal`.
- Stays current via a chokidar file watcher (instant on file change) and a
  15-minute in-process backstop reindex.
- Skips `~/.claude-data/archive/`, `_legacy*` files, `_index.md`,
  `_`-prefixed episodes, and files > 1 MB.

---

## Quick reference

| Path | Purpose |
|---|---|
| `~/.claude-os/mcp/src/` | TypeScript source |
| `~/.claude-os/mcp/src/scripts/reembed.ts` | One-time re-embed migration (`npm run reembed`) |
| `~/.claude-os/mcp/dist/` | Compiled output (gitignored) — what Claude Code runs |
| `~/.claude-os/mcp/test/` | vitest suite |
| `~/.claude-os/config/watched-projects.json` | List of project repos to index |
| `~/.claude-data/memory.db` | SQLite index (machine-local, never committed) |
| `~/.claude-data/.logs/mcp-server.log` | Structured JSON log (one event per line) |

---

## Tools

### `search_memory`
Hybrid search: FTS5 BM25 **and** semantic vector (KNN) search, merged into one
ranked list with `<mark>` highlighting and source paths. Filters by `source_type`
(`context`, `learning`, `decision`, `project_claude_md`, `project_readme`,
`agent`, `episode`) and `project` slug. Use `source_filter: ["episode"]` to scope
to episodic memory. The vector half degrades gracefully to FTS-only if the model
can't load or the vector index is empty.

### `get_topic`
Loads `~/.claude-data/context/<topic>.md` from disk (not from the index — disk
is source of truth). Returns null for missing topics.

### `append_learning`
Appends a dated H2 entry to `~/.claude-data/agent/learnings.md` (scope =
`agent`) or `~/.claude-data/projects/<project>/learnings.md` (scope =
`project`). Creates the file with a default header if missing. Triggers an
inline reindex so the new entry is searchable immediately.

### `list_topics`
Enumerates every topic file in `~/.claude-data/context/`. Cross-references
`_index.md`; reports drift in `warnings`.

### `get_recent_learnings`
Parses `## YYYY-MM-DD — title` headings from `learnings.md` files. Returns
the N newest entries across `agent`, a single `project`, or `all` scopes.

### `list_episodes`
Lists recent session episodes from `~/.claude-data/episodes/` — Haiku-generated
session digests of decisions, corrections, and discoveries. Filters by `project`
slug and `promoted` status; newest first (ties broken on `session_id`). For
full-text search across episode bodies, use `search_memory` with
`source_filter: ["episode"]`.

### `mark_episode_promoted`
Sets `promoted: true` in an episode file's frontmatter (atomic write via
temp-file + rename) after its content has been graduated into `learnings.md` or
a context topic. Takes the `path` returned by `list_episodes`, enforces episode-
directory containment, and re-indexes the file immediately.

### `scan_novelty`
Review-time scan for near-duplicate learning entries (A2). Parses all learning
entries (optionally one `project` plus agent), embeds each, clusters
near-duplicates, persists them as pending `novelty_flags`, and returns every
pending candidate. Stale flags (entry since edited/removed) are dropped. Never
mutates learnings — the agent labels and proposes supersessions in
`/memory-merger`.

### `resolve_novelty_flag`
Records a human-gated resolution of a novelty flag (A2): `dismissed` (false
positive) or `superseded` (older entry retired). Called only after Jason approves
in `/memory-merger`; the markdown edit is done separately by the skill.
Idempotent — returns `updated: false` for an unknown `id`.

### `scan_experience`
Mechanical step of cross-session experience synthesis (B1). Clusters the
**unpromoted** episode backlog by thematic similarity, reusing each episode's
pre-computed embedding (no re-embedding), and returns the clusters with their
member episodes. Performs no LLM synthesis and persists nothing; clusters below
the configured minimum size are dropped.

### `validate_experience_proposal`
Gate 1 of experience synthesis (B1, deterministic grounding). Validates a
candidate experience-learning proposal on three counts: schema conformance,
citation grounding (every cited episode resolves to a real one, and at least the
minimum distinct episodes are cited), and that it is not a lexical near-duplicate
of an existing learning. Returns `{ valid, errors, resolved_citations,
unresolved_citations, duplicate_of }`.

---

## Embeddings & semantic search

- **Model:** `nomic-ai/nomic-embed-text-v1.5` via `@huggingface/transformers`
  (onnxruntime), loaded with **`dtype: "q8"`** (int8-quantized weights). Output is
  a 768-dim float32 vector — identical shape to fp32, so the vector store is
  dtype-agnostic and no schema change is needed to switch precision.
- **The dtype is a named constant:** `EMBEDDING_DTYPE` in `src/embedder.ts`.
  Change it there (e.g. back to `"fp32"`) and re-run the migration to switch.
- **Lazy-loaded:** the model loads on the first embed — a `search_memory` query,
  or indexing a new/changed file (including the startup reindex when files
  changed) — not eagerly at startup. RAM per server: **~120 MB idle, ~600 MB
  warmed at q8** (vs ~1.1–1.5 GB at fp32).
- **Storage:** vectors live in the `vec_items` virtual table (sqlite-vec `vec0`).
  `search_memory` embeds the query, runs a KNN match, and fuses the hits with FTS.
- **Quantization tradeoff:** q8 trades a measured recall dip (≈0.94 mean cosine vs
  fp32, recall@5 ≈0.80) for roughly half the RAM. fp16 is **not** usable for this
  model — its ONNX export crashes on long inputs (rotary-embedding broadcast) — so
  the practical choice is q8 vs fp32.

---

## Re-embedding (one-time migration)

`npm run reembed` rebuilds the entire vector index from the `observations` table.

```bash
cd ~/.claude-os/mcp
# quiesce other Claude Code sessions first (see below)
npm run reembed
```

- **When to run it:** after changing `EMBEDDING_DTYPE` (or the model), or on a
  fresh machine to populate `vec_items` for the first time.
- **Atomic:** embeds every observation into memory first, then clears and
  repopulates `vec_items` in a single transaction — an interruption leaves the
  *prior* index fully intact (no half-rebuilt state).
- **Idempotent & lossless:** `vec_items` is a pure derivative of `observations`,
  so re-running is safe and doubles as **rollback** — revert `EMBEDDING_DTYPE` to
  `"fp32"` and re-run.
- **Quiesce sessions first:** the migration is run by hand, not wired into
  startup. The one uncovered risk is another session's server writing between the
  migration's read and its swap, so close other sessions before running it.
- Prints `cleared` / `reembedded` counts and duration on completion.

It is deliberately **not** wired into server startup — a precision change is a
rare, one-and-done event per machine, and an always-on rebuild would cause a
concurrent-rebuild storm when several sessions start at once.

---

## Rebuilding

```bash
cd ~/.claude-os/mcp
npm install      # only when dependencies change
npm run build    # tsc → dist/
npm test         # vitest, must be zero failures
npm run reembed  # one-time, after an embedding dtype/model change (sessions quiesced)
```

`dist/index.js` is what Claude Code launches. After rebuilding, restart any
active Claude Code session for the new code to load (each session runs its own
server process and loads the model lazily).

---

## Schema overview

`~/.claude-data/memory.db`:

- **`observations`** — one row per indexed file. Columns: `id`, `source_type`,
  `source_path` (UNIQUE), `project`, `topic`, `title`, `content`,
  `content_hash` (sha256 of body, post-frontmatter), `file_mtime`, `indexed_at`,
  `frontmatter` (raw YAML or NULL).
- **`observations_fts`** — FTS5 virtual table mirroring `title`, `content`,
  `topic`. Triggers keep it in sync on insert/update/delete.
- **`vec_items`** — sqlite-vec `vec0` virtual table: `observation_id INTEGER
  PRIMARY KEY`, `embedding FLOAT[768]`. One row per embedded observation;
  `observation_id` mirrors `observations.id`. *Implementation note:* better-sqlite3
  binds JS numbers as `SQLITE_FLOAT`, which the `vec0` integer PK rejects — every
  insert/delete against `vec_items` must bind `BigInt(id)`.
- **`access_stats`** — per-observation access-reinforcement state, kept in a side
  table so the access-bump write never fires the `observations` FTS-sync triggers.
  Columns: `observation_id` (PK, `REFERENCES observations(id) ON DELETE CASCADE`),
  `last_accessed`, `access_count` (default `0`).
- **`novelty_flags`** — A2 candidate duplicate/contradiction pairs of dated learning
  entries awaiting human-gated supersession. Standalone (own PK, no FK to
  `observations` — it references entries, not rows). Columns: `id`, `source_path`,
  `entry_date`, `entry_hash`, `match_path`, `match_date`, `match_hash`, `similarity`,
  `kind`, `detected_by`, `status` (default `'pending'`), `detected_at`;
  `UNIQUE(source_path, entry_hash, match_path, match_hash)`.
- **`meta`** — key/value table: `schema_version` (`2`), `phase` (`4`).

Relational columns can grow via `ALTER TABLE` + a `schema_version` bump without a
reset; the indexer backfills on the next pass. The vector index is regenerated
with `npm run reembed`, never migrated in place.

---

## Adding a watched project

1. Edit `~/.claude-os/config/watched-projects.json`. Append:
   ```json
   {
     "slug": "my-new-project",
     "path": "/absolute/path/to/repo"
   }
   ```
   Slug must match `^[a-z0-9][a-z0-9-]*$`. Optional `files` array overrides
   the default `["CLAUDE.md", "README.md"]`.

2. Restart Claude Code. The MCP server reads the config at startup; it does
   not hot-reload.

3. Verify with `search_memory` on a phrase you know is in the new project's
   `CLAUDE.md` or `README.md`.

---

## Logging

All log lines are structured JSON, one event per line, written to
`~/.claude-data/.logs/mcp-server.log`. Important events:

- `claude-os-mcp starting` — process started
- `startup reindex complete` — initial walk finished
- `file watcher started` — chokidar online
- `stdio transport connected, ready for requests` — ready for MCP traffic
- `backstop reindex complete` — every 15 minutes
- `tool call failed` — tool handler threw; check `meta.tool` and `meta.error`
- `shutting down` — SIGINT/SIGTERM received

The **server** never uses `console.log` — stdout carries the MCP wire protocol
and any stray write corrupts it (use the structured logger instead). Standalone
scripts like `npm run reembed` are not on the transport and print to stdout
normally.

---

## Troubleshooting

**"Tool not available" in Claude Code session.** The MCP server is launched on
demand at session start. Restart Claude Code after editing the config.

**Search returns only keyword hits, or no results for a meaning-based query.**
The vector index may be empty (e.g. on a fresh machine, or after a model change).
Check and repair:
```bash
sqlite3 ~/.claude-data/memory.db "SELECT count(*) FROM vec_items"   # 0 → not embedded
cd ~/.claude-os/mcp && npm run reembed                              # repopulate (sessions quiesced)
```
Note also that FTS5 implicitly ANDs query tokens — a long multi-word phrase can
match zero rows on the keyword side; the vector half still contributes if the
index is populated.

**Search returns no hits but the file exists.** Look for one of: file not under a
configured path; file in `archive/` or with `_legacy*` basename; file > 1 MB;
`_index.md` or a `_`-prefixed episode (deliberately excluded). Inspect with:
```bash
sqlite3 ~/.claude-data/memory.db "SELECT source_path FROM observations WHERE source_path LIKE '%fragment%'"
```

**`mutex lock failed` / `libc++abi` on exit.** A harmless onnxruntime-node
teardown artifact that can appear as a process exits *after* the model was
loaded — data is unaffected. The `reembed` CLI avoids it by letting the event
loop drain instead of calling `process.exit()`; never add `process.exit()` to a
script that loads the embedder.

**Server appears hung at startup.** Check the log for the most recent
`fullReindex complete` event. If reindex is slow, look for an unintentional giant
directory in the watched paths (watched roots are expected to hold on the order
of hundreds to low-thousands of files). The first embed also loads the model,
which can take a few seconds — separate from reindex.

**better-sqlite3 won't build.** macOS Command Line Tools may need updating:
`xcode-select --install`. Then rerun `npm install`.

**"database is locked" errors.** A previous server instance may still hold the
WAL lock. Kill any stray `node …/dist/index.js` processes and restart.

---

## Tests

```bash
npm test
```

Five suites:
- `db.test.ts` — schema idempotency, FTS5 trigger correctness
- `embedder.test.ts` — vector serialization + constants (incl. `EMBEDDING_DTYPE`);
  never loads the real model
- `indexer.test.ts` — `classify`, `indexFile` (upsert/no-op), `fullReindex`,
  archive/oversize skip behavior, and `vec_items` population
- `reembed.test.ts` — `reembedAll`: full re-embed + count reporting, idempotency,
  losslessness (observations & FTS untouched), and atomic rollback when an insert
  fails inside the swap transaction
- `tools.test.ts` — all 11 tool handlers against seeded fixture data

Tests mock the embedder module (the real model is never loaded) and use a tmpdir
database + logger, so they never touch `~/.claude-data/`.
