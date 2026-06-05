'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CANONICAL_HOOKS, mergeHooks } = require('../hooks-install.js');

// Deep-clone helper so tests never share mutable state.
const clone = (o) => JSON.parse(JSON.stringify(o));

test('CANONICAL_HOOKS lists all four documented hooks', () => {
  const commands = CANONICAL_HOOKS.map((h) => h.command);
  assert.equal(CANONICAL_HOOKS.length, 4);
  assert.ok(commands.includes('node ~/.claude-os/hooks/session-start-check.js'));
  assert.ok(commands.includes('node ~/.claude-os/hooks/topic-preload.js'));
  assert.ok(commands.includes('node ~/.claude-os/hooks/learnings-flush.js'));
  assert.ok(commands.includes('node ~/.claude-os/hooks/session-observer.js'));
});

test('CANONICAL_HOOKS registers two Stop hooks', () => {
  const stop = CANONICAL_HOOKS.filter((h) => h.event === 'Stop');
  assert.equal(stop.length, 2);
});

test('mergeHooks wires all four into an empty settings object', () => {
  const { settings, added, skipped } = mergeHooks({});
  assert.equal(added.length, 4);
  assert.equal(skipped.length, 0);
  assert.equal(settings.hooks.SessionStart.length, 1);
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  assert.equal(settings.hooks.Stop.length, 2);
});

test('mergeHooks is idempotent — second run adds nothing', () => {
  const first = mergeHooks({});
  const second = mergeHooks(first.settings);
  assert.equal(second.added.length, 0);
  assert.equal(second.skipped.length, 4);
  assert.equal(second.settings.hooks.Stop.length, 2);
});

test('mergeHooks adds session-observer alongside an existing learnings-flush Stop hook', () => {
  // Reproduces THIS machine's exact broken state: Stop has only learnings-flush.
  const broken = {
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'node ~/.claude-os/hooks/learnings-flush.js', statusMessage: 'Flushing pending learnings...' }] },
      ],
    },
  };
  const { settings, added, skipped } = mergeHooks(clone(broken));
  assert.equal(settings.hooks.Stop.length, 2, 'session-observer must be appended, not replace learnings-flush');
  const stopCommands = settings.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(stopCommands.includes('node ~/.claude-os/hooks/learnings-flush.js'));
  assert.ok(stopCommands.includes('node ~/.claude-os/hooks/session-observer.js'));
  assert.ok(added.includes('node ~/.claude-os/hooks/session-observer.js'));
});

test('mergeHooks preserves unrelated settings and unrelated hooks', () => {
  const existing = {
    permissions: { allow: ['Bash(node:*)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: "jq -r '.x'" }] }],
    },
    theme: 'dark',
  };
  const { settings } = mergeHooks(clone(existing));
  assert.deepEqual(settings.permissions, existing.permissions, 'permissions untouched');
  assert.equal(settings.theme, 'dark', 'unrelated keys untouched');
  assert.equal(settings.hooks.PreToolUse.length, 1, 'PreToolUse hook survives');
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "jq -r '.x'");
});

test('mergeHooks does not mutate its input object', () => {
  const input = {};
  mergeHooks(input);
  assert.deepEqual(input, {}, 'input must be cloned, not mutated');
});

const { before, after } = require('node:test');
const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { applyToSettingsFile } = require('../hooks-install.js');

const TMP = join(tmpdir(), `hooks-install-test-${process.pid}`);
before(() => mkdirSync(TMP, { recursive: true }));
after(() => rmSync(TMP, { recursive: true, force: true }));

test('applyToSettingsFile creates settings with all four hooks when file is absent', () => {
  const path = join(TMP, 'absent', 'settings.json');
  const res = applyToSettingsFile(path);
  assert.equal(res.added.length, 4);
  assert.ok(existsSync(path));
  const written = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(written.hooks.Stop.length, 2);
});

