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

module.exports = { CANONICAL_HOOKS, mergeHooks };
