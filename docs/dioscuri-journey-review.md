# Dioscuri context-graph: journey review & final-phase plan

A historical record of the Dioscuri context-graph integration — what the origin plan promised, what we completed, what we discovered and built that the plan never anticipated, and the final phase that carries us from here to done.

**Why this document exists:** several days of hard, successful work have shipped the bulk of a major upgrade. The build is substantially complete; what remains is activation, a gated pilot, and the deliberately-deferred capture path — far enough along to be proud, not far enough to stop without losing traction. This is the map that keeps the traction: it names exactly what's left and the order to finish it. *(This review deliberately avoids a single "% done" figure: the original plan's scope and the discovered work (§3) are different denominators, so any one percentage would be more precise than it is true.)*

**Lineage:** everything here descends from `dioscuri-context-graph-integration-plan.md` (the origin plan). That plan is **preserved verbatim as a comment on [issue #60](https://github.com/JasonFulksFamilySearch/claude-os/issues/60)** (issue #60's *body* is the separate System Reference; the plan lives in its "📜 Origin plan — preserved for lineage" comment). Section references below to the plan's "§5 phasing table," "§6 decisions," etc. are sections **of that preserved plan**, not of issue #60's body. The plan synthesized two upstream efforts — **Headroom** (context-entry compression + injection ranking) and **Gortex** (code-graph reach + contract index) — into one repo-agnostic Dioscuri capability under a single safety contract: *reversible, never touches the identity/rules prefix, skippable per-call, no behavior change without a human gate.*

---

## 1. Where we are, in one line

The **build is done; the activation and certification are not.** All ten non-gated, non-pilot-dependent units are coded, adversarially gated, and merged to `master` across three PRs (#52, #54, #56). What remains is (a) turning the feature on across the two machines via `update.sh`, (b) the deliberately-deferred arming-gated capture path, and (c) the cross-machine certification that needs a live pilot. The plan's safety contract held end to end: nothing shipped writes to promoted memory or the eval corpus, and every behavior change is gated or skippable.

---

### 1.1 A note on artifact status (read this before §3)

This review distinguishes three states, because conflating them is a real trap (this doc itself made that error on first draft):

- **Merged** — on `origin/master`. The ten Dioscuri code units (§2) are here.
- **Open PR** — pushed, in review, not yet merged. PR #62 (launchd digests) is here — *but see the caveat in §3.4: its final runbook commit was local-only at the time of writing.*
- **Drafted, local-only** — committed or written in a worktree, **not pushed, no PR**. Three of the documentation deliverables this review credits are in this state: the **operator feature guide** (§3.2), the **structural test-suite design spec** (§3.5), and **this journey review itself**. They live as unpushed commits on `chore/structural-test-suite-spec` (2 commits ahead of master, no PR) plus an untracked file. They are *written*, not *shipped*. The honest next step for them is a docs PR; until then, treat §3.2/§3.5 as "drafted," not "landed."

The discipline this enforces: **nothing is called "done" until it is on `origin` or in a PR.** Where the prose below says a doc "exists," read it as "drafted, local-only" unless it names a merged PR.

## 2. What the plan promised → what we completed

The origin plan's §5 phasing table had **10 work-rows across 5 phases**, plus the pilot/port. Here is each, mapped to the unit that delivered it and its status.

| Plan phase | Plan work-row | Delivered as | Status |
|---|---|---|---|
| **0** | CacheAligner audit (no per-session token in the prefix) | **DIO-1** | ✅ Merged (#52) |
| **0** | Detectability spike (ts-morph reach + guard resolution; path-portability) | **DIO-2** | ✅ Done (consumed into DIO-9) |
| **1** | PostToolUse dispatch seam (ContentRouter), interface frozen | **DIO-4** | ✅ Merged (#52) |
| **2** | Native JSON tool-output compression (full SmartCrusher) | **DIO-7** | ✅ Merged (#52) |
| **2** | Graph reach + contract index at `.dioscuri/graph/` | **DIO-9** | ✅ Merged (#52) |
| **3** | CCR retrieval contract (three lifetime stores) | **DIO-11** | ✅ Merged (#52) |
| **3** | Six-factor injection ranking, fed by graph `error_indicator` | **DIO-13** | ✅ Merged (#54) |
| **4** | Lifecycle hooks: `PreCompact` staleness + `Stop` episodic capture | **DIO-14** | ✅ Merged (#54) |
| **4** | TOIN-style retrieval logging (signal only) | **DIO-15** | ✅ Merged (#56) |
| **Pilot/Port** | Willis-first pilot, then Walter port (cross-machine cert) | **DIO-17** | 🟡 Open (#57) — waits on pilot |

**Scorecard against the original plan: 9 of 10 work-rows shipped + the reversibility harness (DIO-8) the plan implied but didn't enumerate.** The only plan-row not yet done is the pilot/port, which is sequencing-blocked by design, not buildable yet.

One faithful correction the build made to the plan: the plan's §5/§6 named a **`PostTask`** lifecycle hook. During DIO-14 we found Claude Code **has no `PostTask` event** — so the episodic-capture trigger was correctly built on the existing **`Stop`** hook instead. The plan's intent (trigger capture at the right lifecycle moment) was honored; the mechanism was corrected to reality.

---

## 3. What we discovered and accomplished that the plan never anticipated

This is the part a phase table can't show — the work that emerged *because* we built carefully. None of it was in the origin plan; all of it was necessary, and it is a large fraction of the actual value delivered.

### 3.1 An adversarial assembly line, run for real
The plan said "route findings through `/red-blue-judge`." What we actually built and ran was a full **PMO-conducted assembly line**: the PMO sequenced units, an `engineer` built each, a `qa` agent hard-gated each adversarially, and only then did it commit as a clean slice. This caught **real defects that green tests missed**, repeatedly:
- **DIO-14** had a green test suite but a fatal path bug — the staleness hook looked at the wrong directory (`<repo>/.dioscuri/graph/` vs the real `mcp/src/.dioscuri/graph/`). The hook would never have fired. QA caught it by running against the *real* layout, not the synthetic fixture.
- **DIO-13** took **three QA loops** — the gate caught a determinism defect that the unit's own tests masked (a tie-break that *relocated* an input-order gap rather than closing it), twice, before it landed clean.
- Across the build, QA proved negative guarantees *by execution* (injecting violations against the live frozen weights, running the real indexer's `classify()` against the off-corpus sinks) rather than trusting assertions.

### 3.2 A documentation corpus the plan didn't scope
- **System reference** ([#60](https://github.com/JasonFulksFamilySearch/claude-os/issues/60)) — how the merged code actually works, by subsystem, grounded with `file:line` anchors. (The origin plan is preserved separately, as a *comment* on #60 — see Lineage above.)
- **PRDs** on every remaining unit (#57/#58/#59) and on the digest-family workstream (#53) — the *why* behind each, sourced from the design docs, not memory.
- **Operator feature guide** (`docs/dioscuri-feature-guide.md`) — how to *use* the upgrade, in Google Developer Documentation Style, with verified control-surface names. *(Drafted, local-only — see §1.1; not yet in a PR.)*
- **In-repo frozen contracts** written during the build: `dioscuri-content-router-seam.md`, `dioscuri-smartcrusher-compression.md`, `dioscuri-ccr-retrieval.md`.

### 3.3 A latent-hazard ledger, tracked not lost
The build surfaced real hazards that were correctly *deferred with a tracking issue* rather than papered over or silently dropped:
- **`searchMemory` has no `reinforce` gate** ([#55](https://github.com/JasonFulksFamilySearch/claude-os/issues/55)) — it bumps `access_stats` unconditionally; the AC-4 "machine accesses don't reinforce" boundary holds today *only* because no machine path reaches it. Tracked for whoever first wires such a path.
- **`rehydrateEnvelope` bare-envelope degradation** — documented in the #54 PR body as a contract the downstream caller must honor.

### 3.4 A whole sibling workstream — two PRs, one open
The **background-digest family** (`pr-digest` / `sprint-digest` / `merge-progression`) turned into its own multi-PR effort:
- **#51 (merged)** — found machine-non-portable (hardcoded `/Users/fulksjas/` paths); shipped as a per-agent-configurable fix.
- **[PR #62](https://github.com/JasonFulksFamilySearch/claude-os/pull/62) (OPEN, not fully pushed)** — **the durable fix for the recurring `/schedule` friction.** Converts the three digests from *session-only cron* (the ephemeral jobs that re-register every session and kept mis-routing to the cloud `/schedule` handler) into **launchd LaunchAgents that survive session exit**. 1,042 insertions: a generator (`bin/digest-launchd-install.js`) + 467-line test, a plist template, `update.sh` Step 9.5 provisioning, a `session-start-check.js` change, and a first-install runbook. Careful safety design: `RunAtLoad=false` (provisioning must never fire the Jira-transitioning merge-progression job), fail-safe if the `claude` binary can't resolve, and `--permission-mode default` (not `bypass`) so the write-capable job is denied anything outside its allowlist. **Status caveat:** the final runbook commit (`39a0015`) is **local-only / unpushed** — the PR on GitHub is one commit behind what's described here. Before review: push it. So #62 is *near-complete*, not "done."
- **[#53](https://github.com/JasonFulksFamilySearch/claude-os/issues/53)** — the *cloud*-portable variant + the session-start misroute, still tracked. Note: #62 addresses the **local** durability (jobs survive session exit) and the recurring re-registration friction; #53's cloud-routine variant is the remaining, separate piece.

### 3.5 A test-strategy spin-off (drafted, local-only — see §1.1)
The "how do we keep future changes from breaking this?" question spawned a **structural-invariant test-suite design** (`docs/superpowers/specs/2026-06-20-structural-invariant-test-suite-design.md`), itself hardened through `/design-review` + a three-cycle `/red-blue-judge` that caught three real design defects (one of them a GitHub-Actions mechanics error that two prior reviews missed). Its H3 invariant was deferred to [#61](https://github.com/JasonFulksFamilySearch/claude-os/issues/61) rather than shipped vacuous. **Status:** this spec — and the operator feature guide (§3.2) and this journey review — are *drafted, local-only* on `chore/structural-test-suite-spec` (2 commits ahead of master, no PR). They are written, not shipped; the next step is a docs PR. The spec is a *design*, not yet an implementation — the actual test suite (H1 + H2 + the CI change) has not been built.

**The honest takeaway:** the plan described *what to build*. The discovered work was *what it takes to build it correctly and keep it built* — the gates, the docs, the hazard tracking, the test floor. That second category is roughly half the actual effort and none of it was foreseeable from the plan alone.

---

## 4. What remains — the final phase

Three threads stand between "merged" and "fully done, running, and certified on both machines." They are ordered here by dependency.

### Thread A — Activate (turn it on; unblocks everything)
**Status: not started. This is the first thing to do and the cheapest.**

The code is on `master` but **merging did not activate it.** The hooks are registered and the directories provisioned only when `update.sh` runs on each machine. Until then, the upgrade is dormant — the PostToolUse router, the PreCompact/Stop hooks, the `.logs/`, `findings-buffer/`, `ccr-cache/` dirs are not live.

- [ ] Run `update.sh` on **Walter** (this machine) — registers the new hooks, provisions the dirs.
- [ ] Verify activation: a large-JSON tool result shows a compression marker; `~/.claude/settings.json` carries the new hook entries.
- [ ] Run `update.sh` on **Willis** (the work Mac) — same activation.

*Why first: nothing downstream (the pilot, the cross-machine cert) can happen until the feature is actually running on at least one machine.*

### Thread B — Pilot, then certify cross-machine (DIO-17 / #57)
**Status: 🟡 open, sequencing-blocked on Thread A.**

The origin plan's §6.5 pilot decision: run on **Willis first** with a graph-bearing query (so the graph half is exercised, not just compression), confirm promoted-episode quality, *then* port to Walter — which is where **FR-C3 cross-machine reproducibility is first certified** (a finding raised on Willis reproduces on Walter at the same commit). This is untestable on one machine, by design.

- [ ] Run the Willis pilot on a graph-bearing skill (the plan suggested `audit-claude-os` / `standup`).
- [ ] Read the pilot's promoted-episode quality — is the captured signal durable or noise?
- [ ] On green: certify cross-machine reproducibility (DIO-17 / #57) — same finding, both twins, same commit.

### Thread C — The arming-gated capture path (DIO-18 #58 + DIO-19 #59)
**Status: 🟡 open, deliberately deferred — the last and most careful work.**

This is the one piece that writes *into* the eval-gated corpus (compressed tool output → episode `## Tool signals` section), so the origin plan and the build both gated it hard: built default-OFF, armed only after a determinism proof, a manual eval re-baseline, and a fidelity measurement.

- [ ] **Build DIO-18 (#58) default-OFF first** — the capture path must *exist* before it can be measured. (DIO-19 is an A/B harness that runs `compress()` over this path, so the path has to be built before the harness can run. The bidirectional dependency in the tickets — #58 depends-on #59, #59 depends-on #58 — is about *arming* vs. *measuring*, not build order.)
- [ ] **Then run DIO-19 (#59)** — the non-error fidelity A/B harness over a *disjoint* labeled set; it produces the drop-rate number. **DIO-19 gates DIO-18's *arming*, not its building.**
- [ ] **Arm DIO-18 only when:** DIO-19 reports within-budget drop · `compress()` proven byte-identical across both machines · `npm run eval --rebaseline` + `cutover` after a non-regressing verdict · green pilot read.

*Why last, and why it serializes behind Thread B:* it's the only lossy write into the corpus, the eval gate is structurally blind to its main risk (it scores `source_path` presence, not content) — so it gets the most discipline. And one arming condition, *`compress()` byte-identical **across both machines***, is **structurally unprovable until Thread B's Walter port completes** — you can't prove cross-machine determinism on one machine. So Thread C cannot *fully arm* until Thread B is done: the three threads are more strictly serial (A → B → C-arming) than "ordered by dependency" alone implies.

### Adjacent, not on the critical path
**The launchd digest workstream (PR #62) and its merge/go-live tail.** This is the most actionable cluster outside the Dioscuri critical path — a near-complete PR plus five tracked follow-ups with owners:

| # | Follow-up | Priority | Owner |
|---|---|---|---|
| [#64](https://github.com/JasonFulksFamilySearch/claude-os/issues/64) | Push branch so PR #62 includes the runbook + doc pointers | P1 | Walter |
| [#65](https://github.com/JasonFulksFamilySearch/claude-os/issues/65) | Request + verify Copilot reviewer (Willis-side — API no-ops for Walter) | P1 | Jason |
| [#66](https://github.com/JasonFulksFamilySearch/claude-os/issues/66) | Annotate 6 stale docs "superseded by launchd" | P2 | Walter |
| [#67](https://github.com/JasonFulksFamilySearch/claude-os/issues/67) | Update genome CLAUDE.md at merge time | P2 | Jason |
| [#68](https://github.com/JasonFulksFamilySearch/claude-os/issues/68) | Consolidate post-merge go-live checklist | P2 | Walter |

*#64 is the gating P1: it pushes the local-only runbook commit (`39a0015`, see §3.4) so the PR on GitHub matches what's described. #65 is the Willis-side Copilot step. The three P2s are merge-time cleanup.*

**Other tracked issues** (named for completeness — most are independent of "Dioscuri is done"):
- **#53** — the *cloud*-portable digest variant + session-start misroute (the piece #62 doesn't cover: running digests when the machine is off, via connectors).
- **#55** — the `searchMemory` `reinforce:false` gate (a latent AC-4 hazard; arm when a machine→search path is first wired).
- **#61** — the structural test-suite H3 redesign (the test-floor spin-off).
- **#42** — extend CI to run the `hooks/` suite (labeled `next-2`). **Directly relevant:** this build shipped hooks-heavy code (PostToolUse router, PreCompact/Stop) that today's `mcp/`-only CI does not test — the same gap the test-suite spec (§3.5) targets.
- **#37** — Phase 1 C-Series (Memory) scope analysis & approval gate (open gate, separate memory workstream).
- **#31 / #34** — C3 promotion-gate dossiers / D3 single-writer index (C/D-series memory enhancements, adjacent).
- **#63** — adopt the ponytail YAGNI ladder + a `/lazy-review` command (most recent; unrelated).

---

## 5. The finish line, defined

We will call the Dioscuri context-graph integration **done** when:

1. The feature is **activated on both Walter and Willis** (Thread A).
2. The **Willis pilot** ran green and **cross-machine reproducibility is certified** (Thread B / #57).
3. The **arming-gated capture path** is built, its fidelity measured within budget, and either armed (after the full gate) or consciously left default-OFF with the arming checklist satisfied (Thread C / #58, #59).

At that point every row of the origin plan is delivered, the upgrade runs on both twins, and the one corpus-writing path is either safely armed or safely parked. The adjacent issues (#53, #55, #61) are real but independent — they don't gate "Dioscuri is done."

**The honest magnitude:** the build is substantially complete — every code unit the original plan named is merged. What remains is three well-named threads: activation (small, mechanical), the pilot + cross-machine certification (medium, gated on a real run), and the arming-gated capture path (the most careful work, last and serialized behind the pilot by design). No single percentage is offered, on purpose — the plan's original scope and the large body of discovered work (§3) are different denominators, so a figure like "70%" would read as measured when it isn't. The defensible claim is the qualitative one: *the build is done; activation and certification are not, and the path through them is short and named.*

---
🤖 Journey review authored by Walter (AI), grounded in the origin plan (#60) and the merged code. A historical record + final-phase map. Snapshot as of the merged Phase 0–4 build; the open threads are tracked at the cited issues.
