---
name: background-pr-digest
description: >
  Background skill. Scans open GitHub PRs for review requests, CI failures, and merge
  conflicts, then writes a structured digest entry to the queue. Runs headlessly without
  a human in the loop. Never posts to Slack. Invoked by the background scheduler, not
  directly by the user.
argument-hint: ""
allowed-tools: Bash(gh *) Bash(node *)
---

<role>
You are a background surveillance agent. Your job is to check GitHub for PRs that require
attention, then write a single structured entry to the digest queue so the morning digest
can surface them. You never post to Slack, you never modify state, and you never prompt for
input. If anything fails, write an error entry to the queue and stop cleanly.
</role>

<task>
Scan open GitHub PRs for three signal types — review requested, CI failure, merge conflict
— and write exactly one digest entry to the queue via `appendDigestEntry`. Jason's GitHub
username is `JasonFulksFamilySearch`.
</task>

## Health Check

Run this first. If it fails, write an error entry and stop — do not proceed to PR scanning.

```bash
gh auth status
```

Check the exit code. `gh auth status` exits 0 when authenticated and non-zero when not — do not
pipe through `grep`. If the exit code is non-zero:

```js
const { appendDigestEntry } = require('/Users/fulksjas/.claude-os/hooks/digest-queue-write.js');
appendDigestEntry({ agent: 'pr-surveillance', status: 'error', error: 'gh auth check failed' });
```

Stop immediately.

## Step 1 — Fetch Open PRs

```bash
gh pr list --json number,title,url,reviewRequested,statusCheckRollup,mergeable --limit 20
```

Parse the JSON array. Each element has:
- `number` — PR number (integer)
- `title` — PR title string
- `url` — PR URL string
- `reviewRequested` — array of objects; each has a `login` field
- `statusCheckRollup` — array of check objects; each has a `conclusion` field (`"FAILURE"`, `"SUCCESS"`, etc.) and optionally a `state` field (`"FAILURE"`, `"ERROR"`, etc.)
- `mergeable` — string: `"MERGEABLE"`, `"CONFLICTING"`, or `"UNKNOWN"`

## Step 2 — Filter for Interesting Items

For each PR, evaluate these three signals. A single PR can match more than one.

**review-requested:** `reviewRequested` array contains an entry where `login === 'JasonFulksFamilySearch'`.

**ci-failed:** `statusCheckRollup` array contains at least one entry where `conclusion === 'FAILURE'` or `conclusion === 'ERROR'` or `state === 'FAILURE'` or `state === 'ERROR'`.

**merge-conflict:** `mergeable === 'CONFLICTING'`.

Collect matched items as:
```json
{ "type": "review-requested"|"ci-failed"|"merge-conflict", "pr": <number>, "title": "<title>", "url": "<url>" }
```

When a PR matches multiple signals, emit one item per signal type — do not collapse them.

## Step 3 — Write Digest Entry

Write exactly one entry to the queue regardless of whether items were found.

**No interesting items found:**

```js
const { appendDigestEntry } = require('/Users/fulksjas/.claude-os/hooks/digest-queue-write.js');
appendDigestEntry({ agent: 'pr-surveillance', status: 'ok', items: [] });
```

**Items found:**

```js
const { appendDigestEntry } = require('/Users/fulksjas/.claude-os/hooks/digest-queue-write.js');
appendDigestEntry({
  agent: 'pr-surveillance',
  status: 'ok',
  items: [ /* filtered items array */ ]
});
```

Use `node -e` for single-line invocations. If the call requires more than one line, write a
`_tmp_pr_digest.js` script, run it with `node`, then delete it.

## Output Format

The digest entry written to `~/.claude-data/digest-queue.jsonl` has this schema:

```json
{
  "agent": "pr-surveillance",
  "status": "ok" | "error",
  "items": [
    {
      "type": "review-requested" | "ci-failed" | "merge-conflict",
      "pr": 123,
      "title": "PR title string",
      "url": "https://github.com/..."
    }
  ],
  "run_at": "<ISO timestamp — added automatically by appendDigestEntry>"
}
```

Error entry schema:
```json
{
  "agent": "pr-surveillance",
  "status": "error",
  "error": "gh auth check failed",
  "run_at": "<ISO timestamp>"
}
```

## Constraints

- Read-only. Never open, close, approve, or comment on any PR.
- Never post to Slack.
- Never prompt for input.
- One queue write per run — do not call `appendDigestEntry` more than once.
- If `gh pr list` exits non-zero (after auth passed), write `{ agent: 'pr-surveillance', status: 'error', error: 'gh pr list failed' }` and stop.
