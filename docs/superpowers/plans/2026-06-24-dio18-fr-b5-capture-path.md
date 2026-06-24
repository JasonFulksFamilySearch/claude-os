# DIO-18 / FR-B5 Capture Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the FR-B5 capture path **default-OFF** — a tool-signal producer, a session-scoped capture buffer, a file-sentinel arming flag, and an episode-worker consumer that writes a `## Tool signals` section — so compressed tool signals can later reach episodic memory, while shipping in an off, byte-identical-to-pre-feature state.

**Architecture:** A new `lib/capture-buffer.js` module (mirroring the existing `lib/findings-buffer.js`) owns the indexer-excluded `~/.claude-data/capture-buffer/<sessionId>.jsonl`. A new `lib/fr-b5-flag.js` module reads a file sentinel under `~/.claude-data/flags/` (hooks cannot open the SQLite meta table where `c2_chunking_enabled` lives). The PostToolUse router's `main()` gains a fail-safe side-effect: when the compressor produced an envelope AND the flag is armed AND compress is not skipped, it appends one buffer line — the router's frozen `route()` return contract is untouched. The Stop episode worker reads that buffer alongside the transcript and appends a `## Tool signals` section directly (not via `summarize()`), via a new conditional section mirroring the existing Decisions/Corrections pattern.

**Tech Stack:** Node.js (CommonJS hooks layer, no TypeScript, no `better-sqlite3` in hooks); `node --test` for hook tests (the existing `hooks/test/*.test.js` convention); the project's `safeString`/JSONL conventions.

## Global Constraints

