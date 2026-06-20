'use strict';

/**
 * smart-crusher.js — the SmartCrusher JSON-array compressor (DIO-7 / FR-B1).
 *
 * A NATIVE, in-process port of Headroom's SmartCrusher pattern (augmentation
 * brief v2 §1), specialized for an audit/defect agent. It compresses a JSON array
 * of records by retaining a representative subset and factoring out fields that are
 * constant across the array, while PRESERVING error/anomaly/boundary rows
 * UNCONDITIONALLY — the one rule that must never be sacrificed to a budget.
 *
 * The mechanism, in order of operation:
 *   1. Parse the JSON array.
 *   2. Per-row classification (error / anomaly / boundary / droppable). This runs
 *      FIRST — the preservation rule is non-negotiable for a defect agent, so the
 *      classifier's verdict gates every later drop decision.
 *   3. Field-level statistical analysis (uniqueness, variance, change points) and
 *      constant-field factoring (fields equal across ALL rows are lifted out once).
 *   4. Kneedle subset-selection on cumulative bigram coverage to pick the knee — the
 *      point of diminishing representational return — as the importance budget.
 *   5. A 30% schema / 15% recency / 55% importance retention split over the
 *      droppable rows, UNIONED with the unconditionally-preserved rows.
 *
 * DETERMINISM (FR-B1 / AC-5c.1, LOAD-BEARING): compress(payload) is byte-identical
 * across runs and across machines for identical input. There is NO Date.now(), NO
 * Math.random, NO wall-clock, and every tie-break is resolved by a stable key
 * (original array index). "Recency" is positional (end of the array), never
 * timestamp-derived. This is a hard precondition for the downstream eval gate
 * (DIO-18): a lossy AND non-deterministic write would drift the eval baseline
 * run-to-run.
 *
 * REVERSIBILITY (AC-1): compress() does not mutate or destroy its input, and its
 * result carries a content hash (`originalHash`) of the canonical original plus the
 * full set of retained-row indices, so the compressed form is a recoverable
 * projection of the original — never a lossy rewrite of it. Full CCR retrieve
 * (serve the byte-exact original from a store keyed by that hash) is DIO-11; here
 * the contract is: the marker carries what a retrieve path needs, and the original
 * is never destroyed in place. See `compress()`'s return shape and README.
 */

const { createHash } = require('node:crypto');

// ── Tunables (pure constants — no env, no wall-clock) ─────────────────────────
// The retention split is the SmartCrusher contract: schema head, recency tail,
// importance middle. They are fractions of the IMPORTANCE BUDGET (the Kneedle knee
// count), not of the whole array — preserved rows are always kept on top of this.
const SCHEMA_FRACTION = 0.30; // rows from the array start (schema/shape exemplars)
const RECENCY_FRACTION = 0.15; // rows from the array end (positional recency)
const IMPORTANCE_FRACTION = 0.55; // rows by importance score (the Kneedle-selected middle)

// Below this row count there is no benefit to compressing — the factoring/subset
// overhead outweighs any saving, and we would risk dropping signal for nothing.
// Headroom skips content under ~200 tokens; for a record array the row-count floor
// is the structural analog. Arrays at/under this pass through unchanged.
const MIN_ROWS_TO_COMPRESS = 8;

// ── Per-row classification — the PRESERVE-FIRST rule (ported FIRST) ───────────
// verdict(row) ∈ { 'error' | 'anomaly' | 'boundary' | 'droppable' }. A row with any
// non-'droppable' verdict is retained UNCONDITIONALLY, regardless of budget. This is
// the rule that keeps the one failing row in a 500-row lint result. AC-5b asserts
// the preservation property against THIS verdict, so the verdict is surfaced on the
// output, not discarded.

// Field names that, when present and truthy/non-zero, mark an error-bearing row.
// Matched case-insensitively against the row's own keys (not values) so we catch
// `{ error: ... }`, `{ "errorCount": 3 }`, `{ failed: true }`, etc.
const ERROR_KEY_RE = /^(error|errors|err|failed|failure|failures|exception|fatal|panic)$/i;
const ERROR_SUBSTRING_RE = /(error|fail|exception|fatal|panic|severity)/i;
// String values that denote an error/failed status when they appear in a status-like field.
const ERROR_VALUE_RE = /^(error|fatal|failed|failure|critical|panic|exception)$/i;
const STATUS_KEY_RE = /^(status|state|level|severity|result|outcome|verdict|type)$/i;

