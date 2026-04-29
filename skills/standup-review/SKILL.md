---
name: standup-review
description: "Review recent standup reports against sprint goals and Scrum best practices — evaluates sprint alignment, report quality, continuity across days, and provides actionable improvement suggestions. Use when the user invokes /standup-review."
argument-hint: <period> (e.g., "2w", "1m", "2026-03-24 to 2026-04-07" — default: 2w)
---

Launch the `standup-review` agent to review standup reports.

**Period:** `$ARGUMENTS`

Load the current sprint from JIRA, read standup reports for the period, evaluate sprint alignment and report quality, and produce a review with recommendations.
