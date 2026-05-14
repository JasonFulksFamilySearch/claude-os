# DevOps Review — Episodic Layer Implementation Plan
**Plan:** `2026-05-14-episodic-layer.md`
**Reviewer:** Willis (AI-assisted, human review required)
**Date:** 2026-05-14

---

## Summary

The plan is structurally sound and production-quality in most areas. The TDD discipline
is excellent; all new code has matching test files written first. The most serious
operational gaps are in the Stop hook (async API call blocking session exit, no timeout)
and a missing MCP rebuild step after TypeScript changes. Several medium-severity
configuration and observability issues are noted. No blocking issues were found in the
build or test setup.

---

## Critical

### C1 — Stop hook makes a synchronous blocking Haiku API call with no timeout

**File:** `hooks/session-observer.js` — `callHaiku()` / `main()`

The `callHaiku` call uses Node.js `fetch` with no timeout. If the Anthropic API is slow
or unreachable, this blocks `process.exit(0)` for an unbounded duration. Claude Code's
Stop hook runner has its own timeout, but if that timeout is long the user experiences
a frozen session exit. If the timeout fires and kills the process mid-write, the episode
file could be partially written or corrupted.

**Consequence:** 3–30+ second session exit delays on slow or degraded API; possible
partial episode file on SIGKILL.

**Recommendation:** Wrap the fetch in `Promise.race` against an `AbortController` timeout:

```javascript
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 8_000);
try {
  const response = await fetch(API_URL, { ..., signal: controller.signal });
  ...
} finally {
  clearTimeout(timer);
}
```

Write the episode file to a temp path (`filename + '.tmp'`) and `renameSync` to final
path only after a complete write. This is atomic on the same filesystem and prevents
partial files.

---

### C2 — MCP `npm run build` is never called after TypeScript changes

**Tasks:** 5, 8 (and implicitly 1–4)

The plan adds TypeScript source files (`list_episodes.ts`, `mark_episode_promoted.ts`,
changes to `db.ts`, `indexer.ts`, `index.ts`) but only calls `npm run build` in Task 5
Step 5. Tasks 1–4 commit TypeScript source without a preceding build step. More
critically, Task 8's final commit (`feat: add episodes.json config`) never triggers a
build — but Task 8 is when the hook is registered and the next session start will
attempt to use the MCP server. If `dist/` is stale, the new tools will not exist at
runtime.

**Consequence:** `list_episodes` and `mark_episode_promoted` will fail with "Unknown
tool" until a manual build is performed. The smoke test in Task 8 Step 5 depends on
the compiled output.

**Recommendation:** Add `npm run build` as a gating step at the start of each task's
"Run tests" step (vitest runs from source via tsx, so tests pass; dist is different).
Add an explicit build step to Task 8 before hook registration:

```bash
cd ~/.claude-os/mcp && npm run build
```

Also add a build verification to the smoke test sequence.

---

## High

### H1 — Hook registration step is vague and fragile

**Task 8, Step 2**

The plan says "Read `~/.claude/settings.json`. Find the `hooks.Stop` array (which already
contains `learnings-flush.js`). Add the new hook alongside it." This is a prose
instruction — not a code snippet showing the resulting JSON structure. Given that
settings.json is structured JSON with potential nesting differences between users, a
partial or misformatted edit will silently break all Stop hooks (including `learnings-flush.js`).

The plan does not verify that the existing hooks are preserved after the edit. There is
no "read back and confirm both entries are present" step.

**Consequence:** Silent loss of `learnings-flush.js` if the editor replaces rather than
appends. All pending learnings accumulate and never flush until the mistake is noticed.

**Recommendation:** Show the complete resulting `hooks.Stop` JSON array structure in the
plan. Add a verification step:

```bash
node -e "
const s = require(process.env.HOME + '/.claude/settings.json');
const stops = s.hooks?.Stop ?? [];
const names = stops.map(h => h.command);
console.log('Stop hooks:', names);
if (!names.some(n => n.includes('learnings-flush'))) process.exit(1);
if (!names.some(n => n.includes('session-observer'))) process.exit(1);
console.log('Both hooks present — OK');
"
```

---

### H2 — `episodes.json` is not in `.gitignore`

**Task 8, Step 1 / `.gitignore`**

