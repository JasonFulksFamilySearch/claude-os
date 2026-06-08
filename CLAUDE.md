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

(Verified working on this repo 2026-06-08, PR #27.) The PR-creating skills (`ship`,
`pr-to-slack`) wire this in automatically; when opening a PR by hand, run it yourself.
