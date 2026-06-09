# Forward Ticket Progression (Per-PR Tier) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate `In Progress → In Test` (Simplified) and `In Progress → Resolved` (Defect) at PR-merge time, via a single shared transition procedure that `investigate` also adopts.

**Architecture:** A canonical CLI-first "Advance Ticket → ⟨status⟩" procedure lives in the `jira` skill; `investigate` is retrofitted to call it; a new headless background skill detects Jason's merged ARC PRs and calls it. All files are Claude Code skills (markdown prompts) in the genome (`~/.claude-os/`).

**Tech Stack:** Claude Code skills (markdown), `jira` CLI (ankitpokhrel/jira-cli), `gh` CLI, `mcp__atlassian__*` (interactive fallback), `node` (digest-queue write helper), `config/scheduled-jobs.json` (cron registration).

---

## Adaptations from the standard writing-plans template (read first)

This plan implements **skills (prompt files)**, not compiled code. Two deviations are deliberate:

1. **No pytest.** "Test-first" is adapted to: state the concrete expected behavior + a runnable verification command, confirm current behavior differs, make the edit, re-run the verification, confirm. Verification runs against **live Jira/GitHub using a disposable test ticket/PR** (a precondition — see below), plus a **dry-run mode** for the background job.
2. **No autonomous commits.** Every "commit" is a **no-commit checkpoint**. The genome (`~/.claude-os/`) is git-tracked and shared with Walter; it is committed only via `/transmit-claude-os` with Jason's explicit permission (Task 5).

**Preconditions for verification:**
- A disposable ARC ticket in **To Do** (a Story/Task/Sub-Task) — call it `ARC-TEST-S`.
- A disposable ARC **Defect** in **Open/In Progress** — call it `ARC-TEST-D`.
- For Task 3 end-to-end: a throwaway PR on an ARC repo whose branch name carries one of those keys, which can be merged.
- `jira` CLI and `gh` CLI authenticated (`jira me`, `gh auth status` both succeed).

---

## File Structure

| Action | Path | Responsibility |
|---|---|---|
| Modify | `~/.claude-os/skills/jira/SKILL.md` | Add the canonical **Advance Ticket** procedure; add `Bash(jira *)` to `allowed-tools`; clarify CLI-for-transitions vs MCP stance |
| Modify | `~/.claude-os/skills/investigate/SKILL.md` | Replace Step 2's inline transition with a call to **Advance Ticket** |
| Create | `~/.claude-os/skills/background-merge-progression/SKILL.md` | Headless job: detect merged ARC PRs by Jason → Advance Ticket → In Test / Resolved |
| Modify | `~/.claude-os/config/scheduled-jobs.json` | Register the new job on cron |

**Shared contract — the status rank model** (used by Advance Ticket for idempotency / no-backward):

- Simplified: `To Do=0, In Progress=1, In Test=2, In Selloff=3, Done=4` (`Cancelled` = terminal, never auto-move).
- Defect: `Open=0, Reopened=0, Need More Information=0, In Progress=1, Resolved=2, Closed=3`.
- Rule: to advance to target rank `T`, skip if `current_rank >= T`; otherwise transition.

---

## Task 1: Add the canonical "Advance Ticket" procedure to the `jira` skill

**Files:**
- Modify: `~/.claude-os/skills/jira/SKILL.md` (frontmatter `allowed-tools` line 5; add a new `## Advance Ticket` section inside `<instructions>`, before `</instructions>` at line 114)

- [ ] **Step 1: State expected behavior + baseline check**

Expected: invoking the `jira` skill with "Advance Ticket ARC-TEST-S → In Progress" fetches the ticket, sees it's To Do (rank 0 < 1), runs `jira issue move`, leaves an audit comment, and reports `transitioned`. A second invocation reports `skipped: already at/past target`. Baseline: today the `jira` skill has no such procedure — confirm by reading the file and noting no "Advance Ticket" heading exists.

Run: `jira issue list -q"key = ARC-TEST-S" --plain --columns KEY,TYPE,STATUS,ASSIGNEE`
Expected: one row, STATUS = `To Do`.

