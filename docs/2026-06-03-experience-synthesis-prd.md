# PRD — B1: Cross-Session "Experience" Synthesis Pass (grounded)

*Authored 2026-06-03 · roadmap item B1 (A1→A2→B1; A1 and A2 shipped to main) · gated by red-blue-judge before implementation*

## Problem Statement

claude-os has accumulated 752 session episodes plus a growing set of dated learning
entries, but it has no mechanism to abstract a pattern *across* sessions. Each episode
is digested in isolation; promotion of an episode's signal into a durable learning is a
**manual, one-at-a-time chore** that lives only in Jason's global operating rules
(`list_episodes({promoted:false})` → read → hand-write a learning → `mark_episode_promoted`).
The result is the "filing cabinet, not a learner" gap (briefing Gap 5): the system stores
everything it witnessed and abstracts none of it. Jason re-derives patterns the system
already saw three times. On the memory-maturity ladder (Storage → Reflection → Experience),
claude-os sits at Storage with early Reflection and never reaches **Experience**.

The reason this gap has stayed open is that the obvious fix is dangerous. Asking an LLM to
"find the deeper lesson across these sessions" is precisely the operation that manufactures
*spurious* insight from coincidental clusters — and any fake learning it produces is written
into the same retrieval layer that A1 ranks and A2 dedups, polluting the spine of the entire
memory system. So the problem is not "cluster and summarize"; it is **"cluster and summarize
without ever letting an unearned insight reach the live memory."**

## Solution

A periodic, fully human-gated synthesis pass, implemented as a standalone skill
`/experience-synthesis` and surfaced as **Phase 4 of `/memory-merger`** (so running memory
maintenance naturally includes it). The pass:

1. **Clusters unpromoted episodes** by embedding. Episodes are already embedded whole-file
   into `vec_items`, so clustering reuses pre-computed vectors — no re-embedding. The
   `promoted` flag *is* the backlog: unpromoted = not-yet-synthesized.
2. **Distills each coherent cluster** into one candidate "experience learning" — a
   higher-order rule that holds across the cluster's sessions, expressed as a proposal that
   conforms to the existing `proposal-schema.json` shape (category `EXPERIENCE_LEARNING`).
3. Subjects every candidate to **three independent pre-human gates**, each catching a
   different failure mode:
   - **Gate 1 — Grounding (mechanical, tested).** A `validate_experience_proposal` MCP
     tool verifies the proposal is schema-valid and that every cited episode resolves to a
     real episode file — both **deterministic and unit-tested** — and additionally checks the
     proposed learning is not a near-duplicate of an existing learning. That last sub-check
     embeds via the model (like `scan_novelty`), so it is *not* deterministic, but it is still
     tested with the unit-vector mock override. A fabricated citation fails here, mechanically.
   - **Gate 2 — Quality (`/grade-proposal`, ≥70).** Each surviving proposal is graded once,
     in isolation, against the existing rubric. The rubric's `evidence_strength` dimension
     awards its top band only to proposals citing 3+ distinct sessions — structurally
     punishing insight drawn from a coincidental pair.
   - **Gate 3 — Truth (`red-blue-judge`, new `experience` mode).** An adversarial cross-check:
     a reviewer scores the proposal against grounding/coherence invariants, and on a
     provisional CLEAN a blind red challenger tries to land one grounded FAIL. Tests whether
     the cited episodes *genuinely support* the claim and whether the cluster is coherent
     rather than coincidental.
