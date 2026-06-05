# Phase 3 — Jira write guardrails

Applied only **after per-ticket human approval** (see SKILL.md → THE HARD GATE). These make the
approved writes *correct*.

## ADF requirements

- **Description** and **Acceptance Criteria** require an **ADF document** value on `editJiraIssue`
  (a plain/markdown string is rejected: *"Operation value must be an Atlassian Document"*).
- **Acceptance Criteria field = `customfield_10085`.**
- **Comments** (`addCommentToJiraIssue`) accept markdown; the converter may nest a line under a
  preceding bullet (cosmetic only).

## Banner + inline-media preservation (description rebuilds)

Never overwrite a reporter's description wholesale. **Prepend** the new structured sections under
any existing coordination banner (e.g. "⚠️ Coordinated under ARC-XXXX …"), then **retain the
original reporter content — including inline attachment/media nodes — verbatim** under a
"## Background — original report" heading. First fetch the current description as ADF
(`getJiraIssue`, `responseContentFormat: "adf"`) so media nodes can be carried across. If a media
node cannot be preserved, **stop and report** rather than posting a description that drops it.

## Workflow validation (status transitions)

ARC has **two disjoint state machines — never apply a transition from the wrong one:**

- **Simplified** (Epic / User Story / Task / Sub-Task / Enhancement): `To Do`, `In Progress`,
  `In Test`, `In Selloff`, `Done`, `Cancelled`.
- **Defect** (Defect / Sighting): `Open`, `Need More Information`, `Reopened`, `In Progress`,
  `Resolved`, `Closed`.

Before transitioning: confirm the issue type → pick the matching machine → confirm the current
status is valid for the requested transition. Transition IDs / status IDs live in
`~/.claude-data/context/jira.md`. Do **not** move a Defect to `Resolved` without a verified merged
fix in hand. Preserve, don't silently override, "Coordinated under ARC-XXXX" notes.

## Issue links

`createIssueLink` types used here: `Relates`, `is caused by` (e.g. a defect ← the PR/story that
introduced it), `Duplicate`. Links are gated like every other write — no batching without approval.

## Reassignment

Only when the verdict establishes a different owner (e.g. a backend root cause → the owning team).
Gated; never silent.

## Per-ticket gate presentation

For each ticket, present: verdict + one-line evidence; then each proposed write as its own
approve / skip / edit item (comment, description, AC, transition, link, reassignment). Apply only
the approved items, then record what was applied (with comment IDs / new status) in the run doc and
move to the next ticket. Reusable field facts and the ADF quirk are also in the auto-memory
reference `arc-jira-acceptance-criteria-field`.
