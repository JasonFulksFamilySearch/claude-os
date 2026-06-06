#!/usr/bin/env bash
# rule-enforcement.sh — PreToolUse hook for claude-os
#
# This hook runs before every Bash/Edit/Write tool call. It:
#   1. Reads tool input from stdin (JSON)
#   2. Checks against rules defined in this file (and ~/.claude/rules/*.md eventually)
#   3. Logs the decision to ~/.claude/hooks-log.jsonl
#   4. Exits 0 to allow, exit 2 to block
#
# Safety:
#   - 200ms timeout (fail open)
#   - Loop guard via CLAUDE_OS_HOOK_DEPTH
#   - Logs both allows AND blocks (so /review-performance can see allowed-but-noisy patterns)
#
# Adding a new rule: see the RULES section below.

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
LOG_FILE="$CLAUDE_HOME/hooks-log.jsonl"
HOOK_TIMEOUT_SEC=0.2

# ─────────────────────────────────────────────────────────────────────
# Safety: loop guard
# ─────────────────────────────────────────────────────────────────────
if [ "${CLAUDE_OS_HOOK_DEPTH:-0}" -gt 1 ]; then
  # Re-entrant call — exit immediately to prevent infinite loops
  exit 0
fi
export CLAUDE_OS_HOOK_DEPTH=$((${CLAUDE_OS_HOOK_DEPTH:-0} + 1))

# ─────────────────────────────────────────────────────────────────────
# Read input (with timeout)
# ─────────────────────────────────────────────────────────────────────
# Some shells don't have `timeout` (BSD systems); use a portable trick
read_with_timeout() {
  local input=""
  if command -v timeout >/dev/null 2>&1; then
    input=$(timeout "$HOOK_TIMEOUT_SEC" cat 2>/dev/null || echo "")
  else
    # Fallback: just cat (no timeout)
    input=$(cat 2>/dev/null || echo "")
  fi
  echo "$input"
}

INPUT=$(read_with_timeout)
if [ -z "$INPUT" ]; then
  # No input or timed out — fail open
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────
# Dependency guard: jq is required to parse tool input below. If jq is
# missing, every field parses as empty, no rule matches, and the hook falls
# through to ALLOW — i.e. the identity write-guard (Rule 10) silently fails
# OPEN. That is the one failure mode we refuse to have. So when jq is absent
# we degrade deliberately: keep the identity invariant enforced via a jq-free
# check on the raw input, allow everything else (matching the pre-hook
# baseline for the hygiene rules), and leave a plain-text breadcrumb in the
# log so the degraded run is visible to /review-performance.
# ─────────────────────────────────────────────────────────────────────
if ! command -v jq >/dev/null 2>&1; then
  # Plain-text (jq-free) audit line so a degraded run is never silent.
  printf '%s jq-missing degraded-mode hook invocation\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)" \
    >> "$LOG_FILE" 2>/dev/null || true

  IDENTITY_LINK="$HOME/.claude/CLAUDE.md"
  IDENTITY_DATA="$HOME/.claude-data/agent/CLAUDE.md"
  # Match an Edit/Write whose file_path is exactly one of the two identity
  # path-forms. We match the "file_path":"<path>" TOKEN (not the bare path)
  # so a Write/Edit that merely mentions the path in its content/strings is
  # not falsely blocked. Limitation vs. the jq+realpath path: a relative or
  # alternately-symlinked path is not canonicalized here, so only the two
  # known literal forms are caught — acceptable for a rare degraded mode,
  # and it errs toward blocking (fail-closed) on the identity invariant.
  tn_re='"tool_name"[[:space:]]*:[[:space:]]*"(Edit|Write)"'
  if [[ "$INPUT" =~ $tn_re ]] \
     && { [[ "$INPUT" == *"\"file_path\":\"$IDENTITY_LINK\""* ]] \
          || [[ "$INPUT" == *"\"file_path\":\"$IDENTITY_DATA\""* ]]; }; then
    echo "Rule 10 (identity write-guard, jq-missing degraded mode): CLAUDE.md is frozen to Claude's Edit/Write tools — identity is human-owned. jq is not installed, so only the identity invariant is being enforced; install jq to restore the full rule engine." >&2
    exit 2
  fi

  # Not an identity write — allow, matching the no-hook baseline.
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────
# Parse hook input
# ─────────────────────────────────────────────────────────────────────
# Claude Code sends JSON like:
# {
#   "session_id": "abc",
#   "cwd": "/path/to/repo",
#   "hook_event_name": "PreToolUse",
#   "tool_name": "Bash",
#   "tool_input": {"command": "git commit -m '...'"}
# }
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null || echo "unknown")
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null || echo "unknown")
CWD=$(echo "$INPUT" | jq -r '.cwd // "unknown"' 2>/dev/null || echo "unknown")

# Extract the relevant input field per tool
case "$TOOL_NAME" in
  Bash)
    SUBJECT=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
    ;;
  Edit|Write)
    SUBJECT=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")
    ;;
  *)
    SUBJECT=""
    ;;
esac

START_TIME=$(date +%s%N 2>/dev/null || date +%s)

