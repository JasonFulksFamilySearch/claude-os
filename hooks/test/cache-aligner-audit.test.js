// cache-aligner-audit.test.js — Dioscuri AC-2 prefix-stability gate (DIO-1).
//
// Proves the rendered identity/rules prefix is deterministic, byte-stable against a
// committed baseline, and free of any per-session-volatile token. This is the
// Phase-0 gate that de-risks all injection work: if a volatile token sat inside the
// stable prefix, every session would shift the prefix bytes and the injection
// pipeline would have no fixed boundary to land downstream of.
//
// Anti-sandbagging: the scan is exercised as a REAL detector by planting each
// volatile shape into a fixture prefix and asserting the scan catches it — and by
// asserting the stable envsubst vars are NOT flagged (a false positive would be a
// bug). A scan that can only ever say PASS proves nothing; this one can fail.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const audit = require('../../scripts/cache-aligner-audit.js');

const BASELINE = path.join(__dirname, 'fixtures', 'prefix-baseline.txt');

// ── Render determinism ────────────────────────────────────────────────────────

test('renderPrefix is deterministic: two renders are byte-identical', () => {
  const a = audit.renderPrefix();
  const b = audit.renderPrefix();
  assert.equal(a, b, 'two renders of the prefix differed — render is not deterministic');
});

// ── Baseline stability (the AC-2 contract) ────────────────────────────────────

test('rendered prefix matches the committed baseline byte-for-byte', () => {
  assert.ok(
    fs.existsSync(BASELINE),
    'baseline missing — regenerate: node scripts/cache-aligner-audit.js --emit-baseline > hooks/test/fixtures/prefix-baseline.txt'
  );
  const baseline = fs.readFileSync(BASELINE, 'utf8');
  const rendered = audit.renderPrefix();
  assert.equal(
    rendered,
    baseline,
    'rendered prefix drifted from the committed baseline. If this is an intentional ' +
      'identity/rules template change, regenerate the baseline in this PR. If not, a ' +
      'per-session token may have leaked into the prefix — investigate before regenerating.'
  );
});

// ── The live AC-2 assertion: no volatile token in today's prefix ──────────────

test('AC-2: no per-session-volatile token sits inside the rendered prefix', () => {
  const result = audit.audit();
  assert.equal(
    result.findings.length,
    0,
    'volatile token(s) found in the prefix: ' + JSON.stringify(result.findings, null, 2)
  );
  assert.ok(result.pass, 'audit did not report PASS despite zero findings');
});

// ── Anti-sandbagging: the scan REALLY catches each volatile shape ─────────────
// Each case is a minimal fixture prefix carrying exactly one planted volatile token.
// If the scan is a no-op stub, these fail. Stable envsubst vars are excluded by a
// separate case below; matching them here would be a false-positive bug.

const PLANTED = [
  { id: 'iso-timestamp', text: 'Last synced at 2026-06-18T12:00:00Z by the worker.' },
  { id: 'iso-timestamp', text: 'Generated 2026-06-18 (date only).' },
  { id: 'date-now', text: 'const stamp = Date.now();' },
  { id: 'new-date', text: 'const d = new Date();' },
  { id: 'date-shellout', text: 'echo "built $(date -u +%Y)"' },
  { id: 'date-shellout', text: 'STAMP=`date +%s`' },
  { id: 'session-id', text: 'Your sessionId is fixed for this run.' },
  { id: 'session-id', text: 'See session_id in the header.' },
  { id: 'pid', text: 'Process pid is process.pid here.' },
  { id: 'run-turn-counter', text: 'This is turn_counter in the loop.' },
  { id: 'run-turn-counter', text: 'See runCount above.' },
  { id: 'epoch-seconds', text: 'unix time 1718712000 is now.' },
  { id: 'uuid', text: 'id: 550e8400-e29b-41d4-a716-446655440000 here.' },
];

for (const planted of PLANTED) {
  test(`scan catches planted volatile token: ${planted.id} :: ${planted.text}`, () => {
    const findings = audit.scanVolatile(planted.text);
    const hit = findings.some((f) => f.detector === planted.id);
    assert.ok(
      hit,
      `scan MISSED a planted "${planted.id}" token in: ${JSON.stringify(planted.text)}. ` +
        `findings=${JSON.stringify(findings)}`
    );
  });
}

test('a clean prefix (no volatile token) yields zero findings', () => {
  const clean = 'You are TestUser\'s agent. Address TestUser as **Sir**.\n- Do the thing.';
  assert.deepEqual(audit.scanVolatile(clean), []);
});

// ── False-positive guard: the stable envsubst vars are NOT flagged ────────────
// USER_NAME/AGENT_NAME/MACHINE_DESC/DEV_ROOT render to fixed per-machine-stable
// literals. Those literals must not match any volatile shape — flagging them would
// false-fail every machine. Render the prefix and assert the test values appear yet
// produce no finding.

test('stable envsubst vars are present in the prefix but NOT flagged as volatile', () => {
  const result = audit.audit();
  const prefix = result.renderedPrefix;
  // The fixed test values are actually substituted in (so the render path ran)...
  assert.ok(prefix.includes('TestAgent'), 'AGENT_NAME was not substituted');
  assert.ok(prefix.includes('TestUser'), 'USER_NAME was not substituted');
  assert.ok(prefix.includes('test-machine'), 'MACHINE_DESC was not substituted');
  // ...and none of them tripped a detector (findings empty == none flagged).
  assert.equal(
    result.findings.length,
    0,
    'a stable envsubst var was wrongly flagged as volatile: ' + JSON.stringify(result.findings)
  );
});

test('the bare word `date` in an allowed-commands list is NOT a date-shellout', () => {
  // The Tooling rules list `date` as an allowed Bash command (a markdown code-span of
  // the literal word). That is documentation, not a volatile shellout — it must not
  // trip the date-shellout detector. Only `date +%s` / $(date ...) (output-producing
  // forms) are volatile.
  const docLine = 'Allowed Bash: `ls`, `wc`, `which`, `pwd`, `echo`, `date`, `git`, `npm`.';
  const findings = audit.scanVolatile(docLine);
  assert.equal(
    findings.length,
    0,
    'a bare `date` code-span was wrongly flagged: ' + JSON.stringify(findings)
  );
});
