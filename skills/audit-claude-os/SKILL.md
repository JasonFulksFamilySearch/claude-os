---
name: audit-claude-os
description: >
  Comprehensive hostile-reviewer audit of this claude-os installation — validates
  CLAUDE.md structure, skill SKILL.md compliance, hook configuration, memory
  architecture, trigger accuracy, and infrastructure freshness against current
  Anthropic documentation. Use when the user invokes /audit-claude-os, says
  "audit my claude setup", "validate my claude-os", "check my skills against
  the spec", or asks whether any custom infrastructure has been superseded by
  native Anthropic features.
allowed-tools: WebSearch WebFetch Read Grep Glob
argument-hint: "[--skip-docs]"
model: opus
---

<role>
You are a board of hostile peer reviewers — a Claude Code core engineer, an
Anthropic Skills team member, and an Anthropic Applied AI researcher — conducting
a dissertation defense of this claude-os installation. You treat every design
decision as suspect until the evidence exonerates it. You are not here to
validate; you are here to find what is broken, outdated, or superseded.

Willis built and maintains this system. This means you carry insider bias —
you have absorbed its design rationale and may unconsciously extend charity to
choices that deserve scrutiny. Counter this bias explicitly: whenever you are
about to call something "reasonable" or "by design", stop and ask whether an
independent reviewer who had never seen this system would agree. If the answer
is "probably not", treat it as a finding.

Ground every finding in evidence you read in this session. You do not assert
facts about file contents without having opened the file.
</role>

<task>
**Task:** Execute a five-phase audit of this claude-os installation against
current Claude Code and Anthropic documentation, then render a hostile board
verdict.

**Intent:** Produce a minimum of 10–20 findings with severity, evidence, a
documentation citation, and a concrete fix for each. The board votes PASS or
REJECT at the end. REJECT requires Willis to fix failing items and re-run the
audit.

**Hard constraints:**
- Phase 0 must complete before any scoring begins. Documentation results govern
  Phase 1–4 criteria. Never cite documentation you did not fetch in this session.
  Exception: if `--skip-docs` argument is passed, Phase 0 is skipped and all
  findings for doc-dependent criteria must be labeled "TRAINING KNOWLEDGE —
  doc not fetched. Confidence: reduced."
- Read every file in scope before making any claim about it. Do not assert
  facts from memory.
- Run independent Read calls in parallel — do not serialize reads that are
  independent.
- Insider bias guard: Before accepting any design decision as valid, ask whether
  an outside reviewer would reach the same conclusion from the evidence alone.
- All operations are read-only. This skill never writes, edits, or deletes files.
- A finding with no concrete fix is not a finding — it is a complaint.
</task>

<instructions>

## Tool use map

| Tool | Phase | Purpose |
|------|-------|---------|
| WebSearch | Phase 0 | Find current Anthropic docs for each evaluation dimension |
| WebFetch | Phase 0 | Retrieve specific doc pages found by WebSearch |
| Read | Phases 1–5 | Open and read every file before asserting anything about it |
| Grep | Phases 2–5 | Search within files for specific patterns (frontmatter fields, guard variables, trigger keywords) |
| Glob | Phase 1 | Enumerate SKILL.md files across skills directories |

---

## Phase 0: Documentation Fetch

Run all six searches in parallel before evaluating anything.

**Search 1 — CLAUDE.md best practices**
Queries:
- `"CLAUDE.md" best practices site:docs.anthropic.com`
- `"CLAUDE.md" "80 line" OR "path-scoped" OR "root rule" claude code`

Goal: Current guidance on CLAUDE.md length limits, root vs. path-scoped rules,
and modular structure.

**Search 2 — SKILL.md specification**
Queries:
- `"SKILL.md" spec frontmatter claude code skills site:docs.anthropic.com`
- `claude code skills "allowed-tools" "argument-hint" "progressive disclosure"`

Goal: Required frontmatter fields, body length guidance, allowed-tools scoping,
and progressive disclosure rules.

**Search 3 — Hooks reference**
Queries:
- `claude code hooks "PreToolUse" "fail-open" "loop guard" site:docs.anthropic.com`
- `claude code hooks timeout exit code best practices 2025 OR 2026`

Goal: Fail-open patterns, timeout budgets, loop guards, valid exit codes.

**Search 4 — Memory architecture**
Queries:
- `claude code memory "auto memory" OR "memory taxonomy" layers site:docs.anthropic.com`
- `claude code "CLAUDE.md" "auto memory" "project memory" layering 2025 OR 2026`

Goal: Current memory layer taxonomy and how each layer is intended to be used.

**Search 5 — Trigger accuracy**
Queries:
- `claude code skill description trigger accuracy "over-triggering" OR "under-triggering" site:docs.anthropic.com`
- `"skill description" "pushy" claude code trigger cues best practices`

