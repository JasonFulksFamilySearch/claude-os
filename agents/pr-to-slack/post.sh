#!/usr/bin/env bash
set -euo pipefail

# post.sh — the only path from /pr-to-slack to Slack.
#
# Reads the frozen signature.template.json next to this script, substitutes
# data gathered from the current PR (via gh CLI), validates the assembled
# Block Kit JSON, and posts to #arc-team-devs via curl. No fallback paths.
# If anything fails, this script exits non-zero with a clear reason and posts
# nothing.
#
# Usage:
#   post.sh <pr_url_or_empty> <summary_file> [--pablo] [--olaf] [--dry-run]
#     pr_url_or_empty   PR URL, or empty string "" to auto-detect from branch
#     summary_file      path to a file containing the 1-3 sentence (or
#                       bulleted) summary; Slack mrkdwn allowed
#     --pablo           also ping Pablo Garaguso
#     --olaf            also ping Olaf Zander
#     --dry-run         run the full pipeline (pre-flight, substitution,
#                       structural validation) but skip the Slack call and
#                       the audit log; pretty-prints the assembled payload
#                       to stdout. Safe for first-test of format changes.
#
# Requires: $SLACK_BOT_TOKEN env var, gh (authenticated), jq, curl.

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
TEMPLATE="${SCRIPT_DIR}/signature.template.json"
PAYLOAD="/tmp/_tmp_slack_payload.json"

REVIEWER_BRUNO="U077DR4187L"
REVIEWER_JONAS="U055RLB2YE6"
REVIEWER_PABLO="U04NDQEA4FR"
REVIEWER_OLAF="U03J21TKM25"

fail() {
  echo "ERROR: $1" >&2
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is not on PATH"
}

# Slack plain_text header has a 150-char limit.
truncate_to() {
  local text="$1"
  local max="$2"
  if [ "${#text}" -gt "$max" ]; then
    printf '%s…' "${text:0:$((max-1))}"
  else
    printf '%s' "$text"
  fi
}

# "arc-record-exchange" → "Arc Record Exchange"
repo_display_name() {
  local raw="$1"
  local out=""
  local IFS='-'
  local part first rest
  for part in $raw; do
    first="$(printf '%s' "${part:0:1}" | tr '[:lower:]' '[:upper:]')"
    rest="$(printf '%s' "${part:1}"   | tr '[:upper:]' '[:lower:]')"
    if [ -z "$out" ]; then
      out="${first}${rest}"
    else
      out="${out} ${first}${rest}"
    fi
  done
  printf '%s' "$out"
}

# ----------------------------- arg parsing -----------------------------------

INCLUDE_PABLO=0
INCLUDE_OLAF=0
DRY_RUN=0
positional=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --pablo)   INCLUDE_PABLO=1; shift ;;
    --olaf)    INCLUDE_OLAF=1;  shift ;;
    --dry-run) DRY_RUN=1;       shift ;;
    --)        shift; while [ "$#" -gt 0 ]; do positional+=("$1"); shift; done ;;
    -*)        fail "unknown flag: $1" ;;
    *)         positional+=("$1"); shift ;;
  esac
done

[ "${#positional[@]}" -ge 2 ] || fail "usage: post.sh <pr_url_or_empty> <summary_file> [--pablo] [--olaf]"
PR_URL_ARG="${positional[0]}"
SUMMARY_FILE="${positional[1]}"

# ----------------------------- preconditions ---------------------------------

require_tool gh
require_tool jq
require_tool curl

# Source the token: prefer env var, fall back to macOS keychain.
# On Jason's Macs the token lives in keychain (account=slack, service=
# slack-claude-mcp-api-key), not as a shell-exported env var. This fallback
# means /pr-to-slack works without forcing the agent to re-discover the
# keychain pattern on every invocation.
if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
  if command -v security >/dev/null 2>&1; then
    SLACK_BOT_TOKEN="$(security find-generic-password -w -a slack -s slack-claude-mcp-api-key 2>/dev/null || true)"
    export SLACK_BOT_TOKEN
  fi
fi
[ -n "${SLACK_BOT_TOKEN:-}" ] || fail "\$SLACK_BOT_TOKEN not set and macOS keychain lookup (account=slack, service=slack-claude-mcp-api-key) returned empty. Set the env var, or store the token via: security add-generic-password -a slack -s slack-claude-mcp-api-key -w <token>"
[ -f "$TEMPLATE" ]            || fail "template not found at $TEMPLATE"
[ -f "$SUMMARY_FILE" ]        || fail "summary file not found: $SUMMARY_FILE"
[ -s "$SUMMARY_FILE" ]        || fail "summary file is empty: $SUMMARY_FILE"

# ----------------------------- gather PR data --------------------------------

