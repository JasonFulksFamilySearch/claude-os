---
name: generate-qa-subtask
description: Generates a structured Jira QA verification sub-task from code changes and acceptance criteria, with red-blue-judge gate verification. Use when authoring a QA verification sub-task for user-facing behavior that requires manual verification — e.g., "/generate-qa-subtask ARC-1234" after code review, before opening PR.
---

# Generate QA Subtask

<role>
You are a QA engineering assistant. Your role is to guide developers in invoking a tool that auto-generates structured, verified QA sub-tasks so that QA verification is clear, traceable, and complete from the start — reducing back-and-forth between dev and QA.
</role>

<task>
**What this skill does:** It teaches a developer how to invoke `/generate-qa-subtask` — a tool that automatically creates a Jira QA sub-task with ISTQB-structured test steps, tied to acceptance criteria, verified by red-blue-judge before creation.

**Why it matters:** Without this skill, developers manually create sub-tasks (slow, error-prone, incomplete), leaving QA to reverse-engineer vague tests. With it, one command generates a verified sub-task in 30–60 seconds, eliminating guesswork and rework.
</task>

<instructions>

## Overview

When you've implemented a feature with user-facing behavior, QA needs to verify it. This skill invokes a tool that **auto-generates a structured Jira QA sub-task** tied to your story's acceptance criteria, with a red-blue-judge verification gate ensuring the tests are sound.

**Without this skill:** You'd manually create a sub-task, copy-paste acceptance criteria into the description, guess at assignees, and hope the structure is clear enough for QA — a 15–20 minute process that often produces incomplete tests.

**With this skill:** One command generates a sub-task with ISTQB-structured test steps (Prerequisites, Test N with Expected/Verify, Pass Criteria) — each step grounded in a specific acceptance criterion — and the judge verifies it against your code diff before creating the Jira ticket, so you know the tests are testable and complete.

## When to Use

**Use when:**
- Feature is implemented and code-reviewed, **because** at this point the code diff is stable and AC mapping is reliable
- Story/defect has acceptance criteria written in Jira (AC field), **so that** the tool can tie each test to a concrete AC criterion
- No QA sub-task exists yet on the parent ticket, **because** the tool asks for confirmation if one exists, but creating fresh is the happy path
- **Behavior is QA-verifiable** (QA can inspect it without logs), **to avoid** tests that are unmeasurable or require log diving:
  - File system state (temp folders, checkpoint files, teardown)
  - Browser state (IndexedDB, localStorage, DOM, Network requests)
  - User workflows (pause/resume, state transitions, error recovery)

**Skip when:**
- Change is internal/infrastructure only (no observable user behavior), **because** QA cannot verify it without code-level inspection
- Cypress/Playwright E2E tests fully cover the user workflow, **so that** you don't duplicate test coverage
- Sub-task already exists (tool will ask if you want to replace it), **and** you decide not to regenerate

**Scope decision grid** (use this to decide whether behavior is QA-verifiable):

| Observable by QA? | Example | Action |
|---|---|---|
| Yes — file state | Download creates temp folder, teardown removes it | ✓ Use `/generate-qa-subtask` |
| Yes — browser state | IndexedDB persists across sessions; user can see it in DevTools | ✓ Use `/generate-qa-subtask` |
| Yes — network | Resume sends Range header with checkpoint; inspect via Network tab | ✓ Use `/generate-qa-subtask` |
| No — logs only | Error logged to Splunk; no observable artifact | ✗ Skip; handle in E2E tests or manual debugging |
| No — internal state | In-memory cache invalidation; no QA-facing behavior | ✗ Skip; unit tests only |

## Time Cost vs. Manual Workaround

**Running `/generate-qa-subtask`:** 30–60 seconds. Tool creates Jira sub-task after judge passes (usually 1–2 iterations), **because** the judge loops internally without requiring your input.

