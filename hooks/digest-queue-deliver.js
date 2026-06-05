'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const QUEUE_PATH = path.join(os.homedir(), '.claude-data', 'digest-queue.jsonl');
const LOCK_PATH = QUEUE_PATH + '.lock';
const LOCK_TTL_MS = 60000;

/**
 * Removes a stale lock file if its mtime is older than LOCK_TTL_MS.
 * Swallows all errors (stat race, already removed, etc.).
 */
function removeStaleLock(lockPath) {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > LOCK_TTL_MS) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // ENOENT means it's already gone; any other error is also safe to ignore here.
  }
}

/**
 * Tries to atomically create the lock file using exclusive-create.
 * Removes stale locks (mtime > LOCK_TTL_MS) before attempting.
 *
 * Returns true if the lock was acquired, false if already held (EEXIST).
 * Throws on unexpected errors.
 */
function acquireLock(lockPath = LOCK_PATH) {
  removeStaleLock(lockPath);
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Removes the lock file. Swallows all errors (already gone, etc.).
 */
function releaseLock(lockPath = LOCK_PATH) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Swallow — idempotent release.
  }
}

/**
 * Atomically reads and clears the digest queue.
 *
 * Returns null when:
 *   - The queue file does not exist.
 *   - The queue file is empty.
 *   - The lock is currently held by another process.
 *
 * Otherwise returns an array of parsed entry objects. Malformed JSON lines
 * are skipped rather than thrown.
 *
 * Note: writers (appendDigestEntry) do not acquire this lock before appending.
 * This is an accepted limitation — see digest-queue-write.js for the rationale.
 * The writer-during-delivery race is not a normal operational scenario given the
 * architecturally sequential relationship between background job completion and
 * interactive session start.
 */
function deliverAndClearQueue(queuePath = QUEUE_PATH, lockPath = LOCK_PATH) {
  if (!fs.existsSync(queuePath)) return null;

  if (!acquireLock(lockPath)) return null;

  try {
    let raw;
    try {
      raw = fs.readFileSync(queuePath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }

    if (!raw.trim()) {
      // Empty file — nothing to deliver.
      return null;
    }

    // Clear the file while still holding the lock.
    fs.writeFileSync(queuePath, '', 'utf8');

    const entries = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // Malformed line — skip it.
      }
    }

    return entries;
  } finally {
    releaseLock(lockPath);
  }
}

module.exports = {
  acquireLock,
  releaseLock,
  deliverAndClearQueue,
  QUEUE_PATH,
  LOCK_PATH,
  LOCK_TTL_MS,
};
