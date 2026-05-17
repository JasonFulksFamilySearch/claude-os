#!/usr/bin/env bash
# parse-hook-logs.sh — Extracts the last 24h of hook log entries as structured JSON
# Called by the /review-performance skill during analysis.
#
# Usage:
#   bash parse-hook-logs.sh                    # last 24h
#   bash parse-hook-logs.sh --hours 48         # last 48h
#   bash parse-hook-logs.sh --rule "Rule 7"    # filter by rule

set -euo pipefail

HOURS=24
RULE_FILTER=""
LOG_FILE="${CLAUDE_HOME:-$HOME/.claude}/hooks-log.jsonl"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours) HOURS="$2"; shift 2 ;;
    --rule) RULE_FILTER="$2"; shift 2 ;;
    --file) LOG_FILE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ ! -f "$LOG_FILE" ]; then
  echo '{"error": "hook log not found", "path": "'"$LOG_FILE"'", "entries": [], "stats": {"total": 0, "blocked": 0, "allowed": 0}}'
  exit 0
fi

# Compute cutoff timestamp (portable across macOS and Linux)
if date -v -1d >/dev/null 2>&1; then
  # macOS / BSD date
  CUTOFF=$(date -u -v "-${HOURS}H" +%Y-%m-%dT%H:%M:%SZ)
else
  # GNU date (Linux)
  CUTOFF=$(date -u -d "${HOURS} hours ago" +%Y-%m-%dT%H:%M:%SZ)
fi

# Build jq filter
JQ_FILTER='select(.timestamp >= $cutoff)'
if [ -n "$RULE_FILTER" ]; then
  JQ_FILTER="$JQ_FILTER | select(.rule == \$rule)"
fi

# Output structured JSON: filtered entries plus summary stats
{
  echo '{'
  echo '  "cutoff": "'"$CUTOFF"'",'
  echo '  "hours_back": '"$HOURS"','
  echo '  "log_file": "'"$LOG_FILE"'",'

  # Entries array
  echo '  "entries":'
  jq -s --arg cutoff "$CUTOFF" --arg rule "$RULE_FILTER" \
    "[.[] | $JQ_FILTER]" "$LOG_FILE" 2>/dev/null || echo '[]'
  echo '  ,'

  # Stats
  echo '  "stats":'
  jq -s --arg cutoff "$CUTOFF" '
    [.[] | select(.timestamp >= $cutoff)] |
    {
      total: length,
      blocked: [.[] | select(.decision == "BLOCKED")] | length,
      allowed: [.[] | select(.decision == "ALLOWED")] | length,
      by_rule: (group_by(.rule // "none") | map({key: (.[0].rule // "none"), value: length}) | from_entries),
      by_tool: (group_by(.tool // "unknown") | map({key: (.[0].tool // "unknown"), value: length}) | from_entries),
      by_repo: (group_by(.cwd // "unknown") | map({key: (.[0].cwd // "unknown"), value: length}) | from_entries),
      repeated_blocks: (
        [.[] | select(.decision == "BLOCKED")] |
        group_by(.rule + "|" + (.command // "" | gsub("[A-Z]+-[0-9]+"; "XXX-NNN") | gsub("[ \t]+"; " "))) |
        map({pattern: (.[0].rule + ": " + (.[0].command // "")), count: length}) |
        map(select(.count >= 2)) |
        sort_by(-.count)
      )
    }
  ' "$LOG_FILE" 2>/dev/null || echo '{"total": 0}'

  echo '}'
} | jq '.'
