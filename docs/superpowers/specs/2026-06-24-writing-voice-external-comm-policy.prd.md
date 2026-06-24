# PRD — External-Communication Skills Load the Writing-Voice Reference (Tiered Register)

**Tracker:** GitHub issue #99 (claude-os, no-JIRA `/make-it-so` adaptation)
**Track:** MEDIUM
**Date:** 2026-06-24
**Author:** Willis (with Jason)

---

## Problem Statement

`~/.claude-os/reference/writing-voice.md` is the single reference for Jason's
authoring voice (typography fingerprint, lexical tells, and a closed grammar/spelling
auto-fix table). Today only two surfaces load it: the `pr-to-slack` agent
(`agents/pr-to-slack/SKILL.md`) and `pr-response` (`skills/pr-response/SKILL.md`).

Every other claude-os skill that emits human-facing external communication composes
its prose without that reference, so outward text drifts toward generic phrasing and
loses the systematic grammar/spelling correction Jason relies on. The drift is
invisible: there is no hook for outgoing prose, so nothing flags a skill that posts to
Slack or a PR without the voice reference, and each new external-comm skill silently
repeats the omission.

Jason wants outward communication to carry his voice consistently — **including git
artifacts** (commit messages, PR descriptions, release notes) — but with two hard
boundaries:

1. Text posted to **Jira** or **GitHub issues** is exempt and unchanged.
2. **Commit messages must not become "word salad."** The voice fingerprint's rhythm
   and lexicon traits (winding sentences, conversational interjections,
   self-deprecating asides) are exactly what would turn a tight commit body into
   rambling, and must never enter the commit path.

## Solution

From the user's perspective: every skill that sends external communication produces
text in Jason's voice at the right intensity for the surface, the grammar/spelling
fixes reach even the most austere artifacts (commits), and a periodic audit catches
any skill — present or future — that emits outward prose without honoring the policy.

The mechanism is a **tiered register model** added to `writing-voice.md`, a
**one-line policy** in that file's header (so the rule propagates to Walter via the
shared genome), pointer edits in the skills that currently miss it, and an
**enforcement check** in `audit-claude-os` (the only realistic check, since no prose
hook exists).

**Three tiers, ordered by how much voice texture the surface tolerates:**

- **Tier 1 — Commit messages** (strictest). Import **only** the Grammar & Spelling
  auto-fix table; the voice fingerprint does **not** apply. The `/commit` format spec
  (conventional-commit tag, 50-char subject, 72-wrap WHAT/WHY/IMPACT body) governs
  structure and wins on every conflict. This is the no-word-salad guarantee: the
  rambling-vector traits are never imported, so there is no mechanism for salad.
  `ship`'s `gh pr create --fill` PR body inherits the commit text, so fixing `/commit`
  covers it with no separate edit.
- **Tier 2 — PR descriptions + release notes** (warmth dial). PR-post register,
  clarity-first, but voice is **permitted to show** — conversational confidence,
  self-aware brevity, the occasional dry aside. No emoji-prefixed headers, no
  corporate fluff. The artifact's own template/format spec wins on conflict.
- **Tier 3 — Slack + PR review prose** (existing registers). `pr-to-slack` and
  `pr-response` already comply. `post-review` and `ship` Step 6 adopt the PR-post
  (clarity-first) register; `arc-release`'s Slack announcement adopts the
  team-channel (warm) register.

Each tier is a new or clarified row in the existing `writing-voice.md` "Register by
surface" table and mirrors the precedence pattern already established there (the
`pr-to-slack` PR-post rules win over the fingerprint).

## User Stories

1. **As Jason, I want my commit messages spell- and grammar-corrected without
   absorbing my conversational voice, so that history stays tight and readable.**
   ```
   Given the /commit skill is composing a commit body
   When it drafts the WHAT/WHY/IMPACT prose
   Then it applies the Grammar & Spelling auto-fix table from writing-voice.md
   And it does NOT apply the voice fingerprint (no ellipses, ALL-CAPS, interjections,
       or self-deprecating asides)
   And the conventional-commit format spec governs the subject and structure
   ```

2. **As Jason, I want the voice fingerprint explicitly declared out of scope for
   commits, so that a future editor does not "helpfully" add it back.**
   ```
   Given a contributor reads skills/commit/SKILL.md
   When they reach the voice guidance
   Then they see an explicit note that the fingerprint is N/A to commit messages
   And that only the grammar/spelling table applies
   ```

3. **As Jason, I want PR descriptions to read like me, so that a PR is a human pitch
   for the change rather than a flat commit echo.**
   ```
   Given make-it-so is composing a PR body
   When it writes the description
   Then it loads writing-voice.md and applies the PR-descriptions register
   And voice is permitted to show (conversational confidence, self-aware brevity)
   And no emoji-headers or corporate warm-ups appear
   ```

