# pr-to-slack: post as Jason (Option X) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/pr-to-slack` (and therefore `/ship`) post PR announcements to #ce-team-devs under Jason's own Slack identity instead of the "JMF Claude MCP v2" app.

**Architecture:** A single authenticating-token swap in `post.sh` — source the `xoxp` user token from the file the Slack MCP server already reads (`~/.config/slack-mcp/tokens.env`) instead of the `xoxb` bot token from keychain. `chat.postMessage` is authorship-agnostic, so the identical Block Kit payload posts as the user under an `xoxp` token. Docs are then realigned.

**Tech Stack:** Bash, `curl`, `jq`, Slack Web API (`chat.postMessage`), macOS.

## Global Constraints

- **No unit-test harness exists** for `post.sh`. The "tests" are: a token-prefix probe that mirrors the script's sourcing logic, the script's own `--dry-run`, and one real post confirmed visually in Slack. Do not invent a pytest.
- **Never print the token value.** Verify only its `xoxp-` prefix or its non-emptiness.
- **Commits go through `/transmit-claude-os`, not `git commit`.** This is `~/.claude-os/` (shared genome). Per the user's CLAUDE.md, never `git commit`/push this tree directly. Each task stages nothing special; the FINAL step runs `/transmit-claude-os` once (its invocation is the commit approval), which sweeps up these edits plus the already-written spec doc.
- **Single source of truth for the token:** read `SLACK_MCP_XOXP_TOKEN` from `~/.config/slack-mcp/tokens.env`. Do NOT copy it into keychain or any second store.
- **Recorded tradeoff:** automated `/ship` posts now carry Jason's name/avatar with no human review at send time. Accepted by Jason.
- **Cross-machine:** `tokens.env` exists on both Willis's and Walter's Macs (the MCP server requires it), so `post.sh` reading it works on each after the `~/.claude-os` change propagates.

---

### Task 1: Repoint `post.sh` to the `xoxp` user token

**Files:**
- Modify: `~/.claude-os/agents/pr-to-slack/post.sh:24` (header comment)
- Modify: `~/.claude-os/agents/pr-to-slack/post.sh:100-111` (token sourcing block)
- Modify: `~/.claude-os/agents/pr-to-slack/post.sh:274` (the `chat.postMessage` bearer)

**Interfaces:**
- Consumes: `~/.config/slack-mcp/tokens.env` defining `SLACK_MCP_XOXP_TOKEN`.
- Produces: shell variable `SLACK_USER_TOKEN` (the resolved `xoxp` token), used as the `chat.postMessage` bearer.

- [ ] **Step 1: Write the failing test (token-prefix probe)**

This probe mirrors the exact sourcing logic the script will use. Run it BEFORE editing — it proves the target token exists and is `xoxp`, and that the *old* script would not have used it:

```bash
( SLACK_USER_TOKEN=""
  . "${HOME}/.config/slack-mcp/tokens.env"
  SLACK_USER_TOKEN="${SLACK_MCP_XOXP_TOKEN:-}"
  if [ -z "$SLACK_USER_TOKEN" ]; then echo "FAIL: empty"; 
  else case "$SLACK_USER_TOKEN" in xoxp-*) echo "PASS: resolves to xoxp user token";; *) echo "FAIL: not xoxp";; esac
  fi )
```

- [ ] **Step 2: Run it to confirm the token resolves**

Run the block above.
Expected: `PASS: resolves to xoxp user token` (no token value printed).
If `FAIL: empty`, stop — `tokens.env` is missing `SLACK_MCP_XOXP_TOKEN`; resolve that before continuing.

- [ ] **Step 3: Update the header comment (line 24)**

Replace:
```bash
# Requires: $SLACK_BOT_TOKEN env var, gh (authenticated), jq, curl.
```
With:
```bash
# Requires: SLACK_MCP_XOXP_TOKEN (env, or ~/.config/slack-mcp/tokens.env), gh (authenticated), jq, curl.
# Posts as Jason (xoxp user token), NOT as the bot app.
```

- [ ] **Step 4: Replace the token sourcing block (lines 100-111)**

