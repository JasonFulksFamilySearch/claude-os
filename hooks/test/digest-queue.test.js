'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const { appendDigestEntry } = require('../digest-queue-write.js');
const { acquireLock, releaseLock, deliverAndClearQueue, LOCK_TTL_MS } = require('../digest-queue-deliver.js');

const TMP = join(tmpdir(), `digest-queue-test-${process.pid}`);
const QUEUE = join(TMP, 'digest-queue.jsonl');
const LOCK = QUEUE + '.lock';

before(() => mkdirSync(TMP, { recursive: true }));
after(() => rmSync(TMP, { recursive: true, force: true }));

// Helper: remove queue and lock between tests to keep each test isolated.
function cleanup() {
  try { rmSync(QUEUE, { force: true }); } catch {}
  try { rmSync(LOCK, { force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// appendDigestEntry
// ---------------------------------------------------------------------------

test('appendDigestEntry creates the file if it does not exist', () => {
  cleanup();
  appendDigestEntry({ type: 'test' }, QUEUE);
  assert.ok(existsSync(QUEUE));
});

test('appendDigestEntry appends a JSON line to the queue file', () => {
  cleanup();
  appendDigestEntry({ type: 'a' }, QUEUE);
  appendDigestEntry({ type: 'b' }, QUEUE);
  const lines = readFileSync(QUEUE, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const parsed = lines.map(l => JSON.parse(l));
  assert.equal(parsed[0].type, 'a');
  assert.equal(parsed[1].type, 'b');
});

test('appendDigestEntry adds run_at timestamp to the entry', () => {
  cleanup();
  const before = Date.now();
  appendDigestEntry({ type: 'digest', payload: 'x' }, QUEUE);
  const line = readFileSync(QUEUE, 'utf8').trim();
  const parsed = JSON.parse(line);
  assert.ok(typeof parsed.run_at === 'string', 'run_at should be a string');
  assert.ok(!isNaN(Date.parse(parsed.run_at)), 'run_at should be a valid ISO date');
  assert.ok(Date.parse(parsed.run_at) >= before, 'run_at should not be in the past');
});

// ---------------------------------------------------------------------------
// acquireLock
// ---------------------------------------------------------------------------

test('acquireLock returns true when lock does not exist', () => {
  cleanup();
  const result = acquireLock(LOCK);
  assert.equal(result, true);
  assert.ok(existsSync(LOCK));
  releaseLock(LOCK);
});

test('acquireLock returns false when lock already exists (EEXIST)', () => {
  cleanup();
  acquireLock(LOCK);
  // Lock is now held; second attempt must return false.
  const result = acquireLock(LOCK);
  assert.equal(result, false);
  releaseLock(LOCK);
});

test('acquireLock removes a stale lock (mtime > 60 s) and then acquires', () => {
  cleanup();
  // Write a stale lock file and backdate its mtime by LOCK_TTL_MS + 1 second.
  writeFileSync(LOCK, '', 'utf8');
  const staleTime = new Date(Date.now() - (LOCK_TTL_MS + 1000));
  utimesSync(LOCK, staleTime, staleTime);

  const result = acquireLock(LOCK);
  assert.equal(result, true, 'should acquire after removing stale lock');
  releaseLock(LOCK);
});

// ---------------------------------------------------------------------------
// releaseLock
// ---------------------------------------------------------------------------

test('releaseLock removes the lock file', () => {
  cleanup();
  acquireLock(LOCK);
  assert.ok(existsSync(LOCK));
  releaseLock(LOCK);
  assert.ok(!existsSync(LOCK));
});

test('releaseLock does not throw if lock file does not exist', () => {
  cleanup();
  assert.doesNotThrow(() => releaseLock(LOCK));
});

// ---------------------------------------------------------------------------
// deliverAndClearQueue
// ---------------------------------------------------------------------------

test('deliverAndClearQueue returns null when queue file does not exist', () => {
  cleanup();
  const result = deliverAndClearQueue(QUEUE, LOCK);
  assert.equal(result, null);
});

test('deliverAndClearQueue returns null when lock is held', () => {
  cleanup();
  writeFileSync(QUEUE, JSON.stringify({ type: 'x' }) + '\n', 'utf8');
  // Pre-acquire the lock to simulate another process holding it.
  acquireLock(LOCK);
  const result = deliverAndClearQueue(QUEUE, LOCK);
  assert.equal(result, null, 'should return null when lock is held');
  releaseLock(LOCK);
});

test('deliverAndClearQueue reads entries, clears queue, releases lock', () => {
  cleanup();
  const e1 = { type: 'task', run_at: new Date().toISOString() };
  const e2 = { type: 'skill', run_at: new Date().toISOString() };
  writeFileSync(QUEUE, JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n', 'utf8');

  const entries = deliverAndClearQueue(QUEUE, LOCK);
  assert.ok(Array.isArray(entries), 'should return an array');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].type, 'task');
  assert.equal(entries[1].type, 'skill');

  // Queue file should be cleared.
  const remaining = readFileSync(QUEUE, 'utf8');
  assert.equal(remaining, '', 'queue file should be empty after delivery');

  // Lock should be released.
  assert.ok(!existsSync(LOCK), 'lock file should be removed after delivery');
});

test('deliverAndClearQueue skips malformed JSON lines', () => {
  cleanup();
  const good = JSON.stringify({ type: 'valid' });
  const bad = '{ not: json ]';
  writeFileSync(QUEUE, good + '\n' + bad + '\n', 'utf8');

  const entries = deliverAndClearQueue(QUEUE, LOCK);
  assert.ok(Array.isArray(entries));
  assert.equal(entries.length, 1, 'only the valid line should be returned');
  assert.equal(entries[0].type, 'valid');
});

test('deliverAndClearQueue returns null for empty queue file', () => {
  cleanup();
  writeFileSync(QUEUE, '', 'utf8');
  const result = deliverAndClearQueue(QUEUE, LOCK);
  assert.equal(result, null);
});
