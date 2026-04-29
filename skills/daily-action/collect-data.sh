#!/bin/bash
# collect-data.sh — Gathers git log, GitHub PR, review queue, and CI data across ARC repos
# Called by the daily-action agent. Outputs structured text for Claude to analyze.
#
# Usage: collect-data.sh <plan-date>
#   plan-date: YYYY-MM-DD (the date the action plan is being generated for)

set -euo pipefail

PLAN_DATE="${1:?Usage: collect-data.sh <YYYY-MM-DD>}"

# 3-day lookback window for broader context
SINCE_DATE=$(date -j -v-3d -f "%Y-%m-%d" "$PLAN_DATE" "+%Y-%m-%d" 2>/dev/null \
  || date -d "$PLAN_DATE - 3 days" "+%Y-%m-%d")
TZ_OFFSET=$(date +%z)
SINCE="${SINCE_DATE}T00:00:00${TZ_OFFSET}"

# Load shared ARC repo list and author regex — see shared-config/daily-metrics-contract.md
# Path is resolved relative to this script so it works both in production
# (~/.claude/skills/...) and in a worktree checkout.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOS_JSON="${SCRIPT_DIR}/../../shared-config/arc-repos.json"
if [[ ! -f "$REPOS_JSON" ]]; then
  echo "ERROR: Missing $REPOS_JSON — see shared-config/daily-metrics-contract.md" >&2
  exit 1
fi

GIT_AUTHORS=$(jq -r '.authorRegex' "$REPOS_JSON")

REPO_NAMES=()
REPO_PATHS=()
REPO_SLUGS=()
while IFS=$'\t' read -r name path slug; do
  REPO_NAMES+=("$name")
  REPO_PATHS+=("$path")
  REPO_SLUGS+=("$slug")
done < <(jq -r '.repos[] | [.name, .path, .slug] | @tsv' "$REPOS_JSON")

get_repo_slug() {
  local path="$1"
  local idx="$2"
  echo "${REPO_SLUGS[$idx]}"
}

collect_repo() {
  local name="$1"
  local path="$2"
  local idx="$3"
  local output=""
  local slug
  slug=$(get_repo_slug "$path" "$idx")

  output+="### ${name}\n"

  if [[ ! -d "$path/.git" ]]; then
    output+="_Repo not found at ${path}_\n\n"
    echo -e "$output"
    return
  fi

  # --- Git log (last 3 days) ---
  local commits
  commits=$(git -C "$path" log --all --author="$GIT_AUTHORS" \
    --since="$SINCE" \
    --format="%h %s (%an, %ar)" 2>/dev/null) || true

  output+="**Git commits (last 3 days):**\n"
  if [[ -n "$commits" ]]; then
    output+="${commits}\n\n"
  else
    output+="_No commits_\n\n"
  fi

  # --- My open PRs ---
  local open_prs
  open_prs=$(gh pr list --repo "$slug" \
    --author="@me" --state=open \
    --limit 10 \
    --json number,title,url,createdAt,isDraft 2>/dev/null) || true

  output+="**My open PRs:**\n"
  if [[ -n "$open_prs" && "$open_prs" != "[]" ]]; then
    output+="${open_prs}\n\n"
  else
    output+="_None_\n\n"
  fi

  # --- Recently merged PRs (mine, last 3 days) ---
  local merged_prs
  merged_prs=$(gh pr list --repo "$slug" \
    --author="@me" --state=merged \
    --search="merged:>=${SINCE_DATE}" \
    --limit 10 \
    --json number,title,url,mergedAt 2>/dev/null) || true

  output+="**My recently merged PRs:**\n"
  if [[ -n "$merged_prs" && "$merged_prs" != "[]" ]]; then
    output+="${merged_prs}\n\n"
  else
    output+="_None_\n\n"
  fi

  # --- CI status (latest run on main) ---
  local ci_status
  ci_status=$(gh run list --repo "$slug" \
    --branch main --limit 1 \
    --json status,conclusion,name,createdAt 2>/dev/null) || true

  output+="**CI status (main):**\n"
  if [[ -n "$ci_status" && "$ci_status" != "[]" ]]; then
    output+="${ci_status}\n\n"
  else
    output+="_Unable to fetch_\n\n"
  fi

  echo -e "$output"
}

echo "# Git & GitHub Data — ${PLAN_DATE}"
echo "Lookback window: ${SINCE_DATE} to ${PLAN_DATE}"
echo ""

# Run all repos in parallel, capture output
PIDS=()
TMPFILES=()

for i in "${!REPO_NAMES[@]}"; do
  tmpfile=$(mktemp)
  TMPFILES+=("$tmpfile")
  collect_repo "${REPO_NAMES[$i]}" "${REPO_PATHS[$i]}" "$i" > "$tmpfile" 2>&1 &
  PIDS+=($!)
done

# Wait and print in order
for i in "${!REPO_NAMES[@]}"; do
  wait "${PIDS[$i]}" 2>/dev/null || true
  cat "${TMPFILES[$i]}"
  rm -f "${TMPFILES[$i]}"
done
