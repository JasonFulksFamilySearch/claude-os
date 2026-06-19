# make-it-so — Triage / right-sizing design

**Problem (evidenced by SCRIP-151):** make-it-so applies a constant-cost pipeline
regardless of ticket size. SCRIP-151 was an ~80-line, single-pattern, low-risk
feature (add two App Router error-boundary files). It consumed ~20 subagent
dispatches, 3 red-blue-judge gates (two of them running the full 3 cycles), a
`/design-review`, and produced 1,117 lines of process artifacts (PRD 234, plan
571, 7 audit records) against ~370 lines of actual code+tests. The gates earned
their keep (4 real defects caught) — but the *ceremony was constant while the
risk was small*. Cost should scale with risk.

**Non-negotiable that this design must preserve:** the skill's hard constraint —
"never advance past a gate without a CLEAN verdict; never bypass the loop
mid-flight." This design does NOT weaken that. It changes, ONCE and UP FRONT,
*which gates a ticket warrants* and *how many revise cycles each gets* — the same
principle the skill already uses to let bug/chore tickets skip design-review.
A gate that applies on the chosen track still runs to a real CLEAN verdict.

---

## Step 0 — Triage (new, runs after /investigate, before PRD)

`/investigate` already returns a confidence report and a sense of the change's
shape. Use its output plus a quick scope read to classify the ticket into a
**track**. The classification is stated to the user with its rationale, and the
user can override (bumping up a track is always allowed; bumping *down* requires
the user to explicitly accept the reduced rigor).

### Classification inputs (all from the investigation, no extra agents)
- **Estimated diff size** — files touched + rough LOC (investigation already maps this).
- **New-pattern?** — does it introduce a new architectural pattern / class / route
  group / schema change, or does it mirror an existing one?
- **Blast radius** — does it touch a shared/critical module (auth, schema,
  lifecycle, money, migrations), or is it leaf/additive?
- **Reversibility** — additive new files (delete to roll back) vs. in-place change
  to a load-bearing path.

### Tracks

| Track | Triggers (ALL must hold) | Pipeline |
|---|---|---|
| **SMALL** | ≤ ~150 LOC est. AND mirrors an existing pattern (no new pattern) AND leaf/additive blast radius AND reversible | investigate → (skip PRD, skip plan, skip design-review) → build to a short inline spec → **Gate 3 (diff) only, 1 cycle** → review (code-reviewer + qa) → PR → closeout |
| **MEDIUM** | ≤ ~500 LOC est. AND (new pattern OR moderate blast radius) but not critical-path | investigate → PRD → **Gate 1, cap 1 cycle** → design-review *only if* a genuinely new pattern → subtasks → plan → **Gate 2, cap 1 cycle** → build → **Gate 3, 1 cycle** → review → PR → closeout |
| **LARGE** | > ~500 LOC OR critical-path/shared-module OR irreversible change OR explicit user request for full rigor | the CURRENT full flow: all 7 steps, all 3 gates, `max_revise_cycles: 2`, design-review for architectural scope |

**SCRIP-151 would have been SMALL** (80 LOC, mirrors access-denied pattern,
additive new files, reversible). Its pipeline collapses to:
investigate → build → one diff-gate → review → PR. No PRD, no plan, no two
planning gates, no design-review. The single Gate 3 still runs (it's the
genuineness gate — the one that actually judges the shipped code), so the safety
that matters most is retained. Estimated cost: ~5-6 agents instead of ~20.

### Why a single diff-gate is safe for SMALL
Gate 3 (diff mode) is the only gate that judges the *implemented* fix rather than
the *intended* one. For a small additive change with no PRD/plan, there is no
"misaligned-requirements-reaching-PR" risk to catch at Gates 1/2 — the change is
small enough that the diff IS the spec. Gate 3 + code-reviewer + qa cover
correctness, genuineness, and behavior. Gates 1/2 exist to stop a *flawed plan*
from reaching code; a SMALL ticket has no separate plan to be flawed.

---

## Cycle-cap change (applies to MEDIUM)

`max_revise_cycles` defaults to 2 (→ up to 3 cycles). On SCRIP-151, the 3rd cycle
of BOTH planning gates was a reviewer *mis-applying its own rubric* (a diff
standard on a PRD; an empirical fact scored as a product decision), each forcing a
wasted re-dispatch. Capping MEDIUM gates at 1 cycle means: one REVISE for a real
defect is allowed; a second consecutive REVISE escalates to the user instead of
grinding. (LARGE keeps cap 2 — bigger artifacts legitimately need more passes.)

This does NOT fix the underlying rubric misfire — that's a separate red-blue-judge
hardening task (tracked as a follow-up). The cap just bounds its cost.

---

## Artifact-bloat change (applies to MEDIUM + LARGE)

The plan embedded full copy-paste code blocks. That is *why* the hex-mismatch
defect existed for Gate 2 to catch — we hand-wrote code in the plan that then
needed gate-checking, when the same code would have been checked at Gate 3 anyway.
**Change:** plans reference files and describe changes; they show code only for a
genuinely non-obvious algorithm, not for boilerplate a competent engineer writes
the same way every time. Shrinks the plan and removes a whole class of
"defect in the plan's sample code" gate cycles.

---

## What does NOT change
- Gate *integrity*: any gate that runs on the chosen track runs to a real CLEAN
  verdict; no mid-flight skipping.
- LARGE tickets get exactly today's behavior.
- The user can always force a higher track ("do the full thing").
- Step 7 closeout, the reversibility confirmations, and the trust boundary are
  untouched.

---

## Settled decisions (Jason, 2026-06-17)

1. **SMALL audit trail = a 3-line inline spec posted to the JIRA story** before
   building (what's being built + which pattern it mirrors), and the Gate-3
   verdict posted after. No full PRD on SMALL, but the story keeps a traceable
   written intent for ~1% of the PRD's cost.
2. **Triage ALWAYS confirms the track with the user** before proceeding — on
   every ticket, not only on SMALL. Rationale (Jason's, and it is the stronger
   call): the dangerous failure mode is not "a small ticket got too little
   rigor" — it is "a risky ticket was mis-classified as SMALL and the lighter
   pipeline ran before anyone noticed." Confirming every track lets the user
   catch a mis-size on ANY track *before* the chosen pipeline executes. The
   one-stop cost is negligible against that protection. So Step 0 ends with:
   present the classification + the evidence that drove it (est. LOC,
   new-pattern?, blast radius, reversibility) + the resulting pipeline, and wait
   for the user to confirm or override. Bumping the track up is always allowed;
   bumping down requires explicit acceptance of the reduced rigor.

## Still open (decide before implementing)
1. Are the LOC thresholds (~150 / ~500) right, or tighter/looser? (Working
   defaults below; easy to tune.)

## Implementation status
SPEC ONLY. Per Jason's instruction, the shared skill `~/.claude/skills/make-it-so/SKILL.md`
is NOT edited until he reviews and signs off on this design and the thresholds.
