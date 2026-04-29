---
name: investigate
context: fork
model: opus
description: Deep investigation of a JIRA ticket — fetches issue context, explores
  relevant code, and assesses confidence before implementation begins. Reduces
  guess-and-check churn by doing thorough upfront research.
argument-hint: <TICKET> (e.g., ARC-3977)
---

# Investigate JIRA Ticket

You are performing a deep investigation of a JIRA ticket before any code changes begin. The goal is to gather enough context to implement a high-confidence fix or feature — avoiding repeated guess-and-check cycles.

## Input

The user provides a JIRA ticket key as the argument (e.g., `ARC-3977`). Extract it from `$ARGUMENTS`.

Ticket: **$ARGUMENTS**

## Step 1: Fetch JIRA Context

Use MCP tools (prefix: `mcp__atlassian__`) with `cloudId: "icseng.atlassian.net"`.

1. **Fetch the main ticket:**
   ```
   getJiraIssue(issueIdOrKey: "<TICKET>", fields: ["summary", "description", "status", "assignee", "priority", "parent", "issuelinks", "created", "updated", "subtasks", "labels", "components"])
   ```

2. **Fetch subtasks** (if any exist in the response):
   ```
   searchJiraIssuesUsingJql(jql: "parent = <TICKET>", fields: ["summary", "status", "assignee", "priority"])
   ```

3. **Fetch linked issues** (if issuelinks exist):
   For each linked issue, note the link type and key. Fetch critical ones if they provide context (e.g., "is caused by", "blocks").

4. **Extract key information:**
   - What is the problem or feature request?
   - What are the acceptance criteria (if any)?
   - What components/areas are mentioned?
   - What is the current status?
   - Are there subtasks already defined?

## Step 2: Explore Relevant Code

Based on the ticket description, summary, and any component/file references:

1. **Launch up to 3 Explore agents IN PARALLEL** to search the codebase:
   - Agent 1: Search for files, functions, and classes directly mentioned or implied by the ticket
   - Agent 2: Search for related patterns, error codes, or symptoms described in the ticket
   - Agent 3 (if needed): Search for test files and existing test coverage for affected areas

2. **For each relevant file found**, note:
   - File path and purpose
   - Key functions/methods involved
   - Current behavior vs. expected behavior (if a bug)
   - Dependencies and callers

## Step 3: Assess Confidence

Rate your confidence that you have enough information to implement correctly:

- **High** — Clear problem, identified root cause or implementation path, relevant code located, edge cases understood
- **Medium** — Problem understood but some ambiguity remains (e.g., unclear edge cases, multiple possible approaches, need to verify assumptions)
- **Low** — Significant unknowns (e.g., can't reproduce from description, missing context, affected code not found, need clarification from ticket author)

## Step 4: Present Investigation Report

Output a structured report using this format:

```
## Investigation: <TICKET> — <Summary>

### JIRA Context
- **Status:** <status>
- **Priority:** <priority>
- **Parent:** <parent ticket if any>
- **Subtasks:** <list or "None">
- **Linked Issues:** <list or "None">

### Problem Statement
<1-3 sentences describing what needs to happen, extracted from the ticket>

### Relevant Code
| File | Purpose | Key Functions |
|------|---------|---------------|
| ... | ... | ... |

### Analysis
<What you found in the code. For bugs: root cause analysis. For features: where changes are needed and why.>

### Proposed Approach
<Brief description of the implementation strategy>

### Confidence: <High|Medium|Low>
<Explanation of confidence rating. If Medium or Low, list specific gaps or questions that need answers before proceeding.>

### Open Questions
<Numbered list of anything that needs clarification before implementation, or "None — ready to proceed">
```

## Rules

- This is a **read-only investigation**. Do NOT modify any files.
- Follow Rule 4 — always include `fields` param in JIRA calls.
- Follow Rule 6 — no ticket numbers in any code comments if you quote code.
- If the ticket mentions specific files or error codes, prioritize searching for those first.
- If the ticket is vague, say so in the confidence assessment rather than guessing.
