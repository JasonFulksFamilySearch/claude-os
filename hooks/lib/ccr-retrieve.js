'use strict';

/**
 * ccr-retrieve.js — the CCR three-store retrieval contract (DIO-11 / FR-D1..D4).
 *
 * The reactive half of Headroom's CCR (Compress → Cache → Retrieve) pattern, the
 * downstream consumer of the DIO-7 SmartCrusher envelope. DIO-7 compresses a JSON
 * array and emits a marker (`[N items compressed to M. Retrieve more: hash=...]`)
 * carrying `originalHash` + `retainedIndices` + `constants`; DIO-11 is the path that
 * SERVES the byte-exact original back when the agent reactively asks for it.
 *
 * REACTIVE, not proactive (FR-D4). There is NO Context Tracker auto-expansion here:
 * nothing injects un-asked-for content. The contract is strictly pull — the agent
 * sees the marker, calls `retrieve(hash[, query])`, and only then is the original
 * resolved and served. This is the deliberate v1 scope (PRD §4 FR-D4; brief v2 §6).
 *
 * ── THREE STORES BY LIFETIME (FR-D3 — the Gate-2 resolution) ──────────────────
 * `retrieve(hash)` resolves against three stores SEPARATED BY LIFETIME, not by
 * mutability. The store that owns a hash is found by ASKING each in lifetime order:
 *
 *   (1) PROMOTED DURABLE MEMORY — already-archived originals, in the indexer-EXCLUDED
 *       on-disk `archive/` dir (`indexer.ts:59` returns null for anything under it).
 *       No TTL; archive-before-delete pruning governs lifetime. A retrieve for
 *       already-promoted content resolves here by reading the archived file.
 *   (2) `.dioscuri/graph/` — rebuildable, per-repo, throwaway graph index. Graph-query
 *       originals are resolved by RE-QUERY, not by storage. DIO-9 owns the graph;
 *       this module exposes a delegation seam (`graphResolver`) so a graph-originated
 *       hash routes to the re-query path without this file reaching into DIO-9's code.
 *   (3) EPHEMERAL SESSION-SCOPED CCR CACHE — the live working set. Holds the byte-exact
 *       original of a freshly-compressed tool output FOR THE SESSION ONLY, content-hash
 *       keyed, auto-evicted at session end / LRU-capped, materialized OUTSIDE any
 *       indexer-watched dir (a sibling of `capture-queue/`, under `ccr-cache/`). This is
 *       store #3 — a third LIFETIME, not a third durable cache.
 *
 * Resolution order is (3) → (1) → (2): the ephemeral cache is the freshest and most
 * likely owner of a just-compressed tool output; the archive owns promoted content;
 * the graph is the re-query fallback. The first store that returns the original wins.
 *
 * ── THE HARD HYGIENE RULE (FR-D3 — eval-pollution AND AC-4, one boundary) ─────
 * An ephemeral CCR write MUST NOT become an `observations` row. It is materialized in
 * `~/.claude-data/ccr-cache/`, which the indexer NEVER walks (it walks only agent/,
 * context/, projects/, episodes/, and explicitly excludes archive/). No FTS table,
 * no sqlite-vec, no `memory.db` write — a plain file cache. Falsification (the test
 * proves it): after a CCR write, `SELECT COUNT(*) FROM observations WHERE source_path
 * LIKE '%<ccr-hash>%'` = 0 AND the eval baseline `file_set_hash` is unchanged.
 *
 * ── AC-1 REVERSIBILITY + the CONSTANTS-REHYDRATION rule (carry-forward from DIO-7 QA) ──
 * `retrieve(hash)` returns the BYTE-EXACT original. The ephemeral store holds the
 * canonical original verbatim, so byte-exactness is trivial there. But a retrieve
 * consumer that reads the *compressed envelope's* retained rows in ISOLATION would be
 * WRONG: DIO-7 factors fields constant across every row into a `constants` block and
 * REMOVES them from each retained row. A row read bare is missing those fields — and
 * if an error-signal field was constant across all rows, that signal is in `constants`,
 * NOT on the row. So `rehydrate(envelope)` MERGES the constants block back into every
 * retained row before returning — never bare retained rows. `verifyAgainstHash()`
 * confirms the reconstructed original hashes to the envelope's `originalHash`.
 */

