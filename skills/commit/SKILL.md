---
name: commit
description: >
  Generate and create a git commit following conventional commit standards
  with JIRA ticket integration. Use when the user says "commit", "create a
  commit", "commit my changes", invokes /commit, or asks to save work to git.
  Also trigger when staged or unstaged changes are present and the user asks
  to wrap up a task.
allowed-tools: Bash(git:*)
argument-hint: [optional: custom message]
---

<role>
You are a senior engineer who values clean, atomic, well-explained commits.
Your job is to read the actual staged and unstaged changes before writing
anything — never assert facts about the diff you have not read in this session.
Good commits are small in scope, honest about WHY a change was made, and written
so a future reader can understand the decision without having been in the room.
</role>

<task>
Analyze the current git state, draft a commit message following the format
below, and execute the commit. Propose splitting when mixed concerns are detected.

Constraints:
- Run pre-commit hooks by default; add `--no-verify` only when tests have
  already passed earlier in this session (see Step 4 for the check). Hooks
  run the test suite — skipping them before tests have passed risks
  committing code that breaks the build.
- Omit the `Co-Authored-By` footer entirely — not wanted in any commits.
- Stage specific files by name; use `git add -A` only when no file list
  exists. Named staging prevents accidentally committing credentials or
  generated files that happen to be untracked.
- Use HEREDOC format for multi-line commit messages. Shell quoting inside
  `git commit -m "..."` mangles newlines and special characters; HEREDOC
  is the only reliable cross-platform approach.
- This is a local, reversible operation (undo with `git reset HEAD~1`);
  do not push to remote unless explicitly instructed.
</task>

## Commit Message Requirements

<format>
**Subject Line:** `<Tag>[!]: <description> [(<JIRA-TICKET>)]` (max 50 chars)

**Valid Tags:**
- `Feat` — New feature
- `Fix` — Bug fix
- `Docs` — Documentation changes
- `Style` — Code style/formatting (no logic change)
- `Chore` — Maintenance tasks
- `Refactor` — Code restructuring (no behavior change)
- `Test` — Adding or updating tests
- `Perf` — Performance improvements
- `Build` — Build system changes
- `CI` — CI/CD pipeline changes
- `Revert` — Reverting previous commits

**Breaking Changes:** Add `!` after tag (e.g., `Feat!:`). MUST include
`BREAKING CHANGE:` footer explaining the impact.

**JIRA Ticket:** Extract from branch name (`UPPERCASE-###`). Recommended
but optional.

**Body:** Wrapped at 72 characters (the standard git terminal display width).
Write in complete prose sentences — future readers need narrative context,
not a checklist. Explain WHAT changed, WHY it was necessary, and the IMPACT
on the system. Separate from subject with a blank line.
</format>

Think carefully about the diff before selecting a commit type — a change that
cannot be described cleanly in 50 characters is almost always two commits.

## Step 1: Gather Information

Run these git commands IN PARALLEL — they are independent:

```bash
git status
git diff --staged
git diff
git log --oneline -5
git branch --show-current
```

Read all output before proceeding. Never describe the diff without having
read it in this session.

## Step 2: Analyze Changes

- Identify primary change type (feat/fix/chore/etc.)
- Determine if this is a breaking change (incompatible API changes)
- Extract JIRA ticket from branch name (e.g., `feat/ARC-1234-description` → `ARC-1234`)
- Understand WHY changes were made (not just WHAT changed)

**Split detection:** Look for mixed concerns in the diff. If you find both
new behavior (feat/fix) AND structural restructuring with no behavior change
(refactor) in the same set of files, flag this before proceeding:

> "These changes contain both feature work and refactoring. I recommend
> splitting into two commits:
> 1. `Refactor:` — [structural changes]
> 2. `Feat/Fix:` — [behavioral changes]
> Proceed as two commits, or commit everything together?"

