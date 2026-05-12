---
name: daily-action
description: "Generate a daily action plan from git history, PRs, JIRA sprint/defect data, and 2-week retrospective heuristics"
argument-hint: "[--rebuild [date] [--force] | date]  --rebuild: regenerate plan (date e.g. '2026-05-06', --force skips confirmation); normal: date e.g. 'today', '2026-04-09'"
---

## Mode selection

Parse `$ARGUMENTS` first:

- If `$ARGUMENTS` contains `--rebuild` → follow **Rebuild Mode** below.
- Otherwise → skip to **Normal Mode** (data collection and plan generation).

---

## Rebuild Mode

Discard today's stale plan and regenerate from live JIRA/GitHub data. Use this when
priorities have changed since this morning's plan was generated.

### Step 1 — Determine plan date and flags

```bash
PLAN_DATE=$(date +%Y-%m-%d)
```

If `$ARGUMENTS` contains a date token matching `YYYY-MM-DD`, or the words "today"/"tomorrow",
resolve it and set `PLAN_DATE` accordingly. Note whether `--force` is present.

### Step 2 — Lock pre-check

Check if a snapshot write is in progress before showing the confirmation:

```bash
LOCK="$HOME/.claude/snapshots/daily/.lock"
if [ -d "$LOCK" ]; then
  LOCK_MTIME=$(stat -f "%m" "$LOCK" 2>/dev/null || stat -c "%Y" "$LOCK" 2>/dev/null || echo "0")
  NOW=$(date +%s)
  LOCK_AGE=$(( NOW - LOCK_MTIME ))
  if [ "$LOCK_AGE" -lt 300 ]; then
    echo "A daily-action write is in progress. Wait and retry."
    exit 1
  fi
fi
```

If the lock is **active** (age < 5 minutes): the snippet above outputs the message and exits 1 immediately.
Do not show the confirmation prompt, do not touch any files.

If the lock is stale (age ≥ 5 minutes): continue — `rebuild-clear.sh` will warn and remove it.

### Step 3 — Identify artifacts to clear

Determine which files exist for `$PLAN_DATE`:

- `~/Documents/WorkDay/DailyActionPlan/action-plan-${PLAN_DATE}.md`
- `~/.claude/skills/daily-action/plans/${PLAN_DATE}.md`
- `~/.claude/snapshots/daily/${PLAN_DATE}.json` (daily-action subfields cleared:
  `plan.itemsPlanned`, `plan.priorityStackSize`, `plan.items`, `plan.adhocItems`,
  `signals`, `jira` download/sprint-assigned fields, `planDetails`, `planItems`,
  `quality`; standup-owned subfields preserved: `plan.itemsCompleted`,
  `plan.completionRate`, `plan.carryoverFromPrev`, `jira.transitionsToday`,
  `jira.commentsLeft`, `jira.sprintCompletedToday`; `"daily-action"`, `"perch"`,
  `"perch-agent"` removed from `sources`)
- `~/.claude/snapshots/agent-debug/${PLAN_DATE}.jsonl` (Perch agent debug log)

If **none** of these exist, skip Steps 4–6 and proceed directly to **Step 7 (Regenerate)**.

### Step 4 — Confirmation (skip when `--force`)

Unless `--force` is set in `$ARGUMENTS`, use `AskUserQuestion` to confirm before clearing.
List the specific files and fields that will be affected so the user knows what will be lost.
Block until the user responds.

If the user declines, output exactly:

```
Rebuild cancelled.
```

Then stop with exit code 0. Do not touch any files.

### Step 5 — Clear artifacts

Run the clear script:

```bash
~/.claude/skills/daily-action/rebuild-clear.sh "$PLAN_DATE"
```

This script acquires the snapshot lock, archives the outgoing plan markdown to
`action-plan-${PLAN_DATE}.pre-rebuild-HHmmss.md` in the same directory, clears
daily-action-owned fields **and** perch-owned fields from the snapshot (preserving
only standup-owned fields), deletes the plan markdown files, and removes the
Perch agent debug log for `$PLAN_DATE`.

If the script exits non-zero, surface the error and stop — do not proceed to regeneration.

### Step 6 — Report clear output

Echo what was archived, cleared, and removed (the script prints each line). Then proceed.

