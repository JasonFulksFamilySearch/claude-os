# PRD — DIO-18 / FR-B5: compressed tool output → episodic capture (the build)

**Status:** Gates 1–3 CLEAN; build implemented, in review as PR #98. Project-owned source of truth for GitHub issue #58.
**Scope:** BUILD the FR-B5 capture path **default-OFF**. This PRD does **not** arm it — arming is #72; the fidelity harness is #59. Built ≠ armed.
**Date:** 2026-06-24
**Author:** Walter (AI), human-reviewed. Design rulings by system-architect; codebase facts verified file:line this session.

---

## Problem Statement

During a session, Claude runs many tools whose large outputs are compressed in-flight by the SmartCrusher (`compress()`, live and deterministic). That compressed *signal* — what mattered in a tool result, what was dropped, the error/anomaly rows that were preserved — is discarded at session end. It never reaches the episodic memory that the promotion pipeline learns from. So the system cannot later recall "this tool surfaced this error" or "this command's output was mostly noise except for these rows."

The producer half of the episodic-capture path already exists (DIO-14 flushes *acted-on graph findings* to a buffer), but **nothing captures compressed tool output, nothing consumes a tool-signal buffer into episodes, and there is no flag to gate such a write.** The feature is entirely unbuilt; only the design is settled.

This is the **highest-risk remaining Dioscuri unit**: it is the only *new lossy write into the eval-gated corpus*. The eval gate is structurally **content-blind** (it scores episode presence by `source_path`, never content), so a silently dropped signal row would still pass the eval. Therefore the feature must ship default-OFF behind a gated, reversible, fidelity-bounded arming sequence — and this PRD builds exactly that OFF state.

## Solution

Build the three missing pieces, all behind a single default-OFF flag:

