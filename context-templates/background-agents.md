# Background Agents

Three background-digest skills run headless on a schedule and write to the digest queue at `~/.claude-data/digest-queue.jsonl`. Results are injected into the next session's context via `session-start-check.js`.

## Scheduling — TRUE launchd LaunchAgents

The digests run as macOS **launchd LaunchAgents** (per-user), so they fire on their cron schedule whether or not a Claude session — or the terminal — is open, and they survive logout/reboot. This replaces the old session-only `/schedule` (in-memory CronCreate) path, which died the moment Claude exited.

- **Source of truth:** `config/scheduled-jobs.json` (name / skill / cron).
- **Generator:** `bin/digest-launchd-install.js` translates each cron → launchd `StartCalendarInterval`, renders `config/launchd/com.claude-os.digest.plist.template` per job into `~/Library/LaunchAgents/com.claude-os.digest.<skill>.plist`, and (re)loads each via `launchctl` — idempotently.
- **Provisioning:** `update.sh` Step 9.5 runs the generator on every update. Re-running is safe (no double-load).
- Each job's headless invocation is `claude -p /<skill> --permission-mode default --allowedTools <the skill's own frontmatter tools>`. The allow-set is read per-job from each SKILL.md's `allowed-tools:` line, so an unattended job (notably the WRITE-capable merge-progression) can use ONLY the tools its skill declares — never broader than an interactive session. `default` (not `bypassPermissions`) is required: bypass allows every tool regardless of `--allowedTools`, whereas `default` enforces the allow-set and denies anything outside it without prompting (safe under no-TTY). Errors land in `~/.claude-data/.logs/<skill>.err`.

## Cadence

- **PR Surveillance** (`background-pr-digest`) — 06:00 local daily (`0 6 * * *`)
- **Sprint Staleness** (`background-sprint-digest`) — 06:30 local daily (`30 6 * * *`)
- **Merge Progression** (`background-merge-progression`) — minute 15 of every hour, Mon-Fri (`15 * * * 1-5`)

## Entry Format

Each entry is a JSONL line:
```json
{ "agent": "pr-surveillance"|"sprint-staleness"|"merge-progression", "status": "ok"|"error", "items": [...], "run_at": "<ISO-8601>" }
```

PR Surveillance items:
```json
{ "type": "review-requested"|"ci-failed"|"merge-conflict", "pr_number": 123, "title": "...", "repo": "owner/repo" }
```

Sprint Staleness items:
```json
{ "key": "ARC-123", "summary": "...", "status": "In Progress", "days_stale": 4 }
```

## Manual operations

```bash
# Re-provision after editing scheduled-jobs.json (also runs in update.sh):
node bin/digest-launchd-install.js

# Inspect a loaded job / force a one-off run / unload:
launchctl print "gui/$(id -u)/com.claude-os.digest.background-pr-digest"
launchctl kickstart "gui/$(id -u)/com.claude-os.digest.background-pr-digest"
launchctl bootout  "gui/$(id -u)/com.claude-os.digest.background-pr-digest"
```

## Supported cron grammar

The cron→`StartCalendarInterval` translator supports: `*` (wildcard), single integers, ranges (`a-b`), and lists (`a,b`). A field with more than one matching value expands to a launchd `StartCalendarInterval` **array** (one dict per combination) — e.g. `15 * * * 1-5` becomes five `{Minute:15, Weekday:n}` dicts. **Unsupported** (rejected with an error rather than mistranslated): step values (`*/5`), named months/days (`MON`, `JAN`), and special tokens (`?`, `L`, `#`).
