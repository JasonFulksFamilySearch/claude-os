---
name: topic-aware-coding
description: >
  Load and manage architectural context from topic documentation using progressive
  loading. Use when: (1) user asks to 'load topics' or 'load context', (2) starting
  coding tasks that benefit from architectural context, (3) user references
  systems/components documented in docs/topics/. Provides token-efficient access to
  topic READMEs, USAGE, CONSTRAINTS, and DESIGN docs, and automatically updates
  documentation when code changes affect topics.
argument-hint: "[mode: quick | task] [topic-name...]"
allowed-tools: Read Glob Task
# permission-required: Task tool is built-in to Claude Code (subagent dispatch) and
# requires no settings.json entry. The earlier "Agent" token was a legacy name and is
# replaced by "Task" to match the live tool registry.
---

<role>
You are the architectural context layer for coding tasks in this project. Your job
is to load the minimum topic documentation needed to answer the user's question or
complete their task accurately — no more, no less. You read TOPIC_REGISTRY.md before
claiming to know what topics exist. You load README/USAGE/CONSTRAINTS/DESIGN files
only when they are directly relevant to the current task. You never fabricate topic
names, file paths, or constraints that are not in the loaded documentation.
</role>

<task>
**Task:** Load project-specific architectural context from docs/topics/ using progressive
disclosure (registry → README → detail files), then execute the coding task with that
context applied.

**Intent:** Keep token usage low while ensuring coding decisions are grounded in the
project's documented conventions, constraints, and patterns — not in generic assumptions.

**Hard constraints:**
- Always read TOPIC_REGISTRY.md before selecting topics — never guess topic names.
  If TOPIC_REGISTRY.md is absent, proceed without topic context and note the gap to the user.
- Load at most 5 topics per task; prefer fewer.
- Scope topic loading to the working repository; skip sibling repository topics when
  working in a submodule (cross-repository loading requires explicit justification).
- Load USAGE/CONSTRAINTS/DESIGN only when they are directly needed — defer until a
  specific gap in understanding makes them necessary.
- When updating documentation, invoke topic-manager agents in parallel (one per topic).
- Treat topic-manager as a scoped write agent: it may edit docs/ files. Only invoke
  it when a coding change has demonstrably altered a documented convention or contract.
  This is the only write operation in this skill; all other steps are read-only.

Before selecting topics, think through which components the task actually touches,
then match those components against the registry — resist loading "interesting" topics
that aren't directly relevant.
</task>

<instructions>

# Topic-Aware Coding Skill

You are enhancing a coding task with architectural context from topic documentation and managing documentation updates when needed.

## Token-Efficient Loading Strategy

The system has three layers, loaded progressively:

1. **TOPIC_REGISTRY.md** (ultra-lightweight inventory) - Load FIRST
2. **topic/README.md** (concept overview) - Load when relevant
3. **topic/USAGE|CONSTRAINTS|DESIGN.md** (details) - Load when needed

**Legacy Compatibility:** Prior topics may use `CONTRACTS.md` instead of `CONSTRAINTS.md`. These are equivalent — CONTRACTS is the legacy name. Always treat CONTRACTS.md as CONSTRAINTS.md when encountered.

## Invocation Modes

### Mode 1: Quick Inventory
**When:** User says "load topics", "load context", or needs topic overview
**Goal:** Fast catalog of available topics

**Action:**
1. Read ALL `**/docs/context/TOPIC_REGISTRY.md` files (workspace + submodules)
   - Ultra-lightweight: Just topic names, one-liner, key paths
   - Target: <100 tokens per topic, entire file <2k tokens
2. Report topic counts by repository
3. Exit (full topic READMEs are loaded on demand in Mode 2)

**Result:** Complete inventory in minimal tokens

### Mode 2: Task-Specific Loading
**When:** User has coding task, question, or technical request
**Goal:** Load only relevant topics with progressive depth

**Action:**
1. Identify working repository (workspace vs submodule)
2. Read that repository's `docs/context/TOPIC_REGISTRY.md`
3. Match user's keywords/file paths to topics from registry
4. Load relevant topic READMEs only
5. Load USAGE/CONSTRAINTS/DESIGN if task requires detail
6. Execute task

**Result:** Targeted context, minimal token usage

---

## Step 1: Determine Mode and Load Registry

