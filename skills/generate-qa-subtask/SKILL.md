---
name: generate-qa-subtask
description: Generates a structured Jira QA verification sub-task using Agile Manual Verification protocol, with honesty-focused red-blue-judge gate verification. Use when authoring a QA verification sub-task for user-facing behavior that requires manual verification — e.g., "/generate-qa-subtask ARC-1234" after code review, before opening PR.
---

# Generate QA Subtask

<role>
You are a QA engineering assistant. Your role is to guide developers in invoking a tool that auto-generates Agile Manual Verification sub-tasks so that QA workflows are clear, traceable, and grounded in the actual code changes — reducing back-and-forth and catching test gaps early.
</role>

<task>
**What this skill does:** It teaches how to invoke `/generate-qa-subtask` — a tool that automatically creates a Jira QA sub-task with Agile Manual Verification structure (Prerequisites, Tests, Pass Criteria), verified by red-blue-judge for honesty against the code diff and acceptance criteria before creation.

**Why it matters:** Without this skill, developers manually write vague test steps that QA reverse-engineers (15–20 minutes of friction). With it, one command generates a verified sub-task in 30–60 seconds that actually checks what changed, maps to AC, and covers error cases the code handles.
</task>

<instructions>

## Overview

When you've implemented a feature, QA needs concrete, honest test steps to verify it. This skill invokes a tool that **auto-generates an Agile Manual Verification sub-task** tied to your acceptance criteria and code changes, with a red-blue-judge gate that ensures the tests are honest (actually verify the diff), complete (cover all AC), and realistic (QA can execute them).

**Without this skill:** You leave vague test steps in Jira. QA asks clarifying questions. Tests miss edge cases the code handles. Rework loop.

**With this skill:** Tests are generated from your code diff and AC, verified to be honest against both, and ready for QA to execute immediately.

## When to Use

**Use when:**
- Feature is implemented and code-reviewed, **because** the code diff is stable and changes are clear
- Story/defect has acceptance criteria written in Jira (AC field), **so that** tests can tie explicitly to each criterion
- No QA sub-task exists yet on the parent ticket, **because** a fresh sub-task with honest tests is better than a vague manual one
- **Behavior is QA-verifiable** (QA can test it without reading logs), **to avoid** unverifiable tests:
  - File system state (temp folders, checkpoint files, teardown)
  - Browser state (IndexedDB, localStorage, DOM, Network requests)
  - User workflows (pause/resume, state transitions, error recovery)

**Skip when:**
- Change is internal/infrastructure only (no observable user behavior), **because** QA cannot verify code-internal changes
- Cypress/Playwright E2E tests fully cover the workflow, **so that** you don't duplicate test coverage
- Sub-task already exists (tool will ask if you want to replace it), **and** you decide not to regenerate

**Scope decision grid** (observable behavior = use the skill):

| Observable by QA? | Example | Action |
|---|---|---|
| Yes — file state | Download creates temp folder, teardown removes it | ✓ Use `/generate-qa-subtask` |
| Yes — browser state | IndexedDB persists across sessions; user can see it in DevTools | ✓ Use `/generate-qa-subtask` |
| Yes — network | Resume sends Range header with checkpoint; inspect via Network tab | ✓ Use `/generate-qa-subtask` |
| Yes — error path | Error is displayed to user; graceful degradation on network failure | ✓ Use `/generate-qa-subtask` |
| No — logs only | Error logged to Splunk; no observable artifact | ✗ Skip; handle in E2E tests or monitoring |
| No — internal state | In-memory cache invalidation; no QA-facing behavior | ✗ Skip; unit tests only |

## Time Cost vs. Manual Workaround

**Running `/generate-qa-subtask`:** 30–60 seconds. Tool generates tests from diff and AC, judge verifies honesty and coverage (1–2 iterations typical).

**Doing it manually:** 15–20 minutes upfront for you (writing test steps, guessing at completeness) + 15–30 minutes for QA (asking for clarification, discovering missing edge cases, retesting).

**Skipping it:** 0 minutes upfront + 45–60 minutes for QA (reverse-engineering from AC + code, missing error cases, discovering unmeasurable tests).

**Bottom line:** Tool pays for itself immediately. Time pressure is when you most need it—skipping doesn't save time, just shifts burden and rework to QA.

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

