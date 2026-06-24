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
