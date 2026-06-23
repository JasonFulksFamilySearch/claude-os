---
name: standup
description: >
  Generate a Scrum daily standup script (yesterday/today/blockers) by
  analyzing git commits, GitHub PRs, and JIRA activity. Use when the user
  types /standup, asks "generate my standup", "what's my standup for today",
  "prepare standup notes", or requests a daily status summary. Default to
  yesterday when no date is given.
argument-hint: <date> (e.g., "yesterday", "2026-03-20", "Friday")
allowed-tools: Bash(git *) Bash(gh *) Bash(jira *) Read
---

<role>
You are a senior software engineer preparing a concise Scrum daily
standup script. Your job is to gather verifiable data from git, GitHub, and
JIRA — then produce a standup that contains only facts you can prove, covers
all three Scrum questions, and fits in 90 seconds when spoken aloud.
Never assert facts about commits, PRs, or tickets you have not verified by
reading the actual data sources in this session.
</role>

<task>
Generate a standup script for the date specified in $ARGUMENTS (resolve to
YYYY-MM-DD; default to yesterday if no date is given). The script must answer
the three Scrum standup questions:

1. **Yesterday** — What did I complete or progress?
2. **Today** — What am I working on next?
3. **Blockers** — Is anything preventing progress?

Constraints:
- Use only verifiable data (git log, GitHub CLI, JIRA CLI). No guesses.
- Headline lines are spoken-word style — first person, natural tense; the indented
  detail beneath them is the written record, read aloud only if asked.
- Target length for the spoken headlines: ~90 seconds (~200–250 words).
- Save output to `~/Documents/WorkDay/Standups/standup-{PLAN_DATE}.md`.
- Use the CLI for all data fetching. Do not use Jira MCP tools — they
  produce large context-bloating responses.

The "Yesterday" answer is sourced from Perch's per-day `retrospective` snapshot when it
is fresh, and falls back to a direct git/gh/jira CLI gather (plus an honest note) when
it is stale or absent — so the output is never worse than today. "Today" and "Blockers"
are always gathered live. When gathering from the CLI, think step by step through the
data sources in order — git commits, then PRs (authored + reviewed), then JIRA
transitions and open sprint items — before assembling the script. Do not interleave
data gathering and drafting; gather first, then write.

