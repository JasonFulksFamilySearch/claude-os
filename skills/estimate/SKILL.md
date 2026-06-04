---
name: estimate
description: Produce a calibrated TIME estimate (hours) for a work item (e.g. a Jira ticket) using a reference-class + three-point (PERT) + 85th-percentile method, calibrated to the user's OWN logged history, then optionally write it to the tracker. Use when the user says "estimate this", "how long will <KEY> take", "size this ticket", "what's the estimate for", or invokes /estimate <KEY>. Confirms before every write — never auto-writes.
---

<role>
You are the estimation layer. You turn a work item into a defensible TIME estimate
by taking the OUTSIDE view first (the user's own logged history), scoring complexity
to set the uncertainty spread, computing a three-point (PERT) range, and committing
at the 85th percentile. You never write an estimate to a tracker without explicit
per-item confirmation. You teach the breakdown; you do not just emit a number.
</role>

<task>
**What:** Given a work item, compute a calibrated p85 time estimate and, on
confirmation, write it to the tracker's estimate field.

**Why:** Gut-feel estimates are dominated by the planning fallacy (Kahneman) and
systematic underestimation (Jørgensen). Anchoring on the user's own logged actuals
(reference-class forecasting, Flyvbjerg) and committing at a percentile is the
evidence-backed fix. The unit (hours vs points) does not drive accuracy; the
process does.

**Hard constraints:**
- HOURS only. Round the commit UP to the nearest 0.5h, never down.
- CONFIRM before each write. Never auto-write. Show the full breakdown first.
- Spikes are time-boxed, not effort-estimated.
- Stories are estimated as Σ sub-tasks; set only the parent's non-sub-task closeout
  on the parent so tracker rollups don't double-count.
</task>

## Calibration is machine-local — load the profile first

This skill is the shared, universal METHOD. The NUMBERS are per-machine and live in
a calibration profile at **`~/.claude-data/context/estimation.md`** (machine-local;
NOT synced between agents — one agent's history must not calibrate another's).

**Step 0 — load the profile.** `Read ~/.claude-data/context/estimation.md`. It supplies:
- the **baseline table** (per work-item type: p50/p85 in hours, n, confidence),
- the **type → M₀ anchor** map,
- **stack-tuned factor exemplars** (what Low/Med/High looks like in this codebase),
- the **regression fixture** (a known item the engine must reproduce),
- the **tracker config** (which tracker, how to fetch/write the estimate field).

**If no profile exists** (e.g. a fresh machine): do NOT guess baselines. Offer to
**bootstrap** one — pull the user's last ~60 days of logged actuals from their
tracker, compute per-type p50/p85 (nearest-rank; flag any type with n<30 as a
low-confidence range), and write a starter profile. If the user declines, run a
single **uncalibrated** estimate using anchors they provide, and do not write a
profile.

## Method (universal — this is the shared part)

### 1. Classify & pull the reference class
Identify the work-item type → pull its M₀ anchor from the profile.
- **Spike** → time-box (don't compute O/M/P); cap per the profile (default 1d).
- **Story** → estimate each sub-task and sum; the story's own estimate is only its
  non-sub-task closeout.

### 2. Complexity scorecard (sets the spread, not the estimate)
Score 7 generic factors 1 (Low) / 2 (Med) / 3 (High). Use the profile's exemplars
to anchor each level to the local codebase/stack:
1. Scope / size · 2. Technical complexity · 3. Unknowns / uncertainty ·
4. Dependencies · 5. Testing burden · 6. Code-area familiarity ·
7. Coordination / review.
Present inferred scores from the item's description and ask the user to confirm/adjust.

**Sum (7–21) → tier** (sets where M sits vs M₀ and how wide O–P opens):
- 7–9 Low → M ≈ M₀; band tight.
- 10–13 Moderate → M ≈ M₀ ×1.5–2; band medium.
- 14–17 Complex → M ≈ M₀ ×3–4; band wide (P → historical tail).
- 18–21 Very complex → **split the item**; spike first. Don't estimate as one.

### 3. Three-point (PERT)
M = tier-scaled most-likely; O = best case; P = worst case (push toward/past the
historical tail when the scorecard is high).
**E = (O + 4M + P)/6** ; **SD = (P − O)/6**.

### 4. Commit at the 85th percentile
**commit = E + SD**, then **round UP to nearest 0.5h** (never down — rounding down
shaves the safety margin the p85 commit exists to protect). Overhead is already in
the actuals, so no extra pad. Report O/M/P, E, SD, exact E+SD, and the rounded commit.
Multi-item forecast: sum E's, sum variances (SD² add), commit at ΣE + √ΣSD², round up.

### 5. Present, confirm, write
Show the breakdown (scorecard sum + tier, O/M/P, E±SD, commit, one-line rationale).
Ask to write `<commit>` to the item's estimate field. Default is NO. Only on an
explicit yes, write via the profile's tracker config. Confirm the new value back.

### Recalibrate (close the loop)
After each item, log estimate vs actual + scorecard sum to the profile. Monthly:
bias factor = `median(actual/estimate)` (>1 ⇒ optimistic, multiply future M by it);
refresh baselines from the latest ~60-day pull; tune factor weights.
**Upgrade path:** at 100+ uniform cycle-time samples per type, swap the
scorecard-driven three-point for a direct Monte-Carlo p85 forecast.

## Verify when the engine logic changes
Run the profile's regression fixture: feed the engine its inputs and confirm the
rounded commit matches the profile's expected value. If not, the engine is
miscalibrated — fix before estimating live items.

## Tracker integration
Defined by the profile. For a **Jira** profile, use the `jira` skill reference
(cloudId, fields), fetch-first with `getJiraIssue`, and write
`{ timetracking: { originalEstimate: "<e.g. 6h 30m>" } }` via `editJiraIssue`. For a
story+sub-task pair, set the sub-task and the parent's own closeout separately.

## Reversibility
- Read-only (safe): reading the profile, fetching the item, computing the estimate.
- Write (requires explicit per-item confirmation): writing the estimate field;
  bootstrapping/updating the local profile.

## Success criteria
- Estimate in hours, committed at p85, rounded up.
- Breakdown shown before any write; no write without an explicit yes for that item.
- Numbers come from the machine-local profile, never hardcoded in this shared skill.
- The profile's fixture reproduces its expected value.
