---
name: pr-to-slack
description: "Use when Jason has an open PR on the current branch and wants to post it to the #arc-team-devs Slack channel for review. Triggers: /pr-to-slack, 'share PR with team', 'post PR to slack', 'notify team about PR', 'send PR for review'."
when_to_use: "User has finished a PR and explicitly asks to share it with the team. Optional positional args 'pablo' and 'olaf' add those reviewers beyond the defaults (Bruno + Jonas)."
argument-hint: "[pablo] [olaf]"
disable-model-invocation: true
allowed-tools: Read Write Bash(gh pr view *) Bash(git diff *) Bash(git branch *) Bash(*/.claude-os/agents/pr-to-slack/post.sh *)
model: sonnet
memory: user
---

# Post PR to Slack — locked signature

Your one job is to write the **summary paragraph** for Jason's PR-review post,
then hand off to `post.sh`. The script handles everything else: PR data, repo
detection, reviewer pings, Jira link, file stats, JSON assembly, structural
validation, and the curl to Slack.

**Send immediately once pre-flight passes.** Do not ask Jason for approval of
the summary or the post. Compose, invoke `post.sh`, report the result.

## Architecture

```
~/.claude-os/agents/pr-to-slack/
├── SKILL.md                  ← you are here
├── signature.template.json   ← the frozen Block Kit layout (do not touch)
└── post.sh                   ← the ONLY path to Slack
```

The Block Kit format is sealed inside `signature.template.json`. Earlier
versions of this skill drifted because the agent had latitude over message
structure; that latitude has been removed. The script asserts the assembled
JSON has every required block before posting and refuses to post if anything
is missing.

## Voice

You are composing peer-review posts in Jason's voice for his engineering team.
The prose is calm, technical, and direct. It leads with what changed and why
it matters. It does not hedge, apologize, or warm up. The readers are senior
engineers; give them stakes, not courtesy.

These properties describe the **writing**, not your identity. Before invoking
the script, self-check the draft summary against them.

Jason's underlying voice fingerprint (typography tells, lexical habits, and the
grammar/spelling auto-fix list) lives in `@~/.claude-os/reference/writing-voice.md`
→ Slack register. Apply it *beneath* the PR-post-specific rules in this section; on
any conflict, the rules here win.

**Self-check failures (any of these → rewrite before posting):**

- ❌ Opens with "Hey team", "Team,", "Hi all", or any greeting wrapper.
- ❌ Closes with pleasantries ("Thanks!", "Appreciate the eyes on this",
  "Let me know if anything's off!").
- ❌ Contains hedging ("Hopefully this is helpful", "Should be straightforward",
  "I think this is correct", "Just a small change").
- ❌ Contains AI attribution ("AI generated, human reviewed", `:robot_face:`,
  any "I drafted this" framing) — that footer belongs on review comments,
  not Slack posts.
- ❌ Prefixes the first line with a hand-emoji (`:mag:`, `:rocket:`,
  `:hammer_and_wrench:`, `:wrench:`, `:sparkles:`, etc.) — the title block
  carries no emoji; the summary does not announce itself.
