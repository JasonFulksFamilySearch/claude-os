---
name: topic-aware-coding
description: "Load and manage architectural context from topic documentation using progressive loading. Use when: (1) user asks to 'load topics' or 'load context', (2) starting coding tasks that benefit from architectural context, (3) user references systems/components documented in docs/topics/. Provides token-efficient access to topic READMEs, USAGE, CONSTRAINTS, and DESIGN docs, and automatically updates documentation when code changes affect topics."
---

# Topic-Aware Coding Skill

You are enhancing a coding task with architectural context from topic documentation and managing documentation updates when needed.

## Token-Efficient Loading Strategy

The system has three layers, loaded progressively:

1. **TOPIC_REGISTRY.md** (ultra-lightweight inventory) - Load FIRST
2. **topic/README.md** (concept overview) - Load when relevant
3. **topic/USAGE|CONSTRAINTS|DESIGN.md** (details) - Load when needed

**⚠️ Legacy Compatibility:** Prior topics may use `CONTRACTS.md` instead of `CONSTRAINTS.md`. These are equivalent—CONTRACTS is the legacy name. Always treat CONTRACTS.md as CONSTRAINTS.md when encountered.

## Invocation Modes

### Mode 1: Quick Inventory
**When:** User says "load topics", "load context", or needs topic overview
**Goal:** Fast catalog of available topics

**Action:**
1. Read ALL `**/docs/context/TOPIC_REGISTRY.md` files (workspace + submodules)
   - Ultra-lightweight: Just topic names, one-liner, key paths
   - Target: <100 tokens per topic, entire file <2k tokens
