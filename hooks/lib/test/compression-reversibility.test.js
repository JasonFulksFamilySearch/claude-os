'use strict';

// compression-reversibility.test.js — DIO-8, the AC-1 reversibility verification
// harness for the DIO-7 SmartCrusher (hooks/lib/smart-crusher.js).
//
// AC-1 (PRD §3): "any content this pipeline compresses or drops must be recoverable
// in full." This harness proves AC-1 holds across the compressor by asserting the
// reversibility CONTRACT the compressed envelope must carry, over a representative
// payload set. It is a TEST/HARNESS — it adds NO runtime behavior.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE HONEST SCOPE BOUNDARY (read before scoring — DIO-8 exit criterion (d)).
//
// SmartCrusher is a LOSSY projection: it DROPS droppable rows on purpose (that is
// the point — a 500-row lint result compresses to a representative subset). So the
// compressed envelope ALONE cannot re-materialize the byte-exact original array —
// the dropped rows are not inline. AC-1 reversibility is therefore NOT "every
// dropped row is recoverable from the envelope"; it is "the ORIGINAL is recoverable
// via the marker/retrieve path." This harness proves exactly the three things the
// compressor is responsible for, and names the one thing it is NOT:
//
//   (a) RETAINED + CONSTANTS RECONSTRUCT LOSSLESSLY. Every retained row, rehydrated
//       by merging the factored-out `constants` block back in, is BYTE-EXACT against
//       that row's canonical form in the original. The factoring is proven reversible.
//
//   (b) originalHash IS THE BYTE-EXACT VERIFICATION ANCHOR. `originalHash` is the
//       sha256 of the canonical original array. Recomputing the canonical hash of the
//       reconstructed original MUST equal the stored `originalHash` — so a retrieve
//       path (which holds the original keyed by that hash) can VERIFY byte-exactness.
//       The harness asserts the CONTRACT (hash present + matches the canonical
//       original) rather than re-implementing the store.
//
//   (c) AC-5b RE-ASSERTED AS REVERSIBILITY-OF-SIGNAL. Error / anomaly / boundary rows
//       are NEVER among the dropped rows — they are retained UNCONDITIONALLY. So the
//       signal an audit agent must never lose is always inline-recoverable, not merely
//       retrieve-recoverable. This is AC-1 for the part that matters most.
//
//   WHAT THIS HARNESS DOES NOT DO: it does NOT re-materialize the full original from
//   the envelope alone (impossible by design — dropped rows aren't inline) and does
//   NOT re-implement the DIO-11 CCR retrieve path (the store that holds the original
//   keyed by `originalHash`). Full byte-exact ORIGINAL recovery is the DIO-11 retrieve
//   path's job; DIO-8 proves the envelope carries everything that path needs and that
//   the anchor verifies. The boundary is the same one smart-crusher.js documents at
//   its REVERSIBILITY header and docs/dioscuri-smartcrusher-compression.md §4.
// ─────────────────────────────────────────────────────────────────────────────

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const crusher = require('../smart-crusher.js');

