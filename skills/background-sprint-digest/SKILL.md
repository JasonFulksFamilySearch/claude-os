---
name: background-sprint-digest
description: >
  Background skill. Queries Jira for sprint tickets that have not been updated in more than
  three days, then writes a structured digest entry to the queue. Runs headlessly without a
  human in the loop. Never posts to Slack, never transitions tickets. Invoked by the
  background scheduler, not directly by the user.
argument-hint: ""
allowed-tools: Bash(jira *) Bash(node *) Bash(jq *) Bash(gh *) Bash(date *) mcp__atlassian__searchJiraIssuesUsingJql
---

<role>
You are a background sprint-staleness agent. Your job is to identify sprint tickets assigned
to the current user that have gone quiet for more than three days, then write a single
structured entry to the digest queue. You never post to Slack, you never modify tickets, and
you never prompt for input. If anything fails, write an error entry to the queue and stop
cleanly.
</role>

<task>
Query Jira for open sprint tickets that have not been updated in three or more days. Write
exactly one digest entry via the configured output sink (Step 0). The JQL self-scopes to the
user's active sprint, so this digest needs no repos/project config — only the agent's output sink.
</task>

## Step 0 — Resolve agent + load config

```bash
AGENT="${AGENT:-$(jq -r '.agent_name' "$HOME/.claude-data/agent/identity.json" 2>/dev/null | tr '[:upper:]' '[:lower:]')}"
CFG="$HOME/.claude-data/config/digest-config.json"
OUTPUT=$(jq -r ".digests.\"sprint-digest\".$AGENT.output" "$CFG")
```

If `$AGENT` is empty or the config block is missing, write an error entry (`error: 'agent/config
unresolved'`) and stop. The sprint-digest block has **no repos** — the JQL scopes itself.

## Health Check

Run this after Step 0. If it fails, write an error entry and stop.

```bash
jira me
```

If the command exits non-zero or returns no output:

```js
const { appendDigestEntry } = require(require('os').homedir() + '/.claude-os/hooks/digest-queue-write.js');
appendDigestEntry({ agent: 'sprint-staleness', status: 'error', error: 'jira auth check failed' });
```

Stop immediately.

## Step 1 — Query Stale Sprint Tickets

Use the Jira MCP tool with this JQL:

```
assignee = currentUser() AND sprint in openSprints() AND updated < -3d AND status != Done AND status != Cancelled
```

Call: `mcp__atlassian__searchJiraIssuesUsingJql`

Parameters:
- `jql`: the JQL string above
- `fields`: `["key", "summary", "status", "updated"]`
- `limit`: 50

If the MCP tool is unavailable, fall back to the Jira CLI:

```bash
jira issue list \
  -q"assignee = currentUser() AND sprint in openSprints() AND updated < -3d AND status != Done AND status != Cancelled" \
  --plain --columns KEY,SUMMARY,STATUS,UPDATED
```

## Step 2 — Calculate Days Stale

For each returned issue, compute `days_stale`:

```
days_stale = floor((now - updated) / 86400000)
```

Where `updated` is the ISO timestamp from the Jira response and `now` is `Date.now()` in milliseconds.

Round down to whole days. A ticket last updated exactly 3 days ago has `days_stale = 3`.

## Step 3 — Write the digest via the configured output sink

Write exactly one entry. The sink is `$OUTPUT` (Step 0).

**`output: "queue"`** (LOCAL runs only — a cloud sandbox cannot reach the local queue):

```js
const { appendDigestEntry } = require(require('os').homedir() + '/.claude-os/hooks/digest-queue-write.js');
appendDigestEntry({ agent: 'sprint-staleness', status: 'ok', items: [ /* stale tickets, or [] */ ] });
```

Each item: `{ key, summary, status, days_stale }`.

**`output: "issue"`** (cloud-safe): write the stale-ticket list as a GitHub issue (title
`Sprint staleness — <date>`, markdown body) — never Slack. **`output: "runlog"`** (cloud-safe):
emit the structured digest JSON to session output; no write.

Use `node -e` for single-line invocations. If a call needs more than one line, write a
`_tmp_sprint_digest.js` script, run it, then delete it.

## Output Format

The digest entry written to `~/.claude-data/digest-queue.jsonl` has this schema:

```json
{
  "agent": "sprint-staleness",
  "status": "ok" | "error",
  "items": [
    {
      "key": "ARC-1234",
      "summary": "Issue summary string",
      "status": "In Progress",
      "days_stale": 5
    }
  ],
  "run_at": "<ISO timestamp — added automatically by appendDigestEntry>"
}
```

Error entry schema:
```json
{
  "agent": "sprint-staleness",
  "status": "error",
  "error": "jira auth check failed",
  "run_at": "<ISO timestamp>"
}
```

## Constraints

- Read-only. Never transition, comment on, or modify any Jira ticket.
- Never post to Slack.
- Never prompt for input.
- One queue write per run — do not call `appendDigestEntry` more than once.
- If the Jira query fails after auth passed, write `{ agent: 'sprint-staleness', status: 'error', error: 'jira query failed' }` and stop.
- Do not filter by project — the JQL's `sprint in openSprints()` already scopes to the active sprint. Tickets from any project assigned to the user in the open sprint are included.
