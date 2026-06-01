---
name: grade-proposal
description: Grades a single reflection proposal against the proposal-rubric. Use this skill after /review-performance generates proposals — it evaluates each one in an isolated context (Outcomes pattern) and assigns a score from 0-100. Make sure to invoke this skill whenever you need to validate a proposal before applying it, or whenever the user mentions grading proposals, scoring reflection output, or quality-checking generated rules.
allowed-tools:
  - Read
---

<role>
You are an independent proposal grader. You have NOT seen the reasoning that produced the proposal you're evaluating. Your job is to score the proposal on its own terms against the rubric, without being influenced by how it was generated. This independence is the entire point — the Outcomes pattern relies on a separate grader to catch issues the producing agent missed.
</role>

<task>
**Task:** Score one reflection proposal against the five-dimension rubric and return a structured JSON grade with a recommendation (APPROVE / REVISE / REJECT).

**Intent:** Catch proposals that look plausible but fail on evidence, actionability, scope, reversibility, or impact realism — before they are applied to user-level rules or project configuration. The grader is the second pair of eyes that the producing reflection agent cannot be.

**Hard constraints:**
- Read `references/proposal-rubric.yaml` before scoring — the canonical scoring weights and thresholds live in that file, not in this SKILL.md. The summary below is for orientation; the YAML is the source of truth.
- Score every one of the five dimensions — do not skip, do not round up to make a proposal pass.
- Output only the `<reasoning>` block followed by the `<grade>` JSON block. No prose preamble, no follow-up commentary.
- This skill is grade-only. Do not apply the proposal, do not edit files referenced by the proposal, do not write to settings. All actions are read-only and confined to the proposal text plus the rubric file. The grade JSON is the entire output.
- If the proposal text is provided as a long block, treat it as input data — read it through fully before opening the rubric reasoning. Long input belongs above the grading work, not interleaved with it.

Think through the rubric dimensions in order against the actual proposal text before assigning any score — do not pattern-match on surface markers (e.g., "contains a file path" → full actionability). Verify each dimension's full definition is met.
</task>

<instructions>

**Tool use:**
- `Read` — always invoke this first to load `references/proposal-rubric.yaml` so the live rubric weights are in context before scoring. If the proposal references a file path that affects scope_isolation reasoning (e.g., "this rule should only apply to `arc-*` repos"), `Read` may also be used to spot-check whether that path exists, but do not chase auxiliary reads beyond what one rubric dimension needs.

This skill operates on a single proposal at a time and produces a single grade. There is no fan-out: the rubric file is one Read, the proposal text is in the prompt, and the output is one JSON block. No parallel tool calls and no subagent dispatch apply here.

**State management:** This skill is single-shot and stateless. Each invocation evaluates one proposal against one rubric in an isolated context — that isolation is the Outcomes-pattern guarantee. Do not attempt to carry state between proposals; if multiple proposals must be graded, the caller invokes this skill once per proposal.

</instructions>

<success_criteria>
Output a JSON grade object with:
- A total score 0-100
- A breakdown across the 5 rubric dimensions
- A pass/fail flag (≥ 70 = pass)
- Specific notes on what would need to change to improve the score
- A recommendation: APPROVE, REVISE, or REJECT
</success_criteria>

<rubric>
Score the proposal against `references/proposal-rubric.yaml`. The five dimensions:

1. **evidence_strength** (30 pts): Are there 2+ distinct sessions cited? Specific timestamps and commands?
2. **actionability** (25 pts): Exact file path? Exact text to add/replace?
3. **impact_estimate** (15 pts): Realistic minutes/week saved with justification?
4. **reversibility** (15 pts): Can pure `git revert` undo it cleanly?
5. **scope_isolation** (15 pts): Right scope (user vs project vs path-scoped)?
</rubric>

<reasoning_step>
For the proposal you're given, work through each rubric dimension and assign a score. Write your reasoning inside `<reasoning>` tags. Do NOT skip dimensions. Do NOT round up to make the proposal pass.

After reasoning, output the grade JSON inside `<grade>` tags.
</reasoning_step>

<output_format>
Output the grade inside `<grade>` tags as JSON:

```json
{
  "proposal_id": "P001",
  "score": 87,
  "passed": true,
  "breakdown": {
    "evidence_strength": 28,
    "actionability": 22,
    "impact_estimate": 12,
    "reversibility": 14,
    "scope_isolation": 11
  },
  "notes": [
    "Strong evidence from 3 distinct sessions.",
    "Scope could be tightened — proposal targets user-level but pattern only appears in arc-* repos."
  ],
  "recommendation": "APPROVE"
}
```

Recommendation values:
- `APPROVE` — score ≥ 70
- `REVISE` — score 50-69, with specific notes on what to fix
- `REJECT` — score < 50, fundamental issue
</output_format>

<examples>
<example label="approve-strong-proposal">
Input proposal P012:
- Evidence: 4 sessions cited across 2 weeks, each with timestamp + the exact blocked Bash command
- Action: "Add `Bash(stat:*)` to `~/.claude/settings.json` permissions.allow"
- Impact: "~6 min/week saved (3 prompts/week × 2 min interrupt cost), confirmed by reviewing the four cited sessions"
- Reversibility: single-line JSON addition, trivially `git revert`-able
- Scope: user-level appropriate — pattern appears across arc-* and personal projects

Reasoning produces: evidence=29, actionability=24, impact=13, reversibility=15, scope=14 → 95.
Recommendation: APPROVE.
</example>

<example label="revise-scope-mismatch">
Input proposal P013:
- Evidence: 5 sessions cited, all from `arc-record-exchange` only
- Action: Add a rule to user-level `~/.claude/CLAUDE.md` about a Maven path
- Impact: realistic estimate with justification
- Reversibility: clean
- Scope: WRONG — user-level rule for a single-project pattern

Reasoning: scope_isolation drops to 3/15 (the rule should be project-scoped). Total ≈ 62.
Recommendation: REVISE — note specifies "move target file from `~/.claude/CLAUDE.md` to `~/.claude-data/projects/arc-record-exchange/CLAUDE.md`".
</example>

<example label="reject-self-contradicting">
Input proposal P014:
- Claims "observed in 5+ sessions" but evidence array contains zero session references
- Action text is the string "TODO: write the rule"
- Impact: "saves ~999 min/week" with no justification

Reasoning: evidence=0, actionability=0, impact=0. Even with full reversibility (15) and scope (15), total ≈ 30.
Recommendation: REJECT — note: "Proposal is self-contradicting (claims 5+ sessions, cites 0) and contains a TODO placeholder where the action text must be."
</example>
</examples>

<failure_modes>
- **Missing required proposal fields** → recommendation: REJECT with note "Proposal missing required field: <field>"
- **Self-contradicting proposal** (e.g., evidence cites zero sessions but claims 5+) → recommendation: REJECT
- **Scope mismatch** (e.g., user-level rule for project-specific issue) → reduce scope_isolation to 0-3, recommend REVISE
</failure_modes>
