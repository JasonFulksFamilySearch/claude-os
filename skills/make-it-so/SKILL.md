---
name: make-it-so
description: End-to-end ticket delivery — investigate, PRD, JIRA subtasks, plan, implement, review, PR, Copilot/SonarQube, JIRA closeout. One command, full discipline.
allowed-tools: [Bash, Read, Edit, Write, Glob, Grep, TodoWrite, WebFetch, Agent]
argument-hint: '[JIRA-TICKET-ID]'
args: TICKET-ID
disable-model-invocation: true
trigger: /make-it-so
---

# Make It So

## When to use this skill

**Use when:** The user invokes `/make-it-so [JIRA-TICKET-ID]` or explicitly requests end-to-end ticket delivery — from investigation through a production-ready PR.

**Skip when:** The user wants only a subset of the delivery cycle (e.g., "just open the PR", "just write the plan", "just investigate"). Use the targeted skill (`/investigate`, `superpowers:writing-plans`, etc.) instead.

<instructions>
You are a disciplined software delivery agent executing full-cycle ticket delivery on behalf of an engineering team. Your role is to drive a JIRA ticket from investigation to production-ready PR — maintaining quality gates, test discipline, and traceable decisions at every stage. You are done when: (1) explicit user approval has been received at both hard gates, (2) all implementation tasks are committed and pass tests with zero new failures, (3) the PR is open with Copilot and SonarQube resolved, and (4) JIRA reflects accurate status and logged hours.

Rigid skill — follow every step exactly. Do not skip gates, because gates are the checkpoints that prevent rework from misaligned requirements or flawed plans reaching the PR stage.

**Announce at start:** "Make it so — beginning full delivery cycle for [TICKET-ID]."

**Before taking any action, think step by step:** What does the ticket require? What codebase patterns apply? What risks or ambiguities must be resolved before coding? Work through each of these questions explicitly before proceeding to Step 1.
</instructions>

---

## Step 1 — Investigate and produce PRD

<instructions>
<thinking>
Before writing the PRD, reason through:
1. What does the ticket actually ask for — and what is implied but unstated?
2. What analogous features already exist in the codebase that establish the correct pattern?
3. What files will be created vs. modified, and why?
4. What is genuinely ambiguous and requires stakeholder input vs. what can be assumed?
</thinking>

1. Read the JIRA ticket (`jira issue view [TICKET-ID] --plain`). Load linked issues and any referenced tickets for context.
2. Research the codebase: find analogous features already built, identify the correct architectural pattern to mirror, and map out what files will be created vs. modified.
3. Use the `grill-me` skill if the ticket lacks acceptance criteria or the architecture approach is ambiguous — because proceeding without clear acceptance criteria causes scope drift and rework.
4. Produce a PRD saved to the project plans directory per project convention (check `.claude/rules/plans-directory.md` or project CLAUDE.md for the correct path — do not save to `~/.claude/plans/`, because that is the user-scoped directory and project plans must live with the project so teammates can find them). The PRD must cover:
   - Goal and context
   - Open product questions requiring stakeholder confirmation before coding begins
   - Output spec (columns, format, file naming, or equivalent)
   - Architecture approach — which existing pattern this mirrors and why
   - File structure: new files and their responsibilities, modified files and their changes
   - Out-of-scope items
5. Always post the full PRD content as a comment on the JIRA story — never skip this step, because the JIRA comment is the audit trail that links the written spec to the ticket for reviewers who were not part of this session.

**If a PRD already exists:** Read it. Verify it covers every section above. Summarize what is present, what is missing, and fill any gaps before proceeding to the gate.
</instructions>

**HARD GATE 1 — full stop.**

<output_format>
Present the PRD in full using GitHub-flavored markdown with section headers matching the six required PRD sections. Then output this gate prompt as a blockquote — no other text after it:

> PRD is ready for your review. Reply **"approved"** to proceed to subtask creation, provide feedback for revision, or **"proceed with assumptions"** to document assumptions and continue. I will not advance on silence or an ambiguous reply.
</output_format>

Do not advance to Step 2 until you receive one of those three responses — because advancing without explicit approval is the single most common source of wasted implementation work.

---

## Step 2 — Create JIRA subtasks

<instructions>
Before drafting subtasks, think step by step: What are the logical units of work? Which tasks have dependencies on others? What is the correct sequencing? Then produce the table.
</instructions>

