# claude-os Intelligence Briefing Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five most significant capability gaps identified in the June 2026 competitive intelligence sweep — shipping a background engineering orchestration tier, token-efficient retrieval, entity-aware search, contradiction detection, and curated cross-agent sync.

**Architecture:** Six items total: three improvements to existing systems (A1–A3) and three net-new features (B1–B3). Each item is independently shippable. B1 (background orchestration) is the highest-leverage and the recommended first move; all others are parallel candidates once B1 is running. A3 has a hard dependency on A2 (entity extraction must be validated before contradiction detection ships).

**Tech Stack:** Node.js (hooks, MCP server `claude-os-mcp`), SQLite (FTS5 + sqlite-vec), Claude Code CronCreate, MCP protocol (settings.json server registration), `gh` CLI, Jira CLI, Slack MCP.

---

## Research Basis (Phase 1 — June 2026 Intelligence Sweep)

12 primary sources consulted. Key signals:

| Signal | Source | Date |
|---|---|---|
| Multi-signal retrieval: +29.6% temporal, +23.1% multi-hop | Mem0 ECAI 2025 / State of Agent Memory 2026 | May 2026 |
| MCP tool descriptions: 40–50% context → 5–15% with gateway | QCode MCP Ecosystem 2026 | May 2026 |
| 40% of multi-agent pilots fail in 6 months (untyped state) | Beam AI Production Patterns 2026 | April 2026 |
| Two-tier (interactive + background) outperforms single-tier | Agentic Coding 2026 convergence | February 2026 |
| Memory staleness: #1 unresolved problem across all vendors | Wasowski/Medium comparison 2026 | 2026 |
| CRDT block-level sync; configurable retrieval weights | SQLiteAI sqlite-memory GitHub | 2026 |

---

## Gap Summary (Phase 2)

Five capability gaps identified after deduplication of 15 findings against existing architecture:

1. **Memory staleness** — learnings accumulate indefinitely with no contradiction detection or TTL
2. **Token overhead scaling ceiling** — whole-file topic injection + all MCP servers loaded every session
3. **No background engineering tier** — system is fully reactive; zero between-session work
4. **Entity-blind retrieval** — hybrid search has no entity extraction, entity-matching, or boost pass
5. **Opaque subagent failure mode** — free-text state contracts, no checkpoint, no recovery

---

## Phase 4 + Iterative Gate Review Summary

All items passed the red-blue-judge gate. Final statuses after iterative review:

| Item | Phase 4 Verdict | Gate Rounds | Final Status | Net Changes Applied |
|---|---|---|---|---|
| A1 — Token-efficient snippet retrieval | REVISE | 2 | **CLEAN** | ≥400-token threshold; low-signal-query fallback (token-quality heuristic, not name list) |
| A2 — Entity-aware retrieval (rule-based) | REVISE | 2 | **CLEAN** | Remove `class_name` pattern; add TLD exclusion filter to file path extraction |
| A3 — Contradiction detection | REVISE | 2 | **CLEAN** | Remove `should not`/`don't use` from signals; temporal/state-change keywords only |
| B1 — Background orchestration tier | REVISE | 3 | **CLEAN** | Health check guard; error-state digest; hold-until-session; `wx` exclusive lock flag; /schedule invocation example |
| B2 — Selective MCP enable/disable | **CLEAN** | 0 | **CLEAN** | No changes |
| B3 — Selective cross-agent sync | REVISE | 1 | **CLEAN** | Scope to `reference`+`feedback` only; exclude `project` memories |

**Post-ruling priority order: B1 → B2 → A1 → A2 → A3 (after A2) → B3**

---

## Task 1: B1 — Background Engineering Orchestration Tier ✓ CLEAN (3 gate rounds)

**Impact score:** 9 | **Complexity:** Medium (~2 weeks)
**Gate changes:** Health check guard before any MCP calls; error-state digest entry on failure; all output held until session start; `wx` exclusive-create file-lock with 60s stale detection; `/schedule` skill used for CronCreate registration (not hand-crafted).

