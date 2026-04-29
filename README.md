# claude-os

Portable agent system for Jason's Claude Code setup. This repo contains the
*system* — code, conventions, skills, slash commands, templates. It does NOT
contain memories, project context, or any machine-specific data; that lives
in `~/.claude-data/` on each machine and is never committed.

## Two-machine model

- **Willis** — work Mac, FamilySearch context.
- **Walter** — personal Mac, side-project context.

Both run identical code from this repo. Each maintains its own `~/.claude-data/`.

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

**Prerequisites:** Node.js >= 20, Git, Claude Code CLI.

The repo **must** be cloned to `~/.claude-os` — agent identity and config files
reference that path directly.

```bash
git clone <repo-url> ~/.claude-os
~/.claude-os/install.sh
```

Restart Claude Code after the script completes. For a fresh machine, populate
`~/.claude-data/agent/CLAUDE.md` with the agent identity before first use.

**To update an existing install:** `~/.claude-os/update.sh` — pulls latest,
rebuilds the MCP server only if `mcp/` changed, and skips everything else.
Skills and commands go live immediately via symlink.

## Phases

- **Phase 1:** restructure existing setup into the two-directory layout (current)
- Phase 2: local MCP server with SQLite + FTS5 search
- Phase 3: hooks for keyword-driven topic preloading and session-end learnings capture
- Phase 4: vector layer (sqlite-vec)
- Phase 5: cross-Claude bridge (claude.ai access via SSE)
- Phase 6: Walter deploy (personal machine)
- Phase 7: polish — scheduled curator, web UI, snapshots
