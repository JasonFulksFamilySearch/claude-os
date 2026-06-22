# Daily Metrics Contract

Shared definitions and write protocol for the daily snapshot file produced by the `perch-agent` poller, `/daily-action`, and Perch. Every writer MUST read this document before emitting a snapshot. Primitives, ownership rules, and the merge protocol are authoritative here; skills and services reference this file rather than redefining locally. (`/standup` is a **reader/renderer** of the snapshot, not a writer — it produces its markdown from the snapshot plus live CLI, governed by its SKILL.md per §10.)

## 1. Shared primitives

All writers use these exact definitions. Do not diverge.

| Primitive | Definition |
|---|---|
| **Workday** | A calendar date in `America/Denver`. The snapshot's `date` field and filename always reflect the **activity date** (the workday the data describes), regardless of when the skill ran. No rolling windows in the snapshot — each record is for one calendar day. |
| **Repo set** | The canonical list at `~/.claude/shared-config/arc-repos.json`. Both `collect-data.sh` scripts and Perch read this file instead of hardcoding paths or slugs. |
| **Author regex** | Defined once in `arc-repos.json` under `authorRegex`. Currently `fulksjas\|Jason Fulks\|jason.fulks\|JasonMFulks`. |
| **My commit** | `git log --author=<authorRegex>` returning a commit with an author-date timestamp inside the workday (local TZ). |
| **My merged PR** | GitHub PR with `author:@me` AND `mergedAt` inside workday bounds. |
| **My opened PR** | `author:@me` AND `createdAt` inside workday (regardless of later state). |
| **My reviewed PR** | I submitted a review whose `submittedAt` is inside the workday, and I am NOT the PR author. |
| **JIRA transition** | A status change on my ticket recorded inside the workday — use Jira issue history, not just the `updated` field (which can change for non-status edits). |
| **Sprint item completed** | Ticket I was assigned; `resolution` set during the workday; the ticket was in the active sprint at resolution time. |
| **CI failing repo** | For activity date D: `gh run list --branch main --created <=YYYY-MM-DDT23:59:59<tz-offset> --limit 1` returned a run with `conclusion: "failure"`. Retro-safe: works the next morning for yesterday, or weeks later for historical standups. |
| **Sonar quality gate failure** | A SonarQube project whose latest `alert_status` is `ERROR`. Determined by Perch from its live `/api/measures/component` query. |

