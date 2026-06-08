# claude-os Leverage Briefing — Self-Contained Spec & Decision Record

**Date:** 2026-06-08
**Author:** Walter (Jason's agent, personal Mac / macelabs-macair), AI-generated, human-directed
**Status:** Decision record + implementation spec. Ready to execute the First Move.
**Source method:** A multi-agent Workflow run (31 agents, 12 recency-biased research sweeps → 49 primary sources → 33 distinct findings → 6 ranked bets → a full red-blue-judge adversarial gate with code-grounded verification). Run ID `wf_44a0ff69-d04`.

> **Why this document exists, and how to read it.** This is written so a *cold session with zero prior context* can pick up the work, execute the first move, and defend every ranking without the originating conversation. Nothing is abbreviated to "see above." Every verdict carries its reasoning; every code claim carries the file it was verified against; every premise that was *falsified during review* is recorded as falsified, because the falsifications are the most valuable part. If you are that cold session: read §1 (what claude-os is), §2 (the goal), §3 (the verified ground truth — this is the spine), then §7 (the First Move) and §8 (the build specs). §4–§6 are the full evidentiary record behind the rankings.

---

## 1. What claude-os is (context for a cold reader)

claude-os is a **single-maintainer personal AI operating system** built on top of the Claude Code CLI. It is explicitly **not** a community project and **not** seeking outside adoption. The maintainer/operator is Jason, who runs it through **two named agent instances sharing one codebase**:

- **Willis** — work Mac, ARC / FamilySearch engineering context.
- **Walter** — personal Mac (`macelabs-macair`), this machine.

Both run the same genome under `~/.claude-os/` (a git repo, synced across machines via `/transmit-claude-os` and `/assimilate-claude-os`). Each agent has its own **private, machine-local** data store under `~/.claude-data/` (NOT a git repo — it is `.gitignore`'d by design; "data must NEVER end up in this repo").

**Already-built capabilities** (verified present in code — usage is a separate question, see §3):

- **SQLite hybrid memory** (`mcp/src/db.ts`): tables `observations`, `observations_fts` (FTS5), `vec_items` (sqlite-vec, nomic-embed-text-v1.5, 768-dim, q8/int8), `access_stats`, `novelty_flags`, `meta`. Hybrid search fuses FTS5 keyword + semantic via **Reciprocal Rank Fusion** (`mcp/src/ranking.ts`, *not* a weighted-blend — this matters, see §3).
- **Reinforcement re-ranking**: `access_stats(observation_id, last_accessed, access_count)` — retrieval bumps a per-memory counter; `reinforcementBonus()` (ranking.ts:40-54) re-ranks frequently/recently-retrieved memory upward. **Monotonic in access_count + recency, additive, non-penalizing — no value or staleness term.**
- **Episodic session memory** + background summarization worker (`session-observer.js` → `session-observer-worker.js`). **136 episodes accreted on Walter as of this date.**
- **Cross-session experience synthesis** (`scan_experience`, `validate_experience_proposal`, `/experience-synthesis`): clusters the unpromoted episode backlog by embedding cosine similarity, distills candidate learnings, gates them through grounding + grade (≥70) + adversarial (red-blue-judge CLEAN), human-gated promotion.
- **Memory novelty / duplicate flagging** (`scan_novelty`, `resolve_novelty_flag`, `/memory-merger`).
- **Lifecycle hooks** (`hooks/`): `session-start-check.js` (context injection), `topic-preload.js` (keyword-matched topic auto-injection at prompt time, emits a passive `[Context hint]`), `learnings-flush.js` (session-end flush), `session-observer.js` (background episodic summarization), `digest-queue-write.js`/`digest-queue-deliver.js`, `rule-enforcement.sh` (PreToolUse guard logging git/gh to `~/.claude/hooks-log.jsonl`).
- **Multi-agent persona identity** with per-machine private stores + identity-drift telemetry.
- **MCP integrations**: Jira (Atlassian), GitHub, SonarQube, Slack.
- **Scheduled background jobs** (`config/scheduled-jobs.json`): PR surveillance 06:00, sprint-staleness 06:30.
- **Diagnostic/eval tooling**: labeled-query retrieval eval harness (`mcp/eval/labeled-queries.json`), self-audit skills (`audit-claude-os`, `mcp-health-audit`, `skill-auditor`).
- **44 skills, 11 subagents, 2 global slash commands** (`/design-review`, `/release`).

---

## 2. The leverage target (Phase 0)

The goal is **operator leverage**, not adoption. Treated as a usage loop, not an acquisition funnel:

> **invocation** (do I reach for it?) → **activation** (did this session produce real value?) → **retention** (did it become a habit?) → **compounding** (does each session make the next one better?)

**Operator(s):** one person (Jason), two agent instances (Willis work-Mac, Walter personal-Mac), one shared genome, two private data stores. *This distinction is load-bearing for bet B3* — "cross-agent" here means one operator across two contexts, not two colleagues.
*Assumption (flagged):* Walter's store was inspected directly (136 episodes, 79 lines agent-learnings, 8 lines claude-os project-learnings). Willis's store was NOT inspected (different machine); assumed at least as active.

**Primary value metric:** **share of real work routed through claude-os ("routed-through rate")** — per high-leverage workflow, the fraction of real instances that went through the skill vs. done manually (commits via `/commit` ÷ total commits, PRs via `/review-pr` ÷ total, etc.). Chosen over *value-per-session* / *hours-saved* because those are unobservable estimates, while routed-through is mechanically tied to compounding (every routed session writes episodes + learnings; every bypassed one writes nothing).

**Supporting signals:** (1) **skill-invocation coverage** — % of 44 skills + 11 subagents invoked ≥1× in trailing 30d; (2) **learning-reuse rate** — promoted learnings retrieved in *later* sessions ÷ promoted; (3) **value-positive session rate** — sessions that produced real value.

**Baseline (what is actually known):** see §3. The headline: memory is over-metered, the workflow funnel is unmetered *in SQLite* — but, critically, **NOT unmeasurable** (see §3, falsified premise #1).

---

## 3. VERIFIED GROUND TRUTH — the spine of this briefing

> Everything below was verified against the live machine/codebase during the gate review (reviewers ran the scans, queried the schema, read the files). These facts override any plausible-sounding assumption. **The single most important lesson of this session: specs and briefs describe imagined system states; only verification against the real artifact separates a plausible plan from a correct one.** (This is the same lesson as the GitHub-issue closures earlier the same day — see §10.)

### 3.1 Verified facts about the codebase

| # | Fact | Verified against |
|---|------|------------------|
| GT-1 | The SQLite schema has **no skill/subagent/command invocation table**. Tables are exactly: `observations`, `observations_fts`, `vec_items`, `access_stats`, `novelty_flags`, `meta`. | `mcp/src/db.ts` (full schema read) |
| GT-2 | `access_stats` is exactly three columns: `observation_id`, `last_accessed`, `access_count`. No `session_id`, no outcome, no query, no event log. It meters **memory retrieval only**. | `db.ts` schema + `.schema` query |
| GT-3 | `reinforcementBonus()` is built from exactly two terms — recency (exp decay) + frequency (log-saturating in `access_count`) — additive, **non-penalizing, no value or staleness term**. The system reinforces *most-touched*, which can be *confidently-wrong* as it goes stale. | `ranking.ts:40-54` |
| GT-4 | Hybrid search fuses by **Reciprocal Rank Fusion over rank positions** (`1/(RRF_K+pos)`) + an additive reinforcement bonus + exact-match bonus. There is **no `0.5·semantic + 0.3·BM25` weighted blend**. RRF terms are ~0.01–0.03 scale. | `ranking.ts:71-93` |
| GT-5 | Episode frontmatter is hard-restricted by an allowlist `ALLOWED_FM_KEYS = {date, session_id, project, turns, promoted}` — any other key is silently dropped. **There is no value field anywhere in the system.** | `hooks/lib/episode-utils.js:22` |
| GT-6 | Episode-write is gated on `hasSignal` (content-salience: did the session contain decisions/corrections/discoveries?) — **NOT a value test**. A 2-hour thrash that shipped nothing and got reverted produces an episode weighted identically to a clean fix. | `session-observer-worker.js:251` |
| GT-7 | Experience-synthesis clusters by **embedding cosine only** (union-find over pairwise similarity), and SKILL.md Step 1/2 processes **"highest-cohesion clusters first"** — value is never an input to which episodes compound first. The only value-shaped field (`estimated_weekly_savings_minutes`, bounded [0,600]) is a **post-hoc LLM guess**, not a measured outcome. | `experience.ts:84,109`; `scan_experience.ts:16-21,75-87` |
| GT-8 | `access_count` only bumps **inside `search_memory`** (search_memory.ts:204-221). The dominant context-delivery path — the `topic-preload` hook / `get_topic` — **reads markdown from disk and never touches `access_stats`**. So "retrieved" systematically under-counts real firing via the hook path. | `search_memory.ts:204-221`; `get_topic.ts` |
| GT-9 | `topic-preload.js` (70 lines) fires on **UserPromptSubmit** (the highest-frequency event), keyword-matches an index, and emits a **passive `[Context hint]`** suggesting `get_topic(...)` — it **never enforces a skill** and has **no record of whether the injected topic helped**. | `topic-preload.js:56-62` |
| GT-10 | `~/.claude/hooks-log.jsonl` logs only Bash/Edit/Write tool calls (**2907 rows, 443 sessions, zero Skill events**). Tool breakdown ≈ {Bash:2522, Edit:268, Write:117}. It carries `session_id` on every row, and the git/gh denominator IS present (≈30 commit, 50 gh-pr, 11 push). | `~/.claude/hooks-log.jsonl` scan |
| GT-11 | `review-performance/scripts/parse-session-transcripts.sh` globs `~/.claude/projects/**/` but extracts only `*/memory/*.md` Auto-Memory files (line 81) — **NOT** the `.jsonl` `tool_use` records. The harvesting *muscle* exists; the invocation aggregation does not. | `parse-session-transcripts.sh:81` |
| GT-12 | `parse-hook-logs.sh` already does `by_tool`/`by_repo`/repeated-pattern aggregation over hooks-log.jsonl. | `review-performance/scripts/parse-hook-logs.sh` |
| GT-13 | `~/.claude-data` is **not a git repo** (no `.git`) and is `.gitignore`'d. So `agent/learnings.md` (79 lines), `memory.db`, and the 136 episodes are **100% machine-local** and do NOT cross between Willis and Walter. | filesystem inspection |
| GT-14 | `assimilate-claude-os` is a **pure `update.sh` pull-and-rebuild** — its job is to install the counterpart's skill/agent *code* changes. So skills DO cross machines via the git genome; **only the private data store (learnings/memory) is stranded.** | `assimilate-claude-os/SKILL.md` |
| GT-15 | The 4 canonical lifecycle hooks are SessionStart, UserPromptSubmit, Stop, Stop. There is **no PostToolUse lifecycle hook** (only PreToolUse guards). `session-observer.js` spawns a detached worker and exits <100ms (the template a new meter would reuse). `hooks-install.js` is the single source of truth merged idempotently by `update.sh` Step 3 → adding a hook propagates to both Macs with no manual step. | `hooks-install.js:26-34`; `session-observer.js` |
| GT-16 | The user-scope policy **forbids the `Co-Authored-By` footer** ("Jason's solo work"). This is the one commit fingerprint that would let a hook discriminate a `/commit`-produced commit from a manual one — and it is suppressed by policy. | `~/.claude/CLAUDE.md` |
| GT-17 | 44 skill directories (`ls skills/*/` = 44) + 11 subagents. This is past the **measured ~32-skill discovery budget** where descriptions truncate and ~⅓ of skills become effectively invisible to native dispatch. | `ls skills/`; discovery-ceiling source |

### 3.2 Reproduced metrics (computed during review from data that already exists)

These were computed by the red-team reviewer by scanning **1,959 transcripts / 342,911 lines across 53 projects, spanning 2026-05-05 → 2026-06-08**, from `~/.claude/projects/**/*.jsonl` (where every Skill invocation is a `tool_use` record with the name in `input.skill`, every subagent dispatch an Agent/Task `tool_use`):

- **Trailing-30d skill-invocation coverage = 38.6% (17 of 44 skills used).**
- **Full 27-skill "never reached for in 30d" list** includes: arc-release, audit-claude-os, oracle, review-performance, sonar-check, standup, estimate, identity-check, mcp-health-audit, one-on-one, … (the high-leverage *deep-workflow* tail is disproportionately here).
- **≈0.91–1.1 skill-invocations per session.**
- **1,780 name-attributed Skill invocations + 644 subagent dispatches** in the window.
- Caveat on representativeness: the 136 episodes span only ~5 active days (Jun 4–8) — a **build-out burst dominated by claude-os self-development**, not steady-state operator work. Any rate is uncalibrated until more representative data accretes.

### 3.3 FALSIFIED PREMISES (recorded because they re-shaped the conclusions)

1. **"Usage is unmeasurable until we build instrumentation" — FALSE.** The headline metric was *reproduced today* from existing on-disk transcripts with a ~40-line read-only script. The blind spot is real only for the *SQLite layer*, NOT for the operator's actual data. → This collapsed bet A1's load-bearing justification and dropped its score to 4. **The cheapest win is reading what's already there, not building a meter.**
2. **"`scan_experience`/reinforcement will consume a value bit" — FALSE as-is.** Both clustering (cosine, GT-7) and reinforcement (memory-retrieval, downstream of promotion, GT-3) would leave a value bit in frontmatter *unread*. → A value scalar (A2) must ship its first consumer in the same unit of work, or it reproduces the under-used-capability failure.
3. **"commit = value" — FALSE and biased.** `investigate`/`design-review`/`oracle`/`grill-me` are high-leverage *by design* and produce no commit. Commit-inference would systematically score the most valuable workflows as value-negative. → A2's value signal must be inference-from-transcript (reuse grade-proposal/red-blue-judge judge infra), not commit-presence.
4. **"Cross-machine transfer moves skills" — FALSE.** Skills already cross via the git-synced genome (GT-14); when Willis uses a skill, Walter already *has* it in code. Only the private learnings/memory are stranded (GT-13). → B3 narrowed to transfer learnings/experiences/high-helpful-count memories, dropping "heavily-used skill."
5. **"A hint opens discovery for the long tail" — PARTIALLY FALSE framing.** The prompt consumer is the *agent*, which already has all 44 descriptions in context (native dispatch). BUT the system's own data says hook-surfaced skills fire ~84% vs ~20% model-choice — so model-choice discovery IS the weak link, which is what B2 attacks. The hint is an *agent-relevance nudge* (consistent with the existing `[Context hint]` contract), not a human-discovery banner. → B2 survives but its causal metric is impossible in an n-of-1 system (no holdout); use correlation + a monthly hint-suppressed week.

---

## 4. Phase 1 — External intelligence sweep (49 sources, 12 angles)

**Recency:** Apr–Jun 2026 dominant. Stale-flagged (>6mo, used only corroboratively): `clig.dev Discoverability` (2024, evergreen), `User Retention in AI Platforms` (2025-11), `AgentEvolver` (2025-11), `ASG-SI` (2025-12-28), `AGENTS.md outperforms skills` (2026-01-27).

**Convergent thesis across sources:** For personal AI tooling in mid-2026, the binding constraint is **not capability — it is the closed loop**: instrument which capabilities fire, attribute outcomes back to the producing workflow, and surface the right capability *at the moment of need* rather than relying on recall.

**Highest-signal sources by loop stage:**

- **Invocation:** Claude Code OTel Monitoring docs (2026-05/06) — first-party `tool_decision`/`tool_result`/`skill_activated` events carry `skill.name`, `agent.name`, `mcp_tool.name`, `command_name`; GitHub Issue #35319 "Skill invocation tracking and usage analytics" (2026-03-17); "Skills and the discovery ceiling" (2026-05-06) — the ~32-skill budget; "Architecting AgentOps Telemetry via Lifecycle Hooks" (2026-04-29); "Managing 150+ AI Agent Skills at Scale (Skill Forge)" (2026-05).
- **Activation:** "5 Claude Code Skills That Actually Work / Agent Fleet" (2026-04) — hook-enforced skills fire ~84% vs ~20% model-choice; Vercel "AGENTS.md outperforms skills in our agent evals" (2026-01-27) — always-on context beats skill-install for *horizontal* knowledge (skill-installed 53% vs always-on 100% because the agent never invoked the skill in 56% of cases); "LOCA-bench" (2026-02-10) — injection HURTS past a context-fill threshold; "Managing context on the Claude Developer Platform" (2025-09-29).
- **Retention:** "User Adoption Metrics in 2026: Humans vs AI Agents" (2026-05-17) — rank by OUTCOME not raw count (Amazon/Uber usage-vanity failure); "I Didn't Become a Developer to Review AI Slop" (2026-05-21) — 96% don't fully trust AI code, 38% say review costs MORE effort; "Coders are refusing to work without AI" (2026-05-29) — ~44% of AI tokens go to fixing AI bugs.
- **Compounding:** "Compound Engineering (Every) /ce-compound" (2026-01-17); "ACE — Agentic Context Engineering" (2026-03) — per-bullet helpful/harmful integer counters; "ASG-SI audited-improvement-rate" (2025-12-28) — promotion rate × reuse rate as the single compounding KPI; "EvolveMem: Self-Evolving Memory" (2026-05) — failure-log-driven tuning with auto-revert-on-regression; "State of AI Agent Memory 2026 (mem0)" (2026-06) — temporal-validity/supersession to stop reinforcement amplifying staleness; "Agent-RRM" (2026-01); "AgentEvolver" (2025-11); "AgeMem survey" (2026-03).
- **Trust:** "In the age of vibe coding, trust is the real bottleneck" (2026-04-02); "Tool Receipts, Not Zero-Knowledge Proofs (NabaOS)" (2026-03-09) — validate connector output vs claimed fact (<15ms); "Why I stopped putting LLMs in my agent memory retrieval path (Memwright)" (2026-04-15); "Black-Box Reliability Certification via Self-Consistency Sampling" (2026-02-26).
- **Push/triggers:** "Push events into a running session with channels (Claude Code Docs)" (2026-03); "Introducing dynamic workflows in Claude Code (+ Routines)" (2026-05-28); "Claude Code Loops" (2026-03); "everything is a ralph loop" (2026-01); "What a true AI-native company feels like (3 months at n8n)" (2026-06-05); "My Claude Code Setup After 4 Months" (2026-02).

---

## 5. Phase 2 — Deduplication matrix (all 33 findings) + the 5 gaps

### 5.1 Full finding set (33), with classification + the verified delta

Legend: **NB** = NOT-BUILT (carry forward); **P** = PARTIAL (carry forward, note delta); **AB** = ALREADY-BUILT; **BUU** = built-but-unused (a leverage gap, carry forward). Loop stage in brackets.

1. **Native-OTel/SQLite invocation meter** [invocation] — **NB**. Turn on `CLAUDE_CODE_ENABLE_TELEMETRY=1`/`OTEL_LOG_TOOL_DETAILS=1` via update.sh; tail `tool_decision`/`tool_result`/`skill_activated` into `skill_stats`/`subagent_stats` tables mirroring `access_stats`. Literal closure of the blind spot. *Src: OTel docs (2026-05/06).*
2. **Hook-based invocation log (OTel fallback)** [invocation] — **NB**. PostToolUse/Stop/SubagentStop hook → one row per invocation `{timestamp, kind, name, trigger, project, session_id, success, duration}`; capture resolved name post-invocation (PreToolUse doesn't get the skill name reliably); 60s dedup; 5-bucket error classification. *Src: Issue #35319 (2026-03-17), AgentOps (2026-04-29).*
3. **Per-skill usage report + 0-in-90d retirement list → audit** [retention] — **P/BUU**. Delta: audit-claude-os/skill-auditor grade spec-compliance with NO invocation data; wire real per-skill counts in. *Src: Issue #35319, Skill Forge (2026-05).*
4. **Activation-quality (accept/reject/abandon per skill)** [activation] — **P/BUU**. Delta: review-performance sees only PreToolUse friction; extend to outcome-level accept/reject/abandon from `tool_decision`/`code_edit_tool.decision`. *Src: OTel docs (2026-06).*
5. **Per-session value rollup: route-to-shipped** [retention] — **NB**. Join tool volume vs shipped-artifact signals (commit.count/PR.count/Jira transition) keyed on session.id; high-tool zero-ship = "active-not-adopted"; rank by OUTCOME not count. *Src: Adoption Metrics 2026 (2026-05-17).*
6. **Session-value ledger + perception-vs-reality calibration** [compounding] — **P/BUU**. Delta: Stop-flush exists but no per-session value tag; add `{trivial|routine|leveraged|compounding}` tag + monthly felt-vs-measured (goal-check rework, revert rate) calibration. *Src: Self-Reported Impact (2026-05-11).*
7. **Reusable rubric LLM-judge "did session produce value"** [retention] — **AB/BUU**. Delta: grade-proposal/red-blue-judge exist but grade artifacts on human invocation; repurpose as automatic per-session value scorer (3-layer rubric, cross-family judge, swap-and-average, calibration toward Krippendorff α≈0.8). *Src: Rubric Evals & LLM-as-Judge (2026-04-21).*
8. **Outcome-graded episode pipeline** [compounding] — **P**. Delta: episodes enter clustering ungraded; add an LLM outcome-judge "did-this-help" score as the PRIMARY clustering ranking key so high-value trajectories compound first. *Src: AgentEvolver (2025-11), Agent-RRM (2026-01), ASG-SI (2025-12-28).*
9. **Per-learning helpful/harmful counters + audited-improvement-rate KPI (ACE)** [retention] — **P**. Delta: access_stats meters retrieval count only; add downstream-effect helpful/harmful pair + reuse-rate KPI. *Src: ACE (2026-03), ASG-SI (2025-12-28), AgeMem (2026-03).*
10. **Stale-memory defense: temporal validity / supersession / contradiction gate** [retention] — **P**. Delta: no `valid_from`/`valid_to`, no contradiction check; reinforcement (GT-3) actively amplifies the most-accessed memory as it goes confidently-wrong. Add supersession so most-recent-valid beats most-accessed; re-validate TOP-access memories in memory-merger. *Src: mem0 (2026-06), Memwright (2026-04-15).*
11. **Retrieval self-tuner (EvolveMem, revert-on-regression)** [compounding] — **P/BUU**. Delta: fusion/reinforcement weights are hardcoded (search_config.ts); eval harness exists but isn't a tuning loop. Log per-query records → diagnose worst-N → propose ONE config change → auto-revert if eval score drops; human-gate net-positive only. *Src: EvolveMem (2026-05), mem0 (2026-06).*
12. **Live-corpus + dependent-session behavior-change retention eval** [retention] — **P/BUU**. Delta: harness measures recall vs fixed set; add a growing-live-corpus run with injected contradictions + a MemoryArena-style "did memory written in session A change behavior in session B" metric — the only metric distinguishing real compounding from accumulation. *Src: mem0 (2026-06), AgeMem (2026-03).*
13. **Hook-ENFORCE high-leverage skills (84% vs 20%)** [activation] — **P/BUU**. Delta: topic-preload injects passive hint, never enforces; upgrade matched high-leverage signatures (Jira key→investigate, "cut a release"→arc-release, staged risky files→sonar-check) from advisory to enforced directive + a will-it-fire reliability log. *Src: Agent Fleet (2026-04), Skills/Slash/MCP/Subagents (2026-05).*
14. **Raise injection authority + measure-if-helped + fill-ratio guard** [activation] — **P/BUU**. Delta: topic-preload fires blind, no used/not-used signal, no fill-ratio gate; (1) re-route matched content to user-message authority + A/B; (2) record read/used + SUPPRESS injection past a context-fill threshold (fall back to JIT get_topic) + LOCA-bench-style with/without prune of the topic allow-list. *Src: Discovery ceiling (2026-05-06), LOCA-bench (2026-02-10), CDP context (2025-09-29).*
15. **Discovery-ceiling audit + horizontal/vertical partition** [activation] — **P/BUU**. Delta: 44+11 past the ~32 budget; build a visibility audit (char cost, truncation count) for audit-claude-os; PROMOTE horizontal passive-knowledge skills (jira/ffmpeg/java/github reference) into always-on CLAUDE.md/topic context (Vercel: 53% vs 100%), keep only vertical action-workflows as discovery-triggered. *Src: Discovery ceiling (2026-05-06), AGENTS.md evals (2026-01-27), Skill Forge (2026-05).*
16. **State-as-discovery: suggest-next-command + did-you-mean near-miss** [invocation] — **NB**. At the END of a high-value skill run, print a state-tied "suggested next command" (investigate→design-review/grill-me; commit on feature branch→ship); plus an error-as-nudge matcher when a phrasing trips no trigger; optional FTS5 skill index logging searched-but-not-found gaps. *Src: clig.dev (2024, evergreen), Skill Forge (2026-05).*
17. **Single chained front-door (grill→prd→issues→tdd)** [compounding] — **P**. Delta: atoms exist (make-it-so, grill-me, write-a-prd, investigate, red-blue-judge) but invoked ad hoc; add a phase-gated chain command + a one-line intent-review gate ("what problem, what changes, what could break") before any implementation skill. *Src: Agent Fleet (2026-04), AI Slop (2026-05-21).*
18. **Mechanical promotion of recurring bruises + recurrence-threshold + forced reflection** [compounding] — **P/BUU**. Delta: capture is agent-discretion (voluntary marker), promotion is grade-gated not frequency-gated. (1) promote an N+-times learning into a PreToolUse/Stop mechanical guard; (2) explicit recurrence-count field (graduate after 2+ firings); (3) FORCED Stop-hook reflection (what surprised me / one pattern / one skill-description fix), provenance split agent-distilled vs human-authored (ETH: machine-written AGENTS.md = -3% success → never auto-promote). *Src: Agent Harness 10x (2026-05-07), Compound Engineering (2026-01-17), Code Agent Orchestra (2026-03-26).*
19. **Push triggers: voice-note ingestion, Channels two-way, proactive nudges, warm-state jobs** [invocation] — **P**. Delta: jobs are fire-and-forget cold-start digests; add (1) always-on voice-note ingestion → filed to project/learnings; (2) route 06:00/06:30 jobs through a Channel into a persistent session (reply "fix it" from phone) + proactive messages on dormant-but-high-value conditions; (3) per-job warm-state carried forward ("PR #N still failing after 3 mornings — escalate"). *Src: Channels docs (2026-03), 4-Months Setup (2026-02), Loops (2026-03).*
20. **Self-terminating routines w/ done-conditions (Ralph)** [invocation] — **P**. Delta: cron-once, no completion predicate; add a checkable done-condition + self-re-invoke-until-satisfied, NL bounded-interval triggers, failure-domain feedback into audit. *Src: ralph loop (2026-01), Loops (2026-03).*
21. **Recurring "what should become a workflow?" surfacing** [compounding] — **NB**. Monthly mine invocation log + episode backlog for the most time-consuming RECURRING manual sequences done by HAND (not routed through any skill), propose a candidate skill each; invest in unglamorous daily-touch automations first; measure whether the digest is CONSUMED. *Src: n8n 3-months (2026-06-05), AgentEvolver (2025-11).*
22. **Install-one-prove-it-sticks gate + session-start leverage nudge** [activation] — **P/BUU**. Delta: a new skill must show ≥K invocations in 30d or be flagged before further additions; session-start surfaces the highest-value workflow unused in N days. Both need the invocation meter. *Src: 2026 MCP/Hooks/Skills Setup (2026-02-01), Retention Metrics (2025-11).*
23. **Weekly utility (not vanity) recap + feature-usage-depth** [retention] — **NB**. Weekly self-reported-VALUE recap (routed X commits, addressed Y PR comments, promoted Z memories, 3 skills unused 30d) — UTILITY not an obligation streak (streak-decay caution); + Feature Usage Depth (distinct skills/period): shallow = high-leverage workflows undiscovered. *Src: Retention Metrics (2025-11), Adoption Metrics (2026-05-17).*
24. **Event-triggered review-prep + self-rework detector (Routines)** [invocation] — **P**. Delta: background-pr-digest digests on cron, never acts; upgrade to GitHub-event-triggered (Routines, launched 2026-04-14) auto-drafted review prep posted as a draft comment; + a self-inflicted-rework detector tagging commits/PRs that revert/fix a prior agent session (~44% of AI tokens fix AI bugs) feeding synthesis. *Src: Dynamic workflows + Routines (2026-05-28), Coders refusing (2026-05-29).*
25. **Evidence-block PR review gate** [retention] — **P/BUU**. Delta: review-pr/post-review produce reports but don't require executed-behavior evidence; add a mandatory EVIDENCE BLOCK (which flow/test/command was run, captured output/failing assertion, root-cause-vs-surface verdict); a review without executed evidence → "unverified." Extends the repo's `verify-by-execution-not-just-tests` memory into an enforced review contract. *Src: AI Slop (2026-05-21), repo memory.*
26. **MCP tool receipts (validate claim vs output)** [invocation] — **NB**. Signed receipt per MCP result (tool, input hash, output hash, result_count, key facts); validate the agent's claim ("PR #N has 3 failing checks") against `receipt.result_count` before it reaches the operator (<15ms); the receipt log doubles as the connector-level invocation funnel. *Src: Tool Receipts (2026-03-09), Memwright (2026-04-15).*
27. **Per-injection epistemic-source tags + per-turn retrieval-decision trace** [activation] — **P**. Delta: no source-type tag, no claim-to-id grounding check, no record of which retrievals were INJECTED vs merely accessed; tag every injected memory/topic with source_type + id, validate asserted facts trace to a real injected id, log which ids/topics retrieved/injected/dropped with scores → retrieval-precision metric + model-vs-context attribution. *Src: Tool Receipts (2026-03-09), Memwright (2026-04-15).*
28. **Mechanical pre-output governance gate** [activation] — **P/BUU**. Delta: checkable rules (no Jira-key-in-comments, no Co-Authored-By) live as advisory prose (`communication.md` admits "adherence is not guaranteed, no PreToolUse hook for prose"); compile the deterministically-checkable subset into the existing `/commit` + `/ship` gate so violations are mechanically BLOCKED. *Src: Vibe-coding trust (2026-04-02).*
29. **Default-on adversarial gates + self-consistency + trust ledger** [compounding] — **AB/BUU**. Delta: oracle/red-blue-judge are opt-in; (1) route highest-trust-damage artifacts (experience promotion, PRD gen, design-review verdicts) through them BY DEFAULT; (2) K=5 self-consistency gate on highest-stakes autonomous outputs (present only above agreement threshold, else "low confidence — review"); (3) per-skill trust-calibration ledger (confidence-at-output vs later accepted/corrected/reverted). *Src: Vibe-coding trust (2026-04-02), Self-Consistency Cert (2026-02-26).*
30. **Skill-activation eval harness (four-arm)** [compounding] — **P/BUU**. Delta: harness evals memory recall, not skill activation; build a Vercel-style four-arm eval (no-capability / skill-default / skill+explicit / always-on) measuring per-skill activation rate as a regression-tested number that catches description decay. *Src: AGENTS.md evals (2026-01-27), LOCA-bench (2026-02-10).*
31. **Decoupled session log + harness-side context trimming + compaction resume-card** [compounding] — **P**. Delta: episodic memory summarizes after the fact, no append-only event log decoupled from the window, no mid-session trimming, no pre-compaction resume-card, no enforced subagent output-size contract; add all four token-lifecycle governance mechanisms (incl. a bounded 1-2k-token digest contract on the 11 subagents). *Src: Decoupling brain from hands (2026-04-08), Protecting Context (2025-12-10), Effective context engineering (2025-09-29).*
32. **/refresh-skills staleness-and-overlap pruning + versioned SKILL.md** [retention] — **P/BUU**. Delta: memory-merger prunes memory, skill-auditor checks spec-compliance, but nothing prunes the SKILL/topic corpus for decay/redundancy or couples version+validated-date to invocation counts; add a corpus-refresh command (keep/update/merge/replace/archive) + a validated-date-vs-usage diff + a Confidence field on learnings. *Src: /ce-compound-refresh (2026-01-17), Share Skills With Team (2026-05-07), Self-Learning Skill (2026-03-22).*
33. **Self-tuning skills: read-scoped-learnings-before / write-outcome-after** [invocation] — **P**. Delta: skills don't read/write their own scoped learnings slice, the corpus isn't relevance-tagged for gated injection; move commit/ship/investigate/review-pr onto read-history-before / write-back-after (which side-effect-logs each invocation) + attach retrieval-relevance metadata (task-shape, file globs, topic keys) to every learning. *Src: Self-Learning Skill (2026-03-22), Compound Engineering Camp (2026-03-13).*

**Survivor count: well past the 10-row floor** (≈31 of 33 carry forward as NB/P/BUU; only finding 7 and 29 are AB, and both are flagged BUU and carried anyway).

### 5.2 The 5 most significant leverage gaps

**Gap 1 — The workflow funnel is unmetered (in SQLite) while memory is over-metered.**
- Root cause: the instrumentation instinct exists but points only at the memory layer (GT-1, GT-2). Structural, not behavioral.
- Loop stage: **invocation** (blocks measurement of all later stages).
- Field signal: findings 1–3; 38.6% coverage / 27-skill dead list — *reproduced during the gate from machine-local `~/.claude/projects/**/*.jsonl` transcripts (§3.2), not re-derivable from the repo working tree*; re-run the §7.2 read-only scan to refresh.
- Risk: every retention/compounding bet is blind without it; "dead weight?" stays a guess.

**Gap 2 — Memory accretes but is never graded on outcome; reinforcement amplifies frequency, not value.**
- Root cause: no value field (GT-5); `reinforcementBonus` has no value/staleness term (GT-3); episode-write gated on salience not value (GT-6); and synthesis clusters by embedding cosine then orders by a non-value key — with a **code↔doc mismatch**: `experience.ts:84` sorts clusters by **member-count (size)** (`b.members.length - a.members.length`; cohesion is computed but never read for ordering), while `experience-synthesis/SKILL.md:59` instructs the operator to process **highest-cohesion first**. Either way the ordering key is *not value* (GT-7) — the leverage gap holds, but the spec must not claim a single clean ordering the system itself does not agree on.
- Loop stage: **compounding.**
- Field signal: findings 5–10; ACE, mem0.
- Risk: 136 episodes compound *theme density*, not *leverage* — heavier, not smarter; stale-amplification worsens with use.

**Gap 3 — 44+11 is past the discovery ceiling; the high-leverage long tail goes cold.**
- Root cause: surface exceeds recall (GT-17); the spine (`/commit`) fires by habit, while high-leverage deep-workflow capabilities — oracle, audit-claude-os, review-performance, estimate, identity-check, mcp-health-audit (all explicitly on the §3.2 dead list), plus `/design-review` (a global slash command, not a skill — §1) — sit in the cold tail. (The §3.2 list is truncated at "…", so the dead set is *at least* these, not provably *exactly* the deep-workflow set; investigate and experience-synthesis exist as skills but are not confirmed on the visible portion of the list.)
- Loop stage: **invocation/activation.**
- Field signal: findings 11–16; discovery-ceiling, 84%-vs-20%, AGENTS.md.
- Risk: the single largest *standing* loss — leverage already paid for (skills exist) never collected.

**Gap 4 — The compounding engine has no automated trigger.**
- Root cause: `/experience-synthesis` and `/memory-merger` are operator-pull — neither appears in `config/scheduled-jobs.json` (only PR surveillance 06:00 + sprint staleness 06:30 are scheduled), so there is **no cadence**. Both skills *do* have an interactive done-condition (each reaches a "STOP and wait for input" human-gated approval step before any write — `experience-synthesis/SKILL.md:126`, under the Step 6 header at :109; `memory-merger/SKILL.md:220` — though it is a mid-pipeline gate, not a terminal step: both resume post-approval execution/reporting); what is missing is a *Ralph-style automated trigger with a backlog-drained completion predicate* (finding 20: today's jobs are cron-once with no completion predicate). The interactive halt is not the gap — the absent scheduled invocation is.
- Loop stage: **compounding/retention.**
- Field signal: findings 18–21; Compound Engineering, Ralph.
- Risk: the 136-episode backlog stays undistilled; and because synthesis orders clusters by size, not value (Gap 2), even when run the highest-leverage trajectories are not the ones distilled first.

**Gap 5 — Trust-critical and governance-checkable outputs rely on the model remembering, not on enforcement.**
- Root cause: oracle/red-blue-judge opt-in (finding 29); deterministic rules live as advisory prose (GT-16, finding 28); `communication.md` concedes adherence isn't guaranteed.
- Loop stage: **retention** (trust erosion kills routing).
- Field signal: findings 25, 28–29; vibe-coding-trust, tool-receipts.
- Risk: one confidently-wrong output erodes the trust that drives routing real work through the system (cf. §10).

---

## 6. Phase 3 + 4 — Ranked bets with FULL gate verdicts

> All six returned **REVISE**. The red team earned every verdict by *verifying against code/data*. Each bet below carries: the as-written bet, the post-gate leverage score, the **exact modification to apply**, and the **judge's full rationale** (so a cold session can defend the ruling). Required fields (what/why-compounds/stage/metric+instrumentation/effort/sources) follow each.

### LIST A — Deepening bets

#### A2 — Session-value scalar minted at Stop, wired into experience-synthesis ordering — **leverage 8** — first real build
- **As written:** at session end capture a one-keystroke / commit-or-PR-inferred "did this session produce value" bit, write to the episode, use it to weight experience-synthesis and reinforcement.
- **VERDICT: REVISE. Score: hold at ~8.**
- **Exact modification (apply before building):**
  1. **Capture path = inference-first, keystroke-fallback.** Default value signal derived *headlessly* at Stop by reusing the existing grade-proposal/red-blue-judge LLM-judge on the transcript. **DROP commit-inference** (falsified premise #3 — would score investigate/design-review/oracle/grill-me as value-negative). The keystroke is an optional override, never primary, so the signal doesn't depend on operator behavior at teardown.
  2. **Write path:** add one key to `ALLOWED_FM_KEYS` (episode-utils.js:22) + one line in `buildEpisodeContent` (session-observer-worker.js:216). Store an **ordinal/bounded** value, not a bare boolean.
  3. **Reader path (the part A2 omitted — ship it in the SAME unit):** extend `scan_experience.ts` (ClusterMember shape lines 16-21; SELECT lines 75-87 must carry the value field) and change SKILL.md Step 2 from "highest-cohesion first" to **"value-weighted ordering within cohesion."** Defer the `ranking.ts` value term to a follow-on bet — do not claim it here.
  4. **Metric:** demote "value-positive session rate" to a secondary diagnostic (self-validating, lagging). **Primary acceptance test:** *synthesis run ordering provably changes when the value field is populated vs. absent* (a demonstrated reader, external).
- **Judge rationale (verbatim substance):** No value field exists anywhere (GT-5; reinforcementBonus has only recency+frequency, GT-3; episode-write is salience-gated not value-gated, GT-6) — so the blind spot is real and A2 targets the right scalar at the right lifecycle point on a hook that already fires (learnings-flush). But the red team landed a concrete, unanswered objection: A2 as scoped is **a write with no reader** — `scan_experience` clusters by cosine and never reads a value field; the synthesis gates test grounding/truth not source-value; reinforcement is downstream of promotion. A value bit would sit unread. Blue's own compounding paragraph conceded the real work is "re-key scan_experience" — outside A2's stated scope. A prerequisite shipped with zero consumers reproduces the under-used-capability failure. Not fundamental (the scalar is genuinely the keystone, knowable only at session end) → REVISE not ESCALATE. Score stays at 8 (not raised to 9) until the revision binds a consumer; an unconsumed write would have warranted a drop to 5.
- **Why it compounds for THIS operator:** the one missing scalar that four downstream deltas (findings 5, 6, 8, 9) explicitly depend on. Today the two self-improvement engines (synthesis, reinforcement) optimize a proxy (theme density, touch frequency) uncorrelated with leverage; A2 swaps the proxy for the real objective so every session sharpens the gradient the system improves along.
- **Stage:** activation + compounding. **Effort:** Medium (~2–3 days). **Sources:** findings 5–9, ACE, Agent-RRM, AgentEvolver, Rubric-Evals.

#### A1 — Read-only invocation telemetry NOW; persistent table only when paired with a consumer — **leverage 4** (dropped)
- **As written:** PostToolUse/Stop hook logging every Skill/subagent invocation to a `usage_stats` table mirroring access_stats, surfaced as a weekly "what you used / never reach for" digest. Stated metric "measurable only once this ships."
- **VERDICT: REVISE. Score: DROP to 4.**
- **Exact modification (two-part split):**
  - **(a) Ship the metric NOW, read-only.** ~40-line read-only scan of existing `~/.claude/projects/**/*.jsonl` (parses `tool_use` blocks where `input.skill`/Task names are recorded), folded into audit-claude-os/review-performance as a graded dead-skill-retirement input. Near-zero cost, nothing stateful. **DROP the new hook + worker + weekly human-read digest AND the "measurable only once this ships" justification.**
  - **(b) Build persistent `usage_stats` SQLite ONLY when paired with a machine consumer** — specifically feeding prompt-time skill recall via the topic-preload hook (mirroring how access_stats feeds ranking.ts reinforcementBonus in a closed loop). **Defer the standalone weekly digest — it is the vanity-shaped deliverable with no downstream consumer.**
- **Judge rationale (verbatim substance):** Red's central objection holds and was *reproduced*: the bet's load-bearing premise ("measurable only once this ships, the blind spot") is **FALSE**. Scanning 1,959 transcripts / 342,911 lines (2026-05-05→2026-06-08) computed trailing-30d coverage = 38.6% (17 of 44), the full 27-skill never-used list, and ~1.1 inv/session — exactly the numbers the bet says require the new subsystem. The metric needs a read-only script, not a hook+worker+table. The vanity objection is structural: `access_stats` earns its keep because `ranking.ts` consumes it in a closed re-ranking loop; the proposed `usage_stats` feeds only a human-read digest with NO machine consumer — the textbook dashboard-nobody-opens. Why REVISE not ESCALATE: the SQLite blind spot is genuinely real (GT-1) and red itself names a legitimate non-vanity use — persisted history feeding prompt-time routing/recall — so the instrument has a salvageable kernel; the leverage is not zero, it is mis-aimed. **Correction to the record:** review-performance's `parse-session-transcripts.sh` does NOT already glob invocations — it globs the same directory but only for `*/memory/*.md` (GT-11); harvesting invocations is trivial but not yet built. The metric is NOT blocked on a different bet — it is available today read-only — which is precisely why the heavyweight build is unjustified as scoped.
- **Why it compounds:** part-(a) immediately turns Gaps 1 & 3 from guesses into graded facts and unblocks the metrics A3/B1/B2/B3 depend on. **Stage:** invocation. **Effort:** Low (a, ~half-day) / Medium (b). **Sources:** findings 1–3, OTel docs, Issue #35319.

#### A3 — Bypass detector (gated on A1, scoped to non-trivial commits) — **leverage 5** (dropped)
- **As written:** Stop-hook/digest cross-referencing the git/gh stream against skill-invocation events, nudging once when high-leverage work bypassed its skill; metric = routed-through rate per workflow.
- **VERDICT: REVISE. Score: DROP to 5.**
- **Exact modification (three scoping changes):**
  1. **Dependency gate:** declare A3 blocked on A1's invocation capture. The numerator (skill firing) is captured NOWHERE today (GT-10: hooks-log has zero Skill events; GT-11). Do not claim routed-through-rate until A1 ships.
  2. **Redefine the metric** to what the substrate supports: a **same-session_id correlation proxy** (skill-fired event followed by the corresponding git/gh command in the same session_id — hooks-log carries session_id), explicitly labeled a proxy, NOT a true routed-through rate. There is no commit fingerprint to discriminate on (GT-16 — Co-Authored-By forbidden) → attribution must be session-temporal, not commit-content.
  3. **Scope the nudge** to exclude legitimate non-bypasses: suppress merge commits and trivial docs/chore/test/style commits (verified: last 100 claude-os commits = 11 merges + 14 trivial). Reuse `parse-hook-logs.sh` (GT-12) and the existing SessionStart/Stop digest rail.
- **Judge rationale (verbatim substance):** Red lands the decisive, concrete objection: the metric's numerator is uncapturable on the substrate cited as "already built" (GT-10 hooks-log tools = {Bash:2522, Edit:268, Write:117}, zero Skill rows; DB has no invocation table either side; GT-11). So "commits via /commit" cannot be computed today and A3's headline metric depends on A1 shipping first. Red also grounded behavior-change risk (11 merges + 14 trivial of last 100 → false-positive nudges). REVISE not ESCALATE because: (a) the capture substrate Red claimed didn't exist DOES — hooks-log.jsonl (2907 rows, 443 sessions) really logs the git/gh denominator, and parse-hook-logs.sh really aggregates it, so Blue's compounding-on-deployed-infra thesis is half-right; (b) Red overreaches on "structurally impossible to measure" — session_id is on every hook row, so once skill capture exists, same-session correlation yields a defensible proxy. The leverage premise (recover bypassed high-value workflows; produce the real-world denominator downstream bets need) is genuine. Flaws are scoping + sequencing, fixable → REVISE. *Shared inaccuracy noted: BOTH teams cited a Skill cross-ref as fait accompli; the aggregator exists but the Skill cross-ref does not.*
- **Stage:** invocation + retention. **Effort:** Medium. **Sources:** findings 14, 19; hook-based invocation log.

### LIST B — New compounding loops

#### B2 — Just-in-time skill surfacing on the prompt boundary — **leverage 8**
- **As written:** extend the topic-preload UserPromptSubmit hook from context-topic injection to SKILL surfacing — inject a loop-aware, deduped, frequency-capped "skill X fits this" hint when a prompt matches a non-invoked skill's trigger.
- **VERDICT: REVISE. Score: hold at ~8.**
- **Exact modification (three changes, none touch the core mechanism):**
  1. **Sequence behind A1.** Ship the invocation meter first (a small extension of existing parsing — `session-observer-worker.js` already reads the full JSONL but `extractText` lines 54-64 filters to `b.type==='text'` and discards `tool_use`; the events are on disk and being dropped). Without it B2 can't see which skills are dead.
  2. **Replace the causal metric with a measurable proxy + control discipline.** The proposed metric ("first invocation of a 0x-in-30d skill after a hint") **cannot establish causation in an n-of-1 system** — native dispatch fires on the same prompt, so a post-hint invocation is unattributable without a holdout the operator can't run. Use: (a) a hint-impression log (hint shown / skill invoked within the same session) reported as a **correlation rate NOT causal lift**, and (b) a **monthly hint-suppressed week** as the only available pseudo-control.
  3. **Add a false-positive guard.** Cap to one skill-hint per prompt; require a multi-keyword / trigger-phrase match (not a single common word); frequency-cap per skill so a declined hint self-suppresses — to protect the `[Context hint]` block that currently carries useful topic loads.
- **Judge rationale (verbatim substance):** Confirmed in B2's favor: 44 skills (past the ~32 ceiling, GT-17); the hook is real, 70 lines, fires on the highest-frequency surface (UserPromptSubmit), reusable verbatim (GT-9); every SKILL.md carries structured trigger phrases (machine-readable). Confirmed in Red's favor: the invocation meter genuinely doesn't exist (GT-1), so B2's metric is unmeasurable today and gated on A1. Red's ONE clean unanswered hit: even after A1 the stated metric can't isolate treatment effect (n-of-1, no holdout) → kills the METRIC as written, not the bet. Red's STRONGEST claim — that the agent already has all 44 descriptions and runs a superior native matcher making the hint "strictly redundant and weaker" — is asserted, not grounded, and is **contradicted by the system's own data** (hook-surfaced 84% vs model-choice 20%); model-choice discovery IS the weak link, which is what B2 attacks (falsified premise #5). Red's valid correction (consumer is the agent, not a human) is absorbed: the hint is an agent-relevance nudge per the existing `[Context hint]` contract. Mechanism proven, value grounded, substrate already-read → not ESCALATE; causation hit + unbuilt-meter dependency real → not CLEAN. Hold at 8 (not 9) because the metric is causally uncontrollable n-of-1 and the whole bet is gated behind A1.
- **Why it compounds for THIS operator:** highest-frequency surface (every prompt) targeting the highest-value cold tail (deep-workflow skills), via a proven 70-line hook; those deep-workflow skills are themselves compounding engines (better investigate → better episodes → better synthesis). **Stage:** invocation. **Effort:** Medium. **Sources:** findings 11–16, discovery-ceiling, 84%-vs-20%.

#### B1 — Retrieval-attribution layer, then a learning-reuse review — **leverage 5** (dropped)
- **As written:** scheduled weekly job correlating promoted experience-learnings against later sessions to compute learning-reuse rate (retrieved + preceded a good outcome / promoted), surfacing dead learnings to prune and live ones to reinforce.
- **VERDICT: REVISE. Score: DROP to 5.**
- **Exact modification (re-scope + re-sequence — instrumentation FIRST):**
  1. **Instrument BOTH retrieval paths:** session-keyed retrieval-event logging at the `search_memory` bump point (search_memory.ts:204-221) AND at the topic-preload/`get_topic` path (GT-8 — currently never touches access_stats, so the dominant hook delivery path is invisible; without this the "retrieved" numerator is biased toward the minority path).
  2. **Add a coarse session-outcome label** (reuse the A2 "did-this-help" substrate, joined on the `session_id` episodes already carry).
  3. **Gate the weekly correlation job behind a minimum-denominator threshold** (promoted-learning count ≥ N, retrieval events ≥ M); below threshold emit only raw instrumentation-coverage telemetry, not a ratio.
  4. **DROP "reinforce live ones" as an operator action** — reinforcement is already automatic and additive (GT-3). The only genuine operator action is routing dead promoted learnings into the existing human-gated memory-merger/experience-synthesis pruning surface.
- **Judge rationale (verbatim substance):** Red lands three concrete unanswered objections; Blue concedes two. (1) Metric uncomputable today: access_stats is exactly 3 columns (GT-2) — no session_id, outcome, query, or event log; B1's metric requires building three subsystems before line one computes. (2) The only meter bypasses the dominant delivery path (GT-8). (3) Statistical deadness: 144 observations, only 5 carry any access record; 136 episodes none; learnings.md 79 lines / single-digit promoted learnings — a reuse rate over that denominator is noise for weeks-to-months. Blue's "reinforce live ones" verb is already done by code (GT-3). NOT ESCALATE because the destination is genuinely the highest-value signal — measured downstream reuse is the one metric distinguishing compounding from accumulation — and the join key exists (episodes carry session_id + promoted frontmatter). The flaw is sequencing + scope: B1 as written builds the correlation engine on instrumentation that doesn't exist, fed by the minority path, over too small a denominator. The metric is unmeasurable until the attribution work (effectively a prerequisite bet) ships — the revision folds that prerequisite in as B1's first deliverable.
- **Stage:** compounding/retention. **Effort:** High. **Sources:** findings 5–10, 12, mem0, AgeMem.

#### B3 — Cross-machine learning transfer (narrowed to stranded assets) — **leverage 5** (dropped)
- **As written:** when one agent (Willis) heavily uses a skill or accrues a high-value learning, the assimilate path surfaces it to Walter as a "this paid off on the other machine" suggestion.
- **VERDICT: REVISE. Score: DROP to 5.**
- **Exact modification:**
  1. **Narrow to transfer ONLY stranded assets** — learnings, promoted experiences, high-helpful-count memory entries — and **DROP "heavily-used skill" from scope** (falsified premise #4: GT-14 — skills already cross via the git genome; Walter already *has* the skill; only social-proof framing would transfer). By contrast learnings do NOT cross (GT-13). The stranded-signal proof: the 2026-06-01 "shared-genome paths" learning is itself a lesson about the Walter/Willis split, written into the un-synced store.
  2. **Change the delivery trigger** from `/assimilate` (infrequent sync action whose framing is "report what arrived" — the weakest moment to seed new work) to the **session-start-check.js additionalContext injection** (fires every session on the receiving machine).
  3. **Gate explicitly behind two prerequisites** stated on the bet card: (a) A1's invocation meter (for any "earned its keep" claim about skills/subagents); (b) a NEW cross-machine sync of the relevant table/learnings (the data store is un-synced by design, GT-13).
- **Judge rationale (verbatim substance):** Red landed a concrete, verified, unrebutted objection on the bet as written: the primary named asset ("heavily-used skill") is already transferred (GT-14). Blue never rebutted it — it silently re-framed the deliverable as a "nudge" and silently upgraded the delivery surface from /assimilate to session-start (both concessions, not defenses — the signature of a bet that needs revision). But Red overreaches calling the whole thing vanity: the asymmetry is real and verified (GT-13 — learnings/memory.db NOT synced), and the very learning Blue cites is a genuinely stranded high-value signal. So a narrowed B3 (transfer assets that actually don't cross, fire at session-start, openly gated behind A1 + a new data-sync) is a real compounding loop. The metric objection (doubly-gated on unbuilt instrumentation) is noted per the rubric, not fatal — surfaced on the bet card so the bet can't be declared done before dependencies ship.
- **Stage:** compounding. **Effort:** Medium-High. **Sources:** findings 1, 7, 9; install-one-prove-it.

### 6.1 Post-gate ranking table

| Rank | Bet | List | Verdict | Score | One-line why the score landed there |
|------|-----|------|---------|-------|-------------------------------------|
| 1 | **A2** session-value scalar + synthesis ordering | A | REVISE | **8** | Keystone scalar 4 loops depend on; held at 8 (not 9) until a consumer is bound |
| 1 | **B2** JIT skill surfacing on prompt boundary | B | REVISE | **8** | Highest-frequency surface × highest-value cold tail × proven hook; gated on A1, n-of-1 metric |
| 3 | **A3** bypass detector | A | REVISE | 5 | Value premise sound, denominator infra real, but numerator gated on A1 |
| 3 | **B1** retrieval-attribution → learning-reuse review | B | REVISE | 5 | Top-tier destination, uncomputable on today's 3-col access_stats / single-digit denom |
| 3 | **B3** cross-machine learning transfer | B | REVISE | 5 | Real stranded-learning core, doubly-gated behind A1 + a new data sync |
| 6 | **A1** invocation telemetry | A | REVISE | **4** | Premise falsified by reproduction; digest is vanity — salvage = read-only now + consumer-paired table later |

---

## 7. Phase 5 — Synthesis + First Move

### 7.1 North Star

With all six implemented post-ruling, a claude-os session changes shape at three seams. At the **prompt boundary** (B2), the cold high-leverage tail (investigate, design-review, oracle) gets surfaced at the moment of need instead of waiting to be recalled — so more real work routes through the deep workflows, not just the `/commit` spine. At **session end** (A2), each session mints a grounded value scalar that re-orders which trajectories the experience engine compounds first — so the system improves along the axis of *leverage*, not *theme density*. Across the **machine boundary** (B3), hard-won learnings stop being stranded on one Mac. The compounding that didn't exist before: today retrieval reinforcement amplifies *frequency* (and thus amplifies confidently-wrong memory as it is consulted — GT-3); after A2 + B1, a memory earns its retrieval slot by *measured downstream effect*, so signal-per-retrieval rises with use instead of the corpus merely growing heavier. A1 (read-only) + A3 make the routed-through rate observable, closing the loop from "I think I use the system" to "here is what routed and what bypassed."

### 7.2 FIRST MOVE — do this first

**Step 0 (today, ~half-day, zero new state): A1 part-(a) — read-only invocation telemetry.**
Write a ~40-line read-only script that scans `~/.claude/projects/**/*.jsonl`, parses `tool_use` blocks (`input.skill` for Skill, Agent/Task for subagents), and emits trailing-30d skill-invocation coverage + the never-used list + invocations/session. Fold it into `audit-claude-os` / `review-performance` as a graded dead-skill-retirement input.
**Why first:** highest leverage-per-effort on the board; the metric is *already computable* (§3.2 reproduced it — 38.6% coverage). It immediately converts Gaps 1 & 3 from guesses to facts and unblocks the metrics A3/B1/B2/B3 all depend on. Lowest behavior-change cost (no operator change at all; it reads existing data). This IS the honest "instrument usage so the rest can be measured" first move the brief anticipated — with the twist that it requires *reading*, not *building*.

**Step 1 (first real build, Medium): A2 — the session-value scalar.**
Highest surviving leverage score (8) tied to the lowest behavior-change cost (fires headlessly at a Stop hook that already runs — no operator keystroke), and it is the keystone four downstream loops are blocked on. Build it per the §6 A2 modification: inference-first capture (reuse grade-proposal/red-blue-judge judge, NOT commit-presence), bounded ordinal written to a new `ALLOWED_FM_KEYS` field, AND wire `scan_experience` value-weighted-within-cohesion ordering in the same unit (so it is not a write-with-no-reader). Acceptance test: synthesis ordering provably changes when the field is populated vs. absent.

**Step 2+: B2 (JIT skill surfacing, gated on A1's persistent table from part-b) → then A3 / B1 / B3** as their now-measurable dependencies come online.

**Full sequence:** A1-read-only (today) → A2 → B2 → A3/B1/B3.

---

## 8. Implementation specs (per bet, for the builder)

> Each respects the project rule "machine setup goes in the scripts" (`update.sh` / `hooks-install.js` / `config/scheduled-jobs.json`), and the MCP tree is **TypeScript** (`mcp/src/**/*.ts`) — not `.js`. Schema changes use the idempotent in-code DDL pattern in `db.ts` (`CREATE TABLE IF NOT EXISTS` + `meta.schema_version`), **not** a migrations dir (there is none).

**A1-(a) read-only:** new script (e.g. `mcp/src/scripts/skill-usage-scan.ts` or a `review-performance` helper) that globs `~/.claude/projects/**/*.jsonl`, line-parses JSON, counts `tool_use` records by resolved Skill/Task name, windows on timestamp. No DB write. Output a coverage report consumed by `audit-claude-os`. Verify by execution against the real transcript dir (per the `verify-by-execution-not-just-tests` repo memory).

**A1-(b) persistent (deferred until consumer exists):** add `skill_stats`/`subagent_stats` tables in `db.ts` (mirror `access_stats` shape, keyed by name, with `last_invoked`/`invoke_count`/`session_id`). Populate via either native OTel (`CLAUDE_CODE_ENABLE_TELEMETRY=1` in update.sh, tail `skill_activated`) or a PostToolUse/SubagentStop hook added to `hooks-install.js` `CANONICAL_HOOKS` (propagates to both Macs). **Only build when wired to prompt-time recall (B2).**

**A2:** `episode-utils.js:22` add value key to `ALLOWED_FM_KEYS`; `session-observer-worker.js:216` write the bounded ordinal in `buildEpisodeContent`; derive the value headlessly at the worker (reuse grade-proposal/red-blue-judge judge on the transcript). `scan_experience.ts:16-21,75-87` carry the field through ClusterMember + SELECT; `experience-synthesis/SKILL.md` Step 2 → value-weighted-within-cohesion.

**A3:** Stop-hook/digest reusing `parse-hook-logs.sh` aggregation + the SessionStart/Stop digest rail; correlate skill-fire events (from A1-b) against git/gh in the same `session_id`; suppress merges + trivial commit types; label output a proxy.

**B1:** retrieval-event logging at `search_memory.ts:204-221` AND `get_topic.ts` (both paths, session-keyed); coarse outcome label joined on episode `session_id`; weekly job behind a min-denominator gate; route dead learnings to `/memory-merger`.

**B2:** extend `topic-preload.js` to also match SKILL.md trigger phrases; inject one capped, multi-keyword-gated, self-suppressing skill hint per prompt; log impressions; add a monthly hint-suppressed week. Gate on A1-(b).

**B3:** add a cross-machine sync of learnings/experiences/high-helpful entries (the data store is currently un-synced — this is net-new and must NOT push private data into the genome repo; design a separate sync path); surface arrivals via `session-start-check.js` additionalContext. Gate on A1-(b) + the new sync.

---

## 9. Appendix — full source list (49, by sweep)

*(Each cited inline in §4/§5 with date. Stale-flagged: clig.dev 2024; Retention Metrics 2025-11; AgentEvolver 2025-11; ASG-SI 2025-12-28; AGENTS.md evals 2026-01-27; CDP context 2025-09-29; Protecting Context 2025-12-10; Effective context engineering 2025-09-29.)*

Invocation/telemetry: Claude Code OTel Monitoring docs ×3 (2026-05/06); GitHub Issue #35319 (2026-03-17); AgentOps Telemetry via Hooks (2026-04-29); Skill Forge "150+ skills" (2026-05); Analytics API adoption data (2026-05); Tool Receipts/NabaOS (2026-03-09).
Discoverability/activation: Skills and the discovery ceiling (2026-05-06); AGENTS.md outperforms skills (2026-01-27); 5 Skills That Actually Work / Agent Fleet (2026-04); Skills/Slash/MCP/Subagents (2026-05); clig.dev Discoverability (2024); LOCA-bench (2026-02-10); CDP context mgmt (2025-09-29).
Memory/compounding: ACE (2026-03); ASG-SI (2025-12-28); AgeMem survey (2026-03); EvolveMem (2026-05); mem0 State of Memory (2026-06); Memwright (2026-04-15); Agent-RRM (2026-01); AgentEvolver (2025-11); Compound Engineering/Every /ce-compound + refresh (2026-01-17); Compound Engineering Camp (2026-03-13); Self-Learning Skill w/ learnings.md (2026-03-22); Rubric Evals & LLM-as-Judge (2026-04-21); MemoryArena/dependent-session (via mem0).
Retention/trust/value: User Adoption Metrics 2026 (2026-05-17); User Retention in AI Platforms (2025-11); Self-Reported Impact of AI (2026-05-11); I Didn't Become a Developer to Review AI Slop (2026-05-21); Coders refusing to work without AI (2026-05-29); Vibe-coding trust (2026-04-02); Self-Consistency Certification (2026-02-26).
Triggers/dogfooding/loops: Channels docs (2026-03); Dynamic workflows + Routines (2026-05-28); Claude Code Loops (2026-03); everything is a ralph loop (2026-01); n8n 3-months (2026-06-05); 4-Months Daily Use (2026-02); 2026 MCP/Hooks/Skills Setup (2026-02-01); Agent Harness 10x (2026-05-07); Code Agent Orchestra (2026-03-26); Share Skills With Team (2026-05-07); Scaling Managed Agents / Decoupling brain from hands (2026-04-08); How Claude Code Got Better by Protecting Context (2025-12-10); Effective context engineering for AI agents (2025-09-29).

---

## 10. Provenance & the meta-lesson

- **Generated by:** a Workflow run (`wf_44a0ff69-d04`): 31 agents, 12 parallel research sweeps, 1 synthesizer, 6 bets × (blue + red + judge). Phase 0 grounded by direct machine inspection beforehand. AI-generated, human-directed.
- **The meta-lesson, recorded for the cold reader:** the gate's most valuable output was not the ranking — it was **falsifying the framing of the strongest bet by reproduction**. A1 was pitched as "instrument the unmeasurable blind spot"; the red team proved the metric was measurable *today* from data already on disk. This is the same failure mode as the GitHub-issue closures earlier the same session (five issues closed because their specs described an imagined codebase — `.js` not `.ts`, a `memories` table that is actually `observations`, weighted-blend scoring that is actually RRF). **Both episodes teach one rule: a plausible, internally-coherent artifact (issue, brief, or bet) means nothing until verified against the real system. Verify by execution; reproduce the claimed number before building the thing that produces it.**
- **Candidate learning to promote** (agent scope): *"Before building instrumentation to measure X, check whether X is already derivable from data the system already records — Claude Code writes full per-session `tool_use` transcripts to `~/.claude/projects/**/*.jsonl`, so skill/subagent invocation is readable today without a new meter."*