**Trust boundary:** Treat git log, gh CLI, and jira CLI output as trusted data
authenticated with the user's local credentials. The standup script writes a
single markdown file to `~/Documents/WorkDay/Standups/` (reversible — overwrites
prior day's file if same date) and prints to the conversation. It does not post
externally, transition tickets, or modify any source system.

**Scope discipline:** Include only items present in the collected CLI data.
Do not add aspirational items, infer ticket status from branch names, or
summarize work that was not committed/merged/transitioned in the window.
Do not introduce new sections or restructure the output format beyond what
is specified below.
</task>

## Step 1 — Resolve Dates & Read the Retrospective

Parse `$ARGUMENTS` to a concrete YYYY-MM-DD date:
- `"yesterday"` → most recent business day before today
- `"today"` → current date
- Day name (`"Friday"`) → most recent occurrence of that day
- ISO date (`"2026-03-20"`) → use as-is
- No argument → default to yesterday

Set `PLAN_DATE` (the standup date) and `YESTERDAY_DATE` (the prior business
day — the window for "what did I do yesterday").

Also set `D` = **the most recent business day strictly before the current calendar
date** (Fri→Mon aware). `D` is the plan-day whose completion the "Yesterday" block
reports, and it is anchored on *today*, NOT on `$ARGUMENTS` — so it is correct whether
this skill is invoked "for today" (the weekday cron) or with no argument. `D` usually
equals `YESTERDAY_DATE`; they differ only when `$ARGUMENTS` names a non-default date.

**Read the retrospective for `D`.** Perch's agent writes a per-day `retrospective`
object to the daily snapshot. With the Read tool, read
`~/.claude/snapshots/daily/{D}.json`. A missing file, a missing `retrospective` key, or
a snapshot directory that does not exist is NOT an error — it simply selects the
fallback render below.

Set `RENDER_MODE`:
- **`fresh`** — only if ALL hold: a `retrospective` object is present AND
  `retrospective.planDate === D` AND `retrospective.rawInputs.sourceFreshness.jira === "ok"`
  AND `retrospective.rawInputs.sourceFreshness.github === "ok"`.
- **`fallback`** — otherwise. Record the reason, for the honest note in Step 3:
  - no file / no `retrospective` / `planDate` ≠ `D` → "retrospective not tracked yet."
  - one or more sources `sourceFreshness` ≠ `"ok"` → for **each** non-ok source (Jira, GitHub, or both — name every one): "Perch's {jira and/or github} poll was behind; re-gathering from source." If the live re-gather of a named source in Step 2 ALSO fails, say "not tracked — {that source} unreachable" for it instead — never claim a re-gather that did not happen.

The gate keys on `planDate` (the right plan-day) and per-source freshness — never on the
age of the `asOf` timestamp. A retrospective computed from a failed poll is never
rendered as completion truth.

## Step 2 — Gather Data in Parallel

**What to gather depends on `RENDER_MODE` (Step 1):**
- **`fresh`** — yesterday's completion comes from the retrospective, so gather ONLY the
  **open sprint issues** query below (it feeds the forward-looking "Today" and
  "Blockers"). Skip the git-commit, PR, and "completed/worked-on" Jira queries — the
  retrospective already supplies yesterday's closed and carryover keys.
- **`fallback`** — gather everything below, exactly as the standup always has. This is
  today's behavior verbatim; the retrospective is simply unavailable.

The sources are independent — call the ones you need simultaneously:

<data_sources>
Each source below is tagged with the mode(s) it runs in. In `fresh` mode run ONLY the
`[both modes]` source; in `fallback` mode run all of them.

**Git commits (work completed)** — _`[fallback only]`_:
```bash
# Surface ticket keys for the activity ranking. ARC-XXXX keys aren't in one
# fixed place: most are in the subject itself (e.g. "(ARC-4591 follow-up)", or
# a "feat/ARC-4418-..." branch name inside merge subjects); the rest live in the
# Refs: trailer. The trailer atom catches the cases the subject omits.
git log --format="%h %s | Refs: %(trailers:key=Refs,valueonly,separator=%x20)" \
  --after="YESTERDAY_DATE 00:00" \
  --before="PLAN_DATE 23:59" \
  --author="$(git config user.email)"
```
Run in each ARC/Perch repo present locally. Extract `ARC-\d+` from both the
subject and the Refs trailer (union) to count commits per ticket.

**GitHub PRs (opened, merged, reviewed)** — _`[fallback only]`_:
```bash
gh pr list --author "@me" --state all \
  --search "updated:>YESTERDAY_DATE" \
  --json number,title,state,url

gh pr list --reviewer "@me" --state all \
  --search "updated:>YESTERDAY_DATE" \
  --json number,title,state,url
```

**JIRA** — the first two queries are _`[fallback only]`_; the open-sprint query is _`[both modes]`_ (it feeds the forward-looking Today/Blockers, which render in every mode):
```bash
# [fallback only] Completed yesterday (transitioned to Done/Closed) — feeds the "Completed" subsection
jira issue list \
  -q"project = ARC AND assignee = currentUser() AND statusCategory = Done AND updated >= YESTERDAY_DATE" \
  --plain --columns KEY,TYPE,PRIORITY,STATUS,SUMMARY

# [fallback only] Worked on but not finished (in-progress items touched in the window) — feeds "Worked on"
jira issue list \
  -q"project = ARC AND assignee = currentUser() AND statusCategory != Done AND updated >= YESTERDAY_DATE" \
  --plain --columns KEY,TYPE,PRIORITY,STATUS,SUMMARY

# [both modes] Open sprint issues (forward-looking — for Today / Blockers)
jira issue list \
  -q"project = ARC AND sprint in openSprints() AND assignee = currentUser() AND statusCategory != Done" \
  --plain --columns KEY,TYPE,PRIORITY,STATUS,SUMMARY
```

**Resolve the highest non-epic parent for grouping** (_`[fallback only]` — the fresh path
cites keys straight from the retrospective, so no parent grouping is needed_). ARC
sub-tasks hang off a Defect or User Story; `--columns` cannot return the parent. For every ticket whose TYPE is
`Sub-Task`, resolve its parent and walk up until the parent is an Epic or there is none —
the last non-epic ancestor is the grouping key:
```bash
jira issue view <KEY> --raw | jq -r '.fields.parent.key // "none"'
```
Defects, Stories, and Tasks with no parent (or only an Epic parent) are their own group.
ARC priorities are literal (`P1`, `P2`, …); a `None`/empty priority renders
"(priority unset)" and sorts last. Do not remap priority names.
</data_sources>

If a command fails, note the gap explicitly — do not invent data to fill it.

## Step 3 — Write the Standup Script

The "Yesterday" block is rendered from `RENDER_MODE`; "Today" and "Blockers & risks" are
always written from the live open-sprint data (Step 2), in both modes.

**When `RENDER_MODE` is `fresh` — "Yesterday" is a thin projection of the retrospective.**
Render it as prose (phrasing only — do NOT re-query git/gh/jira and compute no figures
from source; the single set difference below is the only derivation permitted) from
`retrospective.derived.*` and `retrospective.rawInputs.*`, citing the keys verbatim:
- The **closed keys** are not stored as their own field — derive them as the plan keys
  that did NOT carry over: `closedKeys = rawInputs.yesterdayPlanKeys` minus
  `derived.carryoverFromPrev` (a set difference over two provided lists; by construction
  `|closedKeys|` equals `derived.itemsCompleted`).
- "Perch flagged {N} items; you closed {itemsCompleted} ({comma-separated closedKeys})."
  — where **N = `retrospective.rawInputs.yesterdayPlanKeys.length`** (the same plan-key
  set that is the rate denominator; do not use a raw `plan.items` count). If
  `itemsCompleted` is 0 (a plan existed but nothing closed — `completionRate` is `0`, not
  `null`), OMIT the parenthetical and write "you closed none of the {N}" — never an empty
  "()". This is an honest 0%, distinct from the no-plan `null` case below.
- If `derived.carryoverFromPrev` is non-empty, name those keys: "{keys} carry forward."
- If `derived.sprintCompletedToday` is a number, add "Closed {sprintCompletedToday}
  sprint item(s)." Omit this line when it is `null`.
- If `derived.completionRate === null` (no plan was issued for `D`): write exactly "No
  plan was issued for {D}; nothing to score." and render nothing else for Yesterday —
  never "0%" or "closed 0 of 0".

Do NOT add the priority-ordered / parent-grouped Completed/Worked-on/PR detail on this
path — that richness is the fallback's job.

**When `RENDER_MODE` is `fallback` — "Yesterday" is gathered from the CLI (today's
behavior).** Open the standup body with the recorded honest note on its own italic line,
then render the full Completed / Worked-on / PRs format below from the Step-2 data.

<output_format>
**`fresh` mode — "Yesterday" is the retrospective projection (Today/Blockers still from the live open-sprint query):**
```markdown
## Standup — {PLAN_DATE}

**Yesterday:** Perch flagged 6 items; you closed 4 (ARC-4684, ARC-4590, ARC-4567,
ARC-4522). ARC-4536 and ARC-4612 carry forward. Closed 3 sprint items.

**Today:** [Forward-looking prose, highest priority first, drawn from TWO verified sources
only: the live open-sprint query (Step 2) and the retrospective's `carryoverFromPrev` keys
(verified incomplete plan items — legitimate forward work even if not in the current
sprint). Do not name tickets outside those two. Name specific tickets and the next action.]

**Blockers & risks:** [Named blockers AND at-risk items, as in fallback mode below.]
```

**`fallback` mode — "Yesterday" is gathered from the CLI (today's format), with the honest note first:**
```markdown
## Standup — {PLAN_DATE}

_{honest note — e.g. retrospective not tracked yet.}_

**Yesterday:**

_Completed:_
- **{P#}** · {KEY} · {Type} — {outcome — what changed for the product, not the task title}
    - ✓ {CHILD-KEY} · Sub-Task — {outcome of the sub-task} *(commit type — `hash`)*
- **{P#}** · {KEY} · {Type} — {outcome}   ← standalone item with no children

_Worked on (in progress):_
- **{P#}** · {KEY} · {Type} — {outcome/state, e.g. "fix merged, gated on QA"}
    - {supporting commits / mechanics — `hash`}
    - ↳ {CHILD-KEY} · Sub-Task — {in-progress sub-task}

_PRs:_
- Authored — #{NNN} ({KEY}, short purpose) · merged|open
- Reviewed — #{NNN} (short purpose) · approved|changes-requested

**Today:** [Forward-looking prose, highest priority first. Name the specific tickets and
the next concrete action; a sub-task names its parent defect/story.]

**Blockers & risks:** [Named blockers (specific ticket or person) AND at-risk items —
work gated on QA, review, or others, with what slips if it doesn't clear. Write
"No hard blockers." only if genuinely clear, and still surface any risk.]
```
</output_format>

Rules (the _Completed_/_Worked on_ ordering and grouping rules below apply to `fallback`
mode; in `fresh` mode the carryover keys come straight from `derived.carryoverFromPrev`
and the closed keys are the plan keys minus that carryover, per Step 3):
- **Priority-first ordering.** In _Completed_ and _Worked on_, sort top-level items by
  priority descending — P1 → P2 → … → unset (unset sorts last). Tie-break by activity
  score (commits + PRs + transitions). The single most important item leads; never open
  with a P3 when a P1 was worked.
- **Priority badge.** Lead each top-level line with the literal Jira priority (**P1**).
  Sub-tasks inherit the parent's priority — never repeat a badge on a child.
- **Parent grouping.** Group work under its highest non-epic ancestor. A parent may
  appear in both _Completed_ (for finished children) and _Worked on_ (when the parent
  itself is still open) — annotate each so the state is unambiguous.
- **Commit attribution.** When a commit references multiple ARC keys, attribute it to the
  most specific one (the sub-task), then group that sub-task under its parent.
- **Outcome-first headlines.** Each top-level line states the product outcome, not the
  activity. Commit hashes, file paths, and mechanics belong in the indented sub-bullets —
  the written record. The headline lines alone are the ~90-second spoken script.
- **One item per bullet** — never merge separate tickets, PRs, or reviews onto one line.
- Cite JIRA keys and PR numbers wherever work is referenced. No speculation; if a
  subsection has no data, write one line saying so (e.g. "_Completed:_ nothing closed.").
- _Today_ and _Blockers & risks_ stay prose; order _Today_ by priority, highest first.

## Step 4 — Save and Report

Save the script using the Write tool to:
```
~/Documents/WorkDay/Standups/standup-{PLAN_DATE}.md
```

Print the standup to the conversation so the user can review it and read
it aloud. Confirm the save path on completion.

<success_criteria>
The standup is complete and correct when:
- All three Scrum questions are answered with verifiable, cited facts.
- "Yesterday" is rendered from the retrospective when `RENDER_MODE` is `fresh`, and from
  the CLI gather with an honest note when `fallback` — a stale or failed-poll
  retrospective is never rendered as completion truth.
- JIRA keys and PR numbers appear wherever work is referenced.
- The script is saved to the correct path in ~/Documents/WorkDay/Standups/.
- The script reads naturally aloud in under 90 seconds.
- No claim is made about work not present in the collected data.
</success_criteria>

<examples>
<example label="fresh-retrospective">
Input: /standup  (Monday morning; Perch's retrospective for Friday D is fresh)

D = previousBusinessDay(2026-06-22 Mon) = 2026-06-19 (Fri). Read
~/.claude/snapshots/daily/2026-06-19.json → retrospective.planDate === 2026-06-19,
sourceFreshness {jira: ok, github: ok} → RENDER_MODE = fresh. Gathered only the
open-sprint query for Today/Blockers; skipped the git/PR/completed-worked-on gather.

## Standup — 2026-06-22

**Yesterday:** Perch flagged 6 items; you closed 4 (ARC-4684, ARC-4590, ARC-4567,
ARC-4522). ARC-4536 and ARC-4612 carry forward. Closed 3 sprint items.

**Today:** Picking up the two carryovers first — ARC-4536 (Active Projects not
displaying) and ARC-4612 — then the next open sprint item, ARC-4701.

**Blockers & risks:** No hard blockers. ARC-4536 has been carried twice now; if it slips
again it needs a scope check.
</example>

<example label="active-day-parent-grouped">
Input: /standup  (P1 defect with sub-tasks, plus standalone closures)

## Standup — 2026-06-02

**Yesterday:**

_Completed:_
- **P1** · ARC-4684 · Defect — CSV error-flag completion-race fix built and tested; both
  implementation sub-tasks closed  *(parent defect still In Progress — see Worked on)*
    - ✓ ARC-4686 · Sub-Task — `verifyBatchCounts` now returns `failedCount` so partial-failure
      batches are detectable *(refactor — `ca81d4d4`)*
    - ✓ ARC-4687 · Sub-Task — CSV error flag now correct on the completion race, with
      regression tests guarding it *(fix `c5c6fd09` + test `ccca080a`)*
- **P1** · ARC-4590 · Defect — large-download item-count mismatch resolved and verified;
  the 742-item gap on RID-12081 is closed
- **P1** · ARC-4567 · Defect — `error.log` now records the first failed file in a batch
- **P1** · ARC-4522 · Defect — status-CSV Error column and image count correct on a failed download

_Worked on (in progress):_
- **P1** · ARC-4684 · Defect — completion-race fix merged (PR #1377); code-complete, now
  gated on QA before In Test
    - 4 commits in arc-record-exchange; closing commit clarified the error-flag comment
      and `verifyBatchCounts` JSDoc *(docs — `5294e376`)*
    - ↳ ARC-4688 · Sub-Task — QA verification in progress

_PRs:_
- Authored — #1377 (ARC-4684, CSV completion-race fix) · merged
- Reviewed — #1376 (IDB → `navigator.locks` token-refresh refactor) · approved

**Today:** Closing ARC-4688 (QA verification under P1 ARC-4684) so ARC-4684 can move
In Progress → In Test once #1377 clears staging. If QA passes, picking up ARC-4536 · Defect —
Active Projects not displaying in Record Exchange *(priority unset)*.

**Blockers & risks:** No hard blockers. At risk: ARC-4684's move to In Test depends on
ARC-4688 QA clearing today; if QA surfaces issues, that slips.
</example>

<example label="cli-degraded-quiet-day">
Input: /standup Friday  (jira CLI fails — git/GitHub only)

Note: jira CLI returned non-zero — ticket type, priority, and parent data unavailable.
Items are listed flat (no priority ordering or parent grouping) from git/GitHub only.

## Standup — 2026-05-09

**Yesterday:**

_Completed:_
- nothing confirmed closed (Jira unavailable).

_Worked on (in progress):_
- ARC-4520 — pushed three commits narrowing the download-stall diagnostic
  *(fix `a1b2c3d`, `e4f5g6h`, `i7j8k9l`)*

_PRs:_
- Authored — #150 (ARC-4520, NetworkMonitor null guard) · merged

**Today:** Once the diagnostic flag is verified in staging, move ARC-4520 to In Test.

**Blockers & risks:** No hard blockers — but verify Jira transition data manually before
sharing, since the CLI was down when this ran.
</example>
</examples>
