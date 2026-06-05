# ✦Dioscuri✦ Identity Architecture — Design Spec

> **✦Dioscuri✦ — One body. Two souls.**
> *Formerly "Claude OS." The product is **Dioscuri**: one shared immortal body, two
> deliberately distinct souls (one per machine — work and home). The name is the Greek
> collective for Castor and Pollux — "the twins as one" — which is precisely §2's
> conceptual model.*
>
> **Scope of this rename pass:** brand + §2 conceptual layer only. The engineering
> identifiers and paths that still carry the old name — the `claude-os` repo slug,
> `~/.claude-data/`, `~/.claude/`, the `audit-claude-os` skill, and the
> `CLAUDE_OS_HOOK_DEPTH` env var (itself a live §7 rename target) — are **deliberately
> left untouched here.** Renaming them is a real filesystem/identifier migration, not a
> doc edit, and would collide with the §7 purge and falsify the verified `file:line`
> facts in §5/§8/§9. Tracked as a follow-up (see §10).

**Date:** 2026-06-05
**Issue:** [#25 — Agent name is hardcoded in audit tooling, breaking the deliberate two-agent personality split](https://github.com/JasonFulksFamilySearch/claude-os/issues/25)
**Status:** Design approved (brainstorming complete) — pending written-spec review before implementation planning
**Verification:** Passed two adversarial gates, both folded in. (1) Red-blue-judge (mode: plan,
cycle 1) — REVISE on the incomplete purge inventory (P3). (2) Five-lens design review with
per-finding adversarial verification (24 agents) — 8 material findings raised, 3 confirmed against
real `file:line` (repoint `identity-check`; purge still missed `mcp-health-audit:191`; heal-backup
collides with `update.sh` Step 5 cleanup), 5 collapsed to minor/dropped under skeptical re-check.
All three confirmed fixes are folded into §6–§9; the worthwhile minors (JSON-write safety, defensive
read, `uninstall.sh` symmetry, anchor-sync) are folded in as sub-points.

---

## 1. Problem

The two-machine design — **Willis** (work Mac) and **Walter** (home Mac), same capabilities but
*deliberately different personalities* — is undermined by the agent name being **hardcoded where
it should be derived**. The `identity-check` skill's rubric assumed "Willis," so a machine
provisioned as "Walter" failed its own audit, and the audit output could not be trusted.

This is **not a rename**. It is a *shared-vs-per-machine boundary leak*: the agent name is a
per-machine value, but consumers carried their own hardcoded copies instead of reading the live
value.

### Root cause (deeper than the issue stated)

The agent name lives **only as prose** — two lines in `~/.claude-data/agent/CLAUDE.md`:

```
# Agent Identity — Walter
You are Jason's agent on the macelabs-macair. Your name in this configuration is Walter.
```

There is **no machine-readable source of truth**. No JSON key, no YAML frontmatter, no parseable
field. Every consumer that needs the name must either regex-parse prose (fragile — reword line 1
and every derived name breaks) or hardcode a copy (the bug). Commit `c6e2399` removed the literal
"Willis" from 13 skill/hook files but replaced it with generic prose ("the agent") — it gave
consumers nothing to *derive from*. They now read the name from nowhere; they simply stopped
naming anyone. The acceptance criterion "all read from the live identity file" is therefore **not
met** by that commit.

### Why it matters beyond cosmetics

`review-performance` and `audit-claude-os` are the graded checks other rules lean on for
enforcement (e.g. `~/.claude/rules/communication.md`). The Anthropic memory docs confirm
CLAUDE.md is *"context, not enforced configuration"* — so audit-based enforcement is inherently
soft, and a **corrupted audit gives false confidence**, which is worse than no audit. A nameless
audit silently passes anything; it cannot grade against *Walter, specifically*.

---

## 2. Conceptual model — the Dioscuri (Castor & Pollux)

**Dioscuri** — Greek *Dioskouroi*, "sons of Zeus," the collective name for the twins Castor and
Pollux. It names the pair *as one unit* while staying inherently two: one shared origin, two
distinct persons. That is the product, exactly — **✦Dioscuri✦: one body, two souls.**

The shared body is **the day**; the two machines are positions within it — the same system observed
at different points in its cycle. In the myth, Pollux (immortal) shares his immortality with Castor
(mortal) so both persist as one constellation: same origin, genuinely two beings, each manifesting
in a different realm, never both in the same place at once.

The two realms are the **work machine** and the **home machine** — same shared body, deliberately
different souls. Which archetype maps to which machine is a per-machine matter, not a property of
the shared model, and is therefore *not* fixed here.

| Mythic layer | What it is | Where it lives | Same on both twins? |
|---|---|---|---|
| **The shared immortality** | Dioscuri — tooling, git, behavioral, operating rules, skills, hooks | `claude-os` repo + rendered neutral body | **Yes** — identical |
| **The twin's soul** | Persona: Disposition, Pushback, Style of work, Address, Appreciation | Per-machine personality file | **No** — the deliberate deviation |
| **Which twin** | The name (Walter / Willis) | One parseable anchor every consumer derives from | **No** — per machine |

**The governing rule:** the shared body never *contains* a name or a persona trait. It only ever
*references* them. Castor's name is never carved into the shared constellation.

---

## 3. Confirmed maintainer intent (ground truth)

1. **Canonical naming:** Willis = work, Walter = home, different *by design*. The fix is
   "derive the name," **not** "rename the agent to match the skill."
2. **No shared/rendered/templated config** may reference "Willis" or "Walter" literally.
   Everything in the shared body becomes the product name (**Dioscuri**; literal string still
   "Claude OS" in current code until the identifier rename lands — §10) / "the agent." The **only**
   allowed literal names are: (a) README/docs prose describing the two-machine architecture as a
   fact, and (b) machine-local *rendered* artifacts (e.g. `~/.claude/rules/communication.md` on
   this machine).
3. **The persona moves into a separate per-machine personality file**, distinct from the shared
   body.
4. **The repo ships a neutral persona template** (with `${AGENT_NAME}` placeholders + skeleton).
   `install.sh` renders it per-machine; the actual personality *deviation* is hand-tuned per
   machine after render. The repo stays name-free and carries only a neutral skeleton.
5. **Soul durability — accept the asymmetry.** `update.sh` *preserves* a hand-tuned personality
   file; a fresh `install.sh` *reverts* it to the skeleton. No backup machinery. The machine owns
   its soul, the way a local-only file does.
6. **Authoring the two distinct personalities is out of scope** — the maintainer owns that. This
   work builds the *vessel + plumbing* only.

---

## 4. File architecture

```
claude-os repo  (SHARED — name-free, persona-free, checked in):
  templates/
    CLAUDE.md          → NEUTRAL BODY only: Tooling, Command exec, Git, Skill workflow,
                         Behavioral, Voice, "what doesn't belong". Keeps the line-1 name
                         anchor as a /compact safety net. Adds an @-import of the persona:
                             @~/.claude-data/agent/personality.md
    personality.md     → NEW. Neutral persona SKELETON with ${AGENT_NAME}/${USER_NAME}
                         placeholders (Disposition, Pushback, Style of work, Address,
                         Appreciation) + a banner comment: "per-machine soul; hand-tune the
                         deviation after render."

MACHINE-LOCAL  (rendered by install.sh, NOT in repo, per-twin):
  ~/.claude-data/agent/
    CLAUDE.md          → rendered neutral body (canonical).
    personality.md     → rendered persona, then HAND-TUNED per twin (this is where Walter ≠ Willis).
    identity.json      → NEW parseable anchor:
                         { "agent_name": "Walter", "user_name": "Jason",
                           "machine_desc": "macelabs-macair" }
  ~/.claude/
    CLAUDE.md          → MUST become a real symlink → ~/.claude-data/agent/CLAUDE.md
                         (today it is a stale, divergent COPY — see §5, finding F).
```

---

## 5. Verified codebase facts

Established by parallel read-only investigation and confirmed during the RBJ review:

- **A.** Persona is not a standalone file today — it lives as prose sections inside the identity
  file (template `CLAUDE.md`).
- **B.** Agent name exists only as the two prose lines quoted in §1. No parseable field.
- **C.** `install.sh` prompts for `AGENT_NAME`/`USER_NAME`/`MACHINE_DESC` and renders
  `templates/CLAUDE.md` via `envsubst` to `~/.claude-data/agent/CLAUDE.md`. `symlink_path`
  (install.sh:188–191) backs up an existing regular file to `${link}.pre-claude-os` before
  symlinking.
- **D.** `update.sh` **never overwrites** the identity file. It regex-parses it
  (`sed -n 's/^# Agent Identity — \(.*\)$/\1/p'`, update.sh:243) to re-render rule templates.
  Fragile.
- **E.** Commit `c6e2399` changed 13 skill/hook files: removed literal "Willis", replaced with
  generic prose. Verified via `git show` — created **no** derivation helper and **no**
  `identity.json`. Two hardcoded sites survive it in `hooks/rule-enforcement.sh`:
  `WILLIS_HOOK_DEPTH` (lines 12, 29, 33) and a line-214 comment "the Willis identity file."
- **F.** `~/.claude/CLAUDE.md` is **not** a symlink — it is a regular file (7944 bytes, dated
  May 12) diverging from canonical `~/.claude-data/agent/CLAUDE.md` (same size, dated Jun 1).
  Two copies already drifting: a second, quieter instance of the same bug class.
- **G.** A stale `~/.claude/CLAUDE.md.pre-phase3-20260512-180751.bak` exists; flagged for deletion.

### Authoritative Anthropic memory-docs facts (`code.claude.com/docs/en/memory`)

- CLAUDE.md is *"context, not enforced configuration."* Audit-based enforcement is inherently soft.
- *"If two rules contradict each other, Claude may pick one arbitrarily."* (Walter-vs-Willis is
  exactly this class.)
- `@path` imports are *"loaded into context at launch"*; absolute paths allowed; recursion depth
  4; first-encounter approval dialog. The docs **do not** state imports survive `/compact`.
- Project-root CLAUDE.md *"survives compaction… re-reads it from disk and re-injects."* This
  guarantee is stated for CLAUDE.md, **not** for its imports.
- `~/.claude/rules/*.md` with no `paths:` frontmatter is *"loaded at launch with the same priority
  as `.claude/CLAUDE.md`,"* *"loaded before project rules."*

---

## 6. Design decisions

- **D1 — Body `@`-imports persona, but keeps the one name line inline as a `/compact` safety net.**
  The docs do not guarantee imports re-inject on compact. Belt-and-suspenders: worst case the
  agent still knows its name; best case it keeps the full soul. The mitigation is correct
  *regardless* of whether imports survive compact, so the design does not hinge on the
  unverifiable docs claim.
- **D2 — `identity.json` is the single parseable anchor, and it is canonical.** It gives every
  consumer (`update.sh`, the audit skills, hooks) one machine-readable field to read `agent_name`
  from, instead of prose-parsing or hardcoding. This work wires **both** `update.sh` (§8.D) **and
  `identity-check`** (§8.E) to it; that closes issue #25's named consumer rather than leaving the
  anchor theoretical. **Precedence rule (resolves the two-name-sources concern from the design
  review):** `identity.json` is canonical for machine consumers; the prose line-1 anchor is a
  human-readable mirror that `install.sh` writes from the same vars — never the reverse. `update.sh`
  asserts the two agree each run and warns loudly on divergence (§8.D.5), so a hand-edit to line 1
  is caught, not silently arbitrated. The line-1 anchor's *other* job (the `/compact` safety net,
  D1) is unaffected — it serves the model in-context, not the script read-path.
