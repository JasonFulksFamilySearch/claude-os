'use strict';

/**
 * session-observer.js — Stop hook launcher.
 *
 * Registered in settings.json. Reads hook JSON from stdin, spawns the
 * worker detached, and exits immediately (<100ms). Claude Code is never
 * blocked waiting for the Haiku API response. If the worker fails, it logs
 * to its own stderr but the session close is unaffected.
 */
const { spawn } = require('node:child_process');
const { join } = require('node:path');

let input = '';
process.stdin.setEncoding('utf8');

// Safety net: if Claude Code (or a test wrapper) writes to stdin without
// closing it, the 'end' event never fires and the launcher hangs forever,
// back-pressuring Claude Code's hook caller. 5s is generous for hook input.
const stdinTimer = setTimeout(() => {
  try { process.exit(0); } catch {}
}, 5_000);

process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  clearTimeout(stdinTimer);
  // stop_hook_active guard: if another Stop hook set this flag, skip immediately.
  try {
    if (JSON.parse(input).stop_hook_active) process.exit(0);
  } catch {}

  const child = spawn(
    process.execPath,
    [join(__dirname, 'session-observer-worker.js')],
    {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env },
    }
  );
  child.stdin.write(input);
  child.stdin.end();
  child.unref();
  process.exit(0);
});
