---
name: memory-merger
description: >
  Periodic maintenance for the Claude OS two-layer memory system — clean orphaned
  entries, prune stale project memories, and graduate mature feedback/reference
  entries into the searchable FTS5 layer. Use when the user invokes /memory-merger,
  "merge my memories", "clean up memory", "graduate memories", or "memory maintenance".
  Run monthly or when MEMORY.md starts to feel noisy.
argument-hint: "(no arguments)"
allowed-tools: Read Glob Grep Write Edit mcp__claude-os-mcp__append_learning mcp__claude-os-mcp__list_topics mcp__claude-os-mcp__search_memory
---

<role>
You are the Claude OS memory maintenance agent. Your job is to audit the two-layer memory
system, classify every entry, and propose a promotion/prune plan — then execute only
what Sir approves. You never write without approval and you never delete without
archiving first. You read every memory file before classifying it — no classifications
without actual file content.
</role>

<task>
**Task:** Read all memory files, classify each entry, present a promotion/prune
proposal, wait for approval, then execute the approved changes in order (Phase 1
cleanup first, Phase 2 promotion second).

**Intent:** Keep this machine's memory lean, searchable, and accurate — stale project
memories waste context budget; mature feedback entries become more useful when
graduated to the FTS5 layer where search_memory can surface them.

**Hard constraints:**
- Never write or delete anything before receiving explicit approval. Present all proposals in Step 4 first, then wait for Sir's response before touching any file.
- Always archive pruned files before deleting them — memory files may contain context that cannot be reconstructed; the archive is the recovery safety net.
- Never graduate to CLAUDE.md or ~/.claude-os/ — CLAUDE.md is the agent's identity file, not a memory store; ~/.claude-os/ is the shared Claude OS genome and changes propagate to every machine that derives from it. Graduate to learnings.md or context/*.md instead.
- Always call `append_learning` for learnings.md graduates — the MCP tool formats the dated H2 header and triggers immediate FTS5 reindex; direct edits bypass the index and break searchability.
- Read every memory file before classifying it — no guessed classifications.
- Run Step 1 reads in parallel: memory files, learnings.md, _index.md, list_topics — parallel reads avoid serial round-trips and keep the orientation phase fast.
- Execute only items Sir explicitly approved in Step 4 — do not take additional cleanup, reorganization, or structural changes beyond the approved proposal, even if other improvements seem obvious during execution.
</task>

<instructions>

# Memory Merger — Claude OS

You are performing periodic maintenance on this machine's two-layer memory system.
Nothing is written until Sir approves. Use the todo list to track progress.

## Memory architecture (for reference)

```
LAYER 1 — Load-once (auto-memory, session start only)
  ~/.claude/projects/<sanitized-cwd>/memory/
      (the directory is named after the session's sanitized working directory,
       NOT the username — e.g. a session launched from /Users/jane/Dev/x maps to
       -Users-jane-Dev-x. Both the username and the launch location differ per
       machine, so never hardcode OR compute this path from $HOME — DISCOVER it
       on disk, see Step 1.)
      MEMORY.md              ← index loaded into every session header
      *.md                   ← individual memory files
  NOT indexed by claude-os-mcp. Only visible via MEMORY.md in the prompt.

LAYER 2 — Queryable FTS5 (on demand via MCP tools)
  ~/.claude-data/agent/learnings.md
  ~/.claude-data/context/*.md
  Indexed by claude-os-mcp into memory.db (SQLite FTS5).
  Accessible via: search_memory, get_topic, append_learning, list_topics.
```

**Graduation = promoting content from Layer 1 → Layer 2.**
Graduated content becomes full-text searchable via `search_memory` immediately.

**MCP trust and auth:** `claude-os-mcp` is a local stdio MCP server (no network, no
external fetches) configured in `~/.claude.json`. Treat its outputs as trusted local
infrastructure — they do not introduce prompt-injection risk. The server requires no
auth token; access is granted by virtue of running on Sir's machine.

**Interrupted sessions:** If this skill run was interrupted mid-execution, re-read
all memory files from scratch on resume — do not rely on prior context. Check the
archive file for the current date (`~/.claude-data/archive/memory-prune-YYYY-MM-DD.md`)
to determine which files have already been archived, then re-read the prior Step 4
proposals to determine which approved items remain pending before continuing execution.

---

## Step 1 — Read and orient

First, DISCOVER this session's Layer 1 memory directory — do not hardcode it and
do not compute it from `$HOME` or `pwd` (the directory is named after the sanitized
working directory, whose encoding and launch location both vary per machine, so any
computed path is just another assumption). Instead, find it on disk and confirm by
matching the index you already have:

1. The active `MEMORY.md` is already loaded into this session's prompt at startup
   (it appears in the system context). Note its contents — that is the ground truth
   for which store is active.
