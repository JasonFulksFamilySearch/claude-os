# Experience-Synthesis Value-Gated Selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make experience-synthesis select which episodes/clusters to distill by a per-session *value* signal, shipping the gate inert (shadow mode) with a calibration log, and reconcile the code↔doc cluster-ordering mismatch.

**Architecture:** A value scalar is minted at the existing Stop-hook worker into episode frontmatter (absence = unknown). `scan_experience` carries the field through the read path and applies an *inert-by-default* selection gate (episode floor, cluster floor via max-of-scored-members, value-aware cap), logging what it *would* drop to a sibling JSONL telemetry file. Cluster ordering stays a code-owned deterministic tiebreak; the SKILL.md stops dictating order. Nothing is excluded until thresholds are set live on evidence.

**Tech Stack:** TypeScript (`mcp/src/**`, vitest), CommonJS hooks (`hooks/**`, Node builtins), `gray-matter` frontmatter, `better-sqlite3`, idempotent in-code DDL (no migrations dir).

**Design of record:** `docs/superpowers/specs/2026-06-08-experience-synthesis-value-selection-design.md` (PR #27, issue #26).

**Conventions (verified):**
- Run tests from `mcp/`: `npm test` (`vitest run`) or a single file `npx vitest run test/<file> -t "<name>"`.
- Episode frontmatter parsed two ways, kept in lockstep: `hooks/lib/episode-utils.js` (manual CommonJS) and `mcp/src/episodes.ts` (gray-matter). **Edit both or neither.**
- New tuning constants go in `mcp/src/search_config.ts` as FIXED principled defaults.
- `list_episodes.ts` needs **no edit** — pure alias inheriting `EpisodeRecord`.

---

## File Map

| File | Change |
|------|--------|
| `mcp/src/search_config.ts` | **Modify** — add 4 value-gate constants (Task 1) |
| `hooks/lib/episode-utils.js` | **Modify** — add `value_score` to `ALLOWED_FM_KEYS` (Task 2) |
| `hooks/session-observer-worker.js` | **Modify** — derive + write `value_score` in `buildEpisodeContent` and `main` (Task 3) |
| `mcp/src/episodes.ts` | **Modify** — `EpisodeRecord` field + `listEpisodeFiles` populate (Task 4) |
| `mcp/src/tools/scan_experience.ts` | **Modify** — carry field + selection gate + shadow log (Tasks 5–8) |
| `mcp/src/experience-shadow.ts` | **Create** — shadow-log writer (Task 7) |
| `mcp/test/search_config.test.ts` | **Modify** — assert the new defaults (Task 1) |
| `mcp/test/tools.test.ts` | **Modify** — gate + shadow tests (Tasks 5, 6, 8) |
| `mcp/test/episodes` *(via fixtures)* | exercised in tools.test.ts |
| `skills/experience-synthesis/SKILL.md` | **Modify** — delete ordering parenthetical (Task 9) |

Build order is writer → reader → gate → shadow → reconcile, so a partially-applied plan is always safe (the gate is inert until Task 6, and even then permissive until thresholds are set live).

---

## Task 1: Add inert value-gate constants

**Files:**
- Modify: `mcp/src/search_config.ts` (append after the B1 block, ~line 69)
- Test: `mcp/test/search_config.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `mcp/test/search_config.test.ts` (inside the existing top-level `describe`, or as a new one):

```typescript
import {
  EXPERIENCE_MIN_EPISODE_VALUE,
  EXPERIENCE_MIN_CLUSTER_VALUE,
  EXPERIENCE_VALUE_GATE_MODE,
  EXPERIENCE_VALUE_FEATURE_DATE,
} from "../src/search_config.js";

describe("experience value-gate config", () => {
  it("ships inert: both thresholds null and mode shadow", () => {
    expect(EXPERIENCE_MIN_EPISODE_VALUE).toBeNull();
    expect(EXPERIENCE_MIN_CLUSTER_VALUE).toBeNull();
    expect(EXPERIENCE_VALUE_GATE_MODE).toBe("shadow");
  });

  it("carries an ISO feature-ship date for shadow bucketing", () => {
    expect(EXPERIENCE_VALUE_FEATURE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && npx vitest run test/search_config.test.ts -t "experience value-gate config"`
Expected: FAIL — the four symbols are not exported.

- [ ] **Step 3: Add the constants**

Append to `mcp/src/search_config.ts`:

```typescript
// --- Experience value-gated selection (ships INERT; flipped live only on shadow-log evidence) ---
// FIXED, principled defaults — not fit to any labeled set.

// Episode value floor. A present value_score strictly below this is excluded BEFORE clustering.
// null ⇒ no episode excluded (shadow only). An ABSENT score is never excluded regardless.
export const EXPERIENCE_MIN_EPISODE_VALUE: number | null = null;

// Cluster value floor. A cluster's value = max(scored members); a cluster is dropped only if
// every scored member is below this. null ⇒ no cluster excluded (shadow only). All-keyless ⇒ kept.
export const EXPERIENCE_MIN_CLUSTER_VALUE: number | null = null;

// "shadow" computes the would-drop set but returns the full set (behaviour identical to pre-gate);
// "live" actually filters. Flip to "live" only when the shadow log shows a defensible distribution.
export const EXPERIENCE_VALUE_GATE_MODE: "shadow" | "live" = "shadow";

// ISO date the value writer shipped. Episodes dated before it are expected keyless ("pre-feature")
// and must not be counted as judge declines in the shadow-log calibration null-rate.
export const EXPERIENCE_VALUE_FEATURE_DATE = "2026-06-08";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && npx vitest run test/search_config.test.ts -t "experience value-gate config"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mcp/src/search_config.ts mcp/test/search_config.test.ts
git commit -m "Feat: add inert experience value-gate config constants"
```

---

## Task 2: Allow `value_score` through the CommonJS frontmatter parser

**Files:**
- Modify: `hooks/lib/episode-utils.js:22` and its parse loop
- Test: `hooks/test/` — add a small node:test (see Step 1); if the hooks dir has no test runner, fall back to the inline assertion described in Step 2.

- [ ] **Step 1: Write the failing test**

Create `hooks/test/episode-utils-value.test.js`:

```javascript
'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { parseFrontmatter } = require('../lib/episode-utils.js');

test('parseFrontmatter accepts an integer value_score', () => {
  const fm = parseFrontmatter('---\ndate: 2026-06-08\nvalue_score: 3\n---\nbody\n');
  assert.strictEqual(fm.value_score, 3);
});

test('parseFrontmatter still drops unknown keys', () => {
  const fm = parseFrontmatter('---\ndate: 2026-06-08\nbogus: x\n---\nbody\n');
  assert.strictEqual(fm.bogus, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test hooks/test/episode-utils-value.test.js`
Expected: FAIL — `value_score` is dropped (not in the allowlist), so `fm.value_score` is `undefined`.

- [ ] **Step 3: Add `value_score` to the allowlist**

In `hooks/lib/episode-utils.js`, change line 22 from:

```javascript
const ALLOWED_FM_KEYS = new Set(['date', 'session_id', 'project', 'turns', 'promoted']);
```

to:

```javascript
const ALLOWED_FM_KEYS = new Set([
  'date', 'session_id', 'project', 'turns', 'promoted',
  'value_score', 'value_source', 'value_rubric_version', 'value_model',
]);
```

(The existing integer branch — `else if (/^\d+$/.test(val)) data[key] = parseInt(val, 10);` — already coerces `value_score: 3` to the number `3`; the three provenance keys are strings, handled by the existing `else if (val.length > 0) data[key] = val;` branch. No parser-branch change is needed.)

Extend the Step-1 test to cover a provenance key round-tripping:

```javascript
test('parseFrontmatter accepts string provenance keys', () => {
  const fm = parseFrontmatter('---\ndate: 2026-06-08\nvalue_source: llm-judge\nvalue_model: claude-haiku-4-5\n---\nbody\n');
  assert.strictEqual(fm.value_source, 'llm-judge');
  assert.strictEqual(fm.value_model, 'claude-haiku-4-5');
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test hooks/test/episode-utils-value.test.js`
Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/episode-utils.js hooks/test/episode-utils-value.test.js
git commit -m "Feat: allow value_score through episode frontmatter parser"
```

---

## Task 3: Mint the value scalar at the Stop-hook worker

**Files:**
- Modify: `hooks/session-observer-worker.js` — `buildEpisodeContent` (line 207) and the `obs`-deriving path (`callClaude`/`coerceObservation`, ~line 204)
- Test: `hooks/test/build-episode-value.test.js`

The worker derives an `obs` object from the transcript via `callClaude`. The value scalar is part of that judged observation: the Claude prompt is extended to return an optional integer `value_score` (0–4) or omit it. `buildEpisodeContent` writes the key **only when present** — absence = unknown.

- [ ] **Step 1: Write the failing test**

Create `hooks/test/build-episode-value.test.js`:

```javascript
'use strict';
const assert = require('node:assert');
const test = require('node:test');
// buildEpisodeContent is module-internal; export it for testing (Step 3 adds the export).
const { buildEpisodeContent } = require('../session-observer-worker.js');

const baseObs = () => ({
  summary: 'did a thing', decisions: [], corrections: [], discoveries: [], files_of_note: [],
});

test('writes value_score line when obs.value_score is a number', () => {
  const md = buildEpisodeContent({ ...baseObs(), value_score: 3 }, 'sess-1', 5);
  assert.match(md, /^value_score: 3$/m);
});

test('omits the value_score line entirely when obs.value_score is absent', () => {
  const md = buildEpisodeContent(baseObs(), 'sess-1', 5);
  assert.ok(!/value_score/.test(md), 'no value_score key should be written');
});

test('omits the value_score line when obs.value_score is null (never a fabricated 0)', () => {
  const md = buildEpisodeContent({ ...baseObs(), value_score: null }, 'sess-1', 5);
  assert.ok(!/value_score/.test(md));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test hooks/test/build-episode-value.test.js`
Expected: FAIL — `buildEpisodeContent` is not exported, and it never writes `value_score`.

- [ ] **Step 3: Write the value line + export the function**

In `hooks/session-observer-worker.js`, in `buildEpisodeContent`, after the `if (obs.project)` line (line 215) and before the `fmLines.push('turns'...)` line (216), insert:

```javascript
  if (Number.isInteger(obs.value_score) && obs.value_score >= 0 && obs.value_score <= 4) {
    fmLines.push('value_score: ' + obs.value_score);
    // Provenance — only alongside a real score (provenance without a score is meaningless).
    // VALUE_RUBRIC_VERSION and VALUE_MODEL are module constants defined near the top of the worker.
    fmLines.push('value_source: llm-judge');
    fmLines.push('value_rubric_version: ' + VALUE_RUBRIC_VERSION);
    fmLines.push('value_model: ' + VALUE_MODEL);
  }
```

Define the two constants near the top of `hooks/session-observer-worker.js` (with the other module constants):

```javascript
const VALUE_RUBRIC_VERSION = 'v1';
const VALUE_MODEL = 'claude-haiku-4-5'; // the model callClaude invokes for the episode judge
```

Extend the Step-1 test to assert the provenance trio appears with the score and is absent without it:

```javascript
test('writes provenance keys alongside a present score', () => {
  const md = buildEpisodeContent({ ...baseObs(), value_score: 3 }, 'sess-1', 5);
  assert.match(md, /^value_source: llm-judge$/m);
  assert.match(md, /^value_rubric_version: v1$/m);
  assert.match(md, /^value_model: .+$/m);
});

test('writes no provenance keys when the score is absent', () => {
  const md = buildEpisodeContent(baseObs(), 'sess-1', 5);
  assert.ok(!/value_source/.test(md));
});
```

At the bottom of the file, add `buildEpisodeContent` to the module exports (match the file's existing export style; if it uses `module.exports = { ... }`, add the name; if functions are individually exported, add `module.exports.buildEpisodeContent = buildEpisodeContent;`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test hooks/test/build-episode-value.test.js`
Expected: PASS (all three)

- [ ] **Step 5: Extend the judge prompt to produce the scalar**

In the prompt string passed to `callClaude` (the instruction block that asks Claude to return the observation JSON), add a field instruction:

```text
- value_score (OPTIONAL integer 0–4): the durable leverage of this session —
  0 = no durable value / thrash or reverted; 1 = minor; 2 = a useful local fix;
  3 = a reusable lesson; 4 = a lesson that changes how future sessions are run.
  OMIT this field entirely if the transcript gives insufficient signal to judge
  confidently — never guess a 0.
```

Then in `coerceObservation` (the function that shapes the parsed JSON into `obs`), carry the field through ONLY when it is a valid integer 0–4, else leave it `undefined`:

```javascript
  value_score:
    Number.isInteger(raw.value_score) && raw.value_score >= 0 && raw.value_score <= 4
      ? raw.value_score
      : undefined,
```

- [ ] **Step 6: Commit**

```bash
git add hooks/session-observer-worker.js hooks/test/build-episode-value.test.js
git commit -m "Feat: mint bounded value_score at the episode worker (absence=unknown)"
```

---

## Task 4: Carry `value_score` onto `EpisodeRecord`

**Files:**
- Modify: `mcp/src/episodes.ts` — `EpisodeRecord` interface (lines 10-18) + the populate in `listEpisodeFiles` (lines 72-84)
- Test: `mcp/test/tools.test.ts` (the `list_episodes` describe block already exists; add one case there) — OR a focused `episodes` test. This plan adds it to the `scan_experience` block in Task 5 where fixtures exist; here we add a minimal `episodes`-level check.

- [ ] **Step 1: Write the failing test**

Add to `mcp/test/tools.test.ts`, inside the existing `describe("scan_experience (B1)", ...)` block (it already has `writeEpisode`/`seed`), a new case that also writes a `value_score` and reads it back via `listEpisodesImpl` (imported at line 22):

```typescript
  it("surfaces value_score on EpisodeRecord when present, undefined when absent", () => {
    const dir = episodesDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-06-10.md"),
      `---\ndate: 2026-06-10\nsession_id: sess-10\npromoted: false\nvalue_score: 3\n---\n\n## Summary\nscored\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "2026-06-11.md"),
      `---\ndate: 2026-06-11\nsession_id: sess-11\npromoted: false\n---\n\n## Summary\nunscored\n`,
      "utf8",
    );
    const entries = listEpisodesImpl({}, episodesDir());
    const scored = entries.find((e) => e.session_id === "sess-10")!;
    const unscored = entries.find((e) => e.session_id === "sess-11")!;
    expect(scored.value_score).toBe(3);
    expect(unscored.value_score).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && npx vitest run test/tools.test.ts -t "surfaces value_score on EpisodeRecord"`
Expected: FAIL — `EpisodeRecord` has no `value_score`; `scored.value_score` is `undefined` (TS will also flag the property).

- [ ] **Step 3: Add the field to the interface**

In `mcp/src/episodes.ts`, add to the `EpisodeRecord` interface (after `promoted: boolean;`, line 15):

```typescript
  value_score: number | undefined;
```

- [ ] **Step 4: Populate it in `listEpisodeFiles`**

In `mcp/src/episodes.ts`, in the `out.push({ ... })` block (lines 72-84), add after `promoted,`:

```typescript
        value_score:
          typeof d.value_score === "number" && Number.isInteger(d.value_score) ? d.value_score : undefined,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd mcp && npx vitest run test/tools.test.ts -t "surfaces value_score on EpisodeRecord"`
Expected: PASS. (`list_episodes.ts` needs no change — `EpisodeEntry = EpisodeRecord` inherits the field.)

- [ ] **Step 6: Commit**

```bash
git add mcp/src/episodes.ts mcp/test/tools.test.ts
git commit -m "Feat: carry value_score onto EpisodeRecord and listEpisodeFiles"
```

---

## Task 5: Carry `value_score` through the scan_experience output shape

**Files:**
- Modify: `mcp/src/tools/scan_experience.ts` — `ClusterMember` interface (16-21) and the output map (~95-100)
- Test: `mcp/test/tools.test.ts` (scan_experience block)

- [ ] **Step 1: Write the failing test**

Add to the `describe("scan_experience (B1)", ...)` block. Extend the `writeEpisode` helper usage with a scored variant inline:

```typescript
  it("emits value_score on each returned ClusterMember (present and absent)", () => {
    const dir = episodesDir();
    mkdirSync(dir, { recursive: true });
    const scored = (slug: string, v: number): string => {
      const p = join(dir, `2026-06-${slug}.md`);
      writeFileSync(
        p,
        `---\ndate: 2026-06-${slug}\nsession_id: sess-${slug}\npromoted: false\nvalue_score: ${v}\n---\n\n## Summary\ns\n`,
        "utf8",
      );
      return p;
    };
    seed(scored("01", 4), themeA());
    seed(scored("02", 2), themeA());
    seed(writeEpisode("03", false), themeA()); // unscored → undefined
    const { clusters } = scanExperience(db, {}, config);
    expect(clusters).toHaveLength(1);
    const byId = Object.fromEntries(clusters[0].members.map((m) => [m.session_id, m.value_score]));
    expect(byId["sess-01"]).toBe(4);
    expect(byId["sess-02"]).toBe(2);
    expect(byId["sess-03"]).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && npx vitest run test/tools.test.ts -t "emits value_score on each returned ClusterMember"`
Expected: FAIL — `ClusterMember` has no `value_score`; the map doesn't emit it.

- [ ] **Step 3: Add the field to `ClusterMember` and the output map**

In `mcp/src/tools/scan_experience.ts`, add to `interface ClusterMember` (16-21, after `summary: string | null;`):

```typescript
  value_score: number | undefined;
```

Then in the output map (the inner `members.map((ep) => ({ ... }))` at ~95-100), add after `summary: ep.summary,`:

```typescript
        value_score: ep.value_score,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && npx vitest run test/tools.test.ts -t "emits value_score on each returned ClusterMember"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mcp/src/tools/scan_experience.ts mcp/test/tools.test.ts
git commit -m "Feat: carry value_score through scan_experience output shape"
```

---

## Task 6: The selection gate (episode floor, cluster floor, value-aware cap) — inert by default

**Files:**
- Modify: `mcp/src/tools/scan_experience.ts` — add a pure `applyValueGate` helper + wire it into `scanExperience`
- Test: `mcp/test/tools.test.ts` (scan_experience block)

The gate is a pure function over the resolved members + clusters so it is unit-testable in isolation and honours `EXPERIENCE_VALUE_GATE_MODE`. In `shadow` mode it returns the full set unchanged and reports a would-drop set; in `live` it filters.

- [ ] **Step 1: Write the failing tests**

Add to the scan_experience block (reuse the `scored` helper from Task 5 — promote it to a block-level `const` if not already):

```typescript
  it("shadow mode never excludes, even below a live threshold", () => {
    const dir = episodesDir(); mkdirSync(dir, { recursive: true });
    const mk = (slug: string, v?: number) => {
      const p = join(dir, `2026-06-${slug}.md`);
      const vs = v === undefined ? "" : `value_score: ${v}\n`;
      writeFileSync(p, `---\ndate: 2026-06-${slug}\nsession_id: sess-${slug}\npromoted: false\n${vs}---\n\n## Summary\ns\n`, "utf8");
      return p;
    };
    seed(mk("01", 0), themeA()); seed(mk("02", 0), themeA()); seed(mk("03", 0), themeA());
    // gate stays shadow (config default) → all three returned despite value 0
    const { clusters } = scanExperience(db, {}, config);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].size).toBe(3);
  });

  it("a keyless episode is never excluded even in live mode", () => {
    const dir = episodesDir(); mkdirSync(dir, { recursive: true });
    const mk = (slug: string, v?: number) => {
      const p = join(dir, `2026-06-${slug}.md`);
      const vs = v === undefined ? "" : `value_score: ${v}\n`;
      writeFileSync(p, `---\ndate: 2026-06-${slug}\nsession_id: sess-${slug}\npromoted: false\n${vs}---\n\n## Summary\ns\n`, "utf8");
      return p;
    };
    seed(mk("01", 4), themeA()); seed(mk("02", 4), themeA()); seed(mk("03"), themeA()); // 03 keyless
    const live = { ...config, valueGate: { mode: "live" as const, minEpisode: 2, minCluster: 2 } };
    const { clusters } = scanExperience(db, {}, live);
    expect(clusters[0].members.map((m) => m.session_id).sort()).toContain("sess-03");
  });

  it("live mode drops a cluster whose every scored member is below the floor", () => {
    const dir = episodesDir(); mkdirSync(dir, { recursive: true });
    const mk = (slug: string, v: number) => {
      const p = join(dir, `2026-06-${slug}.md`);
      writeFileSync(p, `---\ndate: 2026-06-${slug}\nsession_id: sess-${slug}\npromoted: false\nvalue_score: ${v}\n---\n\n## Summary\ns\n`, "utf8");
      return p;
    };
    seed(mk("01", 1), themeA()); seed(mk("02", 1), themeA()); seed(mk("03", 1), themeA());
    const live = { ...config, valueGate: { mode: "live" as const, minEpisode: null, minCluster: 3 } };
    const { clusters } = scanExperience(db, {}, live);
    expect(clusters).toHaveLength(0); // max member value 1 < cluster floor 3
  });

  it("max-aggregation: one high-value member rescues its cluster in live mode", () => {
    const dir = episodesDir(); mkdirSync(dir, { recursive: true });
    const mk = (slug: string, v: number) => {
      const p = join(dir, `2026-06-${slug}.md`);
      writeFileSync(p, `---\ndate: 2026-06-${slug}\nsession_id: sess-${slug}\npromoted: false\nvalue_score: ${v}\n---\n\n## Summary\ns\n`, "utf8");
      return p;
    };
    seed(mk("01", 4), themeA()); seed(mk("02", 1), themeA()); seed(mk("03", 1), themeA());
    const live = { ...config, valueGate: { mode: "live" as const, minEpisode: null, minCluster: 3 } };
    const { clusters } = scanExperience(db, {}, live);
    expect(clusters).toHaveLength(1); // max member value 4 ≥ floor 3
  });
```

(NOTE: this introduces an optional `valueGate` override on the config object so tests can force `live`; the default path reads the `search_config.ts` constants. Define its type in Step 3.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && npx vitest run test/tools.test.ts -t "shadow mode never excludes"`
Expected: FAIL — no gate exists; `valueGate` is not a known config field.

- [ ] **Step 3: Implement the gate**

In `mcp/src/tools/scan_experience.ts`:

a. Import the constants at the top:

```typescript
import {
  EXPERIENCE_MAX_EPISODES,
  EXPERIENCE_MIN_EPISODE_VALUE,
  EXPERIENCE_MIN_CLUSTER_VALUE,
  EXPERIENCE_VALUE_GATE_MODE,
} from "../search_config.js";
```

b. Add a resolved-options type and helper (above `scanExperience`):

```typescript
export interface ValueGateOptions {
  mode: "shadow" | "live";
  minEpisode: number | null;
  minCluster: number | null;
}

function resolveValueGate(config: IndexerConfig & { valueGate?: ValueGateOptions }): ValueGateOptions {
  return (
    config.valueGate ?? {
      mode: EXPERIENCE_VALUE_GATE_MODE,
      minEpisode: EXPERIENCE_MIN_EPISODE_VALUE,
      minCluster: EXPERIENCE_MIN_CLUSTER_VALUE,
    }
  );
}

// An episode is excluded only if it HAS a score strictly below the floor. Absent score ⇒ kept.
function episodeBelowFloor(v: number | undefined, floor: number | null): boolean {
  return floor !== null && typeof v === "number" && v < floor;
}

// Cluster value = max over scored members; a cluster with no scored members is "unknown" ⇒ kept.
function clusterBelowFloor(memberValues: (number | undefined)[], floor: number | null): boolean {
  if (floor === null) return false;
  const scored = memberValues.filter((v): v is number => typeof v === "number");
  if (scored.length === 0) return false; // all-keyless ⇒ unknown ⇒ keep
  return Math.max(...scored) < floor;
}
```

c. In `scanExperience`, change the signature to accept the optional override and wire the gate. After the recency cap (the `episodes = backlog.slice(0, cap)` at ~line 71), and after building the shaped `clusters` (~line 90-101), apply the gate. The episode floor filters `members`/`vectors` *before* clustering; the cluster floor filters the shaped output. In `shadow` mode, compute the would-drop sets but return everything.

Replace the cap + cluster section with:

```typescript
  const gate = resolveValueGate(config as IndexerConfig & { valueGate?: ValueGateOptions });
  const cap = (config as { valueGate?: unknown } & ScanExperienceInput && undefined, args.max_episodes) ?? EXPERIENCE_MAX_EPISODES;
  // value-aware cap: when over the cap, keep highest-value-then-most-recent. Below the cap this is a no-op.
  const ranked = backlog
    .slice()
    .sort((a, b) => (b.value_score ?? -1) - (a.value_score ?? -1) || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const episodes = (backlog.length > cap ? ranked : backlog).slice(0, cap);
```

(Keep the existing embedding-resolution loop unchanged. Then, where clusters are shaped:)

```typescript
  const shaped = clusterByEmbedding(members, vectors).map((c) => ({
    size: c.members.length,
    cohesion: c.cohesion,
    members: c.members.map((ep) => ({
      path: ep.path,
      session_id: ep.session_id,
      date: ep.date,
      summary: ep.summary,
      value_score: ep.value_score,
    })),
  }));

  const wouldDropClusters = shaped.filter((c) => clusterBelowFloor(c.members.map((m) => m.value_score), gate.minCluster));
  const clusters = gate.mode === "live" ? shaped.filter((c) => !wouldDropClusters.includes(c)) : shaped;
  return { clusters };
```

And apply the **episode** floor where members are assembled (in the embedding loop, skip an episode that is below the episode floor when `gate.mode === "live"`; in shadow, keep it but record it). Add, inside the loop just before `members.push(ep)`:

```typescript
    if (gate.mode === "live" && episodeBelowFloor(ep.value_score, gate.minEpisode)) continue;
```

(The shadow-mode would-drop *episode* set is recorded in Task 7's logging call, which wraps this.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && npx vitest run test/tools.test.ts -t "scan_experience"`
Expected: PASS (all scan_experience cases, old and new). Also run the full suite to catch the signature change: `cd mcp && npm test`.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/tools/scan_experience.ts mcp/test/tools.test.ts
git commit -m "Feat: inert value-gated selection in scan_experience"
```

---

## Task 7: Shadow-log writer

**Files:**
- Create: `mcp/src/experience-shadow.ts`
- Modify: `mcp/src/tools/scan_experience.ts` — call the writer with the histogram + would-drop sets
- Test: `mcp/test/tools.test.ts` (scan_experience block)

- [ ] **Step 1: Write the failing test**

Add to the scan_experience block — assert a shadow-log line is appended with the histogram and would-drop sets, to a test-injected path:

```typescript
  it("appends one shadow-log line per run with a bucketed histogram", () => {
    const dir = episodesDir(); mkdirSync(dir, { recursive: true });
    const shadowPath = join(workDir, "experience-shadow.jsonl");
    const mk = (slug: string, v?: number, date = `2026-06-${slug}`) => {
      const p = join(dir, `${date}.md`);
      const vs = v === undefined ? "" : `value_score: ${v}\n`;
      writeFileSync(p, `---\ndate: ${date}\nsession_id: sess-${slug}\npromoted: false\n${vs}---\n\n## Summary\ns\n`, "utf8");
      return p;
    };
    seed(mk("01", 3), themeA()); seed(mk("02", 3), themeA()); seed(mk("03"), themeA()); // one keyless, post-feature
    scanExperience(db, {}, { ...config, shadowLogPath: shadowPath } as never);
    const lines = readFileSync(shadowPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.gate_mode).toBe("shadow");
    expect(rec.value_histogram["3"]).toBe(2);
    expect(rec.value_histogram.unknown_declined).toBe(1); // keyless + date ≥ feature date
    expect(Array.isArray(rec.would_exclude_clusters)).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && npx vitest run test/tools.test.ts -t "appends one shadow-log line"`
Expected: FAIL — no shadow log is written.

- [ ] **Step 3: Create the writer**

Create `mcp/src/experience-shadow.ts`:

```typescript
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { EXPERIENCE_VALUE_FEATURE_DATE } from "./search_config.js";

export const DEFAULT_SHADOW_LOG = join(homedir(), ".claude-data", "experience-shadow.jsonl");

export interface ShadowMember { date: string; value_score: number | undefined; }
export interface ShadowRecord {
  run_ts: string;
  gate_mode: "shadow" | "live";
  rubric_version: string;
  episodes_considered: number;
  value_histogram: Record<string, number>;
  would_exclude_episodes: string[];
  would_exclude_clusters: { size: number; max_member_value: number | null }[];
}

// Build the bucketed histogram. Unknown (keyless) episodes split by the feature-ship date so the
// 136 pre-feature episodes are not mistaken for judge declines (the calibration null-rate is
// unknown_declined / post-feature). nowTs is injectable because Date.now() is unavailable in some
// contexts and to keep the writer pure/testable.
export function buildHistogram(members: ShadowMember[]): Record<string, number> {
  const h: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, unknown_pre_feature: 0, unknown_declined: 0 };
  for (const m of members) {
    if (typeof m.value_score === "number") h[String(m.value_score)] = (h[String(m.value_score)] ?? 0) + 1;
    else if (m.date < EXPERIENCE_VALUE_FEATURE_DATE) h.unknown_pre_feature++;
    else h.unknown_declined++;
  }
  return h;
}

export function writeShadowRecord(record: ShadowRecord, logPath: string = DEFAULT_SHADOW_LOG): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8");
}
```

- [ ] **Step 4: Wire it into `scanExperience`**

In `scan_experience.ts`, import:

```typescript
import { buildHistogram, writeShadowRecord, DEFAULT_SHADOW_LOG, type ShadowMember } from "../experience-shadow.js";
```

After computing `shaped` and `wouldDropClusters` (Task 6), and before `return`, assemble + write the record. `run_ts` is passed in via config in tests (Date.now() is avoided in workflow contexts but fine in the MCP server; default to `new Date().toISOString()` guarded):

```typescript
  const cfg = config as IndexerConfig & { shadowLogPath?: string; runTs?: string };
  const allMembers: ShadowMember[] = episodes.map((ep) => ({ date: ep.date, value_score: ep.value_score }));
  writeShadowRecord(
    {
      run_ts: cfg.runTs ?? new Date().toISOString(),
      gate_mode: gate.mode,
      rubric_version: "v1",
      episodes_considered: episodes.length,
      value_histogram: buildHistogram(allMembers),
      would_exclude_episodes: gate.mode === "live"
        ? []
        : episodes.filter((ep) => episodeBelowFloor(ep.value_score, gate.minEpisode)).map((ep) => ep.path),
      would_exclude_clusters: wouldDropClusters.map((c) => ({
        size: c.size,
        max_member_value: (() => {
          const scored = c.members.map((m) => m.value_score).filter((v): v is number => typeof v === "number");
          return scored.length ? Math.max(...scored) : null;
        })(),
      })),
    },
    cfg.shadowLogPath ?? DEFAULT_SHADOW_LOG,
  );
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd mcp && npx vitest run test/tools.test.ts -t "appends one shadow-log line"`
Expected: PASS

- [ ] **Step 6: Run the full suite**

Run: `cd mcp && npm test`
Expected: PASS (all suites — confirms no regression from the scan_experience changes)

- [ ] **Step 7: Commit**

```bash
git add mcp/src/experience-shadow.ts mcp/src/tools/scan_experience.ts mcp/test/tools.test.ts
git commit -m "Feat: shadow-log writer for the experience value gate"
```

---

## Task 8: Acceptance test — the three design invariants together

**Files:**
- Test: `mcp/test/tools.test.ts` (scan_experience block) — one consolidated acceptance case

- [ ] **Step 1: Write the acceptance test**

```typescript
  it("ACCEPTANCE: shadow≡no-gate+logs, live changes membership, unknown never excluded", () => {
    const dir = episodesDir(); mkdirSync(dir, { recursive: true });
    const shadowPath = join(workDir, "accept-shadow.jsonl");
    const mk = (slug: string, v?: number) => {
      const p = join(dir, `2026-06-${slug}.md`);
      const vs = v === undefined ? "" : `value_score: ${v}\n`;
      writeFileSync(p, `---\ndate: 2026-06-${slug}\nsession_id: sess-${slug}\npromoted: false\n${vs}---\n\n## Summary\ns\n`, "utf8");
      return p;
    };
    seed(mk("01", 0), themeA()); seed(mk("02", 0), themeA()); seed(mk("03"), themeA()); // 03 keyless

    // (1) shadow ≡ no-gate: all 3 returned, and a log line is written
    const shadow = scanExperience(db, {}, { ...config, shadowLogPath: shadowPath } as never);
    expect(shadow.clusters[0].size).toBe(3);
    expect(readFileSync(shadowPath, "utf8").trim().split("\n")).toHaveLength(1);

    // (2) live changes membership: floor 2 drops the value-0 members, keeps keyless → size shrinks
    const live = scanExperience(db, {}, { ...config, valueGate: { mode: "live", minEpisode: 2, minCluster: null } } as never);
    const liveSize = live.clusters[0]?.size ?? 0;
    expect(liveSize).toBeLessThan(3);

    // (3) unknown never excluded: sess-03 (keyless) survives live filtering
    expect(live.clusters[0]?.members.map((m) => m.session_id)).toContain("sess-03");
  });
```

- [ ] **Step 2: Run it**

Run: `cd mcp && npx vitest run test/tools.test.ts -t "ACCEPTANCE"`
Expected: PASS — all three invariants hold.

- [ ] **Step 3: Commit**

```bash
git add mcp/test/tools.test.ts
git commit -m "Test: acceptance — shadow/live/unknown invariants for the value gate"
```

---

## Task 9: Reconcile the SKILL.md ordering instruction

**Files:**
- Modify: `skills/experience-synthesis/SKILL.md:59`

No test (documentation). This removes the code↔doc mismatch by deleting the ordering parenthetical while preserving the "need not exhaust" license.

- [ ] **Step 1: Make the edit**

In `skills/experience-synthesis/SKILL.md`, change line 59 from:

```
For each cluster (process the highest-cohesion clusters first; a single run need not exhaust them):
```

to:

```
For each cluster (process clusters in the order returned by `scan_experience`; a single run need not exhaust them — discard any cluster whose members do not share a genuine recurring situation):
```

- [ ] **Step 2: Verify no other line in Step 2 references cohesion ordering**

Run: `cd skills/experience-synthesis && node -e "const s=require('fs').readFileSync('SKILL.md','utf8'); console.log(/highest-cohesion/.test(s) ? 'STILL PRESENT' : 'clean')"`
Expected: `clean`

- [ ] **Step 3: Commit**

```bash
git add skills/experience-synthesis/SKILL.md
git commit -m "Docs: stop dictating cluster order in experience-synthesis SKILL.md"
```

---

## Task 10: Full-suite green + provisioning check

**Files:** none (verification)

- [ ] **Step 1: Run the whole MCP suite**

Run: `cd mcp && npm test`
Expected: PASS — every suite.

- [ ] **Step 2: Run the hook tests**

Run: `node --test hooks/test/`
Expected: PASS — episode-utils + build-episode value tests.

- [ ] **Step 3: Confirm no machine-setup step was left manual**

The only new persistent artifact is `~/.claude-data/experience-shadow.jsonl`, which is created on first write by `writeShadowRecord` (`mkdirSync` + `appendFileSync`) — no provisioning needed. The new `search_config.ts` constants and parser/worker edits ship with the genome via the normal `update.sh` rebuild (MCP `tsc` build). Confirm there is **nothing** to add to `update.sh` / `hooks-install.js` / `config/scheduled-jobs.json` for this unit. (The value gate does NOT add a scheduled job — that is Gap 4, out of scope.)

- [ ] **Step 4: Build the MCP server**

Run: `cd mcp && npm run build`
Expected: `tsc` exits 0 (no type errors from the new fields/signatures).

---

## Self-Review

**Spec coverage:**
- Writer (auditable bounded scalar, absence=unknown, headless at Stop worker) → Tasks 2, 3. Per-design §4, the full provenance trio (`value_source`, `value_rubric_version`, `value_model`) is written alongside `value_score` (allowlist in Task 2, frontmatter in Task 3), so every scored episode is self-describing and reproducible across a model/rubric change.
- Five lockstep sites → Tasks 2 (ALLOWED_FM_KEYS), 4 (EpisodeRecord + listEpisodeFiles populate), 5 (ClusterMember interface + output map). `list_episodes.ts` no-edit → confirmed in Task 4 Step 5.
- Episode gate / cluster gate (max-of-scored) / value-aware cap → Task 6.
- Inert defaults (null/null/shadow + feature date) → Task 1.
- Shadow log mirroring digest-queue seam → Task 7.
- SKILL.md:59 reconcile → Task 9.
- Acceptance (shadow≡no-gate, live changes membership, unknown never excluded) → Task 8.

**Placeholder scan:** No "TBD"/"handle edge cases"; every code step shows code. The plan now matches design §4 in full (provenance keys included).

**Type consistency:** `value_score: number | undefined` is identical across `EpisodeRecord` (Task 4), `ClusterMember` (Task 5), and the shadow `ShadowMember` (Task 7). `ValueGateOptions { mode, minEpisode, minCluster }` is used identically in Task 6 tests and impl. `EXPERIENCE_VALUE_*` names match Task 1 exactly.

**Known open item for the executor:** Task 6 Step 3's cap-rewrite line is written defensively; if the existing `scan_experience.ts` cap expression differs, preserve `args.max_episodes ?? EXPERIENCE_MAX_EPISODES` semantics and apply the value-aware ranking only when `backlog.length > cap`. Confirm `VALUE_MODEL` (Task 3) matches the model `callClaude` actually invokes in the worker — read the worker's Claude-invocation line and set the constant to the real model id rather than assuming.