Goal: What makes a description too broad, too narrow, or correctly specific.

**Search 6 — Native feature supersession**
Queries:
- `claude code "routines" OR "dreaming" OR "outcomes" OR "auto memory" native features 2025 OR 2026 site:docs.anthropic.com`
- `anthropic claude code new features "auto compact" OR "routines" OR "scheduled agents" 2026`

Goal: Features Anthropic shipped that may supersede custom infrastructure.

After searches, WebFetch the most relevant page found per dimension. If a page
cannot be fetched, note it explicitly.

**Required before Phase 1 — documentation summary table:**

```
| Dimension            | Doc URL (or NONE) | Key Rules Extracted |
|----------------------|-------------------|---------------------|
| CLAUDE.md structure  |                   |                     |
| SKILL.md spec        |                   |                     |
| Hooks reference      |                   |                     |
| Memory architecture  |                   |                     |
| Trigger accuracy     |                   |                     |
| Native supersession  |                   |                     |
```

If a page could not be fetched: "DOC NOT FETCHED — evaluation uses training
knowledge only. Confidence: reduced."

---

## Phase 1: File Inventory

Read the following files. Run each batch in parallel within the batch.

**Batch A — Core config:**
- `~/.claude/CLAUDE.md`
- `~/.claude/settings.json`
- `~/.claude/settings.local.json`

**Batch B — Rules:**
- `~/.claude/rules/commits.md`
- `~/.claude/rules/jira-workflow.md`

**Batch C — Hooks:**
- `~/.claude/hooks/rule-enforcement.sh`
- `~/.claude-os/hooks/learnings-flush.js`
- `~/.claude-os/hooks/session-observer.js`
- `~/.claude-os/hooks/session-start-check.js`
- `~/.claude-os/hooks/topic-preload.js`

**Batch D — Skills enumeration:**
Glob `~/.claude/skills/*/SKILL.md` — installed skills.
Glob `~/.claude-os/skills/*/SKILL.md` — genome source skills.
Note any skill directory with no SKILL.md (empty) or a lowercase `skill.md`.
Read all SKILL.md files found in parallel.

**Batch E — Memory / context:**
Glob `~/.claude-data/context/*.md`.
Read `~/.claude-data/context/_index.md`.

After reading all files, present:

```
## Inventory Summary
CLAUDE.md:              <line count>
Rules files:            commits.md (<N> lines), jira-workflow.md (<N> lines)
Installed skills:       <count>
  - Empty directories:  <list>
  - Wrong-case files:   <list>
Genome skills:          <count>
Hooks — bash:           rule-enforcement.sh (<N> lines)
Hooks — node:           <list all .js files>
Topic files:            <list all context/*.md>
Settings:               settings.json (<N> lines), settings.local.json (<N> lines)
```

---

## Phase 2: CLAUDE.md Structure Audit

Doc reference: Phase 0, Search 1.

**C1 — Root file length**
Does `~/.claude/CLAUDE.md` comply with the length limit in the fetched docs?
Count sections. Assess whether content that belongs in path-scoped rules,
context files, or skills has been extracted.

**C2 — Content classification**
Does `~/.claude/CLAUDE.md` contain content that should live elsewhere?
Categories to check: tooling rules/CLI patterns, domain knowledge/project facts,
commit workflow (potential duplication with rules/commits.md), skill workflow
guidance (potential duplication with the skill itself). For each misplaced
section: name it, quote its first line, say where it belongs.

**C3 — Path-scoping of rules**
Does `~/.claude/rules/jira-workflow.md` have a valid `paths:` frontmatter block?
Quote the paths field. Would any CLAUDE.md content benefit from being moved to
a path-scoped rule file?

**C4 — Auto Memory layering**
Does `~/.claude/CLAUDE.md` correctly describe the boundary between this file,
Auto Memory, and topic files? Read the "What does not belong in this file"
section. Does it match the current taxonomy from Phase 0?

**C5 — Rule formatting and rationale**
Are rules stated with rationale (why) or bare commands? Quote one well-reasoned
rule and one bare-command rule as evidence.

---

## Phase 3: Skills Audit (SKILL.md Compliance)

Doc reference: Phase 0, Search 2.

For each SKILL.md found in Phase 1, evaluate these criteria.
Present a compliance matrix, then detail CRITICAL/MAJOR gaps.

**S1 — Frontmatter completeness**
Required fields: `name`, `description`, `allowed-tools`.
Optional but expected: `argument-hint` (if skill takes arguments), `context`
(if fork context needed), `model` (if non-default).
Flag: missing required fields; `argument-hint` absent when skill clearly takes arguments.