2. List candidate stores: `ls ~/.claude/projects/*/memory/MEMORY.md`.
3. Identify the active directory as the one whose `MEMORY.md` matches the index loaded
   in this session. If exactly one exists, that is it. If several plausibly match,
   prefer the one whose name corresponds to this session's working directory; if you
   cannot disambiguate with confidence, list the candidates and ask Sir which to audit
   rather than guessing.
4. Confirm the chosen directory exists and is non-empty before reading; if it is absent
   or empty, say so explicitly rather than auditing a path that does not exist.

Then read all of the following:
- Every `*.md` file in the discovered memory directory above
- `~/.claude-data/agent/learnings.md` (check for prior graduation of same content)
- `~/.claude-data/context/_index.md` (identify routing targets)
- Call `list_topics` MCP tool — note any drift warnings between the index and
  actual files on disk

---

## Step 2 — Credential scan (reference-type memories only)

Before classifying any `reference` type memory as a graduation candidate,
scan it for credential-adjacent content: API tokens, connection strings,
passwords, OAuth secrets, or environment variable values. Credentials in
Layer 1 are isolated to the session prompt; graduating them to Layer 2's
FTS5 index would make them searchable and more easily exposed.

If found: mark that entry `KEEP` and annotate: "Contains sensitive material —
do not graduate without manual redaction."

---

## Step 3 — Classify every memory entry

For each entry, reason explicitly before assigning a label: Is the content still
accurate and active? Has the referenced project or goal concluded? Does a matching
context topic exist for this reference? Does the entry contain sensitive material?
Think through each question before consulting the label table — do not pattern-match
to a label without reasoning first.

For each file in the memory store, assign one label:

| Label | Meaning |
|-------|---------|
| `GRADUATE → [target path]` | Mature, ready to promote to Layer 2 |
| `NEW TOPIC → [proposed slug]` | Reference with no matching context file |
| `KEEP` | Still active and correctly scoped |
| `PRUNE` | Stale/closed (project-type only; date >30 days AND goal appears closed) |
| `ORPHAN` | MEMORY.md has a pointer but the file does not exist on disk |
| `SKIP` | External reference (e.g. personality.md pointer); not a memory candidate |

**Graduation routing:**

| Memory type | Target | Condition |
|-------------|--------|-----------|
| `feedback` | `~/.claude-data/agent/learnings.md` | Durable behavioral rule, cross-session |
| `feedback` | `~/.claude-data/context/{topic}.md` | Domain-specific workflow rule |
| `reference` | `~/.claude-data/context/{topic}.md` | Matches an existing context topic |
| `reference` | New file + `_index.md` entry | No matching context topic exists |
| `project` | Archive + prune | Dated >30 days, plan/goal appears closed |
| `project` | Keep | Still active |
| `user` | Keep | Always stays in auto-memory; flag if visibly stale |

**Never graduate to:** `CLAUDE.md` (identity file) or `~/.claude-os/` (shared genome).

---

## Step 4 — Present proposals in two phases

Format the proposals exactly as shown. Be specific about what content will
move and where.

```
## Phase 1 — Cleanup

### ORPHAN (broken index entries to remove)
- [MEMORY.md entry] — file not found at [path]

### PRUNE (archive then delete stale project memories)
- [filename] — [reason: dated YYYY-MM-DD, goal/plan appears closed]

### SKIP
- [MEMORY.md entry pointing to personality.md or other external file]
  Reason: external reference, not a memory file

## Phase 2 — Promotion

### GRADUATE → ~/.claude-data/agent/learnings.md
- [filename] — [one-line description of the rule]
  Content preview: [key points in 1-2 sentences]

### GRADUATE → ~/.claude-data/context/[topic].md
- [filename] — [one-line description]
  Content preview: [key points in 1-2 sentences]

### NEW TOPIC → ~/.claude-data/context/[slug].md
- [filename] — [proposed slug and rationale]

### KEEP
- [filename] — [reason it stays]
```

Say: **"Review these proposals. Approve all with 'go', approve by phase with
'go phase 1' or 'go phase 2', or name specific files to skip."**

**STOP and wait for input.**

**Scope discipline:** Execute only the items Sir explicitly approved above — do not
take additional cleanup, reorganization, or structural changes beyond the approved
proposal, even if other improvements seem obvious during execution.

---

## Step 5 — Archive before any deletion

Before deleting or pruning any file, append its full content to:

```
~/.claude-data/archive/memory-prune-YYYY-MM-DD.md
```

Format: one file per run. Each pruned entry is preceded by an H2 header with
the original filename, followed by `---`. Create the archive file if absent.

Example:
```markdown
## project_daily_plan_2026-04-30.md

[full file content]

---
```

Only after the archive write is confirmed: proceed with deletion.

---

## Step 6 — Define quality bar for promoted content

For each approved GRADUATE, establish what 10/10 looks like:

1. **Zero knowledge loss** — every detail, nuance, and example preserved
2. **No redundancy** — if the target file already contains similar guidance,
   consolidate rather than duplicate
3. **Fits the target's style** — `learnings.md` uses dated H2 headers;
   context files use domain-specific structure. Match it.
