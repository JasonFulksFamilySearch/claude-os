# Experience-Synthesis Value-Gated Selection — Design

**Date:** 2026-06-08
**Author:** Walter (Jason's agent, personal Mac / macelabs-macair), AI-generated, human-directed
**Status:** Design (brainstormed + adversarially grilled). Ready for implementation-plan once approved.
**Supersedes:** bet **A2** reader-path in `2026-06-08-leverage-briefing-spec.md` (§6, §8) — see §7.
**Provenance:** Grew out of a red-blue-judge of §5.2 of the leverage briefing, which surfaced a code↔doc
ordering mismatch. An adversarial AI-systems-architecture consult then proved the original "value-weighted
ordering" mechanism was aimed at a leverage-neutral lever. This design is the corrected mechanism. Decisions
below were each resolved through `/grill-me` (Section 3 reader/shadow, Section 4 spec corrections).

---

## 1. Problem

The experience-synthesis engine distills cross-session episodes into promotable higher-order learnings.
Three defects, all verified against live code (not the spec's description of it):

1. **Code↔doc mismatch on cluster ordering.** `experience.ts:84` sorts clusters by **member-count (size)**
   descending (`b.members.length - a.members.length`); cohesion is computed (`experience.ts:69-80`) but never
   read for ordering. Meanwhile `skills/experience-synthesis/SKILL.md:59` instructs the operator to "process
   the highest-cohesion clusters first." Code and doc disagree on ordering, with two different owners — the
   structural cause of the drift.

2. **Nothing orders or selects by VALUE.** No value field exists anywhere: `ALLOWED_FM_KEYS`
   (`episode-utils.js:22`) = `{date, session_id, project, turns, promoted}`; `reinforcementBonus`
   (`ranking.ts:40-54`) = recency + frequency only; episode-write is gated on salience not value
   (`session-observer-worker.js:251`). The only value-shaped field, `estimated_weekly_savings_minutes`
   (`experience.ts:109`), is a post-hoc LLM guess and is unused.

3. **The ordering fight is the wrong fight.** `scan_experience` returns **all** surviving clusters with no
   top-N truncation (`scan_experience.ts:90-102`). So cluster sort order only sets which cluster the agent
   *reads first* in a run that "need not exhaust them" — it is **leverage-neutral**. The genuinely value-blind,
   lossy levers are (a) the **recency cap** on input episodes (`scan_experience.ts:69-71`,
   `EXPERIENCE_MAX_EPISODES=200`) and (b) **distilling every coherent cluster** regardless of worth, which burns
   the scarce resources: operator attention at the gates and a full grounding/grade/red-blue-judge cycle per
   cluster.

**The objective is operator leverage:** the synthesis engine should compound along the axis of *measured value*,
not theme-density — and it should spend its expensive pipeline on the episodes/clusters worth distilling.

---

## 2. Principle (why this design cannot re-create the mismatch)

**Mechanical decisions live in code; the SKILL.md describes only what code cannot decide.** Sorting, filtering,
capping, thresholding are unit-testable → code, single-owner. "Is this a genuine recurring situation? Is this
lesson actionable?" is irreducibly judgment → SKILL.md. The mismatch in §1.1 happened because *ordering* (a
mechanical decision) was expressed in two places. The cure is to make ordering **unrepresentable in the doc**,
not to sync two copies of it. Test for any future knob: *if a unit test could assert it, it belongs in code;
if only a human can adjudicate it, it belongs in the SKILL.md.*

---

## 3. Architecture

The lever moves from **ordering** (leverage-neutral) to **selection** (where loss actually happens). Value is
minted once at session end and consumed once as a code-side selection gate — shipped as a single unit so there
is no write-with-no-reader.

```
session ends
   │
   ▼
[A2 writer]  headless LLM-judge over the transcript ──► episode frontmatter
   │              (anchored 0..4 rubric; declines → writes NO key)
   ▼
episode .md  frontmatter: value_score, value_source, value_rubric_version, value_model
   │
   ▼
/experience-synthesis ──► scan_experience.ts:
     1. backlog = unpromoted episodes
     2. read value_score via the shared EpisodeRecord shape         ◄── NEW (lockstep parsers)
     3. cap = value-then-recency                                    ◄── CHANGED (was recency-only)
     4. cluster by cosine (clusterByEmbedding — UNCHANGED)
     5. value gate (episode-level + cluster-level) — INERT by default ◄── NEW (shadow mode)
     6. emit a shadow-log line (what it WOULD drop)                 ◄── NEW (telemetry)
     7. sort = size-desc tiebreak (code-owned, now purely cosmetic)
   │
   ▼
SKILL.md Step 2: process clusters in RETURNED order                 ◄── ordering instruction DELETED
     (judgment only: real shared situation? actionable lesson?)
```

---

## 4. Component A — the value writer

Mints an **auditable** value signal. "Auditable" is the standard that separates this from the dead
`estimated_weekly_savings_minutes`: a signal we will later gate behavior on must be reproducible, must admit
ignorance, and must be anchored to fixed definitions.

**Where:**
- `hooks/lib/episode-utils.js:22` — add `value_score` (and provenance keys) to `ALLOWED_FM_KEYS`.
- `hooks/session-observer-worker.js` (`buildEpisodeContent`, ~line 216) — write the keys when the episode is
  minted, at the existing Stop-hook worker (already fires headlessly; no new lifecycle hook).

**What is written** (frontmatter):

| Key | Value | Notes |
|-----|-------|-------|
| `value_score` | `0..4` ordinal **or the key is omitted** | Omitted ⇒ "unknown" (see §4.1). Never a fabricated `0`. |
| `value_source` | `llm-judge` | Provenance; distinguishes judge-minted from any future measured value. |
| `value_rubric_version` | e.g. `v1` | The anchored rung definitions used. Versioned so scores stay comparable across rubric changes. |
| `value_model` | model id | So a score survives a model upgrade — reproducibility. |

**How derived:** headlessly at the worker, reusing the existing grade-proposal / red-blue-judge judge over the
session transcript, against an **anchored 0–4 rubric** (each rung defined, e.g. 0 = no durable value / thrash;
4 = a reusable lesson that changes future sessions). **No commit-inference** (falsified premise #3 — it scores
investigate/oracle/design-review/grill-me as value-negative). An optional one-keystroke operator override may
set the score, but it is never primary — the signal must not depend on teardown behavior.

### 4.1 Unknown value = key absent  *(grilled decision)*

When the judge has insufficient signal (short/ambiguous session), it writes **no `value_score` key at all** —
not `null`, not `0`. Rationale: the frontmatter parsers (`episode-utils.js` and `episodes.ts` via gray-matter)
have no `null` representation, and "unknown" must never be confused with "low." A gate must never exclude on a
fabricated low score; with absence-as-unknown there are no fabricated scores — only real scores and honest
absences. **Accepted cost:** absence cannot on its own distinguish "judge ran and declined" from "pre-feature /
never scored." §6.2 resolves this in the shadow log via date-bucketing.

---

## 5. Component B — the selection reader (gate)

Three sub-parts. All new filtering defaults to **fully permissive / shadow** — the feature ships as a behavioral
no-op with full observability, and is flipped to live only on evidence (§6).

### 5.1 Carry the field through *(lockstep — hard constraint)*

`value_score` must be surfaced on **every** read path or it is silently dropped on one:
- `hooks/lib/episode-utils.js` `ALLOWED_FM_KEYS` (the CommonJS parser).
- `mcp/src/episodes.ts` — **two edits:** add `value_score` to the `EpisodeRecord` interface (lines 10-18),
  **and** extend the record-populate in `listEpisodeFiles` (lines 72-84, which currently cherry-picks
  `date/session_id/project/turns/promoted/summary` from `parsed.data`) to read `value_score` from frontmatter.
  The interface field is inert unless the populate actually sets it — both are required.
- `mcp/src/tools/list_episodes.ts` (kept in lockstep with the above per its own comment).
- `mcp/src/tools/scan_experience.ts` — **two edits, both required:** (i) the `ClusterMember` interface
  (lines 16-21) gains the field; (ii) the output **mapping operation** at lines ~95-100 (the inner
  `members.map((ep) => ({ path, session_id, date, summary }))` inside the `clusters.map` at lines 92-101) must
  add `value_score: ep.value_score`. NOTE: lines 75-87 are the *embedding-lookup loop* (`idStmt`/`vecStmt`
  resolution), **not** the populate — the field is carried onto the in-memory record there via
  `listEpisodeFiles`, but it is the map at ~95-100 that emits the output shape. Omitting (ii) silently drops
  `value_score` from the `scan_experience` response even with (i) present — the exact "never silent data loss"
  failure this constraint exists to prevent.

This is a **both-or-neither** edit across **five** sites — `ALLOWED_FM_KEYS` (`episode-utils.js:22`),
`EpisodeRecord` (`episodes.ts`), `list_episodes.ts`, the `ClusterMember` interface, **and** the
`ClusterMember` output mapping (`scan_experience.ts` ~95-100) — per the existing lockstep comments in
`episode-utils.js:43` and `episodes.ts:25`. Miss any one and the field is dropped on that path.

### 5.2 The gate — built, inert by default

New constants in `mcp/src/search_config.ts` (house style: "FIXED, principled defaults — not fit to any labeled
set"):

```
EXPERIENCE_MIN_EPISODE_VALUE  = null      // null ⇒ no episode excluded (shadow only)
EXPERIENCE_MIN_CLUSTER_VALUE  = null      // null ⇒ no cluster excluded (shadow only)
EXPERIENCE_VALUE_GATE_MODE    = "shadow"  // "shadow" | "live"
EXPERIENCE_VALUE_FEATURE_DATE = "<ship>"  // ISO date the writer shipped; for shadow bucketing (§6.2)
```

There are **three distinct value-aware operations** — do not conflate them:

- **(i) Value-aware cap** (replaces the recency-only `slice`, `scan_experience.ts:69-71`): when the backlog
  exceeds the cap, select the survivors by value-then-recency instead of recency alone. This bounds *cost* and
  is the one genuinely lossy operation; absent-score episodes sort after scored ones but are not specially
  dropped. (Inert at today's 136 < 200, but it is the silent amputator once the backlog grows.)
- **(ii) Episode gate** (pre-cluster, after the cap, before the embedding resolve at :79): drop episodes whose
  `value_score` is *present and* below `EXPERIENCE_MIN_EPISODE_VALUE`. **Absent score ⇒ never dropped.** Distinct
  from (i): the cap is a cost bound on *how many*, the gate is a worth floor on *which*.
- **(iii) Cluster gate** (post-cluster, at the map :92-101): a cluster's value = **max of its scored members**
  *(grilled decision)*. A cluster is dropped only if **every scored member** is below
  `EXPERIENCE_MIN_CLUSTER_VALUE`. An all-keyless cluster = unknown ⇒ **kept**. Bias is deliberately
  toward keeping.
- **Mode:** in `shadow`, the gate computes the would-drop set but **returns the full set** — behavior identical
  to today. In `live`, it actually filters. The flip is a one-constant change.

The two gates compose without double-jeopardy: episode-gate trims weak members pre-cluster; cluster-gate fires
only when *nothing good* remains (max-aggregation), so a single high-value episode always rescues its cluster.

### 5.3 Doc reconciliation (the original mismatch fix)

`skills/experience-synthesis/SKILL.md:59` — delete **only** the ordering parenthetical. The line becomes:

> `For each cluster (process clusters in the order returned; a single run need not exhaust them):`

The "need not exhaust" license is preserved (it is real and useful); only the ordering claim is removed. The
loop body (Steps 2.1–2.3) is untouched — verified no flow break. The sort at `experience.ts:84` stays as a
deterministic, code-owned tiebreak. **Mismatch class eliminated: nothing mechanical lives in the doc.**

---

## 6. Component C — the shadow log (calibration instrument)

> **Scope note (deliberate addition beyond A2).** The shadow log is *not* in the original A2 brief
> (`2026-06-08-leverage-briefing-spec.md` §6/§8), which specified only: mint the value key, carry it through,
> consume it. It is added here as the **required mitigation for A2's own strongest open risk** — the value
> scalar is an untrustworthy LLM guess (§10), so the gate must ship inert *and observable*, or "tighten later"
> is a guess with no instrument. This is a justified scope addition, listed explicitly here per the
> faithful-representation bar; it is part of the same shippable unit, not silent creep. If the reviewer/operator
> prefers the minimal A2 footprint, the shadow log can be deferred to a follow-on — but then the live-flip
> decision (§8 step 5) has no evidence base and the §10 caveat is unmitigated.

Shadow mode without an instrument is just a disabled feature. The shadow log is what turns "tighten later" from
a hope into an evidence-backed decision.

### 6.1 Location & lifecycle *(grilled decision)*

`~/.claude-data/experience-shadow.jsonl` — one JSON line per `scan_experience` run. Machine-local, gitignored,
no DB, no schema migration; mirrors the existing `digest-queue.jsonl` operational-telemetry seam (run-telemetry
is not retrievable knowledge, so it does **not** belong in `memory.db`). Append-only. **No rotation in v1** —
synthesis is an occasional operator-pull action (a few lines/week); revisit only if Gap 4's eventual automated
trigger puts it on a cadence.

### 6.2 Record shape

```jsonc
{
  "run_ts": "<ISO>",
  "gate_mode": "shadow" | "live",
  "rubric_version": "v1",
  "model": "<id>",
  "episodes_considered": <n>,
  "value_histogram": {
    "0": <n>, "1": <n>, "2": <n>, "3": <n>, "4": <n>,
    "unknown_pre_feature": <n>,   // date <  EXPERIENCE_VALUE_FEATURE_DATE  (expected keyless)
    "unknown_declined":    <n>    // date >= EXPERIENCE_VALUE_FEATURE_DATE  (judge declined — real signal)
  },
  "would_exclude_episodes": [ "<path>", ... ],
  "would_exclude_clusters": [ { "size": <n>, "max_member_value": <v> }, ... ]
}
```

The **calibration null-rate** that matters = `unknown_declined / post-feature episodes`. Date-bucketing
*(grilled decision)* keeps the histogram interpretable: the 136 pre-feature episodes are keyless forever, and
must not be read as judge failures. A high `unknown_declined` rate is itself a "judge isn't ready" signal — flip
to live only when the distribution is sane and the would-drop set is defensible.

---

## 7. Spec corrections to the leverage briefing  *(grilled — record integrity)*

> **Prerequisite, not a promise (sequencing is intentional).** These corrections are deliberately *deferred*
> until after this design doc is committed, so the A2 supersession note can point at a real, committed path
> (a dangling pointer was the rejected alternative — grilled decision, §8). Therefore, at the moment this
> design is reviewed, the briefing is **expected** to be unedited. **Applying §7 to the briefing is a hard
> prerequisite to implementation start** (§8 step 4) — implementation MUST NOT begin until GT-7/Gap 4 are
> corrected and A2 carries its supersession note. This is the recorded plan of record, not an open question.

Applied to `2026-06-08-leverage-briefing-spec.md` **after** this design doc is committed (so the A2 pointer
resolves). Two kinds of change, handled differently:

- **Factual errors → fix in place** (they were never true):
  - **GT-7 (§3.1):** "highest-cohesion clusters first" → size-sort (`experience.ts:84`) with a **code↔doc
    mismatch** vs `SKILL.md:59`; keep "value is never an input" (true today); **add** the architect's
    load-bearing fact — ordering is **leverage-neutral** because all clusters are returned
    (`scan_experience.ts:90-102`, no top-N), so the lossy value-blind levers are the recency cap +
    distill-everything. Brings GT-7 into agreement with the now-clean Gap 2 (it currently contradicts it in the
    same document).
  - **Gap 4 (§5.2):** reframe the risk line from "distilled **first**" (an ordering claim) to "preferentially
    **selected**" (the real lever), consistent with the corrected GT-7.

- **Superseded decision → append, do not overwrite** (preserves the audit trail §10 calls the most valuable
  output):
  - **A2 (§6) and the A2 build-spec line (§8):** leave the original judge rationale and "value-weighted ordering
    within cohesion" text **verbatim** as the historical verdict. Add a dated note: *"Superseded 2026-06-08:
    ordering is leverage-neutral (all clusters returned, no top-N); the reader is a value-**gate** on selection,
    not a reorder. See `2026-06-08-experience-synthesis-value-selection-design.md`."*

---

## 8. Sequencing & dependencies

A2's writer and B's reader ship as **one unit** (satisfies A2's own red-blue-judge REVISE condition: a write
must ship its consumer). **This unit does NOT depend on briefing bet A1** (the invocation meter) — A1 is an
unrelated telemetry bet; the value field this design consumes is produced by the writer *in this same unit*.
The only intra-unit ordering constraint is that the **writer precedes the reader** (the gate has nothing to
read until the field is being written) — but both ship together, so this is a within-PR ordering, not a
cross-bet dependency. Build order:

1. **Writer** (§4): rubric + frontmatter keys + lockstep parser edits.
2. **Reader + shadow log** (§5, §6): carry-through, gate (inert), shadow log, value-aware cap, SKILL.md:59 edit.
3. **Unit test** (§9): the CI regression gate.
4. **Design doc committed**, then **spec corrections** (§7).
5. **(Later, data-driven, not in this unit):** read the shadow log; if calibration holds, set non-null
   thresholds and flip `EXPERIENCE_VALUE_GATE_MODE = "live"`.

All machine setup follows the project rule (`update.sh` / `hooks-install.js` / `search_config.ts` constants);
schema-free — no `memory.db` change. The MCP tree is TypeScript.

---

## 9. Acceptance test  *(grilled decision)*

A `vitest` unit test over `scanExperience()` with hand-built episode fixtures + injected value scores (matches
the existing `experience.ts` unit-test style; deterministic, CI-able, no real corpus). Asserts the three
invariants:

1. **Shadow ≡ no-gate:** in shadow mode the returned clusters are identical to the no-gate run, **and** a
   would-drop set is emitted to the log.
2. **Live changes membership:** in live mode at a non-null threshold the returned membership is strictly
   smaller/different.
3. **Unknown never excluded:** keyless members (both pre-feature and declined) are never dropped in either mode.

This is the **mechanism** gate (correct now, deterministic). The **threshold** decision (when to flip live) is a
separate, later, data-driven step fed by the shadow log — the shadow→live discipline stated as sequencing, not a
competing test.

---

## 10. Risks & the honest caveat

- **The value scalar is an LLM guess, not a measured outcome** — the least-trustworthy signal in the system, on
  a tiny ~5-day, ~136-episode corpus with no calibration. **Mitigation:** the entire feature ships inert
  (`null` thresholds, shadow mode); the shadow log is the calibration instrument; live-flip requires evidence.
  Worst case on day one is zero behavior change with full observability — never silent data loss.
- **Absence conflates declined vs pre-feature** — mitigated by date-bucketing in the shadow log (§6.2).
- **Lockstep parser drift** — if `value_score` lands on only one parser the field is silently dropped;
  enforced as a hard both-or-neither constraint (§5.1).
- **Unbounded shadow log** — non-issue at operator-pull cadence; flagged for revisit if synthesis is ever
  scheduled (Gap 4).
- **A future measured-value signal (B1 territory)** — should plug in via the same code-side selection gate with
  its own `value_source`, never via a SKILL.md reorder, so this mismatch class cannot recur.