// ── Canonicalization mirrors, INDEPENDENT of the module under test ─────────────
// The harness must verify against an INDEPENDENT notion of "canonical", not by
// calling the compressor's own stableStringify (that would make the test tautological
// — it would prove the compressor agrees with itself, not that recovery is correct).
// These are a deliberately separate, minimal re-implementation of the canonical form.

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function canonicalString(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalHash(value) {
  return createHash('sha256').update(canonicalString(value)).digest('hex');
}

// Reconstruct the canonical form of a single retained row from the compressed
// envelope: merge the factored-out constants back in. This is the rehydration the
// retrieve/read path performs — retained rows are stored WITHOUT the constant fields
// (that is the factoring), so reading a retained row WITHOUT the constants block is
// INCOMPLETE. We prove merging them back is lossless.
function rehydrateRetainedRow(retainedRow, constants) {
  // Non-object retained rows carry no factored fields — they pass through.
  if (!retainedRow || typeof retainedRow !== 'object' || Array.isArray(retainedRow)) {
    return retainedRow;
  }
  // constants ∪ retainedRow. The retained row's own keys win (they never overlap a
  // factored constant key — factoring removes the key from the row — but spell out
  // the precedence so the merge is unambiguous).
  return canonicalize({ ...constants, ...retainedRow });
}

// ── The representative payload set (DIO-8 exit criterion (a)) ───────────────────
// One named builder per payload class the harness must cover: small (sub-floor),
// large, error-bearing, all-constant-field, mixed-type, and unicode.

function payloadSmall() {
  // Under MIN_ROWS_TO_COMPRESS — exercises the passthrough path (compressed:false),
  // where retained === original and reversibility is trivial-but-must-hold.
  return [{ a: 1 }, { b: 'two' }, { c: [3] }];
}

function payloadLarge() {
  // 400 uniform-ish droppable rows — the compressor is free to drop, so this proves
  // reversibility under heavy actual dropping.
  const rows = [];
  for (let i = 0; i < 400; i++) {
    rows.push({ kind: 'lint', file: `src/file${i}.ts`, line: i + 1, rule: `rule-${i % 7}`, ok: true });
  }
  return rows;
}

function payloadErrorBearing() {
  // 300 rows with errors, an anomaly, and numeric boundaries planted — exercises the
  // unconditional-preservation path AND reversibility of the preserved signal.
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push({ kind: 'row', i, label: `L${i}`, score: 5 });
  rows[37] = { kind: 'row', i: 37, label: 'L37', score: 5, error: 'boom: x is not defined' }; // error
  rows[88] = { kind: 'row', i: 88, label: 'L88', score: 5, status: 'failed' };                 // error (status)
  rows[120] = { kind: 'row', i: 120, label: 'L120', score: 5, ODD_EXTRA_FIELD: true };          // anomaly (rare shape)
  rows[201] = { kind: 'row', i: 201, label: 'L201', score: 99999 };                             // boundary (max)
  rows[250] = { kind: 'row', i: 250, label: 'L250', score: -99999 };                            // boundary (min)
  return rows;
}

function payloadAllConstantField() {
  // Every row shares several fields that NEVER vary → maximal constant-field factoring.
  // This is the stress case for constants-block rehydration: most of each row is lifted
  // out, so a retained row read WITHOUT the constants is severely incomplete.
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push({
      repo: 'claude-os',
      branch: 'master',
      schema: 'v3',
      env: 'ci',
      file: `f${i}.ts`, // the only varying field
    });
  }
  return rows;
}

function payloadMixedType() {
  // Heterogeneous rows: objects, arrays, strings, numbers, null, booleans, nested.
  // Exercises projectRow's non-object passthrough and canonicalization of nested data.
  const rows = [];
  for (let i = 0; i < 80; i++) {
    if (i % 6 === 0) rows.push({ tag: 'obj', n: i, nested: { z: i, a: [i, i + 1] } });
    else if (i % 6 === 1) rows.push([i, `arr${i}`, { deep: i }]);
    else if (i % 6 === 2) rows.push(`string-row-${i}`);
    else if (i % 6 === 3) rows.push(i * 1000);
    else if (i % 6 === 4) rows.push(i % 2 === 0 ? null : false);
    else rows.push({ tag: 'obj2', n: i, flag: true, list: [] });
  }
  return rows;
}

function payloadUnicode() {
  // Non-ASCII, emoji, combining marks, and control-adjacent chars — proves the canonical
  // hash + reconstruction survive UTF-8 round-tripping without mangling.
  const rows = [];
  const samples = ['café', 'naïve', '日本語', '😀🚀', 'Źalgo', 'tab\there', 'quote"inside', 'back\\slash'];
  for (let i = 0; i < 50; i++) {
    rows.push({ id: i, text: samples[i % samples.length], note: `entry ${i} — ${samples[(i + 3) % samples.length]}` });
  }
  return rows;
}

