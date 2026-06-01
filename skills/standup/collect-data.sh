#!/bin/bash
# collect-data.sh — Gathers git log and GitHub PR data across ARC repos
# Called by the standup skill. Outputs structured text for Claude to analyze.
#
# Usage: collect-data.sh <activity-date> <tz-offset>
#   activity-date: YYYY-MM-DD (the day whose work we're reporting on)
#   tz-offset:     e.g. -0600

set -euo pipefail

ACTIVITY_DATE="${1:?Usage: collect-data.sh <YYYY-MM-DD> <tz-offset>}"
TZ_OFFSET="${2:?Usage: collect-data.sh <YYYY-MM-DD> <tz-offset>}"

SINCE="${ACTIVITY_DATE}T00:00:00${TZ_OFFSET}"
UNTIL="${ACTIVITY_DATE}T23:59:59${TZ_OFFSET}"
# Load shared repo list and author regex — see shared-config/daily-metrics-contract.md
# Prefers the new canonical filename; falls back to legacy arc-repos.json for one
# release window (FR-11 / PER-206 rename migration).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEW_REPOS_JSON="${SCRIPT_DIR}/../../shared-config/perch-watched-repos.json"
LEGACY_REPOS_JSON="${SCRIPT_DIR}/../../shared-config/arc-repos.json"
if [[ -f "$NEW_REPOS_JSON" ]]; then
  REPOS_JSON="$NEW_REPOS_JSON"
elif [[ -f "$LEGACY_REPOS_JSON" ]]; then
  echo "deprecation: arc-repos.json detected — rename to perch-watched-repos.json" >&2
  REPOS_JSON="$LEGACY_REPOS_JSON"
else
  echo "ERROR: Missing ${NEW_REPOS_JSON} — see shared-config/daily-metrics-contract.md" >&2
  exit 1
fi

GIT_AUTHORS=$(jq -r '.authorRegex' "$REPOS_JSON")

REPO_NAMES=()
REPO_PATHS=()
while IFS=$'\t' read -r name path; do
  REPO_NAMES+=("$name")
  REPO_PATHS+=("$path")
done < <(jq -r '.repos[] | [.name, .path] | @tsv' "$REPOS_JSON")

collect_repo() {
  local name="$1"
  local path="$2"
  local output=""

  output+="### ${name}\n"

  if [[ ! -d "$path/.git" ]]; then
    output+="_Repo not found at ${path}_\n\n"
    echo -e "$output"
    return
  fi

  # Git log — surface ticket keys for the activity ranking. Most ARC-XXXX keys
  # are already in the subject (or a branch name inside merge subjects); the
  # Refs: trailer catches commits whose subject omits the key. Claude extracts
  # ARC-\d+ from both the subject and the trailer (union) to attribute commits.
  local commits
  commits=$(git -C "$path" log --all --author="$GIT_AUTHORS" \
    --since="$SINCE" --until="$UNTIL" \
    --format="%h %s (%an, %ar) | Refs: %(trailers:key=Refs,valueonly,separator=%x20)" 2>/dev/null) || true

  output+="**Git commits:**\n"
  if [[ -n "$commits" ]]; then
    output+="${commits}\n\n"
  else
    output+="_No commits_\n\n"
  fi

  # Merged PRs (authored by me)
  local merged_prs
  merged_prs=$(gh pr list --repo "$(git -C "$path" remote get-url origin 2>/dev/null | sed 's/.*github.com[:/]\(.*\)\.git/\1/' | sed 's/.*github.com[:/]\(.*\)/\1/')" \
    --author="@me" --state=merged \
    --search="merged:>=${ACTIVITY_DATE}" \
    --limit 20 \
    --json number,title,url,mergedAt,additions,deletions,headRefName 2>/dev/null) || true

  output+="**My merged PRs:**\n"
  if [[ -n "$merged_prs" && "$merged_prs" != "[]" ]]; then
    output+="${merged_prs}\n\n"
  else
    output+="_None_\n\n"
  fi

  # Open PRs (authored by me)
  local open_prs
  open_prs=$(gh pr list --repo "$(git -C "$path" remote get-url origin 2>/dev/null | sed 's/.*github.com[:/]\(.*\)\.git/\1/' | sed 's/.*github.com[:/]\(.*\)/\1/')" \
    --author="@me" --state=open \
    --limit 10 \
    --json number,title,url,createdAt,headRefName 2>/dev/null) || true

  output+="**My open PRs:**\n"
  if [[ -n "$open_prs" && "$open_prs" != "[]" ]]; then
    output+="${open_prs}\n\n"
  else
    output+="_None_\n\n"
  fi

  # PRs I reviewed
  local reviewed_prs
  reviewed_prs=$(gh pr list --repo "$(git -C "$path" remote get-url origin 2>/dev/null | sed 's/.*github.com[:/]\(.*\)\.git/\1/' | sed 's/.*github.com[:/]\(.*\)/\1/')" \
    --state=all \
    --search="reviewed-by:@me merged:>=${ACTIVITY_DATE}" \
    --limit 20 \
    --json number,title,url,author,headRefName 2>/dev/null) || true

  output+="**PRs I reviewed:**\n"
  if [[ -n "$reviewed_prs" && "$reviewed_prs" != "[]" ]]; then
    output+="${reviewed_prs}\n\n"
  else
    output+="_None_\n\n"
  fi

  echo -e "$output"
}

echo "# Git & GitHub Data — ${ACTIVITY_DATE}"
echo ""

# Run all repos in parallel, capture output
PIDS=()
TMPFILES=()

for i in "${!REPO_NAMES[@]}"; do
  tmpfile=$(mktemp)
  TMPFILES+=("$tmpfile")
  collect_repo "${REPO_NAMES[$i]}" "${REPO_PATHS[$i]}" > "$tmpfile" 2>&1 &
  PIDS+=($!)
done

# Wait and print in order
for i in "${!REPO_NAMES[@]}"; do
  wait "${PIDS[$i]}" 2>/dev/null || true
  cat "${TMPFILES[$i]}"
  rm -f "${TMPFILES[$i]}"
done
