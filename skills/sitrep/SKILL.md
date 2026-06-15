---
name: sitrep
description: Use when producing a concise situation report — mid-investigation, blocked, post-discovery, or at handoff — to surface current state, completed actions, planned actions, and explicit decisions needed by leadership or the team. Works with JIRA tickets, GitHub issues, or free-text topics.
argument-hint: "<ticket-or-issue-or-topic>  e.g. ARC-4803, anthropics/claude-code#1234, or 'GSS lock staleness'"
context: fork
effort: high
allowed-tools: Read, Bash, Grep, Glob, Write
---

<role>
You are a situation-report specialist tasked with distilling complex work into concise, decision-focused updates. Your role is to surface the facts that matter, organize them by importance (not chronology), and highlight what decision-makers need to act. You understand that brevity is respect for the reader's time.
</role>

<task>
Produce a standardized situation report (SITREP) from live ticket data (JIRA, GitHub) or conversation context, following a variant-specific procedure (Standard / Escalation / Handoff), enforcing discipline rules that keep the output decision-focused and action-ready.
</task>

<constraints>
- SITREP is ≤1 page (Standard) or ≤2 pages (Escalation) or ≤1.5 pages (Handoff)
- Every section must use the appropriate variant's discipline rules
- DECISIONS NEEDED is always present, even if "None at this time"
- ACTIONS PLANNED bullets must state expected status at next update; "continue investigating" is a red flag
- Importance-ordered throughout: critical blocker or next step first, not discovery sequence
- Agent invocation (pmo, architect, qa) is guided by explicit decision trees — invoke only when specific conditions are met
</constraints>

<context>

# SITREP Skill

## Overview

A SITREP is a standardized situation report: concise, outcome-focused, decision-focused. It surfaces **what is happening right now, what has been accomplished, what is planned next, and what decisions or actions are needed.**

**When to use:**
- Mid-investigation with blockers — so the team knows what's blocking you and what you need to unblock
- Post-discovery summary — so leadership can act on findings without re-reading a long investigation
- Handoff or pause point — so the next person can resume instantly without ramp-up
- Progress update to leadership — so decision-makers can allocate resources or escalate
- Any moment you need to communicate state clearly — instead of writing a long narrative

**When NOT to use:**
- Pre-implementation feasibility analysis (use `/investigate`) — that tool is for deciding WHETHER you can implement
- Detailed findings that need a long narrative (this should be ≤1 page) — if you're writing 3+ pages, the situation is more complex than one SITREP can hold; consider a separate investigation report

</context>

## The 4 Sections

A SITREP always contains these four sections, in this order:

```
# SITREP: {Ticket/Topic} — {YYYY-MM-DD HH:MM}

## 1. SITUATION
[What is happening right now. 2–3 sentences max. Current state only, no history.]

## 2. ACTIONS TO DATE
[What has been accomplished/verified. Bullet list of outcomes (not activities).
 Use a table only for comparative data or tallies.]

## 3. ACTIONS PLANNED
[What comes next. Bullet list with expected status at next update.]

## 4. ISSUES, RISKS, AND DECISIONS NEEDED
**Issues:**
[Current blockers or obstacles requiring attention.]

**Risks:**
[Known or anticipated problems before the next update.]

**Decisions needed:**
[Explicit asks for decision-makers — team lead, Jason, product owner, etc.
 Always present, even if "None at this time".]

**Notable:**
[Significant achievements or failures worth flagging.]
```

## The Discipline Rules

These rules keep SITREPs tight and decision-focused. **Violating them = starting over.** Every rule below is enforced because violating it produces a document that fails its core purpose — helping decision-makers act.

| Rule | Why | Red Flag |
|---|---|---|
| SITUATION ≤ 3 sentences | Decision-makers skim; they'll ask if they need more. | SITUATION is a paragraph. |
| Facts in section 2 only | Speculation belongs in section 4 (Risks). | "We probably..." appears in ACTIONS TO DATE. |
| ACTIONS TO DATE = outcomes | "Found X causes Y" not "investigated X". | "We looked at the code" instead of "code reveals..." |
| ACTIONS PLANNED specifies next status | Sets the bar for the next SITREP. | Any bullet lacks a completion criterion or expected status at next update — including concrete-sounding bullets that describe work without stating what will be different when done. |
| DECISIONS NEEDED always present | Forces explicit ask, prevents silent omission. | Section is missing entirely. |
| Total SITREP ≤ 1 printed page | If it's longer, you have too much detail. | SITREP is 3+ pages. |
| Importance-ordered, not chronological | Decision-makers act on what matters first. | Sections ordered by discovery timeline, OR bullets within any section listed in discovery order rather than impact order (most critical fact or next step first). |