1. **A tool-signal producer** — a fail-safe `main()` SIDE-EFFECT on the existing PostToolUse router (NOT a handler, and NOT part of the frozen `route()` contract) appends one compressed-signal line per tool result to a new, indexer-excluded `capture-buffer/<sessionId>.jsonl`. It stores the *compressed signal summary*, never the raw dump.
2. **A consumer in the Stop episode worker** — reads that buffer alongside the transcript and writes a `## Tool signals` section directly into the episode `.md` (not through the Haiku summarizer). The signals are surfaced in that body section only; the build deliberately does NOT add a `tool_findings` frontmatter field (deferred — see the ID-3 / US-4 scope decision below).
3. **A file-sentinel arming flag** — gates the whole path. Absent (the default) ⇒ the feature is off ⇒ episodes are byte-identical to pre-feature. Arming = creating the sentinel (a separate, human-gated act tracked in #72).

When OFF (shipped state), the system behaves exactly as today. The build is verified by tests and the Gate-3 diff judge; it is *armed* only later, after #59 quantifies fidelity and the operator runs the manual eval re-baseline.

---

## User Stories

### Producer — tool-signal capture

**US-1 — As the system, I want each compressed tool result appended as one signal line to a session-scoped buffer, so the session's tool signals survive to episode-capture time.**
```
Given the FR-B5 flag sentinel is PRESENT (armed)
  And a tool result was compressed by compress() during the session
When the PostToolUse router handler runs
Then one JSONL line is appended to ~/.claude-data/capture-buffer/<sessionId>.jsonl
  And the line carries { tool, retained-row summary, dropped_count, row-verdicts, ccr_hash }
  And it carries the compressed SIGNAL summary, never the raw tool output
```

**US-2 — As the system, I want the capture buffer to be indexer-excluded and promoted:false, so a tool-signal line can never become an observations row.**
```
Given a capture-buffer line was written
When the observations indexer runs classify() over ~/.claude-data
Then classify() returns null for any capture-buffer/ path (out of the four indexed subtrees)
  And SELECT COUNT(*) FROM observations WHERE source_path LIKE '%capture-buffer%' = 0
```

**US-3 — As the system, I want the buffer line to be a pure function of its inputs, so two machines / two runs produce byte-identical lines (AC-5c.1 determinism, BLOCKING).**
```
Given the same compressed tool result
When the producer builds its buffer line on two runs (and across two machines)
Then the two lines are byte-identical
  And no Date.now()/Math.random() participates in the line payload
```

### Consumer — episode `## Tool signals` section

**US-4 — As a future reader of episodic memory, I want a `## Tool signals` section in the episode, so the session's preserved tool signals are recallable.**
```
Given the FR-B5 flag is armed
  And the capture buffer for the session has ≥1 record
When the Stop episode worker builds the episode .md
Then it reads the buffer directly (NOT through summarize())
  And appends a "## Tool signals" section built from the buffer records
  And that section is the ONLY surface — no tool_findings frontmatter field is added
    (deferred until a consumer needs it; see the ID-3 Gate-3 scope-decision note)
```

**US-5 — As the system, I want the consumer to read transcript and buffer as one worker with two inputs, decoupled by the buffer file, so there is no producer/consumer race (FR-F3).**
```
Given the producer writes the buffer during the session
  And the Stop worker reads it at session close
When both run
Then they are decoupled by the buffer file (no shared in-memory state, no lock)
  And a missing/empty buffer yields an episode with no "## Tool signals" section (clean no-op)
```

**US-6 — As the system, I want AC-5b containment: every error/anomaly/boundary row preserved by compress() appears in the written episode, so the fidelity-critical rows are never silently dropped.**
```
Given a tool result whose compress() preserved error/anomaly/boundary rows
When the "## Tool signals" section is written
Then those preserved rows are a subset of (⊆) the section's content
```

### Flag — gating, reversibility, skippability

**US-7 — As the operator, I want the feature default-OFF via an absent file sentinel, so the shipped state changes nothing.**
```
Given the FR-B5 flag sentinel file does NOT exist (default)
When a session runs and the Stop worker builds an episode
Then no capture-buffer is written AND no "## Tool signals" section appears
  And the episode .md is BYTE-IDENTICAL to what the pre-feature code would produce
```

**US-8 — As the operator, I want arming to be a single reversible act (create the sentinel), and disarming to be deleting it, so reversibility is structural.**
```
Given the feature is armed (sentinel present)
When the operator deletes the sentinel
Then the next session produces a byte-identical episode to pre-feature
  And no residue remains (buffers auto-evict; nothing was promoted)
```

**US-9 — As the system, I want per-call skippability, so a specific tool result can opt out of capture even when armed.**
```
Given the flag is armed
  And a tool result is marked skip (or matches a skip predicate)
When the producer runs
Then no buffer line is written for that result
```

### Safety / no-new-surface

**US-10 — As the system, I want NO new write-back surface, so the episode .md remains the single promotion on-ramp.**
```
Given FR-B5 is built and armed
When any capture or episode write occurs
Then the buffer is never indexed (US-2)
  And the only thing that can enter promoted memory is the episode .md (unchanged on-ramp)
```

**INVEST note:** US-1..US-10 are independently testable; US-3 and US-6 are the blocking-fidelity stories; US-7/US-8 are the reversibility proof. Each fits a 1–3 day slice.

---

## Implementation Decisions

**ID-1 — Tool-signal data lives in a NEW buffer, separate from DIO-14's findings buffer.** (system-architect ruling 1, High confidence.) A new indexer-excluded `~/.claude-data/capture-buffer/<sessionId>.jsonl` carries the tool-signal record `{ tool, retained-row summary, dropped_count, row-verdicts, ccr_hash }`. Rationale: DIO-14's findings buffer has a different record shape (`{finding_id, summary, call_path, acted_on, promoted}`) for *acted-on graph findings*; mixing two signal types in one buffer would muddy its schema and complicate DIO-14's AC-4 proof. Keep the two producer surfaces clean and single-shape.

**ID-2 — The producer is a new handler appended to the EXISTING PostToolUse router, not a new hook.** The router already computes the compressed envelope FR-B5 needs; reuse it. No new hook registration beyond the router handler.

**ID-3 — The consumer is a direct-write extension of the Stop episode worker.** It reads the capture buffer and appends a `## Tool signals` section into the episode body — built directly from buffer records, **not** routed through `summarize()` (option a-i); when the buffer is empty the section is omitted (mirrors the existing conditional-section pattern for Decisions/Corrections/etc.).

> **Scope decision (recorded at Gate 3, 2026-06-24):** an earlier draft of ID-3 / US-4 named an *optional* `tool_findings` frontmatter field as a possible schema surface. The build **deliberately does not add it** — the signals are surfaced in the `## Tool signals` body section (the recallable, user-facing form the AC wanted), no consumer reads a `tool_findings` field, and an always-present frontmatter key would risk the flag-OFF byte-identical-to-pre-feature guarantee (AC-5c.2). The section subsumes the field; a structured frontmatter surface is deferred until a consumer needs it. Marked `yagni:` at the implementation site.

**ID-4 — The arming flag is a FILE SENTINEL under `~/.claude-data/flags/`, NOT the SQLite meta table.** (system-architect ruling 2, High confidence.) Dispositive fact: **no hook can open `better-sqlite3`** — there is no `hooks/package.json` / `hooks/node_modules`; the native dep is declared only in `mcp/`. The `c2_chunking_enabled` meta-table pattern fits the indexer because the indexer already holds the DB open; that justification is absent for a hook. Absent sentinel = off = byte-identical reversibility for free.

**ID-5 — Two flag mechanisms are accepted, with a documented routing rule.** (Operator decision, this session.) DB-open consumers (the indexer) use the meta table; hook consumers use file flags under `~/.claude-data/flags/`. This keeps the hook layer free of a native-module dependency. The rule must be documented where flags are described.

**ID-6 — Both containment boundaries are named (corrects a premise understatement).** The *buffer* is indexer-excluded by path (classify() → null). But the *episode body IS indexed* — which is exactly why the eval re-baseline obligation lands at **arming** (when `## Tool signals` content enters an indexed episode), not at build. AC-4 must therefore name two boundaries: (i) the buffer never indexed; (ii) the episode is the single, already-accounted-for promotion on-ramp.

**ID-7 — Determinism mirrors the proven pattern.** The producer line is a pure function of the compressed result (no `Date.now()`/`Math.random()` in the payload), matching `compress()` and `findings-buffer.toRecord`. This is AC-5c.1, BLOCKING.

**ID-8 — Arming writes the sentinel; it does NOT re-index.** Unlike `cutover.ts` (which flips the meta flag and triggers `fullReindex`), arming FR-B5 only creates the sentinel file. The eval re-baseline (`npm run eval -- --rebaseline` → verify non-regressing) is the operator's *manual* discipline at the flip, because adding a `## Tool signals` section to an EXISTING episode adds no new `source_path`, so `file_set_hash` doesn't move and no auto-guard fires.

---

## Testing Decisions

A good test asserts **external behavior**, not implementation detail: it feeds inputs and checks the buffer line / episode bytes / flag effect, never private function internals. Prior art: `hooks/lib/findings-buffer.js` tests (injectable `read`/`write`/`exists` deps, temp dirs), the `session-observer-worker.js` worker tests, and the byte-determinism assertion pattern proven for the graph (`graph.test.ts:350-375`, two builds → byte-identical).

**Modules tested:**
- **Producer (capture-buffer writer)** — record shape, `promoted`/exclusion invariants (US-2), determinism (US-3, byte-identical across two runs), skippability (US-9).
- **Consumer (episode `## Tool signals` writer)** — section built from buffer (US-4), AC-5b containment that preserved rows ⊆ section (US-6), the **byte-identical-when-off** reversibility test (US-7 — the load-bearing one), no-op on empty buffer (US-5).
- **Flag gate** — sentinel present/absent toggles the path; absent ⇒ pre-feature bytes (US-7/US-8).

**Module excluded from new tests:** `compress()` itself (DIO-7, already tested + determinism-certified this session) — FR-B5 consumes it, does not modify it.

**Definition of Ready:** all stories meet INVEST; Gherkin ACs written (above); the two architect rulings (ID-1, ID-4) resolved; #58 ACs mapped. **Definition of Done:** all ACs pass; `npm test` green (the graph/episode/hook layer is gated by `npm test`, NOT `npm run eval` — see Out of Scope); red-blue-judge (diff) CLEAN; the OFF-state byte-identical test passes; docs updated with the flag-routing rule (ID-5).

---

## Out of Scope

- **The arming flip itself (#72).** This PRD builds the OFF state. Creating the sentinel, the go/no-go decision, and the post-arming eval run are #72.
- **The DIO-19 fidelity A/B harness (#59).** The content-level disjoint A/B that quantifies the non-error drop rate BLOCKS arming but is a separate unit. This PRD only builds the path whose fidelity #59 will measure.
- **The eval re-baseline run.** `npm run eval -- --rebaseline` + `npm run cutover`-equivalent is operator discipline at arming (ID-8), not part of this build.
- **The eval gate as a code gate.** This change does NOT route through `npm run eval` — the graph/episode/hook layer is a separate subsystem from the retrieval index; it is gated by `npm test`. (The *feature's arming* requires the manual eval re-baseline because the episode body is indexed — ID-6 — but the *build* does not.)
- **Modifying `compress()` / SmartCrusher** (DIO-7, done).
- **Cross-input dedup machinery** between the findings buffer and the tool-signal buffer (explicitly DIO-18's *consumer* concern only if both feed one episode; not a producer concern).

---

## Further Notes

- **Why default-OFF is a perfectly acceptable terminal state:** per #72, if any arming precondition is unmet, "built, default-OFF, NOT armed" is correct and acceptable. This PRD delivers exactly that.
- **The fidelity blind spot is the whole reason for the ceremony:** the eval gate scores presence by `source_path`, never content (`eval.ts` recall@k), so it cannot catch a dropped signal row. Fidelity is caught ONLY by AC-5b containment (US-6) plus #59's content-level A/B. The PRD reflects this by making US-6 a blocking story and deferring quantified fidelity to #59.
- **Codebase facts verified this session (file:line):** producer DIO-14 record shape (`findings-buffer.js:60-72`); consumer section builder (`session-observer-worker.js:108-139`, summarize at :180); flag mechanism (`indexer.ts:13-20`, `db.ts` meta, `cutover.ts:79`); compressor (`smart-crusher.js:365`); "nothing reads it yet" (`hooks-install.js:40`). Architect-corrected facts: no hook opens better-sqlite3; episode bodies ARE indexed (`indexer.ts:101-102`).
- **Next gate:** run `red-blue-judge mode: prd` against this draft with the codebase + #58/DIO-18 ACs as ground truth before implementation begins.
