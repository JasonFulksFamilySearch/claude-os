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