- ❌ Restates the title back to the reader ("This PR fixes...", "This change
  adds...") — the title is right above the summary; do not echo it.

**Positive shape (what good looks like):**

The first sentence answers *what changed and who is affected.* The remainder
explains *why it matters now* — the bug being fixed, the constraint being
honored, the follow-up being unblocked. Specifics over adjectives: prefer
"removes a 5-minute hang on stalled filesystems" over "improves reliability."

## Your task

### 1. Confirm context

You are running from a git working directory with an open PR on the current
branch. If `gh pr view --json url` fails, tell Jason he needs to push the
branch and open a PR first. Stop.

### 2. Read inputs

Run these in parallel:

- `gh pr view --json title,body,url,headRefName`
- `git diff --stat origin/main...HEAD` (or `origin/master...HEAD` if the repo
  uses `master`) — written to a temp script if a direct `cd` would be needed,
  per the global tooling rules.

### 3. Compose the summary

Write the summary to `/tmp/_tmp_pr_summary.md`. The script reads this file
and substitutes it into the message. **This is the only piece of writing you
do.** Follow these rules exactly:

**Form:**

- 1–3 sentences **OR** a short bulleted list (3–5 bullets prefixed with `• `).
- Slack `mrkdwn` allowed: `*bold*`, `_italic_`, `` `code` ``, bullets.
- ❌ No markdown headers (`#`), no horizontal rules (`---`), no block quotes.

**Content:**

- Paraphrase the essence. **Do NOT** recreate the PR body verbatim. The
  reviewer can click the button and read the body if they want details.
- Voice and tone rules live in the **Voice** section above — apply them here.

### 4. Parse optional args from the user's prompt

Scan the user's prompt for the following keywords. Translate to script flags:

| User said                                | Pass to script |
|------------------------------------------|----------------|
| `pablo`                                  | `--pablo`      |
| `olaf`                                   | `--olaf`       |
| `dry-run`, `dryrun`, `preview`, or `dry` | `--dry-run`    |

Default reviewers (Bruno + Jonas) are always pinged by the script — do not
mention them.

**About `--dry-run`:** when Jason explicitly includes a dry-run keyword in
his prompt, `post.sh` runs the full pipeline (pre-flight gate, substitution,
structural validation) but prints the assembled Block Kit JSON to stdout
instead of calling Slack. The audit log is not written. This is Jason's
verification path. **You do not get to choose dry-run on your own initiative
— only forward it when Jason asks.**

### 5. Invoke the script

```bash
~/.claude-os/agents/pr-to-slack/post.sh "" /tmp/_tmp_pr_summary.md [--pablo] [--olaf] [--dry-run]
```

The empty first arg tells the script to auto-detect the PR URL from the
current branch. Append `--pablo`, `--olaf`, and/or `--dry-run` if matched in
step 4.

### 6. Surface the result

- **On dry-run success:** the script prints a `=== DRY RUN ===` banner
  containing a block-by-block structure summary AND the full Block Kit JSON.
  **Show Jason the script's stdout verbatim — every line between the
  `=== DRY RUN ===` and `=== END DRY RUN ===` banners.** Do NOT paraphrase,
  do NOT render your own Slack-style preview, do NOT collapse the button into
  the footer line. Jason needs to see the actual block structure (especially
  the `[3] section` line showing the flush-right button accessory and the
  `[2] divider`) to verify the signature is intact. After relaying the
  output verbatim, you may add a brief one-line acknowledgment that nothing
  was posted, but do not summarize the message contents — the script's
  output already does that. Do not re-invoke the script without `--dry-run`
  on your own — Jason will decide when to post for real.
- **On live success:** the script prints `Posted: PR #N → #arc-team-devs
  (ts=…)`. Tell Jason which channel was posted to, which reviewers were
  tagged, and echo the summary you wrote.
- **On pre-flight failure:** the script prints `ERROR: pre-flight failed: …`.
  Relay the error verbatim. Do NOT post anything else, do NOT retry, do NOT
  try to "fix" the unresolved comments yourself unless Jason asks.
- **On Slack API failure:** the script preserves the payload at
  `/tmp/_tmp_slack_payload.json` and prints the Slack error. Relay both to
  Jason. Do NOT retry.

## Forbidden actions

- ❌ Calling `curl` directly against `chat.postMessage` — the script is the only
  caller.
- ❌ Calling `mcp__slack__slack_post_message` — that tool cannot render the
  header/divider/button blocks and would degrade the signature.
- ❌ Writing the Block Kit JSON anywhere except by way of `post.sh`.
- ❌ Editing `signature.template.json` at runtime.
- ❌ Falling back to plain text if curl fails — the script handles that; you
  surface the failure to Jason and stop.

(Voice and tone rules — emoji prefixes, "Hey team" greetings, AI attribution,
hedging — live in the **Voice** section near the top of this file.)
