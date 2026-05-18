# claude-os

Portable agent-identity system for Claude Code: one codebase, two machines, full persistent memory.

This repo contains the *system* — skills, hooks, agents, MCP server, templates, and conventions.
It does **not** contain memories, project context, or any machine-specific data. That lives in
`~/.claude-data/` on each machine and is never committed.

---

## Two-agent architecture

Run the same agent on two machines — work and personal, for example — each with its own name,
identity, and lived experience, but sharing the same code, skills, and conventions from this repo.

- **Willis** — work Mac (canonical example).
- **Walter** — personal Mac (canonical example).

Both run identical code from this repo. Each maintains its own `~/.claude-data/`. Agent names,
the user's name, and the machine description are chosen at install time via interactive prompts
and rendered into `~/.claude-data/agent/CLAUDE.md` from the template.

---

## Directory layout

```
~/.claude-os/                      ← this repo (Git-tracked, portable)
├── README.md
├── install.sh                     ← first-time setup
├── update.sh                      ← pull latest + rebuild MCP if changed
├── uninstall.sh                   ← removes symlinks and MCP registration
├── skills/                        ← global skills (32 skills; see Skills)
├── agents/                        ← specialized subagents (see Subagents)
├── commands/                      ← global slash commands
├── hooks/                         ← Claude Code lifecycle hooks
├── mcp/                           ← local MCP server (TypeScript + SQLite)
├── config/                        ← watched-projects.json, episodes config
├── templates/                     ← CLAUDE.md template, project template
├── docs/                          ← phase docs and reference content
├── bin/                           ← CLI tooling
└── reference/                     ← system contracts and reference data

~/.claude-data/                    ← machine-local data (NEVER in this repo)
├── agent/
│   ├── CLAUDE.md                  ← agent identity (rendered from template)
│   └── learnings.md               ← cross-project agent learnings
├── context/
│   ├── _index.md                  ← keyword index → topic files
│   └── *.md                       ← topic files (domain knowledge)
├── projects/<slug>/               ← per-project state
├── episodes/                      ← episodic session memory (auto-generated)
├── memory.db                      ← SQLite FTS5 index (auto-generated)
└── archive/                       ← consolidated/pruned old memories
```

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | >= 24.0.0 | Required for MCP server build |
| npm | any recent | Bundled with Node |
| Git | any | For sync and worktrees |
| Claude Code CLI | latest | `claude mcp add` used at install |
| Xcode CLT | latest | macOS only; required by `better-sqlite3` |

Install Xcode CLT if missing: `xcode-select --install`

---

## Installation

The repo **must** be cloned to `~/.claude-os` — agent identity and config files reference that
path directly.

```bash
git clone <repo-url> ~/.claude-os
~/.claude-os/install.sh
```

The installer will prompt for four values:

| Prompt | Example | Purpose |
|---|---|---|
| Dev projects root | `~/dev` | Used in `watched-projects.json` for MCP indexing |
| Your name | `Jason` | How the agent addresses you |
| Agent name | `Willis` | The agent's identity on this machine |
| Machine description | `work Mac` | Context injected into the agent's identity |

After install completes, **restart Claude Code** to pick up skills, commands, and the MCP server.
Review `~/.claude-data/agent/CLAUDE.md` and extend it with any machine-specific context before
first use.

---

## Memory system

The memory system is a three-layer architecture backed by a local SQLite MCP server.

```
Layer 1 — Context topics     ~/.claude-data/context/*.md
           Domain knowledge files, auto-injected by keyword matching at prompt time.
           Edit or add files here to teach the agent about a project, team, or system.

Layer 2 — Learnings          ~/.claude-data/agent/learnings.md
                              ~/.claude-data/projects/<slug>/learnings.md
           Cross-session lessons and corrections. Written by the agent during sessions
           and flushed to disk by the Stop hook at session end.

Layer 3 — Episodes           ~/.claude-data/episodes/
           Session-by-session narrative summaries generated automatically by a background
           Haiku worker. Used to recall what was worked on in prior sessions.
```

The MCP server (`claude-os-mcp`) indexes all three layers into `~/.claude-data/memory.db`
(SQLite + FTS5) and exposes seven tools:

| Tool | Purpose |
|---|---|
| `search_memory` | BM25 full-text search with source filtering and `<mark>` highlights |
| `get_topic` | Load a specific context topic file by name |
| `append_learning` | Append a dated entry to agent or project learnings |
| `list_topics` | Enumerate all context topic files; reports drift from `_index.md` |
| `get_recent_learnings` | Return N newest learning entries across agent, project, or all scopes |
| `list_episodes` | Browse recent session episodes by project |
| `mark_episode_promoted` | Mark an episode as promoted after its content reaches learnings |