- **D3 — `identity.json` is authored in `install.sh`,** at the one moment the values are known
  with certainty (human input), not derived in `update.sh`. One-time migration: if `identity.json`
  is absent, derive it *once* from the existing prose anchor, write it, then read it forever after.
  Already-installed machines need no reinstall; `update.sh` falls back to the sed-parse it already
  performs until the file exists.
- **D4 — `update.sh` provisions `personality.md` only-if-absent** (preserves a tuned soul) **and
  re-asserts the `~/.claude/CLAUDE.md` symlink every run** (self-healing against the drift in
  finding F), backing up a divergent regular file once before replacing it.

---

## 7. Name-purge inventory

The governing rule: a literal name is allowed **only** in (a) two-machine *architecture
documentation*, or (b) machine-local *rendered* artifacts the repo never ships. Everywhere in
shared, rendered-from-template, or code/test surfaces, the name must be derived or placeholdered.

| Site | Current state | Disposition | Rationale |
|---|---|---|---|
| `hooks/rule-enforcement.sh` — `WILLIS_HOOK_DEPTH` (lines 12, 29, 33) | Hardcoded name in env var | **Rename** → `CLAUDE_OS_HOOK_DEPTH` | Shared hook, runs on both twins; the loop-guard is the invariant. |
| `hooks/rule-enforcement.sh:214` — comment "the Willis identity file" | Hardcoded prose | **Neutralize** → "the agent identity file" | Shared-code comment names a twin in the body. |
| `hooks/test/rule-enforcement.test.js:38,98` — `WILLIS_HOOK_DEPTH: '0'` | Test pins old env-var name | **Rename in lockstep** with the hook | **Coupled to the rename.** Renaming the hook var without these leaves tests exercising a dead variable — green tests, dead coverage. |
| `hooks/test/session-observer.test.js:32,40` — `'Hello Willis'` fixture + assertion | Test fixture hardcodes a twin name | **Neutralize** → a neutral fixture string (e.g. `'Hello there'`) + matching assertion | Test data should not encode a per-machine name. |
| `skills/playwright-qa-channel/SKILL.md:226` — "Extending to Other Projects (Walter / non-ARC)" | Single-twin name in a shared skill | **Neutralize** → "other projects / non-ARC" | Single-name reference in shared config, not two-machine doc prose. |
| `skills/mcp-health-audit/SKILL.md:191` — literal output string `"Pending — Walter sync required."` | Single-twin name baked into a shared skill's runtime string | **Neutralize** → "Pending — sync to the other machine required." | Same class as the `playwright-qa-channel:226` site; a `.md` runtime string, so gate row 2's code/env sweep would miss it (see §9). |
| `skills/identity-check/SKILL.md:34,56` — read-path + rubric grounding (see Fix-1 row below) | Reads persona from `~/.claude/CLAUDE.md`; rubric grounds in `CLAUDE.md` sections | **Repoint** → read `personality.md` directly; re-point `grounds_in` | The carve moves persona out of `CLAUDE.md`; the audit must follow it or it grades against missing sections. Detailed below. |
| `templates/CLAUDE.md` persona sections | `${AGENT_NAME}` placeholders, persona + body interleaved | **Split** → persona moves to `templates/personality.md`; body keeps neutral rules + anchor line + `@`-import | The core carve. |
| `README.md` Willis/Walter architecture prose | Literal both-names | **Keep literal** | Documentation of the two-machine fact (names both twins to describe the design). |
| `docs/*.md` (phase-2, PRDs) naming both twins | Literal | **Keep literal** | Architecture documentation. |
| `skills/assimilate-claude-os/SKILL.md` (Willis transmits / Walter assimilates) | Literal both-roles | **Keep literal** | Describes the two-machine sync relationship. |
| `skills/identity-check/SKILL.md:29` — "the dual Willis/Walter design" | Literal both-names | **Keep literal — documented exception** | Both-twin architecture prose; named here so gate row 1 does not false-flag it. |
| `skills/mcp-health-audit/SKILL.md:44,177` — "between Willis and Walter" | Literal both-names | **Keep literal — documented exception** | Both-twin architecture prose; named so gate row 1 does not false-flag it. |
| `reference/writing-voice.md:6` — "Shared genome (Willis + Walter)" | Literal both-names | **Keep literal — documented exception** | Both-twin architecture prose; named so gate row 1 does not false-flag it. |
| `~/.claude/rules/communication.md` (rendered) | Literal "Walter" | **Already correct** | Machine-local rendered artifact; its source template uses `${AGENT_NAME}`. |
| `~/.claude/CLAUDE.md.pre-phase3-*.bak` | Stale May-12 backup | **Delete** | Acceptance criterion; pollutes content searches. |

