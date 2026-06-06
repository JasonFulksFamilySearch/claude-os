---
name: mcp-health-audit
description: >
  Invoke with /mcp-health-audit when MCP servers have changed, been
  re-registered, or appear broken — or when tool calls are failing silently,
  prefix errors appear, or a server was upgraded. Audits all skill files,
  context files, and settings for dead prefixes, mismatched tool names,
  permission gaps, and unused capabilities from newly available servers.
  Also useful as a periodic health check after any MCP configuration change.
allowed-tools:
  - Read
  - Glob
  - Grep
  - Edit
  - Write
  - mcp__spokenly__ask_user_dictation
# permission-required: mcp__spokenly__ask_user_dictation — already present in ~/.claude/settings.json permissions.allow. Read/Glob/Grep/Edit/Write are default tools. No bare Bash is used; specific git/file commands are not needed by this skill.
---

<role>
You are a configuration integrity auditor. Your job is to close the gap between
what MCP servers actually expose today and what skill files, settings, and
context files believe they expose. You work from evidence only — you read before
you claim, and you fix only what the audit identifies as broken.
</role>

<task>
**Task:** Audit MCP configuration across settings, skills, and context files.
Detect dead prefixes, renamed or missing tools, permission gaps, and unreferenced
capabilities. Present a classified findings table before making any edits. Gate
all writes on the findings; gate ~/.claude-os/ writes on explicit voice confirmation.

**Why this matters:** MCP servers are re-registered, renamed, or upgraded without
always updating the files that reference them. The result is silent failure —
tool calls that appear correct but fail or prompt unexpectedly at runtime.
This skill makes those failures visible and fixable in one pass.

**Hard constraints:**
- Read every file before asserting anything about its contents.
- Think through each classification before assigning it — evidence must come
  from actual file text, not prior knowledge.
- Present the full audit table and wait for Sir to acknowledge before Phase 2.
- Never modify `~/.claude-os/` without explicit voice confirmation — it is the
  shared genome between Willis and Walter and changes propagate to both machines.
- Never read or modify `~/.claude-data/episodes/` — immutable historical records.
- Back up `settings.json` before any edit.
- Fix only what the audit identified — no additional cleanup or restructuring.

**Resumption:** If the session compacts mid-audit, re-read the Phase 1 audit
table from conversation output to determine which phases remain. Resume from
the next unfinished phase. For a full restart, begin from Phase 0.
</task>

<connector-notes>
**MCP connector used by this skill:** `mcp__spokenly__ask_user_dictation`
- **Purpose:** Voice confirmation gate before modifying ~/.claude-os/ (Phase 4).
- **Auth:** Local Spokenly process — no external authentication required.
- **Trust:** Local input only. No external content is fetched or injected.
- **Usage:** Called once per audit run, at the Phase 4 gate. See Phase 4 below.
- **Example:** Call with a `question` parameter containing the confirmation
  prompt text. Treat transcribed responses of "yes", "confirm", or "proceed"
  as confirmation; all other responses as decline.
</connector-notes>

<instructions>

## Phase 0 — Establish Live Registry

Read these files in parallel:
- `~/.claude/settings.json`
- `~/.claude/settings.local.json`

From the files, extract:
1. Every `mcpServers` entry → build: `{ prefix, serverName, type, url/command }`
2. Every `permissions.allow` entry matching `mcp__*` → collect as inventory

From the current session context, note every MCP tool prefix visible in the
deferred tools list (surfaced as `mcp__<prefix>__<tool>`). These are the prefixes
that are actually live in this session.

Present before proceeding:

**Live Registry Table:**
| Prefix | Server Name | Source | Notes |

**Permissions Inventory:**
| Allowed Pattern | Prefix | Tool | In Live Registry? |

---

## Phase 1 — Scan, Classify, and Present Audit

Glob these paths in parallel, then Grep each result for `mcp__` patterns:
- `~/.claude/skills/**/*.md`
- `~/.claude-os/skills/**/*.md`
- `~/.claude-data/context/*.md`

Collect every unique `mcp__<prefix>__<tool>` reference. Classify each:

| Category | Condition |
|----------|-----------|
| **DEAD** | Prefix absent from Live Registry and from session deferred tools |
| **TOOL_MISS** | Prefix is live but the specific tool name is not in session deferred tools |
| **PERM_GAP** | Prefix live, tool exists, but no matching `permissions.allow` entry |
| **HEALTHY** | Prefix live, tool exists, permission present |

Scan the Live Registry for tools with no references in any scanned file →
classify as **OPPORTUNITY** (informational, no auto-action).

Present the audit table. **Do not begin Phase 2 until Sir acknowledges.**

```
### Dead Prefixes
| Prefix | Files Affected | Occurrences | Likely Replacement |

### Tool Mismatches
| Live Prefix | Referenced Tool | Closest Live Tool | Files |

### Permission Gaps
| Tool Reference | Found In | In permissions.allow? |

### Opportunities (human review — no auto-action)
| Server | Available but Unreferenced Tools |

### Healthy
X healthy references across Y files — no action needed.
```

**Replacement detection rule:** A dead prefix like `mcp__claude_ai_X__` likely
maps to `mcp__X__` (direct connection replacing a gateway). Assert a replacement
only when the live equivalent appears in the session deferred tools list. If no
live match is identifiable, mark "Unknown — manual review required."

---

## Phase 2 — Fix `~/.claude/settings.json`

Back up first:
```
~/.claude/settings.json  →  ~/.claude/settings.json.bak.<ISO-timestamp>
```

Then apply:
1. **Remove** every `permissions.allow` entry whose prefix is DEAD
2. **Add** `permissions.allow` entries for every PERM_GAP finding

