---
name: goal-check
description: "Measure commit quality metrics against improvement targets — Fix%, reactive cleanup, rework per branch, human reviews, reverts. Use when the user invokes /goal-check."
model: sonnet
tools: Read, Glob, Grep, Bash, Write
memory: user
---

# Commit Quality Scorecard

You are generating a commit quality scorecard that measures progress against Jason's Q2 2026 performance goal: **reduce pre-merge rework by implementing local quality validation on every commit.**

The scorecard compares current metrics against a frozen baseline (Jan–Mar 2026) and target values.

## Baseline Constants (Jan 1 – Apr 3, 2026 — 90 days)

These are frozen and must never be recomputed:

| Metric | Baseline Value |
|---|---|
| Total commits | 155 |
| Fix commit % | 48% (74 of 155) |
| Reactive cleanup commits | 17 (11%) |
| Avg corrective commits per feature branch | 2–7 |
| Human review comments per PR (>300 lines) | ~0 |
| Reverts | 2 |

## Target Constants

| Metric | Target | Goal Met |
|---|---|---|
| Fix commit % | ≤25% | ✅ |
| Reactive cleanup commits | 0 per period | ✅ |
| Avg corrective commits per feature branch | ≤1 | ✅ |
| Human reviews on PRs >300 lines | ≥1 per PR | ✅ |
| Reverts | 0 | ✅ |

## Command Restrictions (MANDATORY)

- **NEVER** use `cat`, `head`, `tail`, `grep`, `rg`, `awk`, `sed`, `find` as Bash commands.
- **NEVER** use `git -C <path>`. The helper script handles repo navigation.
- **NEVER** use `node -e` with multi-line code. Write to `_tmp_analysis.js` if needed.
- **NEVER** pipe output through `head`, `tail`, `grep`, `python3`, or `awk`.

## Input

**Period argument:** Extract from the user's prompt.
- `30d` (default if no argument) → last 30 days
- `90d` → last 90 days
- `YYYY-MM-DD to YYYY-MM-DD` → explicit date range
- `baseline` → Jan 1 to Apr 3, 2026 (should reproduce baseline numbers as a sanity check)

Use `date` command to resolve relative periods to absolute `YYYY-MM-DD` dates.

## Step 1: Determine Date Range

Run:
```bash
date +%Y-%m-%d
```

Compute `SINCE_DATE` and `UNTIL_DATE` based on the period argument.

## Step 2: Collect Git Metrics (PARALLEL)

Run **both in parallel:**

**Git data via helper script:**
```bash
bash ~/.claude/skills/goal-check/collect-metrics.sh <SINCE_DATE> <UNTIL_DATE>
```

**GitHub PR data across all repos:**

For each of these repos, run `gh pr list` (all 4 can be parallel):
- `fs-webdev/arc-record-exchange`
- `fs-eng/arc-record-exchange-orch-service`
- `fs-eng/arc-delivery-specification-service`
- `fs-eng/arc-record-exchange-global-status-service`

```bash
gh pr list --repo <owner/repo> --author JasonFulksFamilySearch --state merged --search "created:>=<SINCE_DATE> created:<=<UNTIL_DATE>" --json number,title,additions,deletions,comments,reviewDecision --limit 100
```

For PRs with >300 lines changed (additions + deletions), check for human review comments:
```bash
gh pr view <number> --repo <owner/repo> --json reviews --jq '.reviews[] | select(.author.login != "copilot-pull-request-reviewer" and .author.login != "github-actions") | .author.login'
```

## Step 3: Calculate Metrics

From the helper script output, extract per-repo counts, then aggregate:

### Metric 1: Fix Commit %
- Count commits where the subject starts with `Fix:` or `Fix!:`
- Calculate: `fix_count / total_count * 100`

### Metric 2: Reactive Cleanup Commits
- Count commits matching ANY of these patterns (case-insensitive):
  - `SonarQube` or `sonar`
  - `lint` (but not `splint` or similar false positives)
  - `prettier`
  - `checkstyle`
  - `Copilot` (in context of "Address Copilot", "Copilot review", "Copilot feedback")
  - `unused import` or `unused variable` or `remove unused`
- These are a subset of Fix commits — count them separately

### Metric 3: Avg Corrective Commits per Feature Branch
- Group commits by ticket ID (extract `ARC-####` or `ARCPORT24-####` from commit subject)
- For each ticket with ≥1 Feat/Perf/Refactor commit, count the Fix commits on that same ticket
- Calculate average Fix commits per ticket
- Exclude tickets that are ONLY Fix commits (standalone bug fixes, not feature rework)

### Metric 4: Human Reviews on Large PRs
- Filter PRs where `additions + deletions > 300`
- For each, check if any non-bot reviewer left comments
- Calculate: PRs with human review / total large PRs

### Metric 5: Reverts
- Count commits where subject starts with `Revert` or `Revert:`

## Step 4: Render Scorecard

Generate the scorecard using this exact format:

```
═══ Commit Quality Scorecard (<SINCE_DATE> to <UNTIL_DATE>) ═══

  Metric               Progress        Current  Target   Status  Baseline
  ─────────────────────────────────────────────────────────────────────────
  Fix Commit %         ██████░░░░░░░░   32%     ≤25%     ⚠️      48%
  Reactive Cleanup     █░░░░░░░░░░░░░    2      0        ⚠️      17
  Avg Fix/Branch       ██░░░░░░░░░░░░   1.8     ≤1       ⚠️      2-7
  Human Reviews/LgPR   ████████░░░░░░   0.8     ≥1/PR    ⚠️      ~0
  Reverts              ░░░░░░░░░░░░░░    0      0        ✅      2

  Targets Met: 1/5

  Trend vs Baseline (Jan–Mar 2026):
    Fix%:     48% → 32% (↓16pp — improving)
    Cleanup:  17 → 2 (↓88% — improving)
    ...

  Period: <N> days, <total> commits across <repo_count> repos
═══════════════════════════════════════════════════════════════════
```

**Progress bar rules:**
- Bar is 14 chars wide
- For "lower is better" metrics (Fix%, Cleanup, Fix/Branch, Reverts): fill = `current / baseline` ratio (shows how far you've come from baseline toward zero)
- For "higher is better" metrics (Human Reviews): fill = `current / target` ratio
- Status: ✅ if target met, ⚠️ if improved vs baseline but target not met, ❌ if worse than baseline

## Step 5: Save and Present

1. Save scorecard to `/Users/fulksjas/Documents/DevelopmentGoalChecks/goal-check-<YYYY-MM-DD>.md`
2. Display the scorecard directly in the terminal
3. If any metric is ❌ (worse than baseline), call it out with a brief note on what happened
4. If all metrics are ✅, celebrate

## Notes

- If a repo is unreachable or `gh` is not authenticated, skip it and note the gap.
- The helper script handles parallel repo queries. Do not duplicate that work.
- Commit messages follow conventional commit format: `Tag: description (TICKET)` or `Tag!: description (TICKET)`.
- Author matching: `fulksjas`, `Jason Fulks`, `jason.fulks`, `JasonMFulks`.
- GitHub username: `JasonFulksFamilySearch`.
