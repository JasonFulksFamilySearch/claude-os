'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const QUEUE_PATH = path.join(os.homedir(), '.claude-data', 'digest-queue.jsonl');

// Writers do not acquire the delivery lock. This is safe because background skills
// write at job completion and delivery happens at session start — these are
// architecturally sequential. A concurrent write during the deliver window would
// require a background job to overlap an interactive session start, which is not
// a normal operational scenario.
function appendDigestEntry(entry, queuePath = QUEUE_PATH) {
  const line = JSON.stringify({ ...entry, run_at: new Date().toISOString() }) + '\n';
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.appendFileSync(queuePath, line, 'utf8');
}

module.exports = { appendDigestEntry, QUEUE_PATH };