- **Default-OFF, byte-identical reversibility (AC-5c.2):** with the flag sentinel ABSENT (the shipped default), every code path is a no-op and the produced episode `.md` is **byte-identical** to pre-feature output. This is the load-bearing invariant — every task preserves it.
- **No `better-sqlite3` in hooks:** the hooks layer has no `hooks/package.json` / `node_modules`; never `require('better-sqlite3')` from a hook. The flag is a FILE sentinel, never the meta table.
- **Determinism (AC-5c.1, BLOCKING):** no `Date.now()` / `Math.random()` in any buffer-line or section payload; the line is a pure function of its inputs (mirror `findings-buffer.js` determinism).
- **Indexer-excluded buffer (AC-4 / no-write-back):** `capture-buffer/` is a sibling of `capture-queue/` under `~/.claude-data` — outside the four indexed subtrees, so `classify()` returns null. `COUNT(*) FROM observations WHERE source_path LIKE '%capture-buffer%'` MUST be 0.
- **Fail-safe:** no capture or flag-read error may ever crash a tool call or session close — every I/O wrapped in try/catch returning a safe default (the established posture in `posttooluse-content-router.js` and `stop-episodic-capture.js`).
- **Signal not raw dump:** the buffer line carries the compressed SIGNAL summary (`{ tool, retained-row summary, dropped_count, row-verdicts, ccr_hash }`), never the raw tool output.
- **Field-name reconciliation:** the ticket/PRD say `ccr_hash`; the live code field is `originalHash` (`smart-crusher.js` / `buildCompressedEnvelope`). Use `originalHash` as the source value; the buffer key is `ccr_hash` (the ticket's contract name) set FROM `originalHash`. State this mapping in code comments.
- **Out of scope (do not build):** the arming flip (#72), the DIO-19 fidelity A/B harness (#59), the eval re-baseline run. This plan builds the OFF state only.

---

### Task 1: FR-B5 file-sentinel flag module

**Files:**
- Create: `hooks/lib/fr-b5-flag.js`
- Test: `hooks/test/fr-b5-flag.test.js`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `FLAGS_DIR` (string), `flagPath(name, dir?)` → string, `isArmed(name, { dir?, exists? })` → boolean. `isArmed` returns `true` IFF the sentinel file exists; any error → `false` (fail-safe to OFF).

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { isArmed, flagPath, FLAGS_DIR } = require('../lib/fr-b5-flag.js');

test('absent sentinel ⇒ not armed (the default)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frb5flag-'));
  try {
    assert.equal(isArmed('fr_b5_capture', { dir }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('present sentinel ⇒ armed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frb5flag-'));
  try {
    writeFileSync(flagPath('fr_b5_capture', dir), '');
    assert.equal(isArmed('fr_b5_capture', { dir }), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a throwing exists() ⇒ fail-safe to OFF', () => {
  const boom = () => { throw new Error('fs blew up'); };
  assert.equal(isArmed('fr_b5_capture', { dir: '/x', exists: boom }), false);
});

test('FLAGS_DIR is under ~/.claude-data/flags', () => {
  assert.ok(FLAGS_DIR.endsWith(join('.claude-data', 'flags')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hooks && node --test test/fr-b5-flag.test.js`
Expected: FAIL — `Cannot find module '../lib/fr-b5-flag.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';

/**
 * fr-b5-flag.js — the FR-B5 arming flag, a FILE SENTINEL (not the SQLite meta table).
 *
 * The hooks layer has no better-sqlite3 (no hooks/package.json / node_modules), so it
 * cannot read the meta table where c2_chunking_enabled lives. FR-B5's gate is therefore
 * a file under ~/.claude-data/flags/: present = armed, absent = off (the default).
 * Routing rule for the project: DB-open consumers → meta table; hook consumers → file flags.
 *
 * Reversibility (AC-5c.2): an ABSENT sentinel is the shipped default and makes every
 * FR-B5 path a no-op, so the episode is byte-identical to pre-feature. Disarming is
 * deleting the file. isArmed() fails safe to OFF on any error.
 */

const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const FLAGS_DIR = join(homedir(), '.claude-data', 'flags');

function safeName(name) {
  return (String(name).replace(/[^a-zA-Z0-9_-]/g, '') || 'flag').slice(0, 64);
}

function flagPath(name, dir = FLAGS_DIR) {
  return join(dir, safeName(name));
}

function isArmed(name, { dir = FLAGS_DIR, exists = existsSync } = {}) {
  try {
    return exists(flagPath(name, dir)) === true;
  } catch {
    return false; // fail-safe: any error ⇒ treat as OFF
  }
}

module.exports = { FLAGS_DIR, flagPath, isArmed };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hooks && node --test test/fr-b5-flag.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/fr-b5-flag.js hooks/test/fr-b5-flag.test.js
git commit -m "feat(fr-b5): file-sentinel arming flag, default-OFF"
```

---

### Task 2: Capture-buffer module (producer storage)

**Files:**
- Create: `hooks/lib/capture-buffer.js`
- Test: `hooks/test/capture-buffer.test.js`

**Interfaces:**
- Consumes: `safeString` from `./observation.js` (the project's canonical sanitizer — strips control chars incl. newlines, collapses whitespace).
- Produces: `CAPTURE_BUFFER_DIR` (string), `bufferPath(sessionId, dir?)` → string, `toSignalRecord(signal)` → record, `appendSignal(sessionId, signal, { dir?, append?, mkdir? })` → `{ written: 0|1 }`, `readSignals(sessionId, { dir?, read?, exists? })` → record[]. Record shape: `{ tool, retained, dropped_count, preserved, ccr_hash }` where `preserved` is `[{ index, kind }]` derived from compress()'s **flat string** `verdicts` array (the non-`droppable` entries with their original index); `ccr_hash` is set FROM the envelope's `originalHash`.
- **Verified contract (do not deviate):** compress() returns `verdicts: string[]` (`smart-crusher.js:359`), each element `'error'|'boundary'|'anomaly'|'droppable'` indexed by ORIGINAL row position (`smart-crusher.js:175-186`); the router passes it through unchanged (`posttooluse-content-router.js:124`). The record stores the PRESERVED kinds (error/anomaly/boundary) + their indices — that is the AC-5b containment evidence the section renders.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { appendSignal, readSignals, toSignalRecord, CAPTURE_BUFFER_DIR } =
  require('../lib/capture-buffer.js');

// NOTE the REAL shapes, verified against compress() (smart-crusher.js:359 `verdicts: string[]`,
// :175-186 plain strings indexed by ORIGINAL row position): `verdicts` is a FLAT STRING ARRAY,
// not objects; `retained` is the kept-rows array. Fixtures MUST use the real shape or the
// containment test is tautological.
const SIGNAL = {
  tool: 'Bash',
  retained: [{ id: 1 }, { id: 2 }],
  dropped_count: 7,
  verdicts: ['error', 'droppable', 'boundary', 'anomaly'], // flat strings, index = original row
  originalHash: 'abc123', // envelope field; record key is ccr_hash
};

test('toSignalRecord maps originalHash → ccr_hash and a retained SUMMARY (not raw rows)', () => {
  const r = toSignalRecord(SIGNAL);
  assert.equal(r.tool, 'Bash');
  assert.equal(r.ccr_hash, 'abc123');
  assert.equal(r.dropped_count, 7);
  assert.equal(typeof r.retained, 'string'); // a summary string, never the raw row array
  assert.ok(Array.isArray(r.preserved)); // preserved = the non-droppable verdicts + their indices
});

test('toSignalRecord captures the PRESERVED verdicts (error/anomaly/boundary) with indices, AC-5b', () => {
  const r = toSignalRecord(SIGNAL);
  // index 1 is 'droppable' → excluded; indices 0/2/3 are error/boundary/anomaly → preserved.
  assert.deepEqual(r.preserved, [
    { index: 0, kind: 'error' },
    { index: 2, kind: 'boundary' },
    { index: 3, kind: 'anomaly' },
  ]);
});

test('append then read round-trips one record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capbuf-'));
  try {
    assert.deepEqual(appendSignal('sess-1', SIGNAL, { dir }), { written: 1 });
    const got = readSignals('sess-1', { dir });
    assert.equal(got.length, 1);
    assert.equal(got[0].ccr_hash, 'abc123');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('identical signal ⇒ byte-identical line (determinism, AC-5c.1)', () => {
  const a = JSON.stringify(toSignalRecord(SIGNAL));
  const b = JSON.stringify(toSignalRecord(SIGNAL));
  assert.equal(a, b);
});

test('a write error never throws — returns { written: 0 }', () => {
  const boom = () => { throw new Error('disk full'); };
  assert.deepEqual(appendSignal('s', SIGNAL, { dir: '/x', append: boom }), { written: 0 });
});

test('CAPTURE_BUFFER_DIR is a sibling of capture-queue (indexer-excluded)', () => {
  assert.ok(CAPTURE_BUFFER_DIR.endsWith(join('.claude-data', 'capture-buffer')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hooks && node --test test/capture-buffer.test.js`
Expected: FAIL — `Cannot find module '../lib/capture-buffer.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';

/**
 * capture-buffer.js — the FR-B5 tool-signal buffer (DIO-18 producer storage).
 *
 * Mirrors lib/findings-buffer.js, but for a DIFFERENT signal: the compressed
 * tool-output SIGNAL SUMMARY, not acted-on graph findings. Kept as a separate
 * buffer (separate dir, separate record shape) so findings-buffer's AC-4 proof
 * stays single-shape (PRD ID-1).
 *
 * AC-4 / no-write-back: CAPTURE_BUFFER_DIR is a sibling of capture-queue/ under
 * ~/.claude-data — outside the four indexed subtrees, so the observations indexer's
 * classify() returns null for it. A buffer line can NEVER become an observations row.
 *
 * Determinism (AC-5c.1): the record is a pure function of its inputs. No Date.now()/
 * Math.random() participates — replaying the same signal yields a byte-identical line.
 *
 * Field name: the ticket's contract key is `ccr_hash`; the live envelope field is
 * `originalHash` (smart-crusher / buildCompressedEnvelope). toSignalRecord maps
 * originalHash → ccr_hash so the buffer honors the ticket's contract name.
 */

const { appendFileSync, mkdirSync, existsSync, readFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { homedir } = require('node:os');
const { safeString } = require('./observation.js');

// Sibling of capture-queue/ — same indexer-excluded class. NEVER under episodes/,
// context/, projects/, or agent/ (the only indexed subtrees).
const CAPTURE_BUFFER_DIR = join(homedir(), '.claude-data', 'capture-buffer');

function safeId(sessionId) {
  return (String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '') || 'noid').slice(0, 64);
}

function bufferPath(sessionId, dir = CAPTURE_BUFFER_DIR) {
  return join(dir, safeId(sessionId) + '.jsonl');
}

// A compact, deterministic summary of the retained rows — count + tool, never the
// raw row array (signal, not dump). safeString guarantees no newline can break JSONL.
function retainedSummary(signal) {
  const n = Array.isArray(signal.retained) ? signal.retained.length : 0;
  return safeString(`${n} retained`, 200);
}

// The preservation set (AC-5b): compress()'s verdicts is a FLAT STRING ARRAY indexed by
// original row position (smart-crusher.js:359, :175-186). The non-`droppable` entries are
// the error/anomaly/boundary rows the preserve-first rule kept; we record each kind WITH its
// original index so the episode section can name exactly which rows were preserved and why.
// This is the containment evidence — counts alone would NOT satisfy US-6.
const PRESERVED_KINDS = new Set(['error', 'anomaly', 'boundary']);
function preservedVerdicts(signal) {
  const v = Array.isArray(signal.verdicts) ? signal.verdicts : [];
  const out = [];
  for (let i = 0; i < v.length; i++) {
    const kind = safeString(v[i], 32);
    if (PRESERVED_KINDS.has(kind)) out.push({ index: i, kind });
  }
  return out;
}

function toSignalRecord(signal) {
  const s = signal && typeof signal === 'object' ? signal : {};
  return {
    tool: safeString(s.tool, 128),
    retained: retainedSummary(s),
    dropped_count: Number.isFinite(s.dropped_count) ? s.dropped_count : 0,
    // AC-5b: the preserved (non-droppable) verdict kinds + their original indices, derived
    // from compress()'s flat string `verdicts` array — the containment evidence.
    preserved: preservedVerdicts(s),
    // ticket contract key `ccr_hash` ← live envelope field `originalHash`.
    ccr_hash: safeString(s.originalHash, 128),
  };
}

function appendSignal(
  sessionId,
  signal,
  { dir = CAPTURE_BUFFER_DIR, append = appendFileSync, mkdir = mkdirSync } = {},
) {
  const rec = toSignalRecord(signal);
  const path = bufferPath(sessionId, dir);
  try {
    mkdir(dirname(path), { recursive: true });
    append(path, JSON.stringify(rec) + '\n', 'utf8');
    return { written: 1 };
  } catch {
    return { written: 0 }; // a buffer write can never crash the tool call
  }
}

function readSignals(
  sessionId,
  { dir = CAPTURE_BUFFER_DIR, read = readFileSync, exists = existsSync } = {},
) {
  const path = bufferPath(sessionId, dir);
  if (!exists(path)) return [];
  let raw;
  try { raw = read(path, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip malformed line */ }
  }
  return out;
}

module.exports = {
  CAPTURE_BUFFER_DIR,
  bufferPath,
  toSignalRecord,
  appendSignal,
  readSignals,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hooks && node --test test/capture-buffer.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/capture-buffer.js hooks/test/capture-buffer.test.js
git commit -m "feat(fr-b5): capture-buffer module (indexer-excluded, deterministic)"
```

---

### Task 3: Wire the producer side-effect into the PostToolUse router

**Files:**
- Modify: `hooks/posttooluse-content-router.js` (add a `captureSignal` export + call it in `main()` after `route()`)
- Test: `hooks/test/posttooluse-capture.test.js`

**Interfaces:**
- Consumes: `isArmed` from `./lib/fr-b5-flag.js`; `appendSignal` from `./lib/capture-buffer.js`; `skipFlags`, `buildCompressedEnvelope` (already exported from the router); `compress` result fields via the envelope.
- Produces: `captureSignal(input, payload, { isArmedFn?, append?, env?, sessionId? })` → `{ written: 0|1 }` — exported and unit-tested in isolation. The router's `route()` return contract is UNCHANGED (the freeze); capture is a `main()` side-effect only.

**Design note (read before implementing):** the router is a stdout-only transform — `route()` returns fields, it does not persist. The freeze in `docs/dioscuri-content-router-seam.md` is on `route()` / the handler interface. Capture is therefore NOT a handler and does NOT change `route()`; it is a separate, fail-safe side-effect performed by `main()` AFTER `route()` returns, gated by the flag and the skip. A handler stays a pure function returning fields; only `main()` gains the write.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { captureSignal } = require('../posttooluse-content-router.js');

// A payload whose compressor envelope is present (compress claimed the result).
// verdicts is the REAL flat string array compress() emits (smart-crusher.js:359).
const ENVELOPE = JSON.stringify({
  _dioscuri: { compressed: true, originalHash: 'h1', droppedCount: 4,
    verdicts: ['error', 'droppable'] },
  constants: {}, retained: [{ a: 1 }],
});
const PAYLOAD = { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: ENVELOPE } };
const INPUT = { toolName: 'Bash', toolInput: {}, toolResponse: '[{"a":1}]' };

test('flag OFF ⇒ no capture (default; byte-identical reversibility)', () => {
  let appended = 0;
  const res = captureSignal(INPUT, PAYLOAD, {
    isArmedFn: () => false, append: () => { appended++; return undefined; },
    sessionId: 's', env: {},
  });
  assert.deepEqual(res, { written: 0 });
  assert.equal(appended, 0);
});

test('flag ON + compressed envelope ⇒ one buffer line', () => {
  let appended = 0;
  const res = captureSignal(INPUT, PAYLOAD, {
    isArmedFn: () => true, append: () => { appended++; return undefined; },
    sessionId: 's', env: {},
  });
  assert.deepEqual(res, { written: 1 });
  assert.equal(appended, 1);
});

test('flag ON but compress skipped ⇒ no capture', () => {
  let appended = 0;
  const res = captureSignal(INPUT, PAYLOAD, {
    isArmedFn: () => true, append: () => { appended++; return undefined; },
    sessionId: 's', env: { DIOSCURI_SKIP_COMPRESS: '1' },
  });
  assert.deepEqual(res, { written: 0 });
  assert.equal(appended, 0);
});

test('flag ON but no compressed envelope (raw passthrough) ⇒ no capture', () => {
  let appended = 0;
  const rawPayload = { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: '[{"a":1}]' } };
  const res = captureSignal(INPUT, rawPayload, {
    isArmedFn: () => true, append: () => { appended++; return undefined; },
    sessionId: 's', env: {},
  });
  assert.deepEqual(res, { written: 0 });
  assert.equal(appended, 0);
});

test('a capture error never throws', () => {
  const res = captureSignal(INPUT, PAYLOAD, {
    isArmedFn: () => true, append: () => { throw new Error('boom'); },
    sessionId: 's', env: {},
  });
  assert.deepEqual(res, { written: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hooks && node --test test/posttooluse-capture.test.js`
Expected: FAIL — `captureSignal is not a function` (not yet exported).

- [ ] **Step 3: Write minimal implementation**

At the top of `hooks/posttooluse-content-router.js`, add the requires (after the existing requires on lines 3-4):

```js
const { isArmed } = require('./lib/fr-b5-flag.js');
const { appendSignal } = require('./lib/capture-buffer.js');
```

Add the `captureSignal` function (place it just before `normalizeInput`, ~line 262):

```js
/**
 * FR-B5 producer side-effect (DIO-18). NOT a handler and NOT part of the frozen
 * route() contract — a fail-safe write main() performs AFTER route(), gated by the
 * file-sentinel flag and the per-call compress skip. When the flag is OFF (default),
 * compress was skipped, or route() produced no compressed envelope, this is a no-op
 * → byte-identical reversibility. Errors are swallowed: capture must never break a
 * tool call.
 *
 * It parses the envelope route() already built (updatedToolOutput) to recover the
 * compressed signal — it does NOT re-run compress(), so producer and transform stay
 * in lockstep on one compression result.
 */
function captureSignal(
  input,
  payload,
  { isArmedFn = isArmed, append, env = process.env, sessionId } = {},
) {
  try {
    if (!isArmedFn('fr_b5_capture')) return { written: 0 };
    if (skipFlags(input, env).skipCompress) return { written: 0 };
    const out = payload && payload.hookSpecificOutput;
    if (!out || typeof out.updatedToolOutput !== 'string') return { written: 0 };

    let env_;
    try { env_ = JSON.parse(out.updatedToolOutput); } catch { return { written: 0 }; }
    const d = env_ && env_._dioscuri;
    if (!d || d.compressed !== true) return { written: 0 }; // raw passthrough → nothing to capture

    const signal = {
      tool: input && input.toolName,
      retained: env_.retained,
      dropped_count: d.droppedCount,
      verdicts: d.verdicts,
      originalHash: d.originalHash,
    };
    const opts = append ? { append } : {};
    return appendSignal(sessionId || 'noid', signal, opts);
  } catch {
    return { written: 0 }; // capture never breaks the tool call
  }
}
```

In `main()`, after `payload = route(normalized);` succeeds and before `if (payload)` writes stdout (~line 294), add the capture side-effect. First decode the session id from the raw input (it is on the wire payload as `session_id`):

```js
  // FR-B5 capture side-effect — never affects stdout / the tool result. Gated by the
  // flag sentinel; a no-op when OFF (default). Wrapped so it can never break the call.
  if (payload) {
    let sid;
    try { sid = JSON.parse(input).session_id; } catch { sid = undefined; }
    try { captureSignal(normalized, payload, { sessionId: sid }); } catch { /* never break the call */ }
  }
```

Add `captureSignal` to `module.exports`:

```js
module.exports = {
  isJsonToolResponse,
  parseJsonResponse,
  buildCompressedEnvelope,
  minimalJsonHandler,
  enrichHandler,
  HANDLERS,
  skipFlags,
  route,
  captureSignal,
  normalizeInput,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hooks && node --test test/posttooluse-capture.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Run the EXISTING router test to prove the freeze held**

Run: `cd hooks && node --test test/posttooluse-content-router.test.js`
Expected: PASS — the existing seam/prefix-stability tests still pass (route() unchanged).

- [ ] **Step 6: Commit**

```bash
git add hooks/posttooluse-content-router.js hooks/test/posttooluse-capture.test.js
git commit -m "feat(fr-b5): producer side-effect in router main() (flag-gated, fail-safe)"
```

---

### Task 4: Consumer — `## Tool signals` section in the episode worker

**Files:**
- Modify: `hooks/session-observer-worker.js` (`buildEpisodeContent` — add the section; add a `toolSignals` arg)
- Test: `hooks/test/session-observer-tool-signals.test.js`

**Interfaces:**
- Consumes: `readSignals` from `./lib/capture-buffer.js`; `isArmed` from `./lib/fr-b5-flag.js`.
- Produces: `buildEpisodeContent(obs, sessionId, turnCount, toolSignals)` — a new 4th param `toolSignals` (default `[]`). When non-empty, appends a `## Tool signals` section AFTER `## Files of note`, built DIRECTLY from the records (not via `summarize()`). Empty/absent ⇒ no section ⇒ byte-identical to pre-feature.

**Design note:** `buildEpisodeContent` currently takes `(obs, sessionId, turnCount)`. Adding `toolSignals = []` as a trailing optional param keeps every existing caller byte-identical (no caller passes a 4th arg yet → `[]` → no section). The worker's `main()` will pass the real signals only when armed; that wiring is Step 6.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildEpisodeContent } = require('../session-observer-worker.js');

const OBS = { summary: 'did things', decisions: [], corrections: [], discoveries: [], files_of_note: [] };

test('no toolSignals ⇒ byte-identical to the 3-arg call (reversibility)', () => {
  const a = buildEpisodeContent(OBS, 'sess', 5);
  const b = buildEpisodeContent(OBS, 'sess', 5, []);
  assert.equal(a, b);
  assert.ok(!a.includes('## Tool signals'));
});

// Records use the REAL shape toSignalRecord produces: `preserved` = [{index,kind}] of the
// non-droppable verdicts, derived from compress()'s flat string array. (NOT a `verdicts`
// field of {index,kind} objects — that shape does not exist; using it here would be a
// tautological fixture that hides the real contract.)
test('toolSignals present ⇒ a "## Tool signals" section is appended', () => {
  const signals = [
    { tool: 'Bash', retained: '2 retained', dropped_count: 7,
      preserved: [{ index: 0, kind: 'error' }], ccr_hash: 'h1' },
  ];
  const out = buildEpisodeContent(OBS, 'sess', 5, signals);
  assert.ok(out.includes('## Tool signals'));
  assert.ok(out.includes('Bash'));
  assert.ok(out.includes('h1'));     // ccr_hash retrievability marker present
  assert.ok(out.includes('7'));      // dropped_count surfaced
});

test('AC-5b containment: a preserved error verdict (with its index) appears in the section', () => {
  const signals = [
    { tool: 'Bash', retained: '1 retained', dropped_count: 0,
      preserved: [{ index: 3, kind: 'error' }], ccr_hash: 'h2' },
  ];
  const out = buildEpisodeContent(OBS, 'sess', 5, signals);
  const section = out.slice(out.indexOf('## Tool signals'));
  assert.ok(section.includes('error'));  // preserved error kind ⊆ section
  assert.ok(section.includes('3'));      // its original row index is named ⇒ row identifiable
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hooks && node --test test/session-observer-tool-signals.test.js`
Expected: FAIL — the second/third tests fail (no `## Tool signals` section); the first passes vacuously.

- [ ] **Step 3: Write minimal implementation**

In `hooks/session-observer-worker.js`, change the `buildEpisodeContent` signature (line 108) and append the new section after the `files_of_note` block (after line 136, before `return`):

```js
function buildEpisodeContent(obs, sessionId, turnCount, toolSignals = []) {
```

After the existing `if (obs.files_of_note.length) ...` push (line 135-136), add:

```js
  // FR-B5 (DIO-18): the "## Tool signals" section is built DIRECTLY from the capture
  // buffer records (NOT via summarize()). Empty ⇒ omitted ⇒ byte-identical to pre-feature,
  // mirroring the conditional-section pattern above.
  if (Array.isArray(toolSignals) && toolSignals.length) {
    const lines = toolSignals.map((s) => {
      // AC-5b containment: render each PRESERVED verdict as `kind@index` so the section
      // names exactly which original rows were preserved and why. `preserved` is
      // [{index,kind}] from toSignalRecord (derived from compress()'s flat string verdicts).
      const preserved = Array.isArray(s.preserved)
        ? s.preserved.map((p) => `${p.kind}@${p.index}`).filter(Boolean).join(',')
        : '';
      // ccr_hash is the CCR retrieve marker (AC-1); dropped_count + preserved kinds are the signal.
      return `- \`${s.tool}\` — ${s.retained}, ${s.dropped_count} dropped` +
why_suffix(preserved, s.ccr_hash);
    });
    sections.push('## Tool signals\n' + lines.join('\n'));
  }
```

Add the small helper `why_suffix` just above `buildEpisodeContent` (so the line builder stays readable and the verdict kinds + hash are always present for AC-5b/AC-1):

```js
// Render the preserved verdicts (a `kind@index,kind@index` string) and the CCR retrieve
// hash onto a tool-signal line. Kept pure (no clock/random) for determinism.
function why_suffix(preserved, ccrHash) {
  const k = preserved ? ` [${preserved}]` : '';
  const h = ccrHash ? ` (ccr=${ccrHash})` : '';
  return k + h;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hooks && node --test test/session-observer-tool-signals.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Run the existing worker tests to prove no regression**

Run: `cd hooks && node --test test/session-observer-worker.test.js`
Expected: PASS — existing episode-building tests unchanged (every existing call still passes 3 args → `[]` → no section).

- [ ] **Step 6: Wire `main()` to read the buffer when armed**

In `main()`, just before the `buildEpisodeContent(...)` call (the episode is assembled around line 192-196 after `obs` is ready), read the buffer only when armed, then pass it. Add the requires at the top (after line 11):

```js
const { readSignals } = require('./lib/capture-buffer.js');
const { isArmed } = require('./lib/fr-b5-flag.js');
```

At the call site, FIRST add the `toolSignals` read on the line BEFORE the existing
`const content = ...` line. The real call site (session-observer-worker.js:200) is:

```js
const content = preservePromoted(existingRaw, buildEpisodeContent(obs, sessionId, turns.length));
```

`content` is the OUTPUT of `preservePromoted(existingRaw, …)`, NOT of `buildEpisodeContent`
directly — `preservePromoted` (session-observer-worker.js:86-91) carries an already-promoted
episode's `promoted: true` forward on re-summarization. You MUST keep that wrapper: replace
ONLY the inner `buildEpisodeContent(...)` argument, adding `toolSignals`. Do NOT collapse the
wrapper away (dropping it silently reverts promoted episodes to `promoted: false` — a data
regression).

Add the read above it, then edit the inner argument in place:

```js
  // FR-B5: read the tool-signal buffer ONLY when armed; OFF (default) ⇒ [] ⇒ no section
  // ⇒ byte-identical episode. Read is fail-safe ([] on any error).
  const toolSignals = isArmed('fr_b5_capture') ? readSignals(sessionId) : [];
  const content = preservePromoted(
    existingRaw,
    buildEpisodeContent(obs, sessionId, turns.length, toolSignals),
  );
```

(The `preservePromoted(existingRaw, …)` wrapper is PRESERVED verbatim; only the inner
`buildEpisodeContent` call gains the 4th `toolSignals` arg. Verify `existingRaw` is the same
variable the original line 200 used — it is read just above the call site.)

- [ ] **Step 7: Run the full hooks test suite**

Run: `cd hooks && node --test`
Expected: PASS — all hook tests green, including the existing worker and router suites.

- [ ] **Step 8: Commit**

```bash
git add hooks/session-observer-worker.js hooks/test/session-observer-tool-signals.test.js
git commit -m "feat(fr-b5): consumer writes ## Tool signals section (armed-only, direct)"
```

---

### Task 5: Reversibility + no-write-back proof (the load-bearing guarantees)

**Files:**
- Test: `hooks/test/fr-b5-reversibility.test.js`
- (No production change — this task locks the AC-5c.2 byte-identical and AC-4 no-write-back invariants with explicit tests.)

**Interfaces:**
- Consumes: `buildEpisodeContent` (`session-observer-worker.js`); `CAPTURE_BUFFER_DIR` (`capture-buffer.js`); the indexer `classify()` if reachable from a hook test, else assert by path-shape.

**Design note:** `classify()` lives in the MCP (TypeScript) layer and is not importable from a CommonJS hook test. Prove AC-4 structurally: assert `CAPTURE_BUFFER_DIR` is NOT under any of the four indexed subtrees (`agent/`, `context/`, `projects/`, `episodes/`) — the same structural argument `findings-buffer.js` relies on. The DB-level `COUNT(*) ... capture-buffer = 0` assertion is covered by the existing MCP indexer test surface (note it in the commit; do not duplicate the TS test from a JS hook).

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { join } = require('node:path');
const { buildEpisodeContent } = require('../session-observer-worker.js');
const { CAPTURE_BUFFER_DIR } = require('../lib/capture-buffer.js');

const OBS = { summary: 's', decisions: ['d1'], corrections: [], discoveries: [], files_of_note: [] };

// A FROZEN golden snapshot of the pre-feature episode bytes for OBS — captured from the
// 3-arg builder BEFORE this feature existed. Comparing the OFF path to this literal (not to
// another call of the same new code) is what makes the test non-tautological: if any task
// regresses the OFF path's bytes, this literal no longer matches. If buildEpisodeContent's
// pre-existing format legitimately changes for another reason, update this snapshot deliberately.
// Byte-exact trace of buildEpisodeContent(OBS,'sess',4): fmLines.join('\n') ends with
// "...promoted: false\n---\n" (the trailing '' element yields exactly ONE \n after ---,
// NO blank line), then sections.join('\n\n') = "## Summary\ns\n\n## Decisions\n- d1",
// then a final '\n'. (session-observer-worker.js:111-138.)
const PRE_FEATURE_GOLDEN =
  '---\n' +
  'date: ' + require('../lib/episode-utils.js').todayLocal() + '\n' +
  'session_id: sess\n' +
  'turns: 4\n' +
  'promoted: false\n' +
  '---\n' +
  '## Summary\n' +
  's\n' +
  '\n' +
  '## Decisions\n' +
  '- d1\n';

test('AC-5c.2: flag-off path (no signals) is byte-identical to the FROZEN pre-feature golden', () => {
  // OFF path = no toolSignals. Must equal the frozen pre-feature bytes, AND equal the
  // 3-arg call (proving the new default param is inert).
  const offPath = buildEpisodeContent(OBS, 'sess', 4, []);
  assert.equal(offPath, PRE_FEATURE_GOLDEN);          // non-tautological: vs frozen literal
  assert.equal(offPath, buildEpisodeContent(OBS, 'sess', 4)); // 4th-arg default is inert
});

test('AC-5c.2 negative control: the golden has NO Tool signals section', () => {
  assert.ok(!PRE_FEATURE_GOLDEN.includes('## Tool signals'));
});

test('AC-4: CAPTURE_BUFFER_DIR is outside every indexed subtree', () => {
  const indexed = ['agent', 'context', 'projects', 'episodes'].map((s) => join('.claude-data', s));
  for (const sub of indexed) {
    assert.ok(!CAPTURE_BUFFER_DIR.includes(sub),
      `capture-buffer must not be under ${sub}`);
  }
  assert.ok(CAPTURE_BUFFER_DIR.endsWith(join('.claude-data', 'capture-buffer')));
});
```

- [ ] **Step 2: Run test to verify it fails or passes correctly**

Run: `cd hooks && node --test test/fr-b5-reversibility.test.js`
Expected: PASS (these assert invariants already built in Tasks 2 & 4). If the byte-identical test FAILS, a prior task regressed the OFF path — fix that task before proceeding (this test is the guard that catches it).

- [ ] **Step 3: Run the full hooks suite once more**

Run: `cd hooks && node --test`
Expected: PASS — all green.

- [ ] **Step 4: Commit**

```bash
git add hooks/test/fr-b5-reversibility.test.js
git commit -m "test(fr-b5): lock byte-identical-when-off + indexer-exclusion invariants"
```

---

### Task 6: Document the flag-routing rule (ID-5)

**Files:**
- Modify: `README.md` (the hooks/flags section) OR `docs/dioscuri-content-router-seam.md` — wherever flags are described; add the two-mechanism routing rule.

**Interfaces:** none (docs only).

- [ ] **Step 1: Locate where flags are documented**

Run: `cd .. ; grep -rn "c2_chunking_enabled" README.md docs/ | head` (find the existing flag prose).
Expected: at least one hit naming `c2_chunking_enabled`.

- [ ] **Step 2: Add the routing-rule note**

Add this paragraph near the existing flag description:

```markdown
**Flag-storage routing rule.** Two flag mechanisms exist by design. Consumers that
already open the MCP SQLite DB (the indexer) read flags from the `meta` table
(e.g. `c2_chunking_enabled`). Consumers in the **hooks** layer cannot open
`better-sqlite3` (no `hooks/package.json` / `node_modules`), so they read **file
sentinels** under `~/.claude-data/flags/` (e.g. the FR-B5 `fr_b5_capture` flag).
Rule: DB-open consumers → meta table; hook consumers → file flags. An absent
sentinel means OFF.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/dioscuri-content-router-seam.md
git commit -m "docs(fr-b5): document the meta-table vs file-flag routing rule"
```

---

## Self-Review

**1. Spec coverage** (PRD → task):
- US-1 producer line → Task 3 (+ Task 2 storage). US-2 indexer-excluded/no-write-back → Task 2 + Task 5. US-3 determinism → Task 2 (byte-identical record test). US-4 `## Tool signals` section → Task 4. US-5 two-inputs-one-worker decoupled → Task 4 Step 6 (buffer read in `main()`). US-6 AC-5b containment → Task 4 (error-verdict-in-section test). US-7 default-OFF byte-identical → Task 1 (flag) + Task 4 (default `[]`) + Task 5 (explicit guard). US-8 arming/disarming reversible → Task 1 (file sentinel; absence=off). US-9 per-call skip → Task 3 (skipCompress test). US-10 no new write-back → Task 5. ID-1 separate buffer → Task 2. ID-2 router side-effect not handler → Task 3 design note. ID-4 file sentinel → Task 1. ID-5 routing rule → Task 6. ID-6 two boundaries → Task 5 note. ID-7 determinism → Tasks 2/4 (pure builders). ID-8 arming writes sentinel/no reindex → out of scope (correctly not built). **No gaps.**

**2. Placeholder scan:** every code step contains real code; every run step names the exact command + expected result. No TBD/TODO. ✅

**3. Type consistency:** `isArmed(name, opts)` used identically in Tasks 1/3/4. `appendSignal(sessionId, signal, opts)` / `readSignals(sessionId, opts)` consistent Tasks 2/3/4. Record key `ccr_hash` (from `originalHash`) consistent Tasks 2/3/4. `buildEpisodeContent(obs, sessionId, turnCount, toolSignals=[])` consistent Tasks 4/5. **VERIFIED REAL SHAPES:** compress()'s `verdicts` is a FLAT STRING ARRAY (`smart-crusher.js:359`, `:175-186`), index = original row position — NOT `{index,kind}` objects. The producer passes that flat array through (`d.verdicts`); `toSignalRecord` derives `preserved: [{index,kind}]` from it (the non-`droppable` entries with their index); the consumer renders `preserved` as `kind@index`. Fixtures use the flat-string shape so the AC-5b containment test is non-tautological. The reversibility test compares the OFF path to a FROZEN pre-feature golden literal (not to another call of the new builder). ✅

**Out of scope (not built):** arming flip (#72), DIO-19 fidelity harness (#59), eval re-baseline run, any `compress()` change.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-24-dio18-fr-b5-capture-path.md`.** Next gate (per make-it-so): **Gate 2 — red-blue-judge (mode: plan)** against this plan with the approved PRD + codebase as ground truth, before any execution.