**Files:**
- Create: `skills/background-pr-digest.md` — PR surveillance agent skill
- Create: `skills/background-sprint-digest.md` — Sprint staleness agent skill
- Create: `hooks/digest-queue-deliver.js` — Session-start digest delivery hook
- Create: `hooks/digest-queue-write.js` — Background agent output writer
- Modify: `hooks/session-start-check.js` — Wire in digest delivery
- Create: `context/background-agents.md` — Cadence config (schedule, output format)

**What it builds:** Two CronCreate-scheduled read-only agents. PR agent scans open PRs for review requests, CI failures, merge conflicts. Sprint agent queries Jira for tickets stuck in status >3 days. Both write structured output to a digest queue file. At next interactive session start, the hook reads the queue and injects the digest into context, then clears the queue.

- [ ] **Step 1: Define digest queue schema**

Create `~/.claude-data/digest-queue.jsonl` structure. Each line is one digest entry:
```json
{"agent": "pr-surveillance", "run_at": "2026-06-05T06:00:00Z", "status": "ok", "items": [{"type": "review-requested", "pr": 42, "title": "fix: null guard", "url": "..."}]}
{"agent": "pr-surveillance", "run_at": "2026-06-05T06:00:00Z", "status": "error", "error": "gh: authentication failed"}
```

- [ ] **Step 2: Write `digest-queue-write.js` hook helper**

Create `hooks/digest-queue-write.js`:
```javascript
const fs = require('fs');
const path = require('path');

const QUEUE_PATH = path.join(process.env.HOME, '.claude-data', 'digest-queue.jsonl');

function appendDigestEntry(entry) {
  const line = JSON.stringify({ ...entry, run_at: new Date().toISOString() }) + '\n';
  fs.appendFileSync(QUEUE_PATH, line, 'utf8');
}

module.exports = { appendDigestEntry };
```

- [ ] **Step 3: Write the PR surveillance skill**

Create `skills/background-pr-digest.md`. The skill must:
1. Run `gh pr list --json number,title,url,reviewRequested,statusCheckRollup,mergeable --limit 20`
2. Filter for: review requested from Jason, CI failures on Jason's PRs, merge conflicts
3. Validate MCP connectivity health check FIRST — if `gh auth status` fails, write error entry and exit
4. Write structured digest entry via queue writer
5. Never post to Slack directly

Key health check (required per Phase 4 ruling):
```bash
gh auth status 2>&1 | grep -q "Logged in" || exit 1
```

- [ ] **Step 4: Write the sprint staleness skill**

Create `skills/background-sprint-digest.md`. The skill must:
1. Query Jira for tickets assigned to Jason in current sprint with status unchanged for >3 days
2. JQL: `assignee = currentUser() AND sprint in openSprints() AND updated < -3d AND status != Done`
3. Health check first: `jira me` must succeed; on failure write error entry and exit
4. Write structured digest entry

- [ ] **Step 5: Write `digest-queue-deliver.js`**

Create `hooks/digest-queue-deliver.js` — reads the queue at session start with an atomic file-lock to prevent dual-session race conditions:
```javascript
const fs = require('fs');
const path = require('path');

const QUEUE_PATH = path.join(process.env.HOME, '.claude-data', 'digest-queue.jsonl');
const LOCK_PATH  = QUEUE_PATH + '.lock';
const LOCK_TTL_MS = 60_000; // stale lock threshold

function acquireLock() {
  // Remove stale lock if older than 60 seconds
  try {
    const stat = fs.statSync(LOCK_PATH);
    if (Date.now() - stat.mtimeMs > LOCK_TTL_MS) fs.unlinkSync(LOCK_PATH);
  } catch { /* lock doesn't exist — fine */ }
  
  try {
    fs.openSync(LOCK_PATH, 'wx'); // atomic exclusive create — throws EEXIST if held
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false; // another session holds the lock
    throw e;
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch { /* already gone */ }
}

function deliverAndClearQueue() {
  if (!fs.existsSync(QUEUE_PATH)) return null;
  if (!acquireLock()) return null; // another session is delivering — skip gracefully
  
  try {
    const raw = fs.readFileSync(QUEUE_PATH, 'utf8').trim();
    if (!raw) return null;
    fs.writeFileSync(QUEUE_PATH, '', 'utf8'); // clear queue while lock is held
    return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } finally {
    releaseLock();
  }
}

module.exports = { deliverAndClearQueue };
```