const PAYLOADS = Object.freeze({
  small: payloadSmall,
  large: payloadLarge,
  'error-bearing': payloadErrorBearing,
  'all-constant-field': payloadAllConstantField,
  'mixed-type': payloadMixedType,
  unicode: payloadUnicode,
});

// ─────────────────────────────────────────────────────────────────────────────
// (1) BYTE-EXACT RECOVERY via originalHash — over the representative payload set.
//     The originalHash is the verification anchor: a retrieve path that holds the
//     original verifies byte-exactness by recomputing the canonical hash and matching
//     it. We assert that anchor is correct against an INDEPENDENT canonical hash.
// ─────────────────────────────────────────────────────────────────────────────

for (const [name, build] of Object.entries(PAYLOADS)) {
  test(`(1) byte-exact anchor: originalHash matches the canonical hash of the original — [${name}]`, () => {
    const original = build();
    const result = crusher.compress(original);

    // The envelope must carry a sha256 anchor.
    assert.match(result.originalHash, /^[0-9a-f]{64}$/, 'originalHash is a sha256 hex digest');

    // The anchor MUST equal an INDEPENDENTLY-computed canonical hash of the original.
    // This is the byte-exact verification a retrieve path performs: recompute the
    // canonical hash of the recovered original and match the stored anchor.
    const independentHash = canonicalHash(original);
    assert.equal(
      result.originalHash,
      independentHash,
      'originalHash MUST equal the independent canonical hash of the original (the byte-exact anchor)'
    );

    // The anchor is deterministic — the retrieve KEY is stable for identical input.
    assert.equal(crusher.compress(build()).originalHash, result.originalHash, 'anchor is deterministic');
  });
}