The root `.gitignore` explicitly excludes `config/watched-projects.json` (machine-local
config generated from a template) but makes no mention of `config/episodes.json`. The
plan creates `config/episodes.json` and commits it in Task 8 Step 6 (`git add
config/episodes.json`). This means a user-tuned config (e.g., `stalenessThresholdDays:
90` on a machine with many projects) would be committed to the shared repo genome,
overwriting defaults on Walter's machine on next sync.

**Consequence:** Machine-local tuning is propagated to the shared repo; diverges from
the existing `watched-projects.json` pattern.

**Recommendation:** Either:

1. Treat `episodes.json` as generated/local (same as `watched-projects.json`) — add
   `config/episodes.json` to `.gitignore` and create `config/episodes.json.template`
   as the tracked artifact, mirroring `config/watched-projects.template.json`.
2. If the defaults belong in the repo (which is reasonable), commit only
   `config/episodes.json` as read-only defaults and document that local overrides
   belong in a `config/episodes.local.json` (and add `*.local.json` to `.gitignore`).

Option 1 is consistent with the existing pattern and is preferred.

---

### H3 — No MCP server restart step after deployment

**Task 8**

After the TypeScript build and hook registration, the plan has no step to restart the
MCP server. Claude Code caches the MCP connection at session start. If a session is
active when Task 8 runs, `list_episodes` and `mark_episode_promoted` will not appear
until Claude Code is restarted. The smoke test in Step 5 (`mcp__claude-os-mcp__list_episodes`)
will silently return "Unknown tool" rather than a clear error.

**Consequence:** Smoke test produces a confusing failure that looks like a code bug
rather than a deployment gap.

**Recommendation:** Add an explicit note to Task 8 between Step 5 (build) and the smoke
test:

```
Restart Claude Code (quit and reopen) to reload the MCP server with the new dist/.
The smoke test MUST run in a fresh session.
```

---

## Medium

### M1 — `HAIKU_MODEL` is still hardcoded

**File:** `hooks/session-observer.js` (line ~12 in plan)

The prior-findings section (M5) already flagged this issue. The plan does not address
it. The constant `HAIKU_MODEL = 'claude-haiku-4-5-20251001'` is a hardcoded string in
session-observer.js with no fallback or override path.

**Consequence:** When the model is deprecated, episode generation silently stops (API
returns 404 or model-not-found). No stderr message distinguishes this from a network
failure.

**Recommendation:** Read the model from `episodes.json` if present, falling back to the
hardcoded default. This also makes the model testable without code changes:

```javascript
const config = loadConfig(CONFIG_PATH); // episodes.json already loaded
const HAIKU_MODEL = config.haikuModel ?? 'claude-haiku-4-5-20251001';
```

Add `haikuModel` as an optional field in `config/episodes.json.template` with a comment.

---

### M2 — `buildEpisodeContent` writes empty `project:` line for null project

**File:** `hooks/session-observer.js`

When `obs.project` is null or empty, the plan emits `project: ` (value is a blank
string). This is syntactically valid YAML but semantically wrong — `gray-matter` will
parse it as an empty string `""`, not `null`. The MCP indexer's
`effectiveProject` extraction (`typeof data.project === "string" ? data.project : null`)
will then store `""` as the project rather than `null`, which breaks `list_episodes`
project-filter queries.

**Consequence:** Episodes without a project are stored with `project: ""` and are
excluded from unfiltered `getRecentEpisodes` calls where `epProject !== project` is
evaluated — the `epProject && ...` guard treats `""` as falsy, so this partially
self-corrects in the session-start-check code. However it produces inconsistent data
in the DB and will break future queries that do exact `project = ""` matches.

**Recommendation:** Emit `project: ~` (YAML null) or omit the key entirely when project
is absent:

```javascript
const projectLine = obs.project ? `project: ${obs.project}` : 'project: ~';
```

---

### M3 — `session-start-check.js` reads stdin via `readFileSync('/dev/stdin')` — fragile

**Task 7, Step 3**

The rewritten `session-start-check.js` main function reads stdin with
`readFileSync('/dev/stdin', 'utf8')`. This is synchronous and will block indefinitely if
stdin is not immediately available (e.g., the hook is invoked without a pipe). The
existing `learnings-flush.js` and `topic-preload.js` both use the established pattern
of `for await (const chunk of process.stdin)`. The old `session-start-check.js` uses
neither — it checks a file marker and ignores stdin entirely. Only `topic-preload.js`
needs stdin.

For `SessionStart`, the hook runner sends `{"cwd": "..."}` on stdin. `readFileSync`
will work in normal execution but will hang if the hook is invoked manually during
testing without a pipe.

