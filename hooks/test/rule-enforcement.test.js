'use strict';

// Behavioral tests for the PreToolUse rule-enforcement guard (rule-enforcement.sh).
// These spawn the actual bash hook with crafted PreToolUse JSON and assert its
// exit code (0 = allow, 2 = block). They are hermetic: a throwaway $HOME is used
// so the suite neither depends on nor pollutes the real install, and runs the
// same on any machine (CI, Walter, a fresh checkout).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const HOOK = join(__dirname, '..', 'rule-enforcement.sh');

let HOME;
let IDENTITY_LINK;
let IDENTITY_DATA;

before(() => {
  HOME = mkdtempSync(join(tmpdir(), 'rule-enf-home-'));
  // .claude exists so the hook's log append lands somewhere harmless (and is
  // torn down with the temp HOME). The identity *files* need not exist — the
  // guard matches on path form, not on the file being present.
  mkdirSync(join(HOME, '.claude'), { recursive: true });
  mkdirSync(join(HOME, '.claude-data', 'agent'), { recursive: true });
  IDENTITY_LINK = join(HOME, '.claude', 'CLAUDE.md');
  IDENTITY_DATA = join(HOME, '.claude-data', 'agent', 'CLAUDE.md');
});
after(() => rmSync(HOME, { recursive: true, force: true }));

function runHook(payload, extraEnv = {}) {
  const res = spawnSync('bash', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, HOME, CLAUDE_OS_HOOK_DEPTH: '0', ...extraEnv },
  });
  return { status: res.status, stderr: res.stderr || '' };
}

const edit = (file_path) => ({ tool_name: 'Edit', tool_input: { file_path } });
const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path } });

// ── jq present (normal operation) ──────────────────────────────────────────

test('blocks Edit to the identity file (symlink path form) — Rule 10', () => {
  const { status, stderr } = runHook(edit(IDENTITY_LINK));
  assert.equal(status, 2);
  assert.match(stderr, /Rule 10/);
});

test('blocks Write to the identity file (real data-dir path form)', () => {
  assert.equal(runHook(write(IDENTITY_DATA)).status, 2);
});

test('allows Edit to an ordinary file', () => {
  assert.equal(runHook(edit('/tmp/whatever.md')).status, 0);
});

test('allows Edit to a capability file under ~/.claude/rules', () => {
  assert.equal(runHook(edit(join(HOME, '.claude', 'rules', 'workflow.md'))).status, 0);
});

test('blocks a git commit whose subject carries a ticket number — Rule 7', () => {
  const { status, stderr } = runHook({
    tool_name: 'Bash',
    tool_input: { command: "git commit -m 'ARC-123: do a thing'" },
  });
  assert.equal(status, 2);
  assert.match(stderr, /Rule 7/);
});

// ── jq missing (degraded mode — the fail-closed guard) ─────────────────────

test('fails CLOSED on the identity invariant when jq is unavailable', (t) => {
  // macOS ships /usr/bin/jq, so trimming PATH isn't enough — build a minimal
  // bindir with only bash/cat/date so `command -v jq` genuinely fails.
  const resolve = (bin) => {
    const r = spawnSync('bash', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const bins = { bash: resolve('bash'), cat: resolve('cat'), date: resolve('date') };
  if (!bins.bash || !bins.cat || !bins.date) {
    t.skip('could not resolve bash/cat/date to build a jq-free PATH');
    return;
  }

  const bindir = mkdtempSync(join(tmpdir(), 'no-jq-'));
  try {
    for (const [name, src] of Object.entries(bins)) symlinkSync(src, join(bindir, name));

    const run = (payload) =>
      spawnSync(join(bindir, 'bash'), [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { PATH: bindir, HOME, CLAUDE_OS_HOOK_DEPTH: '0' },
      });

    // Test sanity: jq must truly be unreachable, or this proves nothing.
    const jqCheck = spawnSync(join(bindir, 'bash'), ['-c', 'command -v jq'], {
      env: { PATH: bindir, HOME }, encoding: 'utf8',
    });
    assert.notEqual(jqCheck.status, 0, 'test invalid: jq still reachable in the stripped PATH');

    const blocked = run(edit(IDENTITY_LINK));
    assert.equal(blocked.status, 2, 'identity Edit must fail closed without jq');
    assert.match(blocked.stderr, /Rule 10/);

    assert.equal(run(edit('/tmp/whatever.md')).status, 0, 'ordinary edit must still be allowed without jq');
    assert.equal(
      run({ tool_name: 'Read', tool_input: { file_path: IDENTITY_LINK } }).status, 0,
      'Read of identity must not be falsely blocked (tool_name gate)',
    );
  } finally {
    rmSync(bindir, { recursive: true, force: true });
  }
});
