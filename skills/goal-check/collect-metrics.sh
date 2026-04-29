#!/bin/bash
# collect-metrics.sh — Gathers commit quality metrics across ARC repos
# Called by the goal-check agent. Outputs structured text for Claude to analyze.
# Usage: collect-metrics.sh <since-date> <until-date>
#   Dates in YYYY-MM-DD format.

SINCE_DATE="$1"
UNTIL_DATE="$2"

if [ -z "$SINCE_DATE" ] || [ -z "$UNTIL_DATE" ]; then
  echo "Usage: collect-metrics.sh <since-date> <until-date>"
  echo "  Dates in YYYY-MM-DD format."
  exit 1
fi

REPO_NAMES=(
  "Record Exchange"
  "Orchestration Service"
  "Global Status Service"
  "Delivery Spec Service"
)
REPO_PATHS=(
  "/Users/fulksjas/dev/Record_Exchange/arc-record-exchange"
  "/Users/fulksjas/dev/OrchestrationService/arc-record-exchange-orch-service"
  "/Users/fulksjas/dev/GlobalStatusService/arc-record-exchange-global-status-service"
  "/Users/fulksjas/dev/Delivery_Specification_Service/arc-delivery-specification-service"
)

AUTHOR="fulksjas"

collect_repo_metrics() {
  local repo_name="$1"
  local repo_path="$2"

  if [ ! -d "$repo_path" ]; then
    echo "=== $repo_name ==="
    echo "STATUS: SKIPPED (directory not found: $repo_path)"
    echo ""
    return
  fi

  echo "=== $repo_name ==="
  echo "PATH: $repo_path"
  echo ""

  # All commits in range
  echo "--- ALL COMMITS ---"
  git -C "$repo_path" log --all --author="$AUTHOR" \
    --since="$SINCE_DATE" --until="$UNTIL_DATE" \
    --oneline --no-merges 2>/dev/null
  echo "--- END ALL COMMITS ---"
  echo ""

  # Fix commits only
  echo "--- FIX COMMITS ---"
  git -C "$repo_path" log --all --author="$AUTHOR" \
    --since="$SINCE_DATE" --until="$UNTIL_DATE" \
    --oneline --no-merges --grep="^Fix" 2>/dev/null
  echo "--- END FIX COMMITS ---"
  echo ""

  # Reactive cleanup commits (SonarQube, lint, prettier, checkstyle, Copilot, unused)
  echo "--- REACTIVE CLEANUP COMMITS ---"
  git -C "$repo_path" log --all --author="$AUTHOR" \
    --since="$SINCE_DATE" --until="$UNTIL_DATE" \
    --oneline --no-merges \
    --grep="SonarQube\|sonar\|[Ll]int\|[Pp]rettier\|[Cc]heckstyle\|Copilot\|unused import\|unused variable\|[Rr]emove unused" 2>/dev/null
  echo "--- END REACTIVE CLEANUP COMMITS ---"
  echo ""

  # Revert commits
  echo "--- REVERT COMMITS ---"
  git -C "$repo_path" log --all --author="$AUTHOR" \
    --since="$SINCE_DATE" --until="$UNTIL_DATE" \
    --oneline --no-merges --grep="^Revert" 2>/dev/null
  echo "--- END REVERT COMMITS ---"
  echo ""

  # Commits grouped by ticket for per-branch analysis
  # Format: hash subject (so agent can extract ARC-#### and commit tag)
  echo "--- COMMITS BY TICKET ---"
  git -C "$repo_path" log --all --author="$AUTHOR" \
    --since="$SINCE_DATE" --until="$UNTIL_DATE" \
    --format="%h %s" --no-merges 2>/dev/null
  echo "--- END COMMITS BY TICKET ---"
  echo ""
}

# Run all repos in parallel, capture output in temp files
TMPDIR=$(mktemp -d)
for i in "${!REPO_NAMES[@]}"; do
  collect_repo_metrics "${REPO_NAMES[$i]}" "${REPO_PATHS[$i]}" > "$TMPDIR/repo_$i.txt" 2>&1 &
done
wait

# Output all results in order
echo "╔══════════════════════════════════════════════════════╗"
echo "║  COMMIT QUALITY METRICS: $SINCE_DATE to $UNTIL_DATE  ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

for i in "${!REPO_NAMES[@]}"; do
  cat "$TMPDIR/repo_$i.txt"
  echo ""
done

# Cleanup
rm -rf "$TMPDIR"
