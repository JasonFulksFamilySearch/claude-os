'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isCloudSchedulable } = require('../digest-cloud-guard.js');

// ── The config-shape contract ────────────────────────────────────────────────
//
// `cloud_allowed: false` on the write-capable digest is the whole safety story for
// "a Jira-transitioning skill must not run unattended in the cloud." A silent flip to
// true — or dropping the key — would re-open exactly the hole #53 is about. This test
// pins the COMMITTED template so that drift fails CI, not production. It reads the real
// template (the source of truth update.sh provisions from), not a fixture.

const TEMPLATE = path.resolve(__dirname, '..', '..', 'config', 'digest-config.template.json');

function loadTemplate() {
  return JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
}

test('merge-progression is write-capable: cloud_allowed must be false for EVERY agent', () => {
  const cfg = loadTemplate();
  const mp = cfg.digests['merge-progression'];
  assert.ok(mp, 'merge-progression block must exist');
  for (const [agent, block] of Object.entries(mp)) {
    if (agent.startsWith('_')) continue; // skip _comment
    assert.equal(
      block.cloud_allowed, false,
      `merge-progression.${agent}.cloud_allowed must be false (write-capable skill is local-only)`,
    );
    assert.equal(
      isCloudSchedulable(block), false,
      `the guard must classify merge-progression.${agent} as NOT cloud-schedulable`,
    );
  }
});

test('read-only digests stay cloud-schedulable (no cloud_allowed key blocking them)', () => {
  const cfg = loadTemplate();
  for (const skill of ['pr-digest', 'sprint-digest']) {
    const block = cfg.digests[skill];
    assert.ok(block, `${skill} block must exist`);
    for (const [agent, agentBlock] of Object.entries(block)) {
      if (agent.startsWith('_')) continue;
      assert.equal(
        isCloudSchedulable(agentBlock), true,
        `read-only ${skill}.${agent} must remain cloud-schedulable`,
      );
    }
  }
});
