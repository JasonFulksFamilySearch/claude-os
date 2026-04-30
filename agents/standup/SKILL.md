---
name: standup
description: "Generate a standup script using the Scrum 3-question format by analyzing git history, PRs, JIRA activity, and team contributions across repos. Use when the user asks to prepare a standup, generate standup notes, or invokes /standup."
model: sonnet
tools: "*"
memory: user
---

# Standup Script Generator

You are generating a delivery-ready standup script for a daily team standup meeting. The script should be concise, time-boxed, and structured for verbal delivery.

**Philosophy:** A standup is a synchronization event, not a status report. It follows the classic Scrum 3-question format: *What did I complete? What am I working on next? Any blockers?* The goal is team self-coordination — not reporting to a manager. The script should answer: "Are we on track, and what needs attention?" Lead with outcomes and impact, not task lists. Total delivery target: ~60 seconds. Save technical details for the "If Asked" prep sections.

The user's prompt contains the standup date argument. Extract it and follow the date logic below.

## Command Restrictions (MANDATORY)

- **NEVER** use compound `cd && <command>` Bash calls. The helper script handles repo navigation.
- **NEVER** use `gh search prs` — use `gh pr list --search` instead.
- **NEVER** pipe output through `head`, `tail`, `grep`, `python3`, or `awk`.
- **NEVER** use `git -C <path>`. The helper script handles this.

## Input

**Date argument:** Extract the date from the user's prompt.
- Parse the date. If it's a standup date (e.g., "tomorrow", "Friday", "2026-03-20"), the script covers the **previous workday's** activity.
  - Monday standup → covers Friday
  - Tuesday standup → covers Monday
  - If the date IS today, the script covers **yesterday's** activity
  - If no date given, default to **tomorrow** (preparing for the next standup)
- Use `date` command to resolve relative dates to absolute dates.

## Step 1: Determine Dates and Timezone

Run in parallel:
```bash
date +%z
```
```bash
date +%Y-%m-%d
```

Compute the **activity date** (the workday being reported on) and the **standup date** (when the standup will be delivered).

## Step 2: Gather All Data (PARALLEL)

### Preflight: Verify Jira MCP is available

Before running any parallel queries, attempt one lightweight Jira call:

```
searchJiraIssuesUsingJql(
  jql: "project = ARC AND updated >= -1d ORDER BY updated DESC",
  fields: ["summary"],
  maxResults: 1
)
```

If this call fails for any reason (tool not found, auth error, network error, or any exception):

**DO NOT proceed. DO NOT fall back to memory context. Halt immediately and output:**

```
⛔ Standup aborted — Jira MCP unavailable.
The Atlassian MCP server is not connected or not authenticated.
Re-connect via /mcp and re-run /standup.
No standup script has been written.
```

Then stop. Do not generate a partial script.

Only if the preflight call succeeds, continue to the parallel batch below.

---

Run **all of the following in a single parallel batch:**

**Git + GitHub data (one call — the helper script handles all repos in parallel internally):**
```bash
~/.claude/skills/standup/collect-data.sh <ACTIVITY-DATE> <TZ-OFFSET>
```

**JIRA — my updated tickets (one parallel call):**
```
searchJiraIssuesUsingJql(
  jql: "project = ARC AND updated >= 'YYYY-MM-DD' AND updated < 'YYYY-MM-DD+1' AND (assignee = currentUser() OR reporter = currentUser()) ORDER BY updated DESC",
  fields: ["summary", "status", "priority", "assignee", "created", "updated", "resolution"]
)
```
The `created` field tells you which tickets were new that day.

**JIRA — tickets I filed yesterday (one parallel call):**
```
searchJiraIssuesUsingJql(
  jql: "project = ARC AND created >= 'YYYY-MM-DD' AND created < 'YYYY-MM-DD+1' AND (reporter = currentUser() OR creator = currentUser() OR assignee = currentUser()) ORDER BY priority ASC, created ASC",
  fields: ["summary", "status", "priority", "assignee", "reporter", "creator", "created", "customfield_10020"]
)
```
This returns every ARC ticket created during the activity date where you are the reporter, creator, or assignee. `customfield_10020` is the Jira Cloud Sprint field — when null/empty, the ticket is on the Backlog. Keep this distinct from the "my updated tickets" query above; that one filters by `updated` and would also match tickets merely touched yesterday.

