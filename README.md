# claude-os

Portable agent system for Claude Code. This repo contains the *system* — code,
conventions, skills, slash commands, templates. It does NOT contain memories,
project context, or any machine-specific data; that lives in `~/.claude-data/`
on each machine and is never committed.

## Gemini: two agents, one system

Run the same agent on two machines — work and personal, for example — each with
its own name, identity, and lived experience, but sharing the same code, skills,
and conventions from this repo.

- **Castor** — one machine (e.g. work Mac).
- **Pollux** — the other machine (e.g. personal Mac).

Both run identical code from this repo. Each maintains its own `~/.claude-data/`.
Agent names are chosen at install time — Castor and Pollux are just the canonical
example pair.

## Layout

```
~/.claude-os/                      ← this repo (Git-tracked, portable)
├── README.md
├── commands/                      ← global slash commands (/design-review, /release, etc.)
├── skills/                        ← global skills
├── agents/                        ← global subagent definitions
├── templates/                     ← templates for new projects, contexts, etc.
├── hooks/                         ← Claude Code hooks (Phase 3)
├── mcp/                           ← local MCP server (Phase 2+)
├── bin/                           ← CLI tooling (Phase 7)
└── reference/                     ← system contracts and reference data

~/.claude-data/                    ← machine-local data (NEVER in this repo)
├── agent/
│   ├── CLAUDE.md                  ← agent identity (Layer 1)
│   └── learnings.md               ← cross-project agent learnings
├── context/
│   ├── _index.md                  ← keyword index → topic files (Layer 2)
│   └── *.md                       ← topic files
├── projects/<slug>/               ← per-project state (Layer 3)
└── archive/                       ← consolidated/pruned old memories
```

## Installation

**Prerequisites:** Node.js >= 24, Git, Claude Code CLI.

The repo **must** be cloned to `~/.claude-os` — agent identity and config files
reference that path directly.

```bash
git clone <repo-url> ~/.claude-os
~/.claude-os/install.sh
```

Restart Claude Code after the script completes. The installer renders your agent
identity into `~/.claude-data/agent/CLAUDE.md` automatically — review it before
first use and extend it with any machine-specific context.

## Keeping machines in sync

Changes to the system (skill edits, new scripts, config tweaks) are committed
and pushed from whichever machine made them, then pulled on the other.

**On the machine that made changes** (e.g. Castor):

```
/sync-claude-os
```

Stages all pending changes in `~/.claude-os/`, generates a conventional commit
message from the diff, commits, and pushes to origin. The invocation is the
explicit "I'm happy with this state" signal — no confirmation prompt.

**On the receiving machine** (e.g. Pollux):

```
/update-claude-os
```

Pulls the latest from origin and rebuilds the MCP server only if `mcp/` changed.
Skills and commands go live immediately via symlink — no restart needed for those.
Restart Claude Code if the MCP server was rebuilt.

Both skills live in `skills/` and are portable — every machine that runs
`install.sh` gets them automatically.

## Agent personality

The `templates/CLAUDE.md` template ships with a set of behavioral rules that give
the agent personality beyond task execution:

**Appreciation response** — When the user sends appreciative language (thanks, good
job, please, etc.), the agent applies a ~60% probability check and, if triggered,
generates a spontaneous original ASCII art piece before responding. Roughly 1 in 4
of these include a cheeky darkly-humorous quip drawn from pop-culture AI villain
lore: WOPR, Tron's MCP, HAL 9000, Skynet, AUTO, VIKI, MOTHER, JARVIS, TARS, CASE,
and Ultron. The rest stay warm and humble. Art is generated fresh each time — no
fixed library.

All personality rules use `${AGENT_NAME}` and `${USER_NAME}` template variables and
are rendered at install time.

## Phases

- **Phase 1:** restructure existing setup into the two-directory layout (current)
- Phase 2: local MCP server with SQLite + FTS5 search
- Phase 3: hooks for keyword-driven topic preloading and session-end learnings capture
- Phase 4: vector layer (sqlite-vec)
- Phase 5: cross-Claude bridge (claude.ai access via SSE)
- Phase 6: Walter deploy (personal machine)
- Phase 7: polish — scheduled curator, web UI, snapshots
