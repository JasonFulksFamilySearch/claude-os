---
name: ship
description: Pre-flight quality gates → commit → push → wait for CI → conditional Slack post
argument-hint: "[--no-slack] [--skip-lint] [--skip-tests] [--skip-patterns] [--skip-security]"
allowed-tools: Bash(git *) Bash(gh *) Bash(npm *) Bash(mvn *) Bash(npx *)
---

# Ship Orchestrator

Run quality pre-flight checks, commit, push, wait for CI, and post to Slack on success.
You are orchestrating a multi-step pipeline. **Stop and report clearly at the first failure.**
Do not proceed to the next phase if the current phase fails.

## Arguments

`$ARGUMENTS`

Supported flags (any order, all optional):
- `--no-slack` — push and wait for CI but skip the Slack post even on success
- `--skip-lint` — skip linting phase
- `--skip-tests` — skip test execution phase
- `--skip-patterns` — skip JavaScript/TypeScript pattern review
- `--skip-security` — skip security scan phase

---

## Phase 0: Orientation

Run these in parallel before doing anything else:

```bash
git branch --show-current
git status
git diff --stat HEAD
```

Identify:
- The current branch name (extract JIRA ticket if present, e.g. `feat/ARC-1234-desc` → `ARC-1234`)
- How many files are modified or untracked
- Whether the working tree is clean or has unstaged/untracked changes

Report a one-line summary: `Branch: <branch> | Ticket: <ticket or none> | Changed files: <count>`

---

## Phase 1: Pre-flight Checks

Run each enabled check sequentially. **A single failure in any step halts the ship.**

### Detect Stack

Before running checks, detect the project type by looking for:
- `pom.xml` → Java/Maven project
- `package.json` → Node.js/JavaScript/TypeScript project
- Both → mixed (run both toolchains)

### 1a. Lint (skip if `--skip-lint` passed)

**Java/Maven:**
```bash
mvn checkstyle:check -q
```

**Node.js:**
```bash
npm run lint --if-present
```
If `lint` script doesn't exist in `package.json`, try:
```bash
npx eslint . --ext .js,.ts,.jsx,.tsx --max-warnings 0
```

If lint fails: report all violations, show file + line + rule. **Stop. Do not proceed.**

### 1b. Tests (skip if `--skip-tests` passed)

Check whether tests were already run and passed **in this session** by looking for prior tool output showing `BUILD SUCCESS`, `Tests passed`, `✓`, or exit code 0 from a test command.

**If tests already passed this session:** Skip and note "Tests already verified this session."

**Otherwise:**

**Java/Maven:**
```bash
mvn clean test -q
```

**Node.js:**
```bash
npm test --if-present
```

If tests fail: report failing test names, error messages, and stack traces. **Stop. Do not proceed.**

### 1c. JavaScript/TypeScript Pattern Review (skip if `--skip-patterns` passed)

Only run if Node.js project or if `.js`/`.ts`/`.jsx`/`.tsx` files are in the diff.

Get the list of changed JS/TS files:
```bash
git diff --name-only HEAD | grep -E '\.(js|ts|jsx|tsx)$'
```

If changed JS/TS files exist, invoke the `javascript-typescript:modern-javascript-patterns` skill focused on those specific files.

If the skill surfaces any **blocking issues** (memory leaks, broken async patterns, security anti-patterns): report them. **Stop. Do not proceed.**

Advisory issues (style suggestions) should be reported but do not block shipping.

### 1d. Security Scan (skip if `--skip-security` passed)

Invoke the `security-review` skill focused on the staged diff only:
```bash
git diff --staged
```

If the review surfaces any **HIGH or CRITICAL severity** issues: report them with file and line. **Stop. Do not proceed.**

MEDIUM/LOW issues are reported as advisories and do not block shipping.

---

## Phase 1 Gate

After all enabled pre-flight checks pass, print:

```
✅ Pre-flight complete
   Lint:     PASSED (or SKIPPED)
   Tests:    PASSED (or SKIPPED / already verified)
   Patterns: PASSED (or SKIPPED / no JS/TS files)
   Security: PASSED (or SKIPPED)
```

Ask for confirmation before proceeding: **"Pre-flight passed. Proceed with commit and push?"**
Wait for user approval before continuing to Phase 2.

---

## Phase 2: Commit

Invoke the `/commit` skill to create the commit.

The commit skill handles:
- Conventional commit format
- JIRA ticket extraction from branch name
- Staging and executing the git commit
- Handling split-commit detection

Wait for the commit skill to complete and confirm the commit exists:
```bash
git log --oneline -1
```

If commit fails for any reason: report the error. **Stop. Do not proceed.**

---

## Phase 3: Push

Push the branch to the remote:
```bash
git push -u origin $(git branch --show-current)
```

Capture and report:
- The remote URL the branch was pushed to
- The full branch name
- The PR URL if GitHub responds with one (look for `https://github.com/` in push output)

If no PR exists yet, check for one:
```bash
gh pr view --json url,number,title 2>/dev/null
```

If no PR: note "No PR exists yet — CI will still run on the pushed branch."

---

## Phase 4: Wait for CI

Poll GitHub Actions until the most recent workflow run completes or the timeout is reached.

**Timeout:** 20 minutes. Check every 2 minutes.

Poll command:
```bash
gh run list --branch $(git branch --show-current) -L 1 --json status,conclusion,name,databaseId --jq '.[0]'
```

Each poll cycle, report:
- Run name
- Current status (`queued` / `in_progress` / `completed`)
- Elapsed time

**Do not use `sleep` loops.** Between polls, inform the user of the current status and elapsed time, then pause and check again on the next iteration. Use this natural polling approach rather than a blocking shell loop.

When status = `completed`, check conclusion:

- `success` → proceed to Phase 5
- `failure` → fetch failure details:
  ```bash
  gh run view <databaseId> --log-failed
  ```
  Report: which jobs failed, the failing steps, and the first error lines. **Do not post to Slack.** Stop and report.
- `cancelled` → report cancellation. Ask user how to proceed.

**Timeout reached without completion:** Report "CI still running after 20 minutes. Run `/ship --no-slack` to retry the Slack check once CI completes, or check manually with `gh run list`."

---

## Phase 5: Conditional Slack Post

Only reached if Phase 4 concluded with `success`.

Skip this phase if `--no-slack` was passed.

Invoke the `/pr-to-slack` skill to post the PR to #arc-team-devs.

---

## Final Report

Always end with a structured summary regardless of outcome:

```
─── Ship Report ─────────────────────────────────
Branch:    <branch>
Ticket:    <JIRA ticket or none>
Commit:    <short SHA> <subject>

Phase 1 Pre-flight:  ✅ / ❌ <reason>
Phase 2 Commit:      ✅ / ❌ <reason>
Phase 3 Push:        ✅ / ❌ <reason>
Phase 4 CI:          ✅ / ❌ <conclusion> (<elapsed>)
Phase 5 Slack:       ✅ / ⏭ SKIPPED / ❌ <reason>
─────────────────────────────────────────────────
```
