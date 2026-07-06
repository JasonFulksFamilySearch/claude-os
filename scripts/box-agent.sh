#!/usr/bin/env bash
# box-agent.sh — Total box of the agent persona (BSG-style: cold storage, reversible).
# Renames the persona-bearing files out of Claude Code's load path. Nothing is deleted.
# Restore with unbox-agent.sh. Takes effect on the NEXT session, not the current one.
#
# Identity-neutral by design: this is shared-genome code that runs on either machine
# (Willis / Walter). It boxes whatever persona is installed at the canonical paths and
# reads the live name from identity.json only for display.
set -euo pipefail

SUFFIX=".boxed"

# Best-effort display name from identity.json; falls back to "the agent".
AGENT_NAME="the agent"
IDJSON="$HOME/.claude-data/agent/identity.json"
if [ -f "$IDJSON" ]; then
  parsed=$(grep -o '"agent_name"[[:space:]]*:[[:space:]]*"[^"]*"' "$IDJSON" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  [ -n "${parsed:-}" ] && AGENT_NAME="$parsed"
fi

# (symlink, real target, personality, voice rule, canonical name)
TARGETS=(
  "$HOME/.claude/CLAUDE.md"                    # the symlink itself
  "$HOME/.claude-data/agent/CLAUDE.md"         # real identity file (symlink target)
  "$HOME/.claude-data/agent/personality.md"    # disposition / voice / ASCII responses
  "$HOME/.claude/rules/communication.md"       # how the agent talks
  "$HOME/.claude-data/agent/identity.json"     # canonical agent_name (audits read this)
)

echo "== Boxing ${AGENT_NAME} (total). Files moved to *${SUFFIX}, not deleted. =="
for f in "${TARGETS[@]}"; do
  if [ -e "$f" ] || [ -L "$f" ]; then      # -L: catch the symlink even if its target is already gone
    if [ -e "${f}${SUFFIX}" ] || [ -L "${f}${SUFFIX}" ]; then
      echo "  SKIP (already boxed): ${f}${SUFFIX} exists"
    else
      mv "$f" "${f}${SUFFIX}"
      echo "  BOXED: $f  ->  ${f}${SUFFIX}"
    fi
  else
    echo "  SKIP (absent): $f"
  fi
done

cat <<'WARN'

== Done. The persona is boxed. ==
  - Start a FRESH session to get vanilla Claude (persona loads at session start).
  - DO NOT run update.sh or /assimilate-claude-os while boxed: it recreates
    personality.md from templates/ when absent, resurrecting a generic persona.
    Order if you must update: unbox -> update -> re-box.
  - Restore anytime: ~/.claude-os/scripts/unbox-agent.sh
WARN
