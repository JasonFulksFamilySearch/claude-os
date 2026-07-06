#!/usr/bin/env bash
# unbox-agent.sh — Restore the agent persona from cold storage. Reverses box-agent.sh.
# Takes effect on the NEXT session.
#
# Identity-neutral by design: shared-genome code that runs on either machine (Willis / Walter).
set -euo pipefail

SUFFIX=".boxed"

TARGETS=(
  "$HOME/.claude/CLAUDE.md"
  "$HOME/.claude-data/agent/CLAUDE.md"
  "$HOME/.claude-data/agent/personality.md"
  "$HOME/.claude/rules/communication.md"
  "$HOME/.claude-data/agent/identity.json"
)

echo "== Restoring persona from ${SUFFIX} cold storage. =="
for f in "${TARGETS[@]}"; do
  src="${f}${SUFFIX}"
  if [ -e "$src" ] || [ -L "$src" ]; then
    if [ -e "$f" ] || [ -L "$f" ]; then
      echo "  SKIP (live file present, refusing to clobber): $f"
    else
      mv "$src" "$f"
      echo "  RESTORED: $src  ->  $f"
    fi
  else
    echo "  SKIP (no boxed copy): $src"
  fi
done

echo
echo "== Done. Start a FRESH session — the persona returns at session start. =="