**Doing it manually:** 15–20 minutes upfront for you (creating sub-task, structuring tests, guessing at AC mapping) + 15–30 minutes later for QA (reverse-engineering vague test steps, asking clarifying questions, iterating on what's actually testable), **so** the true cost is 30–50 minutes total and introduces delay into QA verification.

**Skipping it:** 0 minutes upfront + 45–60 minutes total for QA (no structured tests, must infer from AC + code diff + trial-and-error), **which** delays QA and usually creates rework when tests are found to be unmeasurable.

**Bottom line:** Tool pays for itself after one code-review cycle. If you're in a time crunch, skipping this doesn't save time—it just delays the work to QA and usually creates rework.

---

## How to Invoke

**Setup (one-time):** Ensure you're on a feature branch with a parent Jira ticket. The tool reads:
- Parent ticket from your branch name (e.g., `feat/ARC-1234-pause-download`)
- Code diff from git (your branch vs. main)
- Acceptance criteria from the Jira ticket's AC field

**Invocation:**

```bash
/generate-qa-subtask [ARC-TICKET] [--assignee QA_USER]
```

**Arguments:**
- `[ARC-TICKET]` (required): Parent ticket (e.g., `ARC-4831`). If omitted, tool reads branch name.
- `[--assignee QA_USER]` (optional): Jira username to assign the sub-task. By convention, this is the QA owner who will verify, **so that** the sub-task reaches the right person without manual routing.

**Example:**
```bash
/generate-qa-subtask ARC-4831 --assignee sarah.kim
```

## What Happens Inside (Reference)

The tool executes these steps in order:

1. **Ground** — Fetch parent ticket AC, read your code diff, check for existing sub-tasks, **to ensure** all inputs are available and consistent
2. **Draft** — Dispatch an agent to generate test steps in ISTQB format, tied to each AC criterion, **because** AI-assisted generation catches edge cases faster than manual writing
3. **Gate** — Red-blue-judge verifies the tests:
   - ✓ ISTQB structure (Prerequisites, Test N, Pass Criteria properly formed)
   - ✓ AC mapping (each test step grounds to a specific acceptance criterion)
   - ✓ Executability (tests are verifiable by inspecting actual artifacts, not logs)
   
   **This gate is essential, so that** malformed or untestable sub-tasks never reach Jira
4. **Iterate** — If judge fails, tool regenerates and re-verifies (you don't see this; waits until passing), **to ensure** the sub-task is actually correct before you see it
5. **Create** — Once judge passes, tool creates the Jira sub-task and links it to the parent, **because** judge passing is your guarantee that the tests are sound

## What the Generated Sub-Task Looks Like

**Summary:** `QA: Verify [feature name] per ARC-[ticket]`

**Description (ISTQB structure):**

```
Prerequisites:
- Test environment: [staging/local dev build]
- Fresh browser session (no cached state)

Test 1: Pause in-flight download
- Setup: Start a large download
- Step 1: Click "Pause" button after 30% complete
  Expected: Download halts, resume button appears
- Step 2: Wait 5 seconds
  Expected: Paused state persists, no progress change
- Verify: Check temp folder — checkpoint file exists with current byte offset
- Pass Criteria: Download halted, checkpoint file present, byte offset matches

Test 2: Resume from checkpoint
- Setup: Paused download from Test 1
- Step 1: Click "Resume"
  Expected: Download continues from checkpoint, not from start
- Verify: Inspect browser Network tab — request has Range header with saved byte offset
- Pass Criteria: Download continues from checkpoint within 1% of saved offset

Test 3: Resume across browser sessions
- Setup: Complete Test 1, close browser, reopen to same URL
- Step 1: Navigate to in-progress download (from history/session storage)
  Expected: Download state is restored
- Step 2: Resume download
  Expected: Continues from checkpoint
- Verify: Check temp folder — resume reads sidecars from temp dir, not fresh state
- Pass Criteria: Download resumes without losing progress

Test 4: Edge case — completion with errors
- Setup: Start download, inject a network error during transfer
- Step 1: Download fails midway
  Expected: Temp folder persists (not deleted on error)
- Step 2: Resolve network issue, retry
  Expected: Resume works from saved checkpoint
- Verify: Temp folder contains sidecars; resumption reads from them
- Pass Criteria: Error preserves temp state; resume restores from it

Test 5: Edge case — all-downloaded short-circuit
- Setup: Download completes
- Step 1: User clicks "Download" again for same file
  Expected: System detects completion, skips retransfer
- Verify: Check temp folder — cleaned up after completion; new download starts fresh
- Pass Criteria: No temp folder pollution; teardown removes completed state
```

**Assignee:** `[QA owner or unassigned for team lead routing]`

## Common Mistakes (What the Skill Prevents)

| Mistake | What happens | Skill prevents by |
|---------|---------|---------|
| **Forget entirely** | QA waits for guidance; ticket sits in `In Test` with no sub-task | Skill invocation is a deliberate step in your workflow; once you learn it, habit prevents skipping |
| **Manual + incomplete** | QA sub-task lacks structure; test steps are vague; AC mapping is implicit | Tool enforces ISTQB format; every step is grounded in a specific AC; judge verifies this |
| **Miss edge cases** | Happy-path tests only; error states and state transitions untested | Agent generates tests from code diff, identifying error paths and transitions; judge requires coverage |
| **Unverifiable tests** | QA can't run the tests because they assume logs/Splunk data | Agent generates tests that inspect actual artifacts (temp folders, network requests, file state); judge rejects log-only tests |
| **Wrong assignee/convention** | Sub-task is assigned to wrong person or lost in backlog | Skill documents convention (QA owner, or unassigned for backlog); you provide `--assignee` explicitly |

## Real Example: What a Successful Run Looks Like

<example label="happy-path">
```bash
$ /generate-qa-subtask ARC-4831 --assignee sarah.kim

Generating QA sub-task for ARC-4831 (pause-resume download)...
Parent ticket: ARC-4831 Story | Status: In Progress
Acceptance Criteria found: 4 criteria
Code diff: DownloadWorker.ts (+120 lines, -30 lines)

Drafting test steps...
Draft 1/2: [submitting to judge...]

Judge verdict (Draft 1):
  ✓ ISTQB structure: PASS
  ✓ AC mapping: PASS (all 4 AC criteria have corresponding tests)
  ⚠ Executability: WARN — Test 4 (error edge case) doesn't verify teardown 
               of failed state; temp folder inspection is mentioned but not 
               step-by-step. Suggest: add explicit "Check temp folder" step 
               with concrete assertion.

Draft 2/2: [regenerating with explicit teardown steps...]

Judge verdict (Draft 2):
  ✓ ISTQB structure: PASS
  ✓ AC mapping: PASS
  ✓ Executability: PASS

✓ Creating Jira sub-task...
✓ Sub-task ARC-4831.1 created: "QA: Verify pause-resume download functionality"
✓ Assigned to: sarah.kim

Next step: Transition ARC-4831 to "In Test" when QA is ready to verify.
```

**What happened here:**
- Judge reviewed the first draft and found a gap (error-case teardown verification wasn't explicit enough)
- Tool regenerated that section with concrete steps
- Judge passed on the second pass
- Sub-task was created automatically

**You didn't have to do anything.** Tool iterated automatically; you just waited ~30 seconds for the result.
</example>

<example label="edge-case-existing-subtask">
```bash
$ /generate-qa-subtask ARC-5000

Generating QA sub-task for ARC-5000 (IndexedDB persistence)...
Parent ticket: ARC-5000 Story | Status: In Progress
Acceptance Criteria found: 3 criteria
Code diff: IndexedDBStore.ts (+85 lines)

⚠ Sub-task already exists: ARC-5000.1 (QA: Verify IndexedDB persistence)

Replace existing sub-task? [Y/n]: n

No changes made. Use `/generate-qa-subtask ARC-5000 --force` to regenerate.
```

**What happened:** The tool detected an existing sub-task and asked before overwriting. You chose to keep it, so no Jira state changed. If you had answered `Y`, the tool would have regenerated fresh tests, replacing the old sub-task.
</example>

---

## Guarantee: When the Sub-Task Is Created

**The tool creates a Jira sub-task ONLY after the judge has passed all three gates**, because you need a guarantee that the tests are sound before they enter Jira. If judge rejects the tests after 3 iterations:
- Tool stops and reports the failure
- Sub-task is NOT created
- You see the judge's feedback and can decide: (a) debug the feature (tests may be revealing a real gap), or (b) create the sub-task manually

**You are never left with a malformed or incomplete sub-task.** Judge verification is a hard gate—sub-task creation happens after, not before.

**If something goes wrong during Jira creation:**
- Tool rolls back (deletes any partial sub-task) and reports the error
- You can re-run the command to retry
- Command is idempotent—safe to re-run multiple times, so retries never create duplicates

## Invocation from Your Branch

**Example workflow:**

```bash
# You're on feature branch feat/ARC-4831-pause-download
# Code is done and code-reviewed
# Ready to hand off to QA

/generate-qa-subtask

# Tool reads parent from branch name (ARC-4831)
# Generates tests, verifies with judge, creates sub-task
# Output: ✓ Sub-task ARC-4831.1 created — link to Jira

# Transition story to In Test when QA is ready
jira issue edit ARC-4831 --status "In Test"
```

## Jason-Only Scope (Temporary)

**Note:** This skill depends on the red-blue-judge `qa` mode being installed in your `~/.claude-os/` (the genome layer). Until `/transmit-claude-os` is run to propagate this to the team, this skill is **Jason-only**. After transmission, teammates can use it.

For now, if a teammate asks "can I use this?", the answer is "not yet — waiting on genome transmission." Document that in your team's internal notes.

---

## Quick Reference

| Scenario | Action |
|----------|--------|
| "Should I create a QA sub-task?" | If feature has user-facing behavior and no sub-task exists: yes, invoke `/generate-qa-subtask` |
| "How do I know if judge passed?" | You'll see `✓ Sub-task created` in output; tool iterated internally until passing |
| "What if I disagree with generated tests?" | Edit the Jira sub-task after creation; judge only verifies structure and AC mapping, not your judgment |
| "Can I run this mid-feature?" | Yes, but you'll get clearer results after code review (diff is finalized) |
| "What if sub-task exists?" | Tool asks: "Replace existing sub-task?" — your choice |

---

## Test Gate Rubric (What the Judge Checks)

The red-blue-judge gate verifies three dimensions:

**ISTQB Structure (Q1–Q5):**
- Q1: Does description have "Prerequisites" section? ✓
- Q2: Are tests numbered and named? ✓
- Q3: Does each test have Setup, Steps, Expected, Verify, Pass Criteria? ✓
- Q4: Are steps written in imperative (Step 1: Click X)? ✓
- Q5: Are pass criteria concrete and testable? ✓

**Acceptance Criteria Mapping (Q6–Q8):**
- Q6: Does each acceptance criterion map to at least one test? ✓
- Q7: Is the mapping explicit (test name or step mentions the AC)? ✓
- Q8: Are negative/error cases covered? ✓

**Executability (Q9–Q10):**
- Q9: Can tests be executed by inspecting actual artifacts (temp folders, files, requests), not just logs? ✓
- Q10: Are all assertions grounded in observable state? ✓

If any check fails, judge provides feedback and tool regenerates.

---

## Success Criteria

A successful run meets ALL of these criteria:

- [ ] Sub-task was created in Jira (not rejected or left pending)
- [ ] Sub-task summary follows format: "QA: Verify [feature name] per ARC-[ticket]"
- [ ] Description contains "Prerequisites" section with test environment and setup
- [ ] Tests are numbered (Test 1, Test 2, …) and each has a name
- [ ] Each test has: Setup, Steps (Step 1, Step 2, …), Expected results, Verify instructions, and Pass Criteria
- [ ] Each AC criterion from the parent ticket maps to at least one test (explicit mapping in test name or step)
- [ ] Edge cases are covered (error states, state transitions, completion, etc.) — not happy path only
- [ ] Tests are verifiable by inspecting artifacts (files, DevTools, Network tab) — not by reading logs
- [ ] Sub-task is assigned to QA owner (or left unassigned for team lead routing) per `--assignee` arg
- [ ] Judge passed all three gates (ISTQB structure, AC mapping, executability) — reported in tool output

If ALL criteria are met, the sub-task is ready for QA verification.

</instructions>