- [ ] **Step 2: Add `Bash(jira *)` to `allowed-tools`**

In `~/.claude-os/skills/jira/SKILL.md` line 5, append ` Bash(jira *)` to the end of the `allowed-tools:` value. Rationale: the Advance Ticket procedure is CLI-first so it runs in headless contexts too.

- [ ] **Step 3: Soften the MCP-exclusive constraint for transitions**

In the `<task>` Hard constraints (line 23), change:

```
- Use `mcp__atlassian__` exclusively — both retired prefixes fail silently.
```

to:

```
- Use `mcp__atlassian__` for fetch/search/edit (both retired prefixes fail silently). Transitions
  and comments are CLI-first via the `jira` CLI (see Advance Ticket) so the procedure also runs
  headless; MCP `transitionJiraIssue`/`addCommentToJiraIssue` are the interactive fallback.
```

- [ ] **Step 4: Add the Advance Ticket procedure**

Insert this section immediately before `</instructions>` (line 114):

````markdown
## Advance Ticket → ⟨target status⟩

Canonical, reusable transition procedure. Consumers (e.g. `investigate`, `background-merge-progression`)
call it with a ticket key and a target status. CLI-first so it runs interactive **and** headless.

**Status rank** (for idempotency / no-backward):
- Simplified (User Story/Task/Sub-Task/Enhancement/Epic): `To Do=0 · In Progress=1 · In Test=2 · In Selloff=3 · Done=4` (`Cancelled` terminal — never auto-move).
- Defect/Sighting: `Open=0 · Reopened=0 · Need More Information=0 · In Progress=1 · Resolved=2 · Closed=3`.

**Procedure:**

1. **Fetch** type + status (+ assignee if the caller needs the guard):
   ```
   jira issue list -q"key = <KEY>" --plain --columns KEY,TYPE,STATUS,ASSIGNEE
   ```
2. **Map** TYPE to a workflow (Defect/Sighting → Defect; everything else → Simplified) and look up the
   current rank and the target rank from the tables above.
3. **Idempotency / no-backward:** if `current_rank >= target_rank`, **skip** — no transition, no comment.
   Return `skipped: already <STATUS> (>= <target>)`. If current status is `Cancelled`/`Closed`, skip
   and return `skipped: terminal`.
4. **Transition** (CLI validates the move is legal for the workflow; for Defects this enforces the
   state-specific machine for free):
   ```
   jira issue move "<KEY>" "<target status>"
   ```
5. **Audit comment** (work-tracking, not content) — use the caller-supplied line, else a default:
   ```
   jira issue comment add "<KEY>" "<audit line>"
   ```
6. **Fail-soft:** never abort the caller. On any non-zero exit (auth, illegal transition, network),
   return `failed: <reason>` and let the caller continue.

**MCP fallback** (interactive only, when the `jira` CLI is unavailable): fetch with
`getJiraIssue` (fields `["status","issuetype","assignee"]`), resolve the transition id — Simplified
from the table (`21`=In Progress, `81`=In Test, `91`=In Selloff, `31`=Done); Defect via
`getTransitionsForJiraIssue` (act only if the target is offered) — then `transitionJiraIssue` +
`addCommentToJiraIssue`.

**Returns** one of: `transitioned` · `skipped: <reason>` · `failed: <reason>`.
````

- [ ] **Step 5: Verify (live, happy path + idempotency + backward guard)**

Invoke the jira skill: "Advance Ticket ARC-TEST-S → In Progress".
Expected: reports `transitioned`. Confirm:
`jira issue list -q"key = ARC-TEST-S" --plain --columns KEY,STATUS` → STATUS `In Progress`, and a new audit comment exists (`jira issue view ARC-TEST-S --comments 1 --plain`).

Invoke again: "Advance Ticket ARC-TEST-S → In Progress".
Expected: reports `skipped: already In Progress (>= In Progress)`; no second comment added.

Invoke: "Advance Ticket ARC-TEST-S → To Do" (backward).
Expected: reports `skipped: already In Progress (>= To Do)`; status unchanged.