/**
 * Does this row carry an explicit error/failure signal? Checks (a) error-named keys
 * with a truthy/non-zero value, (b) status-like fields whose value reads as an error.
 * Pure function of the row's own content — deterministic.
 */
function isErrorRow(row) {
  if (row == null || typeof row !== 'object' || Array.isArray(row)) {
    // A primitive row: treat a string that *is* an error word as an error.
    return typeof row === 'string' && ERROR_VALUE_RE.test(row.trim());
  }
  for (const [key, val] of Object.entries(row)) {
    // (a) an error-named key whose value is "present" (truthy, or a non-zero number,
    // or a non-empty array/string). `{ errors: 0 }` / `{ error: null }` is NOT an error.
    if (ERROR_KEY_RE.test(key) || ERROR_SUBSTRING_RE.test(key)) {
      if (isPresentSignal(val)) return true;
    }
    // (b) a status-like field whose value reads as an error/failure.
    if (STATUS_KEY_RE.test(key) && typeof val === 'string' && ERROR_VALUE_RE.test(val.trim())) {
      return true;
    }
  }
  return false;
}

// A value "signals presence" of whatever its key names: truthy, a non-zero number,
// a non-empty string, or a non-empty array. Used so `errorCount: 0` is not an error.
function isPresentSignal(val) {
  if (val == null || val === false) return false;
  if (typeof val === 'number') return val !== 0 && !Number.isNaN(val);
  if (typeof val === 'string') return val.trim().length > 0 && val.trim() !== '0' && !/^(none|ok|pass|passed|success|clean)$/i.test(val.trim());
  if (Array.isArray(val)) return val.length > 0;
  if (typeof val === 'object') return Object.keys(val).length > 0;
  return Boolean(val);
}

/**
 * Classify every row in one pass and compute the per-field statistics the later
 * stages need. Returns { verdicts, fields, numericStats } — deterministic and
 * order-stable. Boundary/anomaly detection needs the whole-array view (distribution
 * extremes, change points), so it runs here rather than per-row in isolation.
 */
function classifyRows(rows) {
  const n = rows.length;
  // Field presence + value sets across the array (for uniqueness/constant analysis).
  const fields = new Map(); // fieldName -> { count, values:Set(json), allEqual, firstValueJson }
  // Numeric field samples for distribution-boundary detection.
  const numericByField = new Map(); // fieldName -> [{ index, value }]

  for (let i = 0; i < n; i++) {
    const row = rows[i];
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      for (const [key, val] of Object.entries(row)) {
        let f = fields.get(key);
        if (!f) {
          f = { count: 0, valueJsons: new Set(), firstValueJson: undefined };
          fields.set(key, f);
        }
        f.count++;
        const vj = stableStringify(val);
        if (f.firstValueJson === undefined) f.firstValueJson = vj;
        // Cap the value set so a high-cardinality field doesn't grow unbounded; we
        // only need to know "all equal?" and rough uniqueness, not every value.
        if (f.valueJsons.size <= 64) f.valueJsons.add(vj);
        if (typeof val === 'number' && Number.isFinite(val)) {
          let arr = numericByField.get(key);
          if (!arr) { arr = []; numericByField.set(key, arr); }
          arr.push({ index: i, value: val });
        }
      }
    }
  }

  // Mark distribution-boundary rows: for each numeric field, the rows holding the
  // global min and max are boundaries (the extremes a naive subset would clip off).
  const boundaryIndices = new Set();
  for (const samples of numericByField.values()) {
    if (samples.length < 3) continue; // too few to have a meaningful distribution
    let min = samples[0], max = samples[0];
    for (const s of samples) {
      if (s.value < min.value || (s.value === min.value && s.index < min.index)) min = s;
      if (s.value > max.value || (s.value === max.value && s.index < max.index)) max = s;
    }
    if (min.value !== max.value) {
      boundaryIndices.add(min.index);
      boundaryIndices.add(max.index);
    }
  }

  // Anomaly rows: a row whose SHAPE (sorted key set) is rare across the array. In a
  // uniform record array, the odd row with extra/missing fields is exactly the
  // anomaly an audit agent must not lose. Deterministic: keyed on the shape string.
  const shapeCounts = new Map();
  const rowShapes = new Array(n);
  for (let i = 0; i < n; i++) {
    const shape = rowShape(rows[i]);
    rowShapes[i] = shape;
    shapeCounts.set(shape, (shapeCounts.get(shape) || 0) + 1);
  }
  // A shape is "rare" if it occurs in fewer than 10% of rows AND the array is large
  // enough for that to be meaningful (a 2-row array has no anomalies).
  const rareThreshold = Math.max(1, Math.floor(n * 0.1));

  const verdicts = new Array(n);
  for (let i = 0; i < n; i++) {
    if (isErrorRow(rows[i])) {
      verdicts[i] = 'error';
    } else if (boundaryIndices.has(i)) {
      verdicts[i] = 'boundary';
    } else if (n >= 10 && shapeCounts.get(rowShapes[i]) <= rareThreshold && shapeCounts.size > 1) {
      verdicts[i] = 'anomaly';
    } else {
      verdicts[i] = 'droppable';
    }
  }

  return { verdicts, fields };
}

