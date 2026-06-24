# Writing-Voice External-Comm Policy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every claude-os skill that emits human-facing external communication load `reference/writing-voice.md` at the right register, add a tiered register model + a durable policy line, and enforce it via an `audit-claude-os` check — with Jira/GitHub-issue text exempt.

**Architecture:** Pure prose/instruction edits to 7 markdown files under `~/.claude-os/`. The register model and policy line are added to `reference/writing-voice.md` FIRST (the single source of truth); each consuming skill then gains a one-line pointer to the correct register; the `audit-claude-os` enforcement check lands LAST so it can be sanity-checked against the now-compliant set. No code, no compiler, no unit-test framework.

**Tech Stack:** Markdown only. Verification is by `grep`/`Read` assertions, not a test runner. Commits via `/commit`. No prettier (not `mcp/`).

## Global Constraints

- Every edited file is under `~/.claude-os/` = **shared genome** (Willis + Walter); changes propagate to Walter. (Verbatim from PRD.)
- **Adapted TDD for prose:** each task is `verification-assertion (grep) → edit → confirm assertion → commit`. The "failing test" is a grep that returns nothing (or the old state) before the edit and the expected match after.
- **Lean plan:** tasks specify the *required semantic content* of each edit as checkable bullets; they do NOT lock exact final wording (that is the implementer's job at edit time, verified at Gate 3). This avoids a Gate-2 defect surface on wording.
- **Commit discipline:** stage only the named file(s) per task; commit via `/commit` (handles the no-JIRA branch gracefully — ticket is optional). One commit per task; never batch.
- **Eval gate N/A** (nothing under `mcp/`). `/review-pr` applies. Every PR requests Copilot + verifies attachment. No `Co-Authored-By` footer.
- **Precedence rule** every register row must state: the artifact's own format spec / the skill's own rules win over voice on conflict (mirrors the existing pr-to-slack pattern in the "Slack — PR-announcement posts" subsection of `reference/writing-voice.md`).

---

## File Structure

| File | Responsibility | Edit |
|---|---|---|
| `reference/writing-voice.md` | Single source of truth: register model + policy | 2 new register rows + 1 policy line in the "How to use" header |
| `skills/commit/SKILL.md` | Commit-message authoring | Pointer to Grammar & Spelling table ONLY; fingerprint N/A note |
| `skills/make-it-so/SKILL.md` | PR-body authoring (Step 6) | Pointer to PR-descriptions register |
| `skills/post-review/SKILL.md` | PR review body + inline comments | Pointer to PR-post register |
| `skills/ship/SKILL.md` | PR reply + summary comment (Step 6) | Pointer to PR-post register |
| `skills/arc-release/SKILL.md` | Slack announcement + release notes | 2 pointers (team-channel + PR-desc/release register) |
| `skills/audit-claude-os/SKILL.md` | Enforcement | 1 new cross-cutting check |

**Dependency order:** Task 1 (writing-voice.md) lands first — every later pointer references a register row it defines, so a pointer to a not-yet-existing register is a dangling reference. Task 7 (audit check) lands last — it is sanity-checked against the now-compliant set. Tasks 2–6 are mutually independent.

---

### Task 1: Register model + policy line in `reference/writing-voice.md`

**Files:**
- Modify: `reference/writing-voice.md` — the "Register by surface" section and the "How to use" header

**Interfaces:**
- Produces: two named register rows that Tasks 2–6 point at — refer to them by the names **"Commit messages"** register and **"PR descriptions & release notes"** register.
- Note for Tasks 4–5: they consume the EXISTING **"PR posts / technical answers to the team"** register (the intensity-table row — clarity dominates, voice light; `skills/pr-response/SKILL.md` already points at it by that name in its voice pointer). They reference it **by explicit name** and explicitly exclude the **"Slack — PR-announcement posts"** subsection (Slack-specific, owned by `pr-to-slack`). No new subsection is added for this — the explicit naming in Tasks 4/5 is the disambiguation, which keeps this change to the PRD's two new rows (closes Gate-2 P4 without scope creep).

- [ ] **Step 1: Verification assertion (pre-edit)**

Run: `grep -nE "Commit messages|PR descriptions" reference/writing-voice.md`
Expected: no match (the rows do not exist yet).

- [ ] **Step 2: Add the two register rows**

In the "Register by surface" section, add two new rows/subsections after the existing Email row, each more constrained than the existing "PR posts" row. Required content (checkable bullets):
- **Commit messages** register: import **only** the Grammar & Spelling auto-fix table; the voice fingerprint does **NOT** apply; the `/commit` format spec wins on every conflict; explicit "no word salad" intent (the Core Fingerprint rhythm/lexicon traits are the salad vector and are excluded). Note it also governs ship's `--fill` PR body (inherited from the commit).
- **PR descriptions & release notes** register: PR-post register, clarity-first, but **voice permitted to show** (conversational confidence, self-aware brevity, occasional dry aside); no emoji-prefixed headers / corporate fluff; the artifact's template/format spec wins on conflict.
- Each row states its precedence explicitly, mirroring the "Slack — PR-announcement posts" subsection.

- [ ] **Step 3: Add the policy line to the "How to use" header**

In the "How to use" header block, add one governing line: external-communication skills load this reference; text posted to **Jira or GitHub issues is exempt**; **git artifacts** (commits, PR descriptions, release notes) use the constrained git-artifact registers. State that this header is the single source of truth for the policy (shared genome → propagates to Walter).

- [ ] **Step 4: Confirm assertion (post-edit)**

Run: `grep -nE "Commit messages|PR descriptions|Jira or GitHub issues" reference/writing-voice.md`
Expected: matches for both new register rows AND the policy line.
Also Read the "Governing principle" section and confirm the new rows do NOT contradict "clarity is the hard constraint" (they are *more* constrained, which is consistent).

- [ ] **Step 5: Commit**

Stage `reference/writing-voice.md` only, then commit via `/commit` (expect a `Docs:` tag — register model + policy line).

---

### Task 2: `skills/commit/SKILL.md` — grammar-table-only pointer

**Files:**
- Modify: `skills/commit/SKILL.md` — near the `<format>` block

**Interfaces:**
- Consumes: the "Commit messages" register from Task 1.

- [ ] **Step 1: Verification assertion (pre-edit)**

Run: `grep -cn "writing-voice" skills/commit/SKILL.md`
Expected: `0`.

- [ ] **Step 2: Add the pointer**

Add a short pointer (near the format spec) stating: when composing the commit body, apply **only** the Grammar & Spelling auto-fix table from `~/.claude-os/reference/writing-voice.md` (Commit-messages register); the voice **fingerprint is N/A** to commit messages; the format spec here wins on any conflict. Do not import rhythm/lexicon traits (no word salad).

- [ ] **Step 3: Confirm assertion (post-edit)**

Run: `grep -n "writing-voice" skills/commit/SKILL.md`
Expected: one match with the grammar-table-only + fingerprint-N/A language.

- [ ] **Step 4: Commit**

Stage `skills/commit/SKILL.md` only; commit via `/commit`.

---

### Task 3: `skills/make-it-so/SKILL.md` — PR-body register pointer

**Files:**
- Modify: `skills/make-it-so/SKILL.md` — Step 6 PR-body composition (the "PR body must include:" step)

**Interfaces:**
- Consumes: the "PR descriptions & release notes" register from Task 1.

- [ ] **Step 1: Verification assertion (pre-edit)**

Run: `grep -cn "writing-voice" skills/make-it-so/SKILL.md`
Expected: `0`.

- [ ] **Step 2: Add the pointer**

At the PR-body step, add a pointer: compose the PR body in the writing-voice **PR-descriptions register** (clarity-first, voice permitted to show); the PR-body required sections / format win on conflict. (Issue comments this skill posts are exempt — do NOT add a pointer there.)

- [ ] **Step 3: Confirm assertion (post-edit)**

Run: `grep -n "writing-voice" skills/make-it-so/SKILL.md`
Expected: one match at the PR-body step; confirm it is at the PR-body step, not at an issue-comment step.

- [ ] **Step 4: Commit**

Stage `skills/make-it-so/SKILL.md` only; commit via `/commit`.

---

### Task 4: `skills/post-review/SKILL.md` — PR-post register pointer

**Files:**
- Modify: `skills/post-review/SKILL.md` — where the review body + inline comments are composed

**Interfaces:**
- Consumes: the existing "PR posts / technical answers to the team" register, referenced **by explicit name** (the "PR posts / technical answers to the team" intensity-table row of `reference/writing-voice.md` — NOT the "Slack — PR-announcement posts" subsection).

- [ ] **Step 1: Verification assertion (pre-edit)**

Run: `grep -cn "writing-voice" skills/post-review/SKILL.md`
Expected: `0`.

- [ ] **Step 2: Add the pointer**

Add a pointer: compose the review body and inline comments in the writing-voice **"PR posts / technical answers to the team" (clarity-first) register** — specifics, directness, no corporate warm-up, no hedging. Name that register explicitly so it is not confused with the Slack PR-announcement subsection.

- [ ] **Step 3: Confirm assertion (post-edit)**

Run: `grep -n "writing-voice" skills/post-review/SKILL.md`
Expected: one match referencing the PR-post register.

- [ ] **Step 4: Commit**

Stage `skills/post-review/SKILL.md` only; commit via `/commit`.

---

### Task 5: `skills/ship/SKILL.md` — Step 6 PR-post register pointer

**Files:**
- Modify: `skills/ship/SKILL.md` — Step 6 ("Post replies" — post a reply on each addressed inline comment, then a single summary comment)

**Interfaces:**
- Consumes: the existing "PR posts / technical answers to the team" register, referenced **by explicit name** (the "PR posts / technical answers to the team" register — NOT the "Slack — PR-announcement posts" subsection). (Do NOT touch Phase 5 Slack — it delegates to `/pr-to-slack` already; do NOT touch Phase 3.5 — `--fill` inherits the commit text from Task 2.)

- [ ] **Step 1: Verification assertion (pre-edit)**

Run: `grep -cn "writing-voice" skills/ship/SKILL.md`
Expected: `0`.

- [ ] **Step 2: Add the pointer**

At Step 6, add a pointer: compose the per-comment replies and the summary comment in the writing-voice **"PR posts / technical answers to the team" (clarity-first) register**. Name that register explicitly so it is not confused with the Slack PR-announcement subsection.

- [ ] **Step 3: Confirm assertion (post-edit)**

Run: `grep -n "writing-voice" skills/ship/SKILL.md`
Expected: one match at Step 6. Confirm Phase 3.5 and Phase 5 were NOT edited (the match is in the Step 6 region only).

- [ ] **Step 4: Commit**

Stage `skills/ship/SKILL.md` only; commit via `/commit`.

---

### Task 6: `skills/arc-release/SKILL.md` — two register pointers

**Files:**
- Modify: `skills/arc-release/SKILL.md` — the Slack-announcement phase (Phase 6) and the release-notes composition step
- Reference (read for context, no edit required): `skills/arc-release/references/release-notes-template.md` (absolute path — carried from Gate 1)

**Interfaces:**
- Consumes: the "PR descriptions & release notes" register and the team-channel register from `reference/writing-voice.md`.

- [ ] **Step 1: Verification assertion (pre-edit)**

Run: `grep -cn "writing-voice" skills/arc-release/SKILL.md`
Expected: `0`.

- [ ] **Step 2: Add the two pointers**

- Slack-announcement phase (Phase 6): compose the announcement in the writing-voice **Slack team-channel (warm) register**.
- Release-notes composition: compose in the **PR-descriptions / release-notes register**; the template at `skills/arc-release/references/release-notes-template.md` wins on conflict.

- [ ] **Step 3: Confirm assertion (post-edit)**

Run: `grep -n "writing-voice" skills/arc-release/SKILL.md`
Expected: two matches — one at the Slack phase (team-channel register), one at the release-notes step (PR-desc/release register).

- [ ] **Step 4: Commit**

Stage `skills/arc-release/SKILL.md` only; commit via `/commit`.

---

### Task 7: `skills/audit-claude-os/SKILL.md` — enforcement check (LANDS LAST)

**Files:**
- Modify: `skills/audit-claude-os/SKILL.md` — Phase 5 (Cross-Cutting Audit) region

**Interfaces:**
- Consumes: the now-compliant skill set from Tasks 1–6 (sanity-check the check against it).

- [ ] **Step 1: Verification assertion (pre-edit)**

Run: `grep -cn "writing-voice" skills/audit-claude-os/SKILL.md`
Expected: `0`.

- [ ] **Step 2: Add one cross-cutting check**

Add a check in the Phase 5 region, mirroring the existing `S2`/`H6` "insider bias checkpoint" format (an ID, a PASS/WARN/BLOCK board vote, a citation, a concrete fix). Required content:
- Rule: a skill that **posts to Slack or a PR** must reference `writing-voice.md` with an **appropriate register**; skills whose only external text targets **Jira or GitHub issues are exempt**.
- Record the **already-covered** surfaces so the check does not re-flag them: `agents/pr-to-slack`, `skills/pr-to-slack` (delegates), `pr-response`, ship Phase 5 Slack (delegates), ship Phase 3.5 (`--fill`).
- Record the **false positives** so the check does not flag them: `mcp-health-audit` (example data), `scan`, `standup`, `prompt-master-main`, `review-pr` (read-only).

- [ ] **Step 3a: Confirm the check text is present (post-edit grep)**

Run: `grep -n "writing-voice" skills/audit-claude-os/SKILL.md`
Expected: one match (the new check).

- [ ] **Step 3b: Falsifiable behavior verification (exercises the check against the real tree — satisfies the PRD's "when run")**

The check's job is to discriminate posters that MUST reference writing-voice from exempt ones. Verify that discrimination on the current tree with observable output, not mental reasoning. The PRIMARY check is **name-anchored on the documented set** (so it cannot silently miss an in-scope skill the way a verb-pattern can); a **broad sweep** then backstops for any poster nobody documented.

1. **Positive control — the in-scope set is compliant (name-anchored).** Run:
   `grep -L writing-voice skills/commit/SKILL.md skills/make-it-so/SKILL.md skills/post-review/SKILL.md skills/ship/SKILL.md skills/arc-release/SKILL.md`
   Expected: **no output**. `grep -L` lists files that DON'T match, so any file printed is a non-compliant in-scope skill → FAIL. This names `post-review` (and the others) explicitly, so an in-scope skill can never be missed regardless of which posting verb it uses.
2. **Exemption control — issue/Jira-only skills are exempt.** Confirm a Jira/GitHub-issue-only skill (e.g. `investigate`, `jira`, or `make-it-so`'s issue-comment path) appears on the check's exempt list and is NOT flagged as a violation.
3. **Backstop sweep — no undocumented poster (broad pattern).** Run:
   `grep -rEl "conversations_add_message|chat.postMessage|gh pr comment|gh pr review|gh pr create|gh api .*pulls.*review|gh api .*pulls.*comment|gh api .*pulls.*replies|gh api .*issues.*comment|pull_request_review|add_comment_to_pending_review|add_issue_comment|add_reply_to_pull_request|request_copilot_review|gh release create" skills/ agents/`
   For EACH file hit, assert it is in the **documented union** — in-scope edited (Tasks 2–6) OR exempt OR already-covered OR false-positive (the lists recorded in Step 2). Any hit **outside** that union → a poster the policy missed → FAIL; widen the edits or the lists before commit. (The pattern deliberately includes `gh api …pulls…review/comment/replies` so it catches `post-review`, `ship`, and `pr-response`'s real `gh api` mechanisms, not only the `gh pr`/MCP verbs.)
4. **(Optional full run)** Invoking `/audit-claude-os` surfaces the new check in its Phase-5 output as a contextual confirmation; the falsifiable pass/fail is steps 1–3.

- [ ] **Step 4: Commit**

Stage `skills/audit-claude-os/SKILL.md` only; commit via `/commit`.

---

## Self-Review

**1. Spec coverage:** PRD edits A (writing-voice rows + header) → Task 1; B (policy home) → Task 1 Step 3 + Task 7 (enforcement); C (audit check) → Task 7; D (skill edits: commit/make-it-so/arc-release/post-review/ship) → Tasks 2–6. ship Phase 3.5 covered-for-free → noted in Task 5 (no edit). All PRD surfaces mapped.

**2. Placeholder scan:** No "TBD"/"handle edge cases" — each task names the file, the target region, the required content bullets, and a concrete grep assertion. Prose wording is intentionally not locked (per the lean-plan constraint), but every edit's *required content* is enumerated and checkable.

**3. Consistency:** Register names are used consistently — Tasks 2 & 6(release) → "PR descriptions & release notes" + "Commit messages" (defined in Task 1 Step 2); Tasks 4 & 5 → the existing "PR posts / technical answers to the team" register, referenced by explicit name (that register, explicitly NOT the "Slack — PR-announcement posts" subsection — closes Gate-2 P4 with no new subsection); Task 6(Slack) → team-channel register. No dangling or ambiguous reference: every consuming task names its register explicitly; Task 1 creates the two new rows before Tasks 2/6 consume them.

**4. Exemption integrity:** Tasks 3 and 7 both explicitly guard the Jira/GitHub-issue exemption (Task 3: do not add a pointer at the issue-comment step; Task 7: exempt issue-only skills). The false-positive and already-covered lists are recorded in Task 7 so the audit check is self-consistent with the no-edit decisions.