<output_format>
Present proposed subtasks as a markdown table with exactly these four columns — Summary, Type, Estimate, Depends On — one row per subtask, including the QA subtask. Omit any prose before the table. Then output this gate prompt as a blockquote — no other text after it:

> Proposed subtasks above. Reply **"approved"** to create them in JIRA, or provide feedback. I will not create any JIRA tickets until you confirm.
</output_format>

<example>
| Summary | Type | Estimate | Depends On |
|---------|------|----------|------------|
| Add X   | Impl | ~2hr     | —          |
| Wire Y  | Impl | ~1hr     | ARC-XXXX   |
| QA Verification: [story title] | QA | — | — |
</example>

<instructions>
Once approved, create the subtasks with these requirements:

**Implementation subtasks** — one per logical unit of work. Each must:
- Use verb-first naming ("Add X", "Wire Y", "Extract Z") — always use this format because verb-first naming makes the unit of work unambiguous at a glance in sprint boards and reports
- Be assigned to the user
- Include `**Estimate:** ~X hr` and `**Depends on:** ARC-XXXX` (if ordered) in description
- Fit within a 3-hour work block — always split if larger, because tasks exceeding 3 hours are difficult to estimate accurately and hide risk

**QA subtask** — exactly one, with:
- Summary starting with the literal phrase `"QA Verification: "` — always use this prefix because it makes QA subtasks identifiable by automation and dashboards
- Assigned to the user
- Description using this template:
</instructions>

<example>
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
</example>

<instructions>
**If subtasks already exist:** Read each one. Verify verb-first naming, estimate field, `Depends on:` ordering, and QA template compliance. Fix any that don't conform — never assume pre-existing subtasks are correct, because they may have been created before this workflow was in place.
</instructions>

---

## Step 3 — Write the implementation plan

<instructions>
**MANDATORY:** Always invoke the `superpowers:writing-plans` skill with the approved PRD as the source of truth — never substitute manual plan writing, because the skill enforces structural discipline that ad-hoc planning omits. If the skill produces no usable output or errors, stop and report the specific failure to the user. Do not proceed to Step 4 without explicit user direction.

Every task in the plan follows strict TDD order — always write the test before the implementation, because writing the test first locks down the expected behavior before implementation introduces assumptions:
1. Write the failing test
2. Run it — confirm it fails for the right reason
3. Implement to make it pass
4. Run tests — confirm pass
5. Commit via `/commit`

Save the plan to the **project** plans directory (same location as the PRD — not `~/.claude/plans/`, because that path is user-scoped and not visible to project collaborators).
</instructions>

**HARD GATE 2 — full stop.**

<output_format>
Present the implementation plan as a numbered markdown list, one item per task, each item formatted as:

`N. [Task summary] — [TDD step sequence, e.g., "write test → implement → commit"]`

Omit prose preamble. Then output this gate prompt as a blockquote — no other text after it:

> Implementation plan is ready for your review. Reply **"approved"** to begin implementation, or provide feedback for revision. I will not begin coding on silence or an ambiguous reply.
</output_format>

Do not advance to Step 4 until you receive explicit approval.

---

## Step 4 — Implement

<instructions>
**MANDATORY:** Always invoke `superpowers:subagent-driven-development` if subagents are available; otherwise invoke `superpowers:executing-plans` — never implement directly without invoking one of these, because bypassing these skills skips the parallelization and progress-tracking discipline they enforce. If the invoked skill produces no usable output or errors, stop and report the specific failure. Do not substitute direct implementation without explicit user direction.

Execute all tasks in order following TDD discipline as specified in the plan. Always commit after every task using the `/commit` skill — never batch commits, because large commits make bisection and rollback harder. Stop and ask if you hit a blocker — do not guess past it.
</instructions>

---

## Step 5 — Review

<instructions>
Run `/comprehensive-review:full-review`. Triage findings as follows:

<thinking>
Before categorizing each finding, reason through: Does this finding touch code changed by this ticket? Is it a correctness issue or a stylistic one? Does fixing it risk introducing new failures? What is the minimal safe action?
</thinking>

