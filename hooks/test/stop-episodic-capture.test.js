'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir, homedir } = require('node:os');

const {
  FINDINGS_ACTED_DIR,
  stagingPath,
  readStaged,
  captureSession,
} = require('../stop-episodic-capture.js');
const { bufferPath, readFindings } = require('../lib/findings-buffer.js');

const TMP = join(tmpdir(), `stop-capture-test-${process.pid}`);
const STAGE = join(TMP, 'staging');
const BUF = join(TMP, 'buffer');
before(() => mkdirSync(TMP, { recursive: true }));
after(() => rmSync(TMP, { recursive: true, force: true }));

function stage(sid, lines) {
  mkdirSync(STAGE, { recursive: true });
  writeFileSync(stagingPath(sid, STAGE), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

// ── Staging input lives off the indexed surface too ───────────────────────────

test('the staging dir is under ~/.claude-data, a sibling of capture-queue (indexer-excluded)', () => {
  assert.equal(FINDINGS_ACTED_DIR, join(homedir(), '.claude-data', 'findings-acted'));
});

// ── readStaged ────────────────────────────────────────────────────────────────

test('readStaged returns [] when nothing was staged (the common no-op case)', () => {
  assert.deepEqual(readStaged('no-stage', { dir: STAGE }), []);
});

test('readStaged parses staged JSONL and skips malformed lines', () => {
  const sid = 'stage-read';
  mkdirSync(STAGE, { recursive: true });
  writeFileSync(stagingPath(sid, STAGE), [
    JSON.stringify({ finding_id: 'ok', acted_on: true }),
    '{ broken',
    JSON.stringify({ finding_id: 'ok2', acted_on: true }),
  ].join('\n'), 'utf8');
  const staged = readStaged(sid, { dir: STAGE });
  assert.equal(staged.length, 2);
});

// ── captureSession — the Stop flush flow ──────────────────────────────────────

test('CAPTURE: staged acted-on findings are flushed into the promoted:false buffer', () => {
  const sid = 'cap-1';
  stage(sid, [
    { finding_id: 'f1', summary: 'acted on this', acted_on: true },
    { finding_id: 'f2', summary: 'not acted', acted_on: false },
  ]);

  captureSession(sid, { stagingDir: STAGE, bufferDir: BUF });

  const out = readFindings(sid, { dir: BUF });
  // Only the acted-on finding is captured, promoted:false.
  assert.equal(out.length, 1);
  assert.equal(out[0].finding_id, 'f1');
  assert.equal(out[0].promoted, false);
});

test('NO STAGED FINDINGS IS A CLEAN NO-OP (no buffer written)', () => {
  const sid = 'cap-noop';
  const res = captureSession(sid, { stagingDir: STAGE, bufferDir: BUF });
  assert.equal(res.written, 0);
  assert.ok(!existsSync(bufferPath(sid, BUF)));
});

test('CONSUME-ONCE: staging is cleared after a successful flush (no double-append)', () => {
  const sid = 'cap-clear';
  stage(sid, [{ finding_id: 'g', summary: 'once', acted_on: true }]);

  captureSession(sid, { stagingDir: STAGE, bufferDir: BUF });
  // Staging file removed.
  assert.ok(!existsSync(stagingPath(sid, STAGE)), 'staging is consumed once at Stop');

  // A re-fired Stop on the same session finds nothing staged → no second append.
  const second = captureSession(sid, { stagingDir: STAGE, bufferDir: BUF });
  assert.equal(second.written, 0);
  assert.equal(readFindings(sid, { dir: BUF }).length, 1, 'no double-append on a re-fired Stop');
});

// ── AC-4 falsification: no promoted-memory / observations write path ──────────

test('AC-4: captured records are promoted:false and the buffer is off the indexed surface', () => {
  const sid = 'cap-ac4';
  stage(sid, [{ finding_id: 'p', summary: 'x', acted_on: true, promoted: true }]);
  captureSession(sid, { stagingDir: STAGE, bufferDir: BUF });

  const raw = readFileSync(bufferPath(sid, BUF), 'utf8');
  // No promoted:true row reaches the buffer (the only surface this hook writes).
  assert.equal(/"promoted":true/.test(raw), false);
  // The buffer path is not under any indexed subtree (episodes/context/projects/agent).
  const sep = require('node:path').sep;
  for (const indexed of ['episodes', 'context', 'projects', 'agent']) {
    assert.ok(!bufferPath(sid, BUF).includes(`${sep}${indexed}${sep}`));
  }
});

// ── Determinism ───────────────────────────────────────────────────────────────

test('DETERMINISM: no wall-clock / random in the stop-capture hook source', () => {
  const src = readFileSync(join(__dirname, '..', 'stop-episodic-capture.js'), 'utf8');
  // Strip comments so a mention in prose does not trip the guard (project convention,
  // smart-crusher.test.js:52-53).
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/Date\.now\s*\(/.test(code), 'no Date.now() in the stop-capture hook');
  assert.ok(!/Math\.random\s*\(/.test(code), 'no Math.random() in the stop-capture hook');
  assert.ok(!/new\s+Date\s*\(/.test(code), 'no new Date() in the stop-capture hook');
});