### Step 7 — Regenerate

Run the full data collection and plan generation pipeline — identical to **Normal Mode**
below — using `$PLAN_DATE` as the plan date. Call `collect-data.sh` against live JIRA
and GitHub. Do not skip any step.

---

## Normal Mode

Launch the `daily-action` agent to generate an action plan.

**Plan date:** `$ARGUMENTS` (or today if not specified)

Gather all data sources (git, GitHub PRs, JIRA sprint/defect data, previous action plans), run retrospective heuristics against the last 2 weeks of plans, and produce the daily action plan.

## Data Sources

Use **CLI tools only** for all data fetching. Do not use Jira MCP tools — they depend on the MCP server being connected and produce large context-bloating responses.

### Jira
```bash
# My open sprint issues
jira issue list -q"project = ARC AND sprint in openSprints() AND assignee = currentUser() AND statusCategory != Done" --plain --columns KEY,SUMMARY,STATUS,PRIORITY

# Defects assigned to me
jira issue list -q"project = ARC AND issuetype = Bug AND assignee = currentUser() AND statusCategory != Done" --plain --columns KEY,SUMMARY,STATUS,PRIORITY

# Issue detail (when needed)
jira issue view ISSUE-KEY --plain

# Current sprints
jira sprint list --plain
```

### GitHub PRs
```bash
# My open PRs
gh pr list --author "@me" --json number,title,state,reviewDecision,url --limit 20

# PR checks / CI status
gh pr checks [number] --json name,state,conclusion
```

### Git / local history

**Always use `GIT_DIR=` env vars — never `cd ; git` or `cd && git`.** The `cd ; git` pattern triggers a built-in security prompt that cannot be bypassed. `GIT_DIR=` is already in the allow list.

**Do NOT run `unset GIT_DIR` before other commands.** The `GIT_DIR=/path git log` syntax is command-local — it sets the variable only for that one subprocess, never in the shell. Each Bash tool call is also a fresh shell, so nothing leaks between calls. Running `unset GIT_DIR && gh pr list` is both unnecessary and triggers a permission prompt.

**Repo paths come from the watched-repo file — never hardcode them.** Read `~/.claude/shared-config/perch-watched-repos.json` (fall back to `arc-repos.json` if absent) and run `git log` for each entry's `path` field.

```bash
# Read the canonical watched-repo list; fall back to legacy filename if new one missing
REPOS_JSON=~/.claude/shared-config/perch-watched-repos.json
if [[ ! -f "$REPOS_JSON" ]]; then REPOS_JSON=~/.claude/shared-config/arc-repos.json; fi

# Run for each watched repo using GIT_DIR — no cd required
while IFS=$'\t' read -r name path; do
  GIT_DIR="${path}/.git" git log --oneline --since="14 days ago" --author="fulksjas" 2>&1 | sed "s/^/${name}: /" || true
done < <(jq -r '.repos[] | [.name, .path] | @tsv' "$REPOS_JSON")
```

Check for active worktrees under `../worktrees/{feat,fix,chore}/` relative to each repo and include those too.

### Previous plans
Read the last 14 action plan markdown files from `~/Documents/WorkDay/DailyActionPlan/` to run retrospective heuristics (chronic carryover, stale items, completion trend).

## Snapshot output

After generating the plan, write structured data to the daily snapshot via `snapshot-write.sh` so the Perch dashboard can display it.

**Always use the two-step pattern:**
1. Write the JSON to `~/Documents/WorkDay/DailyActionPlan/_tmp_snapshot.json` using the **Write tool**
2. Call `snapshot-write.sh` passing the file path directly — no `$()` substitution needed

### Call 1 — metrics and heuristic signals

Write this JSON to `~/Documents/WorkDay/DailyActionPlan/_tmp_snapshot.json`, then call:

```bash
~/.claude/skills/daily-action/snapshot-write.sh "$PLAN_DATE" ~/Documents/WorkDay/DailyActionPlan/_tmp_snapshot.json
```

