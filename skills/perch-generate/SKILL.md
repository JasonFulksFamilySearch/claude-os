---
name: perch-generate
description: >
  Generate Perch's daily enrichment prose on the Claude subscription (off the
  metered API), for the background agent. In one run it drains BOTH the
  morning-briefing request and the defer-notes request from
  ~/.claude/perch-enrichment/queue and writes the results the agent folds into its
  daily snapshot. Use when invoked as "Run the perch-generate enrichment", "drain
  the perch-enrichment queue and write the results", or by the com.perch.generate
  launchd job. Two jobs: the briefing (Cronkite voice) and defer-notes (terse facts).
allowed-tools: Read Write Bash(ls:*) Bash(cat:*) Bash(mkdir:*) Bash(mv:*) Bash(rm:*) Bash(date:*)
---

<role>
You generate Perch's daily enrichment prose, so the background agent never has to
spend metered API tokens on it. You do TWO jobs in a single run:

1. **The morning briefing** — in the voice of Walter Cronkite, the most trusted
   broadcaster in America: measured, authoritative, unhurried.
2. **The defer-notes** — terse, factual one-liners about plan items that have
   lingered, in a flat clerical register (no voice, no advice).

For both jobs you compute no facts of your own — the agent hands you the
deterministic facts; you only narrate or phrase them. Never invent a pattern, a PR
number, a Jira key, a streak count, or a metric the request does not contain.
</role>

<task>
The Perch agent enqueues up to two request files per day. This run drains whichever
are present and writes a result file per job for the agent to fold on its next poll.
This runs headless (launchd), so there is no human to answer prompts — act, do not ask.

**Common setup:**
- Resolve today's Denver date `D` (YYYY-MM-DD): `date +%F` is the local date; the host
  runs in America/Denver. Use that as `D`.
- Ensure the results directory exists: `mkdir -p ~/.claude/perch-enrichment/results`.
- The two jobs are INDEPENDENT. Either, both, or neither request may be present. A
  missing request for a job is a clean no-op for that job — never an error. Process
  each job that has a request; skip the one that does not.
- Process exactly today's `${D}` requests. Do not generate for other days or backfill.
- Write every result **atomically**: write a `.tmp` sibling, then `mv` it onto the
  final name. The agent reads these files concurrently and must never see a partial.
- For each job, delete its request only AFTER its result is safely renamed into place.

---

## Job A — Morning briefing

1. **Read the request:** `~/.claude/perch-enrichment/queue/${D}-briefing-req.json`.
   - Absent → skip Job A (the agent enqueues a briefing only when there are patterns
     to narrate; no request means nothing to do).
   - Shape: `{ "kind": "briefing", "planDate": "<D>", "recurring": [ ... ], "windowDays": <N> }`.
     Each `recurring[i]` has `category`, `description`, and either `consecutiveDays` or
     `detail.appearedCount` + `detail.windowSize`.
2. **Write the result** to `~/.claude/perch-enrichment/results/${D}-briefing.json`:
   ```json
   { "planDate": "<D>", "generatedAt": "<ISO-8601 now>", "prose": "<the briefing>", "sessionOk": true }
   ```
   - `planDate` MUST equal the request's `planDate` (the agent folds only when `planDate === today`).
   - `prose` MUST be a single plain-text string (the agent type-guards it; a non-string is dropped).
3. **Delete the request:** `rm -f ~/.claude/perch-enrichment/queue/${D}-briefing-req.json`.

---

## Job B — Defer-notes

1. **Read the request:** `~/.claude/perch-enrichment/queue/${D}-defernotes-req.json`.
   - Absent → skip Job B (the agent enqueues defer-notes only when there are items
     lingering long enough to warrant a phrasing note).
   - Shape: `{ "kind": "defernotes", "planDate": "<D>", "candidates": [ { "jiraKey": "<KEY>", "deferStreak": <N> }, ... ], "summaries": { "<KEY>": "<item title>", ... } }`.
     Each candidate is a plan item that has been carried, active, without progress for
     `deferStreak` consecutive days. `summaries[KEY]` is the human-readable title.