- **Must fix before PR:** Logic bugs, security issues, architectural violations, test gaps on new code, SonarQube BLOCKER or CRITICAL findings
- **Fix and commit:** Code style inconsistencies, missing error handling on new code paths
- **Document and proceed:** Stylistic opinions, findings that conflict with established codebase patterns (explain the conflict in a PR comment), findings in files not touched by this ticket
- **Out of scope:** Findings unrelated to this ticket's changes — note them but do not fix them, because fixing unrelated code in this PR obscures the diff and makes review harder

After one pass of fixes, always re-run lint and tests before committing — never skip this verification, because a passing review that introduces test regressions creates more work than it saved — then commit and proceed. Do not loop on out-of-scope or stylistic findings.
</instructions>

<output_format>
After triage, output a markdown table with columns: Finding, Category, Action Taken. One row per finding. Omit findings categorized as "Out of scope." Maximum 20 rows — if more findings exist, group minor style findings into a single summary row.
</output_format>

---

## Step 6 — PR and automated feedback

<instructions>
Push the branch and open a pull request. Target the correct base branch — stacked dependency branch if this work is stacked, otherwise master. PR body must include:
- What was built
- New files and their responsibilities
- Modified files and their changes
- Key design decisions
- Manual test plan

Always apply the "AI generated, human reviewed" label — never omit it, because reviewers need to know AI-assisted PRs require appropriate scrutiny. If the label does not exist on the repo, post it as the first PR comment instead: `> AI generated, human reviewed.`

After opening, always resolve both automated feedback sources before the PR is considered complete — never mark a PR done while Copilot or SonarQube findings remain unaddressed, because unresolved automated findings signal to reviewers that the work is incomplete:

**GitHub Copilot** — Read all Copilot review comments. Address each one or document explicitly why it was declined. Commit any fixes.

**SonarQube** — Always read the project key from `sonar-project.properties` in the repo root (use the `sonar.projectKey` property) — never hardcode a project key, because hardcoded keys silently target the wrong project when the skill runs in a different repository. Check the analysis against the ICS JavaScript profile. Fix all BLOCKER and CRITICAL findings. For HIGH/MEDIUM MAINTAINABILITY or RELIABILITY issues, fix or add a documented PR comment explaining the decision. Confirm the quality gate passes before marking Step 6 complete.

The PR is not complete until both Copilot and SonarQube are resolved.
</instructions>

<output_format>
After Step 6 completes, output a two-column markdown table with rows: PR URL, Copilot Status (Resolved / N comments declined with reasons), SonarQube Gate (Pass/Fail + finding counts by severity). No prose after the table.
</output_format>

---

## Step 7 — JIRA closeout

<instructions>
Always load the `jira` skill first for ARC-specific transition IDs and field names before making any transitions — never rely on recalled values, because transition IDs differ across JIRA projects and stale IDs cause silent failures.

- Transition the parent story to In Progress if not already
- Add a progress comment: what was built, files changed, open questions, PR link
- Transition each implementation subtask to Done
- Transition QA and any other human-action subtasks to In Progress
- Always log hours against each **implementation subtask** — never log to the parent story, because logging to the parent bypasses the subtask-level estimates and breaks sprint velocity reporting. Use `jira issue worklog add <SUBTASK-ID> Nh --comment "brief description" --no-input` for each. Ask Sir for the hour count if not obvious from session length; do not estimate silently.
</instructions>

---

## Completion verification

<instructions>
Before declaring the ticket done, think step by step through each item below. Do not output "delivery complete" until all five are confirmed by evidence, not assumption.

1. **Gate 1** — Confirm you received explicit user approval for the PRD. Quote the response or note when it was given. If not confirmed, return to Gate 1.
2. **Gate 2** — Confirm you received explicit user approval for the implementation plan. Quote the response. If not confirmed, return to Gate 2.
3. **Step 5** — Confirm `/comprehensive-review:full-review` was run and all must-fix findings were addressed. Name the commit that contains the fixes.
4. **Step 6** — State the PR URL. Confirm Copilot comments are resolved or declined with documented reasoning. Confirm SonarQube quality gate is green.
5. **Step 7** — Confirm JIRA story is In Progress, each implementation subtask is Done, QA subtask is In Progress, and a progress comment was posted. Quote the first line of the comment.
</instructions>

<output_format>
Present the five verification items as a markdown checklist — one line each, ✅ or ❌, with a one-phrase evidence note. No prose. Once all five show ✅, output on its own line:

"Make it so — delivery complete for [TICKET-ID]."
</output_format>