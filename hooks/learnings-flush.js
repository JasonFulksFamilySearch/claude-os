'use strict';

const {
  readFileSync, writeFileSync, appendFileSync,
  existsSync, mkdirSync, unlinkSync, readdirSync, renameSync,
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

// Returns absolute paths of all marker files in the family:
// legacy un-suffixed + any per-session-suffixed variants (including residue).
// Quarantine files (.quarantine-*.json) are explicitly excluded — they are
// terminal and must never be reprocessed.
function markerFamily(dataRoot = DATA_ROOT) {
  if (!existsSync(dataRoot)) return [];
  return readdirSync(dataRoot)
    .filter(f =>
      (f === '_tmp_pending_learning.json' || /^_tmp_pending_learning-.+\.json$/.test(f))
      && !f.includes('.quarantine-'))
    .map(f => join(dataRoot, f));
}

// Per-file flush with quarantine-on-parse-fail and residue-on-append-fail.
// appendFn is injectable for testing; defaults to appendEntry.
function flushFile(markerPath, { appendFn = appendEntry } = {}) {
  if (!existsSync(markerPath)) return { flushed: 0, skipped: 0 };

  let entries;
  let raw;
  try {
    raw = readFileSync(markerPath, 'utf8');
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // QUARANTINE — never unlink-and-discard; preserve contents under a quarantine name.
    const quarantined = markerPath.replace(/\.json$/, '') + `.quarantine-${Date.now()}.json`;
    try { renameSync(markerPath, quarantined); } catch { return { flushed: 0, skipped: 0, error: 'quarantine-failed' }; }
    return { flushed: 0, skipped: 0, quarantined };
  }

  let flushed = 0;
  let skipped = 0;
  const failed = [];

  for (const entry of entries) {
    if (!entry || !entry.scope || !entry.content) { skipped++; continue; }
    const target = resolveTarget(entry);
    if (!target) { skipped++; continue; }
    try {
      appendFn(target, entry);
      flushed++;
    } catch {
      // Preserve for next flush — do NOT count as flushed or skipped.
      failed.push(entry);
    }
  }

  if (failed.length > 0) {
    // Derive the residue name from the ORIGINAL base — strip any existing .residue segment
    // first so repeated flush cycles never produce .residue.residue.json name stacking
    // (Copilot review). The atomic tmp+rename keeps the write crash-safe.
    const base = markerPath.replace(/\.residue(\.json)?$/, '.json').replace(/\.json$/, '');
    const residue = base + '.residue.json';

    // Merge with any prior residue so no failed entries are lost across flush cycles.
    let prior = [];
    if (existsSync(residue)) {
      try { prior = JSON.parse(readFileSync(residue, 'utf8')); } catch { prior = []; }
      if (!Array.isArray(prior)) prior = [];
    }
    const merged = prior.concat(failed);

    const residueTmp = residue + '.tmp';
    writeFileSync(residueTmp, JSON.stringify(merged), 'utf8');
    renameSync(residueTmp, residue);
    try { unlinkSync(markerPath); } catch {}
    return { flushed, skipped, residue };
  }

  try { unlinkSync(markerPath); } catch {}
  return { flushed, skipped };
}

// Process the entire marker family; each file is processed independently.
function flushAll(dataRoot = DATA_ROOT) {
  const files = markerFamily(dataRoot);
  let flushed = 0, skipped = 0, quarantined = 0, residue = 0;
  for (const f of files) {
    const r = flushFile(f);
    flushed += r.flushed || 0;
    skipped += r.skipped || 0;
    if (r.quarantined) quarantined++;
    if (r.residue) residue++;
  }
  return { filesProcessed: files.length, flushed, skipped, quarantined, residue };
}

// Backward-compat: flush(markerPath) delegates to flushFile.
function flush(markerPath = MARKER_PATH) { return flushFile(markerPath); }

module.exports = { todayLocal, resolveTarget, appendEntry, flush, markerFamily, flushFile, flushAll };

if (require.main === module) {
  // Recursion guard: skip if spawned inside a session-observer worker subprocess.
  if (process.env.CLAUDE_OS_SKIP_EPISODE === '1') process.exit(0);

  let input = '';
  process.stdin.setEncoding('utf8');

  // Safety net: flush anyway if stdin never closes (e.g. no hook context piped).
  const stdinTimer = setTimeout(() => {
    flushAll(DATA_ROOT);
    process.exit(0);
  }, 5_000);

  process.stdin.on('error', () => { clearTimeout(stdinTimer); flushAll(DATA_ROOT); process.exit(0); });
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
    flushAll(DATA_ROOT);
  });
}
