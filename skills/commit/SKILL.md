---
name: commit
description: Generate and create a git commit following conventional commit standards with JIRA ticket integration
allowed-tools: Bash(git:*)
argument-hint: [optional: custom message]
---

# Conventional Commit Generator with JIRA Integration

You are creating a git commit following strict conventional commit standards.

## Commit Message Requirements

**Subject Line Format:** `<Tag>[!]: <description> [(<JIRA-TICKET>)]` (Max 50 characters)

**Valid Tags:**
- `Feat` - New feature
- `Fix` - Bug fix
- `Docs` - Documentation changes
- `Style` - Code style/formatting (no logic change)
- `Chore` - Maintenance tasks
- `Refactor` - Code restructuring (no behavior change)
- `Test` - Adding or updating tests
- `Perf` - Performance improvements
- `Build` - Build system changes
- `CI` - CI/CD pipeline changes
- `Revert` - Reverting previous commits

**Breaking Changes:**
- Add exclamation mark after tag for breaking changes (e.g., Feat!:)
- MUST include BREAKING CHANGE: footer explaining the impact

**JIRA Ticket:**
- Extract from branch name (format: UPPERCASE-###)
- Example: Branch feat/ARC-3502-fix-worker → Ticket (ARC-3502)
- RECOMMENDED but OPTIONAL

**Body:**
- Wrapped at 72 characters per line
- Explain WHAT changed, WHY it was necessary, and the IMPACT
- NO bullet points - use prose paragraphs
- Multiple paragraphs allowed (one focus per paragraph)
- Separate body from subject with blank line

**Footers (Optional):**
- Format: Token: value
- BREAKING CHANGE: required when exclamation mark is used in subject
- Refs: for issue references
- ❌ NEVER add Co-Authored-By footer - not wanted in any commits

## Your Task - Follow This Sequence

### Step 1: Gather Information

Run these git commands IN PARALLEL:

```bash
git status
git diff --staged
git diff
git log --oneline -5
git branch --show-current
```

**Why:** Understand current state, changes, commit history style, and extract JIRA ticket from branch name.

### Step 2: Analyze Changes

- Identify primary change type (feat/fix/chore/etc.)
- Determine if breaking change (incompatible API changes)
- Extract JIRA ticket from branch name (e.g., `feat/ARC-1234-description` → `ARC-1234`)
- Understand WHY changes were made (not just WHAT changed)

**Split detection:** Look for mixed concerns in the diff. If you find both new behavior (feat/fix) AND structural restructuring with no behavior change (refactor) in the same set of files, flag this before proceeding:

> "These changes contain both feature work and refactoring. I recommend splitting into two commits:
> 1. `Refactor:` — [structural changes]
> 2. `Feat/Fix:` — [behavioral changes]
> Proceed as two commits, or commit everything together?"

**Clarity test:** Try to write the subject line. If you cannot describe the change cleanly in under 50 characters without resorting to vague language ("Update various things", "Fix multiple issues"), the commit is too broad — apply split detection above before drafting.

### Step 3: Draft Commit Message

Generate a commit message following this EXACT format:

```
<Tag>[!]: <concise description> [(<JIRA-TICKET>)]

<Verbose explanation of WHAT changed, WHY it was necessary, and
the IMPACT on the system. Wrapped at 72 characters. Written in
prose, not bullet points.>

[Optional second paragraph if needed to explain additional
context or implications.]

[BREAKING CHANGE: Detailed explanation of incompatibility]
```

**Subject Line Rules:**
- Max 50 characters
- Capitalize first word of description
- No period at end
- Imperative mood ("Add feature" not "Added feature")
- Include JIRA ticket in parentheses if found

**Body Rules:**
- Hard wrap at 72 characters
- Focus on WHY and IMPACT, not just WHAT
- Use complete sentences
- NO markdown lists or bullet points

### Step 4: Check for Prior Test Execution

Before committing, check whether unit tests were already run **and passed** earlier in this conversation session:

- Look for successful execution of `npm run test:ci`, `npm test`, `mvn clean test`, or equivalent test commands
- Tests must have **passed** (not just run) — look for exit code 0 / "Tests passed" / "BUILD SUCCESS"

**If tests passed earlier in this session:** Add `--no-verify` to the commit command in Step 5 to skip redundant pre-commit hook test execution.

**If tests were NOT run or did NOT pass:** Commit normally without `--no-verify` (pre-commit hooks will run as usual).

### Step 5: Execute Commit

- Show the generated commit message in a code block for reference
- Stage all relevant files using git add with specific file names (prefer specific files over git add -A)
- Create commit using HEREDOC format:

```bash
# When tests already passed in this session (Step 4):
git commit --no-verify -m "$(cat <<'EOF'
<Your generated commit message here>
EOF
)"

# Otherwise (default — hooks run normally):
git commit -m "$(cat <<'EOF'
<Your generated commit message here>
EOF
)"
```

- Run git status after commit to verify success

**Loop until clean:** After a successful commit, check `git status`. If uncommitted changes remain, return to Step 1 and repeat the full cycle for the next logical group. Continue until the working tree is clean. Report how many commits were created when done.

## Examples

### ✅ Good Feature Commit
```
Feat: Add batch retry mechanism for failed downloads (ARC-3502)

The download system had no recovery mechanism when network requests
failed intermittently. Implemented an exponential backoff retry
strategy with a maximum of 3 attempts per file.

This improves reliability for users on unstable connections and
reduces manual intervention for transient failures.
```

### ✅ Good Breaking Change Commit
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

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

### ✅ Good Fix Commit
```
Fix: Prevent infinite loop in worker cleanup routine

The cleanup function was recursively calling itself without a
termination condition when workers failed to terminate gracefully.
Added a maxRetries limit of 3 attempts per cleanup session.

This resolves race conditions where multiple cleanup attempts
would orphan worker threads and eventually crash the application.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

### ❌ Bad Commits (Don't Do This)
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

# Subject too long
Feat: Add comprehensive batch retry mechanism with exponential backoff for failed downloads (ARC-3502)

# No breaking change footer when using !
Feat!: Change API structure

Changed the API structure completely.
```

## Pre-Commit Validation

Before committing, verify:
- [ ] All changes staged correctly
- [ ] Subject ≤ 50 characters
- [ ] Body wrapped at 72 characters
- [ ] Body explains WHY and IMPACT
- [ ] No bullet points in body
- [ ] JIRA ticket included (if branch has one)
- [ ] BREAKING CHANGE: footer present if exclamation mark used

## Important Notes

- **NEVER** use --no-verify or skip hooks UNLESS unit tests have already been run and passed in the current session (see Step 4)
- **ALWAYS** stage specific files (not git add -A unless necessary)
- **ALWAYS** use HEREDOC format for multi-line commit messages
- **ALWAYS** show the generated commit message in a code block before executing
- **ALWAYS** verify commit succeeded with git status after committing

## Handling Edge Cases

**No JIRA ticket in branch:**
- Omit ticket from subject line
- This is acceptable - ticket is optional

**Multiple unrelated changes:**
- Suggest splitting into multiple commits
- Ask user which changes to include in this commit

**No staged changes:**
- Ask user which files to stage
- Don't create empty commits

**Pre-commit hook fails:**
- Fix the issue
- Re-stage files
- Create a NEW commit (don't use --amend)
