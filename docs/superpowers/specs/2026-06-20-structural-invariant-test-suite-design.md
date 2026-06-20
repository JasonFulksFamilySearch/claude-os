# Design — claude-os Structural-Invariant Test Suite + CI Gate

**Date:** 2026-06-20
**Status:** Design (pre-implementation), human-review-ready. Passed `/design-review` (High confidence); the `/red-blue-judge` gate ran the full 3 cycles and caught 3 real defects — H1 hook-registry coverage (fixed), the CI topology's invalid GitHub-Actions `job-level paths:` (fixed to Option B), and H3's vacuity (deferred to [#61](https://github.com/JasonFulksFamilySearch/claude-os/issues/61)). §7 (Ajv) is resolved. The shipped floor is **H1 + H2 + the CI topology change**.
**Scope:** Unit-test layer only. E2E is a separate later effort, explicitly out of scope.

---

## 1. Problem

claude-os has good unit coverage *inside* components (~86–91% of hooks and mcp modules have tests, with genuinely strong test shapes: determinism guards, AC-4 write-path audits, fail-safe-degradation, anti-tautology). Its real exposure is elsewhere — two gaps that **pass every existing test today**:

1. **CI gates `mcp/**` only.** The 29 `hooks/` test files never run in CI (`.github/workflows/ci.yml` is scoped to `mcp/**`). A hook can break and ship green.
2. **Nothing tests the config→thing seams.** `hooks-install.test.js` proves the command *strings* in `CANONICAL_HOOKS` are correct, but never asserts the file each command names actually exists. Rename `session-start-check.js` in a refactor → the hooks suite stays green → every fresh machine (post-`update.sh`) wires a hook that 404s on every session start.

The QA consult's one-line summary: *the existing tests are strong inside components; the system's real exposure is between components, in the config-names-a-thing seams that no in-module test can see.*

## 2. Goal

A **structural-invariant test suite** that walks the config tree and asserts that every named thing exists and conforms — plus a **CI change** that actually gates it (and, as a side effect, finally runs the hooks tests in CI). This is QA's recommended *minimum viable floor*: the smallest code for the widest catastrophe coverage, protecting the system's ability to boot at all on a fresh machine.

**The scope discriminator (the design's governing rule):** an invariant earns a **hard gate** only when its violation is **silent** AND its blast radius **crosses machines**. Violations that are visible immediately, or not crisply falsifiable, are at most an advisory lint — or skipped.

## 3. Architecture

A new repo-root test surface, **`test/structural/`**, run via **`node:test`** (matches the hooks runtime; no new heavyweight runtime). It globs the config tree **at collection time** (top-level, not inside a test body — required for per-file test generation) and emits **one named test per discovered file** (the ESLint / `test.each` model), so a failure names the exact offending file, not a blanket "structural test failed."

### 3.1 CI topology — single workflow, per-job change-detection gating (corrected per RBJ cycle-2 P4)

**The goal:** the `structural` job runs on *every* change (it validates the whole tree); the heavy `mcp` job (npm ci + tsc + vitest) and the `hooks` job run only when their subtree changed; and all three can be **required** status checks without ever hanging a PR.

**Two earlier framings were both wrong** — recording them so the trap isn't re-entered:
- Draft 1 ("drop the `mcp/**` filter") would make every doc typo run the heavy `mcp` job — re-creating exactly the cost the existing filter avoids.
- Draft 2 ("three jobs, each with its own `paths:`") is **mechanically impossible**: *GitHub Actions has no job-level `paths:` key* — `paths`/`paths-ignore` are valid ONLY under `on.<event>` (workflow level), and a workflow-level filter gates the **entire workflow** (no job runs if no path matches). So a retained `mcp/**` workflow filter would skip the whole workflow — and the `structural` job — on a doc edit. (GHA docs: "If there are no files changed, the workflow will not run.")

**The correct shape (GHA Option B — the documented best practice for this case):** ONE workflow, **no workflow-level path filter**, a `changes` job that computes which subtrees changed, and per-job `if:` gating off its outputs. This works *because of* a specific GHA behavior: **a job skipped by an `if:` conditional reports status "Success"** (so a required check on it is satisfied), whereas a path-filtered *workflow* reports "Pending" and **blocks the merge**. That asymmetry is why per-job `if:` gating — not separate path-filtered workflows — is the right tool when the jobs are required checks.

```yaml
on:
  pull_request:                 # NO paths: filter — structural must see every change
  push:
    branches: [ master ]        # NO paths: filter

permissions:
  contents: read

jobs:
  changes:                      # compute which subtrees changed
    runs-on: ubuntu-latest
    outputs:
      mcp:   ${{ steps.filter.outputs.mcp }}
      hooks: ${{ steps.filter.outputs.hooks }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            mcp:   [ 'mcp/**', '.github/workflows/ci.yml' ]
            hooks: [ 'hooks/**', '.github/workflows/ci.yml' ]

  structural:                   # runs on EVERY change — no gating
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: npm ci            # ONLY if §7 Ajv root package.json is present (H2 needs it)
      - run: node --test "test/structural/invariants.test.js"          # hard gates (H1/H2; H3 deferred to #61)
      - run: node --test "test/structural/lint.advisory.test.js"       # advisory (L1/L2/L3)
        continue-on-error: true                                        # §4.3 — lints never block

  mcp:                          # heavy — only when mcp/ changed (skipped→Success otherwise)
    needs: changes
    if: ${{ needs.changes.outputs.mcp == 'true' }}
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: mcp } }
    steps: [ checkout → setup-node 20 (cache npm) → npm ci → npm run build → npm test ]   # UNCHANGED logic

  hooks:                        # only when hooks/ changed (skipped→Success otherwise)
    needs: changes
    if: ${{ needs.changes.outputs.hooks == 'true' }}
    runs-on: ubuntu-latest
    steps: [ checkout → setup-node 20 → node --test "hooks/test/*.test.js" "hooks/lib/test/*.test.js" ]
```

**Branch protection:** mark `structural`, `mcp`, and `hooks` required *by job name*. On a doc-only PR, `mcp`/`hooks` are `if:`-skipped → report Success → don't block; `structural` runs and gates. On an mcp PR, all three run. No PR ever hangs Pending. (Contrast: separate path-filtered workflow files — GHA Option A — would leave a required `mcp` check Pending-forever on a doc PR, the classic blocked-merge trap; that's why Option A is rejected here.)

**Notes the implementation plan must carry:**
- `dorny/paths-filter@v3` is a third-party action (widely standard, but pin the major version); it does its own diff and isn't bound by GHA's native 300-file path-match cap.
- The `mcp` job's *internal* logic (npm ci → build → test, `working-directory: mcp`, node 20, npm cache) is **byte-unchanged** from today's `ci.yml` — only its trigger moves from workflow-level `paths` to a job-level `if:`. The acceptance criteria assert this.
- **Node version:** new jobs pin `setup-node` to `"20"` (the `engines: ">=20"` floor — catches "works on newer local Node, breaks on minimum"). The glob-args form (`node --test "hooks/test/*.test.js"`) is required because bare-directory args throw on Node 24 (a known repo convention).
- The `structural` job's `npm ci` step exists ONLY because §7 chose Ajv (a root `package.json`); H1 and the lints need no install, but they share the job, so one `npm ci` covers H2's Ajv. This is the concrete cost of the §7 Ajv decision, made visible here.

## 4. The invariant set

### 4.1 Hard-gate invariants (fail = red CI)

Each guards a silent + cross-machine catastrophe.

**H1 — Every command in ANY of the three canonical-hook arrays that NAMES a script file → that file exists in the repo.**

- *Guards:* a rename/move that leaves a hook 404ing on every session of every fresh machine (QA's #1 risk).
- *Mechanism:* `require()` the live `hooks-install.js` and read **all THREE exported arrays** — `CANONICAL_HOOKS`, `CANONICAL_GUARD_HOOKS`, `CANONICAL_SCRIPT_GUARD_HOOKS` (all three exported at `hooks-install.js:260`). For each entry's `command` string, parse the script path. **The three-array coverage is load-bearing** (RBJ cycle-1 P1 fix): an earlier draft read only two arrays and silently omitted `CANONICAL_GUARD_HOOKS` — which would leave a whole class of registered hooks unaudited, the exact config→thing hole this invariant exists to close. The mechanism MUST enumerate all three; a future fourth array added to `hooks-install.js` is itself a risk, so H1 should derive the array list from the module's exports where practical rather than hardcoding three names (and at minimum assert the export set hasn't grown unexpectedly).
- **Edge case A (design-review correction #2a; attribution corrected per RBJ cycle-1) — inline-Bash commands have no file.** The arrays are not uniform: `CANONICAL_HOOKS` (`hooks-install.js:14-70`) holds only `node ~/.claude-os/hooks/X.js` forms (resolvable); `CANONICAL_GUARD_HOOKS` (`:85-106`) holds **inline `jq | grep` Bash guards with no script file** (e.g. the Rule-11 guard at `:95`); `CANONICAL_SCRIPT_GUARD_HOOKS` (`:115-119`) holds `bash ~/.claude-os/hooks/rule-enforcement.sh` (resolvable). So across all three arrays the parser MUST recognize only the `node <path>` and `bash <path>` *first-token* forms and **skip** commands that don't name a script file (every `CANONICAL_GUARD_HOOKS` entry skips by design) — not fail them. Framing is *"every command that names a script file → that file exists,"* NOT *"every command resolves to a file."*
- **Edge case B (design-review correction #2b) — the `~/.claude-os/` → repo-root rewrite.** Commands reference the *installed* path (`~/.claude-os/hooks/X.js`); the test runs against the *repo* (`<repoRoot>/hooks/X.js`). H1 MUST rewrite the `~/.claude-os/` (or `$HOME/.claude-os/`) prefix to the repo root before `existsSync`. Getting this wrong makes H1 silently test the wrong directory (a false pass). Resolve the repo root from the test file's own location (`__dirname` → up to repo root), never an absolute machine path.
- *Anti-tautology:* resolves against the *real* `hooks/` dir via `existsSync`, never a hand-typed parallel layout (the DIO-14 fixture-vs-reality lesson). H1 asserts *a file exists* — it does NOT claim *the hook works* (that's a behavioral claim, out of scope for a structural check).

**H2 — Every `config/*.template.json` that HAS a paired `config/*.schema.json` validates against it.**

- *Guards:* `update.sh` provisioning an invalid config to a fresh machine (silent bad-provision).
- *Mechanism:* glob `config/*.schema.json`; for each, derive the paired `<base>.template.json`; load both; validate.
- **Edge case (this design's addition) — unpaired files.** Live `config/` has two pairs (`digest-config`, `watched-projects`) and one *template with no schema* (`episodes.template.json`). H2 **skips unpaired templates** (an unpaired template is not a silent cross-machine catastrophe — it's not validated by anything in production either). H2 validates only the *pairs that exist*. A schema with no template, conversely, IS worth flagging (the schema documents a contract nothing satisfies) — but as a lint (L3 below), not a hard gate.
- *Validation engine (RESOLVED — see §7):* **Ajv**, via a minimal test-only root `package.json`. The originally-favored hand-roll was rejected after reading the schemas — `digest-config.schema.json` uses `$ref`/`definitions` heavily, which a hand-roll would silently skip (a false pass). The schemas use only internal `$ref`, so Ajv runs with no remote-ref fetching.
- *Security (design-review correction):* schemas are first-party/committed; Ajv runs with `loadSchema` unset (no remote `$ref` fetch), compiling only committed schemas, never user input — no SSRF/ReDoS surface.

**H3 — DEFERRED to [#61]. NOT in the shipped floor.**

H3 was to assert the committed eval labeled-set is disjoint from any committed tuning input — guarding train/test leakage (the ECIR-2022 finding: leakage can flip the eval verdict, not just inflate it; the justification for CLAUDE.md's "never tune `search_config.ts` weights against the labeled set" rule).

**Why deferred (RBJ cycle-3 P6 FAIL):** there is **no committed tuning fixture on the current tree** to intersect against — `mcp/eval/` holds only `labeled-queries.template.json` (the labeled set itself), and `docs/eval-gate-protocol.md:56-59` defines the disjoint calibration *query* set as explicitly **future**. So a hard gate asserting "labeled set ∩ tuning fixture = ∅" would intersect against nothing → **pass vacuously, never able to fail** — the exact anti-tautology trap §5 forbids (the DIO-13 lesson: a gate that cannot fail must not pass silently). Shipping it would embed false-confidence theater in the very suite built to prevent it.

The redesign (reframe to a now-checkable invariant / arm-when-present skip-with-reason / wire-in-when-the-fixture-lands) is tracked at **[#61](https://github.com/JasonFulksFamilySearch/claude-os/issues/61)**. **The shipped floor is H1 + H2 only.** When a disjoint calibration query set is introduced, H3's disjointness assertion must land in the *same PR* (per the eval-gate-protocol leakage discipline).

### 4.2 Advisory lints (non-blocking — see §4.3 for HOW they stay advisory)

Structural-only, no semantic analysis.

- **L1 — Every `skills/**/SKILL.md` frontmatter parses + has required fields (`name`, `description`).** Cheap drift-catch over ~50 skills.
- **L2 — Every `agents/**/*.md` has frontmatter + required sections.** Degrades a prompt if violated; doesn't crash a machine — hence advisory.
- **L3 — Every `config/*.schema.json` has a paired template** (the inverse of H2's skip). A schema documenting a contract nothing satisfies is worth surfacing, but not blocking.

### 4.3 How advisory lints stay advisory (design-review correction #3)

`node --test` has a single process exit code, so an `assert` in L1/L2/L3 would make them hard gates by accident — re-introducing exactly the high-churn flakiness QA warned against. The lints MUST be non-blocking by construction:

- **Mechanism:** L1/L2/L3 live in a **separate file** (`test/structural/lint.advisory.test.js`) run as a **separate CI step whose failure CI tolerates** (`continue-on-error: true` on that step, or a dedicated non-gating invocation). They emit findings via `test`'s `diagnostic()` / `console.warn`, not `assert`, so the suite reports drift without failing the merge.
- The hard gates (H1, H2 — H3 deferred to #61) live in `test/structural/invariants.test.js` and DO `assert` — their failure is red CI.
- This keeps the lint/gate split real, not fictional.

### 4.4 Explicitly NOT included (QA-flagged as over-engineering)

- Semantic "identity-neutral" analysis of agent files (not crisply falsifiable → tautological or flaky).
- Skill↔agent cross-reference graph checks ("every skill an agent names exists") — the reference graph is loose by design; high-churn, high-false-positive, teams learn to `skip` it. The cost of a dangling reference is low and immediately visible.
- "Every hook event name is valid" — visible immediately on use.

## 5. Anti-tautology discipline (standing rules baked into the spec)

The three anti-patterns that gave false confidence *this very session*, encoded as rules the implementation must follow:

1. **Fixture-matches-reality (DIO-14):** structural checks resolve against the same constant production reads (real `existsSync`, real `require()` of the live registry), never a hand-typed parallel layout. The `~/.claude-os/`→repo rewrite (H1 edge case B) is the sharp version — get it wrong and the test passes against the wrong directory.
2. **No tautological oracles (DIO-13):** L1/L2's required-field lists are hand-specified from an external authority (the skill/agent spec), never re-derived from the data under test. (This is the very rule that caught H3 at the RBJ cap — a disjointness gate with no operand cannot fail, so it was deferred to #61 rather than shipped vacuous.)
3. **Static-scan never the sole proof of a behavioral claim (GATE-3):** these are structural existence/validation checks by design — H1 asserts a file *exists*, not that the hook *works*. The spec does not let a structural check masquerade as a behavioral guarantee.

## 6. Reversibility

Fully reversible. The suite is new files (`test/structural/*.test.js`); the CI change is additive jobs. Revert = delete the files + the two new jobs. No production code touched, no machine state changed, no `~/.claude-os/` write. (Per CLAUDE.md, the eventual change reaches `~/.claude-os/` master only via a reviewed PR.)

## 7. RESOLVED — the H2 validation engine: Ajv via a minimal root `package.json`

**Decision (2026-06-20):** Option (b) — Ajv via a minimal root `package.json` with `ajv` as the only dependency (plus `ajv-formats` if a schema later needs format assertions).

**Why this, not the originally-favored hand-roll:** the decision was gated on "are the two schemas basic?" — and reading them settles it that they are NOT. `config/digest-config.schema.json` (draft-07) uses **internal `$ref` + `definitions` heavily** (10+ refs, nesting 3 levels deep: `repoDigest → agentBlockRepo → repoList/outputSink/cron`), plus **`additionalProperties: false`**, **`pattern`** (regex), **`enum`**, and **`minItems`**. `config/watched-projects.schema.json` is simpler but also uses `pattern`.

A hand-rolled validator that did not correctly resolve `$ref`/`definitions` would **silently skip every `$ref`'d subschema** — validating only the top-level keys and passing a template with a malformed `agentBlockRepo`. That is precisely the silent under-validation false-pass this entire suite exists to prevent. Hand-rolling *correct* `$ref` resolution is a real mini-JSON-Schema implementation (~150–200 lines to test thoroughly), and any feature a *future* schema adds that the hand-roll misses is another silent false-pass. The architectural-cleanliness win of zero-dep is not worth a validator that can pass broken config.

**Cost accepted:** the `structural` CI job gains one `npm ci` step (no longer strictly zero-install), and a root `package.json` is introduced where there deliberately was none. This is bounded and honest — Ajv is already a transitive dependency in `mcp/`, so it adds nothing new to the supply chain.

**Security (design-review item, still cheap here):** the schemas use only *internal* `$ref` (no remote URIs), so Ajv runs with **no remote-ref fetching** (`loadSchema` unset/false) and the committed-first-party schemas carry no SSRF surface. ReDoS risk from the `pattern` regexes is negligible (simple character-class patterns), but the engine compiles only committed schemas, never user input.

**Scope note for the implementation plan:** the root `package.json` is *test-only* — it declares `ajv` under `devDependencies`, holds no production code, and its presence must not change how `install.sh`/`update.sh` treat the repo root (verify they key off `mcp/package.json`, not a root one). Within the `structural` job, only H2's validation imports Ajv (H1 and the lints need no compile); the `hooks` job needs no install at all.

## 8. Acceptance criteria

- [ ] `test/structural/invariants.test.js` exists; H1 and H2 each emit one named test per discovered file; all pass on the current merged tree. (H3 is deferred to #61 — NOT in this file.)
- [ ] H1 enumerates ALL THREE arrays (`CANONICAL_HOOKS`, `CANONICAL_GUARD_HOOKS`, `CANONICAL_SCRIPT_GUARD_HOOKS`) from the module's exports, correctly skips the inline-Bash `CANONICAL_GUARD_HOOKS` entries (no script file), and correctly rewrites `~/.claude-os/`→repo root — proven by (a) a test that FAILS if any script-bearing command's target is renamed, and (b) a test asserting the export set is exactly those three (so a future fourth array can't slip past unaudited).
- [ ] H2 validates the two real pairs, skips `episodes.template.json` (unpaired), and the chosen engine fetches no remote refs.
- [ ] H3 is NOT shipped (deferred to #61); the spec's §4.1 H3 section is a deferral marker, not a vacuous gate; no `invariants.test.js` test asserts disjointness against a non-existent tuning fixture.
- [ ] `test/structural/lint.advisory.test.js` holds L1/L2/L3; their failure does NOT fail CI (proven by the CI step config).
- [ ] `ci.yml` has NO workflow-level `paths:` filter; a `changes` job (`dorny/paths-filter`) gates the `mcp` and `hooks` jobs via `if: needs.changes.outputs.* == 'true'`; the `structural` job runs ungated on every trigger. The `mcp` job's internal logic (npm ci → build → test, `working-directory: mcp`, node 20) is byte-unchanged from today. On a doc-only PR: `structural` RUNS, `mcp`/`hooks` SKIP-as-Success (don't block); on an mcp PR: all three run. All three are markable as required checks without any hanging Pending.
- [ ] H2 validates via Ajv (§7) using the minimal root `package.json`; Ajv fetches no remote refs; the root `package.json` is test-only and does not perturb `install.sh`/`update.sh`.

## 9. Out of scope (named, deferred safely)

- E2E / integration tests (separate later effort).
- The reusable negative-guarantee harness (`assertFailsOpen` / `assertNoCorpusWrite` / `assertDeterministic`) — QA's #4; a strong *next* increment, but this design is the floor, not the harness.
- Coverage gap-fill for the specific untested modules (summarizer-prompt, experience-shadow, cutover, graph-build, digest-queue-deliver) — QA's lower-tier; a later increment.
- Migration-safety harness — QA's tier-1; later.

## 10. Revision history (RBJ gate trail)

This spec was hardened by `/red-blue-judge` (mode `plan`, codebase as ground truth) across three cycles. Recorded so a future reader sees *why* the spec is shaped as it is:

- **Cycle 1 — P1 FAIL (fixed):** H1 read only 2 of the 3 canonical-hook arrays, silently omitting `CANONICAL_GUARD_HOOKS`; the inline Rule-11 guard was mis-attributed to `CANONICAL_HOOKS`. Fixed: H1 enumerates all three from exports (§4.1).
- **Cycle 2 — P4 FAIL (fixed):** the CI topology used a `job-level paths:` key, which **does not exist in GitHub Actions**; the retained workflow-level filter would have skipped the whole workflow (and the structural job) on a non-mcp change. Fixed to GHA Option B — `dorny/paths-filter` + per-job `if:` gating (§3.1), verified against official GHA docs.
- **Cycle 3 (cap) — P6 FAIL (deferred):** H3 was a hard gate with no operand — no committed tuning fixture exists, so it could never fail (the anti-tautology trap the suite exists to prevent). Per the RBJ cap rule, this escalated to human decision rather than auto-revising; resolved by deferring H3 to [#61](https://github.com/JasonFulksFamilySearch/claude-os/issues/61) and shipping the H1 + H2 floor.

The other lines (P2 scope, P3 NA pre-implementation, P5 unit independence, P6 §7-Ajv-grounded) passed clean across all cycles.

---
🤖 Design authored by Walter (AI), grounded in the merged tree + the QA consult + external research + the `/design-review` corrections + the `/red-blue-judge` gate trail (§10). Human review pending. Internally consistent: §7 resolved (Ajv); H3 deferred to #61; CI topology mechanically verified (GHA Option B); scope bounded to the H1+H2 floor.