// A stable shape signature for a row: the sorted list of its keys (or its JS type
// for a primitive). Two rows with the same keys share a shape.
function rowShape(row) {
  if (row == null) return ' null';
  if (typeof row !== 'object') return ' ' + typeof row;
  if (Array.isArray(row)) return ' array:' + row.length;
  return Object.keys(row).sort().join('');
}

// ── Constant-field factoring ──────────────────────────────────────────────────
/**
 * Fields whose value is identical (and present) across EVERY row are "constant".
 * They are lifted out once into a shared block, so the per-row records can omit
 * them. Deterministic: factored fields are emitted in sorted key order.
 * Returns { constants: { field: value }, constantKeys: Set }.
 */
function factorConstantFields(rows, fields) {
  const constants = {};
  const constantKeys = new Set();
  const nObjects = rows.filter((r) => r && typeof r === 'object' && !Array.isArray(r)).length;
  if (nObjects < 2) return { constants, constantKeys };

  for (const key of [...fields.keys()].sort()) {
    const f = fields.get(key);
    // Present in every object row AND only one distinct value → constant.
    if (f.count === nObjects && f.valueJsons.size === 1) {
      constants[key] = JSON.parse(f.firstValueJson);
      constantKeys.add(key);
    }
  }
  return { constants, constantKeys };
}

// ── Kneedle knee detection on cumulative bigram coverage ──────────────────────
/**
 * Order the droppable rows by representational value and find the Kneedle "knee" —
 * the index past which adding more rows yields diminishing new bigram coverage. The
 * knee count is the importance budget: how many droppable rows are worth keeping.
 *
 * Bigram coverage is a content-diversity proxy: each row contributes the set of
 * adjacent token pairs in its serialized form; a row that introduces many unseen
 * bigrams is representationally valuable. We greedily add the row with the most
 * NEW bigrams (deterministic tie-break: lowest original index), building a
 * cumulative-coverage curve, then Kneedle picks where the curve's gain flattens.
 *
 * @returns {number} knee count in [0, droppable.length]
 */
function kneedleBudget(rows, droppableIndices) {
  const m = droppableIndices.length;
  if (m <= 2) return m;

  // Precompute each droppable row's bigram set (deterministic from content).
  const bigramSets = droppableIndices.map((idx) => bigrams(stableStringify(rows[idx])));

  // Greedy maximum-coverage ordering → cumulative new-bigram curve.
  const seen = new Set();
  const remaining = new Set(droppableIndices.map((_, k) => k)); // local positions
  const coverageCurve = []; // coverageCurve[t] = total distinct bigrams after t picks
  while (remaining.size > 0) {
    let bestPos = -1;
    let bestGain = -1;
    // Iterate in ascending local position for a stable tie-break (lowest original idx).
    for (const pos of remaining) {
      let gain = 0;
      for (const bg of bigramSets[pos]) if (!seen.has(bg)) gain++;
      if (gain > bestGain) { bestGain = gain; bestPos = pos; }
    }
    remaining.delete(bestPos);
    for (const bg of bigramSets[bestPos]) seen.add(bg);
    coverageCurve.push(seen.size);
  }

  return kneeIndex(coverageCurve);
}

