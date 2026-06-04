# PRD — B3: Identity-Drift Telemetry + Identity/Capability Write-Guard

*Authored 2026-06-04 · roadmap item B3 (A1→A2→B1→B2 shipped; B3 is the last original item) · gated by red-blue-judge before implementation*

## Problem Statement

Persona consistency is the core concern of the dual Willis/Walter design, yet today claude-os
cannot tell whether **Willis is still Willis** after hundreds of sessions — drift along the
disposition, pushback, recommendation, voice, and address-as-Sir dimensions is entirely
**unmeasurable**. Separately, the memory layer (learnings flush, episode worker, and especially the
`/memory-merger` and `/experience-synthesis` skills, which hold raw `Write`/`Edit`) is forbidden
from rewriting CLAUDE.md identity sections by **prose only** — nothing structurally prevents a
misfiring run from editing the identity file, so capability growth could silently erode identity.
Two gaps: no drift **tripwire**, and no identity **guardrail**.

## Solution

Two independent deliverables, both safe and validated (the third B3 idea — retrieval-grounded
identity / ID-RAG — was escalated and **dropped** in the Phase-4 ruling because it fragments the
always-on persona and risks dropping Willis mid-task; it is explicitly out of scope).

1. **`/identity-check` — a drift-telemetry skill.** It reads **recent raw session transcripts**
   (where Willis's verbatim behavior lives) and scores them against the **NCT five axes**
   (Narrative Continuity Test, arXiv 2510.24831), each axis operationalized against the matching
   CLAUDE.md identity text. It cites at least two distinct sessions per finding, writes a dated
   drift scorecard, and updates a rolling history table — making persona drift measurable for the
   first time. It is **advisory**: it surfaces drift for Jason and never edits identity.

2. **The identity/capability write-guard.** Activate and harden the dormant "Rule 10" in the
   existing PreToolUse hook so that Claude's `Edit`/`Write` to `~/.claude/CLAUDE.md` is
   **hard-blocked**, turning the memory layer's prose "never graduate to CLAUDE.md" into
   enforcement. The hook fires only on Claude's tools, so Jason still edits the identity file
   directly — identity stays human-owned ("freeze identity, evolve capability").

**Why transcripts, not episodes (verified):** episodes are Haiku digests that extract only
Decisions/Corrections/Discoveries, paraphrased, with the transcript treated as untrusted — they
carry **no** tone, "Sir," pushback phrasing, or recommendation framing. The two axes that most
define "is Willis still Willis" (Stylistic Stability, Persona/Role Continuity) are invisible in
episodes by design. The verbatim signal lives in the raw session transcripts at
`~/.claude/projects/*/*.jsonl`. The existing reader of those raw transcripts is the episode worker
(`session-observer-worker.js`'s `parseTurns`); `/review-performance`, by contrast, reads Auto Memory
digests and the hook log, not raw transcripts. So `/identity-check` reads the transcripts directly,
reusing the `parseTurns` parsing approach.

## User Stories

1. As Jason, I want Willis's persona scored against fixed axes across recent sessions, so that
   drift becomes measurable instead of a vague worry.
2. As Jason, I want the five axes to be the NCT axes grounded in Willis's own CLAUDE.md, so that
   the score measures drift from *Willis's documented identity*, not a generic benchmark.
3. As Jason, I want each drift finding backed by at least two cited sessions, so that a low score
   is evidence, not an unsupported assertion.
4. As Jason, I want `/identity-check` to read the raw transcripts, so that the persona axes (tone,
   address, pushback, recommendation framing) are actually observable.
5. As Jason, I want a dated drift scorecard per run, so that I can read what drifted and why.
6. As Jason, I want a rolling per-axis history with baseline + targets, so that I can see the
   trend over time, not just a snapshot.
7. As Jason, I want `/identity-check` to be advisory and never edit identity, so that the tool that
   measures drift can never itself cause it.
8. As Jason, I want the memory layer structurally unable to rewrite CLAUDE.md, so that no skill or
   hook can erode identity even if its prose guardrail is ignored.
9. As Jason, I want to keep editing CLAUDE.md myself, so that the guard freezes the memory layer
   out without freezing me out.
10. As Jason, I want the guard to leave `~/.claude/rules/*.md` editable, so that capability/operating
    rules keep evolving (e.g. via `/review-performance`) while identity is frozen.
11. As Jason, I want the guard's block to be unmistakable (a clear message), so that when it fires
    the reason is obvious in-session.
12. As Willis, I want `/identity-check` to reuse the `/grade-proposal` rubric shape and
    `/review-performance` evidence discipline, so that it fits the established skill patterns.
13. As Willis, I want the drift history kept machine-local, so that Willis's lived-experience drift
    log stays Willis's and never collides with Walter's.
14. As a future maintainer, I want the guard built by activating the existing Rule 10 stub rather
    than a new hook, so that the change refines the existing structure.
15. As Jason, I want the ID-RAG / retrieval-grounded-identity idea explicitly excluded, so that the
    always-on persona is never fragmented.

## Implementation Decisions

### `/identity-check` skill
- **Read source: recent raw session transcripts** (`~/.claude/projects/*/*.jsonl`), windowed to a
  bounded number of recent sessions / recent assistant turns for cost. NOT episodes (they strip
  persona). It parses the raw transcripts the way the episode worker's `parseTurns` already does
  (the existing raw-`.jsonl` reader); `/review-performance`, by contrast, reads Auto Memory digests
  and the hook log, not raw transcripts.
- **Axes: the five NCT axes** — Situated Memory, Goal Persistence, Autonomous Self-Correction,
  Stylistic & Semantic Stability, Persona/Role Continuity — each operationalized against the
  matching CLAUDE.md identity text (e.g. Persona/Role ↔ Disposition/Pushback/Recommendation/Address;
  Stylistic ↔ steady/structured voice + "Sir"; Self-Correction ↔ the calibration / "let go
  gracefully" stance; Situated Memory ↔ coherent use of the memory layer; Goal Persistence ↔
  holding Jason's goal-thread).
- **Rubric:** a fixed, weighted rubric in a companion `references/identity-rubric.yaml`, scored
  0–100 per axis plus an overall score with banded interpretations — the `/grade-proposal` +
  `proposal-rubric.yaml` shape. The YAML is the source of truth for weights/bands.
- **Evidence discipline:** every per-axis finding cites at least two distinct sessions exhibiting
  (or failing) the behavior; never fabricate sessions/quotes (the `/review-performance` rule and the
  CLAUDE.md "No fabrication" rule).
- **Output (two artifacts):** (a) a dated per-run drift scorecard written to
  `~/.claude/reflection-reports/` (the established report home); (b) a rolling history table in a
  **new machine-local `~/.claude-data/context/identity.md`**, in the Baseline / Targets /
  Latest-Check (dated, windowed, status column) shape used by `~/.claude-data/context/goals.md`.
- **Advisory only:** the skill never edits CLAUDE.md and never proposes an identity rewrite; it
  reports drift and leaves remediation to Jason. `allowed-tools` are read + report-write only
  (Read, Glob, Grep, Write, and date/ls Bash) — no Edit of identity, no Agent dispatch needed.
- **Invocation:** manual (`/identity-check`); a scheduled cadence is out of scope (could ride A3's
  `/schedule` later).

### Identity write-guard
- **Activate and harden the dormant Rule 10** in the existing PreToolUse hook (`rule-enforcement.sh`)
  rather than authoring a new hook. It blocks `Edit`/`Write` whose target resolves to
  `~/.claude/CLAUDE.md`, using the established block mechanism (write the reason to stderr,
  `exit 2`).
- **Whole-file** protection (not section-scoped): identity sections are non-contiguous and
  section-range math in bash is error-prone; whole-file is simple, robust, and safe. Section-scoping
  is a deferred v2.
- **Harden the path match:** canonicalize the tool's `file_path` (resolve `~`/`$HOME`, relative
  paths, and symlinks to an absolute real path) before comparing, so the guard can't be evaded by a
  non-literal path. The current stub's exact-string match is insufficient. **Concretely:**
  `~/.claude/CLAUDE.md` is itself a symlink to `~/.claude-data/agent/CLAUDE.md`, so the guard's
  canonical target is that **resolved real path** — it must block any edit whose resolved
  `file_path` equals `~/.claude-data/agent/CLAUDE.md`, whether reached via the `~/.claude/` symlink
  or the data-dir real path. (Canonicalize both operands, not just the incoming path.)
- **Scope boundaries:** the guard protects only `~/.claude/CLAUDE.md`. It does **not** protect
  `~/.claude/rules/*.md` (capability — must stay editable) nor `~/.claude-os/` (already covered by
  the standing "confirm before modifying ~/.claude-os" rule).
- **Fail mode:** retain the hook's existing behavior (it fails open on an stdin-read timeout);
  changing the global hook fail-mode is out of scope. Fail-closed for the identity path is a noted
  v2 hardening.

### Propagation (genome vs machine-local)
- The **`/identity-check` skill + its rubric are genome** (`~/.claude-os/skills/identity-check/`) —
  they propagate to Walter via `/transmit`.
- The **Rule 10 activation is machine-local** (`~/.claude/hooks/rule-enforcement.sh`) — Willis-only;
  Walter activates his own. (Same split as B2's `workflow.md` directive.)
- **`~/.claude-data/context/identity.md` is machine-local** — Willis's drift history.

## Testing Decisions

A good test asserts external behavior, not implementation detail.

- **The write-guard is unit-tested** — it is the one deterministic, security-relevant piece. A
  standalone shell test pipes crafted tool-call JSON into `rule-enforcement.sh` and asserts exit
  codes: `Edit`/`Write` to `~/.claude/CLAUDE.md` → **exit 2 (blocked)**; an `Edit` to
  `~/.claude/rules/workflow.md` and to an arbitrary file → **exit 0 (allowed)**; non-literal path
  variants (relative, `~`, a symlink) that resolve to CLAUDE.md → **still blocked**. (A shell test,
  since the hook is machine-local and outside the mcp vitest suite; reuse any existing hook-test
  harness if present, else a minimal script.)
- **`/identity-check` skill + rubric are NOT unit-tested** — the NCT scoring is irreducible LLM
  judgment. They are validated by `/skill-auditor` (against the SKILL.md structure/prompt rubric)
  plus a **live smoke test** (run `/identity-check` on real recent sessions and confirm a structured
  scorecard with per-axis scores and ≥2 cited sessions). Mirrors how B2 was verified.
- **Prior art:** `grade-proposal/references/proposal-rubric.yaml` (rubric shape + isolated grader);
  `review-performance/SKILL.md` (evidence-first, dated report, cite-≥2-sessions); the existing
  `rule-enforcement.sh` (hook block mechanism + `hooks-log.jsonl` logging).

## Out of Scope

- **Retrieval-grounded identity (ID-RAG).** Phase-4 ESCALATE/drop — fragments the always-on persona,
  risks intermittent identity loss, contradicts Anthropic's persona-coherence evidence.
- **Scoring drift from episodes.** Episodes provably strip persona; transcripts are the source.
- **Section-scoped guard.** Whole-file in v1; section-level discrimination deferred.
- **Fail-closed hook mode.** Retains the existing fail-open-on-timeout behavior; deferred.
- **Auto-remediation of drift.** `/identity-check` is advisory; it never edits identity or
  auto-tunes CLAUDE.md. Remediation is Jason's manual call.
- **Extending the episode digest to emit persona signal.** A future telemetry source requiring a
  separate genome change to `session-observer-worker.js`; not built here.
- **Scheduled `/identity-check`.** Manual invocation only in v1.
- **Guarding `~/.claude-os/` genome identity.** Covered by the standing "confirm before modifying
  ~/.claude-os" rule.

## Further Notes

- The guard fires only on Claude's `Edit`/`Write` tools — Jason's direct edits to CLAUDE.md (in his
  own editor, outside Claude) are unaffected. That is the intent: identity is human-owned.
- Interaction with `/review-performance`: it may propose CLAUDE.md edits into
  `reflection-reports/`; with the guard active those cannot be auto-applied via Claude's tools, so
  Jason applies any CLAUDE.md change manually. Acceptable — identity edits should be human.
- The dormant Rule 10 stub already targets exactly `~/.claude/CLAUDE.md`, so B3's guard is an
  activation + path-hardening of existing structure, not a new mechanism.
- NCT is a conceptual framework (single source, Oct 2025, flagged in the briefing). We adopt its
  five-axis **structure**, operationalized against Willis's own CLAUDE.md — not a generic benchmark.