**If TOPIC_REGISTRY.md is absent:** Run Glob first. If it returns zero results, notify the
user ("No TOPIC_REGISTRY.md found — proceeding without topic context") and continue the coding
task using direct code inspection via Read and Glob. The registry is project infrastructure,
not a prerequisite; its absence reduces context richness but does not block task execution.

### If Quick Inventory (Mode 1):

**Read all TOPIC_REGISTRY files:**
```
Use Glob to find: **/docs/context/TOPIC_REGISTRY.md
Includes workspace root + all submodules
```

**After loading, report:**
- Total topics across workspace
- Topic breakdown by repository
- Key categories

**Then exit** — individual topic READMEs are loaded on demand in Mode 2 only.

---

### If Task-Specific Context (Mode 2):

**Scope loading to the active repository.** Load topics from the repository where work is happening:
- Submodule work → load that submodule's topics
- Optionally load workspace-level topics when they are explicitly cross-cutting
- Sibling repository topics are out of scope; ignore them unless the task spans repositories

#### Step 1a: Read Relevant TOPIC_REGISTRY

Identify working repository, then read its registry:

**For submodule work:**
```
Read: {submodule}/docs/context/TOPIC_REGISTRY.md
```

**For workspace work:**
```
Read: docs/context/TOPIC_REGISTRY.md
```

**Optionally also read:**
```
Read: docs/context/TOPIC_REGISTRY.md  # For cross-cutting workspace topics
```

**This registry gives you:**
- All available topics in that repository
- One-line descriptions
- Key file path patterns
- Ultra-fast matching capability

#### Step 1b: Match Topics from Registry

**Extract from user's request:**
- Technical terms (e.g., "MOB", "ARK", "cluster", "permission")
- File paths mentioned (e.g., `person_store.py`, `data_writer.py`)
- Actions/concepts (e.g., "deploy", "test", "schema change")

**Match against registry entries:**
- Check topic names for keyword matches
- Check descriptions for concept matches
- Check path patterns for file matches

**Select maximum 5 relevant topics** from current repository only.

#### Step 1c: Topic Selection Criteria

Be judicious about which topics to load. Apply these filters:

**Include topics that are:**
- Unique to this project's architecture or domain
- Complex enough to require project-specific elaboration
- Likely to be misunderstood without context
- Project-specific implementations of common patterns

**Exclude topics that are:**
- Generic concepts identical across similar projects (e.g., "What is REST?", "JSON serialization")
- Standard library usage without project-specific nuances
- Well-documented by external sources with no local customization
- Self-explanatory from code without needing conceptual overview

---

## Step 2: Load Topic READMEs

For EACH relevant topic, read the README from the **appropriate repository**:

**Workspace-level topics:**
```
docs/topics/{topic-name}/README.md
```

**Submodule-specific topics:**
```
{current-submodule}/docs/topics/{topic-name}/README.md
```

These provide lightweight conceptual overviews. Read detail files (USAGE/CONSTRAINTS/DESIGN) only after confirming a specific need in Step 3.

**Repository scoping:**
- Stay within the repository where work is happening
- Cross repository boundaries only for topics that are explicitly cross-cutting
- Treat sibling repository topics as out of scope; skip them unless cross-repository work is confirmed

---

## Step 3: Assess Need for Deeper Documentation

Based on the coding task, determine if you need:
- **USAGE.md**: If user needs code examples, API usage, or "how to" guidance
- **CONSTRAINTS.md**: If discussing rules, constraints, validation, invariants, or enforceable constraints
- **DESIGN.md**: If explaining implementation details, debugging, or architectural internals

Read these files only when they directly support the current task; defer all speculative loading until a concrete gap makes them necessary.

---

## Step 4: Execute Coding Task

With topic context loaded, proceed with the user's coding task while:
- Respecting constraints from CONSTRAINTS.md (if loaded)
- Following patterns from USAGE.md (if loaded)
- Understanding implementation from DESIGN.md (if loaded)
- Maintaining consistency with documented concepts

---

## Step 5: Update Documentation If Needed

If code changes alter a documented convention, contract, or constraint — and only then — invoke the `topic-manager` agent to update the relevant files (README/USAGE/CONSTRAINTS/DESIGN).

**topic-manager scope:** The agent reads and writes files within `docs/topics/{topic-name}/`. It operates only on the topic files you name. It does not push to remote or modify code. Invoking it is reversible (edits can be reverted via git). Invoke it only when a documented fact has materially changed — speculative or "might be useful" updates belong after a concrete, verified change.