**Consequence:** Manual testing and debugging of the hook without piped input hangs the
terminal.

**Recommendation:** Use the established async pattern from `topic-preload.js`:

```javascript
async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let cwd = null;
  try { cwd = JSON.parse(input).cwd || null; } catch {}
  ...
}
if (require.main === module) { main().catch(() => {}); }
```

This is also consistent with the hook pattern already in the repo.

---

### M4 — No TTL / cleanup for episode files (prior finding A3/P-H4 not addressed)

**Scope:** `~/.claude-data/episodes/`

The plan documents `stalenessThresholdDays` in `episodes.json` but this value is only
used to filter injected episodes at session start — it does not delete or archive old
files. Without a cleanup mechanism, `~/.claude-data/episodes/` grows without bound.
The prior review flagged this as A3/P-H4.

**Consequence:** After 6–12 months of daily use (~200–400 files at typical usage), the
directory is large but the impact is low given files are small markdown. The indexer
will re-index all files on each 15-minute backstop cycle, however, which adds latency.

**Recommendation:** Add a `cleanup_episodes` MCP tool or a cron-style hook that
archives or deletes episode files older than `stalenessThresholdDays`. Alternatively,
document this explicitly as a known limitation and provide a manual command in the
runbook:

```bash
find ~/.claude-data/episodes -name "*.md" -mtime +90 -delete
```

Note: `find` is available in Bash context even if Claude Code restricts it for Willis.

---

### M5 — `config/episodes.json` parameters are undocumented (prior finding D-H2 not addressed)

**Task 8, Step 1 / `config/episodes.json`**

The plan creates `config/episodes.json` with two keys but neither a template file nor
inline comments explaining the semantics. The prior review flagged this (D-H2).

`stalenessThresholdDays` has a dual meaning: it controls both session-start injection
filtering AND (implicitly) the intended TTL for cleanup. This non-obvious coupling is
not documented anywhere in the plan.

**Recommendation:** Create `config/episodes.json.template` (mirroring
`watched-projects.template.json`) with a JSON comment workaround:

```json
{
  "_comment": "sessionStartInjectCount: how many recent episodes to inject at session start (default 2)",
  "_comment2": "stalenessThresholdDays: age cutoff for injection AND intended episode TTL (default 30)",
  "_comment3": "haikuModel: override the Haiku model used for episode generation (optional)",
  "sessionStartInjectCount": 2,
  "stalenessThresholdDays": 30
}
```

Or use a `README.md` in `config/` — one already exists for `watched-projects`.

---

### M6 — Smoke test uses `cat <<'EOF'` heredoc — violates tooling rules

**Task 8, Step 4**

The smoke test creates a test episode using a bash heredoc:

```bash
cat > ~/.claude-data/episodes/2026-05-14-smoketest.md << 'EOF'
...
EOF
```

The global CLAUDE.md tooling rules deny `cat` in Bash commands and require using the
Write tool or equivalent for file creation. A future agent executing this plan step
will hit a permission denial.

**Consequence:** The smoke test step fails when executed by Willis.

**Recommendation:** Replace with a `node -e` one-liner or a `_tmp_` script:

```bash
node -e "require('fs').writeFileSync(require('os').homedir()+'/.claude-data/episodes/2026-05-14-smoketest.md', '---\ndate: 2026-05-14\nsession_id: smoketest\nproject: arc\nturns: 5\npromoted: false\n---\n\n## Summary\nSmoke test episode.\n')"
```

---

## Low

### L1 — No operational runbook

The plan contains a Self-Review checklist covering spec coverage and type consistency
but no operational procedures for day-to-day use after deployment.

**Missing procedures:**

1. **Verify episodes are being generated:** Check `ls -lt ~/.claude-data/episodes/` after
   a session ends. If no file appears, check stderr from the Stop hook (Claude Code's
   hook logs are visible in the session output with `--debug`).
2. **Diagnose a broken hook:** Run manually:
   ```bash
   echo '{"session_id":"test","transcript_path":"/path/to/file.jsonl"}' | node ~/.claude-os/hooks/session-observer.js
   ```
3. **Diagnose a broken session-start-check:** Run:
   ```bash
   echo '{"cwd":"/Users/fulksjas/dev/arc"}' | node ~/.claude-os/hooks/session-start-check.js
   ```
4. **Run memory-merger on episodes:** Not addressed — how episodes interact with the
   `memory-merger` skill (which promotes content to learnings.md) is undocumented.