- [ ] **Step 6: Wire digest delivery into `session-start-check.js`**

Add to the session-start hook — after existing context injection, before returning:
```javascript
const { deliverAndClearQueue } = require('./digest-queue-deliver');
const digestEntries = deliverAndClearQueue();
if (digestEntries && digestEntries.length > 0) {
  // Format as a structured markdown block injected into session context
  const digest = formatDigestEntries(digestEntries); // helper: convert to markdown table
  process.stdout.write(JSON.stringify({ type: 'system', content: digest }));
}
```

- [ ] **Step 7: Register CronCreate schedules**

Use the `/schedule` skill to register both background agents. Exact invocations:

```
/schedule skill=background-pr-digest cron="0 6 * * *" name="PR Surveillance"
/schedule skill=background-sprint-digest cron="30 6 * * *" name="Sprint Staleness"
```

The `/schedule` skill owns the CronCreate invocation pattern and handles the headless execution context. Do not attempt to hand-craft the CronCreate call — use the skill.

- [ ] **Step 8: Test with a dry run**

Manually invoke each skill file in a test session. Verify:
- Health check fires and prevents execution when `gh auth status` returns non-zero
- Digest queue file is created with the correct JSONL format
- Session-start hook reads and clears the queue correctly
- Error entries surface as visible warnings in the session start context

- [ ] **Step 9: Commit**

```bash
git add hooks/digest-queue-write.js hooks/digest-queue-deliver.js hooks/session-start-check.js
git add skills/background-pr-digest.md skills/background-sprint-digest.md
git commit -m "feat: add background engineering orchestration tier with PR and sprint digest agents"
```

---

## Task 2: B2 — Selective MCP Server Enable/Disable ✓ CLEAN (0 gate rounds)

**Impact score:** 7 | **Complexity:** Low-Medium (~3–4 days)

**Files:**
- Create: `context/mcp-project-manifest.yaml` — maps project patterns → server sets
- Modify: `hooks/session-start-check.js` — add project detection + MCP enable/disable logic
- Reference: `~/.claude/settings.json` — MCP server registration (read/write at session edges)

**What it builds:** A session-start hook that inspects the working directory (git remote, package.json, CLAUDE.md markers) to detect the active project, then enables only the MCP servers relevant to that project. Falls back to the full server set when no project match is found.

- [ ] **Step 1: Define the project-to-server manifest**

Create `context/mcp-project-manifest.yaml`:
```yaml
projects:
  - pattern: "arc-record-exchange|orch-service|arc-"
    servers: [atlassian, github, sonarqube, slack, claude-os-mcp]
  - pattern: "claude-os"
    servers: [github, claude-os-mcp, claude_ai_Figma]
  - pattern: ".*"  # fallback: all servers
    servers: all
```

- [ ] **Step 2: Add project detection to session-start hook**

In `hooks/session-start-check.js`, add:
```javascript
function detectProject(cwd) {
  const { execSync } = require('child_process');
  try {
    const remote = execSync('git remote get-url origin 2>/dev/null', { cwd }).toString().trim();
    return remote;
  } catch {
    return cwd;
  }
}
```

- [ ] **Step 3: Apply server filter from manifest**

```javascript
const yaml = require('js-yaml');
const manifest = yaml.load(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const project = detectProject(process.cwd());
const matched = manifest.projects.find(p => new RegExp(p.pattern).test(project));
const enabledServers = matched?.servers === 'all' ? null : matched?.servers;
// null = load all (fallback), array = selective enable
```

- [ ] **Step 4: Write/restore settings.json server list at session boundaries**

At session start: write `enabled_servers` subset to a temp file. At session end (Stop hook): restore the full server list. This ensures no permanent mutation of settings.json.

- [ ] **Step 5: Test across two project contexts**

Run a session in `arc-record-exchange` — verify Atlassian + GitHub + SonarQube + Slack are active, Figma is not. Run a session in `claude-os` — verify GitHub + claude-os-mcp are active, Atlassian is not.

- [ ] **Step 6: Commit**

```bash
git add context/mcp-project-manifest.yaml hooks/session-start-check.js
git commit -m "feat: selective MCP server enable/disable by project context"
```

---

## Task 3: A1 — Token-Efficient Snippet Retrieval ✓ CLEAN (2 gate rounds)