const { createHash } = require('node:crypto');
const {
  readFileSync, writeFileSync, renameSync, mkdirSync, existsSync,
  readdirSync, unlinkSync, statSync,
} = require('node:fs');
const { join, dirname } = require('node:path');
const { homedir } = require('node:os');

// ── Canonical serialization — MUST match smart-crusher.js byte-for-byte ───────
// The hash a retrieve resolves against is sha256 over the SmartCrusher canonical
// form (recursively key-sorted JSON). We re-implement it here rather than import
// smart-crusher.js so this module has no dependency on the committed compressor —
// but the two MUST agree, which the cross-module test asserts (ccr-retrieve.test.js
// hashes via smart-crusher and resolves via this module).
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}

function hashCanonical(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

// A hash from an already-canonical STRING (the form smart-crusher hashed). Used when
// verifying a reconstructed original that is already in canonical string form.
function hashCanonicalString(canonicalString) {
  return createHash('sha256').update(canonicalString).digest('hex');
}

// ── The retrieval marker (FR-D1) ──────────────────────────────────────────────
// The summary line injected next to the compressed payload. Byte-identical to the
// marker DIO-7 already emits on the envelope (`buildCompressedEnvelope`), so the
// agent sees ONE consistent marker and `parseMarker` can read either source.
function buildMarker({ originalCount, retainedCount, originalHash }) {
  return `[${originalCount} items compressed to ${retainedCount}. Retrieve more: hash=${originalHash}]`;
}

// Extract the hash from a marker string. Returns the sha256 hex or null. Tolerant of
// surrounding prose so it works whether the marker is standalone or embedded.
function parseMarker(markerString) {
  if (typeof markerString !== 'string') return null;
  const m = markerString.match(/hash=([0-9a-f]{64})/);
  return m ? m[1] : null;
}

// ── Constants rehydration (the DIO-7 carry-forward — LOAD-BEARING) ────────────
/**
 * Merge the factored-out `constants` block back into each retained row, reconstructing
 * full per-row state. DIO-7 REMOVES constant fields from retained rows; a consumer
 * reading a bare row would miss any field that was constant across the array —
 * INCLUDING an error-signal field that happened to be constant (the DIO-7 QA warning).
 *
 * Merge order: the row's OWN value wins over the constant. In practice a retained row
 * never carries a key that is also in `constants` (DIO-7 strips exactly those keys), so
 * the union is clean; the row-wins rule is defensive, not expected to fire. Non-object
 * rows (primitives, arrays) pass through unchanged — constants only apply to object rows.
 *
 * Returns rehydrated COPIES; never mutates the envelope's rows in place.
 */
function rehydrateRows(retained, constants) {
  const c = constants && typeof constants === 'object' ? constants : {};
  return retained.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    // constants first, then the row's own fields — so the row wins on any collision.
    return { ...c, ...row };
  });
}

/**
 * Reconstruct the full retained projection of the original from a DIO-7 compressed
 * envelope: rehydrate every retained row with the constants block. This is what a
 * retrieve path returns when it has ONLY the compressed envelope (no cached original)
 * — the recoverable projection, never bare retained rows.
 *
 * NOTE: this is the RETAINED-projection reconstruction (the rows DIO-7 kept, made
 * whole). The BYTE-EXACT FULL original (including dropped rows) comes from the
 * ephemeral cache / archive, which hold it verbatim — see `retrieve()`. The envelope
 * alone cannot reproduce dropped rows; that is exactly why store #3 exists.
 */
function rehydrateEnvelope(envelope) {
  const dio = (envelope && envelope._dioscuri) || {};
  const retained = Array.isArray(envelope && envelope.retained) ? envelope.retained : [];
  const constants = (envelope && envelope.constants) || {};
  return {
    rows: rehydrateRows(retained, constants),
    originalHash: dio.originalHash || null,
    retainedIndices: Array.isArray(dio.retainedIndices) ? dio.retainedIndices : [],
    originalCount: dio.originalCount,
    droppedCount: dio.droppedCount,
  };
}

