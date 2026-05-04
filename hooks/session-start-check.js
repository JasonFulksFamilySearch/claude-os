'use strict';

const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const MARKER_PATH = join(homedir(), '.claude-data', '_tmp_claude_md_update_needed.txt');

function main() {
  if (!existsSync(MARKER_PATH)) return;

  const message = readFileSync(MARKER_PATH, 'utf8').trim();

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `[Action required — CLAUDE.md operating rules are out of date]\n\n${message}`,
    },
  }));
}

main();