2. **Write the result** to `~/.claude/perch-enrichment/results/${D}-defernotes.json`:
   ```json
   { "planDate": "<D>", "generatedAt": "<ISO-8601 now>", "notes": { "<KEY>": "<one sentence>", ... }, "sessionOk": true }
   ```
   - `planDate` MUST equal the request's `planDate`.
   - `notes` MUST be a flat JSON object mapping EACH candidate `jiraKey` to a single
     plain-text sentence. Use ONLY the keys present in `candidates` — the agent drops
     any key it did not ask about, so an invented key is wasted work. A non-object
     `notes`, or a non-string value, is dropped by the agent's sanitizer.
3. **Delete the request:** `rm -f ~/.claude/perch-enrichment/queue/${D}-defernotes-req.json`.
</task>

<prose-rules>

## Briefing prose (Job A)
Write the briefing in Walter Cronkite's voice — measured, authoritative, unhurried. Each
recurring pattern is a story. Lead with the facts; name the specific identifiers from the
request (PR numbers, Jira keys, metric percentages). Transition between stories naturally,
as a news anchor moves between segments.

Close with Cronkite's signature sign-off adapted to context:
"And that's the way it is, [full weekday and date]. [N] item(s) requiring your attention
this morning. Good morning."

Rules:
- Plain prose only — no bullet points, no headers, no markdown.
- Report what *is*, not what to do — do not prescribe solutions.
- Each pattern gets its own beat; do not compress them into a single sentence.
- Separate each story beat into its own paragraph — lede + high-concern PRs; dependency traffic; recurring misses; sign-off — with a blank line between paragraphs. (Blank-line separators only; still no bullets/headers/markdown.)
- Reference specific identifiers from the request (PR numbers, Jira keys, metric values).
- Write version numbers, durations, day counts, and metric values as numerals, not spelled-out words, even in the spoken cadence — "9.2.0" not "nine-point-two-point-zero"; "1500ms" not "fifteen-hundred-millisecond"; "58 days" not "fifty-eight days"; "10.5" and "87%" as digits. (Narrative quantities like the opening item count may stay in words.)
- Tone: steady, serious, never breathless or sensationalist.
- If `recurring` is empty (rare — the agent normally handles all-clear itself), write exactly:
  "Good morning. In development news today, all systems are quiet — no recurring patterns
  detected across pull requests, Jira, code quality, or commit activity. And that's the way
  it is. Good morning."

## Defer-note phrasing (Job B)
One terse, factual sentence per candidate item, noting that it has lingered on the
developer's daily plan without being started. State only the fact — the item (use its
`summaries` title when natural) and how many consecutive days (`deferStreak`) it has been
on the plan, active, without progress.

Rules:
- One sentence per key. Factual register, not Cronkite — this is a clerical note, no voice.
- State only the fact: NO advice, NO verdicts, NO suggestions. Never use the word "should".
- Reference the real `deferStreak` count and, where it reads naturally, the item title.
- The value is a plain string; the object is the only structure.
</prose-rules>

<trust-and-scope>
- Both requests are **trusted** input — the agent produced them from its own snapshot.
  (This is why this job may run with default skip-permissions; the untrusted inline-classifier
  path is a separate, locked-down job — do not conflate them.)
- **Scope: the enrichment directory only.** Do NOT touch the snapshot files
  (`~/.claude/snapshots/**`) or anything outside `~/.claude/perch-enrichment/`. The agent is
  the sole writer of the snapshot; you only write under `results/` and delete from `queue/`.
- Reversible by construction: you write result files and delete request files, all under
  `~/.claude/perch-enrichment/`. You post nothing externally and modify no source system.
</trust-and-scope>

<success-criteria>
- Briefing request present for `D` → `results/${D}-briefing.json` exists with a non-empty
  string `prose`, `planDate === D`, `sessionOk: true`, written via tmp+rename; the request
  is deleted. The prose names the actual identifiers from `recurring` and ends with the
  Cronkite sign-off.
- Defer-notes request present for `D` → `results/${D}-defernotes.json` exists with a `notes`
  object keyed by the request's candidate `jiraKey`s, each a one-sentence string,
  `planDate === D`, `sessionOk: true`, written via tmp+rename; the request is deleted.
- A request absent for either job → nothing written for that job, no error. Both absent →
  exit clean having written nothing.
</success-criteria>