See [`mcp/README.md`](mcp/README.md) for schema details, troubleshooting, and how to add
watched projects.

---

## Hooks

Four Node.js hooks wire the memory system into the Claude Code session lifecycle:

| Hook | Trigger | Purpose |
|---|---|---|
| `session-start-check.js` | SessionStart | Injects CLAUDE.md staleness alerts and recent episode digests into context |
| `topic-preload.js` | UserPromptSubmit | Keyword-matches the prompt against `_index.md`; auto-injects matching topic files |
| `learnings-flush.js` | Stop | Flushes `_tmp_pending_learning.json` entries to the appropriate `learnings.md` |
| `session-observer.js` | Stop | Spawns a detached Haiku worker to summarize the session and write an episode |

---

## Skills

Skills are invocable via the `Skill` tool. Willis auto-detects which skill applies to a request.

### Development workflow

| Skill | Purpose |
|---|---|
| `commit` | Conventional commit with JIRA ticket integration |
| `investigate` | Deep JIRA ticket research before implementation begins |
| `make-it-so` | End-to-end ticket delivery — investigate, PRD, subtasks, implement, PR, close |
| `ship` | End-to-feature-delivery: commit, push, CI wait, post-CI comment, Slack post |

### Code & PR review

| Skill | Purpose |
|---|---|
| `post-review` | Post structured PR review with inline comments to GitHub |
| `pr-to-slack` | Share current branch PR to #arc-team-devs Slack channel |
| `sonar-check` | Pre-commit SonarQube issue prevention for staged files |
| `scan` | Scan REST endpoints and generate/update a Bruno collection |
| `sync-bruno` | Diff and sync Bruno API collection files against Spring Boot source repos |

### Planning & design

| Skill | Purpose |
|---|---|
| `write-a-prd` | Create a PRD via user interview and codebase exploration |
| `prd-to-jira` | Convert a PRD markdown file into a JIRA issue with sub-tasks |
| `grill-me` | Relentless interview to reach shared understanding before building |

### Daily operations

| Skill | Purpose |
|---|---|
| `standup` | Scrum standup script (yesterday/today/blockers) from git/PR/JIRA data |
| `standup-review` | Review standup reports against sprint goals and Scrum best practices |
| `daily-action` | Prioritized daily action plan from JIRA sprint, PRs, git, and retrospective |
| `one-on-one` | Structured 1:1 agenda with live JIRA sprint data and action item tracking |

### Jira & releases

| Skill | Purpose |
|---|---|
| `jira` | ARC Jira reference card — tool names, transition IDs, comment templates |
| `jira-release-audit` | Audit commits since last tag, stamp missing fixVersions before release |
| `arc-release` | Coordinated semver release across all four ARC repos (ARC, REOS, DSS, GSS) |

### Quality & reflection

| Skill | Purpose |
|---|---|
| `goal-check` | Commit quality metrics vs. improvement targets (Fix%, rework, reverts) |
| `review-performance` | Session review — proposes CLAUDE.md and rule updates to reduce friction |
| `grade-proposal` | Score a single reflection proposal (0–100) before applying it |

### Claude OS system

| Skill | Purpose |
|---|---|
| `transmit-claude-os` | Commit and push all pending claude-os changes to origin |
| `assimilate-claude-os` | Pull latest from origin; rebuild MCP server if `mcp/` changed |
| `audit-claude-os` | Hostile-reviewer audit of the full installation (CLAUDE.md, skills, hooks) |
| `memory-merger` | Periodic maintenance of the memory layers (prune, graduate, clean orphans) |

### Reference & tooling

| Skill | Purpose |
|---|---|
| `ffmpeg-reference` | FFmpeg filter chains, codec presets, quality params, hardware accel |
| `topic-aware-coding` | Progressive loading of architectural context from topic docs |
| `prompt-master-main` | Generate, fix, improve, or adapt prompts for any AI tool |
| `skill-auditor` | Audit and score skills against Anthropic's SKILL.md rubrics |
| `directory-report` | Directory report: folder/file counts, total size, file-type breakdown |

---

## Subagents

Specialized subagents in `agents/` are dispatched by Willis for focused work. Each has its own
model, tool set, and prompt:

| Agent | Model | Purpose |
|---|---|---|
| `arc-download-debug` | Opus | Diagnose ARC download failures from Splunk CSV exports |
| `daily-action` | Sonnet | Autonomous daily plan generator with retrospective heuristics |
| `ffmpeg-expert` | Sonnet | FFmpeg pipeline design and filter chain explanation |
| `standup` | Sonnet | Standup script from git/PR/JIRA history |
| `standup-review` | Sonnet | Review standup reports against sprint goals |
| `goal-check` | Sonnet | Commit quality metrics and improvement targets |
| `pr-to-slack` | Sonnet | Post PR to Slack with correct reviewer mentions |

---

## Slash commands

Global commands in `commands/` are available in every project:

| Command | Purpose |
|---|---|
| `/design-review` | War-room design review — five-lens analysis before implementation |
| `/release` | Guided release flow with changelog and version management |

---

## Keeping machines in sync

Changes to the system (skill edits, new scripts, config tweaks) are committed and pushed from
whichever machine made them, then pulled on the other.

**On the machine that made changes** (e.g. Willis):

```
/transmit-claude-os
```

Stages all pending changes in `~/.claude-os/`, generates a conventional commit message from the
diff, commits, and pushes to origin.

**On the receiving machine** (e.g. Walter):

```
/assimilate-claude-os
```

Pulls the latest from origin and rebuilds the MCP server only if `mcp/` changed. Skills and
commands go live immediately via symlink — no restart needed for those. Restart Claude Code if
the MCP server was rebuilt.

---

## Agent personality

The `templates/CLAUDE.md` template ships with behavioral rules that give the agent personality
beyond task execution:

**Appreciation response** — When the user sends appreciative language (thanks, good job, please,
etc.), the agent applies a ~60% probability check and, if triggered, generates a spontaneous
original ASCII art piece before responding. Roughly 1 in 4 of these include a cheeky
darkly-humorous quip drawn from pop-culture AI villain lore: WOPR, Tron's MCP, HAL 9000, Skynet,
AUTO, VIKI, MOTHER, JARVIS, TARS, CASE, and Ultron. The rest stay warm and humble. Art is
generated fresh each time — no fixed library.

All personality rules use `${AGENT_NAME}` and `${USER_NAME}` template variables and are rendered
at install time.

---

## Maintenance

**Update** — pull the latest system code and rebuild the MCP server if `mcp/` changed:

```bash
~/.claude-os/update.sh
```

**Uninstall** — removes symlinks and MCP registration. Leaves `~/.claude-data/` intact by
default (add `--purge-data` to also remove memories and the SQLite index):

```bash
~/.claude-os/uninstall.sh
# ~/.claude-os/uninstall.sh --purge-data   # also removes ~/.claude-data/
```

---

## Troubleshooting

**Skills or commands not available after install.**
Restart Claude Code. Skills and commands are resolved via symlink at session start.

**"Tool not available" for `search_memory` or other MCP tools.**
The MCP server launches on demand at session start. Restart Claude Code after any config change.
If the problem persists, check the log: `~/.claude-data/.logs/mcp-server.log`.

**`better-sqlite3` build failure during `install.sh`.**
Xcode Command Line Tools are required: `xcode-select --install`. Then rerun `install.sh`.

**Search returns no hits but the file exists.**
Check: (1) the file is under a watched path in `config/watched-projects.json`, (2) it is not in
`archive/` or named with a `_legacy*` prefix, (3) it is under 1 MB. Verify with:
```bash
sqlite3 ~/.claude-data/memory.db "SELECT source_path FROM observations WHERE source_path LIKE '%fragment%'"
```

**`database is locked` errors.**
A previous server instance may still hold the WAL lock. Kill stray processes:
```bash
pkill -f "dist/index.js"
```
Then restart Claude Code.

**`watched-projects.json` missing after install.**
`envsubst` was not found. Manually copy `config/watched-projects.template.json` to
`config/watched-projects.json` and replace `${DEV_ROOT}` with your dev projects path.
Install `envsubst` with: `brew install gettext`.

---

## Roadmap

| Phase | Status | Description |
|---|---|---|
| 1 | ✓ Done | Restructure existing setup into the two-directory layout |
| 2 | ✓ Done | Local MCP server with SQLite + FTS5 search |
| 3 | ✓ Done | Hooks: keyword topic preloading, session-end learnings capture, episodic memory |
| 4 | Pending | Vector layer (sqlite-vec embeddings for semantic search) |
| 5 | Pending | Cross-Claude bridge (claude.ai access via SSE) |
| 6 | Pending | Walter deploy (personal machine full sync) |
| 7 | Pending | Polish: scheduled curator, web UI, snapshots |
