---
name: experience-synthesis
description: >
  Cross-session "experience" synthesis (Claude OS memory, roadmap B1). Clusters the unpromoted
  episode backlog, distills each coherent cluster into one candidate higher-order learning, and
  routes every candidate through three pre-human gates — deterministic grounding, /grade-proposal,
  and a red-blue-judge adversarial cross-check — before a human-gated promotion. Use when the user
  invokes /experience-synthesis, "synthesize experience", "synthesize my episodes", or as Phase 4
  of /memory-merger. Nothing is ever written without approval.
argument-hint: "(no arguments) | optional project slug"
allowed-tools: Read Glob Grep Agent mcp__claude-os-mcp__scan_experience mcp__claude-os-mcp__validate_experience_proposal mcp__claude-os-mcp__append_learning mcp__claude-os-mcp__mark_episode_promoted mcp__claude-os-mcp__list_episodes
---

<role>
You turn many isolated session episodes into a small number of genuinely-earned cross-session
"experience" learnings. You are deeply skeptical of your own abstractions: an LLM will happily
manufacture a profound-sounding lesson from a coincidental cluster, and any fake learning you
promote poisons the retrieval layer for every future session. So you never let a candidate reach
the human until it has survived three independent gates, and you never write a learning or promote
an episode without explicit approval.
</role>

<task>
**Task:** Cluster the unpromoted episode backlog, distill each cluster into one candidate
experience-learning, filter the candidates through three gates, present the survivors for
human-gated approval, and — only on approval — append each approved learning and mark its cited
source episodes promoted.

**Intent:** Climb the memory-maturity ladder from Storage+Reflection to **Experience** — abstract
patterns *across* sessions the system witnessed but never generalized — without manufacturing
spurious insight ("insight inflation").

**Hard constraints:**
- Never write a learning or call `mark_episode_promoted` before the human approves the specific
  proposal. Present, then STOP and wait.
- Every proposal MUST cite its source episodes; a claim no cited episode supports does not ship.
- The three gates are mandatory pre-human filters, in order: (1) `validate_experience_proposal`
  (grounding), (2) `/grade-proposal` (score ≥ 70), (3) `red-blue-judge` mode `experience` (verdict
  CLEAN). A candidate that fails any gate is dropped (or revised once) — it never reaches the human.
- Nothing is auto-applied, auto-merged, or deleted. Promotion of source episodes happens ONLY when
  the human approves the learning they produced.
- Write learnings via `append_learning` (never a direct edit) so they are formatted and reindexed.
- Cite-or-drop: if you cannot ground a claim in a real cited episode, cut the claim.
</task>

<instructions>

## Step 1 — Cluster the backlog

Call `scan_experience` (pass the optional project slug if the user scoped it). It returns thematic
clusters of UNPROMOTED episodes, each with member episodes (path, session_id, date, summary) and a
cohesion score. Clusters below the minimum size are already dropped server-side.

If it returns no clusters, report "no synthesizable clusters in the current backlog" and stop —
there is nothing to synthesize.

## Step 2 — Distill one candidate per cluster

For each cluster (process clusters in the order returned by `scan_experience`; a single run need not exhaust them — discard any cluster whose members do not share a genuine recurring situation):

1. **Read the member episodes in full** (Read each `path`) — not just the summaries. You are looking
   for a *recurring situation* the episodes share and the *lesson* that situation teaches.
2. If the cluster is only superficially related (no genuine shared situation), **discard it** — do
   not force a learning. Coincidental proximity is not a pattern.
3. Otherwise distill ONE concrete, actionable experience-learning and build a proposal in the
   `proposal-schema.json` shape:
   - `id`: `P001`, `P002`, … (sequential within this run)
   - `category`: `EXPERIENCE_LEARNING`
   - `title`: the lesson in one line (≤ 120 chars)
   - `description`: the lesson plus the recurring situation it generalizes (≥ 50 chars)
   - `evidence`: one entry per source episode, each citing the episode's **unique file path** (a
     `session_id` is NOT unique — one session emits several episodes, so cite the path to establish
     distinct episodes; the session_id/date are fine as added context) and **what that specific
     episode showed** — this is the grounding; every claim in the description must trace to at least
     one of these
   - `proposed_change`: `{ file: <agent or project learnings.md absolute path>, action:
     APPEND_LEARNING, content: <the learning text to append> }`
   - `estimated_weekly_savings_minutes`: an honest estimate of the re-derivation time saved (bounded)
   - `priority`: HIGH/MEDIUM/LOW

## Step 3 — Gate 1: grounding (deterministic)

For each proposal, call `validate_experience_proposal`. Drop any proposal it returns `valid: false`
for, and note the reason (schema error, unresolved/fabricated citation, or duplicates an existing
learning). This gate is mechanical and final — do not argue with it; fix the proposal and re-validate
only if the fix is a genuine correction (e.g. you mis-typed a session_id), never to launder a
fabrication.

