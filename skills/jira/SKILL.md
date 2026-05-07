---
name: jira
description: Deterministic Jira reference — loads all MCP tool names, transition
  IDs, formatting rules, and comment templates for the ARC project in one invocation.
  Use when Jira memory files may not have loaded or when you need a full reference.
---

# Jira — ARC Full Reference

## MCP Prefix
Use `mcp__claude_ai_Atlassian__` exclusively. Both `mcp__atlassian__` (retired plugin) and the UUID prefix (`mcp__c9b44d58-*`) are gone — do not use either.

**cloudId:** `icseng.atlassian.net` — required on every tool call.

## Core Tools
| Tool | Purpose |
|---|---|
| `getJiraIssue` | Fetch — always include `fields` param |
| `searchJiraIssuesUsingJql` | JQL search |
| `editJiraIssue` | Edit — fetch first, never blind |
| `transitionJiraIssue` | Status change — use IDs below |
| `addCommentToJiraIssue` | Comment |
| `createJiraIssue` | Create (run metadata tools first) |
| `createIssueLink` | Link two issues — type="Cloners" for clone links |
| `getTransitionsForJiraIssue` | Get transitions live (fallback when cached IDs fail) |

**Default fields:** `["summary","description","status","assignee","priority","parent","issuelinks","created","updated"]`

## Transitions — Simplified (User Story/Task/Sub-Task/Enhancement)
Global — any status → any status.
11=To Do · 21=In Progress · 31=Done · 81=In Test · 91=In Selloff · 101=Cancelled

## Transitions — Epic (same IDs as Simplified)
11=To Do · 21=In Progress · 31=Done · 81=In Test · 91=In Selloff · 101=Cancelled
Done/Cancelled conditional — may not appear if child issues are unresolved.

## Transitions — Defect/Sighting (state-specific)
From Open/Reopened: 4=Start Progress · 5=Resolve(screen) · 731/721=Request Info
From In Progress: 301=Stop Progress · 5=Resolve(screen) · 711=Request Info
From Resolved: 701=Close(screen) · 3=Reopen(screen)
From Closed: 3=Reopen(screen)
Cached 2026-03-17. On 404 error → call `getTransitionsForJiraIssue` live.

## JQL Defaults
```
project = ARC AND assignee = currentUser() AND statusCategory != Done
project = ARC AND issuetype = Defect AND statusCategory != Done ORDER BY priority ASC
project = ARC AND issuetype = "User Story" AND sprint in openSprints()
parent = ARC-[N]
```
Note: Issue type is `"User Story"` (not `Story`) in ARC.

## Comment Format
Markdown input. ≤150 words. Sections + bullets > prose. No filler openers.
Match Jason's structured style with `## Heading` structure.

**Progress:** ## Status Update → Done / Active / Blocked / Next
**Defect:** ## Root Cause Analysis → Root Cause / Affected / Fix / Verify
**Sub-task done:** ## Completed → Branch + Commit (code fmt) / what / Notes
**Decision:** ## Decision → Decision + by whom / Context / Impact / Date

## Issue Summaries
- User Story: noun-phrase or action
- Defect: component — broke — impact
- Sub-Task: verb-first action

## PR Title
`ARC-### - Short outcome description` (≤60 chars after prefix, from branch name)
Sections: Closes · Problem · Solution · Files changed (4+) · How to verify

## Guardrails
- Fetch before any edit
- Append descriptions, never overwrite
- Existing labels only — never create new
- All JQL scoped to `project = ARC` by default
- Ticket numbers in commits/branches/PRs only (Rule 6)
- Sub-Task priority: leave as None (inherits from parent)
