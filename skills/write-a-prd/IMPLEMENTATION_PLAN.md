# Skill Comparison: `write-a-prd` vs `write-prd-1.0.0`

## Context

Comparing the current `/write-a-prd` skill against the downloaded OrchestKit `write-prd-1.0.0`
package to understand what each offers and identify anything worth adopting.

**Scope:** Integrate the best features of the downloaded skill (INVEST criteria, Gherkin acceptance 
criteria, DoR/DoD checklists, scope clarification) while preserving the current skill's core 
strengths (codebase verification, module design). Additionally, extend the skill to handle defect 
specs (bug fix PRDs) as a new capability, applying the same interview + verification methodology 
to root-cause analysis and fix design.

---

## At a Glance

| Dimension | Current (`write-a-prd`) | Downloaded (`write-prd-1.0.0`) |
|---|---|---|
| **Author** | Custom / Willis | OrchestKit v2.0.0 (MIT) |
| **Focus** | Engineering PRD — implementation-ready spec | Product strategy PRD — market/business-oriented |
| **Structure** | Single `SKILL.md` | Multi-file: `SKILL.md` + `references/` + `rules/` + `test-cases.json` |
| **Process** | 5-step sequential interview + codebase verification | Scope clarification upfront, then template-fill |
| **Codebase awareness** | Yes — Step 2 verifies Sir's assertions by reading actual code | None — external product tool |
| **PRD sections** | 7 (Problem, Solution, User Stories, Implementation Decisions, Testing Decisions, Out of Scope, Further Notes) | 8 (Summary, Contacts, Background, Objective, Market Segments, Value Propositions, Solution, Release) |
| **User story format** | Free-form numbered list | INVEST criteria + Gherkin (Given/When/Then) acceptance criteria |
| **Module design** | Explicit Step 4 — deep module identification | Not present |
| **Strategy tools** | — | Value Prop Canvas, Go/No-Go gate, Build vs Buy vs Partner matrix |
| **Allowed tools** | `Read Grep Glob Agent AskUserQuestion Write` | Adds `Bash WebFetch WebSearch TaskCreate TaskUpdate Edit` + MCP memory tools |
| **Memory integration** | None | `mcp__memory__` nodes — stores/retrieves prior PRDs |
| **Task tracking** | None | `TaskCreate` / `TaskUpdate` per PRD |
| **Test cases** | None | `test-cases.json` with 3 scenarios |
| **Output filename** | `<feature-slug>.prd.md` (confirmed with Sir) | `PRD-[product-name].md` |

---

## What the Downloaded Skill Has That the Current Skill Lacks

### 1. Scope clarification upfront (Step 0)
The download asks: Full PRD / Lightweight spec / User stories only / Update existing PRD.
The current skill always runs the full 5-step interview. A lightweight mode would save time
for small tickets.

### 2. INVEST criteria for user stories
User stories are validated against Independent, Negotiable, Valuable, Estimable, Small, Testable.
The current skill has no quality bar for stories — a user story can be vague and still pass.

### 3. Gherkin acceptance criteria (Given/When/Then)
Each story gets explicit scenario-level acceptance criteria. The current skill's "User Stories"
section has no acceptance criteria at all — stories are written but not testable assertions.

### 4. Definition of Ready / Definition of Done checklists
6-item DoR (before sprint) and 7-item DoD (after dev). Not present in the current skill.

### 5. Structured reference files
`references/prd-template.md`, `references/user-stories-guide.md`, `references/value-prop-canvas-guide.md`
keep the SKILL.md itself concise. The current skill embeds everything inline, making SKILL.md
long and harder to maintain.

### 6. Test cases
`test-cases.json` specifies expected outputs for 3 scenarios. The current skill has no
automated test surface.

---

## What the Current Skill Has That the Downloaded Skill Lacks

### 1. Codebase verification (Step 2)
The most important structural difference. The current skill reads actual source files before
accepting any claim about the system. The download is an external product tool with no repo
awareness — it would produce PRDs based on Sir's memory, not verified code state.

### 2. Module design step (Step 4)
Explicit identification of deep modules: what gets built, what interface it exposes, what
gets tested, what is explicitly excluded. This is what makes the PRD "implementation-ready."

### 3. Testing Decisions section
Which modules get tests, prior art for test patterns, and the principle (test external
behavior, not internals). The download has acceptance criteria at the story level but no
engineering test-scope section.

### 4. Willis/ARC context
Language, constraints, and reversibility rules are tailored to this project. The download
is a generic external tool; it would require sanitizing before it fits.

