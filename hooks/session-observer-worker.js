'use strict';

const {
  readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync,
} = require('node:fs');
const { join, dirname, resolve, sep } = require('node:path');
const { homedir } = require('node:os');
const { todayLocal } = require('./lib/episode-utils.js');
const { safeString, yamlScalar, coerceObservation } = require('./lib/observation.js');
const { summarize } = require('./lib/summarizer-client.js');
const { tailHash, shouldSummarize, createCaptureQueue } = require('./lib/capture-queue.js');
const { readSignals } = require('./lib/capture-buffer.js');
const { isArmed } = require('./lib/fr-b5-flag.js');

const EPISODES_DIR = join(homedir(), '.claude-data', 'episodes');
const LOG_PATH = join(homedir(), '.claude-data', 'logs', 'session-observer.log');
// MAX_CHARS = 30_000 ≈ 7,500 tokens — conservative cap to keep the summarization
// prompt within a reasonable size. Raise only after measuring prompt cost.
const MAX_CHARS = 30_000;
const MIN_TURNS = 3;

// Value-scoring provenance constants.
const VALUE_RUBRIC_VERSION = 'v1';
const VALUE_MODEL = 'claude-haiku-4-5';

// CaptureQueue directories and gating constants.
const QUEUE_DIR = join(homedir(), '.claude-data', 'capture-queue');
const DEAD_LETTER_DIR = join(homedir(), '.claude-data', 'capture-queue', 'dead-letter');
const TURN_STRIDE = 10;
const ATTEMPT_CAP = 3;

// Append a timestamped line to the worker log. Wrapped in try/catch so a
// logging failure (disk full, perms) can never crash the worker. The launcher
// detaches stdio so process.stderr.write goes to /dev/null; this log file is
// the only visible trace when episodes stop being generated.
function logLine(level, message) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, '[' + new Date().toISOString() + '] ' + level + ': ' + message + '\n');
  } catch { /* logging must never crash the worker */ }
}

function extractText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(b => b && b.type === 'text')
      .map(b => (b.text || '').trim())
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function parseTurns(transcriptPath) {
  if (!existsSync(transcriptPath)) return [];
  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); } catch { return []; }
  const turns = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      const type = entry.type;
      // Claude Code JSONL uses type: 'user', not 'human'.
      if (type !== 'user' && type !== 'assistant') continue;
      const role = type === 'user' ? 'user' : 'assistant';
      const msg = entry.message || {};
      const text = extractText(msg.content || entry.content || '');
      if (text) turns.push({ role, text });
    } catch { /* skip malformed lines */ }
  }
  return turns;
}

// Returns a deterministic, per-session episode filename. No Date.now() suffix —
// the filename is stable across retries so in-place replace works correctly.
function episodeFilename(record) {
  const id = String(record.sessionId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'noid';
  return `${record.firstSeenDate}-${id}.md`;
}

// Read-before-write: if the existing episode was promoted, keep promoted:true so a
// refresh never resets the human-gated promotion flag. Body re-index is handled by
// the watcher (content-hash on body); promoted is frontmatter so a flag flip alone
// does not re-index.
function preservePromoted(existingRaw, newContent) {
  if (existingRaw && /^promoted:\s*true\s*$/m.test(existingRaw)) {
    return newContent.replace(/^promoted:\s*false\s*$/m, 'promoted: true');
  }
  return newContent;
}

function buildTranscriptText(turns) {
  const selected = [];
  let totalChars = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const rawLine = turns[i].role.toUpperCase() + ': ' + turns[i].text + '\n\n';
    const line = rawLine.length > MAX_CHARS
      ? rawLine.slice(0, MAX_CHARS) + '[truncated]\n\n'
      : rawLine;
    if (totalChars + line.length > MAX_CHARS && selected.length > 0) break;
    selected.unshift(line);
    totalChars += line.length;
  }
  return selected.join('');
}

// Render the preserved verdicts (a `kind@index,kind@index` string) and the CCR retrieve
// hash onto a tool-signal line. Kept pure (no clock/random) for determinism.
function why_suffix(preserved, ccrHash) {
  const k = preserved ? ` [${preserved}]` : '';
  const h = ccrHash ? ` (ccr=${ccrHash})` : '';
  return k + h;
}