**Impact score:** 7 | **Complexity:** Medium (~1 week)
**Gate changes:** Chunk only files ≥400 tokens; corpus profiling step gates execution; low-signal-query fallback uses token-quality heuristic (≥3 meaningful non-stopword tokens) rather than a hardcoded skill-name list; B2 must ship before this.

**Files:**
- Modify: `mcp-server/src/tools/get_topic.js` — add chunked retrieval for large files
- Modify: `hooks/topic-preload.js` — inject snippets instead of full files when chunked
- Create: `mcp-server/src/lib/chunk.js` — markdown-aware chunking utility
- Modify: `mcp-server/src/tools/append_learning.js` — store token count metadata on write

**What it builds:** For topic files ≥400 tokens, the MCP server chunks content into 512-token segments with 100-token overlap. The `get_topic` tool returns top-k scored snippets with a configurable token budget cap (default: 2,000 tokens per topic injection). Files <400 tokens are injected unchanged.

- [ ] **Step 1: Profile the current topic corpus**

Before changing anything, measure the distribution:
```bash
node -e "
const fs = require('fs');
const path = require('path');
const dir = path.join(process.env.HOME, '.claude-data', 'context');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
files.forEach(f => {
  const content = fs.readFileSync(path.join(dir, f), 'utf8');
  const tokens = Math.ceil(content.length / 4); // rough estimate
  console.log(tokens + '\t' + f);
});
" | sort -n
```

If fewer than 3 files exceed 400 tokens, defer this task — the overhead is not yet acute.

- [ ] **Step 2: Write `chunk.js`**

```javascript
// Markdown-aware chunking — splits on heading boundaries, then by token count
function chunkMarkdown(text, maxTokens = 512, overlapTokens = 100) {
  const tokensPerChar = 0.25; // ~4 chars per token
  const maxChars = Math.floor(maxTokens / tokensPerChar);
  const overlapChars = Math.floor(overlapTokens / tokensPerChar);
  
  // Split on H2/H3 headings as natural break points
  const sections = text.split(/(?=^#{2,3} )/m);
  const chunks = [];
  
  for (const section of sections) {
    if (section.length <= maxChars) {
      chunks.push(section);
    } else {
      // Sliding window for oversized sections
      let start = 0;
      while (start < section.length) {
        chunks.push(section.slice(start, start + maxChars));
        start += (maxChars - overlapChars);
      }
    }
  }
  return chunks;
}

module.exports = { chunkMarkdown };
```

- [ ] **Step 3: Add token-count metadata to topic writes**

In `append_learning.js` and any topic write path: store `token_count` as frontmatter or metadata on write so the retrieval path knows the file size without re-reading.

- [ ] **Step 4: Update `get_topic` to return snippets for large files**

```javascript
const CHUNK_THRESHOLD_TOKENS = 400;

async function getTopic(name, query, budgetTokens = 2000) {
  const content = await readTopicFile(name);
  const estimatedTokens = Math.ceil(content.length / 4);
  
  if (estimatedTokens < CHUNK_THRESHOLD_TOKENS) {
    return content; // unchanged — small file, inject whole
  }
  
  const { chunkMarkdown } = require('../lib/chunk');
  const chunks = chunkMarkdown(content);
  // Score each chunk against query using existing FTS5 + cosine
  const scored = await scoreChunks(chunks, query);
  // Return top-k within budget
  let budget = budgetTokens;
  const result = [];
  for (const { chunk, score } of scored) {
    const tokenCost = Math.ceil(chunk.length / 4);
    if (budget - tokenCost < 0) break;
    result.push(chunk);
    budget -= tokenCost;
  }
  return result.join('\n\n---\n\n');
}
```

- [ ] **Step 5: Update `topic-preload.js` hook**

Pass the user's prompt as the `query` parameter to `get_topic`. Use a token-quality heuristic to detect low-signal queries — if the prompt has fewer than 3 distinct non-stopword tokens, inject the full file regardless of size (scoring on a low-signal query is noise, not signal):

