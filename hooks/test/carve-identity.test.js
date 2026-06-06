// carve-identity.test.js — verifies the one-time identity carve migration that
// runs in update.sh Step 8.3a for already-installed machines. The migration is
// fresh-machine-only and unattended on the second machine, so it is tested by
// execution against a realistic un-carved fixture (persona interleaved with body,
// ## Address AFTER ## Operating rules — the layout that broke a naive range-based
// carve).

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CARVE = path.join(__dirname, '..', '..', 'scripts', 'carve-identity.js');

// A realistic un-carved identity file: persona (Disposition/Pushback/Style) BEFORE
// Operating rules, and Address AFTER it — the non-contiguous layout the allowlist
// must handle.
const UNCARVED = [
  '# Agent Identity — Testy',
  '',
  "You are Tester's agent on the testbox. Your name in this configuration is Testy.",
  '',
  '## Disposition',
  '',
  'Calm and principled.',
  '',
  '## Pushback',
  '',
  'Direct when principles are at stake.',
  '',
  '## Style of work',
  '',
  'Works within frameworks.',
  '',
  '## Operating rules',
  '',
  '- Do the thing.',
  '',
  '## Address',
  '',
  'Always address Tester as **Sir**.',
  '',
  '---',
  '',
  '## Tooling rules',
  '',
  'Use the right tools.',
  '',
].join('\n');

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'carve-test-'));
}

function carve(dir) {
  return execFileSync('node', [CARVE, path.join(dir, 'CLAUDE.md'), path.join(dir, 'personality.md')], {
    encoding: 'utf8',
  });
}

test('carve extracts ALL persona sections including interleaved Address', () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), UNCARVED);
  carve(dir);

  const persona = fs.readFileSync(path.join(dir, 'personality.md'), 'utf8');
  for (const s of ['## Disposition', '## Pushback', '## Style of work', '## Address']) {
    assert.ok(persona.includes(s), `persona.md missing ${s}`);
  }
  // Address content preserved verbatim
  assert.ok(persona.includes('Always address Tester as **Sir**.'));
  // anchor carried into the persona file
  assert.ok(persona.includes('# Agent Identity — Testy'));
});

test('carve leaves a clean body: @-import present, NO persona, neutral rules kept', () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), UNCARVED);
  carve(dir);

  const body = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.ok(body.includes('@~/.claude-data/agent/personality.md'), 'body missing @-import');
  assert.ok(!body.includes('## Disposition'), 'persona leaked into body');
  assert.ok(!body.includes('## Address'), 'Address leaked into body');
  assert.ok(body.includes('## Operating rules'), 'body lost Operating rules');
  assert.ok(body.includes('## Tooling rules'), 'body lost Tooling rules');
});

test('exactly one ## Address across both files (no loss, no duplication)', () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), UNCARVED);
  carve(dir);

  const body = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  const persona = fs.readFileSync(path.join(dir, 'personality.md'), 'utf8');
  const count =
    (body.match(/## Address/g) || []).length + (persona.match(/## Address/g) || []).length;
  assert.equal(count, 1);
});

test('persona file has no stray trailing --- separator', () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), UNCARVED);
  carve(dir);
  const persona = fs.readFileSync(path.join(dir, 'personality.md'), 'utf8').trimEnd();
  assert.ok(!persona.endsWith('---'), 'persona ends with a stray separator');
});

test('idempotent: second run on a carved body is a no-op', () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), UNCARVED);
  carve(dir);
  const bodyAfter1 = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  const out = carve(dir);
  const bodyAfter2 = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(out, /already-carved/);
  assert.equal(bodyAfter1, bodyAfter2, 'second carve changed the body');
});

test('preserves an existing hand-tuned personality.md (does not overwrite the soul)', () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), UNCARVED);
  // a pre-existing hand-tuned soul
  const handTuned = '# Agent Identity — Testy\n\n## Disposition\n\nUNIQUELY HAND TUNED.\n';
  fs.writeFileSync(path.join(dir, 'personality.md'), handTuned);
  carve(dir);
  const persona = fs.readFileSync(path.join(dir, 'personality.md'), 'utf8');
  assert.ok(persona.includes('UNIQUELY HAND TUNED.'), 'overwrote a hand-tuned persona');
});

test('no-op when there is no inline persona (already split machine)', () => {
  const dir = freshDir();
  const alreadyBody = [
    '# Agent Identity — Testy',
    '',
    "You are Tester's agent on the testbox.",
    '',
    '@~/.claude-data/agent/personality.md',
    '',
    '## Operating rules',
    '',
    '- Do the thing.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), alreadyBody);
  const out = carve(dir);
  assert.match(out, /already-carved|no inline persona/);
});
