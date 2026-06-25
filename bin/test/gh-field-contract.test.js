'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── The gh --json field contract ─────────────────────────────────────────────
//
// Skills hardcode `gh pr list/view --json <fields>` and `gh issue list/view --json
// <fields>`. A typo'd or stale field name (e.g. `reviewRequested` instead of the real
// `reviewRequests`) makes `gh` hard-fail the WHOLE query at runtime with "Unknown JSON
// field" — and in a headless background skill that means a silently broken digest at
// 6am, not a caught error. This test pins every gh --json field a skill references
// against the canonical field lists documented in ~/.claude-data/context/github.md
// (the single source of truth), so a drift fails CI rather than a cron run.
//
// github.md is machine-local DATA, not committed genome. Where it is absent (a fresh
// clone / CI without the data dir) the test SKIPS rather than false-fails — the contract
// is only checkable where the manifest exists (Willis / Walter).

const GITHUB_MD = path.join(process.env.HOME || '', '.claude-data', 'context', 'github.md');
const SKILLS_DIR = path.resolve(__dirname, '..', '..', 'skills');

// Extract the canonical comma-list that follows a documented anchor sentence, e.g.
// "All available `--json` fields for `gh pr view`/`gh pr list`: `a, b, c`".
function canonicalFields(md, anchor) {
  // The field list is the backtick group AFTER the colon (skip the intervening
  // `gh pr list` / `gh issue list` backtick group that follows the anchor).
  const re = new RegExp(anchor + '[^\\n]*?:\\s*`([^`]+)`');
  const m = md.match(re);
  assert.ok(
    m,
    `github.md manifest anchor not found: "${anchor}" — the manifest was reformatted; ` +
      `update this test's anchor or restore the field-list line.`,
  );
  return new Set(m[1].split(',').map((s) => s.trim()).filter(Boolean));
}

// Every `gh pr|issue list|view ... --json <fields>` reference in a skill body.
// Scoped to list/view because `gh pr checks` and `gh search prs` accept different field
// sets; their fields are not in the pr view/list manifest and must not be checked here.
function jsonRefs(body, cmdRe) {
  const refs = [];
  const re = new RegExp(cmdRe + '[^\\n]*?--json\\s+([A-Za-z,]+)', 'g');
  let m;
  while ((m = re.exec(body)) !== null) {
    const fields = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    if (fields.length === 1 && fields[0] === 'fields') continue; // literal `--json fields` placeholder
    refs.push(...fields);
  }
  return refs;
}

function skillFiles() {
  const out = [];
  for (const dir of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const skillDir = path.join(SKILLS_DIR, dir.name);
    for (const f of fs.readdirSync(skillDir)) {
      if (f.endsWith('.md')) out.push(path.join(skillDir, f));
    }
  }
  return out;
}

test('gh pr/issue --json fields referenced by skills exist in the github.md manifest', (t) => {
  if (!fs.existsSync(GITHUB_MD)) {
    t.skip('github.md manifest not present (machine-local data) — contract not checkable here');
    return;
  }
  const md = fs.readFileSync(GITHUB_MD, 'utf8');
  const prFields = canonicalFields(md, 'All available `--json` fields for `gh pr view`');
  const issueFields = canonicalFields(md, 'All available `--json` fields for `gh issue view`');

  const violations = [];
  for (const file of skillFiles()) {
    const body = fs.readFileSync(file, 'utf8');
    const rel = path.relative(SKILLS_DIR, file);
    for (const f of jsonRefs(body, 'gh pr (?:list|view)')) {
      if (!prFields.has(f)) {
        violations.push(`${rel}: gh pr --json field "${f}" not in github.md pr-field manifest`);
      }
    }
    for (const f of jsonRefs(body, 'gh issue (?:list|view)')) {
      if (!issueFields.has(f)) {
        violations.push(`${rel}: gh issue --json field "${f}" not in github.md issue-field manifest`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `gh --json field drift — a typo'd field hard-fails the query at runtime. ` +
      `If a flagged field is real, add it to github.md's manifest line; if it is a typo, fix the skill:\n` +
      violations.join('\n'),
  );
});