4. **As Jason, I want release notes in the same warm-but-clear register as PR
   descriptions, so that release communication sounds like me within the template.**
   ```
   Given arc-release is composing release notes
   When it fills the release-notes template
   Then it applies the PR-descriptions/release-notes register from writing-voice.md
   And the release-notes template structure wins on any conflict
   ```

5. **As Jason, I want my posted PR reviews to carry my voice, so that review feedback
   reads consistently.**
   ```
   Given post-review is composing a review body and inline comments
   When it drafts the prose
   Then it loads writing-voice.md and applies the PR-post (clarity-first) register
   ```

6. **As Jason, I want ship's PR review replies and summary comment in my voice, so
   that the autonomous comment-addressing loop sounds like me.**
   ```
   Given ship Step 6 is posting replies and a summary comment
   When it composes that prose
   Then it applies the PR-post (clarity-first) register from writing-voice.md
   ```

7. **As Jason, I want the arc-release Slack announcement in my warm team-channel
   voice, so that release pings sound like a person, not a bot.**
   ```
   Given arc-release Phase 6 is posting a Slack announcement to #arc-team
   When it composes the message
   Then it loads writing-voice.md and applies the Slack team-channel register
   ```

8. **As Jason, I want Jira and GitHub-issue text left untouched, so that the exception
   holds and trackers keep their current phrasing.**
   ```
   Given a skill posts to Jira or a GitHub issue (including make-it-so's issue comments)
   When it composes that text
   Then it does NOT load the writing-voice register for that surface
   And its behavior is unchanged by this work
   ```

9. **As Jason, I want a durable policy statement that future external-comm skills
   inherit, so that the convention does not decay as skills are added.**
   ```
   Given a new external-comm skill is later authored
   When its author reads writing-voice.md
   Then the "How to use" header states the policy (external-comm skills load this;
       Jira/GitHub-issue text is exempt; git artifacts use the constrained tiers)
   ```

10. **As Jason, I want an audit check that flags any non-compliant skill, so that the
    policy is enforced periodically given no prose hook exists.**
    ```
    Given audit-claude-os runs
    When it inspects a skill that posts to Slack or a PR
    Then it verifies the skill references writing-voice.md with an appropriate register
    And it exempts skills whose only external text is Jira / GitHub-issue
    And it emits a WARN (with citation + concrete fix) for a non-compliant skill
    ```

11. **As Jason, I want the policy and its enforcement to live in the shared genome, so
    that Walter inherits both automatically.**
    ```
    Given the policy text and the audit check are authored
    When they are committed
    Then both live under ~/.claude-os/ (writing-voice.md + audit-claude-os)
    And no machine-local ~/.claude/rules/ file is required for the policy to hold
    ```

## Implementation Decisions

- **Two register rows added to the `writing-voice.md` "Register by surface" table.**
  One row for **commit messages** (grammar/spelling table only; fingerprint N/A;
  `/commit` format spec wins; no word salad). One row for **PR descriptions +
  release notes** (PR-post register, voice permitted to show; template/format spec
  wins). Both rows state their precedence explicitly, mirroring the existing
  pr-to-slack-rules-win pattern already in that table.

- **Policy statement added to the `writing-voice.md` "How to use" header.** A single
  governing line: external-communication skills load this reference; text posted to
  Jira or GitHub issues is exempt; git artifacts (commits, PR descriptions, release
  notes) use the constrained git-artifact tiers. **This header is the single
  source of truth for the policy** — it lives in the shared genome and propagates to
  Walter.

- **No new `.claude/rules/` file.** That tree is user-scoped (`~/.claude/`) and
  machine-local; a rule there would not reach Walter and would split the source of
  truth. The policy lives in `writing-voice.md` (genome) and is enforced by
  `audit-claude-os` (genome). Decision: header + audit, nothing under `~/.claude/`.

- **`/commit` (commit skill) gains a voice pointer.** Adds a pointer to the
  writing-voice **Grammar & Spelling table only**, plus an explicit note that the
  voice fingerprint is N/A to commit messages and that the existing format spec wins.
  Touches the voice/format region of the skill, not the format spec itself.

- **`make-it-so` PR-body step gains a register pointer.** At the PR-creation step, the
  PR body composition references the writing-voice PR-descriptions register.

- **`arc-release` gains two register pointers.** The Slack-announcement phase
  references the team-channel register; the release-notes composition references the
  PR-descriptions/release-notes register (template wins on conflict).

- **`post-review` gains a register pointer.** The review-body + inline-comment
  composition references the writing-voice PR-post register.

- **`ship` Step 6 gains a register pointer.** The reply + summary-comment composition
  references the writing-voice PR-post register. (Ship's Phase-5 Slack already
  delegates to `pr-to-slack`; Phase-3.5 PR body uses `--fill` and inherits the commit
  text — neither needs a separate edit.)