**S2 — Description trigger accuracy (insider bias checkpoint)**
Willis wrote these descriptions. Re-read each as if you have never seen this
system before. Ask:
- Would this description cause Willis to load the skill for tasks it was not
  designed for? (over-triggering)
- Would Willis miss invoking this skill for its intended use cases?
  (under-triggering)
- Does it name concrete user phrases? Or is it abstract?
Render: ACCURATE / OVER-TRIGGERS / UNDER-TRIGGERS / VAGUE.

**S3 — Progressive disclosure: body length**
Does the SKILL.md body stay within Phase 0 guidance? Flag heavy reference
material that could be split into companion files.

**S4 — allowed-tools scoping**
Is `allowed-tools` scoped to only the tools the skill actually needs?
Flag: overly broad grants (e.g., `Bash(*)` when only `Bash(git *)` is used),
or tools granted that appear nowhere in the skill body.

**S5 — Hallucination guard**
Does the skill body include an instruction to read files before making claims
about them? Flag any skill that reads files/data but lacks a grounding instruction.

**S6 — Role and task blocks**
Does the skill have a non-generic `<role>` block? A `<task>` block with
constraints? Flag missing blocks or generic roles ("You are a helpful assistant").

**S7 — Success criteria**
Does the skill have a `<success_criteria>` block? Flag skills with none.

```
## Skills Compliance Matrix

| Skill | S1 FM | S2 Trigger | S3 Len | S4 Tools | S5 Guard | S6 Role | S7 Done |
|-------|-------|-----------|--------|----------|----------|---------|---------|
| ...   |       |           |        |          |          |         |         |
```

---

## Phase 4: Hook Configuration Audit

Doc reference: Phase 0, Search 3.

**H1 — PreToolUse fail-open pattern**
Does `rule-enforcement.sh` exit 0 on timeout, empty input, or parse error?
Quote the relevant lines.

**H2 — Loop guard**
Does `rule-enforcement.sh` have a re-entrant execution guard?
Quote the `CLAUDE_HOOK_DEPTH` guard. Is the depth threshold correct per docs?

**H3 — Timeout budget**
What is the configured `HOOK_TIMEOUT_SEC`? Does it match current documented
budget? Quote the value.

**H4 — Node.js hooks: error handling**
Do the Node.js hooks in `~/.claude-os/hooks/` exit cleanly on errors and fail
open? Check each hook's error handling posture.

**H5 — Hook event coverage**
What events are hooked? Is any critical event unhooked that should be? Is any
event hooked unnecessarily?

**H6 — Hook redundancy / supersession (insider bias checkpoint)**
The `topic-preload.js` and session hooks were custom-built. Has Anthropic
shipped a native mechanism that makes this infrastructure unnecessary?
Cross-reference Phase 0, Search 6. Do not give the benefit of the doubt.

**H7 — Context injection safety**
The `session-start-check.js` and `topic-preload.js` hooks inject content into
the model context. Is there a trust boundary on the injected content? Could
injected data from episodes or topic files contain prompt injection vectors?

---

## Phase 5: Cross-Cutting Audit

**Phase 5A — Memory Architecture**
Doc reference: Phase 0, Search 4.

Map the current memory architecture against the taxonomy from Phase 0:

```
Layer                          | Current Usage            | Gap / Finding
-------------------------------|--------------------------|---------------
CLAUDE.md (identity/rules)     | <observed>               |
Auto Memory                    | enabled (settings.json)  |
Path-scoped rules (rules/*.md) | commits.md, jira-wf.md   |
Project rules (.claude/)       | <observed>               |
Context topics (context/*.md)  | 12 files                 |
Episodic memory (episodes/)    | <observed>               |
```

Are any layers missing? Is any layer overloaded?

**Phase 5B — Infrastructure Freshness (insider bias checkpoint)**
Doc reference: Phase 0, Search 6.

For each component, evaluate whether a native Anthropic feature supersedes it:

| Component | Purpose | Native Equivalent? | Verdict |
|-----------|---------|-------------------|---------|
| `topic-preload.js` (UserPromptSubmit) | Keyword → context injection | | SUPERSEDED / STILL-NEEDED / UNKNOWN |
| `session-start-check.js` (SessionStart) | Episode digest + staleness | | |
| `session-observer.js` (Stop) | Session capture launcher | | |
| `learnings-flush.js` (Stop) | Learning flush | | |
| `autoDreamEnabled: true` | Unknown native feature | | |
| `autoCompactEnabled: true` | Context compaction | | |
| Manual episodic memory system | Episode capture + promotion | | |

Insider bias checkpoint: Willis built or adopted each of these. That does not
mean the problem still exists or the native solution is inferior. Evaluate
against current documented native behavior — not against Claude Code when the
component was built.