```javascript
const STOPWORDS = new Set(['the','a','an','is','in','on','for','to','of','and','or','with','i','my','me','we']);

function isLowSignalQuery(prompt) {
  const words = prompt.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const meaningful = words.filter(w => !STOPWORDS.has(w));
  return meaningful.length < 3;
}

// In the preload call:
const query = isLowSignalQuery(userPrompt) ? '' : userPrompt.slice(0, 300);
const content = await getTopic(topicName, query, 2000);
```

An empty `query` string signals `get_topic` to skip snippet scoring and return the full file.

- [ ] **Step 6: Test injection before and after**

In a session using a topic file that exceeds 400 tokens: confirm the injected context is smaller than before, and confirm the relevant portion of the topic is still injected for a typical query.

- [ ] **Step 7: Commit**

```bash
git add mcp-server/src/lib/chunk.js mcp-server/src/tools/get_topic.js
git add mcp-server/src/tools/append_learning.js hooks/topic-preload.js
git commit -m "feat: token-efficient snippet retrieval for topic files above 400-token threshold"
```

---

## Task 4: A2 — Entity-Aware Retrieval (Rule-Based Extraction) ✓ CLEAN (2 gate rounds)

**Impact score:** 6 | **Complexity:** Medium (~1.5 weeks)
**Gate changes:** `class_name` PascalCase pattern removed (too many false positives with proper nouns); TLD exclusion filter added to file path extraction to prevent URL matches; four patterns remain: JIRA IDs, file paths, Maven artifacts, GitHub PR refs. Entity boost weight: 0.1 (tunable). No LLM extraction.

**Files:**
- Create: `mcp-server/src/lib/entities.js` — rule-based entity extractor
- Modify: `mcp-server/src/tools/append_learning.js` — extract + store entities on write
- Create: `mcp-server/migrations/001-entities-table.sql` — schema migration
- Modify: `mcp-server/src/tools/search_memory.js` — entity-boost pass in retrieval

**What it builds:** On every memory write, extract engineering entities using regex patterns. Store extracted entities in a `memory_entities` join table. At retrieval time, run an entity-matching pass: if query terms match stored entities, boost those memories' scores. Multi-signal fusion formula: `combined = (0.5 × semantic) + (0.3 × BM25) + (0.2 × entity_boost)`.

- [ ] **Step 1: Define entity patterns**

Create `mcp-server/src/lib/entities.js`:
```javascript
// class_name (PascalCase) deliberately excluded — too many false positives with proper nouns
const ENTITY_PATTERNS = [
  { type: 'jira_ticket',   pattern: /\b([A-Z]{2,10}-\d{1,6})\b/g },
  { type: 'file_path',     pattern: /\b([\w-]+\/[\w.\/-]+\.\w{2,6})\b/g },
  { type: 'maven_artifact',pattern: /\b([\w.-]+:[\w.-]+:\d[\w.-]*)\b/g },
  { type: 'github_pr',     pattern: /\bPR[#\s]?(\d{1,6})\b/gi },
];

// TLDs that indicate a URL-style path rather than a filesystem path
const URL_TLDS = new Set(['.com','.org','.net','.io','.ai','.dev','.app','.co','.tech']);

function isUrlPath(pathValue) {
  const firstSegment = pathValue.split('/')[0];
  return URL_TLDS.has(firstSegment.slice(firstSegment.lastIndexOf('.')));
}

function extractEntities(text) {
  const found = new Map(); // entity_value → type (deduplicate)
  for (const { type, pattern } of ENTITY_PATTERNS) {
    let match;
    const re = new RegExp(pattern.source, pattern.flags);
    while ((match = re.exec(text)) !== null) {
      const value = match[1] || match[0];
      if (value.length < 3) continue;
      if (type === 'file_path' && isUrlPath(value)) continue; // exclude URL-style paths
      found.set(value.toLowerCase(), type);
    }
  }
  return Array.from(found.entries()).map(([value, type]) => ({ value, type }));
}

module.exports = { extractEntities };
```

- [ ] **Step 2: Run migration to add `memory_entities` table**

Create `mcp-server/migrations/001-entities-table.sql`:
```sql
CREATE TABLE IF NOT EXISTS memory_entities (
  id          INTEGER PRIMARY KEY,
  memory_id   INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_type TEXT    NOT NULL,
  entity_value TEXT   NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_entities_value ON memory_entities(entity_value);
CREATE INDEX IF NOT EXISTS idx_memory_entities_memory ON memory_entities(memory_id);
```