- **`audit-claude-os` gains one cross-cutting enforcement check.** Following the
  skill's existing check format (ID, PASS/WARN/BLOCK board vote, documentation/citation,
  concrete fix), a new Phase-5 check: a skill that posts to Slack or a PR must
  reference `writing-voice.md` with an appropriate register; skills whose only outward
  text targets Jira or GitHub issues are exempt; the confirmed false-positives and
  already-covered surfaces are recorded so the check does not re-flag them.

- **No code modules change.** All edits are to skill/reference markdown under
  `~/.claude-os/`. No `mcp/` code, so the offline eval gate does not apply.

## Testing Decisions

This is a prose/instruction change; "tests" are **verification assertions**, not unit
tests against code. A good test here verifies observable instruction content
(does the skill now reference the reference with the correct register?) and the
enforcement behavior (does the audit check flag a planted non-compliant skill and
exempt an issue-only one?) — never the wording of the prose itself.

- **Per-surface presence assertion (manual/grep).** For each of the six edited skills,
  confirm it now references `writing-voice.md` and names the correct register. Confirm
  the two exempt categories (Jira, GitHub-issue) and the five false-positives are
  *not* edited.
- **Audit-check behavior verification.** Confirm the new `audit-claude-os` check, when
  run, (a) flags a skill that posts to Slack/PR without the reference, (b) exempts a
  skill whose only external text is a Jira/GitHub-issue comment, and (c) does not
  re-flag the documented already-covered surfaces. Prior art: the existing S2 / H6
  "insider bias checkpoint" checks in `audit-claude-os` are the pattern to mirror.
- **No-contradiction check.** Confirm the two new register rows do not contradict the
  existing governing principle (`writing-voice.md` clarity-is-the-hard-constraint
  section) or the existing PR-post row.
- **Gate verification.** The three red-blue-judge gates (PRD, plan, diff) are the
  authoritative verification that the change faithfully implements this PRD.

**Definition of Ready:** stories meet INVEST; acceptance criteria in Gherkin;
no open product decisions (all resolved with Jason); shared genome / Walter
propagation understood.

**Definition of Done:** all edited skills reference the reference with the correct
register; commit tier imports grammar table only with fingerprint explicitly excluded;
policy line present in the header; audit check present and behaviorally verified;
exempt + false-positive + already-covered surfaces untouched; `/review-pr` clean;
Copilot requested + verified on the PR.

## Out of Scope

- **Jira surfaces** — comment/field/transition skills (`investigate`, `jira`,
  `estimate`, `generate-qa-subtask`, `arc-defect-verify`, background digests): exempt.
- **GitHub-issue surfaces** — including `make-it-so`'s *issue* comments (only its PR
  *body* is in scope) and `prd-to-jira` (Jira target): exempt.
- **Confirmed false positives (no change):** `mcp-health-audit`
  (`create_pull_request` is example data in a permission-audit table), `scan`
  (Confluence = a doc-link target), `standup` (git author email), `prompt-master-main`
  (a cold-email *example* in its template library), `review-pr` (read-only; posts
  nothing; hands off to `post-review`).
- **Already covered (no change):** `agents/pr-to-slack` (loads it directly),
  `skills/pr-to-slack` (delegates to the agent), `pr-response` (loads it directly),
  ship Phase-5 Slack (delegates to `pr-to-slack`), ship Phase-3.5 PR description
  (`--fill` inherits commit text; fixing `/commit` covers it).
- **No prose-enforcement hook.** No PreToolUse hook for outgoing prose exists or is
  built here; periodic `audit-claude-os` is accepted as the only realistic check.
- **No change to the voice content itself** — the fingerprint, grammar table, and
  governing principle are unchanged; only the register table and header gain rows/lines.

## Further Notes

- **Shared genome.** Every edited file is under `~/.claude-os/`, so all changes
  propagate to Walter. This is *why* the policy home is `writing-voice.md` and not a
  `~/.claude/rules/` file.
- **The word-salad resolution is the crux.** The non-obvious decision is that commits
  do not import the fingerprint at all — only the grammar/spelling table. Importing
  the full fingerprint is precisely the failure mode Jason named; the tiered model
  exists to prevent it structurally rather than by caution.
- **`spokenly` tool note.** `arc-release` declares `mcp__spokenly__ask_user_dictation`
  in its allowed-tools, but that connector is not attached in the current session;
  questions in this delivery were posed in text.
- **Delivery adaptation.** No-JIRA `/make-it-so`: gate verdicts post as comments on
  issue #99; no JIRA subtasks/worklog; commits via `/commit`; no prettier pre-flight
  (markdown, not `mcp/`); right-sized review (consistency/correctness/contradiction
  lenses — security/perf/CI N/A on a prose change).
