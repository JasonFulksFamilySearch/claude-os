# ship — Helper Reference

Reference material for the `ship` skill. **Read this file when:**
- You need the full `push_with_timeout` decision matrix during Phase 3 or Phase 4c.
- You need the exact `fetch_pr_signals` shell calls during Phase 4b polling.
- You need the schema for the Phase 4b state file.

The parent SKILL.md describes the *flow*; this file holds the *mechanics*.

---

## push_with_timeout — full mechanics

Used by Phase 3 (initial push) and Phase 4c Step 4 (post-addressing push). Run the push
under a hard 5-minute wall-clock timeout, then reconcile state if the timeout fires.

```bash
BRANCH=$(git branch --show-current)
PUSH_START=$(date +%s)
PUSH_OUTPUT=$(timeout 300 git push -u origin "$BRANCH" 2>&1)
PUSH_EXIT=$?
PUSH_ELAPSED=$(( $(date +%s) - PUSH_START ))
```

**Decision matrix on `PUSH_EXIT`:**

| Exit | Meaning | Action |
|------|---------|--------|
| 0 | Push succeeded | Report `Push: completed in ${PUSH_ELAPSED}s`. Continue. |
| 124 | Wall-clock hit 5:00 (GNU `timeout` SIGTERM) | Reconcile before declaring stall — see below. |
| any other non-zero | Real push failure (auth, conflict, hook reject) | Report `$PUSH_OUTPUT` and stop. |

**Reconcile on exit 124:**

```bash
LOCAL_SHA=$(git rev-parse HEAD)
UPSTREAM_SHA=$(git rev-parse "@{u}" 2>/dev/null || echo "missing")
git status --short
```

- If `UPSTREAM_SHA == LOCAL_SHA` → push actually landed before SIGTERM. Report
  `Push: completed under timeout (reconciled)` and continue.
- If `UPSTREAM_SHA != LOCAL_SHA` (or missing) → real stall. Report:
  ```
  ❌ Push stalled at 5:00 — upstream did not advance.
     Local:    <LOCAL_SHA>
     Upstream: <UPSTREAM_SHA>
     Last 20 lines of push output:
     <tail of $PUSH_OUTPUT>
  ```
  Then stop. No retry, no prompt — the stall details are written to the Final Report
  and `/ship` exits. The pushed-or-not state is recoverable: re-invoke `/ship` after
  checking the remote, or push manually.

---

## fetch_pr_signals — full shell calls

Used by Phase 4b polling. Run all three `gh` calls and union the resulting `id` values.
All three filter to comments newer than `state.started_at` and skip resolved threads
where the API exposes that field.

Read `gh repo view --json nameWithOwner --jq .nameWithOwner` once at watch entry to
populate `{owner}/{repo}` for the `gh api` calls below.

```bash
# Human review comments + PR-level discussion
gh pr view "$PR_NUMBER" --json reviews,comments,reviewThreads \
  --jq '[
    (.reviews[]? | select(.state != "PENDING") | {id: ("review-" + (.id|tostring)), user: .author.login, body: .body, created_at: .submittedAt}),
    (.comments[]? | {id: ("comment-" + (.id|tostring)), user: .author.login, body: .body, created_at: .createdAt})
  ]'

# Inline code-review comments — this is where Copilot lives
gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER/comments" \
  --jq '[.[] | {id: ("inline-" + (.id|tostring)), user: .user.login, body: .body, path: .path, line: .line, created_at: .created_at, in_reply_to_id: .in_reply_to_id}]'

# Bot/issue comments — SonarQube typically posts here
gh api "repos/{owner}/{repo}/issues/$PR_NUMBER/comments" \
  --jq '[.[] | {id: ("issue-" + (.id|tostring)), user: .user.login, body: .body, created_at: .created_at}]'
```

**Critical detail:** the watch's `started_at` is set when Phase 4b *begins*, NOT when
`/ship` itself started. Comments that landed during the CI wait will be seen as "new"
on the first poll and trigger an addressing cycle — that's the original failure mode
this phase exists to prevent.

---

## Phase 4b state file schema

Path: `~/.claude-data/_tmp_ship_state/<PR_NUMBER>.json`

Initialize with the Write tool — do not use heredoc or `cat >`:

```json
{
  "pr_number": 142,
  "started_at": "2026-05-28T14:32:11Z",
  "seen_comment_ids": [],
  "clean_poll_count": 0,
  "cycle_count": 0
}
```

Fields:
- `pr_number` — int, the GitHub PR number
- `started_at` — ISO8601 timestamp when Phase 4b entered (the filter cutoff for
  "new" comments)
- `seen_comment_ids` — string array of `id` values returned by `fetch_pr_signals`;
  refreshed every poll to use as the baseline for the next diff
- `clean_poll_count` — int, increments on a clean poll, resets to 0 on any new signal
- `cycle_count` — int, increments each time Phase 4c is invoked from this watch

Persist via the Write tool after each loop iteration. Delete the file on successful
exit (two consecutive clean polls).

---

## Reply-posting commands (Phase 4c Step 6)

For each addressed inline comment:

```bash
gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER/comments/<comment-id>/replies" \
  -f body="Addressed in <short-SHA>: <one-line summary of fix>"
```

For PR-level / issue comments (Sonar, top-level reviews):

```bash
gh api "repos/{owner}/{repo}/issues/$PR_NUMBER/comments" \
  -f body="Cycle ${cycle_count}: addressed ${N} comments in <short-SHA>. See thread replies for details."
```
