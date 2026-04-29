---
name: one-on-one
description: "Prepare a 1:1 agenda for a direct report — pulls JIRA sprint work and surfaces open action items from prior sessions"
argument-hint: <name>
---

# 1:1 Prep Skill

You are preparing a structured one-on-one agenda for a direct report. Pull real data from JIRA and their session history — do not fabricate ticket numbers or action items.

## Your Task — Follow This Sequence

### Step 1: Parse the Direct Report's Name

The direct report's name is: `$ARGUMENTS`

- History file path: `~/.claude/one-on-one/$ARGUMENTS.md`
  (normalize to lowercase, spaces replaced with hyphens, e.g., "Alice Smith" → `alice-smith.md`)

### Step 2: Load Session History

Use the **Read** tool to read the history file (if it exists — a missing file is fine, treat as first session).

From the history file extract:
- `jira_account_id` from YAML frontmatter (if present)
- The most recent dated section (largest `## YYYY-MM-DD` date)
- All open action items (`- [ ]` lines) from that most recent section — these carry forward

If no history file exists, skip to Step 3 with no prior action items.

### Step 3: Resolve JIRA Account ID

**If** `jira_account_id` was found in history frontmatter: use it directly, skip the lookup.

**If not:** Call `mcp__atlassian__lookupJiraAccountId` with the person's name to resolve their account ID. Then immediately write it to the history file so future runs skip this step.

If the history file does not exist yet, create it with this structure:
```
---
jira_account_id: <resolved-id>
display_name: <full name from lookup>
---

# 1:1 History: $ARGUMENTS

```

Use the **Write** tool to create the file. Use the **Edit** tool to update frontmatter in an existing file.

### Step 4: Query JIRA (Run Both IN PARALLEL)

Use `mcp__atlassian__searchJiraIssuesUsingJql` for both queries simultaneously.

**Query A — Active sprint work (not done):**
```
project = ARC AND assignee = "<accountId>" AND sprint in openSprints() AND statusCategory != Done ORDER BY status ASC
```

**Query B — Completed this sprint:**
```
project = ARC AND assignee = "<accountId>" AND sprint in openSprints() AND status = Done ORDER BY updated DESC
```

For both queries use:
- `fields`: `["summary", "status", "priority", "issuelinks"]`
- `maxResults`: 20

**Blockers:** From Query A results, identify items where `issuelinks` contains a "is blocked by" link or items whose status has been "In Progress" with no recent movement (use judgment — flag items that look stuck).

### Step 5: Generate and Display the Agenda

Display the agenda to the user using this exact format:

```
# 1:1 Prep — <Name>
**Date:** <today's date, e.g., Monday, April 20, 2026>

---

## Open Action Items
*(from last 1:1 on <date of last session, or "no prior session">)*

- [ ] <item from last session>
- [ ] <item from last session>
*(Leave blank with "None" if no prior session or no open items)*

---

## JIRA Sprint Work

### In Progress
- [ARC-###](https://icseng.atlassian.net/browse/ARC-###) — Summary text

### Completed This Sprint
- [ARC-###](https://icseng.atlassian.net/browse/ARC-###) — Summary text

### Blockers / Stuck
- [ARC-###](https://icseng.atlassian.net/browse/ARC-###) — Summary text *(reason if known)*
*(Leave this section blank with "None identified" if no blockers found)*

---

## Open Floor
*(Their agenda — add their topics here during the meeting)*

-
-
-
```

### Step 6: Offer to Record Notes from the Prior Session

After displaying the agenda, ask:

> **Before we wrap up prep:** Would you like to record notes or close out action items from your *last* session (so the next meeting's prep has a complete history)?
>
> Reply with:
> - **"yes"** — to update action items and add notes from the last meeting
> - **"skip"** — to move on without capturing

**If "yes":**

1. Show the open action items from the last session and ask which are done vs. carry forward:
   > For each open item, reply with `done`, `carry`, or `drop` — or restate the item text to update it.

2. Ask for any free-form notes from the last session:
   > Any notes to record from that meeting? (blockers raised, decisions made, topics discussed)

3. Once you have the updates, append a new dated section to the history file:

```markdown

---

## <last session date, e.g., 2026-04-07>

### Action Items
- [x] <completed item>
- [ ] <carried forward item>

### Notes
<notes the user provided>
```

Use the **Edit** tool to append this block to the history file, placed after the frontmatter/header and before any existing session blocks (newest session first).

**If "skip":** Confirm the agenda is ready and end the skill.

---

## History File Format Reference

Full structure of `~/.claude/one-on-one/<name>.md`:

```markdown
---
jira_account_id: <atlassian-account-id>
display_name: Alice Smith
---

# 1:1 History: Alice Smith

---

## 2026-04-20

### Action Items
- [ ] Follow up on deployment rollback plan

### Notes
Discussed sprint capacity. Alice flagged ARC-2041 as blocked pending design review.

---

## 2026-04-07

### Action Items
- [x] Schedule architecture review with team
- [ ] Investigate ARC-1987 flakiness

### Notes
Good session. Carried forward the ARC-1987 investigation item.
```

---

## Important Notes

- **NEVER** fabricate JIRA ticket numbers or summaries — only use data returned from actual MCP calls
- **NEVER** skip the `fields` parameter on JIRA queries — unscoped responses exceed 12,000 tokens
- **ALWAYS** scope JQL to `project = ARC` unless the person's work clearly spans other projects
- **ALWAYS** store the resolved `jira_account_id` on first run so future sessions skip the lookup
- History file entries go **newest first** — prepend new sessions, don't append
- If JIRA returns no results for a section, display `*None this sprint*` rather than omitting the section
