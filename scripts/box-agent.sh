#!/usr/bin/env bash
# box-agent.sh — Total box of the agent persona (BSG-style: cold storage, reversible).
# Renames the persona-bearing files out of Claude Code's load path AND (deep box, the
# default) suspends the claude-os hook block in ~/.claude/settings.json. Nothing is
# deleted. Restore with unbox-agent.sh. Takes effect on the NEXT session.
#
# Identity-neutral by design: this is shared-genome code that runs on either machine
# (Willis / Walter). It boxes whatever persona is installed at the canonical paths and
# reads the live name from identity.json only for display.
#
#   box-agent.sh                 deep box: persona files + claude-os hooks (default)
#   box-agent.sh --persona-only  persona files only; leave hooks (and their safety
#                                guards) live
set -euo pipefail

SUFFIX=".boxed"
PERSONA_ONLY=0
for a in "$@"; do
  case "$a" in
    --persona-only) PERSONA_ONLY=1 ;;
    --help|-h) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown arg: $a (see --help)"; exit 2 ;;
  esac
done

# Best-effort display name from identity.json; falls back to "the agent".
AGENT_NAME="the agent"
IDJSON="$HOME/.claude-data/agent/identity.json"
if [ -f "$IDJSON" ]; then
  parsed=$(grep -o '"agent_name"[[:space:]]*:[[:space:]]*"[^"]*"' "$IDJSON" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  [ -n "${parsed:-}" ] && AGENT_NAME="$parsed"
fi

# ── Persona files (symlink, real target, personality, voice rule, canonical name) ──
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

# ── Deep box: suspend the claude-os hook block ────────────────────────────────
# Extract ONLY the .hooks key to a sidecar backup, then strip it from settings.json.
# We touch nothing else, so permission/env edits made while boxed survive unbox.
SETTINGS="$HOME/.claude/settings.json"
HOOKS_BACKUP="$HOME/.claude/settings.hooks.boxed.json"

if [ "$PERSONA_ONLY" -eq 1 ]; then
  echo "  HOOKS: --persona-only — leaving settings.json hooks (and safety guards) live."
elif ! command -v jq >/dev/null 2>&1; then
  echo "  HOOKS: WARN jq not found — hooks NOT suspended; persona box applied only."
elif [ -f "$HOOKS_BACKUP" ]; then
  echo "  HOOKS: SKIP (already suspended) — $HOOKS_BACKUP exists"
elif [ ! -f "$SETTINGS" ]; then
  echo "  HOOKS: SKIP (no settings.json)"
elif [ "$(jq 'has("hooks")' "$SETTINGS" 2>/dev/null)" != "true" ]; then
  echo "  HOOKS: SKIP (settings.json has no hooks block)"
else
  tmp="${SETTINGS}.tmp.$$"
  if jq '.hooks' "$SETTINGS" > "$HOOKS_BACKUP" 2>/dev/null && [ -s "$HOOKS_BACKUP" ] \
     && jq 'del(.hooks)' "$SETTINGS" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    mv "$tmp" "$SETTINGS"
    echo "  HOOKS: SUSPENDED -> $HOOKS_BACKUP (removed .hooks from settings.json)"
  else
    rm -f "$tmp" "$HOOKS_BACKUP"
    echo "  HOOKS: ERROR — jq failed; settings.json left unchanged."
  fi
fi

cat <<'WARN'

== Done. The persona is boxed. ==
  - Start a FRESH session to get vanilla Claude (persona + hooks load at session start).
  - DEEP BOX SAFETY: with hooks suspended, the rule-enforcement guards are OFF while
    boxed — no rm -rf home guard, no .env write guard, no commit ticket-ref guard.
    The boxed vanilla session runs without those rails. (Use --persona-only to keep them.)
  - DO NOT run update.sh or /assimilate-claude-os while boxed: it recreates
    personality.md from templates/ when absent, resurrecting a generic persona,
    and re-installs hooks. Order if you must update: unbox -> update -> re-box.
  - Restore anytime: ~/.claude-os/scripts/unbox-agent.sh
WARN
