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
