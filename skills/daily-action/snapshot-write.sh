#!/bin/bash
# snapshot-write.sh — Atomic lock/merge/write/unlock for daily snapshot sidecar
#
# Usage:
#   snapshot-write.sh <plan-date> <owned-fields-json>
#
# <plan-date>:          YYYY-MM-DD
# <owned-fields-json>:  JSON object containing ONLY daily-action owned fields.
#                       The script merges these into the existing snapshot, leaving
#                       all other fields untouched.
#
# Exit codes:
#   0  Success
#   1  Lock acquisition timed out (held > 5 minutes → stale; > 2 seconds → busy)
#   2  jq not available
#   3  Bad arguments

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: snapshot-write.sh <YYYY-MM-DD> <owned-fields-json>" >&2
  exit 3
fi

PLAN_DATE="$1"
# Accept either a JSON string or a path to a JSON file
if [[ -f "$2" ]]; then
  OWNED_JSON=$(< "$2")
else
  OWNED_JSON="$2"
fi
DAY_OF_WEEK=$(date -j -f "%Y-%m-%d" "$PLAN_DATE" "+%A" 2>/dev/null \
  || date -d "$PLAN_DATE" "+%A")
UPDATED_AT=$(date +"%Y-%m-%dT%H:%M:%S%z")

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq not found" >&2; exit 2; }

SNAP_DIR="$HOME/.claude/snapshots/daily"
LOCK="$SNAP_DIR/.lock"
FINAL="$SNAP_DIR/${PLAN_DATE}.json"

mkdir -p "$SNAP_DIR"

# --- Acquire lock (mkdir is atomic on POSIX) ---
i=0
while ! mkdir "$LOCK" 2>/dev/null; do
  i=$((i + 1))

  # After ~2s of retries, check if the lock is stale (> 5 minutes old)
  if [ $i -gt 20 ]; then
    LOCK_AGE=$(stat -f "%m" "$LOCK" 2>/dev/null || echo "0")
    NOW_EPOCH=$(date +%s)
    AGE_SECS=$(( NOW_EPOCH - LOCK_AGE ))
    if [ "$AGE_SECS" -gt 300 ]; then
      # Stale lock — reap it and retry once
      rmdir "$LOCK" 2>/dev/null || true
      if mkdir "$LOCK" 2>/dev/null; then
        break
      fi
    fi
    echo "ERROR: snapshot lock held for ${AGE_SECS}s — giving up" >&2
    exit 1
  fi

  sleep 0.1
done

# Ensure lock is released on any exit
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# --- Read existing snapshot (or start empty) ---
if [ -f "$FINAL" ]; then
  EXISTING=$(< "$FINAL")
else
  EXISTING="{}"
fi

# --- Merge: owned fields + bookkeeping into existing object ---
MERGED=$(jq -n \
  --argjson existing "$EXISTING" \
  --argjson owned "$OWNED_JSON" \
  --arg date "$PLAN_DATE" \
  --arg dow "$DAY_OF_WEEK" \
  --arg updatedAt "$UPDATED_AT" \
  '
  $existing
  # bookkeeping
  | .schemaVersion = 1
  | .date = $date
  | .dayOfWeek = $dow
  | .updatedAt = $updatedAt
  # sources: append "daily-action" if not already present
  | .sources = ((.sources // []) | if index("daily-action") then . else . + ["daily-action"] end)
  # owned fields — deep-merge each top-level key from $owned
  | if $owned.plan        then .plan        = ((.plan        // {}) * $owned.plan)        else . end
  | if $owned.signals     then .signals     = ((.signals     // {}) * $owned.signals)     else . end
  | if $owned.jira        then .jira        = ((.jira        // {}) * $owned.jira)        else . end
  | if $owned.planDetails then .planDetails = ((.planDetails // {}) * $owned.planDetails) else . end
  # planItems — skill is authoritative for which keys are on the plan, but live
  # status from the agent must survive a re-plan. For each incoming item:
  #   - if jiraKey exists in current plan.items, keep status/statusHistory/addedAt/
  #     links/updatedAt; overwrite summary and priority from the new payload.
  #   - if not, stamp addedAt/updatedAt = $updatedAt, statusHistory = [{status, at}],
  #     status = incoming.status (default "active").
  # Keys absent from $owned.planItems are dropped — that is how items leave the plan.
  | if $owned.planItems then
      .plan = (.plan // {}) |
      .plan.items = (
        $owned.planItems | map(
          . as $new |
          ((($existing.plan // {}).items // []) | map(select(.jiraKey == $new.jiraKey)) | first) as $prev |
          if $prev != null then
            $prev + { summary: $new.summary, priority: $new.priority }
          else
            {
              jiraKey: $new.jiraKey,
              summary: $new.summary,
              priority: $new.priority,
              status: ($new.status // "active"),
              addedAt: $updatedAt,
              updatedAt: $updatedAt,
              statusHistory: [{ status: ($new.status // "active"), at: $updatedAt }]
            }
          end
        )
      )
    else . end
  # warnings: append any from $owned.warnings, never clear existing
  | if ($owned.warnings // [] | length) > 0
    then .warnings = ((.warnings // []) + $owned.warnings | unique)
    else .
    end
  ')

# --- Atomic write ---
TMP="${FINAL}.tmp"
printf '%s\n' "$MERGED" > "$TMP"
mv "$TMP" "$FINAL"

echo "OK: wrote $FINAL"
# trap will release lock on exit