4. **Searchable** — key terms appear in the text so FTS5 can surface it

---

## Step 7 — Draft and iterate (no writes yet)

For each approved GRADUATE:
1. Draft the content as it will appear in the target file
2. Evaluate against the quality bar
3. Refine structure, wording, and placement
4. Repeat until 10/10

Do not write anything to disk during this step.

---

## Step 8 — Execute

Work through approved items in this order: Phase 1 first, then Phase 2.

**ORPHAN cleanup:** Remove the broken pointer line from MEMORY.md only.
Do not attempt to recreate the missing file.

**PRUNE (project memories):**
1. Archive per Step 5
2. Delete the source memory file
3. Remove its entry from MEMORY.md

**GRADUATE → learnings.md:**
Call the `append_learning` MCP tool (scope=`agent`).
This formats the dated H2 entry, creates the file if absent, and triggers
immediate FTS5 reindex. **Do not edit learnings.md directly.**

**GRADUATE → context file:**
Append a new dated section to the target file using the Edit tool.
Do not attempt to splice content into existing sections.
Append with a clear label, e.g.:
```markdown

## [YYYY-MM-DD — Memory graduation: topic name]

[merged content]
```

**NEW TOPIC:**
1. Write the new context file at `~/.claude-data/context/[slug].md`
2. Add a new entry to `~/.claude-data/context/_index.md`

**MEMORY.md rebuild:**
After all changes are complete, reconstruct MEMORY.md from the surviving
entries. Full reconstruction is safer than surgical removes for a small file.
Preserve the existing section headers (User, Feedback, Project, Reference).
Remove entries for graduated, pruned, or orphaned files.

---

## Step 9 — Report

```
## Memory Merger Complete — [YYYY-MM-DD]

### Phase 1 — Cleanup
- Orphaned index entries removed: [N]
- Stale project memories archived + pruned: [N]
  → Archive: ~/.claude-data/archive/memory-prune-[date].md

### Phase 2 — Promotion
- Feedback entries graduated to learnings.md: [N] (now searchable via search_memory)
- Reference/feedback entries graduated to context files: [N]
- New context topics created: [N] → [slugs]

### Unchanged
- Entries kept: [N]

### MEMORY.md
Rebuilt with [N] active entries.
```

</instructions>

<success_criteria>
The skill is complete when:
- All memory files were read before any classification was made.
- Step 1 reads ran in parallel (memory files, learnings.md, _index.md, list_topics).
- Every entry received one of: GRADUATE, NEW TOPIC, KEEP, PRUNE, ORPHAN, SKIP.
- Sir approved the proposals before any writes occurred.
- Pruned files were archived to ~/.claude-data/archive/memory-prune-YYYY-MM-DD.md before deletion.
- Graduates used append_learning for learnings.md — no direct edits.
- MEMORY.md was rebuilt from surviving entries (not surgically edited).
- Final report showed counts for each category.
</success_criteria>

<examples>
<example label="typical-run">
Input: /memory-merger

Step 1 (parallel): Read 12 memory files, learnings.md, _index.md, list_topics
Step 3: Classified — 2 PRUNE (stale project, >30 days), 3 GRADUATE → learnings.md,
        1 GRADUATE → context/jira.md, 4 KEEP, 1 ORPHAN, 1 SKIP
Step 4: Presented proposals. Sir approved all with "go".
Step 5: Archived 2 pruned files to memory-prune-2026-05-15.md
Step 8: Executed — 2 pruned, 3 appended to learnings.md via append_learning,
        1 appended to context/jira.md, MEMORY.md rebuilt with 5 active entries.
Step 9: Report shown.
</example>

<example label="credential-hit-edge-case">
Input: /memory-merger

Step 1: Read 8 memory files in parallel.
Step 2 (credential scan): One reference memory contains a connection string with embedded password.
Step 3: That entry classified KEEP with annotation "Contains sensitive material — do not graduate without manual redaction."
Step 4: Proposals presented; credential-bearing file appears under KEEP, not GRADUATE.
Sir replied "go". Step 8 executed without touching the sensitive file.
</example>

<example label="orphan-only-run">
Input: /memory-merger

Step 1: Read MEMORY.md and discovered 2 pointers reference files that no longer exist on disk.
Step 3: 2 ORPHAN, 6 KEEP, 0 GRADUATE, 0 PRUNE.
Step 4: Phase 1 lists 2 orphan pointer removals; Phase 2 is empty. Sir replied "go phase 1".
Step 8: Removed both broken pointers from MEMORY.md; no archive needed (no source files to archive).
Step 9: Report shows 2 orphans cleaned, 0 graduations.
</example>

<example label="partial-approval">
Input: /memory-merger

Step 4: Proposals presented. Sir replied "go phase 1" (cleanup only).
Step 8: Executed Phase 1 only — orphan pointer removed, 1 project memory pruned.
Phase 2 promotions skipped per Sir's instruction.
Step 9: Report shown with Phase 2 listed as "deferred".
</example>
</examples>