test('(1) the anchor verifies byte-exactness: a reconstructed original that hashes to the anchor IS the original', () => {
  // Simulate the retrieve path's verification step end-to-end: the store hands back a
  // candidate "original", the retrieve path recomputes the canonical hash and matches
  // it to the envelope's anchor. A faithful candidate passes; this proves the anchor
  // is a SUFFICIENT byte-exact check (anti-tautology: we hash a SEPARATELY-built copy).
  const original = payloadErrorBearing();
  const result = crusher.compress(original);

  // The "retrieved original" the store would serve — an independent structural copy
  // (rebuilt, then round-tripped through JSON to sever any shared references).
  const retrieved = JSON.parse(JSON.stringify(payloadErrorBearing()));
  assert.equal(
    canonicalHash(retrieved),
    result.originalHash,
    'a byte-faithful retrieved original hashes to the stored anchor — the anchor verifies recovery'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) CONSTANTS-BLOCK REHYDRATION is lossless — over every payload that factors.
//     DIO-7 removes constant fields from each retained row; merging the constants
//     block back MUST reconstruct each retained row byte-exactly against the original.
//     The awareness item: a retained row read WITHOUT the constants block is INCOMPLETE.
// ─────────────────────────────────────────────────────────────────────────────

for (const [name, build] of Object.entries(PAYLOADS)) {
  test(`(2) constants rehydration is lossless: every retained row recovers byte-exactly — [${name}]`, () => {
    const original = build();
    const result = crusher.compress(original);

    // Canonical form of each ORIGINAL row, indexed — our independent ground truth.
    const canonicalOriginalRows = original.map((row) => canonicalString(row));

    for (let k = 0; k < result.retainedIndices.length; k++) {
      const originalIndex = result.retainedIndices[k];
      const retainedRow = result.retained[k];

      // Rehydrate: merge the constants block back into the retained row.
      const rehydrated = rehydrateRetainedRow(retainedRow, result.constants);

      // The rehydrated row MUST be byte-exact against the original row (canonical form).
      assert.equal(
        canonicalString(rehydrated),
        canonicalOriginalRows[originalIndex],
        `retained row at original index ${originalIndex} must rehydrate byte-exactly`
      );
    }
  });
}

test('(2) AWARENESS ITEM: a retained row read WITHOUT the constants block is INCOMPLETE when fields were factored', () => {
  // Proves the flagged awareness item is real: when factoring happened, reading the
  // retained row alone (no constants merge) does NOT equal the original row — the
  // constants block is load-bearing for completeness, not optional.
  const original = payloadAllConstantField();
  const result = crusher.compress(original);

  // This payload class factors heavily — assert factoring actually happened.
  assert.ok(Object.keys(result.constants).length > 0, 'sanity: constant fields were factored out');

  const canonicalOriginalRows = original.map((row) => canonicalString(row));
  let foundIncompleteWithoutConstants = false;

  for (let k = 0; k < result.retainedIndices.length; k++) {
    const originalIndex = result.retainedIndices[k];
    const retainedRow = result.retained[k];

    // WITHOUT the constants merge, the retained row is missing the factored fields.
    const withoutConstants = canonicalString(retainedRow);
    if (withoutConstants !== canonicalOriginalRows[originalIndex]) {
      foundIncompleteWithoutConstants = true;
    }
    // WITH the constants merge, it is complete (the lossless half).
    const withConstants = canonicalString(rehydrateRetainedRow(retainedRow, result.constants));
    assert.equal(withConstants, canonicalOriginalRows[originalIndex], 'WITH constants → complete');
  }

  assert.ok(
    foundIncompleteWithoutConstants,
    'a factored retained row read WITHOUT the constants block IS incomplete (the awareness item is real)'
  );
});

test('(2) rehydration is lossless even when NO fields are factored (constants block empty)', () => {
  // A payload whose rows share no constant field → constants = {} → rehydration is the
  // identity. Reversibility must still hold (no field silently dropped under no-factoring).
  const original = payloadMixedType();
  const result = crusher.compress(original);

  const canonicalOriginalRows = original.map((row) => canonicalString(row));
  for (let k = 0; k < result.retainedIndices.length; k++) {
    const originalIndex = result.retainedIndices[k];
    const rehydrated = rehydrateRetainedRow(result.retained[k], result.constants);
    assert.equal(
      canonicalString(rehydrated),
      canonicalOriginalRows[originalIndex],
      `mixed-type retained row at ${originalIndex} recovers byte-exactly`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) THE DROPPED ROWS + AC-5b (reversibility-of-signal). SmartCrusher drops rows by
//     design; AC-1 covers the original via retrieve, not every dropped row inline.
//     But the SIGNAL rows (error/anomaly/boundary) are NEVER dropped — re-assert AC-5b
//     here as the reversibility guarantee that matters most for an audit agent.
// ─────────────────────────────────────────────────────────────────────────────

for (const [name, build] of Object.entries(PAYLOADS)) {
  test(`(3) AC-5b re-assert: NO error/anomaly/boundary row is among the dropped — [${name}]`, () => {
    const original = build();
    const result = crusher.compress(original);
    const retained = new Set(result.retainedIndices);

    // Every classified signal row MUST be retained — i.e. never dropped.
    for (let i = 0; i < original.length; i++) {
      if (result.verdicts[i] !== 'droppable') {
        assert.ok(
          retained.has(i),
          `row ${i} (${result.verdicts[i]}) MUST be retained — signal is never dropped (AC-5b / reversibility-of-signal)`
        );
      }
    }
  });
}

test('(3) AC-5b: the dropped set contains ONLY droppable rows (the inverse containment)', () => {
  // The complement view: assert that every DROPPED index was classified droppable.
  // Together with the test above this is the full AC-5b partition — signal ⊆ retained,
  // dropped ⊆ droppable.
  const original = payloadErrorBearing();
  const result = crusher.compress(original);
  const retained = new Set(result.retainedIndices);

  let droppedCount = 0;
  for (let i = 0; i < original.length; i++) {
    if (!retained.has(i)) {
      droppedCount++;
      assert.equal(
        result.verdicts[i],
        'droppable',
        `dropped row ${i} MUST have been classified droppable — no signal row is ever dropped`
      );
    }
  }
  assert.equal(droppedCount, result.droppedCount, 'droppedCount matches the actual dropped set');
  assert.ok(droppedCount > 0, 'sanity: this payload actually dropped rows (preservation is not vacuous)');
});

test('(3) the planted error/anomaly/boundary rows are recoverable INLINE (not merely via retrieve)', () => {
  // The signal rows are retained, so their full content recovers from the envelope
  // directly — no retrieve round-trip needed for the part an audit agent must not lose.
  const original = payloadErrorBearing();
  const result = crusher.compress(original);

  const canonicalOriginalRows = original.map((row) => canonicalString(row));
  for (const idx of [37, 88, 120, 201, 250]) {
    assert.notEqual(result.verdicts[idx], 'droppable', `planted row ${idx} is classified signal`);
    const k = result.retainedIndices.indexOf(idx);
    assert.ok(k >= 0, `planted signal row ${idx} is retained`);
    const rehydrated = rehydrateRetainedRow(result.retained[k], result.constants);
    assert.equal(
      canonicalString(rehydrated),
      canonicalOriginalRows[idx],
      `planted signal row ${idx} recovers byte-exactly inline`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) INTEGRATION through the REAL committed seam. Drive a payload through the
//     posttooluse-content-router.js compression handler and assert the
//     updatedToolOutput envelope carries the reversibility markers end-to-end.
//     (Optional per the ticket — included because it proves the markers survive the
//     seam serialization, which is where a real retrieve path reads them.)
// ─────────────────────────────────────────────────────────────────────────────

const router = require('../../posttooluse-content-router.js');

const postToolUseEvent = (response) =>
  JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: {},
    tool_response: response,
  });

test('(4) integration: the seam envelope carries the reversibility markers end-to-end', () => {
  const original = payloadErrorBearing();
  const out = router.route(router.normalizeInput(postToolUseEvent(JSON.stringify(original))));
  assert.ok(out, 'a large array produces a seam emission');

  const envelope = JSON.parse(out.hookSpecificOutput.updatedToolOutput);
  const dio = envelope._dioscuri;

  // The reversibility anchor + retrieve-path inputs are all present on the envelope.
  assert.equal(dio.compressed, true, 'envelope marks itself compressed');
  assert.match(dio.originalHash, /^[0-9a-f]{64}$/, 'originalHash present on the envelope');
  assert.equal(dio.originalCount, original.length, 'originalCount present and correct');
  assert.equal(dio.droppedCount + dio.retainedIndices.length, original.length, 'dropped + retained = original count');
  assert.match(
    dio.marker,
    /^\[\d+ items compressed to \d+\. Retrieve more: hash=[0-9a-f]{64}\]$/,
    'CCR-style retrieval marker carries the recover hash'
  );

  // The marker's hash equals the anchor (a retrieve path keys the store by exactly this).
  const markerHash = dio.marker.match(/hash=([0-9a-f]{64})\]$/)[1];
  assert.equal(markerHash, dio.originalHash, 'marker hash === originalHash (one retrieve key)');

  // And the anchor on the seam envelope matches the INDEPENDENT canonical hash of the
  // original — byte-exact recovery is verifiable from the seam output, not just the engine.
  assert.equal(dio.originalHash, canonicalHash(original), 'seam envelope anchor matches independent canonical hash');
});

test('(4) integration: constants rehydration is lossless from the SEAM envelope', () => {
  const original = payloadAllConstantField();
  const out = router.route(router.normalizeInput(postToolUseEvent(JSON.stringify(original))));
  const envelope = JSON.parse(out.hookSpecificOutput.updatedToolOutput);

  const canonicalOriginalRows = original.map((row) => canonicalString(row));
  const { constants, retained } = envelope;
  const retainedIndices = envelope._dioscuri.retainedIndices;

  for (let k = 0; k < retainedIndices.length; k++) {
    const idx = retainedIndices[k];
    const rehydrated = rehydrateRetainedRow(retained[k], constants);
    assert.equal(
      canonicalString(rehydrated),
      canonicalOriginalRows[idx],
      `seam: retained row at original index ${idx} rehydrates byte-exactly`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (5) ANTI-TAUTOLOGY — the harness can FAIL. Plant a CORRUPTED reconstruction and
//     confirm each reversibility assertion catches it. A test that cannot fail proves
//     nothing; DIO-8 exit criterion (e) requires this guard.
// ─────────────────────────────────────────────────────────────────────────────

test('(5) anti-tautology: a corrupted reconstruction FAILS the byte-exact anchor check', () => {
  const original = payloadLarge();
  const result = crusher.compress(original);

  // Corrupt one row of a "recovered original" candidate — flip a value.
  const corrupted = JSON.parse(JSON.stringify(original));
  corrupted[5].rule = 'TAMPERED-VALUE';

  // The anchor MUST reject it — its canonical hash no longer matches.
  assert.notEqual(
    canonicalHash(corrupted),
    result.originalHash,
    'a corrupted reconstruction MUST NOT hash to the anchor — the check has teeth'
  );

  // And the faithful copy still matches (the check is not just always-false).
  assert.equal(canonicalHash(JSON.parse(JSON.stringify(original))), result.originalHash, 'faithful copy still verifies');
});

test('(5) anti-tautology: a corrupted constants rehydration FAILS the byte-exact row check', () => {
  const original = payloadAllConstantField();
  const result = crusher.compress(original);
  const canonicalOriginalRows = original.map((row) => canonicalString(row));

  // Corrupt the constants block — a wrong constant value poisons every rehydration.
  const corruptedConstants = { ...result.constants };
  const someKey = Object.keys(corruptedConstants)[0];
  corruptedConstants[someKey] = 'WRONG-CONSTANT';

  // At least one rehydrated row must now MISMATCH the original — proving the check
  // catches a bad rehydration rather than passing vacuously.
  let caughtMismatch = false;
  for (let k = 0; k < result.retainedIndices.length; k++) {
    const idx = result.retainedIndices[k];
    const badRehydrated = canonicalString(rehydrateRetainedRow(result.retained[k], corruptedConstants));
    if (badRehydrated !== canonicalOriginalRows[idx]) caughtMismatch = true;
  }
  assert.ok(caughtMismatch, 'a corrupted constants block MUST break byte-exact rehydration — the check has teeth');
});

test('(5) anti-tautology: a dropped SIGNAL row would FAIL the AC-5b containment check', () => {
  // Simulate the failure AC-5b guards against: a verdict marks a row as signal, but it
  // is absent from the retained set. The containment assertion MUST flag it. We model
  // the broken output by removing a known signal index from the retained set and
  // re-running the same containment logic the (3) tests use.
  const original = payloadErrorBearing();
  const result = crusher.compress(original);

  // Build a TAMPERED retained set that drops a real error row (index 37).
  assert.notEqual(result.verdicts[37], 'droppable', 'index 37 is a signal row');
  const tampered = new Set(result.retainedIndices);
  tampered.delete(37);

  // The containment check must now find a violation.
  let violationFound = false;
  for (let i = 0; i < original.length; i++) {
    if (result.verdicts[i] !== 'droppable' && !tampered.has(i)) violationFound = true;
  }
  assert.ok(violationFound, 'dropping a signal row MUST trip the AC-5b containment check — the check has teeth');
});
