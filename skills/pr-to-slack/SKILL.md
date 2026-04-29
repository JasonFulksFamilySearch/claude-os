---
name: pr-to-slack
description: "Post the current branch's PR to Slack (#arc-team-devs) for team review"
argument-hint: [optional: pablo, olaf — additional reviewers to tag]
---

Launch the `pr-to-slack` agent to post the current branch's PR to Slack for team review.

**Arguments:** `$ARGUMENTS`

Gather PR info, compose the Block Kit message, and send it to #arc-team-devs immediately.
