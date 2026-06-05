# Background Agents

Two CronCreate-scheduled background skills run daily and write to the digest queue at `~/.claude-data/digest-queue.jsonl`. Results are injected into the next session's context via `session-start-check.js`.

## Cadence

- **PR Surveillance** (`background-pr-digest`) — 06:00 local daily (schedule: `0 6 * * *`)
- **Sprint Staleness** (`background-sprint-digest`) — 06:30 local daily (schedule: `30 6 * * *`)

## Entry Format

Each entry is a JSONL line:
```json
{ "agent": "pr-surveillance"|"sprint-staleness", "status": "ok"|"error", "items": [...], "run_at": "<ISO-8601>" }
```

PR Surveillance items:
```json
{ "type": "review-requested"|"ci-failed"|"merge-conflict", "pr_number": 123, "title": "...", "repo": "owner/repo" }
```

Sprint Staleness items:
```json
{ "key": "ARC-123", "summary": "...", "status": "In Progress", "days_stale": 4 }
```

## Scheduling

To activate both skills after the session-start wiring is committed:
```
/schedule skill=background-pr-digest cron="0 6 * * *" name="PR Surveillance"
/schedule skill=background-sprint-digest cron="30 6 * * *" name="Sprint Staleness"
```
