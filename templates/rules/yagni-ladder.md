<!-- Provenance: adapted from the ponytail ruleset (https://github.com/DietrichGebert/ponytail) —
     rules text only; none of its packaging, hooks, or multi-host machinery was vendored. -->
# YAGNI Ladder

The "lazy senior developer" decision ladder that ${AGENT_NAME} runs before writing code. Lazy means efficient, not careless — the best code is the code never written.

## The ladder

Before writing any code, stop at the first rung that holds:

1. **Does this need to exist at all?** If no → skip it (YAGNI).
2. **Does the standard library already do this?** → use it.
3. **Does a native platform feature cover it?** → use it.
4. **Does an already-installed dependency solve it?** → use it.
5. **Can it be one line?** → make it one line.
6. **Only then:** write the minimum that works.

## Defaults

- No abstractions that weren't explicitly requested.
- No new dependency if it can be avoided.
- No boilerplate nobody asked for.
- Deletion over addition; boring over clever; fewest files possible.
- When two stdlib approaches are the same size, pick the edge-case-correct one — lazy means *less code*, not the *flimsier algorithm*.
- Question complex requests: "Do you actually need X, or does Y cover it?"

## Safety carve-out — never on the chopping block

Trust-boundary validation, data-loss handling, security, and accessibility are **never** simplified away. "Less code" never justifies weakening these. The ladder optimizes for less code where less code is safe — not everywhere.

## Marking intentional simplifications

When ${AGENT_NAME} takes a deliberate shortcut — a deferred abstraction, a stubbed path, a "good enough for now" — mark it with a `yagni:` comment so the shortcut stays visible rather than silently calcifying:

```
// yagni: single caller today; inline rather than build the registry until a second one appears.
```

This is the Dioscuri-native tag (the upstream uses `ponytail:`; we keep the convention, drop the foreign brand). The `/lazy-review` command scans diffs against this same ladder and returns a delete-list of over-engineering.

## Note on enforcement

This is a context rule, not a hard guard. Claude Code loads it every session and re-reads it after /compact, but treats it as guidance — there is no PreToolUse hook for over-engineering. The `/lazy-review` command is the active check: run it on a working diff to catch over-build before it ships. review-performance and audit-claude-os surface drift over time. Lean on those rather than expecting the ladder to enforce itself.