1. **Ground** — Fetch parent ticket AC, read your code diff, check for existing sub-tasks, **to ensure** all inputs are available and clear
2. **Draft** — Dispatch an agent to generate test steps in Agile Manual Verification format (Prerequisites, Tests, Pass Criteria), tied to each AC criterion and error paths in the diff, **because** agent-assisted generation catches edge cases faster than manual writing
3. **Gate** — Red-blue-judge verifies the tests across three dimensions:
   - **Coverage**: Does every AC criterion have at least one test?
   - **Honesty**: Do the tests actually verify what the diff changed (not make-believe tests)?
   - **Executability**: Can QA realistically execute these tests given the changes?
   
   **This gate is essential, so that** unverifiable or dishonest sub-tasks never reach Jira
4. **Iterate** — If judge fails on any gate, tool regenerates and re-verifies (you see the verdicts; tool loops up to 3 times), **to ensure** the sub-task is sound before creation
5. **Create** — Once all three gates pass, tool creates the Jira sub-task and links it to the parent, **because** judge passing is your guarantee that tests are honest and complete

## What the Generated Sub-Task Looks Like

**Summary:** `QA: Verify [feature name] per ARC-[ticket]`

**Description (Agile Manual Verification format):**

```
## QA Verification Steps

Fix for ARC-4831 — pause/resume download functionality.

### Prerequisites

* Integration environment with feature deployed
* Chrome or Edge browser (File System Access API required)
* Feature flag `arc_v3_downloads` enabled
* Test file: at least 10 MB to trigger resume scenario

### Test 1: Pause in-flight download

1. Start a large download (>10 MB)
2. After 30% completes, click "Pause"
3. Wait 5 seconds to confirm pause persists

**Expected:** Download halts, resume button appears, progress is retained

### Test 2: Resume from checkpoint

1. From paused state (Test 1), click "Resume"
2. Monitor Network tab during resume
3. Confirm download continues

**Expected:** Request has Range header with saved byte offset; download continues from checkpoint, not from start

### Test 3: Resume across browser sessions

1. Complete Test 1 (pause download)
2. Close browser completely
3. Reopen and navigate to downloads
4. Click "Resume" on paused download

**Expected:** Download state is restored; resume continues from checkpoint without losing progress

### Test 4: Error case — network interruption during pause

1. Start download
2. Pause at 50%
3. Disconnect network (airplane mode)
4. Wait 10 seconds
5. Reconnect and click "Resume"

**Expected:** Download resumes successfully from checkpoint (or shows explicit error message); does NOT stall indefinitely

### Pass Criteria

* [ ] Pause button halts download and preserves state (filesystem checkpoint exists)
* [ ] Resume continues from checkpoint, not from start (confirmed via Network Range header)
* [ ] Resume works after browser close/reopen (state persisted in IndexedDB or localStorage)
* [ ] Network error during pause does not stall download; graceful recovery or explicit error message
* [ ] Download completes or fails with clear status message (not silent failure)
```

**Assignee:** `[QA owner or unassigned for team lead routing]`

## Common Mistakes (What the Skill Prevents)

| Mistake | What happens | Skill prevents by |
|---------|---------|---------|
| **Vague test steps** | QA asks clarifying questions; tests are ambiguous | Tests are grounded in the diff; each step is concrete and tied to observable state |
| **Missing edge cases** | Error paths and state transitions are untested | Agent detects error handling in code (try/catch, fallbacks) and generates error-case tests |
| **Unverifiable tests** | QA can't execute tests because they assume logs or internal state | Judge rejects any test that requires logs; enforces observable verification only |
| **AC coverage gaps** | Some AC criteria have no tests; QA guesses what to verify | Judge requires every AC criterion mapped to at least one test |
| **Wrong assignment** | Sub-task is lost in team backlog | Skill documents convention; you use `--assignee` explicitly |

## Real Example: Agile Manual Verification Sub-Task

<example label="happy-path-verification">
```bash
$ /generate-qa-subtask ARC-4831 --assignee sarah.kim

Generating QA sub-task for ARC-4831 (pause-resume download)...
Parent ticket: ARC-4831 Story | Status: In Progress
Acceptance Criteria found: 4 criteria
Code diff: DownloadWorker.ts (+156 lines, -45 lines)

Drafting test steps (Agile Manual Verification)...
Draft 1/2: [submitting to judge...]

Judge verdict (Draft 1):
  ✓ Coverage: PASS (all 4 AC criteria have corresponding tests)
  ⚠ Honesty: WARN — Test 4 (error case) claims to test network 
               interruption, but code shows timeout handling; test 
               should explicitly verify timeout behavior, not just 
               network disconnect
  ✓ Executability: PASS (all tests use observable state)

Draft 2/2: [regenerating with explicit timeout scenario...]

Judge verdict (Draft 2):
  ✓ Coverage: PASS
  ✓ Honesty: PASS (all tests verify what code actually does)
  ✓ Executability: PASS

✓ Creating Jira sub-task...
✓ Sub-task ARC-4831.1 created: "QA: Verify pause-resume download functionality"
✓ Assigned to: sarah.kim

Next step: Transition ARC-4831 to "In Test" when QA is ready to verify.
```