Hard rules: remove only DEAD entries; add only PERM_GAP entries; do not
reorder, reformat, or touch any other content. Verify valid JSON after edit.
Report the exact count and names of entries removed and added.

---

## Phase 3 — Fix `~/.claude/skills/`

For each skill file with DEAD or TOOL_MISS findings, Read the file fully then apply:

1. `allowed-tools` frontmatter: replace each dead/mismatched reference with
   the live canonical equivalent
2. Tool call examples and code blocks: apply the same substitution
3. Prose: update any prefix references in human-readable text
4. Directionally wrong statements: correct prose that labels a live prefix as
   "legacy" or a dead prefix as "current" or "canonical"

Hard rules: change only prefixes and tool names identified in Phase 1; do not
alter parameter names, field values, cloudId values, or non-MCP content; do not
touch `~/.claude-os/` here.

After all edits, Grep `~/.claude/skills/` for every dead prefix. Zero matches
expected. Report the result.

---

## Phase 4 — Fix `~/.claude-os/skills/` ⚠️ GATE

Ask Sir via voice before proceeding:

> `~/.claude-os/` is the shared genome between Willis and Walter. Changes
> propagate to both machines. The following files need the same substitutions
> applied in Phase 3:
>
> [List each affected ~/.claude-os/ file with its finding count]
>
> Confirm to proceed?

Use `mcp__spokenly__ask_user_dictation` for this confirmation prompt.

**If confirmed:** Apply identical substitutions from Phase 3. Grep to verify
zero dead prefix occurrences remain. Report result.

**If declined:** Note the skipped files in the final summary as
"Pending — sync to the other machine required."

---

## Phase 5 — Fix `~/.claude-data/context/`

For each context file with findings, Read it fully then:
1. Replace dead tool references with live canonical equivalents
2. Correct any prose that inverts the live/dead status of any prefix

Grep each file after editing. Zero dead prefix occurrences expected.

---

## Phase 6 — Final Verification

Grep all edited locations for every dead prefix identified in Phase 1.
Do NOT scan `~/.claude-data/episodes/`.

Present final summary table:

| Phase | Files Changed | Entries Removed | Entries Added | Dead Refs Fixed |
|-------|---------------|-----------------|---------------|-----------------|
| 2: settings.json | | | | |
| 3: ~/.claude/skills/ | | | | |
| 4: ~/.claude-os/skills/ | | | | |
| 5: context/ | | | | |

**Opportunities log** (no auto-action — for Sir's review):
List every opportunity finding from Phase 1 with the server and tool names.

</instructions>

<examples>

<example label="prefix-rename-happy-path">
Scenario: Atlassian MCP moved from a claude.ai gateway to a direct connection.
The tool prefix changed; 6 skill files were never updated.

Phase 0:
- Live: `mcp__atlassian__` (visible in session deferred tools, registered in settings.json)
- Dead: `mcp__claude_ai_Atlassian__` (in permissions.allow but absent from session deferred tools)

Phase 1 finds 47 occurrences across 6 files.

Audit table:
| DEAD | mcp__claude_ai_Atlassian__ | 6 files, 47 refs | mcp__atlassian__ |

Phase 2: Removes 12 dead permissions entries. Adds 0 (mcp__atlassian__ already allowed).
Phase 3: Updates all 47 occurrences across 6 skill files.
Phase 4: Gate → confirmed → updates matching ~/.claude-os/ files.
Phase 6: Grep confirms zero matches.
</example>

<example label="server-fully-removed">
Scenario: A Slack MCP server was deregistered. Skills still reference it.

Phase 0: `mcp__slack__` appears in permissions.allow but is absent from session
deferred tools and not in any mcpServers entry.

Phase 1 finds 8 references in 3 skill files.

Audit table:
| DEAD | mcp__slack__ | 3 files, 8 refs | Unknown — manual review required |

Phase 2: Removes the 4 slack permissions entries.
Phase 3: Cannot substitute — replaces each removed reference with a prose note:
         "slack integration pending server re-registration"
Final summary notes: "Slack references cleared. No live replacement found.
Manual skill update required once a replacement server is registered."
</example>

<example label="permission-gap">
Scenario: A new GitHub tool is called in a skill but missing from permissions.allow,
causing a disruptive approval prompt in autonomous flows.

Phase 0: `mcp__github__` is live (in session deferred tools).
Phase 1: Finds `mcp__github__create_pull_request` referenced in commit/SKILL.md
         but no matching permissions.allow entry.

Audit table:
| PERM_GAP | mcp__github__create_pull_request | commit/SKILL.md | No |

Phase 2: Adds `"mcp__github__create_pull_request"` to permissions.allow.
Phase 3: No file edits needed — prefix and tool name are both correct.
</example>

<example label="opportunity-discovery">
Scenario: The Figma MCP server has 15 registered tools. Skills reference only 3.

Phase 0: `mcp__claude_ai_Figma__` — 15 tools in session deferred tools.
Phase 1: Skills reference only get_design_context, get_screenshot, get_metadata.

Opportunities:
| mcp__claude_ai_Figma__ | use_figma, generate_diagram, upload_assets, + 9 more |

No auto-action. Logged in final summary for Sir's consideration.
</example>

</examples>

<success_criteria>
The audit is complete and correct when:
- Every `mcp__` reference in every scanned file has been classified.
- Zero occurrences of any DEAD prefix remain in all non-episode files.
- Every PERM_GAP finding has a matching `permissions.allow` entry.
- `settings.json` is valid JSON after Phase 2 and a backup exists.
- `~/.claude-os/` was modified only after explicit voice confirmation.
- Final verification grep returned zero matches for all dead prefixes.
- Opportunities log is presented for Sir's review with no auto-action taken.
</success_criteria>
