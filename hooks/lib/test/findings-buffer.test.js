'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, rmSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir, homedir } = require('node:os');

const {
  FINDINGS_BUFFER_DIR,
  bufferPath,
  toRecord,
  appendFindings,
  readFindings,
} = require('../findings-buffer.js');

const TMP = join(tmpdir(), `findings-buffer-test-${process.pid}`);
const DIR = join(TMP, 'buffer');
before(() => mkdirSync(TMP, { recursive: true }));
after(() => rmSync(TMP, { recursive: true, force: true }));

// ── AC-4: the buffer is structurally OUTSIDE the indexed surface ──────────────

test('AC-4 PATH: the buffer dir is a sibling of capture-queue under ~/.claude-data (indexer-excluded)', () => {
  // The indexer (mcp/src/indexer.ts classify()) only indexes agent/, context/,
  // projects/, episodes/. A findings-buffer/ sibling can never become an
  // observations row — the AC-4 guarantee is the path position, not prose.
  assert.equal(FINDINGS_BUFFER_DIR, join(homedir(), '.claude-data', 'findings-buffer'));
  assert.ok(!FINDINGS_BUFFER_DIR.includes(`${require('node:path').sep}episodes${require('node:path').sep}`));
  assert.ok(!FINDINGS_BUFFER_DIR.endsWith('episodes'));
});

// ── AC-4: every record is promoted:false, never caller-overridable ────────────

test('AC-4 PROMOTED: toRecord always stamps promoted:false', () => {
  const r = toRecord({ finding_id: 'f1', summary: 's', acted_on: true });
  assert.equal(r.promoted, false);
});

test('AC-4 PROMOTED: a finding asking for promoted:true is still written promoted:false', () => {
  // The hard invariant — no caller can produce a promoted:true buffer record.
  const r = toRecord({ finding_id: 'evil', summary: 's', acted_on: true, promoted: true });
  assert.equal(r.promoted, false);
});

test('AC-4 PROMOTED: every appended line is promoted:false on disk', () => {
  const sid = 'sess-ac4';
  appendFindings(sid, [
    { finding_id: 'a', summary: 'one', acted_on: true, promoted: true },
    { finding_id: 'b', summary: 'two', acted_on: true },
  ], { dir: DIR });
  const raw = readFileSync(bufferPath(sid, DIR), 'utf8');
  for (const line of raw.trim().split('\n')) {
    const rec = JSON.parse(line);
    assert.equal(rec.promoted, false, 'no buffer line may be promoted:true');
  }
  // Falsification: zero promoted:true records exist in the buffer.
  assert.equal(/"promoted":true/.test(raw), false);
});

// ── Records only ACTED-ON findings ────────────────────────────────────────────

test('appendFindings writes ONLY findings actually acted on', () => {
  const sid = 'sess-acted';
  const res = appendFindings(sid, [
    { finding_id: 'acted', summary: 'did this', acted_on: true },
    { finding_id: 'ignored', summary: 'surfaced but not acted', acted_on: false },
    { finding_id: 'unmarked', summary: 'no flag' },
  ], { dir: DIR });
  assert.equal(res.written, 1);
  const recs = readFindings(sid, { dir: DIR });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].finding_id, 'acted');
});

test('appendFindings writes nothing for an empty / non-array input', () => {
  assert.equal(appendFindings('sess-empty', [], { dir: DIR }).written, 0);
  assert.equal(appendFindings('sess-empty', null, { dir: DIR }).written, 0);
  assert.equal(readFindings('sess-empty', { dir: DIR }).length, 0);
});

test('appendFindings writes nothing when no finding was acted on (no file churn)', () => {
  const res = appendFindings('sess-noact', [
    { finding_id: 'x', acted_on: false },
  ], { dir: DIR });
  assert.equal(res.written, 0);
  assert.equal(readFindings('sess-noact', { dir: DIR }).length, 0);
});

// ── Sanitization: no field can break the JSONL stream ─────────────────────────

test('toRecord single-lines fields (no newline can split the JSONL stream)', () => {
  const r = toRecord({
    finding_id: 'id\nwith\nnewlines',
    summary: 'a summary\n---\n## injected',
    call_path: ['sym\nA', 'sym\tB'],
    acted_on: true,
  });
  assert.ok(!r.finding_id.includes('\n'));
  assert.ok(!r.summary.includes('\n'));
  for (const p of r.call_path) assert.ok(!/[\n\t]/.test(p));
});

test('appendFindings produces one parseable JSONL line per acted-on record', () => {
  const sid = 'sess-jsonl';
  appendFindings(sid, [
    { finding_id: 'a', summary: 's1', acted_on: true },
    { finding_id: 'b', summary: 's2\nwith newline', acted_on: true },
  ], { dir: DIR });
  const lines = readFileSync(bufferPath(sid, DIR), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l));
});

// ── Determinism: same findings -> byte-identical lines ────────────────────────

test('DETERMINISM: the same acted-on findings produce byte-identical records', () => {
  const finding = { finding_id: 'det', summary: 'stable', call_path: ['x#y'], acted_on: true };
  const a = JSON.stringify(toRecord(finding));
  const b = JSON.stringify(toRecord(finding));
  assert.equal(a, b);
});

test('DETERMINISM: no wall-clock / random in the findings-buffer source', () => {
  const src = readFileSync(join(__dirname, '..', 'findings-buffer.js'), 'utf8');
  // Strip comments so a prose mention does not trip the guard (smart-crusher.test.js:52-53).
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/Date\.now\s*\(/.test(code), 'no Date.now() in the buffer');
  assert.ok(!/Math\.random\s*\(/.test(code), 'no Math.random() in the buffer');
  assert.ok(!/new\s+Date\s*\(/.test(code), 'no new Date() in the buffer');
});

// ── readFindings tolerance ────────────────────────────────────────────────────

test('readFindings returns [] for an absent buffer', () => {
  assert.deepEqual(readFindings('never-written', { dir: DIR }), []);
});

test('safeId-style sanitization keeps the buffer filename inside the dir', () => {
  const p = bufferPath('../../etc/evil', DIR);
  assert.ok(p.startsWith(DIR));
  assert.ok(!p.includes('..'));
});