// ── Store #3: the ephemeral session-scoped CCR cache (FR-D3) ──────────────────
// Content-hash keyed, session-scoped, auto-evicted, LRU-capped, file-backed under
// ~/.claude-data/ccr-cache/<sessionId>/. OUTSIDE every indexer-watched dir — a sibling
// of capture-queue/. The hygiene rule (never an observations row) holds structurally:
// the indexer does not walk this dir, and nothing here touches memory.db.

const DEFAULT_CACHE_ROOT = join(homedir(), '.claude-data', 'ccr-cache');

// LRU cap: how many original blobs a single session's cache may hold before the
// least-recently-used is evicted. Mirrors the size-cap posture of the capture buffer
// (session-observer-worker MAX_CHARS) — a working set, not a durable store.
const DEFAULT_MAX_ENTRIES = 256;

function safeId(id) {
  return (String(id).replace(/[^a-zA-Z0-9_-]/g, '') || 'noid').slice(0, 64);
}

function writeFileAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

/**
 * Create an ephemeral CCR cache bound to one session. The store is the THIRD lifetime
 * class: it lives only as long as the session, is content-hash keyed, and is auto-
 * evicted at session end (`evictSession`) / LRU-capped on write.
 *
 * @param {object} opts
 * @param {string} opts.sessionId   the session this cache is scoped to
 * @param {string} [opts.cacheRoot] override the root (tests use a temp dir)
 * @param {number} [opts.maxEntries] LRU cap (default 256)
 */
function createEphemeralCache({ sessionId, cacheRoot = DEFAULT_CACHE_ROOT, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const dir = join(cacheRoot, safeId(sessionId));
  const blobPath = (hash) => join(dir, hash + '.json');

  function has(hash) {
    return /^[0-9a-f]{64}$/.test(hash) && existsSync(blobPath(hash));
  }

  // Store the BYTE-EXACT canonical original under its content hash. The value written
  // is the canonical JSON string (the exact bytes smart-crusher hashed) so retrieval is
  // byte-exact AND self-verifying. Returns the hash (the retrieve key).
  function put(original) {
    const canonical = stableStringify(original);
    const hash = hashCanonicalString(canonical);
    writeFileAtomic(blobPath(hash), canonical);
    enforceLru();
    return hash;
  }

  // Store a value whose hash was already computed by the compressor (the common path:
  // the envelope carries originalHash). We re-canonicalize to guarantee the stored
  // bytes match that hash; a mismatch means the caller passed a non-original and is a
  // programming error surfaced here rather than silently caching a wrong blob.
  function putWithHash(original, expectedHash) {
    const canonical = stableStringify(original);
    const actual = hashCanonicalString(canonical);
    if (expectedHash && actual !== expectedHash) {
      throw new Error(`CCR put hash mismatch: envelope claimed ${expectedHash} but original hashes to ${actual}`);
    }
    writeFileAtomic(blobPath(actual), canonical);
    enforceLru();
    return actual;
  }

  // Return the byte-exact original (parsed) for a hash, or undefined if not cached.
  // Touches the blob's mtime so LRU treats a read as recent use.
  function get(hash) {
    if (!has(hash)) return undefined;
    const p = blobPath(hash);
    const canonical = readFileSync(p, 'utf8');
    // Verify on read: the stored bytes MUST still hash to the key (tamper/corruption
    // guard). A retrieve that cannot prove byte-exactness returns undefined, not a lie.
    if (hashCanonicalString(canonical) !== hash) return undefined;
    touch(p);
    return JSON.parse(canonical);
  }

  // Return the raw canonical STRING (the exact stored bytes) — used by the byte-exact
  // assertion path so the test can compare bytes, not just parsed structure.
  function getCanonical(hash) {
    if (!has(hash)) return undefined;
    const canonical = readFileSync(blobPath(hash), 'utf8');
    if (hashCanonicalString(canonical) !== hash) return undefined;
    return canonical;
  }

  function touch(p) {
    try {
      const now = new Date();
      // mtime/atime bump for LRU recency. Best-effort; never throw on a touch.
      require('node:fs').utimesSync(p, now, now);
    } catch { /* recency is best-effort */ }
  }

  // LRU eviction: keep at most maxEntries blobs, dropping the least-recently-modified.
  function enforceLru() {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
    if (files.length <= maxEntries) return;
    const byAge = files
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => a.m - b.m); // oldest first
    const toDrop = byAge.slice(0, files.length - maxEntries);
    for (const { f } of toDrop) {
      try { unlinkSync(join(dir, f)); } catch { /* already gone */ }
    }
  }

  // Auto-eviction at session end: remove the whole session cache dir. Idempotent.
  function evictSession() {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      try { unlinkSync(join(dir, f)); } catch { /* already gone */ }
    }
    try { require('node:fs').rmdirSync(dir); } catch { /* non-empty or gone */ }
  }

  function size() {
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f)).length;
  }

  return { dir, has, put, putWithHash, get, getCanonical, evictSession, size };
}