**What happened here:**
- Judge caught that the first test was **dishonest** — it claimed to test network disconnect but the code handles timeouts, not network errors
- Tool regenerated with an actual timeout test that matches the code
- Judge passed on round 2 because tests now honestly verify what the code does
- Sub-task was created with confidence that QA will test the right things

**You didn't write a single test step.** Tool generated them from your diff and AC, judge verified honesty, and QA gets a concrete, correct sub-task.
</example>

<example label="edge-case-existing-subtask">
```bash
$ /generate-qa-subtask ARC-5000

Generating QA sub-task for ARC-5000 (IndexedDB persistence)...
Parent ticket: ARC-5000 Story | Status: In Progress
Acceptance Criteria found: 3 criteria
Code diff: IndexedDBStore.ts (+89 lines, -12 lines)

⚠ Sub-task already exists: ARC-5000.1 (QA: Verify IndexedDB persistence)

Replace existing sub-task? [Y/n]: n

No changes made. Use `/generate-qa-subtask ARC-5000 --force` to regenerate.
```

**What happened:** Tool detected an existing sub-task and asked before overwriting. You chose to keep it.
</example>

---

## Guarantee: When the Sub-Task Is Created

**The tool creates a Jira sub-task ONLY after all three judge gates pass**, because you need a guarantee that tests are honest, complete, and executable before QA starts. If judge rejects tests after 3 iterations:
- Tool stops and reports the failures
- Sub-task is NOT created
- You see which gate failed (coverage, honesty, or executability) and why
- You can debug the feature (tests may be revealing a real gap) or use `--force` to override

**You are never left with a dishonest or incomplete sub-task.** Judge verification is a hard gate.

**If something goes wrong during Jira creation:**
- Tool rolls back (deletes any partial sub-task) and reports the error
- You can re-run the command to retry
- Command is idempotent—safe to re-run multiple times

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
| "What if judge rejects tests?" | Judge report shows which gate failed (coverage/honesty/executability) and why; tool auto-iterates up to 3 times |
| "What if I disagree with generated tests?" | Edit the Jira sub-task after creation; judge only verifies honesty against diff, not your judgment |
| "Can I run this mid-feature?" | Yes, but you'll get clearer results after code review (diff is finalized) |
| "What if sub-task exists?" | Tool asks: "Replace existing sub-task?" — your choice |
| "How do I force creation if judge fails?" | Use `--force` flag to bypass judge and create anyway (not recommended; indicates a real problem) |

---

## Red-Blue-Judge Gate: Three Dimensions

The red-blue-judge gate verifies:

**Coverage Gate:**
- Does every AC criterion have at least one test? ✓
- Are all AC criteria explicitly mapped to tests? ✓

**Honesty Gate:**
- Do tests actually verify what the code changed (not make-believe tests)? ✓
- Are tests grounded in observable state (not logs)? ✓
- Do error-case tests match error handling the code implements? ✓

**Executability Gate:**
- Can QA realistically run these tests (no impossible expectations)? ✓
- Are Prerequisites accurate and sufficient? ✓
- Are test steps concrete and measurable? ✓

If any gate fails, judge provides feedback specific to that dimension and tool regenerates.

---

## Success Criteria

A successful run meets ALL of these criteria:

- [ ] Sub-task was created in Jira (not rejected or left pending)
- [ ] Sub-task summary follows format: "QA: Verify [feature name] per ARC-[ticket]"
- [ ] Description contains "Prerequisites" section with environment, flags, browser, access
- [ ] Tests are numbered (Test 1, Test 2, …) and each has a concrete name
- [ ] Each test has: imperative steps (1, 2, 3...), Expected results, and Verification method
- [ ] Each AC criterion from the parent ticket maps to at least one test (coverage gate passed)
- [ ] Tests verify what the code actually changed, not hypothetical behavior (honesty gate passed)
- [ ] Error/edge cases are tested if code handles them (agent detected error handling in diff)
- [ ] Tests use observable verification (DevTools, Network tab, file state) — never logs only
- [ ] Pass Criteria are checkbox items derived from AC criteria
- [ ] Sub-task is assigned to QA owner (or left unassigned for team lead routing) per `--assignee` arg
- [ ] Judge passed all three gates (Coverage, Honesty, Executability) — reported in tool output

If ALL criteria are met, the sub-task is ready for QA to execute immediately without clarification.

</instructions>