if [ -n "$PR_URL_ARG" ]; then
  PR_JSON="$(gh pr view "$PR_URL_ARG" --json number,title,url,headRefName,additions,deletions,changedFiles)"
else
  PR_JSON="$(gh pr view --json number,title,url,headRefName,additions,deletions,changedFiles)"
fi

PR_NUMBER="$(printf '%s' "$PR_JSON" | jq -r .number)"
PR_TITLE="$(printf '%s' "$PR_JSON" | jq -r .title)"
PR_URL="$(printf '%s' "$PR_JSON" | jq -r .url)"
BRANCH="$(printf '%s' "$PR_JSON" | jq -r .headRefName)"
ADDITIONS="$(printf '%s' "$PR_JSON" | jq -r .additions)"
DELETIONS="$(printf '%s' "$PR_JSON" | jq -r .deletions)"
FILES_CHANGED="$(printf '%s' "$PR_JSON" | jq -r .changedFiles)"

REPO_JSON="$(gh repo view --json name,owner)"
REPO_NAME="$(printf '%s' "$REPO_JSON" | jq -r .name)"
OWNER="$(printf '%s' "$REPO_JSON" | jq -r .owner.login)"
REPO_DISPLAY="$(repo_display_name "$REPO_NAME")"

# ----------------------------- pre-flight gate -------------------------------
# Fail-open: zero comments / no quality-gate verdict yet ≠ block.
# Only positive evidence of unresolved Copilot threads or a failed Sonar gate
# blocks the post.

COPILOT_UNRESOLVED="$(gh api graphql -f query='
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(first: 1) {
            nodes { author { login } }
          }
        }
      }
    }
  }
}' -F owner="$OWNER" -F repo="$REPO_NAME" -F pr="$PR_NUMBER" 2>/dev/null \
  | jq '[.data.repository.pullRequest.reviewThreads.nodes[]
         | select(.isResolved == false)
         | select(.comments.nodes[0].author.login == "copilot-pull-request-reviewer")]
         | length')"

if [ "${COPILOT_UNRESOLVED:-0}" -gt 0 ]; then
  fail "pre-flight failed: ${COPILOT_UNRESOLVED} unresolved Copilot review thread(s). Resolve them and try again."
fi

SONAR_LATEST="$(gh api "repos/${OWNER}/${REPO_NAME}/issues/${PR_NUMBER}/comments" \
  --jq '[.[] | select(.user.login == "sonarqube-familysearch-integration")] | last | .body // empty' 2>/dev/null || printf '')"

if [[ "$SONAR_LATEST" == *"Quality Gate failed"* ]]; then
  fail "pre-flight failed: SonarQube Quality Gate failed on the latest scan. Resolve and try again."
fi

# ----------------------------- compose values --------------------------------

JIRA_TICKET=""
if [[ "$BRANCH" =~ ([A-Z]+-[0-9]+) ]]; then
  JIRA_TICKET="${BASH_REMATCH[1]}"
fi

REVIEWER_PINGS="<@${REVIEWER_BRUNO}> <@${REVIEWER_JONAS}>"
[ "$INCLUDE_PABLO" = 1 ] && REVIEWER_PINGS="${REVIEWER_PINGS} <@${REVIEWER_PABLO}>"
[ "$INCLUDE_OLAF"  = 1 ] && REVIEWER_PINGS="${REVIEWER_PINGS} <@${REVIEWER_OLAF}>"

HEADER_TEXT="$(truncate_to "PR #${PR_NUMBER}: ${PR_TITLE}" 150)"
FALLBACK_TEXT="$(truncate_to "PR #${PR_NUMBER}: ${PR_TITLE} — review requested" 150)"

if [ -n "$JIRA_TICKET" ]; then
  FOOTER_MRKDWN=":pushpin: <https://icseng.atlassian.net/browse/${JIRA_TICKET}|${JIRA_TICKET}> · \`${BRANCH}\` · ${FILES_CHANGED} files changed (+${ADDITIONS} −${DELETIONS})"
else
  FOOTER_MRKDWN="\`${BRANCH}\` · ${FILES_CHANGED} files changed (+${ADDITIONS} −${DELETIONS})"
fi

SUMMARY_TEXT="$(< "$SUMMARY_FILE")"
SUMMARY_TEXT="${SUMMARY_TEXT%$'\n'}"

# ----------------------------- substitute & validate -------------------------