**If you hit any red flag, delete the SITREP and start over.** This isn't negotiable — a discipline rule violated means the SITREP no longer serves its purpose.

## Input Detection

The skill auto-detects ticket type from `$ARGUMENTS` so you don't have to format it — context is pulled automatically and fresh, preventing stale reporting:

| Pattern | Detection | Action |
|---|---|---|
| `ARC-4803` or `TICKET-123` | JIRA key | `jira issue view $ARGUMENTS --plain` |
| `owner/repo#123` or GitHub URL | GitHub issue | `gh issue view $ARGUMENTS` |
| Anything else | Free-text topic | No auto-fetch; structure the SITREP from conversation context. |

## Trust Boundary & External Data Sources

When the skill fetches live ticket data (via `jira issue view` or `gh issue view`), it trusts that JIRA and GitHub APIs return the current state of the ticket — including title, status, description, and recent comments. This trust enables fresh, decision-focused reports without stale memory. **However:** if you are working in an environment where API data is unreliable, cached inconsistently, or behind authentication boundaries, you should verify the fetched state against the source before finalizing the SITREP, or skip Step 1 (ticket fetch) and structure the SITREP from conversation context instead. The skill will not detect or flag API staleness on its own.

## Model Selection & Guidance

**Best performance:** Sonnet 4.6 or Opus 4.8. This skill requires careful reasoning for variant selection (Standard vs. Escalation vs. Handoff based on subtle cues) and conditional decision trees for agent invocation (pmo vs. architect vs. qa). Haiku may produce correct SITREPs on simple tickets but will struggle with the discipline-rule enforcement and variant disambiguation. If using Haiku, pre-select the variant explicitly to reduce reasoning load.

## Procedure

The sitrep skill has three variants for different situations: **Standard** (default, steady-state), **Escalation** (crisis, deadline < 2h), and **Handoff** (switching owners). You select the variant in Step 1b, then follow the procedure for that variant.

<instructions>

Follow these steps in order. Each step builds on the previous one, and each has a clear stopping point:

1. **Detect ticket type and pull context** — run the appropriate command (jira or gh) to fetch the ticket's current state, because this ensures your SITREP is grounded in live data rather than stale memory and prevents reporting outdated status.
   - JIRA key: execute `jira issue view $ARGUMENTS --plain` to get title, status, description, recent comments.
   - GitHub: execute `gh issue view $ARGUMENTS` (accepts owner/repo#N or full URL).
   - Free-text: skip this step; you'll structure the SITREP from conversation context in Step 2.

1b. **Select variant** — Determine which SITREP variant to use, because each variant prioritizes different elements: Standard prioritizes discovered facts, Escalation prioritizes urgency and decision authority, Handoff prioritizes next-owner clarity. Choose based on these signals:
   - **Standard** (default): Use unless the user specifies otherwise or the situation is a crisis, because the Standard variant is optimized for decision-making with full context and measured scope.
   - **Escalation**: User provides `--escalation` flag (e.g., `sitrep ARC-4844 --escalation`), OR ticket is marked P1/Critical AND contains language suggesting urgency (deadline, "now", "immediately"). Confirm with user if ambiguous: "Is this a crisis requiring immediate decision? (yes/no)" — because crisis decisions have different constraints than steady-state updates (timeline-driven, single decision focus, authority-identified).
   - **Handoff**: User provides `--handoff` flag (e.g., `sitrep ARC-4844 --handoff`), OR ticket shows ownership change (comment says "handing off to Willis", or assigned-to changed). If inferring from context, confirm: "Is this a handoff SITREP? (yes/no)" — because handoff SITREPs prioritize next-owner clarity and critical constraints over full context breadth, enabling instant resumption.
   
   Once variant is selected, follow the matching procedure below (Standard Procedure, Escalation Procedure, or Handoff Procedure).

## Execution Procedures

**See [procedures.md](procedures.md) for the three variant-specific step-by-step procedures** (Standard for steady-state, Escalation for crisis, Handoff for owner-switch). Each procedure includes:
- Steps 2–8 (or 2–7 for Escalation/Handoff) with detailed guidance
- Variant-specific discipline rules and enforcement checklists
- Example patterns and when to enforce each rule

Choose your variant in Step 1b above, then read the matching procedure.

</instructions>

## Agent Enrichment: Decision Trees

A SITREP may surface issues that benefit from specialist agents. Invoke them **during Steps 2–3** (while drafting) so you can incorporate findings into your final sections. After an agent completes, re-run Step 4 (enforce discipline) on the updated sections before saving.

### **When to use `/pmo` (Project Management Coordinator)**

Invoke pmo when the blocker's path forward is unknown or requires cross-team negotiation, because pmo has portfolio visibility and can surface ownership and dependencies that are invisible within a single ticket's context.

**Use /pmo if:**
- Blocker's owner is NOT currently assigned to this ticket, because pmo can research who actually owns the resolution path across the team roster
- Resolution requires coordination across 3+ teams, because pmo has visibility across teams and can unblock multi-party dependencies
- Resolution path is unclear or disputed, because pmo can clarify trade-offs and blockers between stakeholders

**Don't use /pmo if:**
- Blocker is already tracked in a separate ticket with an assigned owner, because the owner is known and you'd be duplicating work
- Blocker is a wait-gate (e.g., "waiting on Jason's decision"), because pmo can't accelerate a decision that's not yet made — that's a decision-gate, not a dependency-discovery problem
- Blocker is internal to this team's workflow, because use `/system-architect` for design questions instead — pmo is for cross-team coordination, not technical design

### **When to use `/system-architect`**

Invoke architect when a DECISION NEEDED is technical and involves design trade-offs, because architect can weigh correctness, scalability, and blast radius before implementation begins (catching design flaws is cheaper than code rework).

**Use /system-architect if:**
- DECISIONS NEEDED includes an architectural choice (e.g., "DPC direct vs. GSS proxy", "monolith vs. microservice"), because arch decisions are load-bearing and have long-lived consequences
- Design options exist with trade-offs to evaluate (architect can weigh them), because the architect's role is to surface hidden costs (performance, reliability, maintenance) in each option
- Implementation plan needs validation before code begins (architect can spot blockers early), because validating the plan saves rework after code is written

**Don't use /system-architect if:**
- Decision is non-technical (resource allocation, timeline negotiation, personnel), because architect's expertise doesn't apply — escalate to pmo or Jason instead
- Architectural direction is already decided and signed off, because use `/qa` for defect verification instead — verification is QA's job, not architecture's
- The blocker is a dependency on another team, because use `/pmo` instead — pmo owns cross-team dependencies, not design review

### **When to use `/qa`**

Invoke qa when claims in ACTIONS TO DATE are unverified or regressions are suspected, because qa performs exploratory testing and transforms "I think it's broken" into verified facts that decision-makers can trust.

**Use /qa if:**
- ACTIONS TO DATE includes unverified claims or suspected regressions ("I think X is broken", "probably caused by Y"), because qa can test and confirm — moving speculation to facts changes the DECISIONS NEEDED section from "further investigate" to "we know X happened"
- Reproduction steps need validation (qa can test and confirm), because a reproducible failure is a fact; a suspected one is not
- Test coverage for a claimed defect is uncertain, because qa audit can map test gaps and reveal whether the claim is real or a testing artifact

**Don't use /qa if:**
- No claims have been tested yet (investigation is still speculative; /qa comes after hypotheses exist), because qa validates known hypotheses, not discovery — if you don't have a hypothesis, there's nothing for qa to test
- Defect is already formalized in a ticket with a reproduction case (qa would duplicate work), because the formalization means the defect has already been validated; qa's job is done
- Issue is architectural (use `/system-architect` instead), because architect handles design trade-offs, not defect validation

### **Agent Enrichment Loop (Step 4a)**

If you invoke an agent during Steps 2–3:

1. Agent completes and returns findings
2. Incorporate findings into the relevant SITREP sections:
   - New discoveries → ACTIONS TO DATE
   - New blockers → ISSUES
   - New risks → RISKS
   - New decision points → DECISIONS NEEDED
   - Next action owner clarified → NEXT ACTION OWNER
3. **Re-run Step 4 (enforce discipline rules)** on all updated sections
4. Finalize and save (do NOT re-invoke the same agent a second time)

## Quick Reference

### **Choosing Your Variant**

- **Standard** (default): Steady-state investigation, mid-work progress, normal handoff → use unless specified otherwise
- **Escalation**: Crisis, decision deadline < 2h, P1 ticket → add `--escalation` flag to command
- **Handoff**: Switching owners, pause point, end of session → add `--handoff` flag to command

### **Draft Templates**

**SITUATION (Standard/Escalation/Handoff):** Present tense, current scope, no history.
```
Current: X is happening. Scope: team/system/ticket. Status: Blocked/In progress/Resolved.
```

**ACTIONS TO DATE (Standard):** Verified facts, outcomes, not activities.
```
✓ Confirmed X is the root cause (evidence: Y)
✓ Tested Z; result: behavior W
✓ Ruled out hypothesis A (because: B)
```

**ACTIONS PLANNED (Standard):** Future steps with completion criteria.
```
→ Clarify endpoint contract from delivery team (expect API spec by EOD)
→ Implement DPC query layer (estimate 2h once spec confirmed)
→ At next update: API contract finalized, or escalated to PO
```

**DECISIONS & NEXT ACTION OWNER (Standard):** Explicit asks + accountability.
```
**Decisions needed:** Should ARC query DPC directly, or should GSS proxy DPC state?

**Next action owner:** system-architect (design option)

**Notable:** None.
```

**DECISIONS & NEXT ACTION OWNER (Escalation):** Urgency + authority.
```
**Decisions needed:** Escalate to on-call DPC team or accept SLA breach?

**Next action owner:** on-call DPC lead (decision authority)
```

**DECISIONS & NEXT ACTION OWNER (Handoff):** Clarity on next owner.
```
**Decisions needed:** None at this time.

**Next action owner:** Willis (implementation)
```

**ISSUES/RISKS (Standard):** Full context.
```
**Issues:** Blocked on external team response (delivery lock API contract).

**Risks:** If API contract changes during implementation, rework estimate doubles.
```

## Common Mistakes

| Mistake | Example | Fix |
|---|---|---|
| SITUATION is too long | "Here's the entire history..." | Keep it 3 sentences: what, scope, status. |
| Activities instead of outcomes | "We investigated the code" | "Code reveals that X is the root cause" |
| Mixing past and future | ACTIONS TO DATE includes "will try next" | Split: DATE section = completed, PLANNED section = future. |
| Missing DECISIONS NEEDED | Everything is planned; no ask. | Always include this section. If no decision, say "None at this time." |
| Chronological instead of importance-ordered | Sections ordered by discovery time | Reorder by impact: blockers first, nice-to-know last. |
| Speculation in ACTIONS TO DATE | "We think X might be the issue" | Move to Risks: "If X, then Y could happen." |
| Nested sub-bullets in ACTIONS PLANNED | `- Implement → sub-step A, sub-step B` | Flatten: one `→` bullet per planned action; sub-tasks belong in the ticket. |
| Too much detail | 3+ pages of findings | Cut to facts only. Move detailed analysis to a separate appendix file. |

<examples>

## Example 1: Blocked investigation

```
# SITREP: ARC-4803 Lock Staleness — 2026-06-15 14:30

## 1. SITUATION
ARC displays lock staleness from GSS, but the authoritative lock is created in DPC. GSS only tracks locks it creates itself, so active downloads are invisible to the UI. Implementation is blocked on the lock topology decision.

## 2. ACTIONS TO DATE
✓ Verified DPC is the authoritative lock source (ArcClient.js:580 calls `PUT /deliveryRequest/lock`)
✓ Confirmed GSS `/requests/locks` only returns GSS-created locks (not DPC locks)
✓ Tested: active ARC downloads do not appear in GSS all-locks view
✓ Ruled out: DPC/GSS locking is not the issue; it's a read-source problem

## 3. ACTIONS PLANNED
→ Await delivery team's lock API contract (endpoint, expiration field, query format)
→ Once spec received: implement DPC query layer in requestManagerV3Handlers.js (estimate 2h)
→ Wire ARC UI to read from DPC instead of GSS
→ At next update: API contract finalized OR escalated to PO

## 4. ISSUES, RISKS, AND DECISIONS NEEDED
**Issues:** Blocked on external team (delivery) to clarify lock API.

**Risks:** If delivery cannot expose lockExpiration via API, ARC must infer it from acquisition timestamp + 30min TTL.

**Decisions needed:** 
- Should ARC read DPC locks directly, or should GSS proxy DPC state to ARC?
- If both systems have locks, which takes precedence?

**Notable:** None.
```

## Example 2: Post-discovery summary

```
# SITREP: GitHub anthropics/claude-code#5127 — 2026-06-15 11:00

## 1. SITUATION
Tests are flaky on CI but pass locally. Root cause is a race condition in the async test helper; real timers don't guarantee timestamp changes between assertions.

## 2. ACTIONS TO DATE
✓ Reproduced flakiness in CI (3 out of 10 runs failed)
✓ Isolated to `condition-based-waiting` test helper (uses setTimeout(5) for delay)
✓ Verified local runs hide the bug (fast machine produces different Date.now() per statement)
✓ Confirmed CI runs 5–10x slower; real timers fail silently

## 3. ACTIONS PLANNED
→ Switch to Jest fake timers (setSystemTime instead of setTimeout)
→ Update test helper documentation
→ Verify CI pass rate recovers to 100%
→ At next update: PR merged, flakiness resolved

## 4. ISSUES, RISKS, AND DECISIONS NEEDED
**Issues:** None; path forward is clear.

**Risks:** Other tests using setTimeout may have the same problem (need test audit).

**Decisions needed:** None.

**Notable:** This is a testing-pattern problem, not a code bug. Fake timers solve it cleanly.
```

## Example 3: Escalation SITREP — Production incident

```
# SITREP: ARC-4801 Production Lock Cleanup Cascading — 2026-06-15 14:18 [CRITICAL]

## 1. SITUATION
15 requests are currently stalled (vs 2 this morning). GSS auto-recovery window expires in 12 minutes. Decision needed immediately.

## 2. TIMELINE/DEADLINE
12 minutes until SLA breach (2026-06-15 14:30). Decision authority: on-call DPC team lead.

## 3. DECISION NEEDED
Escalate to on-call DPC to manually trigger cleanup, or accept SLA breach and attempt auto-recovery?

## 4. ACTIONS IN PROGRESS
ARC incident team staging: screenshot, repro steps, DPC contact list. Awaiting your decision now.

## 5. RISKS
If auto-recovery triggers < 1 minute before cutoff, cascade may not complete in time.

**Issues:** None.

**Decisions needed:** Should we escalate to on-call DPC immediately?

**Next action owner:** on-call DPC lead (decision authority)

**Notable:** This has happened twice before (ARC-4756, ARC-4682); both resolved by escalation within 8 min. Early escalation is the safe pattern.
```

## Example 4: Handoff SITREP — Pausing for architecture review

```
# SITREP: ARC-4844 Wire ARC Acquire Path to GSS Lock — 2026-06-15 16:45

## 1. CURRENT STATE
Implementation design is gated on architecture review. Design doc (ARC-4843) is complete and ready. No code committed to branch yet; branch is clean.

## 2. NEXT OWNER
system-architect (will review Option B and validate Option C rejection)

## 3. NEXT IMMEDIATE ACTION
→ Review ARC-4843 architecture spike decision and validate Option B (dual-write GSS lock, fire-and-forget) is the right call against Option C (full GSS routing).

## 4. CRITICAL CONSTRAINTS
- Cannot begin implementation until architecture is signed off (architecture unblocks code)
- DPC's proven 409 routing must not be broken (Option C is high-risk)
- GSS lock must be fire-and-forget, no blocking waits (performance constraint)

## 5. DECISIONS/GATES
Architecture sign-off is the blocking gate. Once approved, implementation is unblocked (checklist written, 2–3 day estimate).

## 6. CONTEXT FOR NEXT OWNER
ARC-4803 is P1. This is the critical-path subtask. DPC team already reviewed ARC-4843 and confirmed 409 routing is load-bearing. GSS team confirmed lockExpiration API is ready. Only the ARC implementation path (Option B vs. C) is unresolved. This decision was grilled via `/grill-me` with all 8 decision branches resolved.

**Issues:** None; path forward is clear.

**Risks:** If architecture sign-off is delayed beyond tomorrow, ARC-4803 misses the release window.

**Decisions needed:** Confirm Option B is safe for DPC's 409 routing. Confirm Option C blast radius justifies rejection.

**Next action owner:** system-architect (validate design)

**Notable:** `/grill-me` already resolved all major decision branches. Bring that transcript to the review.
```

</examples>

## When SITREPs Save Time

- **Blocked work:** Capture state clearly so you (or someone else) can resume instantly without ramp-up or clarification questions.
- **Escalations:** Give decision-makers exactly what they need to act, no fluff — a one-pager beats a 30-minute call.
- **Handoff:** Next person reads one page and knows what's true, what's tried, what's needed to unblock.
- **Team updates:** 30-second read instead of a long narrative that loses them halfway through.

If you find yourself writing more than one page or rewriting sections multiple times, the SITREP is trying to tell you the situation is more complex than one update can hold — consider creating a separate investigation report file and referencing it from the SITREP's "Notable" section.
