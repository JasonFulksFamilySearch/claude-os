# Phase 2 — MCP Server with SQLite FTS5

**Shipped:** 2026-04-29
**Branch:** `phase-2-mcp-server`

## What shipped

A local TypeScript MCP server at `~/.claude-os/mcp/`, registered with Claude
Code via `~/.claude.json`. It indexes curated markdown into
`~/.claude-data/memory.db` (SQLite + FTS5) and exposes five tools:

- `search_memory(query, limit?, source_filter?, project_filter?)`
- `get_topic(topic_name)`
- `append_learning(scope, content, project?, title?)`
- `list_topics()`
- `get_recent_learnings(scope, limit?, project?)`

Indexing covers everything under `~/.claude-data/` (excluding `archive/` and
`_legacy*` files) plus `CLAUDE.md` / `README.md` from each project listed in
`~/.claude-os/config/watched-projects.json`. A chokidar watcher reacts to
file changes immediately; a 15-minute in-process backstop reindex runs as a
safety net.

Initial watched-projects on Willis (6 repos):

- `arc-record-exchange`
- `arc-pages`
- `arc-record-exchange-orch-service`
- `arc-delivery-specification-service` (README only)
- `arc-record-exchange-global-status-service`
- `perch`

First indexed corpus on Willis: 22 rows (1 agent + 9 context + 1 learning +
11 project files).

Tests: 33 passing across `db.test.ts`, `indexer.test.ts`, `tools.test.ts`.

## What was deliberately NOT built

- No `claude-os` CLI. All interaction is through MCP.
- No raw session transcript indexing. Phase 3 will add extraction.
- No vector embeddings or semantic search. Phase 4.
- No hooks (`UserPromptSubmit`, `SessionStart`, `SessionEnd`). Phase 3.
- No HTTP/SSE transport, no Tailscale Funnel, no claude.ai bridge. Phase 5.
- No web UI. Phase 7.

## Phase 1 → Phase 2 boundary

Phase 1 produced the file system layout and identity. Phase 2 builds **around**
those artifacts, never on top of them: `~/.claude-data/agent/CLAUDE.md`,
`~/.claude-data/context/_index.md`, the legacy preserves, and the slash
commands / skills migrated from `~/.claude/` are unchanged.

The new artifacts are:

- `~/.claude-os/mcp/` — TypeScript source + tests + dist
- `~/.claude-os/config/watched-projects.json` — project list (data, but at
  user-curated cadence — kept in the system repo because it's structurally
  small and rarely changes)
- `~/.claude-os/docs/phase-2.md` — this file
- `~/.claude-data/memory.db` — search index (machine-local, never committed)
- `~/.claude-data/.logs/mcp-server.log` — structured JSON log

## What to expect next (Phase 3)

Phase 3 introduces:

- A session-transcript extractor that distills conversations into learnings,
  rather than indexing raw chat content (which would drown high-signal
  curated material).
- `UserPromptSubmit` and `SessionEnd` hooks for proactive context loading
  (read `_index.md`, surface relevant topics) and post-session learning
  capture.
- An `extractions` table in the existing schema to hold distilled output.

The Phase 2 schema accommodates this without migration. The five Phase 2 tools
remain stable; Phase 3 adds extraction-specific tools alongside them.

## Sanity check after rebuilds

```bash
cd ~/.claude-os/mcp
npm test                                          # 33 tests, zero failures
npm run build                                     # produces dist/index.js
sqlite3 ~/.claude-data/memory.db ".schema"        # observations + observations_fts + triggers + meta
sqlite3 ~/.claude-data/memory.db "SELECT COUNT(*) FROM observations"
```

## Configuration touch points

- **MCP registration:** `~/.claude.json` → `mcpServers.claude-os-mcp`. Backup
  of pre-Phase-2 config preserved at `~/.claude.json.pre-claude-os-mcp`.
- **Watched projects:** `~/.claude-os/config/watched-projects.json`. Schema
  at `watched-projects.schema.json` for editor autocomplete.
- **Logger output:** `~/.claude-data/.logs/mcp-server.log`. Override in tests
  via `setLogPath()`.
- **Database location:** `~/.claude-data/memory.db`. Override in tests via
  the `dbPath` parameter to `openDb()`.
