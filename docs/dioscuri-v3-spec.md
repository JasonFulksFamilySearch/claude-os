# Dioscuri V3 — Specification

**Status:** design-locked, pre-build. Derived from a full four-cluster teardown of V2
scored against the North Star. This is the costed seed for the fresh `Dioscuri` repo.

> Reading order: §1 is the law everything answers to. §2–3 fix the shape. §4–5 are what
> to build. §6 is how it stays alive without becoming V2 again.

---

## 1. North Star (locked)

**Dioscuri exists to make *me* a measurably stronger software developer — faster through
real work assignments, without trading away quality or accuracy.**

Career advantage is the *why*. Throughput on real assignments is *what we measure*.

**Metric, in priority order:**
1. **Speed** — time from assignment-start to done-and-verified. Where marginal effort goes first.
2. **Quality** — meets the requirement the first time. Low rework, low revert.
3. **Accuracy** — correct information; never act on stale or superseded context.

(All three are required floors; the order says where investment goes when they compete.)

**Discipline clauses — the drift guards:**
1. **Every component traces to the metric.** If a part can't show how it makes me faster,
   better, or more accurate on a real assignment, it's scaffolding. The justification chain
   terminates at *"this made me finish faster or get it right"* — never at another invariant.
2. **The system measures its effect on *my work*, not on itself.** Retrieval recall, eval
   scores, ranking quality are *means*. The instrument of record is time-and-rework on real work.
3. **Simplicity is the default. Complexity must be *bought* by the metric** — added where the
   metric demands it, never in anticipation.
4. **Two machines, shared code — not shared raw memory.** Same app, distributed by git +
   install. No cross-machine data reproducibility, no byte-determinism invariant. Memory is local.
5. **Cross-instance learning transfer is post-MVP, but never precluded.** Learnings must be
   *distillable into portable, self-contained artifacts* from day one. Transport between
   machines is deliberate and manual first; never automatic.

---

## 2. The two agents (domain model)

Dioscuri is one engine instantiated as **two domain-bound agents on two machines that are
never in the same place** ("you never find Castor and Pollux together").

| Agent | Domain | Trackers | Machine |
|-------|--------|----------|---------|
| **Willis** | ARC | Jira | Work / daytime |
| **Walter** | SCRIP, MM, Reseller Suite | GitHub issues + Jira issues | Personal / after-hours |

**Hard partition, both ways:** Walter never touches ARC; Willis never touches SCRIP/MM/RS.

Consequences baked into the design:
- **Isolation is free.** The machine boundary enforces the partition — no in-software
  multi-tenancy, no access-control matrix. Each machine *is* its agent.
- **Disjoint memory by design.** Each agent's memory is scoped to its own world; cross-domain
  memory would be contamination, not a feature. Reinforces clause 4.
- **Identity = functional boundary, not persona.** "Which agent am I → which domains, trackers,
  repos" is load-bearing config (**keep**). Disposition/pushback/mythology/hand-tuned "souls"
  are self-expression (**cut**). One `identity.json`-style value, not a persona system.
