# tooling.md
# Tool selection and command execution rules for ${AGENT_NAME}.
# Extracted from CLAUDE.md to keep the identity file under 200 lines.

## Tooling rules

Prefer built-in Claude Code tools over their shell equivalents — they return
structured, context-friendly output. But "prefer" and "denied" are different tiers;
be precise about which is which (verified against `settings.json`):

**Denied — the call fails** (`permissions.deny`): `awk`, `sed`, `rg`. Use the built-in.

**Allowed but discouraged — they run, prefer the built-in anyway:** `cat`, `head`,
`tail`, `find`, `grep` are explicitly allowed in `settings.json` and will NOT fail.
The built-in tools are the convention because they handle large output and context better.

**Search-tool fallback invariant.** Keep `grep`/`find`/`cat` in `permissions.allow` on
each machine so that if native `Grep`/`Glob` regress out of the tool registry (as in
Claude Code 2.1.116–2.1.126), bash search still works. Do not move them to `deny`. If you
notice `Grep`/`Glob` are absent from your tool palette, just use bash `grep`/`find` — they
are already allowed. No flag-setting or hook changes are needed.

| Task | Use | Instead of |
|---|---|---|
| File pattern matching | Glob | `find` (allowed; discouraged) |
| Content search | Grep | `grep` (allowed; discouraged), `rg` (denied) |
| Read file | Read (offset + limit) | `cat` / `head` / `tail` (allowed; discouraged) |
| Text replacement | Edit | `sed`, `awk` (denied) |
| File creation | Write | `echo >`, `cat <<EOF` |

Allowed Bash includes `ls`, `wc`, `which`, `pwd`, `echo`, `date`, `git`, `npm`, `gh`,
`node`, `mvn`, `jira`, `jq`, and other dev commands — see `settings.json`
`permissions.allow` for the authoritative list.

**No multi-line inline node scripts.** `node` is allowed, so a single-line `node -e '...'`
runs without a prompt. A multi-line one prompts because Claude Code's permission matcher
treats embedded newlines as command separators (alongside `&&`, `||`, `;`, `|`), so the
trailing lines no longer match the `Bash(node:*)` allow rule. Write the script to
`./_tmp_analysis.js`, run it, delete it. Single-line `node -e` is fine.

**Path quoting.** Always wrap paths with spaces in double quotes. Never backslash-escape whitespace.

**Topic pre-flight.** In projects with `/docs/context/TOPIC_REGISTRY.md`, invoke the
`topic-aware-coding` skill before coding. Skipping causes rework.

## Command execution

`cd` into the target directory before running commands, rather than path-targeting flags.
The rules below are separated by *how* they are enforced — only the last two actually block.

**Convention (NOT enforced — consistency only):** avoid `git -C`, `mvn -f`,
`gradle --project-dir`, `npm --prefix`. No deny rule or hook blocks these; they would run.
`cd` first so command history reads consistently.

**Enforced by hook (the call fails):** chaining `cd <path> && git <command>` in a single
Bash call. Claude Code hardcodes a prompt for the `cd`+`git` compound, and the inline
PreToolUse hook in `settings.json` denies it outright (with a `/worktrees/` exemption).
Splitting into two separate calls is the zero-prompt path, not a time cost: a lone `cd` into
a path under the working directory and read-only git (`status`/`log`/`diff`) are both
built-in read-only commands that never prompt, and the working directory persists between
calls. (`git -C <path>` would also be promptless but is avoided per the convention above.)

**Enforced by deny rule (the call fails):** `python3 -c` and `python -c` — use built-in
tools or `_tmp_` scripts instead.