# ─────────────────────────────────────────────────────────────────────
# Helper: log decision and exit
# ─────────────────────────────────────────────────────────────────────
log_and_exit() {
  local decision="$1"   # ALLOWED or BLOCKED
  local rule="$2"       # rule identifier, e.g., "Rule 7"
  local reason="$3"     # human-readable reason
  local exit_code="$4"  # 0 = allow, 2 = block

  local end_time
  end_time=$(date +%s%N 2>/dev/null || date +%s)
  local duration_ms=0
  if [ ${#end_time} -gt 10 ]; then
    duration_ms=$(( (end_time - START_TIME) / 1000000 ))
  fi

  # Build log entry as JSON (one line)
  local timestamp
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  jq -nc \
    --arg ts "$timestamp" \
    --arg tool "$TOOL_NAME" \
    --arg cmd "$SUBJECT" \
    --arg decision "$decision" \
    --arg rule "$rule" \
    --arg reason "$reason" \
    --arg cwd "$CWD" \
    --arg session "$SESSION_ID" \
    --argjson duration "$duration_ms" \
    '{
      timestamp: $ts,
      tool: $tool,
      command: $cmd,
      decision: $decision,
      rule: $rule,
      reason: $reason,
      cwd: $cwd,
      session_id: $session,
      duration_ms: $duration
    }' >> "$LOG_FILE" 2>/dev/null || true

  if [ "$exit_code" -eq 2 ]; then
    # stderr message goes back to Claude
    echo "$reason" >&2
  fi

  exit "$exit_code"
}

# ─────────────────────────────────────────────────────────────────────
# ═══════════════════════════════════════════════════════════════════
#   RULES — Add new rules here.
# ═══════════════════════════════════════════════════════════════════
# Each rule: pattern check → log_and_exit on match.
# Bash command rules:
# ─────────────────────────────────────────────────────────────────────

if [ "$TOOL_NAME" = "Bash" ]; then

  # Rule 7: No ticket numbers in commit subjects.
  # Pattern matches: git commit -m "ARC-123: ..." or git commit -m 'JIRA-456 ...'
  if [[ "$SUBJECT" =~ git[[:space:]]+commit.*-m[[:space:]]+[\'\"]?[A-Z]+-[0-9]+ ]]; then
    log_and_exit "BLOCKED" "Rule 7" \
      "Rule 7: Commit subjects must not contain ticket numbers (ARC-123 style). Ticket numbers in code history create stale references when tickets move/rename. Use conventional commit prefix (feat:/fix:/chore:) and put ticket reference in commit body if needed. See ~/.claude/rules/commits.md for the full rationale." \
      2
  fi

  # Rule 8: No force push to main/master
  if [[ "$SUBJECT" =~ git[[:space:]]+push.*--force.*\b(main|master)\b ]] || \
     [[ "$SUBJECT" =~ git[[:space:]]+push.*\b(main|master)\b.*--force ]]; then
    log_and_exit "BLOCKED" "Rule 8" \
      "Rule 8: Force push to main/master is prohibited. Use a feature branch or worktree. See ~/.claude/rules/jira-workflow.md (worktree section)." \
      2
  fi

  # Rule 9: No direct rm -rf on home directory or root
  if [[ "$SUBJECT" =~ rm[[:space:]]+(-[a-zA-Z]*r[a-zA-Z]*[[:space:]]+|--recursive[[:space:]]+).*(\$HOME|\~|/$|/[[:space:]]) ]]; then
    log_and_exit "BLOCKED" "Rule 9" \
      "Rule 9: Refusing rm -rf on home directory or root. If this is intentional, run it manually outside Claude Code." \
      2
  fi

fi

# ─────────────────────────────────────────────────────────────────────
# Edit/Write rules:
# ─────────────────────────────────────────────────────────────────────

if [ "$TOOL_NAME" = "Edit" ] || [ "$TOOL_NAME" = "Write" ]; then

  # Rule 10 (B3 identity write-guard): the agent identity file is FROZEN to Claude's Edit/Write
  # tools — identity/capability separation ("freeze identity, evolve capability"). ~/.claude/CLAUDE.md
  # is a symlink to ~/.claude-data/agent/CLAUDE.md; block edits that reach EITHER path-form.
  # Canonicalize to the real path so a relative / symlinked / non-literal path cannot evade the guard.
  # Jason edits CLAUDE.md directly (outside Claude); this hook only ever fires on Claude's own tools.
  if [ -n "$SUBJECT" ]; then
    canon_path() {
      if command -v realpath >/dev/null 2>&1; then
        realpath "$1" 2>/dev/null || echo "$1"
      else
        echo "$1"
      fi
    }
    SUBJECT_REAL=$(canon_path "$SUBJECT")
    IDENTITY_REAL=$(canon_path "$HOME/.claude/CLAUDE.md")
    if [ "$SUBJECT_REAL" = "$IDENTITY_REAL" ] \
       || [ "$SUBJECT_REAL" = "$HOME/.claude-data/agent/CLAUDE.md" ] \
       || [ "$SUBJECT" = "$HOME/.claude/CLAUDE.md" ] \
       || [ "$SUBJECT" = "$HOME/.claude-data/agent/CLAUDE.md" ]; then
      log_and_exit "BLOCKED" "Rule 10" \
        "Rule 10 (identity write-guard): CLAUDE.md is frozen to Claude's Edit/Write tools — identity is human-owned. The memory layer and skills must never rewrite identity; Jason edits CLAUDE.md directly. Put operating-rules content in ~/.claude/rules/*.md, learnings in learnings.md, or context/*.md." \
        2
    fi
  fi

  # Rule 11: Refuse to write to .env files
  if [[ "$SUBJECT" =~ \.env(\..+)?$ ]]; then
    log_and_exit "BLOCKED" "Rule 11" \
      "Rule 11: Refusing to write to .env files (credentials must not be written by Claude). Edit manually." \
      2
  fi

fi

# ─────────────────────────────────────────────────────────────────────
# Default: allow + log
# ─────────────────────────────────────────────────────────────────────
log_and_exit "ALLOWED" "none" "no rule matched" 0