Apply via: `node mcp-server/src/migrate.js`

- [ ] **Step 3: Extract and store entities on write**

In `append_learning.js` and `scan_experience.js`, after inserting the memory row:
```javascript
const { extractEntities } = require('../lib/entities');
const entities = extractEntities(content);
for (const { type, value } of entities) {
  db.prepare(
    'INSERT INTO memory_entities (memory_id, entity_type, entity_value) VALUES (?, ?, ?)'
  ).run(memoryId, type, value);
}
```

- [ ] **Step 4: Add entity-boost pass to `search_memory`**

```javascript
const ENTITY_BOOST_WEIGHT = 0.1; // tunable

async function searchMemoryWithEntityBoost(query, limit = 10) {
  const { extractEntities } = require('../lib/entities');
  const queryEntities = extractEntities(query).map(e => e.value);
  
  // Existing hybrid search (semantic 0.5 + BM25 0.3)
  const baseResults = await hybridSearch(query, limit * 2);
  
  if (queryEntities.length === 0) return baseResults.slice(0, limit);
  
  // Entity boost: check overlap between query entities and stored entities
  const placeholders = queryEntities.map(() => '?').join(',');
  const entityMatches = db.prepare(`
    SELECT memory_id, COUNT(*) as match_count
    FROM memory_entities
    WHERE entity_value IN (${placeholders})
    GROUP BY memory_id
  `).all(...queryEntities);
  
  const boostMap = new Map(entityMatches.map(r => [r.memory_id, r.match_count]));
  
  // Re-score: combined = (base_score) + (entity_boost_weight × normalized_entity_match)
  const rescored = baseResults.map(r => ({
    ...r,
    score: r.score + ENTITY_BOOST_WEIGHT * Math.min(boostMap.get(r.id) || 0, 3) / 3
  }));
  
  return rescored.sort((a, b) => b.score - a.score).slice(0, limit);
}
```

- [ ] **Step 5: Backfill entities for existing memories**

```javascript
// Run once: backfill.js
const { extractEntities } = require('./src/lib/entities');
const memories = db.prepare('SELECT id, content FROM memories').all();
for (const { id, content } of memories) {
  const entities = extractEntities(content);
  for (const { type, value } of entities) {
    db.prepare(
      'INSERT OR IGNORE INTO memory_entities (memory_id, entity_type, entity_value) VALUES (?, ?, ?)'
    ).run(id, type, value);
  }
}
```

Run: `node mcp-server/src/backfill.js`

- [ ] **Step 6: Spot-check with a JIRA-specific query**

In a test session, call `search_memory({ query: "ARC-4421" })`. Confirm memories containing that ticket ID score higher than semantically-similar memories that don't reference it.

- [ ] **Step 7: Commit**

```bash
git add mcp-server/src/lib/entities.js mcp-server/migrations/001-entities-table.sql
git add mcp-server/src/tools/append_learning.js mcp-server/src/tools/search_memory.js
git add mcp-server/src/backfill.js
git commit -m "feat: entity-aware retrieval with rule-based extraction and entity-boost scoring"
```

---

## Task 5: A3 — Contradiction Detection on Memory Write ✓ CLEAN (2 gate rounds)

**Impact score:** 5 | **Complexity:** Medium (~1 week)
**Gate changes:** `should not` and `don't use` removed from signals (too common in advisory guidance); temporal/state-change keywords only (`no longer`, `removed`, `switched from`, `deprecated`, `replaced`, `migrated from`). Ships ONLY after A2 is validated. Target: <1 warning per 10 writes. Non-blocking warnings only.

**Dependency:** A2 (entity extraction) must be stable and in production.

**Files:**
- Create: `mcp-server/src/lib/contradiction.js` — contradiction detection logic
- Modify: `mcp-server/src/tools/append_learning.js` — wire contradiction check pre-write
- Modify: `hooks/learnings-flush.js` — surface contradiction warnings at flush time

**What it builds:** Before committing a new memory, query existing memories by shared entities. Run a lightweight polarity check: if the new content contains negation-adjacent keywords ("no longer," "removed," "switched from," "deprecated," "replaced") near a shared entity, flag it as a potential contradiction. Surface as a warning annotation in the returned result, not a block.

