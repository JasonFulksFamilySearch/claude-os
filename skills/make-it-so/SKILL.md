---
name: make-it-so
description: End-to-end ticket delivery — investigate, PRD, JIRA subtasks, plan, implement, review, PR, Copilot/SonarQube, JIRA closeout. One command, full discipline.
trigger: /make-it-so
args: TICKET-ID
disable-model-invocation: true
argument-hint: "[JIRA-TICKET-ID]"
---

# Make It So

Full-cycle ticket delivery. Rigid skill — follow every step exactly. Do not skip gates.

**Announce at start:** "Make it so — beginning full delivery cycle for [TICKET-ID]."

---

## Step 1 — Investigate and produce PRD

1. Read the JIRA ticket (`jira issue view [TICKET-ID] --plain`). Load linked issues and any referenced tickets for context.
2. Research the codebase: find analogous features already built, identify the correct architectural pattern to mirror, and map out what files will be created vs. modified.
3. Use the `grill-me` skill if the ticket lacks acceptance criteria or the architecture approach is ambiguous.
4. Produce a PRD saved to the project plans directory per project convention (check `.claude/rules/plans-directory.md` or project CLAUDE.md for the correct path — do not save to `~/.claude/plans/`). The PRD must cover:
   - Goal and context
   - Open product questions requiring stakeholder confirmation before coding begins
   - Output spec (columns, format, file naming, or equivalent)
   - Architecture approach — which existing pattern this mirrors and why
   - File structure: new files and their responsibilities, modified files and their changes
   - Out-of-scope items
5. Post the full PRD content as a comment on the JIRA story.

**If a PRD already exists:** Read it. Verify it covers every section above. Summarize what is present, what is missing, and fill any gaps before proceeding to the gate.

**HARD GATE 1 — full stop.**

Present the PRD (or your gap-filled version) in full. Then output this exactly:

> PRD is ready for your review. Reply **"approved"** to proceed to subtask creation, provide feedback for revision, or **"proceed with assumptions"** to document assumptions and continue. I will not advance on silence or an ambiguous reply.

Do not advance to Step 2 until you receive one of those three responses.

---

## Step 2 — Create JIRA subtasks

Before creating any tickets, draft the full proposed subtask list as a table:

| Summary | Type | Estimate | Depends On |
|---------|------|----------|------------|
| Add X   | Impl | ~2hr     | —          |
| Wire Y  | Impl | ~1hr     | ARC-XXXX   |
| QA Verification: [story title] | QA | — | — |

Then output this exactly:

> Proposed subtasks above. Reply **"approved"** to create them in JIRA, or provide feedback. I will not create any JIRA tickets until you confirm.

Once approved, create the subtasks with these requirements:

**Implementation subtasks** — one per logical unit of work. Each must:
- Use verb-first naming ("Add X", "Wire Y", "Extract Z")
- Be assigned to the user
- Include `**Estimate:** ~X hr` and `**Depends on:** ARC-XXXX` (if ordered) in description
- Fit within a 3-hour work block — split if larger

**QA subtask** — exactly one, with:
- Summary starting with the literal phrase `"QA Verification: "`
- Assigned to the user
- Description using this template:

```
## QA Verification Steps
<context + reference to parent story>

### Prerequisites
- Environment, browser, flag state, data prerequisites

### Test N: <name>
1. Step
**Expected:** outcome
**Verify in Splunk:** `query` (if applicable)

### Pass Criteria
- Overall acceptance bullets
```

**If subtasks already exist:** Read each one. Verify verb-first naming, estimate field, `Depends on:` ordering, and QA template compliance. Fix any that don't conform. Do not assume pre-existing subtasks are correct.

---

## Step 3 — Write the implementation plan

**MANDATORY:** Invoke the `superpowers:writing-plans` skill with the approved PRD as the source of truth. Do not substitute manual plan writing — invoke the skill. If the skill produces no usable output or errors, stop and report the specific failure to the user. Do not proceed to Step 4 without explicit user direction.

Every task in the plan follows strict TDD order:
1. Write the failing test
2. Run it — confirm it fails for the right reason
3. Implement to make it pass
4. Run tests — confirm pass
5. Commit via `/commit`