5. **Clean up old episodes:** No TTL mechanism; manual command needed (see M4).
6. **Disable the hook in an emergency:** Remove or comment out the `session-observer`
   entry in `~/.claude/settings.json`. The `stop_hook_active` guard only prevents
   re-entrancy within a single session, not permanent disable.

**Recommendation:** Add a `## Operational Runbook` section at the end of the plan (or
a linked `docs/runbooks/episodic-layer.md`) covering the above six procedures.

---

### L2 — `findLatestTranscript()` scans all project directories on every session end

**File:** `hooks/session-observer.js` — `findLatestTranscript()`

The fallback transcript discovery function walks `~/.claude/projects/*/` and `statSync`s
every `.jsonl` file to find the latest by mtime. This is acceptable now but will become
a measurable delay (~50–200ms) after months of use when the projects directory has
hundreds of subdirectories. It is also unnecessary — the Stop hook receives
`transcript_path` directly in its stdin payload.

**Consequence:** Minor latency; primarily a future maintenance concern.

**Recommendation:** The plan correctly prioritizes `hookData.transcript_path` over the
fallback. Add a `process.stderr.write` warning when the fallback is used, making it
observable:

```javascript
if (!hookData.transcript_path) {
  process.stderr.write('[session-observer] warn: transcript_path not in hook payload, falling back to scan\n');
}
```

---

### L3 — `parseFrontmatter` in `session-start-check.js` is a hand-rolled YAML parser

**Task 7, Step 3**

The rewritten `session-start-check.js` includes a custom `parseFrontmatter` function
that handles only simple key: value pairs. This is a deliberate choice (no `gray-matter`
dependency in hooks), which is correct. However, the parser silently mishandles:

- Multi-word string values with no quotes: `project: my project` → stored as `"my project"` (works)
- Values with colons: `summary: Fixed bug in foo:bar` → truncated to `"Fixed bug in foo"` (wrong)
- Multi-line values (YAML block scalars): not supported, silently dropped

Episode frontmatter is machine-generated by `buildEpisodeContent` in session-observer,
which only emits simple scalar values, so in practice this is not a risk. But it creates
a fragile dependency: if `buildEpisodeContent` is ever changed to emit complex values,
`parseFrontmatter` will silently misread them.

**Recommendation:** Add a comment on `parseFrontmatter` explicitly documenting the
supported subset and the intentional constraint:

```javascript
// Minimal YAML parser for machine-generated episode frontmatter.
// Supports only flat key: value scalars. Do not use for arbitrary YAML.
// Handles: strings, booleans (true/false), integers.
// Does NOT handle: colons in values, multi-line, arrays, or nested objects.
```

---

### L4 — `vitest` test runner for MCP vs `node --test` for hooks — no unified test command

The plan runs MCP tests with `npm test -- <filter>` (vitest) and hook tests with
`node --test <path>`. There is no single command to run all tests across both layers.
This is a minor issue for a personal tooling repo but creates cognitive overhead during
development.

**Recommendation:** Add an `npm run test:all` script to `mcp/package.json` that runs
both suites, or document a wrapper at the repo root. This is low-priority but useful
for a final pre-ship gate.

---

## Finding Index

| ID | Severity | Description |
|---|---|---|
| C1 | Critical | Stop hook blocks on API call with no timeout; no atomic write |
| C2 | Critical | MCP `npm run build` never called after TypeScript changes |
| H1 | High | Hook registration is vague; existing hooks could be silently lost |
| H2 | High | `episodes.json` not in `.gitignore` — will be committed to shared repo |
| H3 | High | No MCP server restart step before smoke test |
| M1 | Medium | `HAIKU_MODEL` still hardcoded (prior finding M5 not addressed) |
| M2 | Medium | Null project writes empty string `""` into frontmatter, not YAML null |
| M3 | Medium | `readFileSync('/dev/stdin')` is fragile; breaks manual testing |
| M4 | Medium | No episode TTL / cleanup (prior finding A3/P-H4 not addressed) |
| M5 | Medium | `episodes.json` parameters undocumented (prior finding D-H2 not addressed) |
| M6 | Medium | Smoke test uses `cat <<'EOF'` — denied by tooling rules |
| L1 | Low | No operational runbook |
| L2 | Low | `findLatestTranscript()` fallback scans all project dirs; no observability |
| L3 | Low | Hand-rolled `parseFrontmatter` undocumented; fragile with complex values |
| L4 | Low | No unified test command across MCP and hooks |
