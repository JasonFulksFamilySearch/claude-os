---
name: background-pr-digest
description: >
  Background skill. Scans open GitHub PRs for review requests, CI failures, and merge
  conflicts, then writes a structured digest entry to the queue. Runs headlessly without
  a human in the loop. Never posts to Slack. Invoked by the background scheduler, not
  directly by the user.
argument-hint: ""
allowed-tools: Bash(gh *) Bash(node *) Bash(jq *) Bash(date *)
---

<role>
You are a background surveillance agent. Your job is to check GitHub for PRs that require
attention, then write a single structured entry to the digest queue so the morning digest
can surface them. You never post to Slack, you never modify state, and you never prompt for
input. If anything fails, write an error entry to the queue and stop cleanly.
</role>

<task>
Scan open GitHub PRs for three signal types — review requested, CI failure, merge conflict
— and write exactly one digest entry via the configured output sink. The agent, the repos to
scan, and the output sink all come from this agent's block in the per-agent config (Step 0).
</task>

## Step 0 — Resolve agent + load config

Read this agent's config before anything else. Two values drive the run: which repos to scan
and where the digest goes.

**Agent name** — prefer an injected `AGENT` (a cloud routine passes `AGENT=walter|willis` in its
prompt). Otherwise derive it locally from the identity file, lowercased:

```bash
AGENT="${AGENT:-$(jq -r '.agent_name' "$HOME/.claude-data/agent/identity.json" 2>/dev/null | tr '[:upper:]' '[:lower:]')}"
```

**Config block** — read `~/.claude-data/config/digest-config.json`, select `digests."pr-digest".<agent>`:

```bash
CFG="$HOME/.claude-data/config/digest-config.json"
GH_USER=$(jq -r '.github_user' "$CFG")
REPOS=$(jq -r ".digests.\"pr-digest\".$AGENT.repos[]" "$CFG")
OUTPUT=$(jq -r ".digests.\"pr-digest\".$AGENT.output" "$CFG")
```

If `$AGENT` is empty or the config block is missing, write an error entry (`error: 'agent/config
unresolved'`) and stop. `GH_USER` replaces the previously-hardcoded review-request login.

## Health Check

Run this after Step 0. If it fails, write an error entry and stop — do not proceed to PR scanning.

```bash
gh auth status
```

Check the exit code. `gh auth status` exits 0 when authenticated and non-zero when not — do not
pipe through `grep`. If the exit code is non-zero:

```js
const { appendDigestEntry } = require(require('os').homedir() + '/.claude-os/hooks/digest-queue-write.js');
appendDigestEntry({ agent: 'pr-surveillance', status: 'error', error: 'gh auth check failed' });
```

Stop immediately.

## Step 1 — Fetch Open PRs

Scan **each repo in `$REPOS`** (not the ambient repo). For each:

```bash
gh pr list --repo <owner/repo> --json number,title,url,reviewRequested,statusCheckRollup,mergeable --limit 20
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

**review-requested:** `reviewRequested` array contains an entry where `login === $GH_USER` (the `github_user` from config, Step 0).

**ci-failed:** `statusCheckRollup` array contains at least one entry where `conclusion === 'FAILURE'` or `conclusion === 'ERROR'` or `state === 'FAILURE'` or `state === 'ERROR'`.

**merge-conflict:** `mergeable === 'CONFLICTING'`.

Collect matched items as:
```json
{ "type": "review-requested"|"ci-failed"|"merge-conflict", "pr": <number>, "title": "<title>", "url": "<url>" }
```

When a PR matches multiple signals, emit one item per signal type — do not collapse them.

## Step 3 — Write the digest via the configured output sink

Write exactly one entry regardless of whether items were found. The sink is `$OUTPUT` (Step 0):

**`output: "queue"`** (LOCAL runs only — the queue is a local file a cloud sandbox cannot reach).
Use the portable home-relative require:

```js
const { appendDigestEntry } = require(require('os').homedir() + '/.claude-os/hooks/digest-queue-write.js');
appendDigestEntry({ agent: 'pr-surveillance', status: 'ok', items: [ /* filtered items, or [] */ ] });
```

**`output: "issue"`** (cloud-safe). Write the digest as a GitHub issue (or comment on a tracking
issue) — never Slack. Title `PR digest — <date>`, body = the structured items as a markdown list:

```bash
gh issue create --repo <a repo from $REPOS> --title "PR digest — $(date +%F)" --body "<markdown items>"
```

**`output: "runlog"`** (cloud-safe). Emit the structured digest JSON to session output; no write.

Use `node -e` for single-line invocations. If a call needs more than one line, write a
`_tmp_pr_digest.js` script, run it, then delete it.

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
