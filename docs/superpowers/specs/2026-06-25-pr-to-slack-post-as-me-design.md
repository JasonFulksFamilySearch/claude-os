# pr-to-slack: post as Jason (Option X) — Design

- **Date:** 2026-06-25
- **Status:** Approved (design); pending implementation plan
- **Scope:** `~/.claude-os/agents/pr-to-slack/post.sh` and its docs. Shared genome — propagates to Walter on the personal Mac.

## Problem

`/pr-to-slack` (and `/ship`, which calls it) posts PR-announcement messages to
**#ce-team-devs** (`C06FFFS6EB0`) as the Slack **app** "JMF Claude MCP v2" (the APP badge), because
`post.sh` authenticates with a **bot** token (`xoxb`). Jason wants these posts to go
out under **his own identity** instead — same as the ad-hoc "Correction" reply he
posted via the user-token MCP path.

The decision (Option X) is the simplest of the shapes considered: do **not** keep a
second bot identity and do **not** add reply/note sub-modes. `pr-to-slack` posts as
Jason, always — including the automated `/ship` announcement.

## Current state (verified 2026-06-25)

Two posting identities exist today:

| Path | Token | Source | Posts as |
|---|---|---|---|
| `post.sh` → `chat.postMessage` (curl) | `xoxb` bot | keychain `slack-claude-mcp-api-key`, env `SLACK_BOT_TOKEN` | "JMF Claude MCP v2" (APP) |
| `mcp__slack__conversations_add_message` | `xoxp` user | `~/.config/slack-mcp/tokens.env` → `SLACK_MCP_XOXP_TOKEN` (also in `~/.claude.json`) | Jason Fulks |

`~/.config/slack-mcp/tokens.env` holds **both** `SLACK_MCP_XOXP_TOKEN` and
`SLACK_MCP_XOXB_TOKEN`. The MCP server already reads this file. It is machine-local
(not synced via `~/.claude-os`), and must exist on any machine that runs the Slack
MCP server — so it is present on both Willis's and Walter's Macs.

## Goal

`post.sh` posts as Jason by authenticating with the `xoxp` user token, while keeping
every other behavior identical (Block Kit layout, reviewer @-mentions, PR link, file
stats, Jira link, `--dry-run`, audit log, channel resolution).

## Non-goals (YAGNI — deliberately excluded)

- `yagni:` No reply/note sub-modes, no mode dispatch. Option X is a single posting
  identity; the earlier multi-mode design (Option Y) is explicitly dropped.
- `yagni:` No approval gate. Jason accepted that automated `/ship` posts go out under
  his name unattended — that is the chosen tradeoff, not an oversight.
- No keychain provisioning. The token is sourced from the existing `tokens.env`; it is
  never copied into a second store (avoids rotation drift and secret duplication).
- Deleting the Slack **app** itself is a Slack-admin UI action, out of scope for this
  change. The code stops using the bot token; the app can be retired later by hand.

## Design

### The change

In `post.sh`, replace the bot-token sourcing with user-token sourcing, and use that
token as the `chat.postMessage` bearer. `chat.postMessage` is authorship-agnostic:
the same Block Kit payload posts as the app under `xoxb` and as the user under `xoxp`.
Only the authenticating token changes.

**Token sourcing (single source of truth):**

```
# Prefer an already-exported token; else source the MCP token file.
if [ -z "${SLACK_USER_TOKEN:-}" ]; then
  if [ -f "${HOME}/.config/slack-mcp/tokens.env" ]; then
    # shellcheck disable=SC1090
    . "${HOME}/.config/slack-mcp/tokens.env"
    SLACK_USER_TOKEN="${SLACK_MCP_XOXP_TOKEN:-}"
  fi
fi
[ -n "${SLACK_USER_TOKEN:-}" ] || fail "SLACK_MCP_XOXP_TOKEN not found (checked env and ~/.config/slack-mcp/tokens.env)."
```

Then the `chat.postMessage` call uses `Authorization: Bearer ${SLACK_USER_TOKEN}`.

- No secret is printed, copied, or stored anywhere new — `post.sh` reads the file the
  MCP server already owns. If Jason rotates the token, both the MCP server and
  `post.sh` pick up the new value automatically (one source).
- The bot-token path (`SLACK_BOT_TOKEN` / keychain `slack-claude-mcp-api-key`) is
  removed from `post.sh`.

### Preserved unchanged

Block Kit structure and validation, reviewer @-mentions, PR URL, diff stats, Jira
link, `--dry-run` preview, the audit log at `~/.claude-data/projects/pr-to-slack-audit.log`,
and channel `#ce-team-devs` (`C06FFFS6EB0`).

### Docs to update

- `~/.claude-os/skills/pr-to-slack/SKILL.md` — the `<context>` "Slack MCP
  authentication" paragraph (currently describes bot-token auth) and any "posts as the
  app" framing → "posts as Jason via the `xoxp` user token sourced from `tokens.env`".
- `~/.claude-os/agents/pr-to-slack/SKILL.md` — same, if it repeats the auth description.
- `~/.claude-data/context/slack.md` — the header keywords and the `ce-team-devs` /
  `pr-to-slack` notes currently advertise `SLACK_BOT_TOKEN`, `bot token`, `xoxb`. Update
  to reflect user-token posting. (Context file — machine-local; update directly.)
- `~/.claude-os/skills/ship/SKILL.md` — only if it asserts the Slack post comes from the
  bot; the Phase 5 reference to `/pr-to-slack` itself is unaffected.

## Verification (evidence before "done")

1. `~/.claude-os/agents/pr-to-slack/post.sh "" <summary> --dry-run` — confirm the
   assembled Block Kit payload is unchanged and the resolved token is the `xoxp` one
   (assert the prefix is `xoxp-` **without printing the token**, e.g. check
   `${SLACK_USER_TOKEN%%-*}` equals `xoxp`).
2. One real post on a test/low-stakes PR — confirm in Slack that the message appears
   under **Jason Fulks** (no APP badge), with mentions, link, and stats intact.
3. Re-run `/ship` end-to-end (or `--no-watch`) once to confirm the automated path posts
   as Jason.

## Risks

- **`xoxp` + Block Kit rendering:** expected to work (`chat.postMessage` supports user
  tokens and `blocks`), but unproven on this exact payload — Verification step 1–2
  closes it before declaring done.
- **`xoxp` scope:** the user token already posted the "Correction" reply, so it has
  `chat:write`. Low risk.
- **User-token automation policy / rate limits:** enterprise Slack can restrict
  user-token automation. If FS IT tightens this later, posts fail loudly (the script's
  `ok:false` handling) rather than silently — acceptable. Noted, not blocking.
- **Honesty tradeoff (recorded):** automated `/ship` posts now carry Jason's name and
  avatar with no human review at send time. Accepted by Jason as the owner of the
  identity and the automation.

## Rollback

Revert `post.sh` to source the bot token. Single-file, single-commit revert.

## Cross-machine / commit

This edits `~/.claude-os/` (shared with Walter). `tokens.env` already exists on both
machines, so `post.sh` reading `SLACK_MCP_XOXP_TOKEN` works on each. Changes are
committed and propagated via `/transmit-claude-os` — **not** auto-committed here.
