# Skill Auditor — Rubrics A–E (Behaviorally Anchored)

This is the reference companion for `SKILL.md`. Read this file once at the start
of each audit run, before Phase 2 scoring.

## How to use this rubric (read first)

**This is a Behaviorally Anchored Rating Scale (BARS).** Each criterion lists its
levels as concrete, observable behaviors. You do not rate "how good" on a feeling
— you match the artifact to the anchor whose description it satisfies, then assign
that anchor's number.

**AUDIENCE RULE (binding; added 2026-06-08 after the cisco-ios probe).** Every
criterion that asks whether the skill "instructs", "guards", "scopes", or
"grounds" evaluates instructions that govern **Claude's own in-session
behavior**. Domain guidance addressed to the HUMAN OPERATOR's real-world
procedure (e.g. "capture the device's current state before changing it",
"apply the smallest change in a maintenance window" — steps a person performs
on external equipment) is CONTENT, not a Claude-directed mechanism. It can
never satisfy C5 (read-before-claim), C6's level-2 (output-scope bound), C2,
or similar criteria UNLESS the line also explicitly directs Claude's conduct
("read the snippet before asserting anything about it"). When you cite a line
for such criteria, your evidence must say which audience it addresses. (For C6
specifically: an operator-directed parsimony line still earns the level-1
"presence" credit; it cannot earn level 2.)

**Scoring is evidence-forced (strictest mode). For every criterion you MUST record:**
1. **Score** — the matched anchor's number, OR the mark **`U` (UNRESOLVED)** when
   the ground truth needed to score the line is genuinely unavailable (file not
   readable, auth/runtime fact not checkable from the artifact, external contract
   out of reach). `U` is NOT a low score — it means "could not verify," and it is
   **excluded from the denominator** (do not score it 0). This mirrors
   red-blue-judge's PASS/FAIL/UNRESOLVED split and its rule "ambiguity never
   defaults to PASS" — here, ambiguity never defaults to a number at all. Use `U`
   only for true inaccessibility, never to dodge a hard call you *can* make from
   the text.
2. **Evidence** — either a quoted line from the artifact (≤15 words, with its
   line number) that satisfies the anchor, OR, when the score is driven by
   absence, the literal token `ABSENT:` followed by what you searched for and did
   not find. For a `U` mark, state precisely what ground truth was missing
   (`UNRESOLVED: D4 auth lives in settings.json, not provided this run`).
   A score with neither a quote nor an `ABSENT:`/`UNRESOLVED:` note is invalid —
   re-read the file.
3. **Doc rule** — the Anthropic documentation rule the anchor enforces, by name
   (e.g. "Frontmatter reference — valid field set", "best-practices — third
   person"). If a criterion's anchor enforces no doc rule, it is labeled
   **[house]** below and you cite "house methodology" instead. This forces an
   honest line between doc-compliance and editorial preference.

**Scale widths are gated on decidability, not uniform.** A criterion uses more
than three levels ONLY where each extra level has a *countable or otherwise
decidable* anchor (so two runs land identically). Binary doc rules (a name
contains a reserved word or it does not) use 0/1/2; criteria with a genuinely
countable spectrum (number and diversity of examples) use 0–4. Each criterion
states its width and *why* in a `Scale:` line so the choice is auditable.

**Provenance.** The *rules* enforced are Anthropic documentation (Frontmatter
reference, Skill authoring best practices, Skills overview, MCP docs). The
*anchors that describe degrees of compliance* are this auditor's house
methodology and are not an Anthropic standard. Anthropic publishes authoring
guidance but no official skill score, scale, or denominator.

**Target surface:** Claude Code (the 99.9% case). Field validity and limits below
are the Claude Code set. If a skill is explicitly destined for the API/claude.ai,
apply the stricter API field set (`name` + `description` only) and note it.

**Field-set last verified:** 2026-06-06 against
`code.claude.com/docs/en/skills` (Frontmatter reference) and
`platform.claude.com/docs/en/agents-and-tools/agent-skills/{overview,best-practices}`.
Re-verify the field table on each major audit wave; it is the part most likely to drift.

---

## Rubric A — SKILL.md Structure & Progressive Disclosure
*(Doc sources: Claude Code Frontmatter reference; Skill authoring best practices;
Skills overview "How Skills work".)*

### A1 — Frontmatter is valid and uses only documented fields
**Scale: 0/1/2** — binary doc rule (a key is in the documented set or it is not;
the file parses or it does not). No decidable middle gradation beyond "present
but unnamed."
**Doc rule:** Frontmatter reference (valid Claude Code field set); `description`
is the one recommended field.

> **SCRIPT-DECIDED.** Do not score A1 by inspection. Run the bundled
> `validate_frontmatter.py` on the target file and transcribe its `A1` score and
> evidence verbatim. The anchors below document what the script implements; they
> are not an invitation to re-derive the score. A scorecard whose A1 differs
> from the script output is invalid.

- **0** — Frontmatter is missing, does not open/close with `---`, fails YAML
  parse, OR contains any key not in the documented Claude Code set:
  `name`, `description`, `when_to_use`, `argument-hint`, `arguments`,
  `disable-model-invocation`, `user-invocable`, `allowed-tools`,
  `disallowed-tools`, `model`, `effort`, `context`, `agent`, `hooks`, `paths`,
  `shell`. (Common stale/invalid keys: `version`, `author`, `tags`, `tools`.)
- **1** — Parses and all keys are valid, but `description` is absent (skill falls
  back to first body paragraph — works, but undiagnosed discovery risk).
- **2** — Parses, opens/closes with `---`, every key is in the documented set,
  and `description` is present.

*Note:* `model`, `effort`, `context`, `agent`, `hooks`, `paths`, `shell`,
`disallowed-tools`, `user-invocable` are VALID in Claude Code — never flag them
as invalid. For API/claude.ai targets only `name`+`description` are valid; there,
score 0 if any Claude-Code-only field is present.

### A2 — Name is compliant and precise
**Scale: 0/1/2** — the hard limits are binary (charset, ≤64 chars, reserved
words); "precise vs vague" is the only soft axis and collapses to one partial level.
**Doc rule:** best-practices "Skill structure" (name ≤64 chars, lowercase /
numbers / hyphens only, no reserved words `anthropic`/`claude`) + naming
conventions. Per the docs, gerund form (`processing-pdfs`) is *preferred* but noun
phrases (`pdf-processing`, `spreadsheet-analysis`) and action-oriented names
(`process-pdfs`) are listed as **acceptable alternatives** — so a precise
noun-phrase name is fully compliant, NOT a partial. Only *vague/generic* names are
penalized. The gerund preference is **[house]**-weighted as a tiebreaker only.

> **HARD RULES SCRIPT-DECIDED.** `validate_frontmatter.py` decides the 0-level
> (charset, length, reserved words): if `A2_hard.hard_pass` is false, A2 = 0
> with the script's violations as evidence — final. Only when it passes do you
> judge the single soft axis below: precise (2) vs vague/generic (1).

- **0** — `name` (or the directory name it defaults to) contains uppercase,
  spaces, or special characters; OR exceeds 64 characters; OR contains the
  reserved word `anthropic` or `claude`.
- **1** — Charset/length/reserved-word rules all pass, but the name is vague
  (`helper`), generic (`tool`, `utils`, `data`, `files`), or so broad it doesn't
  identify the capability.
- **2** — Passes all hard rules and names the capability precisely. Gerund
  (`processing-pdfs`), noun phrase (`pdf-processing`, `skill-auditor`), and
  action-oriented (`process-pdfs`) forms are all acceptable; do not demote a
  precise name for not being a gerund.

*Decision rule for the 1/2 soft axis (added 2026-06-07 after CLI-parity
splits):* "vague" means GENERIC-SOFTWARE words (`helper`, `tool`, `utils`,
`assistant`, `manager`, `data`, `files`, `misc`) or a name whose scope is much
broader than what the body actually covers. A single domain word that
accurately names the body's actual scope (e.g. `accessibility` for a skill
entirely about accessibility implementation) IS precise — score 2. Do not
demote a name for being one word or a domain label when it matches the body.

