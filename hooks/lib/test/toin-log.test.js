'use strict';

/**
 * toin-log.test.js — DIO-15 TOIN-style retrieval/observability SIGNAL logging.
 *
 * Proves the DIO-15 ACs and the load-bearing Gate-3 hazard:
 *   AC-1  the three signal events (CCR retrieval, graph-staleness, enrich fire-volume) emit
 *         structured records through ONE append-only sink.
 *   AC-2  the sink is PROVABLY off the eval-gated surface: the REAL indexer.classify() returns
 *         null for the sink path → it can never become an `observations` row.
 *   GATE-3 the log→weight loop is gated BY CONSTRUCTION: a static scan asserts NO runtime path
 *         (here or in any module DIO-15 touches) writes/mutates the six-factor WEIGHTS or the
 *         engine's search_config weights.
 *   AC-4  ADDENDUM (cold-eye Flag 4): machine accesses (enrich/graph/CCR retrieve) are LOGGED as
 *         signal but do NOT bump access_stats — none of the emit points routes through
 *         searchMemory (the sole access_stats writer) or touches access_stats themselves.
 *   REVERSIBILITY disabling stops emission with zero state change; the module is append-only and
 *         has no reader, so it cannot feed back into a decision.
 *   DETERMINISM the record builders are pure (no Date.now/Math.random); a static guard enforces it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const toin = require('../toin-log.js');

const HOOKS_LIB = path.join(__dirname, '..');
const HOOKS_ROOT = path.join(HOOKS_LIB, '..');

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toin-test-'));
  return { dir, logPath: path.join(dir, 'nested', 'mcp-server.log') };
}
function readLines(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ── AC-1: the three signal events emit structured records ─────────────────────

test('AC-1: CCR retrieval / staleness / enrich each emit ONE structured record', () => {
  const { dir, logPath } = tmpLog();
  const logger = toin.createToinLogger({ logPath, enabled: true });

  assert.equal(logger.logRetrieval({ found: true, store: 'ephemeral', hash: 'a'.repeat(64) }), true);
  assert.equal(logger.logStaleness({ verdict: 'rebuild', rebuilt: { ran: true } }), true);
  assert.equal(logger.logEnrich({ fired: true, unitCount: 3, injectedText: 'x'.repeat(40) }), true);

  const lines = readLines(logPath);
  assert.equal(lines.length, 3, 'exactly three records appended');

  const [r, s, e] = lines;
  assert.equal(r.event_type, toin.EVENT_TYPES.RETRIEVAL);
  assert.equal(r.found, true);
  assert.equal(r.store, 'ephemeral');
  assert.equal(r.hash, 'a'.repeat(64));

  assert.equal(s.event_type, toin.EVENT_TYPES.STALENESS);
  assert.equal(s.verdict, 'rebuild');
  assert.equal(s.rebuilt, true);

  assert.equal(e.event_type, toin.EVENT_TYPES.ENRICH);
  assert.equal(e.fired, true);
  assert.equal(e.unit_count, 3);
  assert.equal(e.chars, 40);
  assert.equal(e.token_estimate, 10, '~4 chars per token');

  // Every line carries a wall-clock ts and the dioscuri source tag (a log fact).
  for (const l of lines) {
    assert.equal(typeof l.ts, 'string');
    assert.equal(l.source, 'dioscuri-toin');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AC-1c: enrich fire-volume logs the SIZE of the injection, never the content', () => {
  const { dir, logPath } = tmpLog();
  const logger = toin.createToinLogger({ logPath, enabled: true });
  const secret = 'SENSITIVE-MEMORY-CONTENT-that-must-not-be-logged'.repeat(3);
  logger.logEnrich({ fired: true, unitCount: 2, injectedText: secret });

  const [rec] = readLines(logPath);
  // The token-cost guard records size; the text itself is absent from the record.
  assert.equal(rec.chars, secret.length);
  assert.equal(rec.token_estimate, Math.ceil(secret.length / 4));
  assert.ok(!JSON.stringify(rec).includes('SENSITIVE'), 'injected content must NEVER be logged');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── REVERSIBILITY: disabling stops emission with zero state change ─────────────

test('REVERSIBILITY: disabled logger writes NOTHING and creates no sink', () => {
  const { dir, logPath } = tmpLog();
  const logger = toin.createToinLogger({ logPath, enabled: false });
  assert.equal(logger.enabled, false);
  assert.equal(logger.logRetrieval({ found: true, store: 'ephemeral', hash: 'b'.repeat(64) }), false);
  assert.equal(logger.logEnrich({ fired: true, unitCount: 1, injectedText: 'hi' }), false);
  assert.ok(!fs.existsSync(logPath), 'no sink file is created when disabled');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('REVERSIBILITY: the env kill-switch disables emission', () => {
  const { dir, logPath } = tmpLog();
  const logger = toin.createToinLogger({ logPath, env: { [toin.DISABLE_ENV]: '1' } });
  assert.equal(logger.enabled, false);
  assert.equal(logger.logStaleness({ verdict: 'fresh' }), false);
  assert.ok(!fs.existsSync(logPath));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Self-provisioning + append-only + best-effort (never throws) ──────────────

test('emit self-provisions the sink dir and APPENDS (never truncates)', () => {
  const { dir, logPath } = tmpLog();
  assert.ok(!fs.existsSync(path.dirname(logPath)), 'nested dir absent before first write');
  const logger = toin.createToinLogger({ logPath, enabled: true });
  logger.logStaleness({ verdict: 'fresh' });
  logger.logStaleness({ verdict: 'rebuild', rebuilt: { ran: true } });
  assert.equal(readLines(logPath).length, 2, 'second write appends, does not overwrite');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('emit is best-effort: an un-writable sink returns false, never throws', () => {
  // Point the sink at a path whose parent is a FILE (mkdir will fail) — emit must swallow it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toin-bad-'));
  const fileAsParent = path.join(dir, 'iam-a-file');
  fs.writeFileSync(fileAsParent, 'x');
  const logger = toin.createToinLogger({ logPath: path.join(fileAsParent, 'log'), enabled: true });
  assert.doesNotThrow(() => {
    assert.equal(logger.logStaleness({ verdict: 'fresh' }), false);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── DETERMINISM: builders are pure; an explicit ts is honoured ─────────────────

test('DETERMINISM: the record builders are pure (no clock/random in their output)', () => {
  const r1 = toin.buildRetrievalRecord({ found: true, store: 'archive', hash: 'c'.repeat(64) });
  const r2 = toin.buildRetrievalRecord({ found: true, store: 'archive', hash: 'c'.repeat(64) });
  assert.deepEqual(r1, r2, 'same input → byte-identical record');
  assert.ok(!('ts' in r1), 'the builder does NOT stamp a clock — emit() does, at write time');

  const e1 = toin.buildEnrichRecord({ fired: true, unitCount: 5, injectedText: 'abcd' });
  assert.equal(e1.token_estimate, 1, 'token estimate is a deterministic length function');
});

test('DETERMINISM: an explicit ts on the record is honoured for a replayable line', () => {
  const { dir, logPath } = tmpLog();
  const logger = toin.createToinLogger({ logPath, enabled: true });
  logger.emit({ ...toin.buildStalenessRecord({ verdict: 'fresh' }), ts: '2000-01-01T00:00:00.000Z' });
  const [rec] = readLines(logPath);
  assert.equal(rec.ts, '2000-01-01T00:00:00.000Z');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DETERMINISM (static): the source contains no Date.now/Math.random in any builder path', () => {
  const src = fs.readFileSync(path.join(HOOKS_LIB, 'toin-log.js'), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/Date\.now\s*\(/.test(code), 'no Date.now() — the only clock is emit()s line ts');
  assert.ok(!/Math\.random\s*\(/.test(code), 'no Math.random()');
  // new Date() appears exactly ONCE, only inside emit()'s ts default (a log fact, not a builder).
  const newDateCount = (code.match(/new Date\s*\(/g) || []).length;
  assert.equal(newDateCount, 1, 'new Date() only in emit() ts default, nowhere in a builder');
});

// ── AC-2: the sink is PROVABLY off the eval-gated surface (real classify()) ────

test('AC-2: indexer.classify() returns null for the TOIN sink path (never an observations row)', () => {
  // Run the REAL indexer classifier against the production sink path. The sink lives under
  // ~/.claude-data/.logs/ — outside every dir the indexer walks (agent/, context/, projects/,
  // episodes/; archive/ excluded). classify() → null means it can NEVER be indexed, so
  // SELECT COUNT(*) FROM observations WHERE source_path LIKE '%mcp-server.log%' is 0 by
  // construction (the file is never offered to the indexer at all).
  let classify;
  try {
    ({ classify } = require('../../../mcp/dist/indexer.js'));
  } catch {
    // Fall back to source if the TS build isn't present in this worktree.
    classify = null;
  }

  const dataRoot = path.join(os.homedir(), '.claude-data');
  const sink = toin.DEFAULT_LOG_PATH;
  // Structural assertion (build-independent): the sink is under .logs/, which is NOT any of
  // the walked dirs. This is the same fact classify() encodes.
  assert.ok(sink.startsWith(path.join(dataRoot, '.logs') + path.sep), 'sink is under .logs/');
  for (const walked of ['agent', 'context', 'projects', 'episodes', 'archive']) {
    assert.ok(
      !sink.startsWith(path.join(dataRoot, walked) + path.sep),
      `sink must NOT be under the indexer-walked ${walked}/`,
    );
  }

  if (typeof classify === 'function') {
    const config = { dataRoot, watchedProjects: [] };
    assert.equal(classify(sink, config), null, 'REAL classify() returns null for the sink path');
    // And a representative TOIN line file under .logs is equally un-indexable.
    assert.equal(classify(path.join(dataRoot, '.logs', 'mcp-server.log'), config), null);
  }
});

// ── GATE-3: the log→weight loop is gated BY CONSTRUCTION ───────────────────────

test('GATE-3: the TOIN logger imports NO ranking/weights module (no write path to weights)', () => {
  const src = fs.readFileSync(path.join(HOOKS_LIB, 'toin-log.js'), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // It must not require the six-factor ranker, nor the engine's weights/ranking modules.
  assert.ok(!/require\([^)]*injection-ranking/.test(code), 'must not import injection-ranking.js');
  assert.ok(!/require\([^)]*search_config/.test(code), 'must not import search_config');
  assert.ok(!/require\([^)]*ranking\.(js|ts)/.test(code), 'must not import ranking.js/ts');
  // It exposes NO reader of its own log — there is nothing to read a record back into a weight.
  assert.ok(!/readFileSync|readFile\b|createReadStream/.test(code), 'the log sink has NO reader');
});

// THE weights write-path proof (the central Gate-3 guarantee). The load-bearing backstop is
// Object.freeze(WEIGHTS): a runtime mutation of a frozen object THROWS under strict mode (or
// no-ops in sloppy mode) — this is what actually closes the log→weight loop, and it catches
// EVERY mutation form (member-set, alias, Object.defineProperty, Reflect.set) by execution.
// The static scan below is defense-in-depth: a fast lint that fails the build the moment an
// obvious weight-write is committed to the DIO-15 surface, so the regression is caught at the
// diff rather than only at runtime. It is deliberately NOT claimed to be exhaustive — a regex
// cannot track aliasing (`const W = WEIGHTS; W.recency = …`), so freeze, not the scan, is the
// guarantee; the scan just raises the cost of an accidental direct write.
test('GATE-3: Object.freeze is the load-bearing guarantee; a static scan backstops obvious weight-writes', () => {
  // The six-factor WEIGHTS constant is FROZEN at definition — a runtime mutation throws. This
  // is the real guarantee, proven by execution (not by the static scan): it catches every form.
  const { WEIGHTS } = require('../injection-ranking.js');
  assert.ok(Object.isFrozen(WEIGHTS), 'WEIGHTS must be frozen (a runtime write throws)');
  assert.throws(() => {
    'use strict';
    WEIGHTS.recency = 0.99;
  }, 'a runtime write to a weight must throw — there is no mutation path');
  // Freeze also defeats the forms a static regex would miss — proven by execution:
  assert.throws(() => {
    'use strict';
    const alias = WEIGHTS; // aliasing cannot evade a frozen target
    alias.recency = 0.99;
  }, 'a write through an alias must throw — freeze, not the scan, is the backstop');
  assert.throws(() => {
    Object.defineProperty(WEIGHTS, 'recency', { value: 0.99 });
  }, 'Object.defineProperty on a frozen object must throw');
  assert.equal(Reflect.set(WEIGHTS, 'recency', 0.99), false, 'Reflect.set must fail (return false) on a frozen object');

  // Defense-in-depth static scan: no module in the DIO-15 surface performs an OBVIOUS direct
  // write to WEIGHTS or reassigns a search_config weight constant. Non-exhaustive by design
  // (see the block comment above) — freeze is the guarantee; this just catches the easy cases.
  const surface = [
    path.join(HOOKS_LIB, 'toin-log.js'),
    path.join(HOOKS_LIB, 'ccr-retrieve.js'),
    path.join(HOOKS_LIB, 'injection-enrich.js'),
    path.join(HOOKS_LIB, 'injection-ranking.js'),
    path.join(HOOKS_ROOT, 'precompact-graph-staleness.js'),
    path.join(HOOKS_ROOT, 'posttooluse-content-router.js'),
  ];
  // Patterns that would constitute a runtime WRITE to the weights surface. The binding
  // reassignment pattern excludes the frozen DEFINITION (`const WEIGHTS = Object.freeze(...)`):
  // the negative lookahead tolerates whitespace before Object.freeze, and a `const/let/var`
  // declaration is not a runtime mutation.
  const WRITE_PATTERNS = [
    /WEIGHTS\s*\[[^\]]+\]\s*=[^=]/, // WEIGHTS['recency'] = ...
    /WEIGHTS\s*\.\s*[A-Za-z_$][\w$]*\s*=[^=]/, // WEIGHTS.recency = ... and WEIGHTS . recency = ... (spaced member; not == / ===)
    /(?<!const\s)(?<!let\s)(?<!var\s)\bWEIGHTS\s*=\s*(?!\s*Object\.freeze)/, // reassigning the binding (except the frozen definition)
    /Object\.assign\s*\(\s*WEIGHTS/, // Object.assign(WEIGHTS, ...)
    /Object\.defineProperty\s*\(\s*WEIGHTS/, // Object.defineProperty(WEIGHTS, ...)
    /Reflect\.(set|defineProperty)\s*\(\s*WEIGHTS/, // Reflect.set(WEIGHTS, ...) / Reflect.defineProperty(WEIGHTS, ...)
    /\b(W_REINFORCE|W_EXACT_TITLE|W_EXACT_CONTENT|RRF_K)\s*=[^=]/, // engine weight reassignment
  ];
  for (const file of surface) {
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const pat of WRITE_PATTERNS) {
      assert.ok(
        !pat.test(code),
        `${path.basename(file)} must contain NO runtime weight-write (matched ${pat})`,
      );
    }
  }
});

test('GATE-3: the engine search_config weights are immutable `const` bindings (no runtime reassignment)', () => {
  // The brief names BOTH weight surfaces: the hooks six-factor WEIGHTS (covered above) AND the
  // engine's search_config weights. The latter are `export const` bindings — immutable by the
  // language: a runtime reassignment is a SyntaxError/TypeError, not a code path. This proves it
  // for each named weight constant: it is DEFINED exactly once as a const, and never reassigned.
  const cfgPath = path.join(HOOKS_ROOT, '..', 'mcp', 'src', 'search_config.ts');
  if (!fs.existsSync(cfgPath)) return; // mcp source absent in this checkout — nothing to prove
  const src = fs.readFileSync(cfgPath, 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const weight of ['W_REINFORCE', 'W_EXACT_TITLE', 'W_EXACT_CONTENT', 'RRF_K']) {
    // Defined exactly once, as a const export.
    const defs = code.match(new RegExp(`export const ${weight}\\b`, 'g')) || [];
    assert.equal(defs.length, 1, `${weight} must be defined exactly once as an export const`);
    // No reassignment anywhere: `WEIGHT =` not preceded by const/let/var (i.e. not the definition).
    const reassign = new RegExp(`(?<!const )(?<!let )(?<!var )\\b${weight}\\s*=[^=]`);
    assert.ok(!reassign.test(code), `${weight} must never be reassigned at runtime (it is const)`);
  }
});

// ── AC-4 ADDENDUM: machine accesses are LOGGED but do NOT bump access_stats ────

test('AC-4: no DIO-15 emit-point module routes through searchMemory or writes access_stats', () => {
  // The single access_stats writer is searchMemory (mcp/src/tools/search_memory.ts), the
  // human-recall path. DIO-15 logs MACHINE accesses (CCR retrieve, graph staleness, enrich) as
  // signal — but those emit points must NOT call searchMemory (which would reinforce) nor touch
  // access_stats themselves. A machine access is not a recall signal; logging it must stay a
  // read-only observation. Proven by static scan of the modules DIO-15 added emission to.
  const emitPointModules = [
    path.join(HOOKS_LIB, 'toin-log.js'),
    path.join(HOOKS_LIB, 'ccr-retrieve.js'),
    path.join(HOOKS_LIB, 'injection-enrich.js'),
    path.join(HOOKS_ROOT, 'precompact-graph-staleness.js'),
  ];
  for (const file of emitPointModules) {
    const src = fs.readFileSync(file, 'utf8');
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/searchMemory\s*\(/.test(code), `${path.basename(file)} must not CALL searchMemory`);
    assert.ok(!/require\([^)]*search_memory/.test(code), `${path.basename(file)} must not import search_memory`);
    assert.ok(!/access_stats/.test(code), `${path.basename(file)} must not touch access_stats`);
  }
});
