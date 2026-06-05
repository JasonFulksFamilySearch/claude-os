'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CANONICAL_HOOKS, CANONICAL_GUARD_HOOKS, mergeHooks } = require('../hooks-install.js');

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

test('mergeHooks wires all four lifecycle hooks plus the two guards into an empty settings object', () => {
  const { settings, added, skipped } = mergeHooks({});
  assert.equal(added.length, 6); // 4 lifecycle + 2 guard
  assert.equal(skipped.length, 0);
  assert.equal(settings.hooks.SessionStart.length, 1);
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  assert.equal(settings.hooks.Stop.length, 2);
  // The two guards share ONE PreToolUse/Bash group.
  assert.equal(settings.hooks.PreToolUse.length, 1);
});

test('mergeHooks is idempotent — second run adds nothing', () => {
  const first = mergeHooks({});
  const second = mergeHooks(first.settings);
  assert.equal(second.added.length, 0);
  assert.equal(second.skipped.length, 6); // 4 lifecycle + 2 guard
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
const { tmpdir, homedir } = require('node:os');
const { applyToSettingsFile } = require('../hooks-install.js');

const TMP = join(tmpdir(), `hooks-install-test-${process.pid}`);
before(() => mkdirSync(TMP, { recursive: true }));
after(() => rmSync(TMP, { recursive: true, force: true }));

test('applyToSettingsFile creates settings with all six hooks when file is absent', () => {
  const path = join(TMP, 'absent', 'settings.json');
  const res = applyToSettingsFile(path);
  assert.equal(res.added.length, 6); // 4 lifecycle + 2 guard
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
  assert.equal(second.skipped.length, 6); // 4 lifecycle + 2 guard
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
  assert.equal(res.added.length, 6); // 4 lifecycle + 2 guard
  const written = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(written.hooks.Stop.length, 2);
});

test('applyToSettingsFile treats an absent file as fresh (not an error)', () => {
  const path = join(TMP, 'still-absent', 'settings.json');
  const res = applyToSettingsFile(path);
  assert.equal(res.added.length, 6); // 4 lifecycle + 2 guard
  assert.ok(existsSync(path));
});

// ── PreToolUse guard hooks ───────────────────────────────────────────────────

const GUARD_CMDS = CANONICAL_GUARD_HOOKS.map((h) => h.command);

// Build a settings object holding the two guards in ONE PreToolUse/Bash group,
// using the canonical command strings (used as the "Jason's-machine" shape).
const guardsAlreadyPresent = () => ({
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: CANONICAL_GUARD_HOOKS.map((h) => ({
          type: 'command',
          command: h.command,
          statusMessage: h.statusMessage,
        })),
      },
    ],
  },
});

const preToolUseCommands = (settings) =>
  (settings.hooks.PreToolUse || []).flatMap((g) => (g.hooks || []).map((h) => h.command));

test('CANONICAL_GUARD_HOOKS holds the two PreToolUse/Bash guards', () => {
  assert.equal(CANONICAL_GUARD_HOOKS.length, 2);
  for (const h of CANONICAL_GUARD_HOOKS) {
    assert.equal(h.event, 'PreToolUse');
    assert.equal(h.matcher, 'Bash');
    assert.ok(typeof h.command === 'string' && h.command.length > 0);
  }
});

test('CANONICAL_HOOKS stays exactly four (guards are a separate category)', () => {
  assert.equal(CANONICAL_HOOKS.length, 4);
});

test('mergeHooks creates ONE PreToolUse Bash group holding both guards on a fresh object', () => {
  const { settings, added } = mergeHooks({});
  assert.equal(settings.hooks.PreToolUse.length, 1, 'exactly one PreToolUse group');
  const group = settings.hooks.PreToolUse[0];
  assert.equal(group.matcher, 'Bash', 'created group MUST carry matcher:"Bash"');
  assert.equal(group.hooks.length, 2, 'both guards in the one group');
  for (const cmd of GUARD_CMDS) {
    assert.ok(added.includes(cmd), 'guard command reported in added');
    assert.ok(group.hooks.some((h) => h.command === cmd), 'guard command in the Bash group');
  }
});

test('mergeHooks skips both guards when they are already present (no duplicate group)', () => {
  const { settings, added, skipped } = mergeHooks(clone(guardsAlreadyPresent()));
  assert.equal(settings.hooks.PreToolUse.length, 1, 'no second Bash group');
  assert.equal(settings.hooks.PreToolUse[0].hooks.length, 2, 'still just the two guards');
  for (const cmd of GUARD_CMDS) {
    assert.ok(skipped.includes(cmd), 'present guard is skipped');
    assert.ok(!added.includes(cmd), 'present guard is not re-added');
  }
});