Replace:
```bash
# Source the token: prefer env var, fall back to macOS keychain.
# On Jason's Macs the token lives in keychain (account=slack, service=
# slack-claude-mcp-api-key), not as a shell-exported env var. This fallback
# means /pr-to-slack works without forcing the agent to re-discover the
# keychain pattern on every invocation.
if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
  if command -v security >/dev/null 2>&1; then
    SLACK_BOT_TOKEN="$(security find-generic-password -w -a slack -s slack-claude-mcp-api-key 2>/dev/null || true)"
    export SLACK_BOT_TOKEN
  fi
fi
[ -n "${SLACK_BOT_TOKEN:-}" ] || fail "\$SLACK_BOT_TOKEN not set and macOS keychain lookup (account=slack, service=slack-claude-mcp-api-key) returned empty. Set the env var, or store the token via: security add-generic-password -a slack -s slack-claude-mcp-api-key -w <token>"
```
With:
```bash
# Source the user token: prefer an exported env var, else the MCP token file.
# ~/.config/slack-mcp/tokens.env is the single source of truth the Slack MCP
# server already reads (it holds SLACK_MCP_XOXP_TOKEN and SLACK_MCP_XOXB_TOKEN).
# Sourcing the xoxp USER token here makes chat.postMessage post AS Jason, with no
# secret duplicated into a second store and no rotation drift.
if [ -z "${SLACK_USER_TOKEN:-}" ]; then
  if [ -f "${HOME}/.config/slack-mcp/tokens.env" ]; then
    # shellcheck disable=SC1091
    . "${HOME}/.config/slack-mcp/tokens.env"
    SLACK_USER_TOKEN="${SLACK_MCP_XOXP_TOKEN:-}"
  fi
fi
[ -n "${SLACK_USER_TOKEN:-}" ] || fail "SLACK_MCP_XOXP_TOKEN not set and ~/.config/slack-mcp/tokens.env did not provide it. Ensure that file exists with SLACK_MCP_XOXP_TOKEN=<your xoxp token>."
```

- [ ] **Step 5: Update the `chat.postMessage` bearer (line 274)**

Replace:
```bash
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
```
With:
```bash
  -H "Authorization: Bearer ${SLACK_USER_TOKEN}" \
```

- [ ] **Step 6: Confirm no `SLACK_BOT_TOKEN` reference survives in the script**

Run: `grep -n "SLACK_BOT_TOKEN" ~/.claude-os/agents/pr-to-slack/post.sh`
Expected: no output (exit 1). Any hit is a missed edit — fix it.

- [ ] **Step 7: Syntax-check the script**

Run: `bash -n ~/.claude-os/agents/pr-to-slack/post.sh && echo "syntax OK"`
Expected: `syntax OK`.

- [ ] **Step 8: Stage (do not commit — final transmit handles it)**

Run: `git -C ~/.claude-os add agents/pr-to-slack/post.sh`
(Commit deferred to the final `/transmit-claude-os` step per Global Constraints.)

---

### Task 2: Realign the docs to user-token posting

**Files:**
- Modify: `~/.claude-os/skills/pr-to-slack/SKILL.md:57-59` (the `<context>` "Slack MCP authentication" paragraph)
- Modify: `~/.claude-data/context/slack.md:3` (keywords) and `:95-120` (the "Bot Token" section)

**Interfaces:**
- Consumes: nothing. Produces: nothing (documentation only).

- [ ] **Step 1: Fix the SKILL.md authentication paragraph**

In `~/.claude-os/skills/pr-to-slack/SKILL.md`, replace:
```
**Slack MCP authentication:** The Slack MCP server authenticates via a bot token
configured in Claude Code's MCP server config (`claude mcp get slack`). No additional
token setup is needed at invocation time — the server handles auth automatically.
```
With:
```
**Slack authentication:** Posting runs through `post.sh`, which authenticates with
Jason's `xoxp` user token sourced from `~/.config/slack-mcp/tokens.env` — so messages
post under Jason's identity, not a bot app. The same file backs the `mcp__slack__`
verification tools. No per-invocation token setup is needed.
```

- [ ] **Step 2: Fix the context/slack.md keyword line (line 3)**

Replace `SLACK_BOT_TOKEN, keychain, bot token, xoxb` with `SLACK_MCP_XOXP_TOKEN, user token, xoxp, tokens.env` in the `Keywords:` line.

- [ ] **Step 3: Replace the "Bot Token" section (lines 95-120)**

Replace the entire block from `## Bot Token (`SLACK_BOT_TOKEN`)` through the closing `security add-generic-password ...` fence with:
```markdown
## Posting Token (`SLACK_MCP_XOXP_TOKEN`)

`/pr-to-slack` and `/ship` post as **Jason** (not a bot app). `post.sh` sources
Jason's `xoxp` user token from the file the Slack MCP server already reads:

| Field | Value |
|---|---|
| file | `~/.config/slack-mcp/tokens.env` |
| var | `SLACK_MCP_XOXP_TOKEN` |

`~/.claude-os/agents/pr-to-slack/post.sh` sources it transparently: if
`SLACK_USER_TOKEN` is unset, it reads `tokens.env` and uses `SLACK_MCP_XOXP_TOKEN`.
No agent action needed. The token is never copied into keychain — `tokens.env` is the
single source of truth, shared with the MCP server, so rotation is one place.

The old `xoxb` bot path (keychain `slack-claude-mcp-api-key`, "JMF Claude MCP v2" app)
is retired in code. The Slack app itself can be deleted from the Slack admin UI later.
```