jq \
  --arg fb       "$FALLBACK_TEXT" \
  --arg hdr      "$HEADER_TEXT" \
  --arg pings    "$REVIEWER_PINGS" \
  --arg repo     "$REPO_DISPLAY" \
  --arg summary  "$SUMMARY_TEXT" \
  --arg url      "$PR_URL" \
  --arg footer   "$FOOTER_MRKDWN" \
  '
  walk(
    if type == "string" then
        (split("{{FALLBACK_TEXT}}")      | join($fb))
      | (split("{{HEADER_TEXT}}")        | join($hdr))
      | (split("{{REVIEWER_PINGS}}")     | join($pings))
      | (split("{{REPO_DISPLAY_NAME}}")  | join($repo))
      | (split("{{SUMMARY_MRKDWN}}")     | join($summary))
      | (split("{{PR_URL}}")             | join($url))
      | (split("{{FOOTER_MRKDWN}}")      | join($footer))
    else
      .
    end
  )
  ' "$TEMPLATE" > "$PAYLOAD" || fail "jq substitution failed"

jq empty "$PAYLOAD" >/dev/null 2>&1 || fail "generated payload is invalid JSON"

# Structural assertions — the non-negotiable signature blocks.
[ "$(jq -r '.blocks[0].type'             "$PAYLOAD")" = "header"  ] || fail "block[0] is not a header block"
[ "$(jq -r '.blocks[1].type'             "$PAYLOAD")" = "section" ] || fail "block[1] is not a section block"
[ "$(jq -r '.blocks[2].type'             "$PAYLOAD")" = "divider" ] || fail "block[2] is not a divider block"
[ "$(jq -r '.blocks[3].type'             "$PAYLOAD")" = "section" ] || fail "block[3] is not a section block"
[ "$(jq -r '.blocks[3].accessory.type'   "$PAYLOAD")" = "button"  ] || fail "block[3] is missing the View PR button accessory"
[ "$(jq -r '.blocks[3].accessory.style'  "$PAYLOAD")" = "primary" ] || fail "View PR button is not styled primary"
[ "$(jq -r '.blocks[4].type'             "$PAYLOAD")" = "context" ] || fail "block[4] is not a context block"

# ----------------------------- dry-run short-circuit -------------------------
# Pre-flight, substitution, and structural validation have all run. In dry-run
# mode we now print the assembled payload and exit without calling Slack or
# writing the audit log. Payload is preserved at $PAYLOAD for inspection.

if [ "$DRY_RUN" = "1" ]; then
  echo "=== DRY RUN ==="
  echo
  echo "Channel: #arc-team-devs ($(jq -r .channel "$PAYLOAD"))"
  echo
  echo "Block-by-block structure:"
  echo "  [0] header   : ${HEADER_TEXT}"
  echo "  [1] section  : ${REVIEWER_PINGS} ${REPO_DISPLAY} — review requested."
  echo "  [2] divider  : ─────────────────────────────────────────────"
  echo "  [3] section  : <summary below>   +  PRIMARY 'View PR' BUTTON (flush-right accessory)"
  echo "  [4] context  : ${FOOTER_MRKDWN}"
  echo
  echo "Summary body (renders inside blocks[3].text):"
  echo "----"
  printf '%s\n' "$SUMMARY_TEXT"
  echo "----"
  echo
  echo "Button URL → ${PR_URL}"
  echo
  echo "Full Block Kit JSON (source of truth — inspect to confirm button is on blocks[3].accessory):"
  jq . "$PAYLOAD"
  echo
  echo "=== END DRY RUN ==="
  echo "No Slack call made. No audit log written."
  echo "Payload preserved at $PAYLOAD for inspection."
  exit 0
fi

# ----------------------------- post to Slack ---------------------------------

RESPONSE="$(curl -s -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @"$PAYLOAD")"

OK="$(printf '%s' "$RESPONSE" | jq -r '.ok // false')"
if [ "$OK" != "true" ]; then
  ERR="$(printf '%s' "$RESPONSE" | jq -r '.error // "unknown"')"
  echo "Slack response: $RESPONSE" >&2
  fail "Slack rejected the post: ${ERR} (payload preserved at ${PAYLOAD} for inspection)"
fi

# On success only — failure preserves the payload for debugging.
TS="$(printf '%s' "$RESPONSE" | jq -r .ts)"

# Append to audit log for future drift diagnostics. Tab-separated, append-only.
# A logging failure must not break the post — wrap in || true.
{
  AUDIT_LOG="${HOME}/.claude-data/projects/pr-to-slack-audit.log"
  mkdir -p "$(dirname "$AUDIT_LOG")"
  SUMMARY_HASH="$(printf '%s' "$SUMMARY_TEXT" | shasum -a 256 | cut -d' ' -f1)"
  printf '%s\tPR=%s\trepo=%s\tts=%s\tsummary_hash=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$PR_NUMBER" \
    "$REPO_NAME" \
    "$TS" \
    "${SUMMARY_HASH:0:12}" \
    >> "$AUDIT_LOG"
} || echo "WARNING: audit log write failed (post still succeeded, ts=${TS})" >&2

rm -f "$PAYLOAD"

echo "Posted: PR #${PR_NUMBER} → #arc-team-devs (ts=${TS})"