### A3 — Description is trigger-precise, third-person, within limits
**Scale: 0–4** — decidable spectrum: person (binary), trigger cues (countable:
none / generic / specific phrases), and length (measurable against 1,536).
Each level below is checkable, so the extra width is earned.

> **0-GATES SCRIPT-DECIDED (Phase 2).** `validate_frontmatter.py` emits an
> `A3_mech` block: combined description+`when_to_use` character count vs 1,536
> and first/second-person detection. A `GATE-FAIL` verdict means **A3 = 0,
> transcribed verbatim — no judgment.** On `GATES-PASS` you judge ONLY the 1–4
> ladder (trigger/task-type counting + lead-sentence position), citing the
> script's char count in evidence.
**Doc rule:** best-practices "Writing effective descriptions" (third person;
include what + when; specific triggers) + Frontmatter reference (combined
`description`+`when_to_use` truncated at 1,536 chars).

- **0** — No `description`, OR it exceeds 1,536 chars combined with `when_to_use`
  (silent truncation drops trigger cues), OR it is written in first/second person
  ("I can help…", "You can use this…").
- **1** — Third person and within length, but states only what the skill does
  with NO "when to use" / trigger cues.
- **2** — Third person, within length, has what + a generic "when to use" but
  names no concrete user phrases or task types.
- **3** — Third person, within length, names ≥1 concrete trigger phrase/task type,
  but the primary capability is NOT stated in the first sentence (it appears only
  after trigger lists or secondary detail).
- **4** — Third person, within length, the first sentence states the primary
  capability, AND the description names two or more concrete trigger phrases/task
  types.
*Decidability note: "leads with" = primary capability appears in sentence 1 (a
positional check); trigger phrases are counted. Both are decidable from the text.*

*Definition of "leads with capability" (added 2026-06-08 after a [3,4]
split): the requirement is met iff SENTENCE 1 of the description contains a
capability verb applied to an object (design/implement/audit/generate/review/
analyze/设计/实施/审计/生成…+ object) OR a noun phrase that itself names the
capability/deliverable ("Cisco IOS review patterns for show commands…" leads
with the capability even though it is verbless). Demote to 3 ONLY when
sentence 1 is preamble/background and the capability appears later.*

*Definition of "concrete trigger phrase/task type" (added 2026-06-07 after
observed 2-vs-4 splits):* EITHER a quoted user phrasing ("review my skills")
OR a named task type — a verb+object naming a thing the user would ask for
("generate semantic ARIA", "audit code for compliance", "design components").
A description like "design, implement, and audit X… generate Y for Web and
native platforms" names ≥2 task types and satisfies the trigger requirement;
quoted user phrases are sufficient but NOT required. Count the task types in
the evidence cell.

### A4 — Progressive disclosure: Level-2 body stays lean
**Scale: 0/1/2** — the 500-line target is a measurable threshold with one partial
band for "over but salvageable."
**Doc rule:** best-practices "Progressive disclosure patterns" (SKILL.md body
under 500 lines; split when approaching) + Skills overview Level-2 (<5k tokens).

- **0** — Body exceeds ~500 lines AND inlines heavy reference material (API
  dumps, large tables, full datasets) that has no linked file.
- **1** — Body is over ~500 lines but the overflow is cohesive prose that could
  stay, OR body is under 500 lines but inlines one reference block that clearly
  belongs in a Level-3 file.
