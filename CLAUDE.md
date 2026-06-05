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