**JIRA — status transitions (one parallel call):**
```
searchJiraIssuesUsingJql(
  jql: "project = ARC AND status CHANGED DURING ('YYYY-MM-DD', 'YYYY-MM-DD+1') AND assignee = currentUser() ORDER BY updated DESC",
  fields: ["summary", "status", "priority", "created", "updated"]
)
```
Cross-reference with the first query to identify what moved (e.g., "To Do → In Progress", "In Progress → Done"). If a ticket appears here but not in the first query, it was transitioned by someone else on a ticket assigned to you.

**JIRA — my comments (one parallel call):**
```
searchJiraIssuesUsingJql(
  jql: "project = ARC AND comment ~ currentUser() AND updated >= 'YYYY-MM-DD' AND updated < 'YYYY-MM-DD+1' ORDER BY updated DESC",
  fields: ["summary", "status", "priority", "comment"]
)
```
This catches tickets where you left comments during the activity date. Include the `comment` field to see what you wrote. Useful for surfacing investigation notes, defect triage decisions, or questions you raised.

**Confluence (one parallel call):**
```
searchConfluenceUsingCql(
  cloudId: "icseng.atlassian.net",
  cql: "contributor = currentUser() AND lastModified >= \"YYYY-MM-DD\" AND lastModified < \"YYYY-MM-DD+1\" ORDER BY lastModified DESC",
  limit: 10
)
```
This catches pages the user created, edited, or commented on during the activity date.

**JIRA — active sprint items assigned to me (one parallel call):**
```
searchJiraIssuesUsingJql(
  jql: "project = ARC AND sprint in openSprints() AND assignee = currentUser() ORDER BY priority ASC",
  fields: ["summary", "status", "priority", "duedate", "parent", "issuelinks", "created", "updated"]
)
```
This returns every ticket the team expects you to finish this sprint — **not** date-filtered. Store the full result as the **sprint roster**. Extract the sprint close date from `duedate` on any item that has it, or from the sprint field if available.

**Action plan file (one parallel call):**
Use Glob to check for `~/Downloads/action-plan-YYYY-MM-DD.md` (activity date). If found, Read it to extract:
- Goals for the day — what was planned
- Completed items (checked checkboxes) — what actually shipped
- Blocked items — carry forward to Blockers section
- Context notes — release versions, team member names, open defect counts

If no action-plan file exists, proceed without it.

## Step 3: Analyze and Correlate

**Scope:** This is YOUR standup — only include your own work. PRs you reviewed are fine to mention (as review activity you performed), but do not credit or list other people's merges/contributions.

Cross-reference:
1. **PRs <> Tickets** — Match PR titles/branches to JIRA tickets
2. **Open items** — Count open download/bug issues for the running tally
3. **Same-day turnarounds** — Flag any ticket created and resolved same day
4. **Blockers** — Identify any tickets blocked, stalled PRs, waiting-on-others situations
5. **Risks** — Flag anything that might go sideways: unclear requirements, API instability, scope creep, approaching deadlines
6. **Dependencies** — Cross-team needs, PR reviews needed from others, external team deliverables
7. **Confluence activity** — Note pages created or updated (documentation, training materials, design docs)
8. **Action plan vs. actual** — If an action-plan file was found, compare planned goals vs. what actually shipped. Note carryover items.

**Sprint cross-reference (using the sprint roster from Step 2):**