- [ ] **Step 4: Confirm no stale bot-token references remain**

Run: `grep -niE "SLACK_BOT_TOKEN|xoxb|bot token" ~/.claude-os/skills/pr-to-slack/SKILL.md ~/.claude-data/context/slack.md`
Expected: at most the single line in slack.md that intentionally says the bot path "is retired." Any other hit is a missed edit.

- [ ] **Step 5: Stage the SKILL.md change (context/slack.md is outside the repo)**

Run: `git -C ~/.claude-os add skills/pr-to-slack/SKILL.md`
(`~/.claude-data/context/slack.md` is machine-local and not part of `~/.claude-os`; it needs no commit.)

---

### Task 3: Live verification (real post as Jason)

**Files:** none modified. This task proves the change against a real PR + Slack.

**Interfaces:** Consumes the edited `post.sh`. Produces a human-confirmed PASS.

> Requires an open, low-stakes PR on the current branch to post to. If none is handy, this task runs on the next genuine `/ship`. The dry-run sub-step needs a repo context where `gh pr view` resolves.

- [ ] **Step 1: Dry-run on a real PR branch**

From a repo with an open PR, run:
```bash
echo "test summary — verifying post-as-me" > /tmp/_tmp_pr_summary.md
~/.claude-os/agents/pr-to-slack/post.sh "" /tmp/_tmp_pr_summary.md --dry-run
```
Expected: the assembled Block Kit payload prints, ending with the dry-run "No Slack call made. No audit log written." line — and NO token-sourcing `fail`. (Reaching the dry-run exit proves `SLACK_USER_TOKEN` resolved.)

- [ ] **Step 2: One real post**

Run (same repo/PR):
```bash
~/.claude-os/agents/pr-to-slack/post.sh "" /tmp/_tmp_pr_summary.md
```
Expected: `Posted: PR #N → #arc-team-devs (ts=...)`.

- [ ] **Step 3: Human visual confirmation (Jason)**

In #ce-team-devs, confirm the message appears under **Jason Fulks** with his avatar and **no APP badge**, and that reviewer @-mentions, the PR link, and file stats all rendered. This is the ground-truth proof that `xoxp` + Block Kit posts as the user.
If it still shows the APP badge → the bearer is still the bot token; re-check Task 1 Step 5.

- [ ] **Step 4: Confirm the audit log appended**

Run: `tail -n 1 ~/.claude-data/projects/pr-to-slack-audit.log`
Expected: a line with `PR=...  ts=...` matching the post just made.

- [ ] **Step 5: Clean up the test post**

Delete the test message in Slack by hand (it was a verification post, not a real announcement).

---

### Final Step: Commit + propagate via `/transmit-claude-os`

- [ ] Invoke `/transmit-claude-os`. It commits and pushes all pending `~/.claude-os/` changes (this plan, the spec doc, `post.sh`, the SKILL.md edit) to origin, from where Walter assimilates them. Its invocation is the commit approval — no separate `git commit` is run.

---

## Self-Review

**Spec coverage:**
- "Token swap in `post.sh`, sourced from tokens.env, no keychain" → Task 1. ✓
- "Preserve Block Kit / mentions / audit log / dry-run / channel" → untouched by Task 1; confirmed in Task 3 Steps 3–4. ✓
- "Docs to update (SKILL.md, context/slack.md)" → Task 2. (`agents/pr-to-slack/SKILL.md` and `ship/SKILL.md` were grep-verified to carry NO bot-token references, so they need no edit — the `post.sh` header comment covers the agent-side note.) ✓
- "Verification: dry-run + one real post as Jason" → Task 3. ✓
- "Bot retirement in code; app deletion manual" → Task 1 removes the bot path; Task 2 Step 3 documents the manual app deletion. ✓
- "Cross-machine / commit via transmit" → Global Constraints + Final Step. ✓

**Placeholder scan:** No TBD/TODO. The `<your xoxp token>` string appears only inside a verbatim error-message reproduction, not as a plan instruction. Clean.

**Type/name consistency:** `SLACK_USER_TOKEN` is the single variable name introduced (Task 1 Steps 4–5, probe in Step 1); the bearer in Step 5 references it; Step 6 asserts the old `SLACK_BOT_TOKEN` is gone. Consistent.
