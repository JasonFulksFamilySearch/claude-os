# Episodic Layer — Design Spec
**Date:** 2026-05-14  
**Status:** Approved for implementation

---

## Problem

Claude-os today has a strong semantic memory layer (`learnings.md`, context topics) and good retrieval tooling (`search_memory`, `get_topic`, `topic-preload`). What it lacks is an **episodic layer**: a record of what actually happened in a session — decisions made, corrections given, non-obvious discoveries — before those signals are distilled (or lost).

Without the episodic layer, learning capture is entirely manual. Willis must notice a lesson and call `append_learning`. In fast-paced sessions, moments slip by. There is no "what did we do last time on this project" recall.

---

## Goal

Auto-generate a structured episode record at the end of every meaningful session, surface recent episodes at session start, and feed them into the existing memory-merger promotion pipeline — without adding maintenance overhead or third-party dependencies.

---

## Architecture

```
Stop hook fires
  ├─ learnings-flush.js         (existing — unchanged)
  └─ session-observer.js        (new)
        ↓
  ~/.claude-data/episodes/YYYY-MM-DD-<ms-timestamp>.md  written

Indexer (existing, 15-min interval)
  └─ picks up new episode → embeds → SQLite
        ↓
  search_memory now covers episodes automatically

Next session — SessionStart fires
  └─ session-start-check.js     (extended)
        ↓
  Last N project-matched episodes injected as additionalContext

Periodic — /memory-merger
  └─ reviews promoted:false episodes
  └─ promotes signal to learnings.md or context/*.md
  └─ sets promoted: true in episode frontmatter
```

---

## Components

### 1. `hooks/session-observer.js` — Stop hook

**Trigger:** Stop lifecycle event (runs alongside existing `learnings-flush.js`)

