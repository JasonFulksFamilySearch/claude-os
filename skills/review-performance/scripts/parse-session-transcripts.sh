#!/usr/bin/env bash
# parse-session-transcripts.sh — Extracts Auto Memory entries from recent sessions
# Called by the /review-performance skill during analysis.
#
# Usage:
#   bash parse-session-transcripts.sh                    # last 24h, all projects
#   bash parse-session-transcripts.sh --hours 48
#   bash parse-session-transcripts.sh --project arc-record-exchange

set -euo pipefail

HOURS=24
PROJECT_FILTER=""
PROJECTS_DIR="${CLAUDE_HOME:-$HOME/.claude}/projects"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours) HOURS="$2"; shift 2 ;;
    --project) PROJECT_FILTER="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ ! -d "$PROJECTS_DIR" ]; then
  echo '{"error": "projects dir not found", "path": "'"$PROJECTS_DIR"'", "memories": [], "stats": {"total": 0}}'
  exit 0
fi

# Find memory files modified in the last $HOURS hours
# Portable: use find -mmin (BSD and GNU both support this)
MMIN=$((HOURS * 60))

FIND_PATH="$PROJECTS_DIR"
if [ -n "$PROJECT_FILTER" ]; then
  FIND_PATH="$PROJECTS_DIR/$PROJECT_FILTER"
  if [ ! -d "$FIND_PATH" ]; then
    echo '{"error": "project not found", "project": "'"$PROJECT_FILTER"'", "memories": []}'
    exit 0
  fi
fi

# Collect memory files into a JSON array
{
  echo '{'
  echo '  "hours_back": '"$HOURS"','
  echo '  "projects_dir": "'"$PROJECTS_DIR"'",'
  echo '  "memories": ['

  FIRST=1
  while IFS= read -r -d '' file; do
    # Determine project name from path
    rel_path="${file#$PROJECTS_DIR/}"
    project=$(echo "$rel_path" | cut -d/ -f1)
    filename=$(basename "$file")

    # Get modification time
    if stat -f "%Sm" -t "%Y-%m-%dT%H:%M:%SZ" "$file" >/dev/null 2>&1; then
      # macOS
      mtime=$(stat -f "%Sm" -t "%Y-%m-%dT%H:%M:%SZ" "$file")
    else
      # Linux
      mtime=$(stat -c "%y" "$file" | cut -d'.' -f1 | tr ' ' 'T')Z
    fi

    # Read content, escape for JSON
    content=$(jq -Rs . < "$file")

    if [ $FIRST -eq 0 ]; then
      echo ','
    fi
    FIRST=0

    cat <<EOF
    {
      "project": "$project",
      "file": "$rel_path",
      "modified": "$mtime",
      "content": $content
    }
EOF
  done < <(find "$FIND_PATH" -type f -name "*.md" -mmin "-$MMIN" -path "*/memory/*" -print0 2>/dev/null)

  echo ''
  echo '  ],'

  # Aggregate stats
  total=$(find "$FIND_PATH" -type f -name "*.md" -mmin "-$MMIN" -path "*/memory/*" 2>/dev/null | wc -l | tr -d ' ')
  projects=$(find "$FIND_PATH" -type f -name "*.md" -mmin "-$MMIN" -path "*/memory/*" 2>/dev/null | sed "s|$PROJECTS_DIR/||" | cut -d/ -f1 | sort -u | wc -l | tr -d ' ')

  echo '  "stats": {'
  echo '    "total_memory_files": '"$total"','
  echo '    "projects_with_activity": '"$projects"
  echo '  }'
  echo '}'
} | jq '.'