// ── Store #1: promoted/archived originals (FR-D3 store 1) ─────────────────────
// Already-archived originals live in the indexer-EXCLUDED archive/ dir. This resolver
// reads a byte-exact original from there by hash. The archive's own layout is keyed by
// (source_path, anchor), NOT by hash (db.ts:52 — that is WHY it can't serve retrieve(hash)
// for an arbitrary ephemeral original, the Gate-2 finding), so a CCR archive resolver is
// given an explicit hash→path index (or a directory it content-hashes on read). Here we
// resolve by reading any archived blob and matching its content hash — the archive owns
// PROMOTED content, a small set, so a content-hash scan is acceptable and keeps this
// resolver from depending on the archive's internal key.

const DEFAULT_ARCHIVE_ROOT = join(homedir(), '.claude-data', 'archive');

/**
 * Build a resolver that serves a byte-exact archived original by hash. The archive is
 * the indexer-EXCLUDED durable store (store #1); reading from it is AC-4-clean by
 * construction (it is never an observations row — indexer.ts:59 excludes it).
 *
 * Resolution: a hash→canonical-file map is built lazily by content-hashing the archive's
 * `.json` blobs. Promoted content is a bounded set, so this is cheap; it avoids coupling
 * to the archive's (source_path, anchor) key. Returns undefined if the hash is not
 * archived (then retrieve falls through to the graph re-query).
 */
function createArchiveResolver({ archiveRoot = DEFAULT_ARCHIVE_ROOT } = {}) {
  function findCanonical(hash) {
    if (!/^[0-9a-f]{64}$/.test(hash) || !existsSync(archiveRoot)) return undefined;
    // Walk one level; archived CCR originals are written as <hash>.json by the promotion
    // path. Fast path: a file literally named <hash>.json. Slow path: content-hash scan.
    const direct = join(archiveRoot, hash + '.json');
    if (existsSync(direct)) {
      const canonical = readFileSync(direct, 'utf8');
      if (hashCanonicalString(canonical) === hash) return canonical;
    }
    return undefined;
  }
  return {
    has: (hash) => findCanonical(hash) !== undefined,
    getCanonical: (hash) => findCanonical(hash),
    get: (hash) => {
      const c = findCanonical(hash);
      return c === undefined ? undefined : JSON.parse(c);
    },
  };
}

// ── The reactive retrieve contract (FR-D1, FR-D4) ─────────────────────────────
/**
 * Build the CCR retrieve capability over the three lifetime stores. This is the handle
 * the agent calls: `retrieve(hash[, query])`. REACTIVE only — it does nothing until
 * called (FR-D4: no proactive Context Tracker auto-expansion).
 *
 * @param {object} stores
 * @param {object} stores.ephemeral   store #3 — createEphemeralCache(...) instance
 * @param {object} [stores.archive]   store #1 — createArchiveResolver(...) instance
 * @param {(hash:string, query?:string)=>(any|undefined)} [stores.graphResolver]
 *        store #2 — DIO-9's graph re-query seam. Given a graph-originated hash, returns
 *        the re-queried original (or undefined). DELEGATED — this module does not reach
 *        into .dioscuri/graph/ itself (that is DIO-9's lane).
 * @param {(hash:string, query:string, original:any)=>any} [queryFn]
 *        the FR-D2 query path. Given the resolved original and a query, returns the
 *        relevant subset. The SQLite/FTS tokenizer-parity implementation lives in
 *        mcp/src/ccr-query.ts (FTS5 is only available there); a JS fallback is provided
 *        for the no-SQLite hook environment. Injected so the caller wires the right one.
 */