Any change to a primitive definition requires same-commit updates in every consumer that references it (both `collect-data.sh` scripts, both SKILL.md files, Perch's snapshot writer).

## 2. Snapshot storage

**Canonical path:** `~/.claude/snapshots/daily/YYYY-MM-DD.json` where the date is the activity date.

**Storage is per-day flat JSON files.** Skills never touch a database directly. Perch hydrates a LowDB read cache from these files on startup and re-scans them on cache miss; but the files are the source of truth. If LowDB is lost, it rebuilds from the files.

## 3. Schema

Every file conforms to `schemaVersion: 2` below. All fields except `schemaVersion`, `date`, `sources`, and `updatedAt` are optional — absence means "not observed," not "zero."

```json
{
  "schemaVersion": 2,
  "date": "YYYY-MM-DD",
  "dayOfWeek": "Thursday",
  "updatedAt": "ISO-8601 with offset",
  "sources": ["daily-action", "perch-agent", "perch"],
  "warnings": [],

  "activity": {
    "commitsTotal": 0,
    "commitsByRepo": {},
    "prsMerged": 0,
    "prsOpened": 0,
    "prsReviewed": 0,
    "prsOpenNow": 0,
    "linesAdded": 0,
    "linesDeleted": 0,
    "ciFailingRepos": [],
    "confluencePagesTouched": 0
  },

  "jira": {
    "sprintAssignedTotal": 0,
    "sprintAssignedNotDone": 0,
    "transitionsToday": 0,
    "commentsLeft": 0,
    "downloadIssuesOpen": 0,
    "unassignedDefectsOpen": 0
  },

  "plan": {
    "itemsPlanned": 0,
    "priorityStackSize": 0
  },

  "signals": {
    "sprintDrift":       { "status": "OK", "defectPercent": 0 },
    "chronicCarryover":  { "status": "OK", "ticketCount": 0 },
    "staleStack":        { "status": "OK", "itemCount": 0 },
    "stalledBlocker":    { "status": "OK", "stalledDays": 0 },
    "completionTrend":   { "status": "OK", "rolling3Day": 0.0 },
    "finishOverStart":   { "status": "OK", "openPrsCount": 0 },
    "qaRework":          { "status": "OK", "ticketCount": 0 }
  },

  "quality": {
    "sonarQualityGateFailures": 0,
    "sonarProjectsTotal": 0,
    "sonarFailingProjects": []
  },

  "retrospective": {
    "planDate": "YYYY-MM-DD",
    "asOf": "ISO-8601 with offset",
    "derived": {
      "itemsCompleted": 0,
      "completionRate": 0.0,
      "carryoverFromPrev": [],
      "sprintCompletedToday": 0
    },
    "rawInputs": {
      "yesterdayPlanKeys": [],
      "jiraDoneKeys": [],
      "githubMergedPRs": [],
      "sprintDoneKeys": [],
      "sourceFreshness": { "jira": "ok", "github": "ok" }
    }
  }
}
```

`retrospective.derived.completionRate` is `null` (not `0`/`NaN`) when `itemsPlanned === 0`. `retrospective.derived.carryoverFromPrev` is an **array of plan keys** (not a count). The four `derived.*` figures formerly lived at the flat `plan.itemsCompleted/completionRate/carryoverFromPrev` and `jira.sprintCompletedToday` paths (schemaVersion 1); they were relocated here in v2 — see §4 and §9.

Free-text fields (e.g., `plan.dayGoal`, per-signal notes, ticket lists) live only in the markdown outputs — they are not part of the snapshot. Signal blocks keep a `status` plus one scalar (`defectPercent`, `ticketCount`, etc.) so they are chartable.

`warnings[]` is a list of strings. Writers append to it when a data source failed; other writers must never clear it. Example: `"daily-action: jira sprint query failed"`.

## 4. Ownership rules — three disjoint owners

Every field has exactly one owner. No co-ownership. This is what makes re-runs idempotent.

### `/daily-action` owns (intent + retrospective analysis)
- `plan.itemsPlanned`, `plan.priorityStackSize`
- `signals.*` (all seven)
- `jira.sprintAssignedTotal`, `jira.sprintAssignedNotDone`
- `jira.downloadIssuesOpen`, `jira.unassignedDefectsOpen`

### `perch-agent` owns (observation + retrospective — derived from polled source systems)
- `activity.*` — commits, PRs, CI, Confluence (emitted by the poller's deterministic reducer; `agent/snapshotMerger.js`)
- `jira.transitionsToday`, `jira.commentsLeft` (`jira.commentsLeft` is currently a hardcoded `0` placeholder — not yet derived; not displayed)
- `retrospective` — a single object scoring a plan-day's Perch-issued plan against that work's source-system outcomes: `retrospective.derived.{itemsCompleted, completionRate, carryoverFromPrev, sprintCompletedToday}` plus `retrospective.{planDate, asOf, rawInputs}`. **Derived by source-correlation** — current Jira `statusCategory` for the plan keys, merged-PR-by-key, and the resolution-windowed sprint query — NOT by counting `[x]`/`[ ]` in markdown. Recomputable from `rawInputs`; a failed poll omits the affected figure and records `sourceFreshness: failed` rather than asserting a stale value.

> **Supersession note (2026-06, ratified by Jason):** the four completion figures formerly lived at the flat `plan.itemsCompleted/completionRate/carryoverFromPrev` and `jira.sprintCompletedToday` paths and were assigned to `/standup`, "derived from counting `[x]`/`[ ]` in the day's action-plan markdown." That design was never implemented (checkbox-counting is not recomputable from source). It is superseded: **owner** (`/standup` → `perch-agent`), **method** (checkbox-counting → source-correlation), and **location** (flat `plan.*`/`jira.*` → `retrospective.derived.*`) all change. Full design + phasing: Perch `docs/2026-06-18-standup-retrospective-redesign.md`.

### Perch owns (live externally-observed state)
- `quality.sonarQualityGateFailures`, `quality.sonarProjectsTotal`, `quality.sonarFailingProjects[]`

### Shared / protocol bookkeeping
- `schemaVersion`, `date`, `dayOfWeek` — any writer (idempotent; value is deterministic for the date)
- `updatedAt`, `sources` — merge protocol (see §5)
- `warnings[]` — any writer appends; no writer overwrites

**`/standup` is not a snapshot writer** — it reads the snapshot and renders markdown (governed by its SKILL.md, §10); it owns no snapshot field. The three disjoint snapshot owners are `/daily-action`, `perch-agent`, and Perch.

**Rule:** a writer MUST NOT emit any field it does not own. Silence is valid; a wrong assertion is not.

## 5. Merge protocol (all writers)

Atomic nine-step sequence. Every writer — skill agent or Perch — follows this exactly.

```
1. mkdir -p ~/.claude/snapshots/daily/

2. Acquire ~/.claude/snapshots/daily/.lock via exclusive create.
   - In shell: use `mkdir` on a directory named `.lock` (atomic on POSIX)
     OR `(set -o noclobber; echo $$ > .lock)` with trap to release.
   - In Node: open the lockfile with `{ flag: 'wx' }`.
   - If acquisition fails, retry with exponential backoff up to ~2s total.
     If still held, fail loudly with a diagnostic error.

3. Read YYYY-MM-DD.json if present; otherwise start from {}.

4. Deep-merge only the caller's owned fields from §4 into the in-memory
   object. Do not touch any field outside the caller's ownership.

5. Append the caller's name to `sources` (dedupe, preserve insertion order).

6. Set `updatedAt` to now() as ISO-8601 with local offset.

7. Write YYYY-MM-DD.json.tmp with the merged object.

8. Rename YYYY-MM-DD.json.tmp -> YYYY-MM-DD.json.
   (POSIX guarantees atomic rename within the same filesystem.)

9. Release the lock (remove .lock).
```

A crash between steps 7 and 8 leaves the prior state intact. A crash between 8 and 9 leaves the lock held — the next writer's retry + manual cleanup catches it.

## 6. Re-run semantics

Every writer is re-runnable any number of times per activity date. Because ownership is disjoint, a re-run never corrupts another writer's slice.

- **`/daily-action` re-run** (e.g., re-plan after a new assignment): overwrites `plan.itemsPlanned`, `plan.priorityStackSize`, `signals.*`, JIRA open-state counts with fresh values. Does NOT touch `activity.*`, the `retrospective` object, or `quality.*`.

- **`perch-agent` re-run** (continuous poll; the `retrospective` recomputes each morning until fresh): overwrites `activity.*`, `jira.transitionsToday`/`commentsLeft`, and the `retrospective` object (point-in-time recompute from source — current Jira status, merged PRs, resolution-windowed sprint). Does NOT touch `plan.itemsPlanned`, `signals.*`, `jira.sprint*`, or `quality.*`.

- **Perch writes on every successful Sonar fetch**: idempotent overwrite of `quality.*` only. Later writes reflect newer Sonar state; earlier writes are lost on purpose.

- **Order-independent**: any writer may run first for a given date. The file is partial until the others contribute; readers handle missing fields gracefully.

- **Retroactive writes allowed**: any writer may write a snapshot for an arbitrarily old activity date (e.g., running standup on Monday for Friday). No upper limit on lookback.

## 7. Warnings

When a writer tries to gather a data source and fails (JIRA timeout, GitHub rate limit, Sonar 5xx), it SHOULD append a short string to `warnings[]` and continue emitting what it has. Format: `"<writer>: <what failed>"`.

Examples:
- `"perch-agent: jira transitions query failed"`
- `"daily-action: github cli not authenticated for arc-orch-service"`
- `"perch: sonar 503 for arc-record-exchange"`

Warnings are cumulative across re-runs — writers append but never clear, so multiple sessions' failures can coexist. Readers (charts, dashboards) should treat warnings as diagnostic signal and not fail the render.

## 8. Timezone

All workday boundaries are `America/Denver`. Writers running in containers (e.g., Perch in Docker) MUST receive `TZ=America/Denver` via environment variable. `date +%z` and Node `new Date().toISOString()` behave consistently once TZ is set.

Snapshot `date` strings are opaque to downstream readers — no reader should re-interpret them into a different zone. If a Perch instance runs elsewhere, display logic must account for the writer's zone, not the reader's.

## 9. Versioning

`schemaVersion: 2` on every snapshot — bumped from 1 when the four completion figures were relocated into the `retrospective` object and `carryoverFromPrev` changed from a count to a key array (a relocation + type change per the rule below; Perch code already writes `2` at `server/utils/snapshotWriter.ts`). Future schema changes follow semver-ish rules:

- **Additive, backward-compatible** (add an optional field): keep the current `schemaVersion`. Old readers ignore the new field.
- **Renames, removes, relocations, or type changes**: bump the `schemaVersion`. Readers switch behavior on the version. Existing snapshots stay at their written version unless an explicit migration script is run.

Readers MUST check `schemaVersion` and either handle it or warn.

## 10. Out of scope for this contract

- Markdown outputs of `/standup` and `/daily-action` — those remain the primary human-facing artifact and are governed by their respective SKILL.md files, not this contract.
- The `goal-check` skill — it produces period-based scorecards, not daily observations, and is not a snapshot writer.
- Backfill of historical markdown into snapshots — none; accumulation starts from the first day this contract is deployed.
- Retention/compaction of old snapshot files — revisit after a year of accumulation.