- **Two-lane learnings.** A distilled learning is tagged:
  - *domain-bound* (how ARC's release flow works, a SCRIP quirk) → **stays home, never crosses.**
  - *domain-agnostic craft* (a debugging pattern, a git move, a test structure) → **may cross
    Willis↔Walter — manually, deliberately.** (See §4 / clause 5.)
- **Weighting: tidiness, not compliance.** The separation is a clean-worlds preference, not a
  governed control set. No encryption/retention/audit apparatus.

---

## 3. Architecture posture — Claude-native, not the enterprise product stack

The common "7-layer agent stack" (foundation → orchestration → memory → vector/RAG → tools →
observability → deployment) is a **product** stack: it assumes a model-agnostic agent served to
many users at scale. **V3 is a personal, Claude-native, two-machine tool.** So we map the
functions and deliberately skip the layers scale would justify but the North Star does not.

| Layer | V3 | Stance |
|-------|----|--------|
| Foundation model | Claude (Opus 4.x via Claude Code) | Covered; Anthropic manages it. |
| Orchestration | **Claude Code itself** (hooks, skills, MCP, subagents, Agent SDK) | Covered. **Do NOT add LangChain/LlamaIndex** — the harness *is* the orchestration. |
| Memory | SessionStart load (short-term) + FTS5/vec recall + distilled learnings (long-term) + agent identity (profile) | Covered — the heart. |
| Vector DB / RAG | **local SQLite + sqlite-vec** | Covered. **Do NOT add Pinecone/Weaviate** — hosted scale you don't have, at the cost of a network dep + data leaving the machine. |
| Tools & integrations | **MCP servers** + built-in tools + Jira/GitHub | Covered. MCP is the disciplined, proven integration standard. |
| Observability & eval | **my-work telemetry** (time-to-done, rework, act-vs-requery) | The one weak layer — minimal but **must be real**; it's the sensor for §6. **Do NOT add LangSmith.** |
| Deployment | `install.sh` / `update.sh` + git | Correctly absent. No cloud — V3 serves one user, locally. |

**Principle:** you are not missing structure — you run a leaner, native version of the same
functions, and correctly reject the three layers (orchestration framework, hosted vector DB,
cloud deploy) that only pay off for a scaled product.

---

## 4. MVP scope

### Harvested heart (port from V2, clean)
1. **Memory recall** — local SQLite FTS5 + vec, hybrid search fused with RRF, near-dup novelty
   for staleness. Single table, **no chunking dual-mode.**
2. **Reactive retrieval as MCP tools** — the agent calls `search_memory` on demand.
   **No speculative PostToolUse injection** (it fires on every result, spends tokens,
   destabilizes the prompt cache). Reactive-by-construction.
3. **SessionStart context load** — cheap, stable, once-per-session: which product, recent
   decisions/constraints. Prefix-cache-friendly.

### New builds (what V2 deliberately skipped)
4. **Portable distilled learnings (clause 5)** — session → Haiku-summarized *self-contained*
   learning artifact (harvest the summarizer + value-score rubric; change only the destination
   from "local DB row" to "markdown artifact that can ride git"), tagged domain-bound vs.
   portable craft. **Cross-machine transport deferred + manual.**
5. **Decision / supersession capture (accuracy tier)** — typed decision records with
   `supersedes` edges (reuse V2's `superseded` novelty flags) so V3 never surfaces a reversed
   decision.
6. **My-work telemetry (the instrument of record)** — log: act-on-result vs. re-query?
   time-to-done? rework/revert? **Replaces the recall@k eval gate entirely.** V2 already
   collects the raw signal (`access_queries`) and never uses it.

### Lean dev loop
7. **Harvested skills:** `commit`, `review-pr`, `ship` (trimmed of the long CI-settle watch),
   `investigate`, `sonar-check`, `doctor`.
8. **Modular tracker:** Jira + GitHub-issues backends; per-agent binding (Willis→Jira/ARC,
   Walter→Jira+GitHub/SCRIP·MM·RS). Read / transition / link only — **not** the PRD→Jira→QA
   pipeline.
9. **One quality gate:** a single diff-verify before ship. `red-blue-judge` survives **only as
   opt-in for high-stakes**, never forced or non-bypassable.

### Explicitly OUT of MVP
- Code graph (defer; earns its place only if the agent needs *programmatic* blast-radius and
  the editor's "find references" proves insufficient).
- Live cross-instance "powwow" (git-borne, manual sharing first).
- Persona/twins elaboration; PRD/Jira pipeline; `make-it-so` forced gates; self-audit +
  config-auditor skills; the whole compression / CCR / injection-ranker apparatus.

---

## 5. Build sequence

1. **Skeleton + memory recall** (harvested) — your existing search, clean, in the new repo. Day-one value.
2. **My-work telemetry — built SECOND, before any feature.** The instrument precedes the things
   it measures, so every later addition *proves* it moves the metric instead of being trusted on
   faith. V2's original sin was features without a my-work instrument; V3 inverts it.
3. **Reactive MCP retrieval + SessionStart load.**
4. **Portable distilled learnings** (clause 5 seam — distillation only; transport later).
5. **Decision / supersession capture** (accuracy tier).
6. **Lean dev-loop skills + modular tracker.**

Each step is independently useful and measured before the next.

---

## 6. How V3 stays current (standing governance)

**Governing principle: V3 evolves on *evidence*, not on *news*.** Clauses 2 and 3 *are* the
evolution policy. Nothing is adopted because it is new — only because the metric says I'm slow,
or a new capability would *provably* move the metric. **Staying current and staying lean are the
same discipline; the observability layer (§3, layer 6) is the compass for both.**

### Three modes
- **🏋️ Gym — strengthen what exists.** *Trigger:* the my-work metric **degrades or plateaus on a
  capability V3 already has** (noisy retrieval, missing recall, a slowing skill). *Source:*
  telemetry. *Cadence:* responsive — go when the metric dips, not on a calendar.
- **🎓 School — acquire a capability V3 lacks.** *Trigger:* **the environment shifted** to open a
  capability you don't have (a new GA Claude model with a real delta; a new MCP server for a tool
  you live in; a new Claude Code primitive; your *work* changed). *Source:* a deliberate horizon
  scan. *Cadence:* periodic — the scan yields a **candidate list, not an adoption.**
- **🗑️ Retire — drop a capability that stopped earning its place.** *Trigger:* a component's metric
  contribution fell to noise, or the thing it served is gone. **A system that can't retire becomes
  V2 again.** *Cadence:* every periodic review asks "what comes *out*," not just "what goes in."

### Governance rhythm
1. **Continuous:** telemetry is always on. Metric dip on an existing capability → gym.
2. **Periodic horizon scan (quarterly):** lightweight review of what changed in the Claude
   ecosystem and in your work, plus "what can retire." Output is a **list**; nothing is built yet.
3. **Adoption gate = the North Star filter:** nothing ships unless it *provably* moves
   speed/quality/accuracy on *my* work. New ≠ adopt.
4. **Proven, not bleeding-edge:** prefer **GA** primitives; pilot a beta only when the metric case
   is strong. Adopt on *proof*, not on *announcement*.
5. **Reversible, measured adoption:** measure before/after on my-work, behind a flag, revert if it
   doesn't move the metric.

### The syllabus (what to track, highest-ROI first)
- **MCP servers for your tools** (better Jira/GitHub MCP directly speeds Willis/Walter) — #1 axis.
- **Claude Code primitives** (hooks, skills, subagents, Agent SDK, plugins) — your orchestration layer.
- **New Claude models** — adopt on a capability delta that moves my-work, GA-gated.
- **API features** (prompt caching, extended thinking, tool-use modes) — where they move the metric.

**Caution:** the horizon scan stays a *checklist that produces decisions* — not an apparatus that
audits itself. The moment it grows gates-on-gates, it has become the ceremony the V2 teardown cut.

**The one-line rule:** *weak metric on a capability you have → gym; metric fine but the world has a
capability you lack → school; a capability's contribution went to zero → retire.* You don't guess —
the compass reads it.

---

## 7. Layout & naming

- **Repo:** `Dioscuri` (GitHub, fresh — `claude-os` is taken).
- **Local:** `~/.dioscuri/` (lowercase, for cross-platform safety) next to `~/.claude/` — the repo
  clone (code + config), shared via git across machines.
- **Data:** `~/.dioscuri/data/` — local memory/learnings, **gitignored, never leaves the machine**
  (clause 4).
- **Multi-machine:** code ships via git (clone on each machine); raw memory stays local; portable
  craft learnings ride git only when you deliberately cross them (clause 5).

---

## Appendix A — V2 teardown verdict (keep / cut / build reference)

| Cluster | Keep (harvest clean) | Cut (dead or retired-invariant) | Note |
|---------|----------------------|----------------------------------|------|
| **Memory engine** | `search_memory`, embedder, RRF ranking, `fts_query`, near-dup novelty, db core, watcher | chunker / migrations / cutover / result_shaper (never cut over), recall@k + fidelity eval gates | retriever harvests clean; gate measured the wrong thing (uncurated placeholder set) |
| **Hooks / injection** | the "one PostToolUse hook, fail-safe" skeleton; *ideas*: preserve-error-rows, reactive retrieval, staleness-before-compact | CCR three-store, six-factor ranker, enrich, TOIN, cache-aligner audit, FR-B5 capture | **CCR/ranker/enrich had zero production callers.** Harvest ideas, not code (~80% sheds) |
| **Code graph** | reverse-reach / blast-radius primitive (rebuild lean, no artifact) | artifact-io portability guard, sidecar/determinism, contracts (a permanent no-op), staleness hook, ~70% of graph-auditor, config-auditors | **query API's only caller is its test.** ~40–50% was cross-machine determinism ceremony |
| **Capture / gov / identity** | Haiku summarizer + value-score, capture-queue pattern, cache-aligner discipline, ~6–8 dev-loop skills, launchd installer | red-blue-judge as forced gate, make-it-so pipeline, write-a-prd/prd-to-jira/QA, audit/skill/identity-check skills, persona/twins layer | capture produces *local raw memory*, not portable learnings — clause 5 is the new build |

**Net:** V3 ≈ 20–30% of V2's surface, and covers the North Star *better* — because it adds the
portable-learnings + my-work telemetry V2 lacked while shedding dead scaffolding and product
governance. Ground-up *design*, harvested *heart*, one *new* build.
