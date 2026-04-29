# claude-os-mcp

Local MCP server backing Jason's `claude-os` memory system. Indexes curated
markdown under `~/.claude-data/` plus `CLAUDE.md` / `README.md` from a
configurable list of project repos, and exposes five tools to Claude Code via
the stdio transport.

This is the Phase 2 deliverable. The schema and architecture are designed to
absorb Phases 3 (transcript extraction + hooks), 4 (vector embeddings), and 5
(claude.ai bridge) without migration.

---

## What it does

- Reads markdown from `~/.claude-data/agent/`, `~/.claude-data/context/`,
  `~/.claude-data/projects/<slug>/`, and the `CLAUDE.md` / `README.md` of every
  project listed in `~/.claude-os/config/watched-projects.json`.
- Stores a searchable mirror in `~/.claude-data/memory.db` (SQLite + FTS5).
- Exposes five MCP tools: `search_memory`, `get_topic`, `append_learning`,
  `list_topics`, `get_recent_learnings`.
- Stays current via a chokidar file watcher (instant on file change) and a
  15-minute in-process backstop reindex.
- Skips `~/.claude-data/archive/` and any `_legacy*` files.

---

## Quick reference

| Path | Purpose |
|---|---|
| `~/.claude-os/mcp/src/` | TypeScript source |
| `~/.claude-os/mcp/dist/` | Compiled output (gitignored) — what Claude Code runs |
| `~/.claude-os/mcp/test/` | vitest suite |
| `~/.claude-os/config/watched-projects.json` | List of project repos to index |
| `~/.claude-data/memory.db` | SQLite index (machine-local, never committed) |
| `~/.claude-data/.logs/mcp-server.log` | Structured JSON log (one event per line) |

---

## Tools

### `search_memory`
Full-text BM25 search across the entire index. Returns ranked snippets with
`<mark>` highlighting plus the source path. Filters by `source_type`
(`context`, `learning`, `decision`, `project_claude_md`, `project_readme`,
`agent`) and `project` slug.

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

---

## Rebuilding

```bash
cd ~/.claude-os/mcp
npm install      # only when dependencies change
npm run build    # tsc → dist/
npm test         # vitest, must be zero failures
```

`dist/index.js` is what Claude Code launches. After rebuilding, restart any
active Claude Code session for the new code to be loaded.

---

## Schema overview

`~/.claude-data/memory.db`:

- **`observations`** — one row per indexed file. Columns: `id`, `source_type`,
  `source_path` (UNIQUE), `project`, `topic`, `title`, `content`,
  `content_hash` (sha256 of body, post-frontmatter), `file_mtime`, `indexed_at`,
  `frontmatter` (raw YAML or NULL).
- **`observations_fts`** — FTS5 virtual table mirroring `title`, `content`,
  `topic`. Triggers keep it in sync on insert/update/delete.
- **`meta`** — small key/value table with `schema_version` and `phase`.

Phase 4 will add an `embedding BLOB` column via `ALTER TABLE` without
migration.

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
`~/.claude-data/.logs/mcp-server.log`. Important log events:

- `claude-os-mcp starting` — process started
- `startup reindex complete` — initial walk finished
- `file watcher started` — chokidar online
- `stdio transport connected, ready for requests` — ready for MCP traffic
- `backstop reindex complete` — every 15 minutes
- `tool call failed` — tool handler threw; check `meta.tool` and `meta.error`
- `Skipping oversized file` — file > 1 MB; curated content shouldn't be that
  big

`console.log` is **never** used — stdout carries the MCP wire protocol and
any stray writes corrupt it.

---

## Troubleshooting

**"Tool not available" in Claude Code session.** The MCP server is launched
on demand at session start. Restart Claude Code after editing the config.

**Search returns no hits but the file exists.** Look for one of: file not
under a configured path; file in `archive/` or with `_legacy*` basename; file
> 1 MB; `_index.md` (deliberately excluded). Inspect with:
```bash
sqlite3 ~/.claude-data/memory.db "SELECT source_path FROM observations WHERE source_path LIKE '%fragment%'"
```

**Server appears hung at startup.** Check the log for the most recent
`fullReindex complete` event. If reindex is slow, look for an unintentional
giant directory in the watched paths (Phase 2 expects watched roots to hold
hundreds of files at most).

**better-sqlite3 won't build.** macOS Command Line Tools may need updating:
`xcode-select --install`. Then rerun `npm install`.

**"database is locked" errors.** A previous server instance may still hold
the WAL lock. Kill any stray `node …/dist/index.js` processes and restart.

**Schema needs to change.** Add a new column via `ALTER TABLE` and bump
`meta.schema_version`. Don't reset existing rows; the indexer handles
backfill on the next pass.

---

## Tests

```bash
npm test
```

Three suites:
- `db.test.ts` — schema idempotency, FTS5 trigger correctness
- `indexer.test.ts` — `classify`, `indexFile` (upsert/no-op), `fullReindex`,
  archive/oversize skip behavior
- `tools.test.ts` — all five tool handlers against seeded fixture data

Tests redirect the logger to tmpdir and use a tmpdir database, so they never
touch `~/.claude-data/`.