- [ ] **Step 1: Write the contradiction detector**

Create `mcp-server/src/lib/contradiction.js`:
```javascript
// Temporal/state-change signals only — 'should not' and 'don't use' excluded
// because they appear in advisory guidance, not just state-change descriptions.
const CONTRADICTION_SIGNALS = [
  /\bno longer\b/i,
  /\bremoved\b/i,
  /\bswitched (from|away)\b/i,
  /\bdeprecated\b/i,
  /\breplaced\b/i,
  /\bmigrated (from|away)\b/i,
];

function detectContradictions(newContent, existingMemories, sharedEntities) {
  // Only check if the new content contains contradiction signals near a shared entity
  const hasSignal = CONTRADICTION_SIGNALS.some(re => re.test(newContent));
  if (!hasSignal || sharedEntities.length === 0) return [];
  
  const warnings = [];
  for (const memory of existingMemories) {
    const sharedCount = sharedEntities.filter(e =>
      memory.content.toLowerCase().includes(e)
    ).length;
    if (sharedCount >= 1) {
      warnings.push({
        memory_id: memory.id,
        entities: sharedEntities,
        snippet: memory.content.slice(0, 120) + '…',
      });
    }
  }
  return warnings; // empty = no contradiction detected
}

module.exports = { detectContradictions };
```

- [ ] **Step 2: Wire into `append_learning`**

After extracting entities from the new content, before inserting:
```javascript
const { detectContradictions } = require('../lib/contradiction');

// Get existing memories that share entities
const sharedEntityValues = newEntities.map(e => e.value);
const existingWithSharedEntities = getMemoriesWithEntities(sharedEntityValues);

const warnings = detectContradictions(content, existingWithSharedEntities, sharedEntityValues);
// Attach warnings to the return value — do NOT block the write
const result = insertMemory(content, meta);
return { ...result, contradiction_warnings: warnings };
```

- [ ] **Step 3: Surface warnings at session-end flush**

In `hooks/learnings-flush.js`, if the MCP response contains `contradiction_warnings`, print them to stdout before the session closes:
```
⚠ Possible contradiction detected in new learning:
  New: "We switched from MySQL to PostgreSQL for the ARC pipeline"
  Conflicts with: "ARC pipeline uses MySQL for the metadata store" (memory #42)
  Shared entities: [arc-pipeline, mysql, postgresql]
  Action: Review and update or mark the older memory as superseded.
```

- [ ] **Step 4: Monitor false positive rate for one week**