Schema for the temp file:
```json
{
  "plan": {
    "itemsPlanned": 5,
    "priorityStackSize": 4
  },
  "signals": {
    "sprintDrift":      { "status": "OK", "defectPercent": 0 },
    "chronicCarryover": { "status": "WARNING", "ticketCount": 0 },
    "staleStack":       { "status": "WARNING", "itemCount": 0 },
    "stalledBlocker":   { "status": "OK", "stalledDays": 0 },
    "completionTrend":  { "status": "OK", "rolling3Day": 0.0 },
    "finishOverStart":  { "status": "OK", "openPrsCount": 0 },
    "qaRework":         { "status": "OK", "ticketCount": 0 }
  },
  "jira": {
    "sprintAssignedTotal": 0,
    "sprintAssignedNotDone": 0,
    "downloadIssuesOpen": 0,
    "unassignedDefectsOpen": 0
  },
  "warnings": []
}
```

Signal `status` values: `"OK"` | `"WARNING"` | `"CRITICAL"`. `warnings` is a string array of human-readable advisory messages (empty array if none).

### Call 2 — plan details

Write this JSON to `~/Documents/WorkDay/DailyActionPlan/_tmp_snapshot.json`, then call:

```bash
~/.claude/skills/daily-action/snapshot-write.sh "$PLAN_DATE" ~/Documents/WorkDay/DailyActionPlan/_tmp_snapshot.json
```

Schema for the temp file:
```json
{
  "planDetails": {
    "ARC-XXXX": {
      "context": "One or two sentences: why this item is on the plan today, what changed, what the situation is.",
      "steps": [
        { "text": "Concrete next action — specific enough to execute immediately", "done": false },
        { "text": "Second step", "done": false }
      ],
      "doneWhen": "Explicit, observable completion criterion."
    }
  }
}
```

**Rules for `planDetails`:**
- Include every item from the plan that has a context paragraph, steps, or done-when criterion
- Use the exact Jira key as the object key (e.g., `"ARC-3972"`)
- `context`: the narrative paragraph you write explaining why the item is on the plan — same content as the markdown, condensed to 1–3 sentences
- `steps`: the `- [ ]` checklist items from the markdown, each as `{ "text": "...", "done": false }`; omit the "Done when:" item from steps — put it in `doneWhen` instead
- `doneWhen`: the "Done when:" line verbatim, without the "Done when:" prefix
- Items with no steps or context can be omitted from `planDetails`

**Field ownership:**

- `planDetails` and `plan.items` are owned by the daily-action skill. The skill writes the canonical list of today's plan items via Call 3 below.
- `plan.items` status, links, and `statusHistory` are kept live by the perch-agent rules engine (`agent/snapshotMerger.js`), but the agent is **update-only on known keys** — it cannot append new items. Tickets the skill did not place on today's plan never land in `plan.items`.
- This means the skill's Call 3 is the daily reset point. Whatever you put in `planItems` is what shows up on the dashboard.

### Call 3 — plan items (canonical list)

Write this JSON to `~/Documents/WorkDay/DailyActionPlan/_tmp_snapshot.json`, then call:

```bash
~/.claude/skills/daily-action/snapshot-write.sh "$PLAN_DATE" ~/Documents/WorkDay/DailyActionPlan/_tmp_snapshot.json
```

Schema for the temp file:
```json
{
  "planItems": [
    { "jiraKey": "ARC-3972", "summary": "Graceful pause/resume on network loss", "priority": "P1", "status": "active" },
    { "jiraKey": "ARC-4276", "summary": "Concurrent cross-tab downloads overwrite", "priority": "P2", "status": "active" }
  ]
}
```

**Rules for `planItems`:**
- Include every item from today's plan — the same set that appears in the markdown file under "Today's Action Plan."
- `status` is one of: `"active"`, `"completed"`, `"cancelled"`, `"reassigned"`, `"moved"`. Default to `"active"` for new entries unless the item already shipped before the plan was written.
- The shell script preserves live status (`status`, `statusHistory`, `addedAt`, `links`, `updatedAt`) for any `jiraKey` that already exists in today's snapshot — so re-running `/daily-action` mid-day after the agent has flipped a status to `"completed"` will not wipe that.
- Keys in old `plan.items` that are not in your new `planItems` are **dropped**. That's the correct behavior — items leave the plan when you take them off.
- New entries are stamped with `addedAt`, `updatedAt`, and an initial `statusHistory` automatically.