- [ ] **Step 6: Verify (Defect workflow legality)**

Invoke: "Advance Ticket ARC-TEST-D → Resolved" (from In Progress).
Expected: `transitioned`; STATUS `Resolved`. (If ARC-TEST-D is `Open`, expect the CLI to move it via the legal path or report `failed: <reason>` — confirm fail-soft returns cleanly either way.)

- [ ] **Step 7: Checkpoint (NO COMMIT)**

Re-read the modified section for correctness. Do **not** commit — genome commit is gated to Task 5.

---

## Task 2: Retrofit `investigate` Step 2 to call Advance Ticket

**Files:**
- Modify: `~/.claude-os/skills/investigate/SKILL.md` (Step 2 "Mark Work Started", currently ~lines 126–174)

- [ ] **Step 1: State expected behavior + baseline**

Expected: `/investigate ARC-TEST-S` still moves the ticket To Do → In Progress with an audit comment and the report annotation — but now by *calling Advance Ticket* rather than inlining `jira issue move`. Baseline: read Step 2 and confirm it currently inlines the transition logic (the `jira issue move "$ARGUMENTS" "In Progress"` block and MCP fallback).

- [ ] **Step 2: Replace the inline transition with an Advance Ticket call**

In Step 2, replace the body from "Otherwise transition the passed-in ticket…" through the end of the **Resilience** paragraph with:

````markdown
Apply the **Advance Ticket → In Progress** procedure (defined in the `jira` skill) to `$ARGUMENTS`,
with audit line `"Investigation started — moved to In Progress."`.

If `$ARGUMENTS` is a **Sub-Task** and its parent story is still To Do, apply **Advance Ticket → In
Progress** to the parent too (a subtask in progress means the story is in progress):
```
jira issue list -q"key = $ARGUMENTS" --plain --columns KEY,TYPE,PARENT   # read the parent key
```

Do **not** advance sibling subtasks. When `$ARGUMENTS` is a Story/Task with To Do subtasks, leave
them — Step 5's report flags them.

Record each Advance Ticket result (`transitioned` / `skipped: <reason>` / `failed: <reason>`) for the
report's JIRA Context section. Advance Ticket is fail-soft, so a Jira write failure never aborts the
investigation.
````

Keep the existing "Skip the transition and the comment when already In Progress…" lead-in paragraph (Advance Ticket also enforces it, but the in-skill note keeps Step 2 readable) and keep the report-annotation guidance in Step 5 unchanged.

- [ ] **Step 3: Verify (behavior parity)**

First reset the test ticket: `jira issue move ARC-TEST-S "To Do"` (manual, to re-test).
Run `/investigate ARC-TEST-S`.
Expected: ticket → In Progress, one audit comment "Investigation started — moved to In Progress.", and the report's Status line annotated `In Progress (moved from To Do at investigation start)`. Identical to pre-retrofit behavior, now routed through the shared procedure.

- [ ] **Step 4: Checkpoint (NO COMMIT)**

---

## Task 3: Create the `background-merge-progression` skill

**Files:**
- Create: `~/.claude-os/skills/background-merge-progression/SKILL.md`

- [ ] **Step 1: Capture the ARC repo list (no fabrication)**

