#!/usr/bin/env bash
# unbox-agent.sh — Restore the agent persona from cold storage. Reverses box-agent.sh.
# Restores the persona files AND, if a suspended-hooks backup exists, merges the
# claude-os hook block back into ~/.claude/settings.json. Takes effect on the NEXT session.
#
# Identity-neutral by design: shared-genome code that runs on either machine (Willis / Walter).
# Auto-detects whether hooks were suspended — no flag needed to reverse a deep box.
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

# ── Restore suspended hooks, if any ───────────────────────────────────────────
# Merge ONLY the .hooks key back so any interim edits to settings.json are preserved.
SETTINGS="$HOME/.claude/settings.json"
HOOKS_BACKUP="$HOME/.claude/settings.hooks.boxed.json"

if [ -f "$HOOKS_BACKUP" ]; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "  HOOKS: WARN jq not found — cannot restore. Backup kept at $HOOKS_BACKUP"
  elif [ ! -f "$SETTINGS" ]; then
    echo "  HOOKS: WARN settings.json missing — cannot merge. Backup kept at $HOOKS_BACKUP"
  else
    tmp="${SETTINGS}.tmp.$$"
    if jq --slurpfile h "$HOOKS_BACKUP" '.hooks = $h[0]' "$SETTINGS" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
      mv "$tmp" "$SETTINGS"
      rm -f "$HOOKS_BACKUP"
      echo "  HOOKS: RESTORED — merged .hooks back into settings.json"
    else
      rm -f "$tmp"
      echo "  HOOKS: ERROR — jq merge failed; settings.json unchanged. Backup kept at $HOOKS_BACKUP"
    fi
  fi
else
  echo "  HOOKS: SKIP (no suspended-hooks backup — persona-only box or none)"
fi

echo
echo "== Done. Start a FRESH session — the persona (and hooks) return at session start. =="
