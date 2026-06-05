'use strict';

const {
  readFileSync, writeFileSync, appendFileSync,
  existsSync, mkdirSync, unlinkSync,
} = require('node:fs');
const { join, dirname } = require('node:path');
const { homedir } = require('node:os');

const MARKER_PATH = join(homedir(), '.claude-data', '_tmp_pending_learning.json');
const DATA_ROOT = join(homedir(), '.claude-data');

function todayLocal() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function resolveTarget(entry, dataRoot = DATA_ROOT) {
  if (entry.scope === 'project') {
    if (!entry.project || !/^[a-z0-9][a-z0-9-]*$/.test(entry.project)) return null;
    return join(dataRoot, 'projects', entry.project, 'learnings.md');
  }
  if (entry.scope === 'agent') return join(dataRoot, 'agent', 'learnings.md');
  return null;
}

function appendEntry(path, entry) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, '# Learnings\n\nDated entries below — append-only.\n', 'utf8');
  }
  const block = `\n\n## ${todayLocal()} — ${entry.title || 'Learning'}\n\n${entry.content.trim()}\n`;
  appendFileSync(path, block, 'utf8');
  return block.length;
}

function flush(markerPath = MARKER_PATH) {
  if (!existsSync(markerPath)) return { flushed: 0, skipped: 0 };

  let entries;
  try {
    const raw = readFileSync(markerPath, 'utf8');
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    try { unlinkSync(markerPath); } catch {}
    return { flushed: 0, skipped: 0, error: 'malformed marker file' };
  }

  let flushed = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (!entry.scope || !entry.content) { skipped++; continue; }
    const target = resolveTarget(entry);
    if (!target) { skipped++; continue; }
    try {
      appendEntry(target, entry);
      flushed++;
    } catch {
      skipped++;
    }
  }

  try { unlinkSync(markerPath); } catch {}
  return { flushed, skipped };
}

module.exports = { todayLocal, resolveTarget, appendEntry, flush };

if (require.main === module) {
  // Recursion guard: skip if spawned inside a session-observer worker subprocess.
  if (process.env.CLAUDE_OS_SKIP_EPISODE === '1') process.exit(0);

  let input = '';
  process.stdin.setEncoding('utf8');

  // Safety net: flush anyway if stdin never closes (e.g. no hook context piped).
  const stdinTimer = setTimeout(() => {
    flush();
    process.exit(0);
  }, 5_000);

  process.stdin.on('error', () => { clearTimeout(stdinTimer); flush(); process.exit(0); });
  process.stdin.on('data', d => { input += d; });
  process.stdin.on('end', () => {
    clearTimeout(stdinTimer);
    try {
      const ctx = JSON.parse(input);
      // Another Stop hook already handled this session — skip.
      if (ctx.stop_hook_active) process.exit(0);
      // Background tasks are still running; they will flush via their own Stop hooks.
      const bgTasks = Array.isArray(ctx.background_tasks) ? ctx.background_tasks : [];
      if (bgTasks.length > 0) process.exit(0);
    } catch { /* malformed or empty input — proceed with flush */ }
    flush();
  });
}
