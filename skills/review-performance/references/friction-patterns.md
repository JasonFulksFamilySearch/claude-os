# Friction Patterns Reference

This file documents the regex patterns and heuristics used by `/review-performance` to detect friction in Claude Code sessions.

## Hook Log Patterns

Hook log entries are line-delimited JSON. Each line looks like:

```json
{
  "timestamp": "2026-05-17T10:30:00Z",
  "tool": "Bash",
  "command": "git commit -m 'ARC-123: Fix filter'",
  "decision": "BLOCKED",
  "rule": "Rule 7",
  "agent_message": "I was about to commit but remembered no ticket numbers",
  "cwd": "/Users/jason/dev/arc-record-exchange",
  "session_id": "abc123",
  "duration_ms": 45
}
```

### Repeated Block Detection

A repeated block is the **same `rule` triggered on the same `tool` with semantically similar `command`** in 3+ distinct `session_id`s within 24h.

Semantic similarity: normalize command (lowercase, collapse whitespace, replace ticket numbers with `XXX-NNN`, replace paths with `<PATH>`). If normalized commands match, treat as same.

### Agent Sentiment Classification

Parse `agent_message` against these patterns:

| Pattern (regex, case-insensitive) | Sentiment |
|---|---|
| `I (was about to\|wanted to\|tried to).*but` | apologetic |
| `(I know\|I remember).*rule.*says` | apologetic |
| `(I'm not sure\|not clear\|confused about).*rule` | confused |
| `why does.*(rule\|claude\.md).*say` | confused |
| `let me (use\|try) (instead\|the alternative)` | compliant |
| `(skipping\|avoiding).*because` | compliant |
| `(can't\|cannot)\|won't.*let me` | frustrated |

When in doubt, classify as `compliant`.

## Auto Memory Patterns

Auto Memory entries live at `~/.claude/projects/<project>/memory/*.md`. Look for:

- **Cross-project repetition**: same insight written in 2+ different projects → promote to user-level `~/.claude/CLAUDE.md`
- **Project-only insight**: written in 1 project, applies broadly within it → promote to that project's `.claude/rules/`
- **Path-confined insight**: applies only to specific subdir → use path-scoped rule

## Stale Rule Detection

A rule is "stale" if, in the last 60 days:

- Zero hook log entries reference its identifier
- Zero Auto Memory entries reference its identifier
- No session transcript matches the rule's key phrases

Stale rules are not necessarily wrong — passive context rules (e.g., "our project uses TypeScript strict mode") may never block anything but still provide value. Flag for human review, not automatic deletion.

## Skill Gap Detection

Look for **same Bash command sequence repeated 10+ times across sessions** (after normalization). Examples that should become skills:

- Repeated query construction (e.g., manual Jira JQL)
- Repeated multi-step git sequences
- Repeated test-then-fix-then-test patterns

If a sequence has a clear input/output shape, propose `SKILL_CREATION`.

## Priority Heuristics

| Priority | Criteria |
|---|---|
| **HIGH** | Saves ≥ 15 min/week OR blocks the same command 5+ times OR affects multiple repos |
| **MEDIUM** | Saves 5-15 min/week OR consistent friction in 1 repo |
| **LOW** | Saves < 5 min/week OR isolated incident |

## Anti-Patterns (Do NOT Propose These)

- **Don't propose** removing a rule based on a single session of friction. Wait for 3+ sessions.
- **Don't propose** new rules without evidence of recurring need.
- **Don't propose** rules that conflict with existing rules (check for conflicts first).
- **Don't propose** changes to `.gitignored` files or files outside `~/.claude/` and repo `.claude/` directories.
- **Don't propose** anything that would weaken security (e.g., relaxing rules around credentials, secrets, or destructive commands).