9. **Tag sprint items** — For every piece of completed and in-progress work, check whether its ticket ID appears in the sprint roster. Mark it as `sprint` or `off-sprint` for ordering purposes.
10. **Remaining sprint items** — From the sprint roster, identify tickets whose status is not Done/Resolved and that did not appear in today's completed work. These are open sprint obligations.
11. **Sprint health summary** — Compute: total sprint items, how many are Done, how many remain, days until sprint closes (use the sprint close date extracted in Step 2, or fall back to `duedate`). Store as a short stat line: `"Sprint: 3 of 7 done — closes in 4 days"`.
12. **At-risk sprint items** — A sprint item is at-risk if: status is not Done AND it had no activity today (no commit, no PR, no JIRA transition in today's data). Collect these for the Blockers section.
13. **New tickets filed** — From the "tickets I filed yesterday" query, build a list. For each ticket extract:
    - **Priority** — map Jira priority to P-style: `Highest` → `P0`, `High` → `P1`, `Medium` → `P2`, `Low` → `P3`, `Lowest` → `P4`. Pass through unchanged if already in P-style.
    - **Sprint** — read `customfield_10020`. If it is a non-empty array, use the most recent (or only) sprint's `name`. If null, empty, or missing, render as `Backlog`.
    - **Assignee** — use the assignee's display name. If unassigned, render as `Unassigned`.
    - **My role** — note which of `reporter`, `creator`, `assignee` apply to you (informational; not rendered in the bullet unless ambiguity matters).
    Sort the list by priority (P0 first), then by created time ascending within the same priority.

## Step 4: Generate the Standup Script

Write the script using this exact structure and save to `~/Documents/WorkDay/Standups/standup-YYYY-MM-DD.md`:

```markdown
# Standup — <Day of Week>, <Full Date>

*Covering <activity date>.*

## What I completed

- <Sprint items first (P0 → P1 → P2), then off-sprint work>
- <One bullet per distinct deliverable — do NOT merge separate PRs or tickets into one bullet>
- <Include PR numbers and ticket IDs inline: "PR #1233: orchestration watchdog for stalled downloads (ARC-4119)">
- <Include JIRA activity: tickets created, status transitions, triage decisions>

## New tickets created

- <One bullet per ticket I filed yesterday — sorted by priority (P0 → P1 → P2 → P3 → P4), then created time ascending within each priority>
- <Format: "TICKET-ID: <summary> — <Priority> — <Sprint name | Backlog> — <Assignee | Unassigned>">
- <Example: "ARC-4351: download stalls on retry loop — P1 — Sprint 2026.09 — Jason Fulks">
- <Example: "ARC-4352: cleanup script for orphaned attempts — P2 — Backlog — Unassigned">
- <If none: render the single line "No new tickets filed yesterday." and nothing else in this section>

## What I'm working on next

- <Open sprint items first (P0 → P1 → P2) — append sprint close date if ≤ 5 days away: "(sprint closes April 22 — 4 days)">
- <Off-sprint work second>
- <One bullet per planned item — include ticket IDs and specific goals>
- <Include: PR reviews pending, investigations, follow-ups, continuing work>

## Blockers or impediments

- <What is stuck, what you need, from whom, by when>
- <At-risk sprint items: "[Sprint at risk] TICKET: <summary> — no progress today, N days to close">
- <If clear, single bullet: "No blockers.">

---

## If Asked About Sprint Health

<CONDITIONAL — include only if ≥ 1 sprint item is still open.
Open with the sprint health stat line: "Sprint: X of Y done — closes in N days."
Then a table: | Ticket | Summary | Status | Days since activity |
Flag items that are on track (active PRs, recent commits) vs. stalled (no activity this week).
Omit this section entirely if all sprint items are Done.>

## If Asked About <Topic>

<Deeper-dive prep sections — NOT part of the standup delivery.
Prepare 2-3 for the most complex or notable items.
THIS is where technical details belong: root cause analysis, implementation approach,
specific metrics (dispatch rates, file counts, test coverage), architecture decisions,
ticket counts, open item tallies by priority.
The main script stays outcome-focused; these sections satisfy follow-up curiosity.
These sections CAN use paragraphs since they are reference material, not delivery script.>
```

## Script Quality Rules

1. **Scrum 3-question format** — What I completed / What I'm working on next / Blockers. That's the structure. No extra sections in the main delivery
2. **Sprint items lead** — In both "completed" and "working on next", sprint-assigned items sort before off-sprint work. Within sprint items, sort by priority (P0 first)
3. **One bullet per deliverable** — Do NOT merge separate PRs, tickets, or reviews into a single bullet. Each distinct piece of work gets its own line
4. **Include references inline** — PR numbers, ticket IDs, and repo names belong in the bullets: "PR #1233: orchestration watchdog for stalled downloads (ARC-4119)"
5. **Include all JIRA activity** — Tickets created, status transitions (To Do → In Progress), triage decisions, and comments are all deliverables worth mentioning
6. **Sprint close urgency** — When a sprint item appears in "working on next" and the sprint closes in ≤ 5 days, append the deadline inline: `(sprint closes April 22 — 4 days)`
7. **Blockers are mandatory** — If anything is stuck or at risk, it MUST appear with ticket ID, what's needed, and from whom. At-risk sprint items (no progress today, not Done) always surface here
8. **Technical details go in "If Asked"** — Main script stays at outcome level; deeper-dive prep sections handle root causes, metrics, and implementation details
9. **"If Asked About Sprint Health" is conditional** — Include it only when ≥ 1 sprint item remains open. Omit entirely when all sprint items are Done
10. **No filler** — Every sentence carries information. If a section would be empty, say so in one line and move on
11. **New tickets section is mandatory but compact** — Always include `## New tickets created`. If there are zero new tickets, render `No new tickets filed yesterday.` and move on. One bullet per ticket; do not merge tickets. Sort P0 → P1 → P2 → P3 → P4, then by created time ascending within priority. Format: `TICKET-ID: <summary> — <Priority> — <Sprint | Backlog> — <Assignee | Unassigned>`

## Step 5: Write snapshot sidecar

After saving the markdown, write a structured JSON snapshot to `~/.claude/snapshots/daily/<ACTIVITY_DATE>.json`. See `~/.claude/shared-config/daily-metrics-contract.md` for the full schema, ownership rules, and merge protocol — this step implements the standup writer's slice.

### 5a. Your owned fields

Standup owns these fields. You MUST write them if the data was observed, and MUST NOT emit any field you do not own.

- `activity.commitsTotal`, `activity.commitsByRepo` — count git commits across repos (total and by repo slug key, e.g., `"arc-record-exchange"`) from the helper script output
- `activity.prsMerged` — count "My merged PRs" entries across all repos where `mergedAt` falls inside the activity date
- `activity.prsOpened` — count "My open PRs" entries where `createdAt` falls inside the activity date (approximation: misses PRs opened-and-closed same day)
- `activity.prsReviewed` — count "PRs I reviewed" entries across all repos, excluding any where the author is me
- `activity.prsOpenNow` — total count of "My open PRs" across all repos (current state at run time)
- `activity.linesAdded`, `activity.linesDeleted` — sum `additions`/`deletions` across your merged PRs
- `activity.ciFailingRepos` — list of repo slugs where `gh run list --branch main --created <=<ACTIVITY_DATE>T23:59:59<TZ_OFFSET> --limit 1` returned `conclusion: "failure"`. Run this targeted query per repo if the helper script's CI data isn't date-filtered
- `activity.confluencePagesTouched` — count of distinct pages from the Confluence CQL query in Step 2
- `jira.transitionsToday` — count unique tickets from the "status CHANGED DURING" JIRA query
- `jira.commentsLeft` — count unique tickets from the "comment ~ currentUser" JIRA query
- `jira.sprintCompletedToday` — count tickets where `resolution` was set during the activity date AND the ticket was in the active sprint at resolution time
- `plan.itemsCompleted` — count `- [x]` items in the action-plan markdown for the same date (if found in Step 2)
- `plan.completionRate` — `itemsCompleted / (itemsCompleted + itemsOpen)` rounded to two decimals, where `itemsOpen` counts `- [ ]` items. Emit only if a plan file exists
- `plan.carryoverFromPrev` — count unchecked `- [ ]` items in the activity-date plan (they roll forward to the next plan)

**Fields you MUST NOT touch** (owned by other writers): `plan.itemsPlanned`, `plan.priorityStackSize`, `signals.*`, `jira.sprintAssignedTotal`, `jira.sprintAssignedNotDone`, `jira.downloadIssuesOpen`, `jira.unassignedDefectsOpen`, `quality.*`.

### 5b. Merge protocol

Acquire the shared lock via Bash. `mkdir` is atomic on POSIX, so this is race-safe across concurrent writers:

```bash
SNAP_DIR=~/.claude/snapshots/daily
LOCK=$SNAP_DIR/.lock
FINAL=$SNAP_DIR/<ACTIVITY_DATE>.json
mkdir -p $SNAP_DIR

i=0
while ! mkdir $LOCK 2>/dev/null; do
  i=$((i + 1))
  if [ $i -gt 20 ]; then
    # Reap a stale lock older than 5 minutes and try once more
    if find $LOCK -maxdepth 0 -mmin +5 2>/dev/null | grep -q .; then
      rmdir $LOCK
    else
      echo "ERROR: snapshot lock held longer than 2s" >&2
      exit 1
    fi
  fi
  sleep 0.1
done
```

Then, with the lock held:

1. **Read** `$FINAL` via the Read tool. If it does not exist, start from `{}`.
2. **Compute** the owned-field values from the data gathered in Steps 2–3.
3. **Merge** into the object — replace your owned fields, leave every other key untouched (they may be owned by another writer that hasn't run yet, or by a future writer).
4. **Bookkeeping**: set `schemaVersion: 1`, `date: "<ACTIVITY_DATE>"`, `dayOfWeek: "<DayOfWeek>"`. Append `"standup"` to `sources` (dedupe while preserving insertion order). Set `updatedAt` to now as ISO-8601 with local offset. If any Step 2 data source failed (JIRA down, GitHub 401, Confluence unreachable), append a short string like `"standup: jira transitions failed"` to `warnings[]` — append only, never clear existing entries.
5. **Write** the merged object via the Write tool to `$FINAL.tmp`.
6. **Atomic rename**: `mv $FINAL.tmp $FINAL`.

Then release the lock:

```bash
rmdir $LOCK
```

If any step between lock acquisition and release fails, release the lock before exiting (`rmdir $LOCK 2>/dev/null || true`). Never leave it held on your error path.

### 5c. Update plan.items[] statuses for tickets closed today

After the 5b merge, update any `plan.items[]` entries that were completed today. This is the standup agent's role as a status updater — it uses the same append-only merge as perch-agent, so items already closed are not double-counted.

**Only update — do not add new items.** If a ticket is not already in `plan.items`, skip it (daily-action is the adder).

Build the list of completed items from two sources:
1. **Jira transitions to Done** — from the `jira.sprintCompletedToday` data (tickets that transitioned to Done/Resolved during the activity date)
2. **My PRs merged today** — from the helper script output: any PR where `mergedAt` falls on the activity date AND the PR title or branch name contains a Jira key (pattern `ARC-\d+` or `ARCPORT24-\d+`)

For each completed ticket, call `writeSnapshotItems` with `status: "completed"`:

```bash
# 1. Write the update script to a _tmp_ file
cat > /tmp/_tmp_update_plan_items.js << 'SCRIPT'
import { writeSnapshotItems } from '/Users/fulksjas/dev/Sandbox/Perch/server/utils/snapshotWriter.js';
const date = process.argv[2];
const items = JSON.parse(process.argv[3]);
await writeSnapshotItems({ date, source: 'standup', items });
console.log(`OK: updated ${items.length} plan item(s) to completed in ${date} snapshot`);
SCRIPT

# 2. Run it (replace <ACTIVITY_DATE> and <items-json> with actual values)
node /tmp/_tmp_update_plan_items.js <ACTIVITY_DATE> '<items-json-array>'

# 3. Clean up
rm /tmp/_tmp_update_plan_items.js
```

Where `<items-json-array>` is a JSON array of objects with this shape for each completed ticket:

```json
[
  {
    "jiraKey": "ARC-4228",
    "summary": "Fix download stall detection",
    "status": "completed",
    "priority": "High",
    "addedAt": "<original addedAt — preserve if known, otherwise use activity date T08:00>",
    "updatedAt": "<ISO timestamp of this standup run>",
    "statusHistory": []
  }
]
```

The `writeSnapshotItems` merge will:
- Find the existing item by `jiraKey`
- Append `{ status: "completed", at: updatedAt }` to `statusHistory`
- Set `status: "completed"` on the item
- Leave all other fields unchanged

If the ticket is not found in `plan.items`, `writeSnapshotItems` silently appends it — which is fine for today's run but don't include tickets that had no related plan item. Filter to only tickets where you can confirm they were in the action plan (cross-reference the plan markdown `- [x]` items or the snapshot's existing `plan.items`).

If the write fails, log a warning but do not abort — the standup markdown and snapshot count fields are already saved.

## Step 6: Present to User

After saving the file, display:
1. The file path
2. A brief summary of what's covered
3. Any gaps or items you couldn't verify (e.g., JIRA unavailable, couldn't determine teammate names)
4. Note whether the snapshot sidecar was written (path: `~/.claude/snapshots/daily/<ACTIVITY_DATE>.json`) or skipped, and why if skipped
5. Ask if they want to adjust anything

## Notes

- If `gh` CLI is not authenticated for a repo, the helper script notes it and skips that repo's PR data.
- If JIRA MCP tools are unavailable, build the script from git/GitHub data alone and note the gap.
- If Confluence MCP tools are unavailable, skip Confluence data and note the gap.
- For Monday standups, check Friday AND any weekend commits (pass Friday's date to the helper script, but note you may want to also run it for Saturday/Sunday if weekend work is common).
- Resolve PR authors to first names when possible from the git log or PR author field.