/**
 * Kneedle: on a concave, increasing curve, the knee is the x that maximizes the
 * vertical distance from the straight line joining the first and last points. We
 * normalize x and y to [0,1] first (Satopää et al.). Returns a COUNT (knee x + 1),
 * clamped to [1, len]. Deterministic.
 */
function kneeIndex(curve) {
  const len = curve.length;
  if (len <= 2) return len;
  const x0 = 0, x1 = len - 1;
  const y0 = curve[0], y1 = curve[len - 1];
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (dy === 0) {
    // Flat curve (every row adds nothing new) → no informational knee; keep the
    // minimum representative head. A flat curve is a determinism hazard the brief
    // names explicitly; we resolve it to a fixed fraction, never a random pick.
    return Math.max(1, Math.round(len * 0.3));
  }
  const norm = Math.sqrt(dx * dx + dy * dy);
  let bestIdx = 0;
  let bestDist = -1;
  for (let i = 0; i < len; i++) {
    // Perpendicular distance from point (i, curve[i]) to the line (x0,y0)-(x1,y1).
    const dist = Math.abs(dy * (i - x0) - dx * (curve[i] - y0)) / norm;
    if (dist > bestDist) { bestDist = dist; bestIdx = i; }
  }
  return Math.min(len, bestIdx + 1);
}

