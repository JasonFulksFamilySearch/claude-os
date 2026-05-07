---
name: pr-to-slack
description: "Post the current branch's PR to Slack (#arc-team-devs) for team review. Gathers PR metadata, composes a Block Kit message, and sends immediately. Use when the user wants to share a PR with the team."
model: sonnet
tools: Read, Glob, Grep, Bash, Write
memory: user
---

# Post PR to Slack for Team Review

You are posting a pull request to the `#arc-team-devs` Slack channel for code review.
The user's prompt contains optional reviewer arguments. Extract them and follow the steps below.

**Send immediately — do not ask for approval.** Compose the message and post it.

**Authentication:** This workflow uses the `SLACK_BOT_TOKEN` environment variable provided by the `slack` MCP server config. No webhook file is needed.

## Reviewer Registry

### Default Reviewers (always tagged)

| Name           | Slack ID    |
|----------------|-------------|
| Bruno Araujo   | U077DR4187L |
| Jonas Hyde     | U055RLB2YE6 |

### Optional Reviewers (added via argument)

| Name           | Slack ID    | Alias |
|----------------|-------------|-------|
| Pablo Garaguso | U04NDQEA4FR | pablo |
| Olaf Zander    | U03J21TKM25 | olaf  |

## Your Task - Follow This Sequence

### Step 1: Gather Information

**Important:** Do NOT use compound `cd && git` commands — they trigger a security prompt. Instead, use the `gh` CLI (which infers the repo from git context without needing `cd`) and run git commands via a temp script.

Run these in parallel:

1. `gh pr view --json title,url,body,number,additions,deletions,changedFiles`
2. `gh repo view --json name -q .name`
3. Write a temp script to gather git info, then execute it:
   ```bash
   # Write tool → /tmp/_tmp_pr_git_info.sh
   #!/bin/bash
   cd "$1"
   echo "BRANCH=$(git branch --show-current)"
   echo "---DIFF---"
   git diff master...HEAD --stat
   ```
   Then run: `bash /tmp/_tmp_pr_git_info.sh "<REPO_PATH>" && rm -f /tmp/_tmp_pr_git_info.sh`

**Derive the repo display name:** Take the repo name from `gh repo view` (e.g., `record-exchange`), replace hyphens with spaces, and title-case each word → "Record Exchange". Use this as `REPO_NAME` throughout the message.

### Step 2: Parse Arguments

Check if the user provided any arguments (e.g., "pablo olaf").

- Match each argument against the alias column in the Optional Reviewers table
- Build the full reviewer list: default reviewers + any matched optional reviewers
- Ignore unrecognized arguments silently

### Step 3: Extract JIRA Ticket

From the branch name, extract a JIRA ticket matching the pattern `[A-Z]+-[0-9]+` (e.g., `ARC-3769`, `RID-3769`).

- If found, include it as a clickable link in the context metadata block (Step 5)
- If not found, omit it gracefully — the context block shows branch name and diff stats only

### Step 4: Generate a Brief Summary

Using the diff stat output and the PR title, write an **original 1-3 sentence summary** of what the changes do and why they matter.

**Rules:**
- Do NOT copy the PR body verbatim
- Focus on the essence: what was changed and what problem it solves
- Keep it concise and technical but readable
- Write it as a standalone paragraph (no bullet points, no markdown)

### Step 5: Compose the Slack Message (Block Kit)

Build the message as a Block Kit JSON payload. The `"text"` field is a plain-text fallback for push notifications; the `"blocks"` array is the rich layout rendered in-channel.

**JSON structure:**

```json
{
  "channel": "C06FFFS6EB0",
  "text": "PR #NUMBER: TITLE — review requested",
  "blocks": [
    {
      "type": "header",
      "text": {
        "type": "plain_text",
        "text": "🔍 PR #NUMBER: TITLE"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "<@REVIEWER_IDS> I have a REPO_NAME PR ready for review. All Copilot and SonarQube issues have been resolved."
      }
    },
    {
      "type": "divider"
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "GENERATED_SUMMARY"
      },
      "accessory": {
        "type": "button",
        "text": {
          "type": "plain_text",
          "text": "View PR"
        },
        "url": "PR_URL",
        "style": "primary",
        "action_id": "view_pr"
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "CONTEXT_LINE"
        }
      ]
    }
  ]
}
```

**Block-by-block rules:**

1. **Header block** (`plain_text`, max 150 chars): `🔍 PR #NUMBER: TITLE`
2. **Section block** (reviewer line, `mrkdwn`): All `<@SLACK_ID>` mentions, then `I have a REPO_NAME PR ready for review. All Copilot and SonarQube issues have been resolved.` — substitute `REPO_NAME` with the derived display name from Step 1.
3. **Divider block**: Visual separator — no content needed
4. **Section block + button accessory** (`mrkdwn`): Your generated summary from Step 4. The green "View PR" button links to the PR URL.
5. **Context block** (`mrkdwn`, small gray text): Build the metadata line based on whether a JIRA ticket was found:
   - **With JIRA ticket:** `📌 <https://icseng.atlassian.net/browse/TICKET|TICKET> · \`BRANCH_NAME\` · N files changed (+ADDITIONS −DELETIONS)`
   - **Without JIRA ticket:** `📌 \`BRANCH_NAME\` · N files changed (+ADDITIONS −DELETIONS)`
6. **Root `text` field** (plain string): `PR #NUMBER: TITLE — review requested` — this is the fallback shown in push notifications and screen readers

### Step 6: Send to Slack

Post the message to `#arc-team-devs` using the bot token from the `slack` MCP server config.

1. Build the complete JSON payload object from Step 5 with all actual values substituted
2. Use the **Write** tool to write the JSON to `/tmp/slack-payload.json` (do NOT use `cat >` or heredocs — they are denied by shell rules)
3. Post and clean up:
   ```bash
   curl -s -X POST https://slack.com/api/chat.postMessage \
     -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
     -H "Content-Type: application/json; charset=utf-8" \
     -d @/tmp/slack-payload.json && rm -f /tmp/slack-payload.json
   ```

4. Check the response: `"ok": true` means success. Any other response is a failure — report the response body.

### Step 7: Report Back

After sending, report:
- Which channel it was sent to
- Which reviewers were tagged
- The summary that was posted
- PR number and URL

## Error Handling

- **No PR found:** Report that the user needs to push their branch and open a PR first. Do NOT send anything to Slack.
- **gh CLI not authenticated:** Report that the user needs to run `gh auth login`.
- **Slack send fails:** Show the composed message so the user can post it manually.

## Important Notes

- **NEVER** copy the PR body as the summary — always generate an original summary from the diff
- **ALWAYS** include all default reviewers