Save the plan to the **project** plans directory (same location as the PRD — not `~/.claude/plans/`).

**HARD GATE 2 — full stop.**

Present the plan in full. Then output this exactly:

> Implementation plan is ready for your review. Reply **"approved"** to begin implementation, or provide feedback for revision. I will not begin coding on silence or an ambiguous reply.

Do not advance to Step 4 until you receive explicit approval.

---

## Step 4 — Implement

**MANDATORY:** Invoke `superpowers:subagent-driven-development` if subagents are available; otherwise invoke `superpowers:executing-plans`. Do not implement directly without invoking one of these. If the invoked skill produces no usable output or errors, stop and report the specific failure. Do not substitute direct implementation without explicit user direction.

Execute all tasks in order following TDD discipline as specified in the plan. Commit after every task using the `/commit` skill. Stop and ask if you hit a blocker — do not guess past it.

---

## Step 5 — Review

Run `/comprehensive-review:full-review`. Triage findings as follows:

- **Must fix before PR:** Logic bugs, security issues, architectural violations, test gaps on new code, SonarQube BLOCKER or CRITICAL findings
- **Fix and commit:** Code style inconsistencies, missing error handling on new code paths
- **Document and proceed:** Stylistic opinions, findings that conflict with established codebase patterns (explain the conflict in a PR comment), findings in files not touched by this ticket
- **Out of scope:** Findings unrelated to this ticket's changes — note them, do not fix them

After one pass of fixes, re-run lint and tests (zero new failures required), then commit and proceed. Do not loop on out-of-scope or stylistic findings.

---

## Step 6 — PR and automated feedback

Push the branch and open a pull request. Target the correct base branch — stacked dependency branch if this work is stacked, otherwise master. PR body must include:
- What was built
- New files and their responsibilities
- Modified files and their changes
- Key design decisions
- Manual test plan

Apply the "AI generated, human reviewed" label. If the label does not exist on the repo, post it as the first PR comment instead: `> AI generated, human reviewed.`

After opening, resolve both automated feedback sources before the PR is considered complete:

**GitHub Copilot** — Read all Copilot review comments. Address each one or document explicitly why it was declined. Commit any fixes.

**SonarQube** — Read the project key from `sonar-project.properties` in the repo root (use the `sonar.projectKey` property). Do not hardcode a project key — always derive it from the repo. Check the analysis against the ICS JavaScript profile. Fix all BLOCKER and CRITICAL findings. For HIGH/MEDIUM MAINTAINABILITY or RELIABILITY issues, fix or add a documented PR comment explaining the decision. Confirm the quality gate passes before marking Step 6 complete.

The PR is not complete until both Copilot and SonarQube are resolved.

---

## Step 7 — JIRA closeout

Load the `jira` skill first for ARC-specific transition IDs and field names before making any transitions.

- Transition the parent story to In Progress if not already
- Add a progress comment: what was built, files changed, open questions, PR link
- Transition each implementation subtask to Done
- Transition QA and any other human-action subtasks to In Progress
- Log hours worked against each **implementation subtask** — not the parent story. Use `jira issue worklog add <SUBTASK-ID> Nh --comment "brief description" --no-input` for each. Ask Sir for the hour count if not obvious from session length; do not estimate silently and do not log to the parent.

---

## Completion verification

Before declaring the ticket done, verify each item explicitly and by evidence. Do not output "delivery complete" until all five are confirmed.

1. **Gate 1** — Confirm you received explicit user approval for the PRD. Quote the response or note when it was given. If not confirmed, return to Gate 1.
2. **Gate 2** — Confirm you received explicit user approval for the implementation plan. Quote the response. If not confirmed, return to Gate 2.
3. **Step 5** — Confirm `/comprehensive-review:full-review` was run and all must-fix findings were addressed. Name the commit that contains the fixes.
4. **Step 6** — State the PR URL. Confirm Copilot comments are resolved or declined with documented reasoning. Confirm SonarQube quality gate is green.
5. **Step 7** — Confirm JIRA story is In Progress, each implementation subtask is Done, QA subtask is In Progress, and a progress comment was posted. Quote the first line of the comment.

Once all five are confirmed, output: "Make it so — delivery complete for [TICKET-ID]."