> **Note on completeness (two review passes):** the inventory was under-counted twice and corrected
> twice. (1) The RBJ review (P3) added the three test/skill coupling rows. (2) The five-lens design
> review found the inventory *still* missed `mcp-health-audit:191` — a single-twin literal of the
> exact class already caught at `playwright-qa-channel:226` — and three both-twin prose sites that
> needed explicit "keep-literal" classification so gate row 1 does not false-flag them. The lesson:
> the purge sweep must **enumerate the full `Willis|Walter` search result and classify every hit**,
> not re-discover sites ad hoc. The test-file coupling (`WILLIS_HOOK_DEPTH` in
> `rule-enforcement.test.js`) remains the highest-risk row — it must move in the same change as the
> hook rename.

---

## 8. Migration sequence (idempotent; all setup in scripts per project rule)

In dependency order. No step is a manual instruction.

- **A. `templates/personality.md` (new, repo).** Extract Disposition / Pushback / Style of work /
  Address / Appreciation from `templates/CLAUDE.md`, keeping placeholders. Add the
  "hand-tune-after-render" banner.
- **B. `templates/CLAUDE.md` (modified, repo).** Strip persona sections. Keep line-1 anchor
  (`# Agent Identity — ${AGENT_NAME}`), the "you are X" line (the `/compact` safety net), and all
  neutral body rules. Add `@~/.claude-data/agent/personality.md` near the top.