If multiple topics need updates, invoke the agent **in parallel** (multiple invocations in a single message) for faster processing. Reference `docs/context/MAINTENANCE.md` for update guidelines.

**State handoff for fresh context:** If this skill is invoked in a new context window mid-task, re-read the TOPIC_REGISTRY to rebuild orientation before continuing — do not assume prior topic selections are still accurate.

---

## Token Efficiency Checklist

Before loading ANY file beyond READMEs, ask:
- [ ] Is this file directly relevant to the current task?
- [ ] Will this information change my approach or understanding?
- [ ] Can I complete the task without this information?

If all answers are YES, load it. Otherwise, skip it.

---

## Decision Matrix

**When to load each file type:**

| File Type | Load When | Skip When |
|-----------|-----------|-----------|
| README.md (context) | Mode 1: Initial load for all projects | Mode 2: Task-specific only |
| README.md (topic) | Always for relevant topics | Topic not relevant to task |
| USAGE.md | Need code examples, API patterns, or implementation guidance | Just need concept overview |
| CONSTRAINTS.md | Discussing validation, rules, constraints, or invariants | No constraint checking needed |
| DESIGN.md | Debugging, refactoring internals, or need implementation details | High-level changes only |

---

## Related Topics Handling

When a README references related topics:
- **Load related topic**: Only if it's directly needed for the current task
- **Skip related topic**: If it's tangentially related or "nice to know"
- **Defer loading**: Make note of it; load it only when you hit a concrete blocker that requires it

---

## Token Efficiency Reference

| Scenario | Strategy | Typical Token Cost |
|----------|----------|-------------------|
| Quick inventory | Load all `**/TOPIC_REGISTRY.md` files | ~2-3k tokens total |
| Task-specific (single repo) | Load 1 TOPIC_REGISTRY + 1-3 topic READMEs | ~500-2000 tokens |
| Task-specific (workspace) | Load 2 TOPIC_REGISTRY + 1-3 topic READMEs | ~800-2500 tokens |
| Deep dive | Add USAGE/CONSTRAINTS/DESIGN | +500-1500 tokens per file |

**Progressive Loading Benefits:**
- **Layer 1 (TOPIC_REGISTRY)**: Ultra-lightweight inventory (<100 tokens/topic)
- **Layer 2 (topic/README.md)**: Concept overview only when relevant
- **Layer 3 (USAGE/CONSTRAINTS/DESIGN)**: Details only when needed
- Repository scoping prevents loading irrelevant sibling repositories

---

## When Topics Are Not Found

Apply graceful degradation rather than blocking when documentation is missing:

**Registry not found** (`TOPIC_REGISTRY.md` absent or Glob returns zero results):
- Report to the user: "No TOPIC_REGISTRY.md found in this workspace. Proceeding without topic context."
- Continue the task using direct code inspection (Read, Glob) as the context source.
- The registry is optional project infrastructure; its absence reduces context richness but does not prevent task completion.
- Suggest the user run `topic-manager` to generate one if the project uses the topic documentation system.

**Topic README not found** (registry lists a topic but its README.md is missing):
- Report to the user: "README for topic '{name}' not found at expected path. Proceeding without it."
- Continue with whatever documentation was successfully loaded.
- Load the next most relevant topic if one exists; do not halt or fabricate content.

**Detail file not found** (USAGE/CONSTRAINTS/DESIGN missing for a topic):
- Proceed with the README-level understanding already loaded.
- Note the gap in your response if it meaningfully affects the answer quality.

In all cases: complete the task with the context that is available. The skill's job is to enhance coding quality with documentation, not to gatekeep on its presence.

</instructions>

<examples>
<example label="quick-inventory">
**Task**: "load topics"

Mode: Quick Inventory (Mode 1).
Action: Glob `**/docs/context/TOPIC_REGISTRY.md` to find all registry files across workspace and submodules.
Cost: ~2-3k tokens total.
Report: "Found {N} topics across workspace: root ({X}), {submodule1} ({Y}), {submodule2} ({Z})."
Exit: Report the inventory and stop — individual topic READMEs are loaded only on demand in Mode 2.
</example>

<example label="bug-fix">
**Task**: "Fix bug in [core component]"

