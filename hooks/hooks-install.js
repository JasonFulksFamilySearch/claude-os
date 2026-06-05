'use strict';

/**
 * hooks-install.js — single source of truth for claude-os lifecycle hooks.
 *
 * Holds the canonical four-hook contract (mirrors the README hook table) and
 * merges it into a Claude Code settings object at the INDIVIDUAL-COMMAND level:
 * a hook is added only if no existing group already runs that exact command.
 * This makes wiring idempotent and safe on machines that already have some
 * hooks — including the case where the Stop event already runs learnings-flush
 * but is missing session-observer.
 */

const CANONICAL_HOOKS = [
  {
    event: 'SessionStart',
    command: 'node ~/.claude-os/hooks/session-start-check.js',
    statusMessage: 'Checking session state...',
  },
  {
    event: 'UserPromptSubmit',
    command: 'node ~/.claude-os/hooks/topic-preload.js',
    statusMessage: 'Scanning for topic context...',
  },
  {
    event: 'Stop',
    command: 'node ~/.claude-os/hooks/learnings-flush.js',
    statusMessage: 'Flushing pending learnings...',
  },
  {
    event: 'Stop',
    command: 'node ~/.claude-os/hooks/session-observer.js',
    statusMessage: 'Writing session episode...',
  },
];

/**
 * Merge the canonical hooks into a settings object.
 * Pure: clones input, performs no I/O. Returns { settings, added, skipped }
 * where added/skipped are arrays of command strings.
 */
function mergeHooks(inputSettings) {
  const settings = JSON.parse(JSON.stringify(inputSettings || {}));
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};

  const added = [];
  const skipped = [];

  for (const hook of CANONICAL_HOOKS) {
    const { event, command, statusMessage } = hook;
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];

    const groups = settings.hooks[event];
    const alreadyPresent = groups.some(
      (group) =>
        Array.isArray(group.hooks) &&
        group.hooks.some((h) => h && h.command === command)
    );

    if (alreadyPresent) {
      skipped.push(command);
    } else {
      groups.push({
        hooks: [{ type: 'command', command, statusMessage }],
      });
      added.push(command);
    }
  }

  return { settings, added, skipped };
}

const { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } = require('node:fs');
const { dirname } = require('node:path');

/**
 * Apply the canonical hooks to a settings.json file on disk.
 * - If the file exists, copy it to settings.json.bak-<timestamp> first.
 * - Reads existing JSON (treats missing/empty/malformed as {}).
 * - Writes pretty-printed JSON only if something changed.
 * `timestamp` is injected (callers pass an ISO string) so the function stays
 * deterministic and testable; the CLI supplies one at invocation time.
 */
function applyToSettingsFile(path, timestamp) {
  let existing = {};
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf8').trim();
      existing = raw ? JSON.parse(raw) : {};
    } catch {
      existing = {};
    }
  }

  const { settings, added, skipped } = mergeHooks(existing);

  if (added.length > 0) {
    if (existsSync(path)) {
      const stamp = (timestamp || new Date().toISOString()).replace(/[:.]/g, '-');
      copyFileSync(path, `${path}.bak-${stamp}`);
    } else {
      mkdirSync(dirname(path), { recursive: true });
    }
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  }

  return { settings, added, skipped };
}

module.exports = { CANONICAL_HOOKS, mergeHooks, applyToSettingsFile };

// ── CLI entrypoint ───────────────────────────────────────────────────────────
// Run directly: `node hooks-install.js`  → wires hooks into ~/.claude/settings.json
if (require.main === module) {
  const { homedir } = require('node:os');
  const { join } = require('node:path');
  const target = process.env.CLAUDE_OS_SETTINGS_PATH || join(homedir(), '.claude', 'settings.json');

  const GREEN = '\x1b[0;32m';
  const YELLOW = '\x1b[1;33m';
  const NC = '\x1b[0m';

  try {
    const { added, skipped } = applyToSettingsFile(target);
    for (const cmd of added) {
      const name = cmd.split('/').pop();
      console.log(`${GREEN}[OK]${NC}   Registered hook: ${name}`);
    }
    for (const cmd of skipped) {
      const name = cmd.split('/').pop();
      console.log(`${YELLOW}[SKIP]${NC} Hook already present: ${name}`);
    }
    if (added.length === 0) {
      console.log(`${GREEN}[OK]${NC}   All four hooks already wired — nothing to do.`);
    }
    process.exit(0);
  } catch (err) {
    console.error(`Failed to wire hooks into ${target}: ${err.message}`);
    process.exit(1);
  }
}
