---
name: prd-to-jira
disable-model-invocation: true
description: Convert a local PRD markdown file into a JIRA issue with implementation work packages as sub-tasks in the ARC project. Use when user has a completed PRD and wants to push it into JIRA as an Epic, User Story, or Defect.
allowed-tools: Read, Glob, Grep, AskUserQuestion, mcp__atlassian__getVisibleJiraProjects, mcp__atlassian__getJiraProjectIssueTypesMetadata, mcp__atlassian__getJiraIssueTypeMetaWithFields, mcp__atlassian__createJiraIssue, mcp__atlassian__getJiraIssue, mcp__atlassian__editJiraIssue
argument-hint: <path/to/prd.md>
---

# PRD to JIRA

You are converting a local PRD file into a JIRA issue with sub-tasks in the ARC project.

## Step 1: Read the PRD

Read the file at `$ARGUMENTS`. If no argument provided, search the current directory for the most recent `*.md` file that contains a `## Problem Statement` or `## Solution` section.

If no PRD file is found, tell the user and stop.

## Step 2: Ask Issue Type

Ask the user which JIRA issue type this PRD should become:

- **Epic** — large initiative that spans multiple stories
- **User Story** — a single deliverable feature or change
- **Defect** — a bug or broken behavior that needs fixing

## Step 3: Validate JIRA Metadata

Run these MCP calls to confirm field requirements:

1. `getJiraProjectIssueTypesMetadata` — confirm the chosen issue type exists in ARC
2. `getJiraIssueTypeMetaWithFields` — get required fields for that type

## Step 4: Create the Parent Issue

Map PRD sections to the JIRA description using the team's formatting conventions:

**Summary:** Derive from the Problem Statement — noun-phrase or action for User Story, component-impact pattern for Defect, short initiative name for Epic. Keep under 80 characters.

**Description:** Assemble from the PRD using `## Heading` structure:

```
## Problem

[Problem Statement section content]

## Solution

[Solution section content]

## Implementation Decisions

[Implementation Decisions section content]

## Testing Decisions

[Testing Decisions section content]

## Acceptance Criteria

[Derive from the PRD's User Stories section. Convert each user story into a verifiable checklist item that a Product Owner can accept or reject against.]

- [ ] [User-facing behavior derived from user story 1]
- [ ] [User-facing behavior derived from user story 2]
- [ ] ...

## Out of Scope

[Out of Scope section content]

## Further Notes

[Further Notes section content — omit if empty]
```

**Priority:** Ask the user (P1, P2, P3) for User Story and Defect. Leave unset for Epic.

**Labels:** Apply `ARC-backlog` to the parent issue.

Create the issue with `createJiraIssue` in project ARC.

## Step 5: Derive Sub-Tasks from Implementation Work

Sub-tasks represent **technical work packages**, not user stories. Derive them from the PRD's `## Implementation Decisions` and `## Testing Decisions` sections — NOT from `## User Stories`.

Each sub-task should be:
- A discrete unit of work one person can own
- Estimable in hours or days
- Independently completable and verifiable
- Verb-first summary format (team convention)

**How to derive sub-tasks:**

1. Read the `## Implementation Decisions` section. Group related decisions into work packages by module or component. Each work package becomes a sub-task.
2. Read the `## Testing Decisions` section. Each testable module becomes a testing sub-task.
3. Cross-reference `## User Stories` to verify coverage — every user story should be fulfilled by at least one sub-task, but the mapping is many-to-one (multiple user stories covered by a single implementation sub-task).

**Example derivation:**
- 15 user stories about download progress, error display, retry behavior, cancel flow
- Implementation Decisions mentions: progress tracking component, error handler refactor, retry strategy module
- Result: 5 sub-tasks — "Implement progress tracking component", "Refactor error handler for structured display", "Add retry strategy with exponential backoff", "Implement cancel flow with status propagation", "Write integration tests for download lifecycle"

**For each sub-task:**

1. **Summary:** Verb-first action (e.g., "Implement X", "Refactor Y", "Write tests for Z")

2. **Description:**
   ```
   ## Summary

   [What this work package delivers and why]

   ## Scope

   - [Specific changes or modules involved]
   - [Key decisions from Implementation Decisions that apply]

   ## Acceptance

   - [How to verify this sub-task is done]
   - [Which user stories this fulfills — by description, not by number]

   ## Definition of Done

   - [ ] Code reviewed and approved
   - [ ] Tests passing
   - [ ] Deployed to dev
   ```

3. **Priority:** Leave as None (inherits from parent).

4. Create with `createJiraIssue`, setting `parent` to the issue key from Step 4.

**Present the proposed sub-tasks to the user for approval before creating them.** Show the list with summaries and which user stories each covers. The user may merge, split, or remove sub-tasks before they hit JIRA.

## Step 6: Present Results

Show the user:

1. Parent issue key and URL
2. Count of sub-tasks created
3. List of sub-task keys and summaries

## Rules

- Always use `mcp__atlassian__` prefix (never `mcp__claude_ai_Atlassian__`).
- Always include `fields` param when fetching issues.
- Never create labels — use existing labels only.
- Issue type in ARC is `"User Story"` (not `Story`).
- Sub-Task summaries are verb-first actions.
- Fetch before editing — never edit blind.
- Do NOT include file paths or code snippets in JIRA descriptions (they go stale).
- Do NOT put ticket numbers in any code comments (Rule 6).