- **2** — Body is under ~500 lines and pushes heavy reference material into linked
  files; reads like a table of contents, not the manual.

### A5 — Supporting (Level-3) files are purposeful and referenced
**Scale: 0/1/2** — "every file referenced with when-to-read" is binary per file;
the partial covers "referenced but no when-to-read."
**Doc rule:** Skills overview Level-3 (files loaded only when referenced) +
best-practices "high-level guide with references."

- **0** — Files exist in the skill directory that SKILL.md never references
  (dead weight Claude won't discover), OR SKILL.md references a file that does
  not exist (dangling pointer).
- **1** — Every bundled file is referenced, but at least one reference lacks
  "when to read this" guidance (Claude can't tell when to load it).
- **2** — Every bundled file is referenced from SKILL.md with explicit when-to-read
  guidance; no dangling pointers. (Skills with no Level-3 files score 2.)

### A6 — Deterministic work lives in executable scripts, not inlined code
**Scale: 0/1/2** — "fragile/repeated code is a runnable script vs inlined" is
binary; partial covers "script exists but run-vs-read intent unclear."
**Doc rule:** Skills overview Level-3 ("scripts… executed via bash; the script
code never enters context") + best-practices "set appropriate degrees of freedom"
(low-freedom fragile ops as exact scripts).

- **0** — Deterministic/fragile/repeated operations are written as inline code
  blocks for Claude to re-derive each run, where a script would be reliable.
- **1** — Scripts exist, but SKILL.md does not make clear whether Claude should
  *run* them (output only) or *read* them as reference.
- **2** — Deterministic ops are in executable scripts invoked via bash, with the
  run-vs-read intent explicit. (Skills with no deterministic ops score 2.)

### A7 — Evaluate-first design
**Scale: 0/1/2** — presence of success criteria/tests is binary; partial covers
"informal success notion, no examples or eval."
**Doc rule:** best-practices "Test with all models you plan to use" + Skills
overview (skills tested with real usage). **[house]**-weighted on the specific
"include test cases" phrasing.

- **0** — No success criteria, no examples, no eval approach; output quality is
  unverifiable.
- **1** — Documents what "success" looks like in prose, but no examples or test cases.
- **2** — Includes test cases / eval criteria OR concrete examples that let a
  human verify the primary task's output.

*Decision rule (2026-06-08, after [0,1,2] split): A7 = 2 if the file contains
EITHER a B8-qualifying success artifact (checklist / pass-fail questions /
before-after checks) OR at least one concrete worked artifact — for A7 a
realistic code/config block counts even when it fails B5's stricter
scenario-paired definition (A7 asks "can a human verify the output", not "is
this a few-shot example"). A7 = 1 only when success exists solely as prose
description; 0 when neither. Score A7 AFTER B5 and B8 and cite the same
artifacts.*

### A8 — Security: trust and scope documented
**Scale: 0/1/2** — "external action + trust boundary stated" is binary; partial
covers "external action acknowledged but scope vague."
**Doc rule:** best-practices runtime/environment notes + Skills overview
(filesystem/bash/code-execution capability). **[house]**-weighted on explicit
trust-boundary phrasing.

- **0** — Skill fetches URLs, calls external tools, or runs code with no statement
  of trust assumptions or scope of action.
- **1** — Acknowledges external action exists but does not bound the scope or name
  the trust assumption.
- **2** — States trust assumptions and scope for any external fetch / tool call /
  code execution. (Skills with no external action score 2.)

### A9 — Body voice is portable (no hardcoded addressee or single-user voice)
**Scale: 0/1/2** — decidable by a token search: a hardcoded proper-name addressee
or honorific is either present in the body or it is not.
**Doc rule:** **[house]** — extends the *spirit* of the doc's third-person
description rule (mixed/locked point-of-view harms reuse) to the SKILL.md body,
plus the Opus-4.8 "literal instruction following" note (the model takes a baked-in
addressee literally). Anthropic states the third-person rule for the
*description* only; applying it to the body is this auditor's portability
standard, not a published rule.

- **0** — The body repeatedly addresses a specific named person or honorific
  ("Sir", "Boss", a proper name) as the user, OR is written so it only makes sense
  for one specific operator. A skill meant to be reusable/shareable should address
  "the user" / "you", not a fixed individual.
- **1** — One or two incidental named-addressee tokens that don't pervade the
  skill (easy to neutralize), OR a voice quirk that is stylistic but not blocking
  reuse.
- **2** — Body addresses a generic user ("the user", "you") throughout; no
  hardcoded individual addressee. (A skill genuinely scoped to a single named
  operator by design, and documented as such, also scores 2.)
*Evidence: grep the body for honorifics/proper names used as the addressee; report
the count and the lines, or `ABSENT: no hardcoded addressee found`.*


*(Doc source: Anthropic Prompting best practices,
`platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices`
— the single current reference for Claude Opus 4.8 / 4.7 / 4.6, Sonnet 4.6, Haiku
4.5. Rules below re-verified against it 2026-06-06.)*

### B1 — Role is assigned
**Scale: 0/1/2** — role present/generic/specific is a clean three-band.
**Doc rule:** prompting best-practices (assign a role / system prompt persona).

- **0** — No role set anywhere in frontmatter or body.
- **1** — A role is set but generic ("You are a helpful assistant").
- **2** — A specific, capability-matched role is set ("You are an expert Claude
  Code architect performing an evidence-based audit").

### B2 — Task, intent, and constraints are stated upfront in one block
**Scale: 0/1/2** — consolidated-upfront vs scattered vs absent.
**Doc rule:** prompting best-practices (be clear and direct; put the task and
constraints first).

*BINARY as of Phase 2 (adjudicated 2026-06-08 after 60% corpus agreement).*
One decidable question: **does the opening block state WHAT the task is AND
name the governing constraint set/standard?**

*Definition of "opening block" (fixed 2026-06-08 after a [0,2] split on its
boundary): the body intro plus the FIRST TWO `##` sections, regardless of what
they are named.* A governing standard stated in section 2 (e.g. an "Operating
Rules" section right after "When to Use") IS in the opening block.

*Definition of "task statement" (fixed 2026-06-08 after a second [0,2] split):
any sentence naming what the skill/Claude DOES — a capability verb applied to
an object ("this skill ensures/designs/audits/implements/reviews X", 确保/设计/
审计/实施/专注于…的实现). A descriptive "this skill ensures interfaces are
perceivable…" sentence IS a task statement; an imperative directive is NOT
required. "Scope-only" is a 0 only when no such verb+object sentence exists in
the opening block.*

- **0** — No: the task statement or governing standard is missing from the
  opening block (stated late, split, or only implied).
- **2** — Yes: both present in the opening block. Point-of-use constraint
  detail inside later steps never demotes — that is locality, not scattering.

Evidence must quote the opening block and name which element is present/absent.
(There is no 1 anchor; the old middle band was the disagreement.)

### B3 — Context and motivation ("why") are provided
**Scale: 0–4** — SCRIPT-COUNTED as of Phase 2 (adjudicated 2026-06-08 after 25%
corpus agreement).

> **SCRIPT-DECIDED.** `validate_frontmatter.py` emits a `B3_count` block: it
> counts top-level bullets/numbered steps outside code fences and tables as
> major instructions, matches a fixed rationale-marker lexicon, computes R, and
> names the band. **Transcribe its score verbatim** (when it reports R > 0.85
> it caps at 3 and you may raise to 4 only if at least one rationale states a
> generalizing principle). If the verdict is `NO COUNTABLE STRUCTURE`, judge
> from prose using the definitions below and write "judged fallback" in the
> evidence. The script's structural proxy is deliberately crude but fixed —
> the same file always gets the same B3.

The judged-fallback definitions: a **major
instruction** = a numbered step heading, or a top-level bullet/sentence that
opens with an imperative verb, located OUTSIDE example blocks, checklists,
tables, and code fences (those never count, in numerator or denominator;
sub-clauses never count). Count once per step/bullet, not per sentence. An
instruction **carries rationale** iff its sentence/bullet contains an explicit
reason marker — "because", "so that", "to avoid", "since", "otherwise", "this
ensures/prevents", or an em-dash clause stating a consequence. Score by the
integer ratio `R = (major instructions with a rationale marker) / (major
instructions)`. Both counts are countable from the text, so two runs land
identically.
**Doc rule:** Prompting best practices — give Claude motivation/context so it can
generalize; literal-instruction guidance ("state the scope explicitly").

- **0** — R = 0 (no major instruction carries a rationale marker).
- **1** — 0 < R ≤ 0.25.
- **2** — 0.25 < R ≤ 0.50.
- **3** — 0.50 < R ≤ 0.85.
- **4** — R > 0.85 AND at least one rationale is written to generalize (states a
  principle, not just a local reason).
*Record the two counts in the evidence cell, e.g. `ABSENT/COUNT: 7 of 9 major
instructions carry a marker → R=0.78`.*

### B4 — XML tags separate content types
**Scale: 0/1/2** — none / partial / systematic.
**Doc rule:** prompting best-practices (use XML tags to structure prompts).

- **0** — Prose wall or markdown headers as the only structure; no named tags.
- **1** — Some content is tagged but instructions, examples, and inputs are not
  consistently separated.
- **2** — Instructions, context, examples, and variable inputs are wrapped in
  named XML tags (`<instructions>`, `<examples>`, `<context>`, `<input>`).

### B5 — Examples are few-shot, diverse, and tagged
**Scale: 0–4** — fully countable: number of examples, tagged-or-not, and edge-case
coverage are all literally countable, so 5 bands are decidable.
**Doc rule:** prompting best-practices (provide diverse few-shot examples,
including edge cases; tag them).

*Definitions (added 2026-06-07; revised after CLI-parity splits):*
- An **example** is a worked demonstration with BOTH halves present: a stated
  case/scenario/input AND the artifact or output produced for it. Schemas,
  templates, placeholder specs, symptom lists, command references, and
  checklists are NOT examples. *Boundary rule (2026-06-08): a bare code/config
  block — even a realistic one — is a reference/template unless it is paired
  with its concrete scenario; "here is an ACL pattern" = reference (not an
  example), "for a guest-WiFi subnet like X, this ACL results" = example.
  A category/platform LABEL is NOT a scenario: "Web: accessible search (form)"
  or "iOS button" headings over code blocks are labels — those blocks remain
  references/templates. A scenario states a concrete case with particulars,
  not a type.* If the file has only references/templates, B5 = 0.
- **Order of evaluation (2026-06-08, fixes a [0,1] two-routes split): FIRST
  decide example-vs-reference with the two-halves + label rule. Content that
  fails it is a reference → it can NEVER reach the untagged-cap path → B5 = 0
  when nothing qualifies. The untagged hard cap applies ONLY to content that
  already qualifies as an example.**
- **Tagged** means wrapped in named XML tags (`<example>`, `<examples
  label=…>`). Markdown headers (`###`), bold labels, and code fences are NOT
  tags. If you call examples "tagged", your evidence must name the XML tag.
- Evidence must state three counts/facts: number of examples, tagged yes/no
  (with the tag name), number of distinct edge cases.

- **0** — No examples (per the definition above).
- **1** — Exactly one example, OR examples present but untagged. (HARD CAP:
  untagged examples can never exceed 1, regardless of count or quality.)
- **2** — Multiple tagged examples, but all show the same happy-path pattern
  (no edge case).
- **3** — Multiple tagged examples covering the happy path plus exactly one edge case.
- **4** — Multiple tagged examples covering the happy path plus two or more
  *distinct* edge cases (errors, empty input, conflict, etc.).

### B6 — Positive framing: says what to do, not only what to avoid
**Scale: 0/1/2** — mostly-negative / mixed / positive-with-alternatives.
**Doc rule:** prompting best-practices (tell Claude what to do instead of what not to do).

*BINARY as of Phase 2 (adjudicated 2026-06-08 after 71% corpus agreement).*
One decidable question: **does ANY prohibition lack an adjacent positive
alternative (same bullet or adjacent sentence)?**

- **0** — Yes: one or more prohibitions (don't/never/avoid/仅…/禁止-style
  lines) has no adjacent alternative.
- **2** — No: every prohibition pairs with an alternative, OR the file contains
  no prohibitions at all (vacuous pass — say so).

Universal quantifier, not a vibe: enumerate the prohibitions, check each.
Evidence must cite the count, e.g. "4 prohibitions, 1 unpaired (L118)".

*Adjacency is STRICT (2026-06-08): same bullet or immediately adjacent
sentence ONLY. An alternative that exists elsewhere in the body does NOT pair
a prohibition. A labeled Anti-Patterns/反模式 list whose bullets carry no
inline alternative = unpaired prohibitions → 0, regardless of how positive the
rest of the document is. Noun-phrase anti-pattern bullets ("Applying X without
Y") count as prohibitions.*

### B7 — Long data at top, query at bottom
**Scale: 0/1/2** — applies only to long-input prompts; correct-order / no-guidance / wrong-order.
**Doc rule:** prompting best-practices (place long documents before the query).

- **0** — Query/instructions appear before long input content.
- **1** — Accepts long inputs but gives no ordering guidance.
- **2** — Long data is placed above instructions and query. (Prompts with no
  long-input pattern score 2.)

### B8 — Success criteria are defined
**Scale: 0/2 — BINARY as of Phase 2** (adjudicated 2026-06-08 after 62% corpus
agreement; the old "informal" middle band was the disagreement).
**Doc rule:** prompting best-practices (define what success looks like).

One decidable question: **does the file contain ANY explicit success artifact —
a checklist, a rubric, a pass/fail statement, or verifiable example output?**

- **0** — No: nothing in the file defines "done" or "correct" beyond vibes.
- **2** — Yes: at least one explicit success artifact exists (a checklist of
  verifiable items counts, even informally worded — e.g. "24x24px minimum" is
  pass/fail checkable).

*Artifact definition (2026-06-08): a SUCCESS ARTIFACT is any list/statement
whose items can each be answered pass/fail about the produced work — a
checklist, a set of review questions ("Is there an explicit permit before the
implicit deny?"), or before/after verification checks ALL qualify. A purely
procedural step list ("1. do X, 2. do Y") does NOT — steps tell you what to
do, not how to tell it was done correctly.*

Evidence quotes the artifact (or ABSENT: what was searched for).

### B9 — Effort / thinking depth (and `effort`/`model` fields) match task complexity
**Scale: 0/1/2** — under-specified / present-but-mismatched / matched. Covers both
prompted thinking guidance AND the frontmatter `effort`/`model` fields, because
those set the skill's token spend and capability for its turn (a complex skill
pinned to `effort: low` under-thinks; a trivial one at `max` burns tokens).
**Doc rule:** Prompting best practices (Opus-4.8 effort guidance: "`xhigh` for
coding/agentic use cases, minimum `high` for intelligence-sensitive"; "respects
effort strictly, especially at the low end") + Frontmatter reference (`effort`,
`model` fields). Verified 2026-06-06.

- **0** — Complex agentic/coding task with no thinking/effort guidance and no
  `effort` field (risks under-thinking), OR a trivial task pinned to `xhigh`/`max`
  or weighed down with heavyweight CoT boilerplate (burns tokens), OR an `effort`/
  `model` field set in clear opposition to the task (e.g. `effort: low` on a
  multi-step audit skill).
- **1** — Thinking/effort guidance or an `effort`/`model` field is present but
  mismatched to the task's actual complexity (e.g. `medium` on an intelligence-
  sensitive task the doc says wants `high`+).
- **2** — Effort is appropriate for the task — either via an `effort`/`model`
  field set sensibly (`high`/`xhigh` for complex/agentic; lower for scoped/
  latency-sensitive) or via explicit reasoning guidance — with no needless
  overhead on simple tasks. A skill that omits the fields and inherits a sensible
  session effort also scores 2.
*Evidence: cite the `effort`/`model` field if present (line) or `ABSENT: no effort/
model field` plus the body's thinking guidance, and state the task-complexity read.*

### B10 — Formatting instructions use positive framing
**Scale: 0/1/2** — negative-only / partial / positive.
**Doc rule:** prompting best-practices (describe desired format positively).

- **0** — Output format described only negatively ("no bullet points").
- **1** — Mix of positive format spec and bare prohibitions.
- **2** — Output format described as what it should be ("write in flowing prose
  paragraphs").

---

## Rubric C — Agent Design
*(Doc sources: Prompting best practices — "agentic systems" / tool-use / effort /
subagent guidance, same canonical doc as Rubric B; Claude Code subagents and
skills docs. Re-verified 2026-06-06.)*

### C1 — Subagent scope is clearly bounded
**Scale: 0/1/2** — undefined / role-only / role+tools+done.
**Doc rule:** subagents docs (single focused role; declared tools; clear "done").

- **0** — Subagent role undefined or attempts to do everything.
- **1** — Single role stated, but tool access or "done" condition is unspecified.
- **2** — Single focused role with declared tool access and an explicit "done"
  definition. (Skills with no subagent score 2.)

### C2 — Reversibility guard is present
**Scale: 0/1/2** — none / partial / explicit two-tier.
**Doc rule:** agentic best-practices (distinguish reversible autonomous actions
from irreversible/shared actions needing confirmation).

*Applicability rule (added 2026-06-07 after observed 0-vs-2 splits):* C2 binds
ONLY when the skill instructs actions on SHARED or EXTERNAL state — push to
remote, delete files, post/send to external services, deploy, write to a
database, modify system settings. Local, session-reviewed code edits and
advisory/guidance content are reversible by definition: if the skill instructs
nothing beyond those, C2 = 2 (vacuous pass) — do NOT score 0 for "no
reversibility policy" on a skill with nothing irreversible to police.

- **0** — Instructs shared/external actions with no distinction; blanket
  autonomy or blanket restriction.
- **1** — Mentions caution on some destructive action but no clear reversible-vs-
  irreversible policy.
- **2** — Explicitly separates reversible actions (edit, test) Claude may take
  autonomously from irreversible/shared actions (push, delete, post) needing
  confirmation; OR the skill instructs no shared/external actions at all
  (vacuous pass — say so in evidence).

### C3 — Parallel tool calls are guided
**Scale: 0/1/2** — none / partial / explicit parallel+sequential rule.
**Doc rule:** parallel tool use docs + agentic best-practices.

- **0** — No guidance on parallelism for fan-out tasks.
- **1** — Mentions parallelism but does not distinguish independent (parallel)
  from dependent (sequential) calls.
- **2** — Instructs independent tool calls in parallel and dependent ones
  sequentially. (Single-tool skills score 2.)

### C4 — State management is explicit
**Scale: 0/1/2** — implicit / partial / explicit-store+orientation.
**Doc rule:** agentic best-practices (persist state; let a fresh context reorient).

*Applicability rule (added 2026-06-07 after observed 0-vs-2 splits):* a
"multi-step task" for C4 means work that SPANS context windows or sessions —
resumable campaigns, long-running migrations, multi-file waves, or anything
whose intermediate results must survive an interruption. A procedure whose
steps all complete within a single response/session (an in-context checklist or
step list, however many steps) is SINGLE-STEP for C4 → score 2 (vacuous pass;
say so in evidence). Score 0 only when the skill plausibly spans contexts AND
leaves state implicit.

- **0** — State handling implicit/absent for a task that spans contexts/sessions
  (loss risk).
- **1** — Names where state lives but not how a fresh context window reorients.
- **2** — Specifies where state persists (git, JSON, memory tool) AND how a fresh
  context orients. (Skills whose work completes in one session score 2.)

### C5 — Hallucination guard is present
**Scale: 0/1/2** — none / general-accuracy / read-before-claim.
**Doc rule:** agentic best-practices (ground claims; read before asserting).

*Applicability rule (added 2026-06-07; tightened 2026-06-08 after [0,2]
splits):* C5 BINDS when any use case in the file directs Claude to make claims
about external artifacts — auditing/reviewing code, analyzing files, reporting
on systems. **A when-to-use bullet alone is sufficient to bind** ("audit
existing code" in a use-case list binds C5 even if no body section
operationalizes it — do NOT argue the body never gets there). C5 is VACUOUS
(score 2, say so) only when NO use case and NO instruction anywhere has Claude
assert anything about a user artifact. **The satisfying mechanism must direct
CLAUDE to read/inspect the artifact before asserting (AUDIENCE RULE):
operator-directed procedures ("capture the device's state", "confirm the
platform") can NEVER satisfy C5.** Anchor 1's "general accuracy
instruction" means an explicit instruction sentence in the file (e.g. "be
accurate", "verify before reporting") — the mere fact that the skill's domain
content is factual does NOT count as an accuracy instruction.

- **0** — Binds, and no grounding/accuracy instruction exists; free to assert
  facts about unopened files/systems.
- **1** — Binds, and a general "be accurate"-type instruction exists without a
  read-before-claim mechanism.
- **2** — Explicit "read the file before making claims about it; never speculate
  about unopened code." OR C5 does not bind (vacuous pass).

### C6 — Overengineering is constrained
**Scale: 0/1/2** — none / general-brevity / explicit-minimum-change.
**Doc rule:** agentic best-practices (scope to the minimum change; avoid
unrequested abstractions).

- **0** — NOTHING in the file constrains scope — no simplicity, parsimony,
  prefer-the-simpler-option, or stay-on-task instruction of any kind.
- **1** — ANY general simplicity/parsimony instruction is present (e.g. "prefer
  native elements before custom", "keep it simple"), even if it is not framed as
  a task-scope bound. Quote the line. **Operator-directed parsimony ("apply the
  smallest change on the device") is HARD-CAPPED at 1 per the AUDIENCE RULE —
  it can never reach 2 no matter how explicit it is.**
- **2** — Explicitly scopes CLAUDE'S OWN OUTPUT to the minimum change and
  forbids unrequested abstractions/files/future-proofing.

*Decision rule (added 2026-06-07 after observed 0-vs-1 splits):* the 0/1
boundary is presence, not quality — if you can quote any parsimony line, it is
a 1. Quality of the constraint is the 1/2 boundary.

### C7 — Tool-use triggering is explicit
**Scale: 0/1/2** — implicit / named-only / named+when.
**Doc rule:** tool-use docs + agentic best-practices (name tools and when to use each).

- **0** — Tools available but triggering left entirely implicit.
- **1** — Names the tools/connectors but not when to use each (or when-guidance
  exists for only a subset of the named tools).
- **2** — Names specific tools/MCP connectors AND describes when to use each;
  OR the skill references no tools/connectors at all (vacuous pass — a pure
  knowledge/reference skill has nothing to trigger; do NOT invent an obligation
  to name tools it does not use; say "vacuous" in evidence).

---

## Rubric D — MCP Connector Usage  *(applies only when the skill uses MCP)*
*(Doc sources: MCP connector docs; Claude Code MCP docs.)*

### D1 — Each connector is named and its purpose stated
**Scale: 0/1/2**, with a hard auto-fail floor.
**Doc rule:** MCP docs (name the server and its purpose); dead-prefix list below.
**Auto-fail (score 0, overrides anchors):** any occurrence of
`mcp__claude_ai_Atlassian__` (retired claude.ai gateway) or `mcp__c9b44d58-*`
(deregistered 2026-05-07 plugin) in `allowed-tools`, examples, or prose. Canonical
live prefix is `mcp__atlassian__`.

- **0** — MCP servers appear in settings but are never named/explained in the
  skill, OR a dead prefix is present (auto-fail).
- **1** — Server named but its purpose/usage boundary is vague.
- **2** — Every MCP server is named with a stated purpose and usage boundary
  ("use the Jira MCP to read issues and post comments; do not call the API directly").

### D2 — Tool allowlist/denylist is scoped
**Scale: 0/1/2.**
**Doc rule:** MCP docs (scope to needed tools).

- **0** — All MCP tools enabled with no scoping consideration.
- **1** — Partial scoping; some unused tools left enabled without comment.
- **2** — References only the specific tools needed, or explicitly justifies needing all.

### D3 — Trust boundary is documented
**Scale: 0/1/2.**
**Doc rule:** MCP docs + prompt-injection guidance (treat external-fetched content
as untrusted).

- **0** — External-fetching MCP used with no injection-risk acknowledgment.
- **1** — Mentions external content but gives no "treat as untrusted" instruction.
- **2** — Notes injection risk and instructs Claude to treat fetched content as
  untrusted input. (Non-fetching connectors score 2.)

### D4 — Authentication approach is documented
**Scale: 0/1/2.**
**Doc rule:** Claude Code MCP docs (auth via settings/OAuth/env).

- **0** — No auth documentation; a new user/instance couldn't connect.
- **1** — Auth mentioned but mechanism/location unspecified.
- **2** — States the auth mechanism and where it lives (settings token, OAuth, env var).
- **U** — Auth correctness depends on settings/environment not provided this run;
  mark UNRESOLVED (excluded from denominator) and list in Remaining Gaps. Do not
  score 0 for the auditor's lack of access.

### D5 — Connector is exercised, not just referenced
**Scale: 0/1/2.**
**Doc rule:** MCP docs + best-practices (show concrete tool-call usage).

- **0** — Connector mentioned but no example tool call/workflow.
- **1** — A usage pattern is described in prose but no concrete call shown.
- **2** — At least one concrete tool call/workflow example is present.

---

## Rubric E — Settings & Permissions Compliance  *(always applies)*
*(Doc sources: `~/.claude/settings.json` hierarchy; tool-substitution rules.
Scores grounded in the Phase-1 permission profile.)*

### E1 — allowed-tools matches what the skill can and does use
**Scale: 0/1/2** — checks both directions: nothing declared that's denied, and
nothing *used in the body* that's undeclared (an undeclared tool the skill needs
triggers a mid-run permission prompt — a latency/functionality hit, not just
cosmetics).
**Doc rule:** settings hierarchy (allow/deny lists) + Frontmatter reference
(`allowed-tools` = tools usable without a prompt while the skill is active).

> **DENY-DIRECTION SCRIPT-DECIDED.** `validate_frontmatter.py` cross-checks the
> declared `allowed-tools` against the live deny list: a `deny_hits` entry means
> the 0-anchor's first clause is met — E1 = 0 with that evidence, final.
> Verdict table (apply mechanically):
> - `VACUOUS-PASS` (no allowed-tools declared): the deny-direction passes by
>   rule — settings availability is IRRELEVANT when nothing is declared. Judge
>   only the body-usage direction; if the body also uses no non-default tools,
>   E1 = 2. Do NOT score 1 for missing settings in this case.
> - `DENY-HIT`: E1 = 0, final.
> - `UNRESOLVED` (tools declared but no settings file): absent-settings rule —
>   score 1, cannot fully verify.
> The body-usage direction (used-but-undeclared, declared-but-unused) is always
> model-judged from the body text — under the PORTABLE-ARTIFACT rule below.

> **PORTABLE-ARTIFACT RULE (adjudicated 2026-06-08 after the defect-recall
> miss).** The body-usage direction is judged as if the skill were installed on
> a FRESH machine with DEFAULT permissions: the only excused tool uses are
> (a) Claude Code's default toolset and (b) entries in the skill's OWN
> `allowed-tools`. **The auditing machine's local allow list can NEVER excuse
> an undeclared tool use** — a verdict must not change with the auditor's
> machine. A body instruction to run any shell command (e.g. `git status`),
> any `mcp__` call, or any permission-gated tool that is not declared in the
> skill's frontmatter = used-but-undeclared → the 0 anchor's second clause is
> met. (The local settings remain authoritative ONLY for the deny-direction
> above and for E3's denied-command check, which are inherently local
> questions.)

- **0** — Frontmatter declares a tool that is in the global deny list, OR the body
  clearly invokes a non-default tool (a `Bash(...)` command, an `mcp__` call, or a
  tool requiring permission) that is NOT in `allowed-tools` and not otherwise
  pre-approved — i.e. the skill will stall for a permission prompt mid-run.
- **1** — Declares a tool that is neither allowed nor denied (permission gap), OR
  declares tools the body never uses (harmless noise, but flag it).
- **2** — Every tool the body uses is either a default tool or present in
  `allowed-tools` and on the allow list; nothing declared is denied; no needed
  tool is undeclared.
*Evidence: cross-check the `allowed-tools` line against tool invocations in the
body; report any used-but-undeclared or declared-but-unused, or `ABSENT: body uses
only default tools, allowed-tools consistent`.*

### E2 — MCP references use canonical live prefixes
**Scale: 0/1/2**, dead-prefix auto-fail.
**Doc rule:** active MCP prefix list; dead-prefix list (see D1).

- **0** — Any dead prefix (`mcp__claude_ai_Atlassian__`, `mcp__c9b44d58-*`) appears
  (auto-fail), regardless of other evidence.
- **1** — Prefix is plausible but not confirmed in the active prefix list.
- **2** — All MCP references match live, settings-allowed prefixes exactly.

### E3 — No denied Bash commands instructed or implied
**Scale: 0/1/2.**
**Doc rule:** deny list + substitution table below.

- **0** — Skill explicitly instructs a denied command (`find`, `head`, `tail`,
  `awk`, `sed`, `rg`, `python3 -c`).
- **1** — Instructs a shell op that a denied command could satisfy, without naming one.
- **2** — No denied commands; built-in tools used throughout.

Substitution table (apply in Phase 3):

| Denied command | Replacement |
|---|---|
| `find` (pattern matching) | `Glob` |
| `grep` / `rg` (content search) | `Grep` |
| `cat` / `head` / `tail` (read) | `Read` with `offset`+`limit` |
| `sed` / `awk` (text replace) | `Edit` |
| `echo >` / `cat <<EOF` (write) | `Write` |
| `python3 -c` / `python -c` | write to `_tmp_*.py`, run, delete |

### E4 — Plugin references match enabled plugins
**Scale: 0/1/2.**
**Doc rule:** `enabledPlugins` in settings.

- **0** — References a plugin not in `enabledPlugins`.
- **1** — Mentions a plugin-provided skill/tool without naming the plugin.
- **2** — All plugin dependencies are in `enabledPlugins`, or skill is plugin-independent.

### E5 — Non-standard permissions documented with a resolution path
**Scale: 0/1/2.**
**Doc rule:** settings hierarchy (document required entries + target file).

- **0** — Non-standard permission needed, no documentation of what/where to add.
- **1** — Noted in prose but no specific entry or file path.
- **2** — Documented with a copy-pasteable entry and the target settings file, via a
  `<!-- permission-required: ... -->` note. (Skills needing none score 2.)

---

## Scoring & Reporting

**Per-criterion max varies by width.** Record each as `score/max`. Rubric maxima:

- A: A1,A2 ×2 + A3 ×4 + A4–A9 ×2 = 4+4+12 = **20**
- B: B3,B5 ×4 + B1,B2,B4,B6,B7,B8,B9,B10 ×2 = 8+16 = **24**
- C: C1–C7 ×2 = **14**
- D (when MCP used): D1–D5 ×2 = **10**
- E (always): E1–E5 ×2 = **10**

**Report both** (no single sacred total):
1. **Raw weighted points** per rubric and overall (e.g. `A 16/20, B 19/24, C 12/14,
   E 8/10 → 55/68`). D included only when MCP is used. **Any criterion marked `U`
   is removed from both numerator and denominator** — e.g. if D4 is `U`, Rubric D
   is scored out of 8, not 10 — so the auditor's blind spots never inflate or
   deflate the skill's score. List every `U` in Remaining Gaps with the missing
   ground truth.
2. **Normalized percentage** per rubric and overall (`55/68 = 81%`). Use the % for
   cross-skill comparison in a wave, since widths differ and `U`-adjusted
   denominators differ between runs.

Maximum overall: **78** (A20+B24+C14+D10+E10) with MCP; **68** without MCP.

*These totals are house methodology — Anthropic publishes no skill score. The %
exists for comparison only; the per-criterion anchors are the real output.*

---

## A-Rubric Phase 3 Resolution Guidance

- **A1 (invalid field):** strip any key outside the documented Claude Code set
  (`version`, `author`, `tags`, `tools`→`allowed-tools`); add `description` if
  missing. Never strip valid fields (`model`, `effort`, `context`, `agent`,
  `hooks`, `paths`, `shell`, `disallowed-tools`, `user-invocable`, `when_to_use`,
  `arguments`, `argument-hint`). Correct typos of valid fields rather than deleting.
- **A2 (name):** lowercase/hyphenate; ≤64 chars; remove `anthropic`/`claude`;
  prefer gerund; add an explicit compliant `name` if the directory default is bad.
- **A3 (description):** rewrite to third person; lead with key use case + concrete
  triggers; trim combined description+`when_to_use` to ≤1,536 chars (overflow
  triggers move to `when_to_use`, still under the cap).
- **A4 (lean body):** move oversized inline content to `references/<topic>.md`,
  leave a one-line pointer.
- **A5 (support files):** add when-to-read pointers; create or remove dangling links.
- **A6 (scripts):** extract deterministic code to `scripts/<name>`; make run-vs-read explicit.

## E-Rubric Phase 3 Resolution Guidance

- **E1:** remove deny-listed entries from `allowed-tools`; for gaps (score 1) add a
  `<!-- permission-required -->` comment naming the entry and target settings file.
- **E2:** replace dead/wrong MCP prefix with the canonical live prefix.
- **E3:** replace denied commands with built-in equivalents per the substitution table.
- **E4:** if plugin not in `enabledPlugins`, remove the reference or note it must be enabled.
- **E5:** add `<!-- permission-required: Bash(cmd:*) → ~/.claude/settings.json
  permissions.allow -->` adjacent to the affected instruction, exact key format.
