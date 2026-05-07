#!/bin/bash
# rebuild-clear.sh — Clears daily-action- and perch-owned fields from today's snapshot
#   and deletes today's plan markdown files, in preparation for a /daily-action --rebuild run.
#
# Usage:  rebuild-clear.sh <YYYY-MM-DD>
#
# Acquires the snapshot lock, archives the outgoing plan markdown, removes daily-action-
# owned and perch-owned fields from the snapshot (preserving only standup-owned fields),
# deletes plan markdown files, and removes the perch agent debug log for the date.
# Prints progress to stdout. On a no-op (no artifacts for the date), exits 0 with a
# NO-OP message so the caller can skip straight to generation.
#
# Exit codes:
#   0  Success (clear complete, or no-op — no artifacts existed)
#   1  Active lock held: a write is in progress
#   2  jq not available
#   3  Bad arguments (missing or malformed date)

set -euo pipefail

PLAN_DATE="${1:-}"
if [ -z "$PLAN_DATE" ]; then
  echo "ERROR: Missing argument. Usage: rebuild-clear.sh <YYYY-MM-DD>" >&2
  exit 3
fi
if ! echo "$PLAN_DATE" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
  echo "ERROR: Invalid date format '$PLAN_DATE'. Expected YYYY-MM-DD." >&2
  exit 3
fi

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq not found" >&2; exit 2; }

SNAP_DIR="$HOME/.claude/snapshots/daily"
LOCK="$SNAP_DIR/.lock"
SNAP_FILE="$SNAP_DIR/${PLAN_DATE}.json"
WORKDAY_DIR="$HOME/Documents/WorkDay/DailyActionPlan"
PLAN_MD="${WORKDAY_DIR}/action-plan-${PLAN_DATE}.md"
SKILLS_PLAN="$HOME/.claude/skills/daily-action/plans/${PLAN_DATE}.md"
PERCH_DEBUG_LOG="$HOME/.claude/snapshots/agent-debug/${PLAN_DATE}.jsonl"

mkdir -p "$SNAP_DIR"

# ── Pre-acquire stale lock check ────────────────────────────────────────────────
# Detect stale locks before trying to acquire so we can warn + remove first.
if [ -d "$LOCK" ]; then
  LOCK_MTIME=$(stat -f "%m" "$LOCK" 2>/dev/null || stat -c "%Y" "$LOCK" 2>/dev/null || echo "0")
  NOW_EPOCH=$(date +%s)
  LOCK_AGE=$(( NOW_EPOCH - LOCK_MTIME ))
  if [ "$LOCK_AGE" -lt 300 ]; then
    echo "ERROR: A daily-action write is in progress. Wait and retry." >&2
    exit 1
  else
    echo "WARNING: Stale lock found (${LOCK_AGE}s old) — removing and proceeding."
    rmdir "$LOCK" 2>/dev/null || true
  fi
fi

# ── Acquire lock (mkdir is atomic on POSIX) ─────────────────────────────────────
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "ERROR: A daily-action write is in progress. Wait and retry." >&2
  exit 1
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# ── No-op check: if nothing exists for this date, exit cleanly ─────────────────
HAS_SNAP=false
HAS_PLAN=false
HAS_SKILL_PLAN=false
HAS_DEBUG_LOG=false
[ -f "$SNAP_FILE" ]      && HAS_SNAP=true
[ -f "$PLAN_MD" ]        && HAS_PLAN=true
[ -f "$SKILLS_PLAN" ]    && HAS_SKILL_PLAN=true
[ -f "$PERCH_DEBUG_LOG" ] && HAS_DEBUG_LOG=true

if ! $HAS_SNAP && ! $HAS_PLAN && ! $HAS_SKILL_PLAN && ! $HAS_DEBUG_LOG; then
  echo "NO-OP: No daily-action or perch artifacts found for ${PLAN_DATE} — skipping clear."
  exit 0
fi

# ── Archive outgoing plan markdown ─────────────────────────────────────────────
ARCHIVE_SUFFIX=$(date "+%H%M%S")
if $HAS_PLAN; then
  ARCHIVE_FILE="${WORKDAY_DIR}/action-plan-${PLAN_DATE}.pre-rebuild-${ARCHIVE_SUFFIX}.md"
  cp "$PLAN_MD" "$ARCHIVE_FILE"
  echo "Archived: $ARCHIVE_FILE"
fi

# ── Clear daily-action-owned snapshot fields ────────────────────────────────────
# Removes fields owned by /daily-action per daily-metrics-contract.md §4.
# Preserves standup-owned fields (activity.*, jira.transitionsToday,
# jira.commentsLeft, jira.sprintCompletedToday, plan.itemsCompleted,
# plan.completionRate, plan.carryoverFromPrev).
# Perch fields are also cleared (AC-4 updated): quality.*, plan.adhocItems.
if $HAS_SNAP; then
  UPDATED_AT=$(date +"%Y-%m-%dT%H:%M:%S%z")
  jq --arg ua "$UPDATED_AT" '
    del(.plan.itemsPlanned, .plan.priorityStackSize, .plan.items)
    | del(.signals)
    | del(
        .jira.sprintAssignedTotal,
        .jira.sprintAssignedNotDone,
        .jira.downloadIssuesOpen,
        .jira.unassignedDefectsOpen
      )
    | del(.planDetails)
    | del(.planItems)
    | del(.plan.adhocItems)
    | del(.quality)
    | .sources = ([.sources[]? | select(. != "daily-action" and . != "perch" and . != "perch-agent")])
    | .updatedAt = $ua
  ' "$SNAP_FILE" > "${SNAP_FILE}.tmp"
  mv "${SNAP_FILE}.tmp" "$SNAP_FILE"
  echo "Cleared: $SNAP_FILE"
fi

# ── Delete plan markdown files ──────────────────────────────────────────────────
if $HAS_PLAN; then
  rm "$PLAN_MD"
  echo "Removed: $PLAN_MD"
fi

if $HAS_SKILL_PLAN; then
  rm "$SKILLS_PLAN"
  echo "Removed: $SKILLS_PLAN"
fi

# ── FR-9: Delete perch-agent debug log for today (date-keyed external artifact) ─
if [ -f "$PERCH_DEBUG_LOG" ]; then
  rm "$PERCH_DEBUG_LOG"
  echo "Removed: $PERCH_DEBUG_LOG"
fi

echo "OK: Clear complete for ${PLAN_DATE}"