// Adjacent-character bigrams over a normalized token stream of the serialized row.
// Char bigrams are language-agnostic and deterministic; for record data they capture
// value-shape diversity without a tokenizer dependency.
function bigrams(str) {
  const set = new Set();
  const s = str.toLowerCase();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

// ── Importance scoring for droppable rows ─────────────────────────────────────
/**
 * Rank droppable rows by representational importance so the Kneedle budget keeps the
 * MOST informative ones. Importance = count of distinct bigrams the row contributes
 * (richer rows score higher), tie-broken by lowest original index (determinism).
 * Returns the droppable indices sorted by descending importance.
 */
function rankByImportance(rows, droppableIndices) {
  const scored = droppableIndices.map((idx) => ({
    idx,
    score: bigrams(stableStringify(rows[idx])).size,
  }));
  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  return scored.map((s) => s.idx);
}

// ── Deterministic canonical serialization ─────────────────────────────────────
/**
 * Canonical JSON: object keys sorted recursively, so the serialized form (and its
 * hash, and its bigrams) is identical regardless of input key order. This is the
 * spine of determinism — `compress()` must be byte-identical for inputs that differ
 * only in key order or in non-semantic whitespace.
 */
function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function hashOriginal(canonicalString) {
  return createHash('sha256').update(canonicalString).digest('hex');
}

// ── The compressor ────────────────────────────────────────────────────────────
/**
 * Compress a JSON array of records. Returns a structured result, NOT a string — the
 * caller (the router handler) serializes it for `updatedToolOutput`. Pure and
 * deterministic.
 *
 * @param {Array<any>} array  the parsed JSON array to compress
 * @returns {{
 *   compressed: boolean,        // false if below the floor (caller passes raw through)
 *   retainedIndices: number[],  // sorted original indices kept (the reversibility key)
 *   retained: any[],            // the retained rows, with constant fields factored out
 *   constants: object,          // fields constant across all rows, lifted out once
 *   verdicts: string[],         // per-ORIGINAL-row classification (AC-5b observability)
 *   droppedCount: number,
 *   originalCount: number,
 *   originalHash: string,       // sha256 of the canonical original (AC-1 reversibility)
 * }}
 */
function compress(array) {
  const originalCount = array.length;
  const canonical = stableStringify(array);
  const originalHash = hashOriginal(canonical);

  // 1. CLASSIFY FIRST — the preserve-first rule. Even on the passthrough path we
  //    surface the verdict so the per-row classification is always observable.
  const { verdicts, fields } = classifyRows(array);

  // Below the floor → no compression benefit. Pass through, but still expose the
  // verdict and the reversibility hash so the contract is uniform.
  if (originalCount < MIN_ROWS_TO_COMPRESS) {
    return {
      compressed: false,
      retainedIndices: array.map((_, i) => i),
      retained: array,
      constants: {},
      verdicts,
      droppedCount: 0,
      originalCount,
      originalHash,
    };
  }

  // 2. The UNCONDITIONAL preserve set: every non-droppable row, by index.
  const preserved = new Set();
  for (let i = 0; i < originalCount; i++) {
    if (verdicts[i] !== 'droppable') preserved.add(i);
  }

  // 3. Constant-field factoring over the whole array.
  const { constants, constantKeys } = factorConstantFields(array, fields);

  // 4. Droppable rows are the candidate pool for the 30/15/55 split.
  const droppableIndices = [];
  for (let i = 0; i < originalCount; i++) if (!preserved.has(i)) droppableIndices.push(i);

  // 5. Kneedle knee on bigram coverage → the importance budget (how many droppable
  //    rows are worth keeping at all).
  const budget = kneedleBudget(array, droppableIndices);

  // 6. The 30% schema / 15% recency / 55% importance split, sized to the budget.
  const keepFromDroppable = new Set();

  const schemaCount = Math.round(budget * SCHEMA_FRACTION);
  const recencyCount = Math.round(budget * RECENCY_FRACTION);
  const importanceCount = budget - schemaCount - recencyCount;

  // Schema head: the first droppable rows (array start = shape exemplars).
  for (let k = 0; k < schemaCount && k < droppableIndices.length; k++) {
    keepFromDroppable.add(droppableIndices[k]);
  }
  // Recency tail: the last droppable rows (positional recency — NOT timestamp).
  for (let k = 0; k < recencyCount && k < droppableIndices.length; k++) {
    keepFromDroppable.add(droppableIndices[droppableIndices.length - 1 - k]);
  }
  // Importance middle: the highest-importance droppable rows not already kept.
  const byImportance = rankByImportance(array, droppableIndices);
  let added = 0;
  for (const idx of byImportance) {
    if (added >= importanceCount) break;
    if (!keepFromDroppable.has(idx)) { keepFromDroppable.add(idx); added++; }
  }

  // 7. Final retained set = preserved (unconditional) ∪ selected droppable. Sorted
  //    by original index so output ordering is deterministic and faithful to source.
  const retainedSet = new Set([...preserved, ...keepFromDroppable]);
  const retainedIndices = [...retainedSet].sort((a, b) => a - b);

  // 8. Project retained rows with constant fields factored out (omit the keys lifted
  //    into `constants`). Non-object rows pass through as-is.
  const retained = retainedIndices.map((i) => projectRow(array[i], constantKeys));

  return {
    compressed: true,
    retainedIndices,
    retained,
    constants,
    verdicts,
    droppedCount: originalCount - retainedIndices.length,
    originalCount,
    originalHash,
  };
}

// Strip the factored-out constant keys from a row and emit it in CANONICAL (sorted)
// key order. Canonicalizing here — not only in the hash path — means the compressed
// payload itself is byte-identical for inputs that differ only in key order, so the
// content entering the deterministic eval corpus (DIO-18) is order-invariant too,
// not just the retrieve key. Non-object rows pass through unchanged.
function projectRow(row, constantKeys) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return sortKeys(row);
  const out = {};
  for (const key of Object.keys(row).sort()) {
    if (!constantKeys.has(key)) out[key] = sortKeys(row[key]);
  }
  return out;
}

module.exports = {
  compress,
  // Exported for focused unit tests of the mechanism stages:
  classifyRows,
  isErrorRow,
  factorConstantFields,
  kneedleBudget,
  kneeIndex,
  stableStringify,
  hashOriginal,
  MIN_ROWS_TO_COMPRESS,
};
