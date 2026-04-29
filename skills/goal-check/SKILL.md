---
name: goal-check
description: "Measure commit quality metrics against improvement targets — Fix%, reactive cleanup, rework per branch, human reviews, reverts"
argument-hint: [period] (e.g., "30d", "90d", "baseline" — default: 30d)
---

Launch the `goal-check` agent to generate a commit quality scorecard.

**Period:** `$ARGUMENTS`

Collect git and GitHub PR data across all ARC repos, calculate metrics, compare against baseline and targets, and produce the scorecard.

---

## Agent Instructions

Execute the steps below in order. Do NOT pause for confirmation at any point — run everything to completion and produce the final scorecard.

### Rule 11 Note

`collect-metrics.sh` is a pre-existing skill artifact. Its internal use of `git -C` is acceptable — Rule 11 applies to commands you construct directly, not to existing scripts you invoke. Execute the script without asking.

### Step 1 — Determine Date Range

Parse `$ARGUMENTS` to set the period:
- `30d` (default if blank): last 30 calendar days ending today
- `90d`: last 90 calendar days ending today
- `baseline`: 2026-01-01 to 2026-04-03

Compute `SINCE_DATE` and `UNTIL_DATE` in `YYYY-MM-DD` format.

### Step 2 — Collect Git Metrics

```bash
cd /Users/fulksjas/.claude/skills/goal-check && bash collect-metrics.sh <SINCE_DATE> <UNTIL_DATE>
```

### Step 3 — Collect GitHub PR Review Data

Run these 4 commands **in parallel**:

```bash
gh pr list --repo fs-webdev/arc-record-exchange --author fulksjas --state all --search "created:<SINCE_DATE>..<UNTIL_DATE>" --json number,title,additions,deletions,reviews,reviewDecision,createdAt
gh pr list --repo fs-eng/arc-record-exchange-orch-service --author fulksjas --state all --search "created:<SINCE_DATE>..<UNTIL_DATE>" --json number,title,additions,deletions,reviews,reviewDecision,createdAt
gh pr list --repo fs-eng/arc-delivery-specification-service --author fulksjas --state all --search "created:<SINCE_DATE>..<UNTIL_DATE>" --json number,title,additions,deletions,reviews,reviewDecision,createdAt
gh pr list --repo fs-eng/arc-record-exchange-global-status-service --author fulksjas --state all --search "created:<SINCE_DATE>..<UNTIL_DATE>" --json number,title,additions,deletions,reviews,reviewDecision,createdAt
```

A "large PR" has `additions + deletions > 300`. For each large PR, count human (non-bot) reviewers from the `reviews` array. The target is >= 1 human review per large PR.

### Step 4 — Read Prior Scorecard

List files in `/Users/fulksjas/Documents/DevelopmentGoalChecks/` and read the most recent `goal-check-*.md` that is NOT the current run's date. Extract the prior run's metric values for trend comparison. If no prior scorecard exists, note "first run" and compare against baseline only.

### Step 5 — Calculate Metrics

Compute these 5 metrics from the collected data:

| Metric | How to Calculate |
|---|---|
| Fix Commit % | (commits matching `^Fix` / total commits) * 100 |
| Reactive Cleanup | commits matching SonarQube, sonar, lint, prettier, checkstyle, Copilot, unused import/variable, remove unused |
| Avg Fix/Branch | group commits by ticket (ARC-####), count Fix-tagged commits per ticket that also has non-Fix commits, average the fix counts |
| Human Reviews/Large PR | (large PRs with >= 1 human reviewer) / (total large PRs) |
| Reverts | commits matching `^Revert` |

**Baseline (90 days, Jan–Apr 2026):**
| Metric | Baseline | Target |
|---|---|---|
| Fix Commit % | 48% | ≤25% |
| Reactive Cleanup | 17 (11%) | 0 |
| Avg Fix/Branch | 2–7 | ≤1 |
| Human Reviews/Large PR | 0.11 | ≥1 |
| Reverts | 2 | 0 |

### Step 6 — Classify Trend (vs. Prior Run)

Compare each metric's current value against the prior run's value (or baseline if first run). Classify into exactly one bucket:

- **Going well** — metric improved since last run, OR target already met
- **Stalled** — no meaningful change (within ±5 percentage points or ±1 absolute count)
- **Slipped** — metric regressed since last run

### Step 7 — Produce Scorecard

**CRITICAL**: The entire scorecard — metric table, trend comparison, trend summary, and observations — MUST be inside a **single code block** (triple-backtick fence). This keeps the monospace alignment intact. Do NOT put any of these sections outside the code block. Markdown headings and regular text come AFTER the closing code fence.

Use this exact template. Progress bars are exactly 14 characters (█ for filled, ░ for empty). Pad columns to align:

```
═══ Commit Quality Scorecard (<SINCE_DATE> to <UNTIL_DATE>) ═══

  Metric               Progress        Current  Target   Status  Baseline
  ─────────────────────────────────────────────────────────────────────────
  Fix Commit %         ██████████░░░░   XX%     ≤25%     ✅/⚠️    48%
  Reactive Cleanup     ██████░░░░░░░░      X      0      ⚠️/❌    17
  Avg Fix/Branch       ████░░░░░░░░░░   X.XX    ≤1       ⚠️      2-7
  Human Reviews/LgPR   █████████████░   X.XX    ≥1/PR    ✅/⚠️    ~0
  Reverts              ░░░░░░░░░░░░░░      0      0      ✅       2

  Targets Met: N/5

  Trend vs Prior Run (<prior run date range>):
    Fix%:     XX% → XX% (↓Xpp — improving/stalled/REGRESSING)
    Cleanup:  XX → XX (↓X% — improving/stalled/REGRESSING)
    Fix/Br:   X.X → X.XX (improving/stalled/REGRESSING)
    Reviews:  X.XX → X.XX (improving/stalled/target met)
    Reverts:  X → X (no change/improving/REGRESSING)

  ── Trend Summary ──────────────────────────────────
  Going well:
    • [Metric]: [1-2 sentence driver explanation]
    • [Metric]: [1-2 sentence driver explanation]

  Stalled:
    • [Metric]: [1-2 sentence explanation]

  Slipped:
    • [Metric]: [1-2 sentence explanation]

  Omit empty buckets (e.g., if nothing slipped, skip "Slipped:")

  Notable observations:
    • [observation 1]
    • [observation 2]

  Period: N days, N commits across N repos
═══════════════════════════════════════════════════════════════════
```

After the code block, include these as regular markdown:
- **Metric Detail** — per-metric breakdown with commit lists
- **Per-branch fix count table**
- **Large PR review detail table**

### Step 8 — Save Output

Save to `/Users/fulksjas/Documents/DevelopmentGoalChecks/goal-check-<UNTIL_DATE>.md`