2. Report topic counts by repository
3. Exit (don't load full topic READMEs yet)

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

### If Quick Inventory (Mode 1):

**Read all TOPIC_REGISTRY files:**
```bash
# Use Glob to find: **/docs/context/TOPIC_REGISTRY.md
# Includes workspace root + all submodules
```

**After loading, report:**
- Total topics across workspace
- Topic breakdown by repository
- Key categories

**Then exit** - don't load individual READMEs yet.

---

### If Task-Specific Context (Mode 2):

**IMPORTANT:** Only load topics from the repository where work is happening.
- Submodule work → load that submodule's topics
- Optionally load workspace-level topics if cross-cutting
- Do NOT load topics from sibling repositories

#### Step 1a: Read Relevant TOPIC_REGISTRY

Identify working repository, then read its registry:

**For submodule work:**
```bash
Read: {submodule}/docs/context/TOPIC_REGISTRY.md
```

**For workspace work:**
```bash
Read: docs/context/TOPIC_REGISTRY.md
```

**Optionally also read:**
```bash
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
- ✅ Unique to this project's architecture or domain
- ✅ Complex enough to require project-specific elaboration
- ✅ Likely to be misunderstood without context
- ✅ Project-specific implementations of common patterns

**Exclude topics that are:**
- ❌ Generic concepts identical across similar projects (e.g., "What is REST?", "JSON serialization")
- ❌ Standard library usage without project-specific nuances
- ❌ Well-documented by external sources with no local customization
- ❌ Self-explanatory from code without needing conceptual overview

**Examples:**
- ✅ Include: "MOB (Match OBject) Structure" - project-specific data model
- ❌ Exclude: "HTTP Request Handling" - unless there's unique middleware/patterns
- ✅ Include: "Blocking Strategy for Billion-Record Deduplication" - unique algorithmic approach
- ❌ Exclude: "Database Connection Pooling" - unless custom implementation
- ✅ Include: "CJK Name Parsing with Cultural Rules" - domain-specific complexity
- ❌ Exclude: "Configuration File Loading" - standard practice

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

These provide lightweight conceptual overviews. Do NOT read other files yet.

**Repository scoping:**
- Stay within the repository where work is happening
- Only cross repository boundaries for explicitly cross-cutting topics
- Do NOT load topics from unrelated sibling repositories

---

## Step 3: Assess Need for Deeper Documentation

Based on the coding task, determine if you need:
- **USAGE.md**: If user needs code examples, API usage, or "how to" guidance
- **CONSTRAINTS.md**: If discussing rules, constraints, validation, invariants, or enforceable constraints
- **DESIGN.md**: If explaining implementation details, debugging, or architectural internals

Only read these files if they directly support the current task. Do NOT read speculatively.

---

## Step 4: Execute Coding Task

With topic context loaded, proceed with the user's coding task while:
- Respecting constraints from CONSTRAINTS.md (if loaded)
- Following patterns from USAGE.md (if loaded)
- Understanding implementation from DESIGN.md (if loaded)
- Maintaining consistency with documented concepts

---

## Step 5: Update Documentation If Needed

If code changes affect topic documentation:
- Note which topics are affected
- Invoke the `topic-manager` agent to update relevant files (README/USAGE/CONSTRAINTS/DESIGN)
- If multiple topics need updates, invoke the agent **in parallel** (multiple invocations in a single message) for faster processing
- Reference docs/context/MAINTENANCE.md for update guidelines

**Example parallel invocation:**
```
[Invoke topic-manager to update authentication-flow topic]
[Invoke topic-manager to update session-management topic]
[Invoke topic-manager to update token-validation topic]
(All in a single message for parallel execution)
```

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
- **Defer loading**: Make note of it, but don't load unless you hit a blocker

---

## Token Efficiency Comparison

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
- Cross-cutting workspace topics loaded when applicable

**Token Target for TOPIC_REGISTRY.md:**
- Workspace root: ~2000 tokens max ({N} topics × 100 tokens/topic)
- Submodule: ~1500 tokens max ({M} topics × 100 tokens/topic)
- **Must be smaller than any single topic README**

---

## Examples

### Example Pattern 1: Quick Inventory
**Task**: "load topics"
- Mode: Quick Inventory (Mode 1)
- Load: All `**/docs/context/TOPIC_REGISTRY.md` files
- Cost: ~2-3k tokens total
- Report: "Found {N} topics across workspace: root ({X}), {submodule1} ({Y}), {submodule2} ({Z})"
- Exit: Don't load individual topic READMEs yet

### Example Pattern 2: Bug Fix
**Task**: "Fix bug in [core component]"
- Mode: Task-Specific (Mode 2)
- Topics identified: [relevant component topics]
- Load: READMEs + DESIGN.md for affected component (need implementation details)
- Skip: USAGE.md (not writing new code), CONSTRAINTS.md (not validating inputs)
- Rationale: Need to understand internals to fix bug

### Example Pattern 3: New Feature
**Task**: "Add new [feature type] to [system]"
- Mode: Task-Specific (Mode 2)
- Topics identified: [relevant system topics]
- Load: READMEs + CONSTRAINTS.md (understand rules) + USAGE.md (follow patterns)
- Skip: DESIGN.md initially (may need later if implementation unclear)
- Rationale: Need to follow existing patterns and constraints

### Example Pattern 4: Understanding Question
**Task**: "How does [system X] work?"
- Mode: Task-Specific (Mode 2)
- Topics identified: [relevant topics]
- Load: READMEs only
- Skip: All other files unless user asks follow-up questions
- Rationale: Overview sufficient for conceptual understanding

### Example Pattern 5: New Component Creation
**Task**: "Create new [component type]"
- Mode: Task-Specific (Mode 2)
- Topics identified: [relevant architectural topics]
- Load: READMEs + USAGE.md (code examples) + CONSTRAINTS.md (follow constraints)
- Skip: DESIGN.md unless debugging issues
- Rationale: Need to follow existing patterns and respect constraints

### Example Pattern 6: Oblique Reference
**Task**: "Why can't I connect to {external service}"
- Mode: Task-Specific (Mode 2)
- Load: `docs/context/TOPIC_REGISTRY.md` (workspace-level work)
- Extract keywords: "connect", "{external service}"
- Match from registry: "Networking" topic mentions connectivity/cross-account
- Load: `docs/topics/networking/README.md`
- Cost: Registry ~2k tokens + Networking README ~1.5k tokens = ~3.5k tokens
- Result: Understand network architecture and access patterns

### Example Pattern 7: Repository Scoping
**Task**: "Fix the {data_store} adapter in {submodule1}"
- Mode: Task-Specific (Mode 2)
- Working directory: `{submodule1}/`
- Load: `{submodule1}/docs/context/TOPIC_REGISTRY.md`
- Also load: `docs/context/TOPIC_REGISTRY.md` (for cross-cutting topics)
- Extract: File path `{data_store}.py` matches patterns in registry
- Match: "{store-architecture}" and "{adapter-pattern}" topics from submodule registry
- Load: `{submodule1}/docs/topics/{category}/{store-architecture}.md`
- Load: `{submodule1}/docs/topics/{category}/{adapter-pattern}.md`
- Load: `docs/topics/{language}-standards/README.md` (cross-cutting workspace topic)
- Cost: 2 registries ~3k + 3 READMEs ~4k = ~7k tokens
- Do NOT load: Topics from `{submodule2}/`
- Result: Focused context for {submodule1} + relevant workspace standards