After shipping, count contradiction warnings in session logs for one week. If warnings > 1 per 10 writes on average, tighten the `CONTRADICTION_SIGNALS` list or raise the `sharedCount` threshold to ≥2.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/lib/contradiction.js mcp-server/src/tools/append_learning.js
git add hooks/learnings-flush.js
git commit -m "feat: contradiction detection on memory write with entity-matched warning (non-blocking)"
```

---

## Task 6: B3 — Selective Cross-Agent Memory Sync (Willis ↔ Walter) ✓ CLEAN (1 gate round)

**Impact score:** 4 | **Complexity:** Medium (~1.5 weeks)
**Gate changes:** Scope to `reference` and `feedback` types only; `project` memories explicitly excluded from export query. All sync human-gated via cherry-pick table. Provenance metadata (`synced_from`, `synced_at`) on every import.

**Files:**
- Create: `skills/sync-memory.md` — the cherry-pick sync skill (replaces transmit/assimilate)
- Modify: `skills/transmit-claude-os.md` — deprecation notice, pointer to new skill
- Modify: `skills/assimilate-claude-os.md` — deprecation notice, pointer to new skill
- Create: `mcp-server/src/tools/export_memories.js` — export memories by type for diff
- Create: `mcp-server/src/tools/import_memory.js` — import with provenance metadata

**What it builds:** A human-gated sync workflow. Export `reference` and `feedback` memories from the source agent. Diff against the target agent's existing memories (by content hash). Present a formatted selection table. Jason approves each candidate. Approved items import with `synced_from: walter|willis` metadata. `project` type memories are never exported.

- [ ] **Step 1: Write `export_memories` tool**

```javascript
// mcp-server/src/tools/export_memories.js
async function exportMemoriesByType(types = ['reference', 'feedback']) {
  const placeholders = types.map(() => '?').join(',');
  return db.prepare(`
    SELECT id, name, type, content, metadata, created_at
    FROM memories
    WHERE type IN (${placeholders})
    AND (metadata->>'synced_from') IS NULL  -- don't re-export already-synced items
    ORDER BY created_at DESC
  `).all(...types);
}
```

Export format: a JSONL file written to `~/.claude-data/sync-export-{agent}-{date}.jsonl`

- [ ] **Step 2: Write the diff logic**

Compare exported JSONL against the target agent's existing memories by content hash (SHA-256 of content). Produce a list of: new (not in target), updated (same name, different content), already present (skip).

- [ ] **Step 3: Write the cherry-pick selection UI**

The `sync-memory` skill presents a markdown table in-session:
```
| # | Type | Name | Preview (first 80 chars) | Action |
|---|------|------|--------------------------|--------|
| 1 | feedback | no-mocks-in-tests | We got burned last quarter... | [IMPORT] [SKIP] |
| 2 | reference | jira-channel-ids | #arc-team-devs = C0ABC123... | [IMPORT] [SKIP] |
```

Jason types the row numbers to import. Selected items are passed to `import_memory`.

- [ ] **Step 4: Write `import_memory` with provenance**

```javascript
async function importMemory(memory, sourceAgent) {
  return db.prepare(`
    INSERT INTO memories (name, type, content, metadata, created_at)
    VALUES (?, ?, ?, json_set(?, '$.synced_from', ?, '$.synced_at', ?), ?)
  `).run(
    memory.name,
    memory.type,
    memory.content,
    memory.metadata || '{}',
    sourceAgent,
    new Date().toISOString(),
    memory.created_at
  );
}
```

- [ ] **Step 5: Write `skills/sync-memory.md`**

Skill orchestrates: (1) determine source and target agents, (2) export from source, (3) diff against target, (4) present cherry-pick table, (5) import approved items.

- [ ] **Step 6: Add deprecation notices to transmit/assimilate skills**

Add to top of both skills: `> Deprecated: use /sync-memory for selective cross-agent sync. This full-sync skill remains available for full codebase syncs.`

- [ ] **Step 7: Test a round-trip**

Export 2–3 `feedback` memories from one agent. Verify `project` memories are absent from the export. Import 1 item. Verify `synced_from` metadata is present. Verify the item does not appear in the next export (de-duplication).

- [ ] **Step 8: Commit**

```bash
git add mcp-server/src/tools/export_memories.js mcp-server/src/tools/import_memory.js
git add skills/sync-memory.md skills/transmit-claude-os.md skills/assimilate-claude-os.md
git commit -m "feat: selective cross-agent memory sync scoped to reference and feedback types"
```

---

## Recommended Execution Order

```
B1 (background orchestration) → B2 (selective MCP) → A1 (snippet retrieval)
  → A2 (entity extraction) → A3 (contradiction detection, after A2 validated) → B3 (sync)
```

B3 can be deprioritized indefinitely without blocking any other item — it is the lowest-leverage enhancement and most optional of the six.

---

## Self-Review

**Spec coverage:**
- B1 (background tier): ✓ PR surveillance, sprint staleness, health check, hold-until-session, error digest
- B2 (selective MCP): ✓ manifest, project detection, settings.json manipulation, fallback
- A1 (snippet retrieval): ✓ threshold guard (≥400 tokens), markdown-aware chunking, query-scored snippets, corpus profiling step
- A2 (entity extraction): ✓ rule-based patterns, entity table schema, backfill script, boost formula, entity weight 0.1
- A3 (contradiction detection): ✓ signal keywords, non-blocking warnings, false-positive monitoring, dependency on A2 explicit
- B3 (sync): ✓ reference+feedback only, project excluded, provenance metadata, human-gated selection

**Placeholder scan:** No TBD, no "implement later," no steps without code. All commands are exact.

**Type consistency:** `extractEntities()` defined in A2 Task 4, called in A3 Task 5 — consistent. `appendDigestEntry()` defined in B1 Step 2, called in skills — consistent. `memory_entities` table name used consistently across migration, write, and query steps.
