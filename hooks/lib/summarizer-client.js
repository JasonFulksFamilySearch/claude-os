'use strict';
const { spawnSync } = require('node:child_process');
const { coerceObservation } = require('./observation.js');

const VALUE_MODEL = 'claude-haiku-4-5';
const DEFAULT_TIMEOUT_MS = 120_000;

// JSON Schema mirroring coerceObservation's accepted shape. Passed to `claude -p
// --json-schema` so the model returns a validated `structured_output` object —
// retiring the brace-scanner. value_score is OPTIONAL (omit when unsure).
const OBSERVATION_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    project: { type: ['string', 'null'] },
    decisions: { type: 'array', items: { type: 'string' } },
    corrections: { type: 'array', items: { type: 'string' } },
    discoveries: { type: 'array', items: { type: 'string' } },
    files_of_note: {
      type: 'array',
      items: { type: 'object', properties: { path: { type: 'string' }, reason: { type: 'string' } }, required: ['path', 'reason'] },
    },
    value_score: { type: 'integer', minimum: 0, maximum: 4 },
  },
  required: ['summary'],
};

// NOTE on flags (do not drop any — each measured live 2026-06-16):
//  --output-format json + --json-schema : structured_output field (no brace-scan, no parse-fail class)
//  --system-prompt (REPLACE) : drops Claude Code's ~28K-token default agent prompt (~7x cost cut)
//  --safe-mode : skips CLAUDE.md/skills/plugins/hooks/MCP cold-start; keeps subscription auth + policy
//  --permission-mode default : prevents the plan-mode drift seen with --tools "" (which we do NOT pass)
//  --no-session-persistence + CLAUDE_OS_SKIP_EPISODE env : recursion guards (unchanged from prior)
function buildArgs({ model = VALUE_MODEL, systemPrompt, schemaJson }) {
  return [
    '-p',
    '--model', model,
    '--output-format', 'json',
    '--json-schema', schemaJson,
    '--system-prompt', systemPrompt,
    '--safe-mode',
    '--permission-mode', 'default',
    '--no-session-persistence',
  ];
}

function parseEnvelope(stdout) {
  try { return JSON.parse((stdout || '').trim()); } catch { return null; }
}

// Returns an errorClass string on failure, or null on success.
// Transient (retry next turn): TIMEOUT, OVERLOAD, SERVER. Deterministic (dead-letter now): AUTH.
// PARSE is handled by extractObservation; classifyResult only sees transport/envelope state.
function classifyResult(result) {
  if (result.error) {
    return result.error.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'SERVER';
  }
  if (result.status !== 0) return 'SERVER';
  const env = parseEnvelope(result.stdout);
  if (env && env.is_error) {
    const code = env.api_error_status;
    if (code === 401 || code === 403) return 'AUTH';
    if (code === 429) return 'OVERLOAD';
    if (typeof code === 'number' && code >= 500) return 'SERVER';
    return 'SERVER'; // unknown api error -> transient-retry (safe-fail; never drop a memory on a guess)
  }
  return null;
}

function extractObservation(stdout) {
  const env = parseEnvelope(stdout);
  if (!env || typeof env.structured_output !== 'object' || env.structured_output === null) {
    throw new Error('PARSE');
  }
  return coerceObservation(env.structured_output);
}

function summarize(transcriptText, { spawn = spawnSync, model = VALUE_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS, systemPrompt } = {}) {
  const sp = systemPrompt || require('./summarizer-prompt.js').SYSTEM_PROMPT;
  const args = buildArgs({ model, systemPrompt: sp, schemaJson: JSON.stringify(OBSERVATION_SCHEMA) });
  // Wrap transcript in a data-fence so Claude treats it as untrusted content.
  // Use bracketed sentinels for the replacement — `<<<TRANSCRIPT` replaced with
  // `[FENCE-OPEN]` cannot reconstruct a fence on re-pass, so this is idempotent.
  // A naive `<TRANSCRIPT` replacement is NOT safe: `<<<<<TRANSCRIPT` →
  // `<<<TRANSCRIPT` (regenerates the marker) — an attacker writing 5+ `<`s
  // would forge a fence and inject instructions past the boundary.
  const safeTranscript = '<<<TRANSCRIPT\n'
    + transcriptText.replace(/<<<TRANSCRIPT/g, '[FENCE-OPEN]').replace(/TRANSCRIPT>>>/g, '[FENCE-CLOSE]')
    + '\nTRANSCRIPT>>>';
  const result = spawn('claude', [...args, safeTranscript], {
    env: { ...process.env, CLAUDE_OS_SKIP_EPISODE: '1' },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const errorClass = classifyResult(result);
  if (errorClass) return { status: 'error', errorClass, detail: (result.stderr || '').slice(0, 500) };
  try {
    return { status: 'ok', observation: extractObservation(result.stdout) };
  } catch {
    return { status: 'error', errorClass: 'PARSE', detail: (result.stdout || '').slice(0, 500) };
  }
}

module.exports = { OBSERVATION_SCHEMA, buildArgs, classifyResult, extractObservation, summarize };