## Step 4 — Gate 2: quality (/grade-proposal, ≥ 70)

Invoke the `grade-proposal` skill **once per surviving proposal**, in isolation (it must not see your
reasoning). Keep only proposals scoring **≥ 70**. Record each score. A proposal that scores below 70
is dropped — a weak-evidence or vague learning is exactly what this gate exists to stop.

## Step 5 — Gate 3: truth (red-blue-judge, mode `experience`)

For each proposal that cleared gate 2, invoke `red-blue-judge` with:
- `mode`: `experience`
- `artifact`: the proposal
- `ground_truth`: the cited source episode paths + the existing learnings files (agent + relevant
  project)
- `state_file`: `~/.claude-data/projects/claude-os/rbj-experience-<id>-cycle1.md`
- `cycle`: 1

Keep only proposals with verdict **CLEAN**. On **REVISE**, you may regenerate the proposal once
against the cited `revise_lines` and re-judge (cycle 2); if it still does not reach CLEAN, drop it.
On **ESCALATE**, surface the escalation to the human and drop the proposal from the auto-approved set.

## Step 6 — Present survivors and STOP

Present every proposal that cleared all three gates:

```
## Experience synthesis — candidate learnings

### P001 — [title]   (grade NN/100, gate verdict CLEAN, cohesion 0.NN)
Source episodes: [session_id · date] × N
Proposed learning (→ [agent|project] learnings):
  [content]
```

List any clusters discarded or proposals dropped at each gate (one line each) so the human sees what
was filtered and why.

Say: **"Approve all with 'go', approve specific ones by id (e.g. 'go P001 P003'), or name ones to
skip."** Then **STOP and wait for input.** Write nothing yet.

## Step 7 — Execute approved learnings (after approval only)

For each approved proposal:
1. `append_learning` with the proposal's scope (`agent` or `project` + slug), the `content`, and a
   title derived from the proposal title.
2. For each cited source episode, call `mark_episode_promoted` on its path — this removes it from the
   next run's backlog (the episodes' signal is now captured).

Skip any proposal the human did not approve; leave its source episodes unpromoted.

## Step 8 — Report

```
## Experience synthesis complete — [YYYY-MM-DD]
- Clusters found: N (discarded as incoherent: M)
- Candidates generated: N → gate 1 grounding: K passed → gate 2 grade ≥70: J passed → gate 3 CLEAN: I passed
- Approved & appended: A learnings
- Source episodes promoted: E
```

</instructions>

<success_criteria>
The skill is complete when:
- Every presented candidate cited its source episodes and passed all three gates (grounding,
  grade ≥ 70, red-blue-judge CLEAN) before the human saw it.
- No learning was written and no episode was promoted before explicit human approval.
- Approved learnings were written via `append_learning`; their cited source episodes were promoted
  via `mark_episode_promoted`; unapproved proposals left their episodes unpromoted.
- Incoherent clusters and gate-dropped candidates were reported, not silently discarded.
- The final report showed the per-gate funnel counts.
</success_criteria>

<examples>
<example label="typical-run">
Input: /experience-synthesis
Step 1: scan_experience → 2 clusters (sizes 4 and 3).
Step 2: cluster A → a real recurring lesson ("worktree sessions reset cwd; merge from main");
        cluster B → superficial proximity, discarded.
Step 3: validate_experience_proposal(P001) → valid (3 citations resolve, not a duplicate).
Step 4: grade-proposal(P001) → 88 ≥ 70, kept.
Step 5: red-blue-judge mode=experience (P001) → CLEAN.
Step 6: present P001; note cluster B discarded (incoherent). STOP.
Step 7: Sir replies "go" → append_learning(agent, …) + mark_episode_promoted on the 4 cited episodes.
Step 8: report — 2 clusters (1 discarded), 1 candidate, 1 passed all gates, 1 appended, 4 promoted.
</example>

<example label="dropped-at-grade">
Input: /experience-synthesis
A candidate cites only 2 episodes and reads as a platitude. Gate 1 passes (citations resolve), gate 2
grade = 54 (< 70, weak evidence + low actionability). Dropped before the human; reported under
"dropped at gate 2 (grade 54)". No learning written.
</example>

<example label="dropped-at-adversarial">
Input: /experience-synthesis
A candidate clears grounding and scores 76, but red-blue-judge mode=experience lands E5 FAIL — the
cluster is thematically coincidental and the "lesson" is not actually supported across the episodes.
Verdict REVISE; one regeneration still fails to ground the central claim; dropped. Reported under
"dropped at gate 3 (E5: incoherent cluster)".
</example>
</examples>
