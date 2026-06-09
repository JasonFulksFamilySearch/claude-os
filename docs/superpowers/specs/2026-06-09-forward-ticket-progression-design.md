# Forward Ticket Progression — Per-PR Tier (Design)

- **Date:** 2026-06-09
- **Status:** Approved for implementation (test-drive)
- **Authors:** Willis, with Jason

## Context

The ARC ticket lifecycle (per `~/.claude/rules/jira-workflow.md`) is:

- **Simplified** (Epic / Story / Task / Sub-Task / Enhancement): `To Do → In Progress → In Test → In Selloff → Done`
- **Defect / Sighting**: `Open → In Progress → Resolved → Closed`

An audit of the skill ecosystem (2026-06-09) found that **almost none of these transitions are automated**:

| Transition | Trigger | Owned by a skill? |
|---|---|---|
| To Do → In Progress *(story/subtask)* | work starts | ✅ `investigate` (added 2026-06-09) |
| Open → In Progress *(defect)* | work starts | ✅ `investigate` |
| **In Progress → In Test** | PR merged | 🔴 nobody |
| **In Progress → Resolved** *(defect)* | fix merged | 🔴 nobody |
| In Test → In Selloff | release staging | 🔴 nobody |
| In Selloff → Done | post-release | 🔴 nobody |
| Resolved → Closed *(defect)* | verified | 🔴 nobody |

`/commit` is git-only (`allowed-tools: Bash(git *)`); it never touches Jira. `/ship` stops at
"PR up, CI green, awaiting review" and does not merge or transition. `investigate` anchors the
*start* of work; nothing anchors progression after it.

The transition pattern itself (fetch status → confirm the move is workflow-legal → transition →
audit comment → fail-soft) currently exists as ~40 inline lines inside `investigate`. Adding more
transitions naively would duplicate that pattern across skills, where it would drift.

## Goals

1. Close the **per-PR tier**: automate `In Progress → In Test` (Simplified) and
   `In Progress → Resolved` (Defect), fired at **PR merge** — the developer's terminal action.
2. Establish a **single shared transition procedure** so guard logic is written once, and
   retrofit `investigate` onto it to collapse the existing duplication.

## Non-goals (deferred)

- **Release-tier transitions** (`In Test → In Selloff`, `In Selloff → Done`, `Resolved → Closed`).
  These assert real-world facts ("staged", "deployed", "verified") that are unsafe to fire
  silently; they belong in a later, confirmation-gated design owned by `/arc-release`.
- **Parent-story roll-up.** When a *sub-task's* PR merges, only that sub-task advances. Moving the
  parent story to In Test requires judging whether *all* siblings are done — deferred (mirrors the
  "advance what you point at" rule `investigate` already follows).
- Any write to ticket *content* (description, fields). Transitions + a one-line audit comment only.

## Architecture

Three components. All live in the genome (`~/.claude-os/`).

### Component 1 — Shared "Advance Ticket" procedure (in the `jira` skill)

Add one canonical, parameterized procedure to `~/.claude-os/skills/jira/SKILL.md`:

> **Advance Ticket → ⟨target status⟩**
> **Inputs:** ticket key, target status, optional audit-comment text.
> 1. Fetch the ticket's current status and issue type.
> 2. **Workflow-detect & legality:** Simplified transitions are globally available; for
>    Defect/Sighting, validate the target is offered by `getTransitionsForJiraIssue` from the
>    current state. Resolve the transition by name (CLI) or dynamically-resolved id (MCP) — never
>    a hardcoded id.
> 3. **Idempotent / no-backward:** if the ticket is already at or past the target status, skip
>    (no transition, no comment) and report "already at/past target".
> 4. Transition.
> 5. Leave a one-line audit comment (work-tracking, not content).
> 6. **Fail-soft:** never throw. On any failure (401/403, illegal transition, network), return a
>    structured outcome (`transitioned` / `skipped:<reason>` / `failed:<reason>`) so the caller
>    continues.

This is the single source of truth for the guard logic. The `jira` skill is already the
"deterministic Jira reference," so this fits its charter.

### Component 2 — Retrofit `investigate`

`investigate` Step 2 ("Mark Work Started") currently inlines the transition. Replace that inline
block with a call to **Advance Ticket → In Progress** (its sub-task→parent-story bump and its
report annotations stay). Net effect: the duplication created on 2026-06-09 is collapsed into the
shared procedure rather than multiplied.

