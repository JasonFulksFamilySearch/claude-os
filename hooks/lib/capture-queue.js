'use strict';
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { todayLocal } = require('./episode-utils.js');

function tailHash(transcriptText) {
  return createHash('sha256').update(transcriptText || '').digest('hex');
}

function safeId(sessionId) {
  return (String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '') || 'noid').slice(0, 64);
}

function writeJsonAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  renameSync(tmp, path);
}

// Summarize only when warranted: first success for the session, OR the transcript
// has materially grown (turn-stride) OR materially changed (tail-hash delta) since
// the last success. This converts per-turn Stop firing from a cost bug into a refresh cadence.
function shouldSummarize(record, turnCount, currentTailHash, { stride = 10 } = {}) {
  if (!record || record.turnsAtLastSuccess == null) return true;
  if (currentTailHash !== record.tailHashAtLastSuccess) return true;
  return (turnCount - record.turnsAtLastSuccess) >= stride;
}

function createCaptureQueue({ queueDir, deadLetterDir }) {
  const recPath = (sessionId) => join(queueDir, safeId(sessionId) + '.json');
  const dlPath = (sessionId) => join(deadLetterDir, safeId(sessionId) + '.json');

  function get(sessionId) {
    const p = recPath(sessionId);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  }

  function upsert(sessionId, { transcriptPath, turnCount }) {
    const now = new Date().toISOString();
    const existing = get(sessionId);
    const rec = existing || {
      sessionId, firstSeenDate: todayLocal(), turnsAtLastSuccess: null,
      tailHashAtLastSuccess: null, attempts: 0, lastErrorClass: null, createdAt: now,
    };
    rec.transcriptPath = transcriptPath;
    rec.turnsAtLastAttempt = turnCount;
    rec.updatedAt = now;
    writeJsonAtomic(recPath(sessionId), rec);
    return rec;
  }

  function markSuccess(sessionId, { turnCount, tailHash }) {
    const rec = get(sessionId);
    if (!rec) return;
    rec.turnsAtLastSuccess = turnCount;
    rec.tailHashAtLastSuccess = tailHash;
    rec.attempts = 0;
    rec.lastErrorClass = null;
    rec.updatedAt = new Date().toISOString();
    writeJsonAtomic(recPath(sessionId), rec);
  }

  function deadLetter(sessionId, reason) {
    const rec = get(sessionId) || { sessionId };
    rec.deadLetterReason = reason;
    rec.deadLetteredAt = new Date().toISOString();
    writeJsonAtomic(dlPath(sessionId), rec);
    try { unlinkSync(recPath(sessionId)); } catch { /* already gone */ }
  }

  function recordFailure(sessionId, errorClass, { attemptCap = 3 } = {}) {
    const rec = get(sessionId);
    if (!rec) return { deadLettered: false };
    rec.attempts = (rec.attempts || 0) + 1;
    rec.lastErrorClass = errorClass;
    rec.updatedAt = new Date().toISOString();
    // AUTH is deterministic — dead-letter immediately, do not burn the retry budget.
    if (errorClass === 'AUTH' || rec.attempts >= attemptCap) {
      writeJsonAtomic(recPath(sessionId), rec); // persist the final state before moving
      deadLetter(sessionId, errorClass === 'AUTH' ? 'auth/config failure (deterministic)' : `attempt cap ${attemptCap} reached (${errorClass})`);
      return { deadLettered: true };
    }
    writeJsonAtomic(recPath(sessionId), rec);
    return { deadLettered: false };
  }

  function depth() {
    if (!existsSync(queueDir)) return 0;
    return readdirSync(queueDir).filter(f => f.endsWith('.json')).length;
  }

  function deadLetterStats() {
    if (!existsSync(deadLetterDir)) return { count: 0, oldest: null };
    const files = readdirSync(deadLetterDir).filter(f => f.endsWith('.json'));
    let oldest = null;
    for (const f of files) {
      const m = statSync(join(deadLetterDir, f)).mtimeMs;
      if (oldest == null || m < oldest) oldest = m;
    }
    return { count: files.length, oldest: oldest ? new Date(oldest).toISOString() : null };
  }

  return { upsert, get, markSuccess, recordFailure, deadLetter, depth, deadLetterStats };
}

module.exports = { tailHash, shouldSummarize, createCaptureQueue };