**Behavior:**
1. Read JSON from stdin; if `stop_hook_active: true`, exit 0 immediately (prevents loops)
2. Read `transcript_path` from stdin JSON (provided by Claude Code's Stop hook input); fall back to finding the most recently modified JSONL under `~/.claude/projects/` if absent
3. Parse JSONL; extract text from `human` and `assistant` turns only (skip raw tool I/O)
4. If fewer than 3 turns, exit 0 — nothing worth observing
5. Truncate to 30,000 characters, keeping the most recent turns
6. POST to Anthropic API using Haiku model with structured observation prompt
7. Parse JSON response; if all observation arrays are empty, exit 0 (quiet session)
8. Write episode file to `~/.claude-data/episodes/`
9. On any failure (API error, parse error, file write error): log to stderr, exit 0 — never block session close

**Haiku system prompt:**
```
You are a session observer for an AI coding assistant named Willis.
Extract ONLY salient, non-obvious observations from the session transcript.

Focus on:
- Decisions: approach A chosen over B, with the reason WHY
- Corrections: Willis was wrong and had to change direction
- Discoveries: surprising behavior, hidden constraints, non-obvious patterns

Ignore routine tool calls, boilerplate, and things any senior engineer already knows.

Return JSON only:
{
  "summary": "2-4 sentence session description",
  "project": "inferred project name or null",
  "decisions": ["..."],
  "corrections": ["..."],
  "discoveries": ["..."],
  "files_of_note": [{"path": "...", "reason": "..."}]
}

Empty arrays are correct when nothing noteworthy occurred. Quality over quantity.
```

---

### 2. `~/.claude-data/episodes/YYYY-MM-DD-<ms-timestamp>.md` — Episode file format

```markdown
---
date: 2026-05-14
session_id: 1747267200000
project: arc
turns: 31
promoted: false
---

## Summary
[2-4 sentence description of what was worked on and how it resolved.]

## Decisions
- [Decision with WHY included.]

## Corrections
- [What Willis got wrong and what the correct answer was.]

## Discoveries
- [Non-obvious finding that would surprise a future reader.]

## Files of note
- `path/to/file.ts` — reason this file was significant this session
```

**Design notes:**
- `promoted: false` frontmatter allows `memory-merger` to glob its work queue efficiently
- Sections omitted when empty (no placeholder text)
- Plain markdown — indexer needs no special handling

---

### 3. `hooks/session-start-check.js` — Extension

**Current behavior:** Checks for `_tmp_claude_md_update_needed.txt` and injects alert if present.

**Extended behavior:** After the existing marker check, also:
1. Read `~/.claude-os/config/episodes.json` → get `sessionStartInjectCount` (default: 2) and `stalenessThresholdDays` (default: 30)
2. Glob `~/.claude-data/episodes/*.md`, parse frontmatter, sort by date descending
3. Infer current project from stdin `cwd`: match against project `path` entries in `watched-projects.json` first; fall back to `path.basename(cwd)`
4. Filter to files where `project` matches and date is within staleness threshold
5. Take the top N files
6. Inject a brief digest into `additionalContext`:

```
[Episode — 2026-05-13 | arc]
Debugged download stall detection in SplunkService. Chose sliding window
over fixed interval due to clock skew in distributed environments.
→ Full detail: search_memory("arc stall detection 2026-05-13")
```

**Constraints:** Total injection capped at ~400 tokens. If no matching episodes, inject nothing.

---

### 4. `mcp/src/tools/list_episodes.ts` — New MCP tool

**Purpose:** Browse the episode store by date and project.

**Parameters:**
- `limit`: number (default: 10)
- `project`: string (optional filter)
- `promoted`: boolean (optional filter)

**Implementation:** Glob `~/.claude-data/episodes/*.md`, parse frontmatter, apply filters, sort by date descending, return array of `{ date, project, session_id, summary, promoted, path }`. Direct file reads — no DB query, no index dependency.

---

### 5. `~/.claude-os/config/episodes.json` — Configuration

```json
{
  "sessionStartInjectCount": 2,
  "stalenessThresholdDays": 30
}
```

Both `session-start-check.js` and `session-observer.js` read this file. Defaults apply gracefully if the file is absent. Increase `sessionStartInjectCount` to surface more episodes at session start without any code changes.

---

### 6. `mcp/src/indexer.ts` — Watched path addition

Add `~/.claude-data/episodes/` to `defaultConfig()` as a permanent watched path (not in `watched-projects.json`, since episodes are agent-level). This gives `search_memory` coverage over all episode files within 15 minutes of writing, with no per-project configuration required.

---

## Data flow summary

| Event | What happens |
|---|---|
| Session ends | `session-observer.js` → Haiku → episode file written |
| 15 min later | Indexer embeds episode → `search_memory` covers it |
| Next session starts | `session-start-check.js` injects last N episode digests |
| Willis searches | `search_memory("topic")` returns episode hits alongside learnings |
| Willis browses | `list_episodes(project: "arc")` returns recent episode list |
| Memory cleaning | `/memory-merger` reviews `promoted:false` episodes → promotes signal → sets `promoted:true` |

---

## Additional changes identified in design review

### `mcp/src/db.ts` — `SourceType` union
Add `"episode"` to the `SourceType` union (line 80). `source_type` is a plain `TEXT` column in SQLite — no migration needed. The union update ensures TypeScript typing stays accurate across `classify()`, `indexFile()`, and `search_memory`.

### `mcp/src/indexer.ts` — three coordinated changes (not one)
The spec originally said "add to `defaultConfig()`." After reading the code, three places require changes:
1. `classify()` — must handle `episodes/` paths and return `{ source_type: "episode", topic: null, project: <frontmatter project> }`
2. `fullReindex()` — must walk `episodes/` dir alongside `agent/`, `context/`, `projects/`
3. `watchAll()` — must add `episodes/` to the chokidar watched paths

### `mcp/src/tools/search_memory.ts` — description update
Update the tool description to include `"episode"` as a valid `source_filter` value and mention that episode files are searchable.

### `mark_episode_promoted` MCP tool (new)
The promotion write-back from `memory-merger` is unspecified without this. It updates `promoted: false → true` in an episode file's frontmatter. `memory-merger` calls this tool after promoting an episode's content.

### `session-start-check.js` — single JSON output merge
If both a CLAUDE.md alert AND episode digests are present, they must be merged into one `additionalContext` string — two sequential `process.stdout.write()` calls will not work. The hook builds the full context string before a single write.

### `gray-matter` in hooks — inline frontmatter parser
`gray-matter` lives in the MCP's `node_modules`, not in the hooks layer. Hook scripts use a minimal inline YAML frontmatter parser (10–15 lines) rather than a cross-boundary require.

### Injection cap — characters, not tokens
400 tokens ≈ 1,600 characters. `session-start-check.js` enforces a 1,600-character cap rather than a token count, which would require the Anthropic SDK.

### `session_id` field sourced from Stop hook input
The Stop hook input provides a `session_id` field. Use it directly in episode frontmatter rather than a millisecond timestamp. Fall back to `Date.now()` if absent.

## What is NOT changing

- `learnings-flush.js` — unchanged
- `get_topic`, `append_learning`, `list_topics`, `get_recent_learnings` — unchanged
- `db.ts` schema (SQL) — unchanged; only the TypeScript `SourceType` union is updated
- `embedder.ts` — unchanged
- `watched-projects.json` — unchanged

---

## Out of scope

- Episode deletion / TTL automation (manual cleanup for now; `promoted:true` files are candidates)
- Cross-machine episode sync (episodes stay in `~/.claude-data/`, which is per-machine by design)
- Episode editing UI

---

## Success criteria

1. After any session with 3+ turns, an episode file exists in `~/.claude-data/episodes/`
2. At next session start in the same project, Willis sees a digest without being asked
3. `search_memory("topic")` returns relevant episode hits
4. `list_episodes` returns a browsable list
5. `/memory-merger` has a clear, filterable work queue via `promoted:false`
6. No session is ever blocked from closing due to a hook failure