test('applyToSettingsFile backs up an existing file before writing', () => {
  const dir = join(TMP, 'backup');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'settings.json');
  writeFileSync(path, JSON.stringify({ theme: 'dark', hooks: {} }), 'utf8');

  applyToSettingsFile(path, '2026-06-04T00:00:00.000Z');

  const backups = readdirSync(dir).filter((f) => f.startsWith('settings.json.bak-'));
  assert.equal(backups.length, 1, 'exactly one timestamped backup created');
  const backup = JSON.parse(readFileSync(join(dir, backups[0]), 'utf8'));
  assert.equal(backup.theme, 'dark', 'backup holds the pre-write content');
});

test('applyToSettingsFile is idempotent on a real file', () => {
  const path = join(TMP, 'idem', 'settings.json');
  applyToSettingsFile(path);
  const second = applyToSettingsFile(path);
  assert.equal(second.added.length, 0);
  assert.equal(second.skipped.length, 4);
});

test('applyToSettingsFile preserves unrelated keys on disk', () => {
  const dir = join(TMP, 'preserve');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'settings.json');
  writeFileSync(path, JSON.stringify({ permissions: { allow: ['X'] }, theme: 'dark', hooks: {} }), 'utf8');
  applyToSettingsFile(path, '2026-06-04T00:00:00.000Z');
  const written = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(written.permissions, { allow: ['X'] });
  assert.equal(written.theme, 'dark');
});

// --- Hardening tests (requested by code review) ---

test('mergeHooks rebuilds a null event value into a valid array', () => {
  const { settings } = mergeHooks({ hooks: { Stop: null } });
  assert.ok(Array.isArray(settings.hooks.Stop));
  assert.equal(settings.hooks.Stop.length, 2);
});

test('CANONICAL_HOOKS contains no duplicate (event, command) pairs', () => {
  const seen = new Set();
  for (const h of CANONICAL_HOOKS) {
    const key = `${h.event}::${h.command}`;
    assert.ok(!seen.has(key), `duplicate canonical hook: ${key}`);
    seen.add(key);
  }
});

test('mergeHooks detects an existing command inside a multi-command group', () => {
  // A single Stop group bundling two commands — the realistic "messy settings" shape.
  const existing = {
    hooks: {
      Stop: [
        {
          hooks: [
            { type: 'command', command: 'node ~/.claude-os/hooks/learnings-flush.js', statusMessage: 'Flushing pending learnings...' },
            { type: 'command', command: 'node ~/.claude-os/hooks/session-observer.js', statusMessage: 'Writing session episode...' },
          ],
        },
      ],
    },
  };
  const { added, skipped } = mergeHooks(clone(existing));
  assert.ok(skipped.includes('node ~/.claude-os/hooks/learnings-flush.js'));
  assert.ok(skipped.includes('node ~/.claude-os/hooks/session-observer.js'));
  assert.ok(!added.includes('node ~/.claude-os/hooks/session-observer.js'));
});

test('applyToSettingsFile aborts without writing when an existing file is unparseable', () => {
  const dir = join(TMP, 'unparseable');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'settings.json');
  const original = '{ "theme": "dark", // a comment\n  "permissions": { "allow": ["X"] }, }';
  writeFileSync(path, original, 'utf8');

  // It must throw rather than silently rebuilding from {} and stripping keys.
  assert.throws(() => applyToSettingsFile(path, '2026-06-04T00:00:00.000Z'), /unparseable|parse/i);

  // The live file is byte-for-byte untouched...
  assert.equal(readFileSync(path, 'utf8'), original);
  // ...and NO backup was written (we refuse to touch a file we can't understand).
  const backups = readdirSync(dir).filter((f) => f.startsWith('settings.json.bak-'));
  assert.equal(backups.length, 0);
});

test('applyToSettingsFile treats an empty file as fresh (not an error)', () => {
  const dir = join(TMP, 'empty-file');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'settings.json');
  writeFileSync(path, '   \n  ', 'utf8'); // whitespace only

  const res = applyToSettingsFile(path, '2026-06-04T00:00:00.000Z');
  assert.equal(res.added.length, 4);
  const written = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(written.hooks.Stop.length, 2);
});

test('applyToSettingsFile treats an absent file as fresh (not an error)', () => {
  const path = join(TMP, 'still-absent', 'settings.json');
  const res = applyToSettingsFile(path);
  assert.equal(res.added.length, 4);
  assert.ok(existsSync(path));
});
