# Skill Auditor — Rubrics A–E

This is the reference companion for `SKILL.md`. The skill-auditor SKILL.md
references this file during Phase 2 (Pre-Improvement Scoring) and Phase 4
(Post-Improvement Scoring). Read this file once at the start of each audit run
to load every criterion before scoring.

---

## Rubric A — SKILL.md Structure
*(Source: Anthropic Engineering "Equipping agents for the real world with
Agent Skills" + Claude Code Skills docs)*

**A1 — Valid YAML frontmatter**
Pass: File begins with `---`, contains `name` and `description` fields, ends
with `---` before body content. Fail: Missing frontmatter, missing fields, or
YAML syntax error.

**A2 — Name is a clean slash-command identifier**
Pass: `name` is lowercase, hyphen-separated, no spaces, no special characters,
describes the capability precisely (e.g., `jira-commit`, `design-review`).
Fail: Vague (`helper`), generic (`tool`), or contains spaces/uppercase.

**A3 — Description is trigger-precise**
Pass: Description tells Claude *when* to load the skill (specific
task/context cues) AND *what* it does. It is slightly "pushy" — it names
concrete user phrases or task types that should trigger it, not just what
it does in the abstract. Fail: Description is only a feature summary with
no trigger cues, or it is so broad it would fire on unrelated tasks.

**A4 — Progressive disclosure: body stays lean**
Pass: SKILL.md body is under 500 lines. Heavy reference material is split
into separate files in the skill directory and referenced by name. Fail:
Body exceeds 500 lines with no linked files, or large reference blocks are
inlined when they could be external.

**A5 — Supporting files are purposeful and clearly referenced**
Pass: Every file in the skill directory is referenced from SKILL.md with
explicit guidance on when Claude should read it. Fail: Files exist in the
skill directory but are not referenced, or references lack "when to read"
context.

**A6 — Code/scripts are separated from instructions**
Pass: Deterministic or repetitive operations are in executable scripts
(Python, bash) that Claude runs rather than re-derives from scratch. The
SKILL.md makes clear whether Claude should *run* a script or *read* it as
reference. Fail: Long code blocks are inlined in SKILL.md when they belong
in a script, or the run-vs-read distinction is absent.

**A7 — Evaluate-first design**
Pass: The skill either (a) includes test cases / eval criteria, or (b) the
SKILL.md documents what "success" looks like for the skill's primary task so
a human can evaluate outputs. Fail: No success criteria, no examples, no
eval approach.

**A8 — Security: trust and scope**
Pass: If the skill calls external tools, fetches URLs, or runs code, it
notes what trust assumptions are being made and what the scope of action is.
Fail: Skill instructs Claude to connect to external sources or run arbitrary
code with no trust boundary documentation.

---

## Rubric B — Prompt Engineering
*(Source: Anthropic Prompting Best Practices — claude-4-best-practices)*

**B1 — Role is assigned**
Pass: A clear role is set in the system prompt or at the top of the SKILL.md
body (e.g., "You are a senior Java architect…"). Fail: No role, or role is
generic ("You are a helpful assistant").

**B2 — Task, intent, and constraints are upfront in one block**
Pass: The first substantive instruction block states what to do, why, and
what the hard constraints are — all together, before any examples or
procedural steps. Fail: Constraints are scattered throughout the document,
or intent is only implied.

**B3 — Context and motivation are provided**
Pass: The prompt explains *why* each major instruction matters, not just
what to do. Claude can generalize from the explanation. Fail: Instructions
are bare commands with no rationale.

**B4 — XML tags are used to separate content types**
Pass: Instructions, context, examples, and variable inputs are wrapped in
named XML tags (`<instructions>`, `<examples>`, `<context>`, `<input>`).
Fail: Prompt is a wall of prose or uses markdown headers as the only
structural mechanism.

**B5 — Examples are few-shot, diverse, and tagged**
Pass: 3–5 concrete examples wrapped in `<example>` tags that cover the
happy path and at least one edge case. Fail: No examples, examples are
untagged, or all examples show the same pattern.

**B6 — Positive framing: tells Claude what to do, not what to avoid**
Pass: Instructions describe the desired output format and behavior directly.
Fail: Instructions are primarily negative ("do not use markdown", "never
output X") with no positive alternative specified.

**B7 — Long data goes at the top, query at the bottom**
Pass: For prompts that accept long documents or large context, the data is
placed above the instructions and query. Fail: Query appears before the
document content, or no ordering guidance for variable-length inputs.

**B8 — Success criteria are defined**
Pass: The prompt specifies what a correct/excellent output looks like,
either via examples, a rubric, or an explicit pass/fail description. Fail:
No definition of "done" or "correct."

**B9 — Effort / thinking depth is appropriate for the task**
Pass: For complex multi-step tasks, the prompt either (a) uses `xhigh`/`high`
effort, or (b) includes explicit reasoning guidance ("think step by step
through X before answering"). For simple tasks, no unnecessary thinking
overhead is added. Fail: Complex agentic task with no thinking guidance, or
simple task with heavyweight CoT boilerplate.

**B10 — Formatting instructions use positive framing**
Pass: Output format is described as what it should be
("Write in flowing prose paragraphs"). Fail: Format is only described
negatively ("Do not use bullet points").

---

## Rubric C — Agent Design
*(Source: Anthropic Prompting Best Practices — Agentic Systems section)*

**C1 — Subagent scope is clearly bounded**
Pass: Each subagent has a single, focused role. The skill or prompt
specifies what tools the subagent has access to, and what "done" means for
that subagent. Fail: Subagent role is undefined or tries to do everything.

**C2 — Reversibility guard is present**
Pass: The prompt explicitly distinguishes between reversible actions (edit
files, run tests) that Claude can take autonomously, and irreversible or
shared-system actions (push to remote, delete, post externally) that require
confirmation. Fail: No distinction made; Claude is given blanket autonomy
or blanket restriction.

**C3 — Parallel tool calls are guided**
Pass: For tasks that fan out across multiple files or sources, the prompt
instructs Claude to call independent tools in parallel. Dependencies are
called sequentially. Fail: No guidance on parallelism, leaving it entirely
to model defaults.

**C4 — State management is explicit**
Pass: For multi-step or multi-window tasks, the prompt specifies where state
is persisted (git, structured JSON file, memory tool) and how a fresh context
window should orient itself. Fail: State management is implicit or absent,
creating risk of lost progress.

**C5 — Hallucination guard is present**
Pass: Prompt includes an instruction to read files before making claims
about them (e.g., "Never speculate about code you have not opened. Read the
file before answering."). Fail: No grounding instruction; Claude is free to
assert facts about files or systems without verification.

**C6 — Overengineering is constrained**
Pass: Prompt scopes Claude to the minimum change needed. It explicitly
discourages adding unrequested abstractions, extra files, or future-proofing
that was not asked for. Fail: No scope constraint; prompt allows or
encourages Claude to "improve" beyond the task boundary.

**C7 — Tool use triggering is explicit**
Pass: The prompt names the specific tools or MCP connectors Claude should
use and describes when to use each. Fail: Tools are available but the prompt
leaves triggering entirely implicit.

---

## Rubric D — MCP Connector Usage
*(Source: Anthropic MCP Connector docs + Claude Code MCP docs)*

**D1 — Each connector is named and its purpose is stated**
Pass: The skill or CLAUDE.md names every MCP server it relies on and says
what it uses it for ("Use the Jira MCP to read issue details and post
comments — do not use the API directly."). Fail: MCP servers are listed in
settings but never referenced or explained in the skill.
**Dead-prefix violation (automatic D1 fail):** Any occurrence of
`mcp__claude_ai_Atlassian__` in `allowed-tools`, tool call examples, or prose
is an automatic D1 fail — this prefix refers to the retired claude.ai gateway
that no longer exists and fails silently. The canonical live prefix is
`mcp__atlassian__`.
**Dead-prefix violation (automatic D1 fail):** Any occurrence of
`mcp__c9b44d58-*` in `allowed-tools`, tool call examples, or prose
is an automatic D1 fail — this UUID-based prefix refers to the retired
`atlassian@claude-plugins-official` plugin (deregistered 2026-05-07) and fails silently.

**D2 — Tool allowlist / denylist is configured**
Pass: The skill either references only the specific tools it needs from each
MCP server, or explicitly acknowledges all tools are needed. Fail: All MCP
tools are enabled with no consideration of scope.

**D3 — Trust boundary is documented**
Pass: If the MCP server fetches external content (URLs, webhooks, user
data), the skill notes that prompt injection risk exists and instructs Claude
to treat that content as untrusted input. Fail: External-fetching MCP
servers are used with no injection risk acknowledgment.

**D4 — Authentication approach is documented**
Pass: The skill or its companion notes how authentication is handled
(token in settings, OAuth, environment variable). Fail: No auth
documentation; a new user or Claude instance would not know how to
connect.

**D5 — Connector is exercised, not just referenced**
Pass: The skill includes at least one concrete example of a tool call or
workflow that uses the MCP connector, so Claude knows the expected usage
pattern. Fail: Connector is mentioned but no example of actual tool
invocation is given.

---

## Rubric E — Settings & Permissions Compliance
*(Source: `~/.claude/settings.json` hierarchy + `tooling.md` tool-substitution rules)*

This rubric always applies. Scores are grounded in the permission profile built in Phase 1.

**E1 — allowed-tools frontmatter declares only available tools**
Pass: Every entry in the skill's `allowed-tools:` frontmatter is present in the global
allow list. Any `Bash(command:*)` entry must not appear in the deny list.
Fail (score 0): Frontmatter declares a tool that is in the global deny list.
Partial (score 1): Frontmatter declares a tool that is neither allowed nor denied (permission
gap — needs to be added to settings).
Pass (score 2): All declared tools are confirmed present in the allow list, or no
`allowed-tools` is declared and the skill needs none beyond the defaults.

**E2 — MCP tool references use canonical live prefixes**
Pass: Every MCP tool name referenced in the skill body, `allowed-tools`, or examples uses
a prefix that is (a) present in the permission profile's active MCP prefix list and (b) is
not a known dead/retired prefix.
**Dead-prefix automatic E2 fail:** `mcp__claude_ai_Atlassian__` and `mcp__c9b44d58-*`
(see D1 for detail). Any occurrence is score 0 regardless of other evidence.
Partial (score 1): Prefix appears plausible but is not confirmed in the active MCP prefix
list — may be a new addition not yet in settings.
Pass (score 2): All MCP references match live, settings-allowed prefixes exactly.

**E3 — No denied Bash commands are instructed or implied**
Pass: Skill body does not instruct, suggest, or imply use of any command in the global
deny list. Where file operations are needed, the skill directs Claude to use the built-in
tool equivalents per the substitution table below.
Fail (score 0): Skill explicitly instructs a denied command (e.g., `find`, `head`, `tail`,
`awk`, `sed`, `rg`, `python3 -c`).
Partial (score 1): Skill instructs a shell operation that could be satisfied by a denied
command but does not name one explicitly (ambiguous).
Pass (score 2): No denied commands referenced; built-in tools used throughout.

Substitution table (apply in Phase 3 fixes):

| Denied command | Replacement |
|---|---|
| `find` (pattern matching) | `Glob` |
| `grep` / `rg` (content search) | `Grep` |
| `cat` / `head` / `tail` (read file) | `Read` with `offset` + `limit` |
| `sed` / `awk` (text replace) | `Edit` |
| `echo >` / `cat <<EOF` (write file) | `Write` |
| `python3 -c` / `python -c` | write to `_tmp_*.py`, run, delete |

**E4 — Plugin references match enabled plugins**
Pass: If the skill references or depends on functionality provided by a plugin (e.g.,
`superpowers@claude-plugins-official`, `comprehensive-review@claude-code-workflows`),
that plugin is confirmed present in `enabledPlugins` in `settings.json`.
Fail (score 0): Skill references a plugin that is not in `enabledPlugins`.
Partial (score 1): Skill mentions a plugin-provided skill or tool but does not explicitly
name the plugin — dependency is implicit.
Pass (score 2): All plugin dependencies are in `enabledPlugins`, or skill is
plugin-independent.

**E5 — Non-standard permissions are documented with a resolution path**
Pass: If the skill requires tools or Bash commands not in the global allow list, the skill
body includes a `<!-- permission-required: ... -->` note or a visible callout that names
the exact `settings.json` entry to add and which file to add it to (`~/.claude/settings.json`
for global, project `.claude/settings.json` for project scope).
Fail (score 0): Non-standard permissions needed but no documentation of what to add or where.
Partial (score 1): Non-standard permissions noted in prose but no specific entry or file path given.
Pass (score 2): All non-standard requirements documented with a copy-pasteable entry and
the target settings file. Skills that require no non-standard permissions score 2 automatically.

---

## Scoring Denominators

Base score (Rubrics A+B+C): /50.
Rubric D adds /10 when MCP is used.
Rubric E adds /10 always.
Maximum possible: /70 (all rubrics apply); /60 (no MCP connectors used); /50 (A+B+C only,
which is rare since E always applies in practice).

## E-Rubric Phase 3 Resolution Guidance

- **E1 violations:** Remove from `allowed-tools` any entry confirmed in the deny list. For
  permission-gap entries (score 1), add a `<!-- permission-required -->` comment in the
  frontmatter noting the missing entry and target settings file.
- **E2 violations:** Replace dead/wrong MCP prefix with the canonical live prefix from the
  active MCP prefix list. This is always a direct in-file fix.
- **E3 violations:** Replace denied shell commands with built-in tool equivalents using the
  substitution table above. This is always a direct in-file fix.
- **E4 violations:** If the plugin is not in `enabledPlugins`, either remove the reference or
  add a note that the plugin must be enabled first.
- **E5 violations:** Add a `<!-- permission-required: Bash(cmd:*) →
  ~/.claude/settings.json permissions.allow -->` comment adjacent to the affected
  instruction. Use the exact settings key format.