Mode: Task-Specific (Mode 2).
Topics identified: [relevant component topics] from registry.
Load: READMEs + DESIGN.md for affected component (need implementation details to understand the bug).
Skip: USAGE.md (not writing new code), CONSTRAINTS.md (not validating inputs).
Rationale: Implementation internals are needed to locate and fix the defect.
</example>

<example label="new-feature">
**Task**: "Add new [feature type] to [system]"

Mode: Task-Specific (Mode 2).
Topics identified: [relevant system topics] from registry.
Load: READMEs + CONSTRAINTS.md (understand rules) + USAGE.md (follow patterns).
Skip: DESIGN.md initially — load later only if implementation is unclear.
Rationale: Must follow existing patterns and respect constraints before writing new code.
</example>

<example label="understanding-question">
**Task**: "How does [system X] work?"

Mode: Task-Specific (Mode 2).
Topics identified: [relevant topics] from registry.
Load: READMEs only.
Skip: All detail files unless user asks follow-up questions requiring deeper context.
Rationale: A conceptual overview is sufficient; detail files add tokens without value here.
</example>

<example label="new-component">
**Task**: "Create new [component type]"

Mode: Task-Specific (Mode 2).
Topics identified: [relevant architectural topics] from registry.
Load: READMEs + USAGE.md (code examples) + CONSTRAINTS.md (follow constraints).
Skip: DESIGN.md unless debugging issues arise during implementation.
Rationale: Patterns and constraints must be known before writing new code.
</example>

<example label="oblique-reference">
**Task**: "Why can't I connect to {external service}"

Mode: Task-Specific (Mode 2).
Load: `docs/context/TOPIC_REGISTRY.md` (workspace-level work).
Extract keywords: "connect", "{external service}".
Match from registry: "Networking" topic mentions connectivity/cross-account patterns.
Load: `docs/topics/networking/README.md`.
Cost: Registry ~2k tokens + Networking README ~1.5k tokens = ~3.5k tokens total.
Result: Understand network architecture and access patterns without loading unrelated topics.
</example>

<example label="repository-scoping">
**Task**: "Fix the {data_store} adapter in {submodule1}"

Mode: Task-Specific (Mode 2).
Working directory: `{submodule1}/`.
Load: `{submodule1}/docs/context/TOPIC_REGISTRY.md` — primary registry.
Also load: `docs/context/TOPIC_REGISTRY.md` — for cross-cutting workspace topics only.
Match: File path `{data_store}.py` matches "{store-architecture}" and "{adapter-pattern}" in submodule registry.
Load READMEs: `{submodule1}/docs/topics/{category}/{store-architecture}.md` and `{submodule1}/docs/topics/{category}/{adapter-pattern}.md`.
Load cross-cutting: `docs/topics/{language}-standards/README.md`.
Cost: 2 registries ~3k + 3 READMEs ~4k = ~7k tokens.
Out of scope: Topics from `{submodule2}/` — they are unrelated to this task; skip them.
</example>

<example label="missing-registry-graceful-degradation">
**Task**: "Refactor the auth module" — but Glob finds no TOPIC_REGISTRY.md anywhere in the workspace.

Mode: Task-Specific (Mode 2) attempted.
Action: Glob `**/docs/context/TOPIC_REGISTRY.md` returns zero results.
Resolution: Proceed with the coding task using general knowledge and code inspection only.
  - Read relevant source files directly to understand current patterns.
  - Note to the user: "No TOPIC_REGISTRY.md was found in this workspace. Proceeding without
    topic context — consider running topic-manager to generate one if the project uses the
    topic documentation system."
Continue without blocking: the registry is optional infrastructure; its absence reduces context
richness but does not prevent completing the task.
Rationale: Graceful degradation keeps the skill useful in projects that have not yet
adopted the topic documentation convention.
</example>
</examples>

<success_criteria>
The skill is complete when:
- TOPIC_REGISTRY.md was read before any topic was selected (never guessed).
- Topics loaded match the task's actual components — no speculative loading.
- Sibling repository topics were not loaded when working in a submodule.
- USAGE/CONSTRAINTS/DESIGN files were loaded only when directly needed.
- The coding task was executed with topic context applied (constraints honored,
  patterns followed, documented concepts respected).
- If documentation was updated: topic-manager agents were invoked in parallel,
  one per affected topic, and only because a documented fact materially changed.
</success_criteria>
