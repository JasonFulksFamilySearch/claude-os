---
name: standup
description: "Generate a standup script using the Scrum 3-question format by analyzing git history, PRs, JIRA activity, and team contributions across repos"
argument-hint: <date> (e.g., "tomorrow", "2026-03-20", "Friday")
---

Launch the `standup` agent to generate a standup script.

**Standup date:** `$ARGUMENTS`

Gather all data sources (git, GitHub PRs, JIRA, Confluence, action-plan files), correlate activity, and produce the standup script.
