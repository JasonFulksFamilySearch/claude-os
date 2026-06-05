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
 * PreToolUse/Bash guard hooks — a SECOND, distinct category from the lifecycle
 * (memory) hooks above. These are identity/safety guards, not memory wiring, so
 * they live in their own contract and the README documents them in a separate table.
 *
 * Each command string is VERBATIM from the source of truth (the guards that were
 * hand-added to a live ~/.claude/settings.json). The fidelity test in
 * hooks-install.test.js asserts these byte-for-byte against the live file, so a
 * transcription drift fails the suite rather than silently writing a duplicate.
 *
 * Unlike the lifecycle hooks (which take no matcher), a PreToolUse hook must carry
 * matcher: 'Bash' to fire only on Bash tool calls — see mergeGuardHooks.
 */
const CANONICAL_GUARD_HOOKS = [
  {
    // Rule 11 guard: denies `cd … && git`. A permissionDecision:"deny" hook.
    event: 'PreToolUse',
    matcher: 'Bash',
    command: 'jq -r \'.tool_input.command\' | grep -qE \'^cd\\s+.*&&\\s*git\\s\' && echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Rule 11: cd and git must be separate commands. Run cd first, then git separately."}}\'',
    statusMessage: 'Checking cd && git...',
  },
  {
    // Merge-verify reminder: injects additionalContext on `gh pr merge`. Non-blocking
    // (ends `|| true`), so it never fails the tool call.
    event: 'PreToolUse',
    matcher: 'Bash',
    command: 'jq -r \'.tool_input.command\' | grep -qE \'gh pr merge\' && echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Merge-verify reminder: a gh pr merge does NOT confirm the merge landed, and the GitHub MCP can return STALE state. Before reporting any PR as merged, run: gh pr view <n> --json state,mergedAt (expect state=MERGED, mergedAt non-null) AND git fetch --prune then confirm origin/<branch> SHA advanced. State the merge in the same breath as that proof."}}\' || true',
    statusMessage: 'Merge-verify reminder...',
  },
];

/**
 * True if `command` already appears in any group under settings.hooks[event].
 * The exact-string match is the idempotency key shared by both the lifecycle and
 * guard merges — a hook is "present" iff its command string is byte-identical.
 */
function commandPresent(settings, event, command) {
  const groups = settings.hooks[event];
  return (
    Array.isArray(groups) &&
    groups.some(
      (group) =>
        Array.isArray(group.hooks) &&
        group.hooks.some((h) => h && h.command === command)
    )
  );
}

/**
 * Merge the lifecycle (memory) hooks AND the PreToolUse guard hooks into a settings
 * object. Pure: clones input, performs no I/O. Returns { settings, added, skipped }
 * where added/skipped are arrays of command strings (combined across both categories).
 */
function mergeHooks(inputSettings) {
  const settings = JSON.parse(JSON.stringify(inputSettings || {}));
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};

  const added = [];
  const skipped = [];

  // Pass 1 — lifecycle (memory) hooks: each gets its own matcher-less group.
  for (const hook of CANONICAL_HOOKS) {
    const { event, command, statusMessage } = hook;
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];

    if (commandPresent(settings, event, command)) {
      skipped.push(command);
    } else {
      settings.hooks[event].push({
        hooks: [{ type: 'command', command, statusMessage }],
      });
      added.push(command);
    }
  }

  // Pass 2 — guard hooks: matcher-aware. A PreToolUse Bash hook MUST carry
  // matcher:'Bash' to fire only on Bash, so we append into an existing Bash group
  // when one exists, else create a new { matcher:'Bash', hooks:[...] } group — never
  // the matcher-less push used for lifecycle hooks.
  mergeGuardHooks(settings, added, skipped);

  return { settings, added, skipped };
}

/**
 * Append each guard hook into the settings object, matcher-aware. Mutates the
 * passed `settings`/`added`/`skipped` (called by mergeHooks after the lifecycle pass).
 */
function mergeGuardHooks(settings, added, skipped) {
  for (const hook of CANONICAL_GUARD_HOOKS) {
    const { event, matcher, command, statusMessage } = hook;
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];

    if (commandPresent(settings, event, command)) {
      skipped.push(command);
      continue;
    }

    const groups = settings.hooks[event];
    const bashGroup = groups.find((g) => g && g.matcher === matcher && Array.isArray(g.hooks));
    const entry = { type: 'command', command, statusMessage };

    if (bashGroup) {
      bashGroup.hooks.push(entry);
    } else {
      groups.push({ matcher, hooks: [entry] });
    }
    added.push(command);
  }
}

const { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } = require('node:fs');
const { dirname } = require('node:path');

/**
 * Apply the canonical hooks to a settings.json file on disk.
 * - If the file exists, copy it to settings.json.bak-<timestamp> first.
 * - Reads existing JSON (missing/empty → fresh {}; an unparseable existing file throws rather than clobbering).
 * - Writes pretty-printed JSON only if something changed.
 * `timestamp` is injected (callers pass an ISO string) so the function stays
 * deterministic and testable; the CLI supplies one at invocation time.
 */
function applyToSettingsFile(path, timestamp) {
  let existing = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8').trim();
    if (raw) {
      try {
        existing = JSON.parse(raw);
      } catch {
        // The file exists and has content we cannot parse (e.g. comments or a
        // trailing comma). Rebuilding from {} would strip the user's real keys,
        // so refuse to write at all and surface an actionable error instead.
        throw new Error(
          `${path} exists but is not valid JSON — refusing to modify it. ` +
          `Fix the JSON by hand, then re-run.`
        );
      }
    }
    // raw === '' (empty / whitespace-only) falls through as a fresh {} — not an error.
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

module.exports = { CANONICAL_HOOKS, CANONICAL_GUARD_HOOKS, mergeHooks, mergeGuardHooks, applyToSettingsFile };

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