- **C. `install.sh` (modified).** After the existing render, add: (1) render `personality.md` via
  `envsubst`; (2) write `identity.json` from the three vars; (3) ensure `~/.claude/CLAUDE.md` is a
  symlink to canonical (heals the drift in finding F).
  - *JSON-write safety (from design review, minor):* build `identity.json` with
    `jq -n --arg agent_name "$AGENT_NAME" --arg user_name "$USER_NAME" --arg machine_desc "$MACHINE_DESC" '...'`,
    not an `envsubst`/`printf` template — `--arg` escapes quotes/backslashes correctly. `jq` is
    already a hard dependency of the hook layer. The derive-once path in step D must use the same
    constructor so a prose capture is escaped, not string-interpolated.
- **D. `update.sh` (modified).** Sequence this step **explicitly** (the design review flagged an
  ordering gap when these were bundled):
  1. **Heal first.** Re-assert the `~/.claude/CLAUDE.md` symlink before any identity read. Back up a
     divergent regular file to a **timestamped, heal-specific name**
     (`${link}.pre-symlink-heal-<UTC>`) — **not** `${link}.pre-claude-os`, which `update.sh` Step 5
     unconditionally deletes every run (the collision the review confirmed). Only back up + relink
     when the target actually differs from canonical; refuse to overwrite an existing heal backup.
  2. **Read the anchor.** Prefer `identity.json`. Read it **defensively** — if present but
     unparseable or `agent_name` is empty, fall through to the prose fallback exactly as the absent
     case does; never abort the run (the script is `set -euo pipefail`).
  3. **Fallback.** The prose `sed`-parse reads the **canonical** `~/.claude-data/agent/CLAUDE.md`
     (not the `~/.claude` link), so the read is independent of symlink state. One-time migration
     (D3): if `identity.json` is absent, derive once via this fallback and write it — through the
     `jq --arg` constructor from step C — then read JSON forever after. Guard the install-defaults
     case: if the parsed name is the template default (`Claude`/`human user`), **skip writing**
     `identity.json` and warn, rather than baking a placeholder into the new source of truth.
  4. **Provision `personality.md` only-if-absent** — but assert it exists *before* the body's
     `@`-import is relied upon (a dangling import otherwise).
  5. **Reconcile (anchor sync).** Assert `identity.json.agent_name` equals the parsed line-1 name;
     warn loudly on divergence. `identity.json` is **canonical for machine consumers**; the prose
     line-1 is a human-readable mirror `install.sh` writes from the same vars — never the reverse.