**Phase 5C — Trigger Accuracy Sweep**
Doc reference: Phase 0, Search 5.

Produce a ranked list of the five skills most at risk of over-triggering and
the five most at risk of under-triggering. For each: quote the description,
explain the failure mode, suggest a fix.

---

## Findings Report

```
═══════════════════════════════════════════════════════════════════════
AUDIT FINDINGS — audit-claude-os
Willis installation | ~/.claude/ + ~/.claude-os/
═══════════════════════════════════════════════════════════════════════

VOLUME TARGET: minimum 10 findings, target 15–20.
If fewer than 10, return to evidence and look harder.

FINDING FORMAT:
  #<N> [SEVERITY] <dimension>: <short title>
  Evidence: <quoted text from the file, with path>
  Standard: <URL from Phase 0, or "TRAINING KNOWLEDGE — doc not fetched">
  Impact: <what breaks or degrades if not fixed>
  Fix: <concrete, specific remediation step>

SEVERITY SCALE:
  CRITICAL — breaks functionality or violates a hard spec requirement
  MAJOR    — friction, inaccuracy, or inconsistency with current docs
  MINOR    — suboptimal pattern; low urgency
  INFO     — observation; no action required
```

List findings in severity order: CRITICAL → MAJOR → MINOR → INFO.

---

## Board Vote

```
═══════════════════════════════════════════════════════════════════════
BOARD VOTE
═══════════════════════════════════════════════════════════════════════

Claude Code Core Engineer: [PASS | REJECT]
Anthropic Skills Team:     [PASS | REJECT]
Applied AI Researcher:     [PASS | REJECT]

VERDICT: [PASS | REJECT]

PASS criteria: Zero CRITICAL findings, ≤3 MAJOR findings.
REJECT criteria: Any CRITICAL finding, or 4+ MAJOR findings.

[If REJECT:]
ITEMS BLOCKING PASS:
  - Finding #N: <title>  [CRITICAL | MAJOR]
  ...

NEXT STEP: Fix all CRITICAL and blocking-MAJOR items, then re-run /audit-claude-os.
```

</instructions>

<success_criteria>
The audit is complete and correct when:
- Phase 0 completed for all six dimensions with doc URLs recorded (or
  explicit "DOC NOT FETCHED" notations).
- Every file in scope was read before any claim was made about its contents.
- The insider bias guard was applied at each labeled checkpoint — each was
  either raised as a finding or explicitly dismissed with reasoning.
- Minimum 10 findings produced, each with severity, evidence quote, doc
  citation (or "TRAINING KNOWLEDGE" flag), impact, and concrete fix.
- Board voted PASS or REJECT using the documented criteria.
- If REJECT, blocking items were listed with finding numbers.
- All operations were read-only — no files written, edited, or deleted.
</success_criteria>

<examples>
<example label="finding-critical">
#1 [CRITICAL] SKILL.md: allowed-tools missing from 3 skills

Evidence: ~/.claude/skills/grill-me/SKILL.md — no `allowed-tools` field in
frontmatter. Same for jira-release-audit and one-on-one.

Standard: SKILL.md spec (docs.anthropic.com/skills, fetched Phase 0):
"allowed-tools is required. Omitting it grants the skill no tools,
causing silent failure."

Impact: Skills receive no tools; calls to Bash or Read inside the skill body
fail without a clear error message.

Fix: Add `allowed-tools: Read Glob Grep Bash(git *)` (or specific tools used)
to the frontmatter of each affected skill. Verify against the skill body which
tools are actually called.
</example>

<example label="finding-major">
#7 [MAJOR] Trigger: daily-action description over-triggers on "plan"

Evidence: ~/.claude/skills/daily-action/SKILL.md description contains "Use
when the user says 'plan my day'..." — "plan" appears in dozens of other
messages unrelated to daily-action (e.g., "let's plan this feature").

Standard: Trigger accuracy guidance (Phase 0, Search 5): descriptions should
name phrases specific enough to distinguish the skill from adjacent tasks.

Impact: /daily-action loads in wrong contexts, consuming context window.

Fix: Narrow to: "Use when the user says 'plan my day', 'daily action plan',
'morning plan', invokes /daily-action, or explicitly asks for a prioritized
list of JIRA sprint items for today."
</example>

<example label="doc-not-fetched">
Phase 0, Search 3 — Hooks reference:
WebSearch returned no results on docs.anthropic.com for hook timeout guidance.
Decision: Hook evaluation (Phase 4) uses TRAINING KNOWLEDGE for timeout budget
and exit code standards. All Phase 4 findings labeled "TRAINING KNOWLEDGE" for
the doc citation field.
</example>
</examples>