### 5. Irreversibility guard
The current skill explicitly distinguishes reversible (exploration) from irreversible (Write)
actions and requires path confirmation before writing. The download's `Write` call is
unconditional.

---

## Assessment: What's Worth Adopting

Strong candidates to backport into the current skill:

| Element | Why | Where it fits |
|---|---|---|
| **Scope clarification (Step 0)** | Avoids running the full interview for a one-pager | Add as Step 0 with 3 modes: full / lightweight / user-stories-only |
| **INVEST quality bar** | Prevents vague stories from shipping in the PRD | Add as a validation pass during Step 3 before writing |
| **Gherkin acceptance criteria** | Makes each story independently testable — aligns with the Testing Decisions section | Add acceptance criteria block inside User Stories section of the template |
| **DoR / DoD checklists** | Engineering handoff completeness check | Append to Testing Decisions section |
| **Split references into separate files** | Keeps SKILL.md scannable; template and guides become independently editable | Extract `prd-template.md` and `user-stories-guide.md` into `references/` under the skill directory |

**Why Mode D (Defect Spec) Belongs:**
Mode D reuses the skill's core strength — codebase verification + design grounding — for bug fixes. 
A defect spec follows the same 5-step interview + module design logic, but oriented toward:
- **Problem:** the bug's observable behavior and impact (vs. feature need)
- **Root cause:** verified by code inspection (Step 2)
- **Solution:** the fix's design and affected modules (Step 4)
- **Testing:** regression test + verification strategy
This is a natural extension of the skill's interview-driven, code-grounded methodology. It stays within the skill's core competency without adding new tools or processes.

**Mode D Output Template:**
Mode D uses the same 7-section PRD template as Mode A, with one substitution:
- **"User Stories" section becomes "Defects"** — describes the bug (observable behavior, reproduction steps) and acceptance criteria for the fix (in Gherkin format: Given/When/Then). Same structure and validation (INVEST criteria, Gherkin acceptance criteria, DoR/DoD) as Mode A's User Stories, applied to defect resolution.

**Mode D Output Filename:**
Mode D outputs the same filename format as Mode A: `<defect-slug>.prd.md` (e.g., `null-pointer-parser.prd.md`). Both feature PRDs and defect specs use the `.prd.md` extension since both produce implementation-ready specifications.

Do NOT adopt:

| Element | Why not |
|---|---|
| Market Segments, Contacts, Value Propositions, Release | Business/product-manager sections — not the output Willis produces |
| Go/No-Go gate, Build vs Buy vs Partner | Strategic decision tools — out of scope for an engineering PRD skill |
| `mcp__memory__` tools | Not in Willis's MCP toolset |
| `TaskCreate` / `TaskUpdate` | Adds overhead to a skill that already has a clear end state (the written file) |
| `WebFetch` / `WebSearch` | The skill is codebase-scoped — external research belongs in a separate research step |

---

## Recommended Changes (if adopting)

1. **Add `references/` directory** alongside `SKILL.md`:
   - `references/prd-template.md` — extract the `<prd-template>` block
   - `references/user-stories-guide.md` — INVEST criteria + Gherkin format

2. **Add Step 0** (scope selection via `AskUserQuestion`):
   Users invoke `/write-a-prd [description]`; Step 0 menu displays three mode options:
   - Mode A: Full PRD (all 5 steps) — features, enhancements, architectural decisions
   - Mode C: User stories only (Step 1 + Step 3 only; output is stories + acceptance criteria) — uses same 7-section template as Mode A, but Steps 2 and 4 are skipped, so Implementation Decisions and Testing Decisions sections remain empty/omitted
   - Mode D: Defect spec (all 5 steps, tailored for bug fixes) — root cause verification + fix design
   
   User selects mode; skill routes to appropriate steps (Steps 1–5 configured per mode). Template structure remains consistent across modes; interview pathway and section population vary per mode., similar to Mode A but problem-oriented

3. **Strengthen User Stories section** of the PRD template:
   - Add INVEST validation before writing
   - Add acceptance criteria sub-block per story (Given/When/Then)

4. **Append DoR/DoD to Testing Decisions section** of the template.

---

## Verification

Implementation readiness checklist. After all four recommended changes are implemented:
- Invoke `/write-a-prd` on a real ARC ticket and step through the full flow
- Verify Step 0 correctly routes to each of the three modes (A, C, D)
- Verify acceptance criteria (INVEST + Gherkin) appear in Mode A and Mode D output PRDs
- Verify Mode C output includes only user stories + acceptance criteria (no other sections)
- Verify the existing codebase verification and module design steps still run in Mode A and Mode D
- Verify the existing 5-step interview structure is respected across all modes
