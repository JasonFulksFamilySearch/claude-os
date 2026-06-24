'use strict';

/**
 * digest-cloud-guard — the runtime half of the `cloud_allowed` contract.
 *
 * WHY this exists (and why it lives HERE, not at the `/schedule` create path):
 *   `cloud_allowed: false` is DECLARED in config/digest-config.json for the
 *   write-capable digest (merge-progression), but the actual cloud scheduler is
 *   Claude Code's BUILT-IN `/schedule` skill — code this repo does not own and
 *   cannot patch a pre-check into. There is also no repo-local dispatcher in front
 *   of it. So the contract cannot be enforced AT the create path; it is enforced at
 *   the two layers this repo DOES own:
 *     (1) here — a pure classifier the skill body calls to self-abort a cloud run, and
 *     (2) a config-shape test (bin/test/digest-config-contract.test.js) that pins the
 *         write-capable digest to cloud_allowed:false so the flag cannot silently drift.
 *
 * The classifier takes a RESOLVED agent block (already selected by skill + agent
 * name from digest-config.json), so it is pure and trivially testable — no I/O.
 */

/**
 * isCloudSchedulable(block) → boolean.
 *
 * Rule, mirroring the two schema block shapes:
 *   • read-only digests have NO `cloud_allowed` key → cloud-safe by construction →
 *     ABSENCE means schedulable (true).
 *   • `cloud_allowed: false` → write-capable, must not run unattended → false.
 *   • `cloud_allowed: true`  → explicit opt-in for a future cloud-portable variant → true.
 *   • a null/undefined/non-object block → fail CLOSED (false): an unresolved block must
 *     never be treated as cloud-safe, so a config typo cannot green-light a cloud run.
 */
function isCloudSchedulable(block) {
  if (!block || typeof block !== 'object') return false;
  // Absent key ⇒ read-only/cloud-safe ⇒ schedulable. Present ⇒ honor the boolean.
  return block.cloud_allowed === undefined ? true : block.cloud_allowed === true;
}

/**
 * assertCloudSchedulable(block, skill) — throws if the skill must not be scheduled
 * as a cloud routine. The thrown message names the skill and cites `cloud_allowed`
 * so the failure is self-explanatory in a digest error entry or a log line.
 */
function assertCloudSchedulable(block, skill) {
  if (!isCloudSchedulable(block)) {
    throw new Error(
      `${skill}: cloud_allowed is false (or block unresolved) — this skill is LOCAL-ONLY and ` +
      'must not run as an unattended cloud routine. It runs on the local launchd schedule. ' +
      'See config/digest-config.json and bin/digest-cloud-guard.js.',
    );
  }
}

module.exports = { isCloudSchedulable, assertCloudSchedulable };
