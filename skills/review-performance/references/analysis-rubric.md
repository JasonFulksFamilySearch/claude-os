# Analysis Rubric

How to score and prioritize proposals from `/review-performance`.

## Scoring Dimensions

Each proposal is evaluated by the `grade-proposal` skill across 5 dimensions (total 100 points). Proposals must score ≥ 70 to reach the user review queue.

### 1. Evidence Strength (30 points)

| Score | Criteria |
|---|---|
| 25-30 | 3+ distinct sessions cited with timestamps and command details |
| 18-24 | 2 distinct sessions cited |
| 10-17 | 1 session cited or evidence is hearsay (e.g., "agent seemed confused") |
| 0-9 | No specific evidence; pattern asserted without backing |

### 2. Actionability (25 points)

| Score | Criteria |
|---|---|
| 20-25 | Exact file path + exact text to add/replace + no ambiguity |
| 14-19 | File path correct, content mostly clear, minor interpretation needed |
| 7-13 | Vague target ("update CLAUDE.md somewhere") |
| 0-6 | Cannot be applied without significant decision-making |

### 3. Impact Estimate (15 points)

| Score | Criteria |
|---|---|
| 12-15 | Realistic minutes/week saved, bounded, with justification |
| 7-11 | Reasonable estimate but no justification |
| 0-6 | Wildly optimistic (>60 min/week) or unestimated |

### 4. Reversibility (15 points)

| Score | Criteria |
|---|---|
| 12-15 | Pure git revert undoes everything; no side effects |
| 7-11 | Reversible but requires coordination (e.g., deleting an auto-loaded rule) |
| 0-6 | Hard to reverse (e.g., deleting Auto Memory) |

### 5. Scope Isolation (15 points)

| Score | Criteria |
|---|---|
| 12-15 | Change targets the right scope (user vs project vs path-scoped) |
| 7-11 | Scope is broader than necessary but not harmful |
| 0-6 | Wrong scope (e.g., proposing user-level rule for project-specific issue) |

## Threshold

- **≥ 90**: Auto-recommend for application (still requires human approval)
- **70-89**: Present in review queue
- **50-69**: Present with warning "weak signal; consider waiting"
- **< 50**: Suppress; revise in next reflection cycle

## Sentiment-to-Action Mapping

When a proposal is triggered by blocked-command analysis:

| Agent Sentiment | Suggested Action |
|---|---|
| `apologetic` | UPDATE_RULE_RATIONALE — strengthen the "why" so agent believes in the rule |
| `confused` | CLAUDE_MD_REFINEMENT — clarify rule text or add examples |
| `compliant` | No action — rule is working as designed |
| `frustrated` | RULE_RELAXATION — consider adding an exception |

## Stale Rule Decision Matrix

For STALE_RULE_REVIEW proposals:

| Rule type | 60 days no triggers | Action |
|---|---|---|
| Enforced rule (blocks commands) | Yes | Propose DELETE_RULE |
| Passive context rule (e.g., "we use TypeScript") | Yes | Keep — explain in proposal that low signal is expected |
| Aspirational rule (e.g., "always write tests") | Yes | Investigate compliance another way; do not delete |

## Cross-Repository Pattern Strength

| # of repos affected | Recommended scope |
|---|---|
| 1 | Project-level rule (`<repo>/.claude/rules/`) |
| 2-3 | Project-level rule in each, OR user-level if pattern is universal |
| 4+ | User-level rule (`~/.claude/CLAUDE.md`) |

Always prefer narrower scope when in doubt.
