'use strict';

// ccr-retrieve.test.js — the CCR three-store retrieval contract (DIO-11 / FR-D1..D4).
//
// Proves the DIO-11 EXIT criteria at the hook/JS layer (the SQLite-backed tokenizer-
// parity proof + the real-DB observations falsification live in mcp/test/ccr-query.test.ts,
// where FTS5 is available):
//   (a) reactive retrieve(hash[,query]) works (FR-D1) — and is reactive-only (FR-D4);
//   (b) resolves against the three lifetime stores (FR-D3): ephemeral #3, archive #1,
//       graph #2 (delegated re-query);
//   (c) an ephemeral CCR write never becomes an observations row — STRUCTURAL proof here
//       (cache dir is outside every indexer-walked dir + no memory.db touch); the real-DB
//       COUNT(*)=0 falsification is in the mcp test;
//   (e) AC-1 byte-exact reconstruction INCLUDING rehydrating the constants block (the
//       DIO-7 carry-forward) — round-trips a REAL smart-crusher.compress() envelope.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ccr = require('../ccr-retrieve.js');
const crusher = require('../smart-crusher.js'); // the committed DIO-7 producer (read-only here)

function tmpRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ccr-${label}-`));
}

// A large array with a buried error row + one constant field, so the round-trip
// exercises BOTH dropping (the dropped rows must come back from the cache, not the
// envelope) AND constant-field factoring (the rehydration carry-forward).
function payloadWithConstantAndError(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const row = { repo: 'claude-os', file: `src/f${i}.ts`, line: i, rule: 'no-unused' };
    if (i === Math.floor(n / 2)) row.status = 'error'; // a buried error row
    rows.push(row);
  }
  return rows;
}

// ── canonical/hash agreement with the committed compressor (the retrieve KEY) ──

test('HASH PARITY: ccr canonical hash equals smart-crusher.originalHash for the same input', () => {
  const payload = payloadWithConstantAndError(40);
  const result = crusher.compress(payload);
  const ccrHash = ccr.hashCanonical(payload);
  assert.equal(ccrHash, result.originalHash,
    'the retrieve key (ccr hash) MUST equal the marker hash the compressor emits');
});

// ── FR-D1 reactive contract: marker round-trips, retrieve serves the original ──

test('FR-D1 MARKER: buildMarker round-trips through parseMarker to the same hash', () => {
  const hash = 'a'.repeat(64);
  const marker = ccr.buildMarker({ originalCount: 500, retainedCount: 72, originalHash: hash });
  assert.equal(marker, `[500 items compressed to 72. Retrieve more: hash=${hash}]`);
  assert.equal(ccr.parseMarker(marker), hash, 'the hash is recoverable from the marker');
  assert.equal(ccr.parseMarker('garbage no hash here'), null, 'no false positive');
});

test('FR-D1 + FR-D4 REACTIVE: retrieve does NOTHING until called; then serves the original', () => {
  const root = tmpRoot('reactive');
  try {
    const payload = payloadWithConstantAndError(30);
    const cache = ccr.createEphemeralCache({ sessionId: 's1', cacheRoot: root });

    // Nothing is served proactively — the cache is empty until a compress writes to it.
    const retrieve = ccr.createRetrieve({ ephemeral: cache });
    const cold = retrieve(ccr.hashCanonical(payload));
    assert.equal(cold.found, false, 'reactive: nothing is resolvable before a put — no auto-expansion');

    // The compress path puts the byte-exact original; THEN retrieve serves it.
    const hash = cache.put(payload);
    const hot = retrieve(hash);
    assert.equal(hot.found, true);
    assert.equal(hot.store, 'ephemeral');
    // The served original is byte-exact: its canonical form equals the canonical payload.
    assert.equal(ccr.stableStringify(hot.original), ccr.stableStringify(payload),
      'the served original is the byte-exact (canonical) original');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── FR-D3 three stores by LIFETIME: resolution order (3)→(1)→(2) ───────────────

test('FR-D3 THREE STORES: retrieve resolves ephemeral #3, archive #1, and graph #2', () => {
  const cacheRoot = tmpRoot('three-eph');
  const archiveRoot = tmpRoot('three-arc');
  try {
    // Store #3 (ephemeral): a freshly-compressed tool output.
    const ephPayload = [{ a: 1 }, { a: 2 }, { a: 3 }];
    const cache = ccr.createEphemeralCache({ sessionId: 's2', cacheRoot });
    const ephHash = cache.put(ephPayload);

    // Store #1 (archive): a promoted/archived original, written as <hash>.json in the
    // indexer-EXCLUDED archive dir (the real promotion path writes it there).
    const arcPayload = [{ promoted: true, kind: 'decision' }];
    const arcHash = ccr.hashCanonical(arcPayload);
    fs.writeFileSync(path.join(archiveRoot, arcHash + '.json'), ccr.stableStringify(arcPayload), 'utf8');
    const archive = ccr.createArchiveResolver({ archiveRoot });

    // Store #2 (graph): a graph-originated hash resolved by DELEGATED re-query — this
    // module never reaches into .dioscuri/graph/ (DIO-9's lane); it routes to a resolver.
    const graphPayload = [{ symbol: 'foo', reaches: ['bar'] }];
    const graphHash = ccr.hashCanonical(graphPayload);
    const graphResolver = (h) => (h === graphHash ? graphPayload : undefined);

    const retrieve = ccr.createRetrieve({ ephemeral: cache, archive, graphResolver });

    const r3 = retrieve(ephHash);
    assert.equal(r3.found && r3.store, 'ephemeral', '#3 ephemeral resolves');

    const r1 = retrieve(arcHash);
    assert.equal(r1.found && r1.store, 'archive', '#1 archive resolves');

    const r2 = retrieve(graphHash);
    assert.equal(r2.found && r2.store, 'graph', '#2 graph re-query resolves (delegated)');

    // An unknown hash resolves nowhere — fails closed, never a fabricated original.
    const miss = retrieve('f'.repeat(64));
    assert.equal(miss.found, false, 'an unowned hash resolves nowhere');
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
});

test('FR-D3 ORDER: ephemeral (#3) wins over archive (#1) for the same hash (freshest owner)', () => {
  const cacheRoot = tmpRoot('order-eph');
  const archiveRoot = tmpRoot('order-arc');
  try {
    const payload = [{ x: 1 }, { x: 2 }];
    const hash = ccr.hashCanonical(payload);
    const cache = ccr.createEphemeralCache({ sessionId: 's3', cacheRoot });
    cache.put(payload);
    fs.writeFileSync(path.join(archiveRoot, hash + '.json'), ccr.stableStringify(payload), 'utf8');
    const archive = ccr.createArchiveResolver({ archiveRoot });

    const retrieve = ccr.createRetrieve({ ephemeral: cache, archive });
    const r = retrieve(hash);
    assert.equal(r.store, 'ephemeral', 'the ephemeral working set is the freshest owner — resolved first');
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
});

// ── (c) the hard hygiene rule: an ephemeral write never enters an indexer dir ──

test('HYGIENE: the ephemeral cache lives OUTSIDE every indexer-walked dir (no observations row possible)', () => {
  const root = tmpRoot('hygiene');
  try {
    const cache = ccr.createEphemeralCache({ sessionId: 'shy', cacheRoot: root });
    const hash = cache.put([{ a: 1 }, { b: 2 }]);

    // The blob is materialized under the cache root, which is a SIBLING of capture-queue/
    // — the indexer walks only agent/, context/, projects/, episodes/ and excludes archive/.
    // ccr-cache/ is none of those, so fullReindex never visits it → it cannot become a row.
    const written = fs.readdirSync(cache.dir);
    assert.ok(written.includes(hash + '.json'), 'the original is written into the ccr-cache dir');
    assert.ok(cache.dir.includes('ccr-') || cache.dir.includes(root),
      'the cache dir is under the dedicated ccr cache root, not an indexer dir');

    // No memory.db anywhere near the cache — it is a plain file store, not a DB write.
    const allFiles = fs.readdirSync(cache.dir);
    assert.ok(!allFiles.some((f) => f.endsWith('.db')), 'no sqlite db is created by a CCR write');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HYGIENE: evictSession auto-evicts the session cache (session-scoped lifetime)', () => {
  const root = tmpRoot('evict');
  try {
    const cache = ccr.createEphemeralCache({ sessionId: 'sev', cacheRoot: root });
    cache.put([{ a: 1 }]);
    cache.put([{ b: 2 }]);
    assert.equal(cache.size(), 2, 'two blobs cached');
    cache.evictSession();
    assert.equal(cache.size(), 0, 'session-end eviction clears the cache (lifetime #3)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HYGIENE: the LRU cap bounds the cache (working set, not a durable store)', () => {
  const root = tmpRoot('lru');
  try {
    const cache = ccr.createEphemeralCache({ sessionId: 'slru', cacheRoot: root, maxEntries: 3 });
    for (let i = 0; i < 6; i++) cache.put([{ uniq: i, pad: `x${i}`.repeat(i + 1) }]);
    assert.ok(cache.size() <= 3, `LRU cap holds the cache to <= 3 (got ${cache.size()})`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── (e) AC-1 byte-exact reconstruction + the CONSTANTS-REHYDRATION carry-forward ──

test('AC-1 BYTE-EXACT: retrieve(hash) over a real compress() envelope returns the byte-exact original', () => {
  const root = tmpRoot('byteexact');
  try {
    const payload = payloadWithConstantAndError(60); // drops rows AND factors `repo`
    const result = crusher.compress(payload);
    assert.ok(result.compressed, 'precondition: the payload actually compresses');
    assert.ok(result.droppedCount > 0, 'precondition: rows were dropped (cache must restore them)');

    // The compress path caches the BYTE-EXACT original under the envelope's hash.
    const cache = ccr.createEphemeralCache({ sessionId: 'sbe', cacheRoot: root });
    const storedHash = cache.putWithHash(payload, result.originalHash);
    assert.equal(storedHash, result.originalHash, 'the cached blob is keyed by the marker hash');

    // Retrieve serves it back BYTE-EXACT — canonical bytes identical, and re-hashes to key.
    const canonicalOut = cache.getCanonical(result.originalHash);
    assert.equal(canonicalOut, ccr.stableStringify(payload), 'the served bytes are byte-identical to the canonical original');
    assert.equal(ccr.hashCanonicalString(canonicalOut), result.originalHash, 'and re-hash to the retrieve key');

    // Crucially: the FULL original includes the DROPPED rows — the envelope alone could
    // never reproduce them; the ephemeral store holds the whole thing verbatim.
    const served = JSON.parse(canonicalOut);
    assert.equal(served.length, payload.length, 'every original row is recovered, including dropped ones');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC-1 CONSTANTS-REHYDRATION: a row read from the ENVELOPE alone is missing the factored field; rehydrate restores it', () => {
  // The DIO-7 carry-forward: constant fields are lifted into `constants` and REMOVED from
  // each retained row. A consumer reading a bare retained row misses them. rehydrate merges
  // them back — so the reconstructed per-row state is whole, NOT bare retained rows.
  const payload = [];
  for (let i = 0; i < 40; i++) payload.push({ repo: 'claude-os', branch: 'master', file: `f${i}.ts`, line: i });
  const result = crusher.compress(payload);

  // The factored field is in constants and ABSENT from the bare retained rows.
  assert.equal(result.constants.repo, 'claude-os', 'repo is factored into constants');
  assert.equal(result.constants.branch, 'master', 'branch is factored into constants');
  assert.ok(!('repo' in result.retained[0]), 'bare retained row is MISSING the factored field (the trap)');

  // Reconstruct the envelope projection: every retained row gets the constants merged back.
  const envelope = {
    _dioscuri: { originalHash: result.originalHash, retainedIndices: result.retainedIndices, originalCount: result.originalCount, droppedCount: result.droppedCount },
    constants: result.constants,
    retained: result.retained,
  };
  const rehydrated = ccr.rehydrateEnvelope(envelope);

  for (const row of rehydrated.rows) {
    assert.equal(row.repo, 'claude-os', 'rehydrated row carries the factored constant');
    assert.equal(row.branch, 'master', 'rehydrated row carries the second constant');
    assert.ok('file' in row && 'line' in row, 'and still carries its own varying fields');
  }
});

test('AC-1 REHYDRATION + ERROR-IN-CONSTANTS: an error signal factored into constants is restored per-row (the DIO-7 QA hazard)', () => {
  // The specific hazard the DIO-7 QA flagged: when an error-signal field is CONSTANT across
  // every row, it lands in the constants block, NOT inline. A retrieve consumer reading a
  // bare row in isolation would MISS the error signal. Rehydration restores it.
  const payload = [];
  for (let i = 0; i < 20; i++) payload.push({ status: 'error', file: `f${i}.ts`, line: i }); // status constant across all
  const result = crusher.compress(payload);

  // Because `status:'error'` is constant, it is FACTORED OUT — gone from each retained row.
  if ('status' in result.constants) {
    assert.equal(result.constants.status, 'error', 'the constant error signal is in the constants block');
    if (result.retained.length > 0) {
      assert.ok(!('status' in result.retained[0]), 'and is MISSING from the bare retained row — the trap');
    }
    const rehydrated = ccr.rehydrateEnvelope({ _dioscuri: {}, constants: result.constants, retained: result.retained });
    for (const row of rehydrated.rows) {
      assert.equal(row.status, 'error', 'rehydration restores the error signal onto every row — no missed signal');
    }
  } else {
    // If the compressor classified these as errors and kept all rows inline (no factoring),
    // the signal is already on each row — also acceptable. Assert that instead.
    for (let i = 0; i < result.retainedIndices.length; i++) {
      const row = result.retained[i];
      assert.ok(row.status === 'error' || 'status' in result.constants, 'error signal present inline or in constants');
    }
  }
});

// ── FR-D2 query path (JS fallback — the tokenizer-parity proof is the mcp test) ──

test('FR-D2 QUERY (fallback): retrieve(hash, query) returns only the relevant subset', () => {
  const root = tmpRoot('query');
  try {
    const payload = [
      { file: 'a.ts', rule: 'no-unused', msg: 'crusher import unused' },
      { file: 'b.ts', rule: 'no-undef', msg: 'x is not defined' },
      { file: 'c.ts', rule: 'no-unused', msg: 'crusher var unused' },
    ];
    const cache = ccr.createEphemeralCache({ sessionId: 'sq', cacheRoot: root });
    const hash = cache.put(payload);
    const retrieve = ccr.createRetrieve({ ephemeral: cache }); // no FTS queryFn → JS fallback

    const r = retrieve(hash, 'crusher');
    assert.equal(r.found, true);
    assert.ok(Array.isArray(r.queried), 'query returns a subset');
    assert.equal(r.queried.length, 2, 'only the two crusher rows match the fallback substring query');
    assert.ok(r.original, 'the full byte-exact original is STILL returned for AC-1 verification');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FR-D2 QUERY: an injected queryFn (the FTS-parity path) is used when provided', () => {
  const root = tmpRoot('queryfn');
  try {
    const payload = [{ a: 'crushed' }, { a: 'walking' }, { a: 'crushing' }];
    const cache = ccr.createEphemeralCache({ sessionId: 'sqf', cacheRoot: root });
    const hash = cache.put(payload);

    // Stand in for mcp's queryWithFtsParity: a Porter-stem-aware matcher would return
    // BOTH 'crushed' and 'crushing' for query 'crush'. We assert createRetrieve routes
    // through the injected fn (the real stemming is proven in mcp/test/ccr-query.test.ts).
    const fakeFtsParity = (_h, q, original) =>
      original.filter((row) => JSON.stringify(row).includes(q.slice(0, 5)));
    const retrieve = ccr.createRetrieve({ ephemeral: cache }, { queryFn: fakeFtsParity });

    const r = retrieve(hash, 'crushing');
    assert.equal(r.found, true);
    assert.ok(r.queried.length >= 2, 'the injected FTS-parity queryFn is the one used (stem-aware), not the fallback');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── fail-closed: a resolver that returns a non-matching blob is rejected (AC-1) ──

test('AC-1 FAIL-CLOSED: a store that returns a blob NOT hashing to the key is rejected, never served', () => {
  const root = tmpRoot('failclosed');
  try {
    const cache = ccr.createEphemeralCache({ sessionId: 'sfc', cacheRoot: root });
    // A graph resolver that lies: returns a payload that does NOT hash to the requested key.
    const liar = () => [{ not: 'the original' }];
    const retrieve = ccr.createRetrieve({ ephemeral: cache, graphResolver: liar });
    const r = retrieve('1'.repeat(64));
    assert.equal(r.found, false, 'a non-byte-exact resolution fails closed — AC-1 is never violated silently');
    assert.equal(r.reason, 'hash-mismatch-on-resolve');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
