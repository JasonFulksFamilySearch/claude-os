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

**Send immediately once pre-flight passes — do not ask for approval.** Compose the message and post it.

**Authentication:** This workflow uses the `SLACK_BOT_TOKEN` environment variable provided by the `slack` MCP server config. No webhook file is needed.

## 🚫 Template is fixed — do NOT improvise

The Block Kit layout below is the **single canonical template**. Every PR-to-Slack
post must match it exactly. The following deviations have been observed and are
all forbidden:

- **Do NOT add a 🔍 or any other emoji prefix to the header.** The header is
  `PR #NUMBER: <FULL TITLE VERBATIM>` and nothing else.
- **Do NOT paraphrase, shorten, or strip prefixes/suffixes from the PR title.**
  The header `TITLE` is the exact string returned by
  `gh pr view --json title -q .title`. If `gh` returns
  `Feat: Rename batch state file to _arc_download_state.json (ARC-4480)`,
  that is what goes in the header — including the `Feat:` tag prefix and the
  `(ARC-4480)` ticket suffix.
- **Do NOT append `_AI generated, human reviewed._` or any other AI label to
  the Slack message.** That label belongs on PR review comments, not on Slack
  posts. The Slack post carries no AI attribution footer.
- **Do NOT fall back to a plain-text version if curl is blocked.** The MCP
  `slack_post_message` tool only supports a `text` field — it cannot render the
  `View PR` button or the proper header block. If the curl in Step 6 is denied
  or fails, **STOP** and report the failure to the user with the prepared
  `/tmp/slack-payload.json` path so they can authorize a retry. Do not silently
  degrade the message.

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

### Step 0: Pre-Flight Check (MANDATORY — do this before anything else)

Check for unresolved automated review feedback. If any exists, STOP — do NOT proceed with subsequent steps or post to Slack.

Run these checks in parallel:

1. **Copilot inline comments:**
   ```bash
   gh api repos/{owner}/{repo}/pulls/{pr_number}/comments \
     --jq '[.[] | select(.user.login == "copilot-pull-request-reviewer")] | length'
   ```
   Get the PR number first via `gh pr view --json number -q .number`. Get the repo owner/name via `gh repo view --json owner,name`.

2. **SonarQube issues:** Use `mcp__sonarqube__list_issues` for the current branch if accessible.

**If ANY unresolved Copilot or SonarQube issues exist:**
- List each issue clearly (file, line, description)
- Tell the user: "Pre-flight failed: X automated review comment(s) remain unresolved. Resolve and reply to all of them before posting to Slack."
- **STOP. Do not proceed with Steps 1–6.**

**Only continue to Step 1 when pre-flight passes (zero open issues).**

---

### Step 1: Gather Information

**Important:** Do NOT use compound `cd && git` commands — they trigger a security prompt. Instead, use the `gh` CLI (which infers the repo from git context without needing `cd`) and run git commands via a temp script.

Run these in parallel:

1. `gh pr view --json title,url,body,number,additions,deletions,changedFiles,statusCheckRollup`
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

### Step 4.5: Build the Status Strip (dynamic, not hardcoded)

Compute three live status icons that go into a context block under the reviewer
ping. The icons MUST reflect actual state — never hardcode `✅`.

**Copilot status** — from the same pre-flight query you already ran in Step 0
(count of unresolved `copilot-pull-request-reviewer` inline comments):

| Count | Icon |
|-------|------|
| 0     | ✅   |
| ≥1    | ❌   |

(Pre-flight blocks the post if count ≥ 1, so this should always be ✅ in
practice — but compute it from the live count, not from an assumption.)

**SonarQube status** — read the latest top-level PR comment authored by
`sonarqube-familysearch-integration` via
`gh api repos/{owner}/{repo}/issues/{pr_number}/comments --jq '[.[] | select(.user.login == "sonarqube-familysearch-integration")] | last | .body'`
and look for the phrase `Quality Gate passed` or `Quality Gate failed`.

| Body phrase             | Icon |
|-------------------------|------|
| `Quality Gate passed`   | ✅   |
| `Quality Gate failed`   | ❌   |
| neither / no comment    | ❓   |

**CI status** — aggregate `statusCheckRollup` from the Step 1 `gh pr view` call.
Use `jq -r 'map(.conclusion // .status) | unique'` to collapse the array:

| Aggregated states                                              | Icon |
|----------------------------------------------------------------|------|
| all `SUCCESS` (or `NEUTRAL`)                                   | ✅   |
| any `FAILURE`, `CANCELLED`, `TIMED_OUT`, or `STARTUP_FAILURE`  | ❌   |
| any `IN_PROGRESS`, `QUEUED`, `PENDING`, or `null`              | 🟡   |
| empty array (no checks configured)                             | ❓   |

**Strip text** (passed to the new context block in Step 5):

```
Copilot <copilot_icon> · SonarQube <sonarqube_icon> · CI <ci_icon> — ready for review.
```

Substitute the three icons computed above. Use the literal middle-dot `·` (U+00B7),
not `|` or `-`.

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
        "text": "PR #NUMBER: TITLE"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "<@REVIEWER_IDS> I have a REPO_NAME PR ready for review."
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "STATUS_STRIP"
        }
      ]
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

1. **Header block** (`plain_text`, max 150 chars): `PR #NUMBER: TITLE` — no leading emoji; `TITLE` is the full string from `gh pr view --json title -q .title`, including any conventional-commit prefix (`Feat:`, `Fix:`, `Chore:`) and any trailing ticket parenthetical (`(ARC-XXXX)`). Do not edit the title.
2. **Section block** (reviewer line, `mrkdwn`): All `<@SLACK_ID>` mentions, then `I have a REPO_NAME PR ready for review.` — substitute `REPO_NAME` with the derived display name from Step 1. The "all issues resolved" assurance now lives in the status strip below; do not repeat it here.
3. **Context block — status strip** (`mrkdwn`, small gray text): The exact string built in Step 4.5 — `Copilot <icon> · SonarQube <icon> · CI <icon> — ready for review.` with the three icons substituted from live data. Never hardcode the icons.
4. **Divider block**: Visual separator — no content needed
5. **Section block + button accessory** (`mrkdwn`): Your generated summary from Step 4. The green "View PR" button links to the PR URL.
6. **Context block — footer** (`mrkdwn`, small gray text): Build the metadata line based on whether a JIRA ticket was found:
   - **With JIRA ticket:** `📌 <https://icseng.atlassian.net/browse/TICKET|TICKET> · \`BRANCH_NAME\` · N files changed (+ADDITIONS −DELETIONS)`
   - **Without JIRA ticket:** `📌 \`BRANCH_NAME\` · N files changed (+ADDITIONS −DELETIONS)`
7. **Root `text` field** (plain string): `PR #NUMBER: TITLE — review requested` — this is the fallback shown in push notifications and screen readers

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

**Do not fall back to `mcp__slack__slack_post_message`.** That tool only accepts
a `text` field and cannot send the header block, the divider, or the green
"View PR" button accessory — using it produces a degraded post that violates
the canonical template. If curl is denied by the harness, the prepared payload
is still on disk at `/tmp/slack-payload.json`; stop and report so the user can
authorize the curl manually or grant the Bash permission.

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