### Component 3 — Detection-based merge transition (new background write-job)

A **new** background skill — separate from `background-pr-digest`, which is read-only by charter
("never transitions tickets") and must stay that way.

- **Trigger / cadence:** runs on a cron schedule (registered via `/schedule`). Recommended
  cadence: every 30–60 minutes on weekdays (merge → In Test should not wait a day, unlike the
  daily digests). Cadence is a tunable, not load-bearing.
- **Detection:** query GitHub for recently-merged PRs on ARC repos **authored by Jason** within a
  lookback window that comfortably exceeds the cadence (overlap is safe — see idempotency). Use
  `gh pr list --state merged --author @me --json ...` style queries. (Author filter scopes the
  scan to Jason's own work — the common author-and-merge case; the assignee guard below is the
  independent safety net that prevents touching anyone else's ticket.)
- **Mapping:** extract the ARC ticket key from the branch name / PR title (same extraction
  `/commit` uses: `feat/ARC-1234-... → ARC-1234`).
- **Action:** for each merged PR's ticket, call **Advance Ticket** with the issue-type-appropriate
  target: `In Test` for Simplified, `Resolved` for Defect. Audit comment: e.g.
  `"PR #<n> merged — moved to In Test."`

**Guards:**
- ARC tickets only.
- Assigned to Jason only (never touch a teammate's ticket).
- Forward-only + idempotent (Advance Ticket skips if already at/past target — so re-scanning the
  same merged PR is a no-op).
- Audit comment on every actual transition.
- Fail-soft per ticket: one ticket's failure never aborts the batch.

**Autonomy note:** this is the one component that writes to Jira with no human in the loop. The
guards keep a misfire both unlikely and cheap — a wrong status move is trivially reversible and
leaves an audit comment explaining itself. This is the deliberate trade for honoring "beyond
merge I can't do anything."

## Data flow

```
Jason merges PR (gh CLI or GitHub UI)
        │
        ▼
[Component 3] background scan (cron)
   detects merged ARC PR by Jason
   extracts ARC-#### from branch/title
        │
        ▼
[Component 1] Advance Ticket → (In Test | Resolved)
   fetch status/type → legality → idempotency → transition → audit comment → fail-soft
        │
        ▼
Board reflects "ready for test" without further action from Jason
```

`investigate` (front of loop) and Component 3 (after merge) now both route through Component 1.

## Error handling & correctness

- **Idempotency** is the backbone: because Advance Ticket no-ops when already at/past target, the
  detection job's overlapping lookback windows cannot double-transition or double-comment.
- **Workflow legality** is enforced centrally in Component 1 — Defect transitions are validated
  against live `getTransitionsForJiraIssue` results, so the state-specific defect machine is never
  violated.
- **Fail-soft everywhere:** a Jira outage degrades to "noted, continue" — it never breaks the
  developer's flow or the background batch.

## Blast radius — genome

Every file changed here lives in `~/.claude-os/` (a git repo, the shared genome between Willis and
Walter, propagated via `/transmit-claude-os`). Implications:

- Changes need Jason's explicit go-ahead to commit, and propagate to Walter on assimilate.
- The 2026-06-09 `investigate` edit and this spec are already uncommitted in the genome.

## Verification

1. **Procedure-level (Component 1):** run Advance Ticket against — a To Do ticket (transitions);
   an already-In-Progress ticket (idempotent no-op); a Done/Closed ticket (no backward move); a
   Defect (validates the defect workflow path).
2. **Retrofit (Component 2):** re-run `/investigate` on a To Do subtask; confirm identical
   behavior to the inline version (subtask + parent → In Progress, audit comment, report
   annotation) now that it routes through the shared procedure.
3. **End-to-end (Component 3):** merge a throwaway PR tied to a test ticket; confirm the ticket
   lands In Test with a `"PR #n merged"` audit comment, and that a second scan is a no-op.
4. **Defect path:** repeat (3) with a Defect-type ticket; confirm it lands Resolved.

## Open / tunable details (for the plan, not blockers)

- Exact detection cadence and lookback window.
- Whether the detection job also surfaces a summary line into the existing digest queue (read-only)
  for visibility, while keeping the *write* in the separate job.
- Naming of the new background skill (e.g. `background-merge-progression`).