test('mergeHooks is idempotent on the guards across two runs', () => {
  const first = mergeHooks({});
  const second = mergeHooks(first.settings);
  for (const cmd of GUARD_CMDS) {
    assert.ok(second.skipped.includes(cmd));
    assert.ok(!second.added.includes(cmd));
  }
  assert.equal(second.settings.hooks.PreToolUse.length, 1);
  assert.equal(second.settings.hooks.PreToolUse[0].hooks.length, 2);
});

test('mergeHooks partial-install: only the missing guard is added, into the same Bash group', () => {
  // Seed with ONLY the first guard present.
  const partial = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: CANONICAL_GUARD_HOOKS[0].command, statusMessage: CANONICAL_GUARD_HOOKS[0].statusMessage }] },
      ],
    },
  };
  const { settings, added, skipped } = mergeHooks(clone(partial));
  assert.ok(skipped.includes(CANONICAL_GUARD_HOOKS[0].command), 'present guard skipped');
  assert.ok(added.includes(CANONICAL_GUARD_HOOKS[1].command), 'missing guard added');
  assert.equal(settings.hooks.PreToolUse.length, 1, 'still one Bash group');
  assert.equal(settings.hooks.PreToolUse[0].hooks.length, 2, 'both guards now in the group');
});

test('mergeHooks appends guards into an existing Bash group, preserving an unrelated hook at index 0', () => {
  const existing = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: "jq -r '.x'" }] }],
    },
  };
  const { settings } = mergeHooks(clone(existing));
  assert.equal(settings.hooks.PreToolUse.length, 1, 'no second Bash group created');
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "jq -r '.x'", 'unrelated hook stays at index 0');
  const cmds = preToolUseCommands(settings);
  for (const cmd of GUARD_CMDS) assert.ok(cmds.includes(cmd), 'guard appended into the same group');
});

test('mergeHooks leaves a non-Bash PreToolUse group untouched and puts guards in a Bash group', () => {
  const existing = {
    hooks: {
      PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: "jq -r '.edit'" }] }],
    },
  };
  const { settings } = mergeHooks(clone(existing));
  const editGroup = settings.hooks.PreToolUse.find((g) => g.matcher === 'Edit');
  const bashGroup = settings.hooks.PreToolUse.find((g) => g.matcher === 'Bash');
  assert.ok(editGroup, 'Edit group preserved');
  assert.equal(editGroup.hooks[0].command, "jq -r '.edit'", 'Edit group untouched');
  assert.ok(bashGroup, 'a Bash group was created for the guards');
  const cmds = bashGroup.hooks.map((h) => h.command);
  for (const cmd of GUARD_CMDS) assert.ok(cmds.includes(cmd));
});

test('applyToSettingsFile writes both guards to disk under a PreToolUse Bash group, idempotently', () => {
  const path = join(TMP, 'guards-disk', 'settings.json');
  applyToSettingsFile(path);
  const written = JSON.parse(readFileSync(path, 'utf8'));
  const bashGroup = (written.hooks.PreToolUse || []).find((g) => g.matcher === 'Bash');
  assert.ok(bashGroup, 'a PreToolUse group with matcher:"Bash" reached disk');
  const cmds = bashGroup.hooks.map((h) => h.command);
  for (const cmd of GUARD_CMDS) assert.ok(cmds.includes(cmd), 'guard command written to disk');
  // Second run is a no-op for the guards.
  const second = applyToSettingsFile(path);
  for (const cmd of GUARD_CMDS) assert.ok(!second.added.includes(cmd));
});

// FIDELITY (non-circular): assert each canonical guard command is byte-identical to
// what the LIVE ~/.claude/settings.json actually runs. Compares canonical-vs-reality,
// not canonical-vs-a-copy. Skips ONLY if the live file is absent; present-but-not-found
// is a FAIL (catches both a canonical transcription drift and a renamed live hook).
test('CANONICAL_GUARD_HOOKS match the live ~/.claude/settings.json byte-for-byte', () => {
  const live = join(homedir(), '.claude', 'settings.json');
  if (!existsSync(live)) {
    // Legitimately absent (e.g. a fresh CI box) — skip, do not false-fail.
    console.error('SKIP fidelity: ~/.claude/settings.json absent on this machine');
    return;
  }
  const parsed = JSON.parse(readFileSync(live, 'utf8'));
  const liveCmds = (parsed.hooks && parsed.hooks.PreToolUse ? parsed.hooks.PreToolUse : [])
    .flatMap((g) => (g.hooks || []).map((h) => h.command));
  for (const h of CANONICAL_GUARD_HOOKS) {
    assert.ok(
      liveCmds.includes(h.command),
      `canonical guard command not byte-identical to any live ~/.claude/settings.json PreToolUse command — drift between hooks-install.js and the live file:\n${h.command}`
    );
  }
});
