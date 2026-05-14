---
name: jira-release-audit
description: Audit git commits since the last release tag, identify ARC Jira tickets, and stamp missing fixVersion before cutting a release. Auto-detects version from latest git tag (minor bump default).
---

# Jira Release Audit

Audit commits from the current repo since the last release tag, identify ARC tickets that are missing a `fixVersion`, and stamp them with the upcoming release before it is cut.

## When to Use

- Before cutting any release (Record Exchange, REOS, DSS, GSS, etc.)
- When preparing a release manifest or release notes
- To answer "what's shipping in this release?"

---

## Execution Steps

### Step 1 — Identify Last Release Tag and Get Commits Since Then

```bash
git tag --sort=-v:refname
```

Take the latest semver tag from the output (e.g. `v2.12.0`). Then get all commits since that tag:

```bash
git log --oneline <last-tag>..HEAD
```

Example: `git log --oneline v2.12.0..HEAD`

Extract every `ARC-\d+` pattern from commit messages. Ignore:
- `chore(deps)` / Renovate bot bumps (no ticket by design)
- Internal tooling commits with no ARC reference (e.g. CLAUDE.md updates, permission fixes)

### Step 2 — Determine Target Release Version

Using the same latest tag from Step 1 (e.g. `v2.12.0`), default to a **minor bump**: `v2.12.0 → v2.13.0`.

**Confirm the target version with the user before proceeding** — they may want a patch bump instead.

### Step 3 — Find or Create the Jira Version

Use `mcp__atlassian__fetch` to check whether the version already exists in Jira:

```
GET https://icseng.atlassian.net/rest/api/3/project/ARC/versions
cloudId: icseng.atlassian.net
```

- If the target version exists: note its `id` and proceed.
- If it does **not** exist: inform the user and offer to create it:

```
POST https://icseng.atlassian.net/rest/api/3/version
Body: { "name": "v2.13.0", "projectId": 10647, "released": false, "archived": false }
cloudId: icseng.atlassian.net
```

Note the `id` from the response — it is needed for all `editJiraIssue` calls.

> ARC project constants: `projectId = 10647`, `cloudId = icseng.atlassian.net`

### Step 4 — Fetch All Identified Tickets in Parallel

For every ARC ticket extracted in Step 1, call `mcp__atlassian__getJiraIssue` **in a single parallel batch**:

```
cloudId: icseng.atlassian.net
fields: ["summary", "status", "fixVersions", "issuetype"]
```

### Step 5 — Classify Each Ticket

| Result                                     | Action                                    |
|--------------------------------------------|-------------------------------------------|
| `fixVersions` contains the target version  | Already stamped — skip                    |
| `fixVersions` is empty                     | Needs stamping                            |
| `fixVersions` has a **different** version  | Flag for manual review — do not overwrite |

### Step 6 — Stamp Missing Tickets in Parallel

For every ticket in the "needs stamping" list, call `mcp__atlassian__editJiraIssue` **in a single parallel batch**:

```
cloudId: icseng.atlassian.net
fields: { fixVersions: [{ id: "<version-id-from-step-3>" }] }
```

### Step 7 — Present the Summary

Produce aligned markdown tables:

**Already stamped** (no action taken):
| Ticket | Type | Summary | Status |

**Stamped this run**:
| Ticket | Type | Summary | Status |

**Excluded** (no ticket / dependency bumps):
- Brief list of commit descriptions

### Step 8 — Flag Stale Statuses

After stamping, call out any ticket where:
- Code is merged but Jira status is still **To Do** or **In Progress** (may need a manual transition)
- `fixVersions` was already set to a **different** version (needs human decision before release)

---

## Constants

| Field      | Value                     |
|------------|---------------------------|
| cloudId    | icseng.atlassian.net      |
| Project    | ARC                       |
| projectId  | 10647                     |
| MCP prefix | `mcp__atlassian__` only   |
| Bump style | Minor by default (v#.#+1.0) |

## Notes

- Never overwrite an existing non-empty `fixVersions` without user confirmation.
- Sub-Tasks (issuetype = Sub-Task) may need a status transition in addition to fixVersion — flag them if status is To Do.
- Use `mcp__atlassian__` exclusively; ignore `mcp__claude_ai_Atlassian__`.