function buildEpisodeContent(obs, sessionId, turnCount, toolSignals = []) {
  const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || String(Date.now());

  const fmLines = [
    '---',
    'date: ' + todayLocal(),
    'session_id: ' + safeSessionId,
  ];
  // Contract: every freeform-string frontmatter key MUST go through yamlScalar — it is
  // self-sufficient: quotes and escapes YAML-structural chars AND control characters (including newlines).
  if (obs.project) fmLines.push('project: ' + yamlScalar(obs.project));
  if (Number.isInteger(obs.value_score) && obs.value_score >= 0 && obs.value_score <= 4) {
    fmLines.push('value_score: ' + obs.value_score);
    fmLines.push('value_source: llm-judge');
    fmLines.push('value_rubric_version: ' + VALUE_RUBRIC_VERSION);
    fmLines.push('value_model: ' + VALUE_MODEL);
  }
  fmLines.push('turns: ' + turnCount, 'promoted: false', '---', '');

  const sections = ['## Summary\n' + (obs.summary || 'No summary generated.').trim()];

  if (obs.decisions.length)
    sections.push('## Decisions\n' + obs.decisions.map(d => '- ' + d).join('\n'));
  if (obs.corrections.length)
    sections.push('## Corrections\n' + obs.corrections.map(c => '- ' + c).join('\n'));
  if (obs.discoveries.length)
    sections.push('## Discoveries\n' + obs.discoveries.map(d => '- ' + d).join('\n'));
  if (obs.files_of_note.length)
    sections.push('## Files of note\n' + obs.files_of_note.map(f => '- `' + f.path + '` — ' + f.reason).join('\n'));

  // FR-B5 (DIO-18): the "## Tool signals" section is built DIRECTLY from the capture
  // buffer records (NOT via summarize()). Empty ⇒ omitted ⇒ byte-identical to pre-feature,
  // mirroring the conditional-section pattern above.
  if (Array.isArray(toolSignals) && toolSignals.length) {
    const lines = toolSignals.map((s) => {
      // AC-5b containment: render each PRESERVED verdict as `kind@index` so the section
      // names exactly which original rows were preserved and why. `preserved` is
      // [{index,kind}] from toSignalRecord (derived from compress()'s flat string verdicts).
      const preserved = Array.isArray(s.preserved)
        ? s.preserved.map((p) => `${p.kind}@${p.index}`).filter(Boolean).join(',')
        : '';
      // ccr_hash is the CCR retrieve marker (AC-1); dropped_count + preserved kinds are the signal.
      return `- \`${s.tool}\` — ${s.retained}, ${s.dropped_count} dropped` +
        why_suffix(preserved, s.ccr_hash);
    });
    sections.push('## Tool signals\n' + lines.join('\n'));
  }

  return fmLines.join('\n') + sections.join('\n\n') + '\n';
}

// Pure predicate: returns true when the transcript path is absent (dead-letter candidate).
// Exported so tests can prove the missing-vs-present distinction without running main().
function shouldDeadLetterMissingTranscript(transcriptPath) {
  return !existsSync(transcriptPath);
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData = {};
  try { hookData = JSON.parse(input); } catch {}

  const transcriptPath = hookData.transcript_path;
  if (!transcriptPath) process.exit(0);

  // Missing transcript must be dead-lettered BEFORE parseTurns/MIN_TURNS gating.
  // parseTurns() silently returns [] for missing files, which causes the MIN_TURNS
  // guard to exit quietly — bypassing the dead-letter path entirely (Copilot review).
  const sessionId = hookData.session_id || String(Date.now());
  const queue = createCaptureQueue({ queueDir: QUEUE_DIR, deadLetterDir: DEAD_LETTER_DIR });
  if (shouldDeadLetterMissingTranscript(transcriptPath)) {
    queue.deadLetter(sessionId, 'transcript no longer exists');
    process.exit(0);
  }

  const turns = parseTurns(transcriptPath);
  // File exists but has too few turns — silent skip, not a dead-letter (normal short session).
  if (turns.length < MIN_TURNS) process.exit(0);

  const transcriptText = buildTranscriptText(turns);
  if (!transcriptText.trim()) process.exit(0);

  const record = queue.upsert(sessionId, { transcriptPath, turnCount: turns.length });
  const hash = tailHash(transcriptText);
  if (!shouldSummarize(record, turns.length, hash, { stride: TURN_STRIDE })) {
    process.exit(0); // not materially grown/changed since last success — no spend
  }

  const result = summarize(transcriptText, {});
  if (result.status === 'error') {
    const { deadLettered } = queue.recordFailure(sessionId, result.errorClass, { attemptCap: ATTEMPT_CAP });
    logLine('warn', `summarize ${result.errorClass} (attempt recorded${deadLettered ? ', dead-lettered' : ''}): ` + result.detail);
    process.exit(0);
  }

  const obs = result.observation;
  const hasSignal = obs.decisions.length || obs.corrections.length || obs.discoveries.length ||
    obs.files_of_note.length || (obs.summary && obs.summary !== 'No significant decisions made.');
  if (!hasSignal) { queue.markSuccess(sessionId, { turnCount: turns.length, tailHash: hash }); process.exit(0); }

  mkdirSync(EPISODES_DIR, { recursive: true });
  const filename = episodeFilename(record);
  const target = resolve(EPISODES_DIR, filename);
  if (target !== EPISODES_DIR && !target.startsWith(EPISODES_DIR + sep)) {
    logLine('error', 'filename escapes episodes dir; aborting: ' + filename);
    process.exit(0);
  }
  const existingRaw = existsSync(target) ? readFileSync(target, 'utf8') : null;
  // FR-B5: read the tool-signal buffer ONLY when armed; OFF (default) ⇒ [] ⇒ no section
  // ⇒ byte-identical episode. Read is fail-safe ([] on any error).
  const toolSignals = isArmed('fr_b5_capture') ? readSignals(sessionId) : [];
  const content = preservePromoted(
    existingRaw,
    buildEpisodeContent(obs, sessionId, turns.length, toolSignals),
  );
  const tmpPath = target + '.tmp';
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, target);
  queue.markSuccess(sessionId, { turnCount: turns.length, tailHash: hash });
  process.exit(0);
}

module.exports = { parseTurns, buildTranscriptText, buildEpisodeContent, episodeFilename, preservePromoted, coerceObservation, safeString, shouldDeadLetterMissingTranscript };

if (require.main === module) {
  main().catch(err => {
    logLine('fatal', 'unhandled rejection: ' + (err && err.message ? err.message : String(err)));
    process.exit(0);
  });
}
