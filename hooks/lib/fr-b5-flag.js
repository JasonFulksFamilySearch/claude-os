'use strict';

/**
 * fr-b5-flag.js — the FR-B5 arming flag, a FILE SENTINEL (not the SQLite meta table).
 *
 * The hooks layer has no better-sqlite3 (no hooks/package.json / node_modules), so it
 * cannot read the meta table where c2_chunking_enabled lives. FR-B5's gate is therefore
 * a file under ~/.claude-data/flags/: present = armed, absent = off (the default).
 * Routing rule for the project: DB-open consumers → meta table; hook consumers → file flags.
 *
 * Reversibility (AC-5c.2): an ABSENT sentinel is the shipped default and makes every
 * FR-B5 path a no-op, so the episode is byte-identical to pre-feature. Disarming is
 * deleting the file. isArmed() fails safe to OFF on any error.
 */

const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const FLAGS_DIR = join(homedir(), '.claude-data', 'flags');

function safeName(name) {
  return (String(name).replace(/[^a-zA-Z0-9_-]/g, '') || 'flag').slice(0, 64);
}

function flagPath(name, dir = FLAGS_DIR) {
  return join(dir, safeName(name));
}

function isArmed(name, { dir = FLAGS_DIR, exists = existsSync } = {}) {
  try {
    return exists(flagPath(name, dir)) === true;
  } catch {
    return false; // fail-safe: any error ⇒ treat as OFF
  }
}

module.exports = { FLAGS_DIR, flagPath, isArmed };