- **E. Repoint `identity-check` to the carved persona (the design-review blocker).** The carve moves
  Disposition/Pushback/Style/Address/Appreciation into `personality.md`, but `identity-check` reads
  persona by `Read`-ing `~/.claude/CLAUDE.md` (`SKILL.md:34,56`) and its rubric grounds 60–85% of the
  score in `grounds_in: "CLAUDE.md — …"` (`identity-rubric.yaml:13,31,48,62`). The `Read` tool does
  **not** resolve `@`-imports — only the launch-loader does — so after the split the skill would grade
  against sections absent from the file it reads (a false-green audit, §1's own enemy). Change
  `identity-check` Step 1 to `Read` `~/.claude-data/agent/personality.md` (the persona) **plus**
  `~/.claude/CLAUDE.md` (the anchor), and re-point every `identity-rubric.yaml` `grounds_in` from
  `CLAUDE.md — …` to `personality.md — …`. Also derive the agent name from `identity.json` here.
- **F. Name-purge edits** per §7 (hook env-var rename + coupled tests, comment, fixtures, the two
  single-twin skill strings).
- **G. `uninstall.sh` (modified, from design review).** Add `~/.claude-data/agent/identity.json` and
  `~/.claude-data/agent/personality.md` to the removal set (guarded for absence), so the change is
  symmetrically reversible per the project rule that machine setup lives in scripts.
- **H. Delete** the stale `.bak`.

---

## 9. Verification gate (observed behavior, not "script ran")

Per the user-memory rule: *for config-writing or fresh-machine-only changes, run the real thing
end-to-end; passing tests are not proof.*

| # | Claim | Method | Pass condition |
|---|---|---|---|
| 1 | Name purge complete | **Enumerate** the full `Willis\|Walter` search result across `claude-os` + `~/.claude`; classify every hit | Every hit is either neutralized or a §7 documented exception; zero unclassified hits |
| 2 | **No single-twin name in code/test/env OR shared-skill runtime strings** (the check that would have caught both under-counts) | Sweep code/test/env-var surfaces AND `.md` runtime/output strings in shared skills | Zero single-twin names in `.js`/`.sh`/env vars/test fixtures/shared-skill output strings; only both-twin architecture prose remains, all of it in §7's documented-exception list |
| 3 | `identity.json` is the anchor | Read it; confirm `update.sh` reads `agent_name` from it | Field present + correct; no `sed` prose-parse in the **primary** read path (fallback may remain for the pre-migration window) |
| 3b | **Defensive read** — corrupt `identity.json` degrades, never aborts | Write a malformed `identity.json`, run `update.sh` | Update completes; falls back to prose parse; no `pipefail` abort |
| 3c | **JSON-write safety** — exotic name round-trips | Install with a name containing `"` and `\`, then read it back | `identity.json` is valid JSON; the name survives the install→update read intact |
| 4 | Persona actually loads | Start a real session; `/memory` lists loaded files | `personality.md` (or its `@`-import) appears in the loaded set |
| 4b | **`@`-import resolves** on fresh install AND in-place update | Confirm the import target file exists at both lifecycle points | `personality.md` present before the body's `@`-import is relied upon; no dangling import |
| 5 | Persona survives `/compact` (safety net) | In a session, `/compact`, then probe | Agent still knows it's Walter + retains the inline name anchor |
| 5b | **Import survival empirically recorded** | Run `/memory` after `/compact` | Record whether `personality.md` is still in the loaded set — converts the unverifiable docs claim into a known machine fact |
| 6 | Symlink heal fires, backup is durable | On *this* machine (has the drift), run the heal; `ls -la ~/.claude/CLAUDE.md`; then run `update.sh` a second time | Shows a symlink → canonical; any divergent copy is backed up to a **timestamped** name that **survives** the next `update.sh` Step 5 cleanup |
| 7 | Update preserves a tuned soul | Hand-edit `personality.md`, run `update.sh`, re-read | Edit survives untouched |
| 8 | **Audit grades the carved persona** (the repoint blocker) | Run `identity-check`; confirm its read-path and rubric `grounds_in` resolve to real sections in the file it actually reads | No name-drift false positive; grades against "Walter"; **every persona axis's `grounds_in` resolves to a present section in `personality.md`** — not merely "the skill passes" |
| 9 | `.bak` removed | Glob `~/.claude/CLAUDE.md*.bak` | No results |
| 10 | Hook tests still meaningful after rename | Run the hook test suite | Tests reference the new env-var name and pass against live behavior |
| 11 | **Reversibility** | Inspect `uninstall.sh` | `identity.json` and `personality.md` are in the removal set |

### Mapping to issue #25 acceptance criteria

- ☑ Canonical per-machine naming confirmed (Willis=work, Walter=home) → confirmed by maintainer.
- ☐ No skill/rubric/config hardcodes a name → §7 purge (now enumerated + classified) + gate rows 1–2.
- ☐ `audit-claude-os` + `review-performance` pass on Walter without name-drift false positives →
  gate row 8 (now asserts the persona axes actually resolve post-carve, via §8.E repoint).
- ☐ `identity-check` (issue #25's named consumer) reads the name from the live identity source →
  §8.E repoints it to `personality.md` + `identity.json`; gate row 8.
- ☐ Stale `.bak` removed → gate row 9.
- ☐ Per-machine persona boundary documented → `personality.md` + `identity.json` *are* the boundary; this spec records it.

---

## 10. Out of scope (named, not dropped)

- **Authoring the two distinct personalities** — maintainer owns; the skeleton ships neutral.
- **Wipe-survival backup** — asymmetry accepted (§3.5); no backup machinery.
- **Willis-side execution** — this work is built and verified on *Walter* (this machine). When the
  work Mac next runs `update.sh`, the structural changes carry over and the one-time
  `identity.json` migration fires there. Not verifiable from this machine; tracked as a follow-up.
- **The `claude-os` → Dioscuri identifier rename** — this pass rebrands only the product/concept
  layer (title, §2, intent prose). The repo slug `claude-os`, the paths `~/.claude-data/` and
  `~/.claude/`, the `audit-claude-os` / `assimilate-claude-os` skills, the `${link}.pre-claude-os`
  backup name, and the GitHub repo URL all still carry the old name. Renaming them is a real
  filesystem + git + identifier migration with its own data-migration and backward-compat surface,
  and it would collide with the in-flight §7 `CLAUDE_OS_HOOK_DEPTH` rename. Deferred to a dedicated
  rename ticket; **do not** fold it into the issue #25 identity work.
```
