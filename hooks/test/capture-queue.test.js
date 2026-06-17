'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, rmSync, existsSync, readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { tailHash, shouldSummarize, createCaptureQueue } = require('../lib/capture-queue.js');

const TMP = join(tmpdir(), `capture-queue-test-${process.pid}`);
const Q = join(TMP, 'queue');
const DL = join(TMP, 'dead');
before(() => mkdirSync(TMP, { recursive: true }));
after(() => rmSync(TMP, { recursive: true, force: true }));
const q = () => createCaptureQueue({ queueDir: Q, deadLetterDir: DL });

test('shouldSummarize: first attempt (no prior success) -> true', () => {
  const rec = { turnsAtLastSuccess: null, tailHashAtLastSuccess: null };
  assert.equal(shouldSummarize(rec, 5, 'h1', { stride: 10 }), true);
});
test('shouldSummarize: grown < stride AND same hash -> false', () => {
  const rec = { turnsAtLastSuccess: 10, tailHashAtLastSuccess: 'h1' };
  assert.equal(shouldSummarize(rec, 15, 'h1', { stride: 10 }), false);
});
test('shouldSummarize: grown >= stride -> true', () => {
  const rec = { turnsAtLastSuccess: 10, tailHashAtLastSuccess: 'h1' };
  assert.equal(shouldSummarize(rec, 20, 'h1', { stride: 10 }), true);
});
test('shouldSummarize: hash changed (even under stride) -> true', () => {
  const rec = { turnsAtLastSuccess: 10, tailHashAtLastSuccess: 'h1' };
  assert.equal(shouldSummarize(rec, 12, 'h2', { stride: 10 }), true);
});

test('upsert creates a durable record atomically; get reads it', () => {
  const rec = q().upsert('sess-1', { transcriptPath: '/t/x.jsonl', turnCount: 4 });
  assert.equal(rec.sessionId, 'sess-1');
  assert.equal(rec.attempts, 0);
  assert.ok(rec.firstSeenDate);
  assert.ok(!readdirSync(Q).some(f => f.endsWith('.tmp')), 'no .tmp left behind');
  assert.equal(q().get('sess-1').transcriptPath, '/t/x.jsonl');
});

test('markSuccess records turns+hash and clears error', () => {
  q().upsert('sess-2', { transcriptPath: '/t/y.jsonl', turnCount: 6 });
  q().markSuccess('sess-2', { turnCount: 6, tailHash: 'hh' });
  const r = q().get('sess-2');
  assert.equal(r.turnsAtLastSuccess, 6);
  assert.equal(r.tailHashAtLastSuccess, 'hh');
  assert.equal(r.lastErrorClass, null);
});

test('recordFailure increments attempts; dead-letters at cap', () => {
  q().upsert('sess-3', { transcriptPath: '/t/z.jsonl', turnCount: 3 });
  assert.equal(q().recordFailure('sess-3', 'TIMEOUT', { attemptCap: 3 }).deadLettered, false);
  assert.equal(q().recordFailure('sess-3', 'TIMEOUT', { attemptCap: 3 }).deadLettered, false);
  const third = q().recordFailure('sess-3', 'TIMEOUT', { attemptCap: 3 });
  assert.equal(third.deadLettered, true);
  assert.equal(q().get('sess-3'), null, 'record removed from queue after dead-letter');
  assert.equal(existsSync(join(DL, 'sess-3.json')), true);
});

test('deadLetter moves record with a reason; deadLetterStats counts it', () => {
  q().upsert('sess-4', { transcriptPath: '/gone.jsonl', turnCount: 3 });
  q().deadLetter('sess-4', 'transcript missing');
  const stats = q().deadLetterStats();
  assert.ok(stats.count >= 1);
  assert.ok(stats.oldest);
});

test('depth counts live records only', () => {
  const before = q().depth();
  q().upsert('sess-5', { transcriptPath: '/t/a.jsonl', turnCount: 3 });
  assert.equal(q().depth(), before + 1);
});