4. **Only proposals that clear all three gates reach Jason** at the existing propose-then-wait
   approval gate. On approval, the learning is written via `append_learning` and the cited
   source episodes are marked promoted (removing them from the next run's backlog).

Nothing is ever auto-applied, auto-merged, or deleted. The `promoted` flag is the only new
state. The anti-insight-inflation requirement from the Phase-4 ruling is the design's spine:
three orthogonal gates plus a human, with grounding enforced by tested code rather than by
prose hope.

## User Stories

1. As Jason, I want the system to surface cross-session patterns it already witnessed, so that
   I stop re-deriving lessons the episodes already contain.
2. As Jason, I want every synthesized learning to cite the specific episodes it came from, so
   that I can verify the claim against its evidence before trusting it.
3. As Jason, I want spurious "insights" filtered out before I ever see them, so that my review
   time is spent on candidates that are already well-grounded.
4. As Jason, I want synthesis to run as part of `/memory-merger`, so that experience synthesis
   happens during the same periodic maintenance I already do, not as a separate ritual.
5. As Jason, I want to approve or reject each synthesized learning individually, so that the
   human gate over my memory's curation is never bypassed.
6. As Jason, I want nothing deleted or auto-written during synthesis, so that the pass can
   never silently lose or corrupt a memory.
7. As Jason, I want the source episodes of an accepted learning marked promoted, so that the
   same episodes are not re-synthesized on the next run.
8. As Jason, I want synthesis to ignore episodes I've already promoted, so that the pass only
   ever works the backlog of un-abstracted experience.
9. As Jason, I want a clustering threshold and minimum cluster size chosen on principle (not
   fit to a sample), so that the behavior is predictable and explainable.
10. As Jason, I want clusters of fewer than three episodes skipped, so that no proposal is ever
    built on evidence too thin to earn the grader's top band.
11. As Jason, I want the synthesized learning to be a concrete, actionable rule rather than a
    platitude, so that it is worth its place in the retrieval layer.
12. As Jason, I want a synthesized learning that merely restates a learning I already have to
    be caught and dropped, so that synthesis does not re-bloat the layer A2 just deduplicated.
13. As Jason, I want a synthesized learning that contradicts an existing learning to be flagged
    for me rather than silently added, so that I decide which one wins.
14. As Willis, I want clustering to reuse the embeddings already stored for episodes, so that a
    synthesis run is cheap regardless of how many episodes exist.
15. As Willis, I want the "unpromoted episode" definition to live in exactly one place, so that
    `scan_experience` and `list_episodes` can never drift apart.
16. As Willis, I want the proposal-shaping and citation checks to be pure, tested functions
    behind a tool, so that gate 1 is enforced code, not a prose instruction I might skip.
17. As Willis, I want the adversarial cross-check to use the same auditable `red-blue-judge`
    framework as A1 and A2, so that experience proposals get the same rigor and leave the same
    audit trail.
18. As Willis, I want the synthesis skill to be a thin orchestrator over tested tools, so that
    most of its behavior is covered by unit tests and only irreducible LLM judgment is not.
19. As a future maintainer, I want experience proposals to conform to the same
    `proposal-schema.json` as `/review-performance`, so that one grader serves both producers
    without a fork.
20. As a future maintainer, I want synthesis to add no new database table, so that the schema
    surface stays small and the `promoted` flag remains the single source of "already handled."
21. As Jason, I want a bounded number of episodes considered per run, so that a synthesis pass
    has a predictable cost ceiling even as the episode archive grows.
22. As Jason, I want a clear report at the end of a synthesis pass (proposals generated, filtered
    at each gate, accepted, episodes promoted), so that I can see what the pass did and why.

## Implementation Decisions

### Corpus and recency
- The synthesis corpus is **unpromoted episodes only** (`promoted: false` in episode
  frontmatter). Existing learnings are *not* folded into the clustering set (avoids mixing
  whole-file episode vectors with non-persisted entry vectors); learnings-awareness is instead
  enforced as a guard (gate 1 duplicate check + gate 3 contradiction/duplication invariants).
- "Recent" therefore means "not yet synthesized." On approval of a synthesized learning, every
  cited source episode is marked promoted via the existing `mark_episode_promoted` tool, which
  removes it from the next run's backlog. **No new state table is introduced.**
- A run considers at most a configured cap of the most-recent unpromoted episodes (by date), so
  cost is bounded as the archive grows.

### Clustering
- A new pure helper module provides `clusterByEmbedding(items, vectors, {threshold, minSize})`,
  which groups items by **union-find over pairwise cosine edges**: for every pair whose cosine
  similarity is at or above the threshold, union the two; then keep connected components whose
  size is at least `minSize`. Returns groups (with member references and an informational
  intra-cluster cohesion value). This is the analog of A2's `findNearDuplicateEntries` but
  returns *groups*, not flat pairs.
- Clustering operates on **pre-computed episode embeddings pulled from `vec_items`** by
  `observation_id` (resolved from the episode's `source_path`). Episodes not yet indexed/embedded
  are skipped and counted.
- Thresholds are fixed, documented defaults added to the existing search-config constants module,
  following A1's "principled defaults, not fit to any eval set" discipline:
  - `EXPERIENCE_CLUSTER_COSINE` ≈ 0.70 — a *thematic* relatedness threshold, deliberately well
    below A2's 0.92 near-duplicate threshold (we want "same kind of situation across sessions,"
    not "near-identical text").
  - `EXPERIENCE_MIN_CLUSTER_SIZE` = 3 — tied directly to `/grade-proposal`'s evidence band: a
    cluster of fewer than three episodes cannot earn the top `evidence_strength` score, so it is
    not worth synthesizing.
  - A maximum-episodes-per-run cap for cost bounding.

### New MCP tools
- **`scan_experience`** — mechanical clustering, the analog of `scan_novelty`. Enumerates
  unpromoted episodes (via the shared enumerator below), pulls each one's embedding from
  `vec_items`, runs `clusterByEmbedding`, and returns the clusters with each member's path,
  session_id, date, and summary. It performs **no LLM synthesis and persists nothing**.
- **`validate_experience_proposal`** — gate 1, made deterministic and enforceable. Given a
  proposal, it verifies: (a) schema conformance to `proposal-schema.json` (id pattern, ≥2
  evidence items, `proposed_change` with file + action, `EXPERIENCE_LEARNING` category, impact
  within bounds); (b) every cited episode reference resolves to a real file under the episodes
  directory (anti-fabrication); and (c) the proposed learning is not a near-duplicate of an
  existing learning entry (reusing A2's `parseEntries` + `lexicalSimilarity`/cosine helpers). It
  returns `{ valid, errors[], duplicate_of? }`. The pure proposal-shaping and citation-checking
  functions live in the experience helper module and are unit-tested directly; the tool is the
  skill-callable surface over them.
- Both tools are registered in the MCP server following the established three-spot pattern
  (import, ListTools array, CallTool switch) using `scan_novelty` as the template, and named to
  parallel it.

### Shared episode enumeration
- The "unpromoted episode" enumeration is extracted into a single shared helper
  (`listEpisodeFiles({promoted})`) used by both the existing `list_episodes` tool and the new
  `scan_experience`. This pre-empts the duplicated-definition failure A2's diff gate caught: the
  two callers must never grow independent notions of what an unpromoted episode is.

### The synthesis skill
- `/experience-synthesis` is a standalone skill that orchestrates the full pipeline: call
  `scan_experience` → for each cluster, read the member episode files and distill one candidate
  experience learning → build a schema-shaped proposal citing the cluster's source episodes →
  **gate 1** (`validate_experience_proposal`) → **gate 2** (`/grade-proposal`, keep ≥70) →
  **gate 3** (`red-blue-judge` in `experience` mode, keep CLEAN; on REVISE regenerate against the
  cited lines up to the gate's cycle cap; on ESCALATE surface to Jason) → present survivors at the
  human approval gate. On approval, write each learning via `append_learning` and call
  `mark_episode_promoted` on its cited episodes.
- The skill is a *thin orchestrator over tested tools*. It produces a run report (proposals
  generated, count filtered at each gate, accepted, episodes promoted).
- Its `allowed-tools` grant the new MCP tools, `list_episodes`, `mark_episode_promoted`,
  `append_learning`, file reads, and invocation of `/grade-proposal` and `red-blue-judge`.

### grade-proposal integration
- Experience proposals reuse `/grade-proposal` **unchanged** — it scores five dimensions and is
  category-blind. The only schema changes are **additive and backward-compatible**: an
  `EXPERIENCE_LEARNING` value added to the `proposal-schema.json` `category` enum, and an
  `APPEND_LEARNING` value added to its `proposed_change.action` enum (neither affects
  `/review-performance`'s existing categories or actions). The action value is required so that
  an experience proposal is schema-valid at gate 1, whose validator checks `action` against the
  enum.
- Experience proposals populate the schema as: evidence = the cited source episodes (target ≥3),
  `proposed_change` = `{ file: agent learnings file, action: APPEND_LEARNING, content: the
  distilled learning }`, `estimated_weekly_savings_minutes` = an honest estimate of re-derivation
  time saved. The ≥70 pass threshold applies as-is.

### red-blue-judge `experience` mode
- A new `experience` mode is added to the gate (mode enum in the skill + a rubric block in
  `rubrics.md`, following the documented "adding a rubric" procedure). Its ground truth is the
  cited source episodes plus the existing learnings; its artifact is the proposed experience
  learning. Invariant lines:
  - **E1 — Grounding:** every claim in the proposal is supported by a cited source episode.
  - **E2 — Non-contradiction:** the learning is not contradicted by an existing learning.
  - **E3 — Non-duplication:** the learning is not a restatement of an existing learning.
  - **E4 — Coherence:** the cluster is thematically coherent; the abstraction is earned, not a
    coincidental grouping.
  - **E5 — Scope & specificity:** scope (agent vs project) is correct and the learning is a
    concrete, actionable rule rather than a platitude.
- The skill consumes the standard `RBJ-VERDICT` contract and loops exactly as `make-it-so` does.

### memory-merger Phase 4
- `/memory-merger` gains a **Phase 4 — Experience synthesis** that invokes `/experience-synthesis`.
  Phase 4 executes last (after Phase 3 supersession), so synthesis clusters over an already
  cleaned and deduplicated learnings corpus. The Step 4 proposal block and Step 8 execution order
  are extended; the approval-gate wording adds `'go phase 4'`; the Step 9 report gains a Phase 4
  line. memory-merger's `allowed-tools` are extended only as needed to invoke the synthesis skill.

## Testing Decisions

A good test asserts **external behavior**, not implementation detail: given seeded episodes/vectors
or a given proposal object, assert the clusters, the validation verdict, or the schema conformance
that results — never the internal control flow. Tests must be anti-tautological: they must fail if
the production logic is reverted.

**Unit-tested modules:**
- **Clustering engine** (`clusterByEmbedding`): seeded vectors that form known groups produce the
  expected components; pairs below threshold do not union; components smaller than `minSize` are
  dropped; a fully-disconnected set yields no clusters. This is the deep module and the highest-value
  test target.
- **Shared episode enumerator**: unpromoted filter returns only `promoted:false` episodes; the
  existing `list_episodes` behavior is unchanged (its current tests continue to pass against the
  extracted helper).
- **`scan_experience` tool**: integration test that seeds episodes and drives a real cluster. Per the
  A2 lesson, this test **overrides the default zero-vector embedder mock with a unit vector** so that
  cosine actually crosses the threshold — a constant-zero mock would leave the clustering path dead
  and silently untested. Asserts clusters are returned with member identities; asserts episodes
  missing an embedding are skipped, not fatal.
- **`validate_experience_proposal` tool + proposal/citation helpers**: a schema-valid, real-citation,
  non-duplicate proposal returns `valid: true`; a proposal missing required fields returns the
  specific errors; a proposal citing a non-existent episode fails the grounding check; a proposal
  whose content near-duplicates an existing learning returns `duplicate_of`.
- **`search_config` constants**: existence and sanity of the new constants (a `search_config` test
  already exists for A1/A2 constants — extend it).

**Covered by the red-blue-judge mode harness if present, else by prose:** the `experience` mode
rubric. If `red-blue-judge`'s `tests/` directory has a mode-registration / verdict-format harness, the
new mode is added to it; otherwise the mode is validated by inspection and by the gate's own runtime
operation.

**Explicitly not unit-tested (irreducible model judgment, covered by the gate architecture and the
implementation diff-gate):** the distillation text the LLM writes; `/grade-proposal`'s internal
scoring; `red-blue-judge`'s adversarial reasoning; `/memory-merger`'s Phase 4 delegation prose. A unit
test asserting "the LLM synthesized a good insight" would be a fabricated green and is forbidden. The
skill is deliberately shaped as a thin orchestrator so that the maximum mechanical surface — including
the gate-1 grounding check — is pulled into the tested tools, leaving only genuine model judgment
outside unit coverage.

**Prior art for the tests:** A2's `novelty.test.ts` (pure helpers incl. clustering), `db.test.ts`
(table/constraint behavior), `tools.test.ts` (MCP tool behavior incl. the unit-vector mock-override
technique for cosine-gated paths), and `search_config.test.ts` (constant sanity). These patterns are
copied directly.

## Out of Scope

- **Folding learnings into the clustering corpus.** v1 clusters episodes only; learnings-awareness is
  a guard (gate 1 duplicate check, gate 3 invariants), not a clustering input. Mixing learning-entry
  vectors with episode vectors is deferred.
- **Contradiction-polarity detection.** Vectors give proximity, not polarity; "does this contradict an
  existing learning" is judged by gate 3 (adversarial review), not computed.
- **Persistent per-episode-cluster state / a new DB table.** The `promoted` flag is the only state.
- **Automatic promotion or writing.** Every write is human-approved; nothing is auto-applied or deleted.
- **Synthesizing across non-episode sources** (context topics, project files). v1 is episode-focused.
- **Per-entry embedding persistence for learnings.** Out of scope; only episodes (already embedded) are
  clustered.
- **Tuning the clustering threshold against a labeled set.** Defaults are principled; tuning is a later,
  data-in-hand step.
- **Extending `/grade-proposal`'s rubric** for experience-specific scoring. Reuse as-is; revisit only if
  real runs show strong proposals systematically dying on the impact dimension.

## Further Notes

- **Scale.** ~752 episodes exist; episode bodies are already embedded whole-file in `vec_items`, so the
  per-run cost is dominated by union-find over the (capped, unpromoted) candidate set — cheap. No
  re-embedding occurs in the common path.
- **Episode `project` is free-text.** Episode frontmatter `project` is a descriptive label (e.g.
  "BTC (Bacta Tank / ...)"), not a clean slug; do not assume it partitions episodes cleanly. Clustering
  is by embedding, not by project, so this does not affect v1.
- **`extractSummary` lockstep.** The episode-summary regex is duplicated between `list_episodes` and a
  CommonJS twin in the hooks layer (`hooks/lib/episode-utils.js`); if the shared enumerator touches
  summary extraction, keep both in lockstep.
- **red-blue-judge is now model-invocable.** The `disable-model-invocation` flag was removed from the
  gate skill on 2026-06-03, which is what lets `/experience-synthesis` invoke it directly as gate 3.
- **Alignment with the active quality goal.** This design maximizes the unit-tested, pre-merge surface
  (including pulling gate 1 out of prose into a tested tool) and follows the design-before-implement,
  gate-before-merge discipline — directly serving the "reduce Ship-Then-Fix / pre-merge rework" goal.
- **Genome changes.** This feature modifies shared `~/.claude-os/` assets (the MCP server, `search_config`,
  `red-blue-judge`, `memory-merger`, `proposal-schema.json`) and adds the `/experience-synthesis` skill.
  All such changes propagate to Walter and require Jason's explicit approval at merge/transmit time.