Read `~/.claude-data/context/arc.md` → Repositories table. Capture each `owner/repo` slug into the list the skill iterates. (Used in Step 2's `gh` commands.)

- [ ] **Step 2: Write the skill file**

Create `~/.claude-os/skills/background-merge-progression/SKILL.md` with exactly this content (substitute the real `owner/repo` slugs from Step 1 into the `ARC_REPOS` list):

````markdown
---
name: background-merge-progression
description: >
  Background skill. Detects Jason's recently-merged ARC PRs and advances their Jira ticket to
  In Test (Simplified) or Resolved (Defect) via the jira skill's Advance Ticket procedure. Runs
  headlessly without a human in the loop. Never posts to Slack. Invoked by the background
  scheduler, not directly by the user. Pass `--dry-run` to report candidates without writing.
argument-hint: "[--dry-run]"
allowed-tools: Bash(gh *) Bash(jira *) Bash(node *) mcp__atlassian__getJiraIssue mcp__atlassian__transitionJiraIssue mcp__atlassian__addCommentToJiraIssue mcp__atlassian__getTransitionsForJiraIssue
---

<role>
You are a headless ticket-progression agent. You find PRs Jason has merged on ARC repos and move
the matching Jira ticket forward to reflect that the work is ready for test. You never prompt for
input, never post to Slack, and never touch a ticket that is not assigned to Jason. If anything
fails, you record it and continue to the next item.
</role>

<task>
For each ARC PR authored by Jason and merged within the lookback window, extract its ARC ticket key
and apply the jira skill's **Advance Ticket** procedure with the issue-type-appropriate target:
`In Test` for Simplified issues, `Resolved` for Defects. Guards: ARC-only, assignee = Jason,
forward-only (Advance Ticket is idempotent), audit comment, fail-soft. Jason's GitHub username is
`JasonFulksFamilySearch`.
</task>

## Mode

If the argument contains `--dry-run`, run every step EXCEPT the actual `jira issue move` /
`jira issue comment add` calls — instead report, per candidate, the transition that WOULD happen.
Otherwise (the scheduler default, no argument) run live.

## Health Check

```bash
gh auth status
jira me
```
If either exits non-zero, write an error digest entry and stop:
```js
const { appendDigestEntry } = require('/Users/fulksjas/.claude-os/hooks/digest-queue-write.js');
appendDigestEntry({ agent: 'merge-progression', status: 'error', error: 'auth check failed' });
```

## Step 1 — Find merged PRs by Jason

Lookback = 2 days (must exceed the cron cadence; overlap is safe because Advance Ticket is
idempotent). Compute the lookback date and, for each ARC repo, list merged PRs:

```bash
ARC_REPOS=( <owner/repo slugs from arc.md> )
SINCE=$(date -v-2d +%Y-%m-%d)
for repo in "${ARC_REPOS[@]}"; do
  gh pr list --repo "$repo" --state merged --author JasonFulksFamilySearch \
    --search "merged:>=$SINCE" --json number,title,headRefName,url,mergedAt
done
```

## Step 2 — Map each PR to an ARC ticket

For each PR, extract the first `ARC-<digits>` match from `headRefName` (fallback: `title`). PRs with
no ARC key are skipped. Collect `{ pr, repo, url, key }`.

## Step 3 — Guard + advance

For each `{ key }`:
1. Fetch: `jira issue list -q"key = <KEY>" --plain --columns KEY,TYPE,STATUS,ASSIGNEE`.
2. **Guard:** if ASSIGNEE is not Jason, skip (`skipped: not assigned to Jason`).
3. Target = `Resolved` if TYPE is `Defect`/`Sighting`, else `In Test`.
4. Apply **Advance Ticket → <target>** (jira skill) with audit line `"PR #<pr> merged — moved to <target>."`.
   In `--dry-run`, report the intended target instead of calling move/comment.
5. Record the result.

## Step 4 — Write one digest entry (visibility)

Regardless of count, write exactly one entry so the morning digest can surface what moved:
```js
const { appendDigestEntry } = require('/Users/fulksjas/.claude-os/hooks/digest-queue-write.js');
appendDigestEntry({ agent: 'merge-progression', status: 'ok', items: [ /* {key, pr, from, to, result} */ ] });
```
Use single-line `node -e`; if multi-line is needed, write `_tmp_merge_progression.js`, run it, delete it.

## Constraints
- Never post to Slack. Never prompt for input.
- Only advance tickets assigned to Jason. Forward-only (Advance Ticket enforces idempotency/no-backward).
- One digest write per run.
- Fail-soft per ticket: one failure never aborts the batch.
</output>
````

- [ ] **Step 3: Verify (dry-run — no writes)**

Ensure ARC-TEST-S is `In Progress` and there is a merged PR on an ARC repo whose branch carries `ARC-TEST-S` (create + merge a throwaway PR if needed).
Run: `/background-merge-progression --dry-run`
Expected: output lists the merged PR, maps it to ARC-TEST-S, and reports "WOULD move ARC-TEST-S → In Test". Confirm the ticket status is **unchanged** afterward (`jira issue list -q"key = ARC-TEST-S" --plain --columns KEY,STATUS` still `In Progress`).

- [ ] **Step 4: Verify (live, end-to-end)**

Run: `/background-merge-progression`
Expected: ARC-TEST-S → `In Test` with audit comment "PR #<n> merged — moved to In Test.", and a digest entry written.
Re-run immediately: expected `skipped: already In Test` (idempotent), no duplicate comment.

- [ ] **Step 5: Verify (Defect path)**

With a merged PR carrying `ARC-TEST-D` and ARC-TEST-D `In Progress` + assigned to Jason:
Run: `/background-merge-progression`
Expected: ARC-TEST-D → `Resolved`.

- [ ] **Step 6: Verify (assignee guard)**

Reassign ARC-TEST-S to someone else (or simulate), run live, expect `skipped: not assigned to Jason` and no transition.

- [ ] **Step 7: Checkpoint (NO COMMIT)**

---

## Task 4: Register the job on the scheduler

**Files:**
- Modify: `~/.claude-os/config/scheduled-jobs.json`

- [ ] **Step 1: Add the job entry**

Append to the `jobs` array (after "Sprint Staleness"):
```json
{
  "name": "Merge Progression",
  "skill": "background-merge-progression",
  "cron": "15 * * * 1-5"
}
```
Cadence: top of every hour +15 min, weekdays — merge → In Test should not wait a day. Tunable.

- [ ] **Step 2: Verify registration shape**

Confirm the JSON parses and the entry matches the existing schema (`name`, `skill`, `cron`):
Run: `node -e "console.log(JSON.parse(require('fs').readFileSync('/Users/fulksjas/.claude-os/config/scheduled-jobs.json','utf8')).jobs.map(j=>j.name).join(', '))"`
Expected: `PR Surveillance, Sprint Staleness, Merge Progression`. (Session-start injects the `CronCreate` for new jobs — no manual `/schedule`.)

- [ ] **Step 3: Checkpoint (NO COMMIT)**

---

## Task 5: Final verification + commit gate

- [ ] **Step 1: Full review of the genome diff**

Run: `cd ~/.claude-os && git status && git diff --stat`
Expected changed/added: `skills/jira/SKILL.md`, `skills/investigate/SKILL.md`, `skills/background-merge-progression/SKILL.md`, `config/scheduled-jobs.json`, plus the already-present `skills/investigate/SKILL.md` (earlier edit) and the two `docs/superpowers/` files.

- [ ] **Step 2: Confirm all verifications passed**

Re-read the verification results from Tasks 1–4. Every one must be green before proposing a commit.

- [ ] **Step 3: COMMIT GATE — ask Jason**

Do **not** commit autonomously. Present the diff summary and ask Jason for explicit permission to run `/transmit-claude-os` (which commits + pushes the genome, propagating to Walter). Only proceed on his explicit go-ahead.

- [ ] **Step 4: Clean up test artifacts**

Move ARC-TEST-S / ARC-TEST-D back to their original statuses and delete the throwaway PR/branch.

---

## Self-Review (completed by author)

- **Spec coverage:** Component 1 → Task 1; Component 2 → Task 2; Component 3 → Task 3 + Task 4 (registration). Genome/commit constraint → Task 5. Deferred items (release tier, parent roll-up) explicitly out of scope. ✓
- **Placeholders:** The only deferred-value is the `ARC_REPOS` slug list, which Task 3 Step 1 sources explicitly from `~/.claude-data/context/arc.md` (a documented lookup, not a vague TODO). ✓
- **Type/name consistency:** `Advance Ticket → ⟨status⟩` returns `transitioned`/`skipped: <reason>`/`failed: <reason>` — used consistently in Tasks 1, 2, 3. Status rank model defined once (File Structure) and referenced by the procedure. Digest agent name `merge-progression` consistent across health-check and Step 4. ✓