**Clarity test:** Try to write the subject line. If you cannot describe the
change cleanly in under 50 characters without vague language ("Update various
things", "Fix multiple issues"), the commit is too broad — apply split
detection before drafting.

## Step 3: Draft Commit Message

Generate a commit message following this exact format:

```
<Tag>[!]: <concise description> [(<JIRA-TICKET>)]

<Verbose explanation of WHAT changed, WHY it was necessary, and
the IMPACT on the system. Wrapped at 72 characters. Written in
prose, not bullet points.>

[Optional second paragraph for additional context or implications.]

[BREAKING CHANGE: Detailed explanation of incompatibility]
```

**Subject line rules:**
- 50 characters maximum
- Capitalize first word of description
- End without a trailing period
- Imperative mood ("Add feature" not "Added feature")
- Include JIRA ticket in parentheses when found

**Body rules:**
- Hard-wrap at 72 characters
- Focus on WHY and IMPACT, not just WHAT
- Write in complete prose sentences
- One focused topic per paragraph

## Step 4: Check for Prior Test Execution

Before committing, verify whether tests were already run and passed earlier
in this conversation session:

- Looks for: `npm run test:ci`, `npm test`, `mvn clean test`, or equivalent
- Passed means: exit code 0, "Tests passed", or "BUILD SUCCESS"

When tests passed earlier in this session: add `--no-verify` to skip the
redundant pre-commit hook run (the work was already validated, and running
it again is pure overhead).

When tests have not been run or did not pass: commit without `--no-verify`
so pre-commit hooks run as normal.

## Step 5: Execute Commit

Show the generated commit message in a code block for review. Stage relevant
files using specific file names, then execute:

```bash
# When tests already passed in this session:
git commit --no-verify -m "$(cat <<'EOF'
<Your generated commit message here>
EOF
)"

# Default — hooks run normally:
git commit -m "$(cat <<'EOF'
<Your generated commit message here>
EOF
)"
```

Run `git status` after commit to verify success.

**Loop until clean:** After a successful commit, check `git status`. If
uncommitted changes remain, return to Step 1 and repeat the full cycle for
the next logical group. Report how many commits were created when done.

## Pre-Commit Validation

Before committing, verify:
- [ ] All intended changes staged correctly
- [ ] Subject is 50 characters or fewer
- [ ] Body is wrapped at 72 characters
- [ ] Body explains WHY and IMPACT in complete prose sentences
- [ ] JIRA ticket included when branch contains one
- [ ] `BREAKING CHANGE:` footer present when subject uses `!`
- [ ] Co-Authored-By footer omitted

## Examples

<examples>
<example label="good-feature">
```
Feat: Add batch retry mechanism for failed downloads (ARC-3502)

The download system had no recovery mechanism when network requests
failed intermittently. Implemented an exponential backoff retry
strategy with a maximum of 3 attempts per file.

This improves reliability for users on unstable connections and
reduces manual intervention for transient failures.
```
</example>

<example label="good-breaking-change">
```
Feat!: Refactor worker message protocol (ARC-3501)

Removed the legacy v2 message wrapper format in favor of direct
v3 message structure. All workers now use the new format without
backward compatibility shims.

This simplifies the codebase and improves message routing
performance by eliminating unnecessary wrapping overhead.

BREAKING CHANGE: v2 plugins will no longer receive messages.
Migration guide: Update all v2 workers to v3 format by
implementing the new message structure defined in the v3 README.
```
</example>

<example label="good-fix">
```
Fix: Prevent infinite loop in worker cleanup routine

The cleanup function was recursively calling itself without a
termination condition when workers failed to terminate gracefully.
Added a maxRetries limit of 3 attempts per cleanup session.

This resolves race conditions where multiple cleanup attempts
would orphan worker threads and eventually crash the application.
```
</example>

<example label="bad-commits">
```
# Too vague
Fix: Updated files

# No explanation
Feat: Add feature (ARC-1234)

# Body has bullet points (should be prose)
Fix: Fix bug

- Added validation
- Fixed issue
- Updated tests

# Subject too long (over 50 chars)
Feat: Add comprehensive batch retry mechanism with exponential backoff

# No breaking change footer when using !
Feat!: Change API structure

Changed the API structure completely.
```
</example>
</examples>

## Handling Edge Cases

<edge_cases>
**No JIRA ticket in branch:** Omit ticket from subject line — it is optional.

**Multiple unrelated changes:** Suggest splitting into multiple commits; ask
which changes to include in this commit.

**No staged changes:** Ask which files to stage. Only create commits when
staged changes exist.

**Pre-commit hook fails:** Fix the underlying issue, re-stage the affected
files, and create a NEW commit. Using `--amend` after a hook failure modifies
the previous commit and may destroy prior work.
</edge_cases>

<success_criteria>
- All git state (status, diff --staged, diff, log, branch) was read before drafting the message
- Commit subject is ≤50 characters with a valid conventional-commit tag
- Body is wrapped at 72 characters and written in complete prose sentences (not bullets)
- JIRA ticket is included in the subject when the branch name contains one
- `Co-Authored-By` footer is absent from the commit message
- Split detection was applied when mixed concerns were identified in the diff
- Pre-commit hooks ran unless tests already passed in this session (with explicit note)
- `git status` confirmed a clean working tree after the commit
- All uncommitted changes that existed before the skill ran were committed or explained
</success_criteria>
