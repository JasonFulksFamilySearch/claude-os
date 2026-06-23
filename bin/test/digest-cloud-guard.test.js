'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isCloudSchedulable,
  assertCloudSchedulable,
} = require('../digest-cloud-guard.js');

// ── The contract ─────────────────────────────────────────────────────────────
//
// A digest-config agent block declares whether its skill may run as an unattended
// CLOUD routine. The rule mirrors the schema's two block shapes:
//   • read-only digests (pr-digest, sprint-digest) have NO `cloud_allowed` key —
//     they are cloud-safe by construction, so ABSENCE means schedulable.
//   • the write-capable digest (merge-progression) carries `cloud_allowed` and sets
//     it false — a skill that transitions Jira tickets must never run unattended
//     from a sandbox, so `cloud_allowed: false` means NOT schedulable.
//   • `cloud_allowed: true` is the explicit opt-in (no current block uses it, but the
//     classifier must honor it so a future cloud-portable write variant can flip it).
//
// The guard reads a resolved agent block (already selected by skill+agent), not the
// whole config — so it is pure and trivially testable.

// ── isCloudSchedulable: the pure classifier ──────────────────────────────────

test('read-only block (no cloud_allowed key) is cloud-schedulable', () => {
  assert.equal(isCloudSchedulable({ repos: ['o/r'], output: 'queue', cron: '0 6 * * *' }), true);
});

test('cloud_allowed:false block is NOT cloud-schedulable', () => {
  assert.equal(isCloudSchedulable({ repos: ['o/r'], output: 'queue', cron: '15 * * * 1-5', cloud_allowed: false }), false);
});

test('cloud_allowed:true block is cloud-schedulable (explicit opt-in)', () => {
  assert.equal(isCloudSchedulable({ repos: ['o/r'], output: 'issue', cron: '15 * * * 1-5', cloud_allowed: true }), true);
});

test('a null/undefined block is NOT cloud-schedulable (fail-closed)', () => {
  // An unresolved block must never be treated as cloud-safe — fail closed so a
  // config typo cannot silently green-light an unattended cloud run.
  assert.equal(isCloudSchedulable(null), false);
  assert.equal(isCloudSchedulable(undefined), false);
});

// ── assertCloudSchedulable: the throwing guard ───────────────────────────────

test('assert passes silently for a cloud-schedulable read-only block', () => {
  assert.doesNotThrow(() =>
    assertCloudSchedulable({ output: 'issue', cron: '0 6 * * *' }, 'background-pr-digest'));
});

test('assert throws for cloud_allowed:false, naming the skill', () => {
  assert.throws(
    () => assertCloudSchedulable({ output: 'queue', cron: '15 * * * 1-5', cloud_allowed: false }, 'background-merge-progression'),
    /background-merge-progression/,
  );
});

test('assert error message explains WHY it is blocked', () => {
  assert.throws(
    () => assertCloudSchedulable({ cloud_allowed: false }, 'background-merge-progression'),
    /cloud_allowed/,
  );
});

test('assert throws fail-closed for a missing block', () => {
  assert.throws(() => assertCloudSchedulable(null, 'background-merge-progression'));
});
