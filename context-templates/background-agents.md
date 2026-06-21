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

## Going live (first install)

The jobs are **inert until provisioned** — writing `scheduled-jobs.json` and merging the code does not schedule anything. To bring the three LaunchAgents up on a Mac:

1. **Get the code onto the machine.** Merge the PR, then on the Mac:
   ```bash
   cd ~/.claude-os && git pull
   ```

2. **Run the provisioner.** `update.sh` Step 9.5 renders + loads all three agents idempotently:
   ```bash
   cd ~/.claude-os && ./update.sh
   ```
   Or run just the generator (same effect, no other update steps):
   ```bash
   cd ~/.claude-os && node bin/digest-launchd-install.js
   ```
   Expect `[OK]` / `[SKIP]` lines per job. A `[!!]` warning means the real `claude` binary
   could not be resolved (nothing was written — fail-safe) or `scheduled-jobs.json`/a cron is
   malformed; fix and re-run.

3. **Edit the genome `CLAUDE.md` to drop the retired CronCreate path** — same sitting as the
   provision above, so the deployed agent instructions never contradict shipped behavior. In
   `~/.claude-os/CLAUDE.md`, the "Scheduled background jobs → … session-start injects the
   register commands" line and the "When session start injects a `[Background jobs]` block,
   silently call CronCreate …" block describe a path PR #62 removed (that block is never emitted
   now). Replace them so they point at `update.sh` Step 9.5 / `bin/digest-launchd-install.js` and
   state plainly that these jobs run as launchd LaunchAgents — there is nothing to register at
   session start, and CronCreate must NOT be called for them (it would double-schedule). This is
   a live-machine edit on a gitignored, machine-provisioned file — it cannot ride a PR; apply it
   by hand here, paired with the provision in step 2.

4. **Verify each agent loaded** (replace `<skill>` with each of `background-pr-digest`,
   `background-sprint-digest`, `background-merge-progression`):
   ```bash
   launchctl print "gui/$(id -u)/com.claude-os.digest.<skill>" | head -20
   ls -la ~/Library/LaunchAgents/com.claude-os.digest.*.plist
   ```
   A loaded job prints its `state`, `program`, and `StartCalendarInterval`. Confirm
   `RunAtLoad = false` — provisioning must not have fired a digest (critical: merge-progression
   transitions real Jira tickets).

5. **Force a test fire** of a read-only job first (pr-digest is safest — never writes):
   ```bash
   launchctl kickstart "gui/$(id -u)/com.claude-os.digest.background-pr-digest"
   ```
   Then confirm a result landed: a new line in `~/.claude-data/digest-queue.jsonl`, and an
   empty/clean `~/.claude-data/.logs/background-pr-digest.err`. The digest surfaces in your
   next interactive session via `session-start-check.js`.

6. **(Optional but recommended for the WRITE job) confirm the permission scope holds under
   no-TTY** before trusting merge-progression unattended. The job's safety rests on
   `--permission-mode default` *denying* any tool outside the skill's `allowed-tools` set.
   Prove it with a controlled contrast — and use a command that is **not** pre-allowed in your
   `settings.json` (a pre-allowed command like `node` runs under both modes and proves nothing):
   ```bash
   # Should be DENIED (lands in permission_denials, no prompt, completes):
   claude -p "run: sw_vers -productName" --permission-mode default --allowedTools "Bash(echo *)" --output-format json
   # Should RUN (proves bypass ignores the allowlist — i.e. why we use default, not bypass):
   claude -p "run: sw_vers -productName" --permission-mode bypassPermissions --allowedTools "Bash(echo *)" --output-format json
   ```

To unschedule a job: `launchctl bootout "gui/$(id -u)/com.claude-os.digest.<skill>"` and delete
its plist from `~/Library/LaunchAgents/`.

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
