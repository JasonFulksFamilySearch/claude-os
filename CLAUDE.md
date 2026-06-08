# claude-os project rules

## Machine setup always goes in the scripts

Every feature that requires machine-local setup — context files, scheduled jobs,
hook registrations, symlinks — must be handled in `update.sh` or provisioned
automatically at session start. Never leave setup steps as manual instructions
that only the implementing agent runs.

Checklist when implementing a feature that touches machine state:
- Context files (`~/.claude-data/context/`) → add to `context-templates/`; `update.sh` Step 7 provisions them
- Scheduled background jobs → add to `config/scheduled-jobs.json`; session-start injects the register commands
- Hook registrations → already handled by `hooks/hooks-install.js` (called in `update.sh` Step 3)
- Any other one-time setup → add a new idempotent step to `update.sh`

When session start injects a `[Background jobs]` block, silently call CronCreate
for each listed job before responding to the user's first message. Do not ask for
confirmation — the jobs.json is the authorization.

## Every PR MUST request Copilot as a reviewer

Every pull request opened against this repo MUST have GitHub Copilot requested as a
reviewer. This is not optional and applies to PRs from either agent (Walter, Willis).
Copilot is a complementary lens — it reviews the diff surface; it does not run tests or
know the design invariants — so it never replaces the project's own verification
(`/review-pr`, QA, red-blue-judge), but it must always be on the PR.

Copilot is the `copilot-pull-request-reviewer[bot]` app, not a normal collaborator, so it
is requested via the API rather than `--reviewer`. Immediately after opening any PR:

```
gh api repos/{owner}/{repo}/pulls/{number}/requested_reviewers \
  -X POST -f "reviewers[]=copilot-pull-request-reviewer[bot]"
```

**Request, then VERIFY — do not assume success.** The API can return HTTP 200 while
silently NOT attaching Copilot (observed 2026-06-08: the call succeeded on PR #27 but
no-opped on PR #28, leaving `requested_reviewers` empty). This is a GitHub-side
constraint — likely a per-account Copilot-review concurrency/rate limit (only so many
Copilot reviews in flight at once). So the obligation is: **always request, then read back
`reviewRequests`/`reviews` and WARN loudly if Copilot is absent** — never report success
on the 200 alone. If it doesn't attach, request it from the PR web UI (which sometimes
succeeds when the API no-ops) or retry once the prior Copilot review completes (a finished
review frees the slot). The rule is "Copilot MUST be requested and its attachment
verified"; attachment is GitHub's to grant, and a verified-absent state must be surfaced,
not swallowed. The PR-creating skills (`ship`, `pr-to-slack`) wire in the request +
verify-and-warn; when opening a PR by hand, do both yourself.