function createRetrieve({ ephemeral, archive, graphResolver } = {}, { queryFn } = {}) {
  if (!ephemeral) throw new Error('createRetrieve requires an ephemeral store (#3)');

  /**
   * retrieve(hash[, query]) — resolve and serve the byte-exact original from the store
   * that owns it by lifetime, then optionally narrow it with `query`.
   *
   * Resolution order (3) ephemeral → (1) archive → (2) graph re-query: the freshest
   * owner of a just-compressed tool output is the ephemeral cache; promoted content is
   * in the archive; the graph is the re-query fallback.
   *
   * Returns:
   *   { found: true, store, original, queried? }   on a hit
   *   { found: false, hash }                        if no store owns the hash
   * `original` is the BYTE-EXACT full original (all rows, including dropped ones — the
   * stores hold it verbatim). When `query` is given, `queried` is the relevant subset;
   * `original` is still returned so the caller can verify byte-exactness (AC-1).
   */
  function retrieve(hash, query) {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return { found: false, hash, reason: 'malformed-hash' };
    }

    let store;
    let original;

    if (ephemeral.has(hash)) {
      store = 'ephemeral';
      original = ephemeral.get(hash);
    } else if (archive && archive.has(hash)) {
      store = 'archive';
      original = archive.get(hash);
    } else if (typeof graphResolver === 'function') {
      const g = graphResolver(hash, query);
      if (g !== undefined) {
        store = 'graph';
        original = g;
      }
    }

    if (original === undefined) {
      return { found: false, hash, reason: 'no-store-owns-hash' };
    }

    // AC-1: the resolved original must hash back to the requested key — byte-exact or
    // it is not the original. A resolver that returns a non-matching blob fails closed.
    if (hashCanonical(original) !== hash) {
      return { found: false, hash, reason: 'hash-mismatch-on-resolve', store };
    }

    const result = { found: true, store, original, hash };

    if (typeof query === 'string' && query.length > 0) {
      result.queried = typeof queryFn === 'function'
        ? queryFn(hash, query, original)
        : jsFallbackQuery(original, query);
    }

    return result;
  }

  return retrieve;
}

/**
 * A dependency-free fallback query for the FR-D2 `query` path, used in the hook
 * environment where SQLite/FTS5 is NOT available (better-sqlite3 lives only in mcp/).
 * It does a substring/whitespace-token match over the serialized rows — DELIBERATELY
 * NOT claiming tokenizer parity. The Porter-stemmed, FTS5-byte-identical implementation
 * is mcp/src/ccr-query.ts (`queryWithFtsParity`), injected as `queryFn` where SQLite is
 * present. This fallback returns rows that contain ALL query tokens (AND semantics),
 * preserving original order. It is correct-but-coarse, never silently wrong about parity.
 */
function jsFallbackQuery(original, query) {
  const rows = Array.isArray(original) ? original : [original];
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return rows;
  return rows.filter((row) => {
    const hay = JSON.stringify(row).toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}

module.exports = {
  // canonical/hash (must agree with smart-crusher.js — asserted cross-module in tests)
  stableStringify,
  hashCanonical,
  hashCanonicalString,
  // marker (FR-D1)
  buildMarker,
  parseMarker,
  // constants rehydration (DIO-7 carry-forward — LOAD-BEARING)
  rehydrateRows,
  rehydrateEnvelope,
  // store #3 (FR-D3 ephemeral session cache)
  createEphemeralCache,
  DEFAULT_CACHE_ROOT,
  DEFAULT_MAX_ENTRIES,
  // store #1 (FR-D3 promoted/archived)
  createArchiveResolver,
  DEFAULT_ARCHIVE_ROOT,
  // the reactive retrieve contract (FR-D1, FR-D4)
  createRetrieve,
  jsFallbackQuery,
};
