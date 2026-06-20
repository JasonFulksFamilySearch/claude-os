#!/usr/bin/env node
// cache-aligner-audit.js — Dioscuri AC-2 CacheAligner prefix-stability audit.
//
// WHAT THIS PROVES (the Phase-0 gate, PRD §3 AC-2; ticket DIO-1):
//   The rendered identity/rules prefix — the stable, cache-aligned head of the
//   system context — contains NO per-session-volatile token. If it did, every
//   session would shift the prefix bytes, defeating prefix caching AND giving the
//   injection pipeline a moving target to land "downstream of the stable prefix"
//   against. So before any injection work ships, we freeze a byte-exact baseline
//   of the prefix-with-pipeline-OFF and assert nothing volatile lives inside it.
//
// THE THREAT MODEL (precise):
//   The prefix is rendered by `envsubst` substituting ONLY the per-machine-stable
//   vars below. Those are set once at install (NOT per session) — so they are the
//   EXPECTED variability and must NOT be flagged. The real AC-2 threat is a
//   per-session-VOLATILE token (ISO timestamp, Date.now(), $(date)/`date` shellout,
//   sessionId, PID, run/turn counter, epoch seconds, UUID) creeping into the
//   prefix. An empty volatile-finding list = PASS.
//
// READ-ONLY: this harness renders into a string and scans it. It mutates no
// template, no rendered prefix, no identity file, no Layer 1. It documents state.
//
// Usage:
//   node scripts/cache-aligner-audit.js                 # human audit report (stdout)
//   node scripts/cache-aligner-audit.js --json          # machine-readable report
//   node scripts/cache-aligner-audit.js --emit-baseline # print ONLY the rendered
//                                                        # prefix bytes (regenerate
//                                                        # the committed baseline)
//
// Exit: 0 = clean (no volatile token found); 1 = volatile token(s) found OR error.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'templates');

// ── The envsubst substitution allowlist ──────────────────────────────────────
// Derived from the actual render path (install.sh ~150-176, update.sh 8.4/8.6):
// CLAUDE.md + personality.md render with USER_NAME/AGENT_NAME/MACHINE_DESC;
// rules/*.md render with AGENT_NAME/USER_NAME. These four are per-MACHINE-stable
// (set once at install), so they are the *expected* prefix variability and are
// EXCLUDED from the volatile scan — flagging them is a false-positive bug.
// DEV_ROOT is not used by today's render path, but it is per-machine-stable by the
// same logic, so it stays on the exclusion list defensively (zero cost if added later).
const STABLE_VARS = Object.freeze({
  USER_NAME: 'TestUser',
  AGENT_NAME: 'TestAgent',
  MACHINE_DESC: 'test-machine',
  DEV_ROOT: '/test/dev/root',
});

// The exact `envsubst` variable-restriction string the install path passes. Listing
// the vars restricts envsubst to substitute ONLY these — any other `${...}` in a
// template is left literal, exactly as install.sh/update.sh do it.
const ENVSUBST_VARS = '${USER_NAME} ${AGENT_NAME} ${MACHINE_DESC} ${DEV_ROOT}';

// ── The prefix surface ────────────────────────────────────────────────────────
// The rendered identity/rules prefix is assembled from three template families, in
// the order they load into the system context: the body (CLAUDE.md), then the
// @-imported soul (personality.md), then the user-scoped rules (rules/*.md, sorted
// for a deterministic order). This list IS the audited surface; widen it only if a
// new template family joins the prefix.
function prefixSources(templatesDir = TEMPLATES_DIR) {
  const rulesDir = path.join(templatesDir, 'rules');
  const ruleFiles = fs.existsSync(rulesDir)
    ? fs
        .readdirSync(rulesDir)
        .filter((f) => f.endsWith('.md'))
        .sort() // deterministic order regardless of filesystem enumeration
        .map((f) => path.join(rulesDir, f))
    : [];
  return [
    path.join(templatesDir, 'CLAUDE.md'),
    path.join(templatesDir, 'personality.md'),
    ...ruleFiles,
  ];
}

// Render one template through envsubst with the FIXED test values, exactly as the
// install path does (same binary, same var-restriction string). Fixed inputs →
// byte-identical output across runs and across machines.
function renderTemplate(templatePath) {
  const raw = fs.readFileSync(templatePath, 'utf8');
  const env = { ...process.env, ...STABLE_VARS };
  // envsubst reads the template from stdin and writes the rendered form to stdout.
  return execFileSync('envsubst', [ENVSUBST_VARS], { input: raw, encoding: 'utf8', env });
}

// Assemble the full rendered prefix: each source rendered, joined by a stable
// separator that marks file boundaries (so a scan finding can name its source).
const SOURCE_SEPARATOR = '\n\n';

function renderPrefix(templatesDir = TEMPLATES_DIR) {
  const sources = prefixSources(templatesDir);
  const parts = [];
  for (const src of sources) {
    if (!fs.existsSync(src)) {
      throw new Error('prefix source missing: ' + src);
    }
    parts.push(renderTemplate(src));
  }
  return parts.join(SOURCE_SEPARATOR);
}

// ── Volatile-token scan ───────────────────────────────────────────────────────
// Each detector targets one per-session-volatile shape. A detector that matches
// means a token that would differ session-to-session sits in the prefix → AC-2
// violation. The four/five stable envsubst vars are NEVER matched here (they are
// rendered to fixed literals before the scan, and their literal values don't match
// these volatile shapes).
const DETECTORS = Object.freeze([
  {
    id: 'iso-timestamp',
    description: 'ISO-8601 date/datetime (e.g. 2026-06-18T12:00:00Z)',
    // Date or datetime; requires a full YYYY-MM-DD so plain version-ish numbers
    // (e.g. "20") don't trip it.
    re: /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
  },
  {
    id: 'date-now',
    description: 'JS Date.now() call',
    re: /\bDate\.now\s*\(\s*\)/g,
  },
  {
    id: 'new-date',
    description: 'JS `new Date()` construction',
    re: /\bnew\s+Date\s*\(/g,
  },
  {
    id: 'date-shellout',
    description: 'shell `date` command substitution ($(date ...) or `date +%s`)',
    // Two forms of an actually-executing date shellout:
    //   $(date ...)        — unambiguous command substitution
    //   `date +%s` / `date -u ...` — backtick substitution WITH a flag/format arg
    // The backtick branch deliberately requires `date` to be followed by an arg
    // (a `+`/`-` flag), NOT the bare word. This avoids a false positive on a markdown
    // inline-code span of the literal word `date` in prose (e.g. an "Allowed Bash
    // commands" list lists `date` as a code-span — documentation, not a volatile
    // shellout). A bare `date` produces no embedded volatile token; `date +%s` does.
    re: /\$\(\s*date\b[^)]*\)|`\s*date\s+[+-][^`]*`/g,
  },
  {
    id: 'session-id',
    description: 'sessionId / session_id reference',
    re: /\bsession[_-]?id\b/gi,
  },
  {
    id: 'pid',
    description: 'process id reference (process.pid / $$ / getpid)',
    re: /\bprocess\.pid\b|\bgetpid\s*\(|(?<![A-Za-z0-9_])\$\$(?![A-Za-z0-9_])/g,
  },
  {
    id: 'run-turn-counter',
    description: 'run/turn/call counter token (run_counter, turnCount, ...)',
    re: /\b(?:run|turn|call|invocation)[_-]?(?:counter|count|index|number|num|id)\b/gi,
  },
  {
    id: 'epoch-seconds',
    description: 'epoch seconds/millis literal (10–13 digit unix time)',
    // A bare 10–13 digit run of digits. The stable test values contain no such run,
    // so this can only fire on an actual embedded epoch.
    re: /(?<!\d)\d{10,13}(?!\d)/g,
  },
  {
    id: 'uuid',
    description: 'UUID (8-4-4-4-12 hex)',
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  },
]);

// Locate every match of every detector in the rendered prefix, with a 1-based
// line/column and a trimmed snippet for the finding report.
function scanVolatile(renderedPrefix) {
  const findings = [];
  const lines = renderedPrefix.split('\n');
  for (const det of DETECTORS) {
    // Fresh regex per detector run so lastIndex state never leaks.
    const re = new RegExp(det.re.source, det.re.flags);
    let m;
    while ((m = re.exec(renderedPrefix)) !== null) {
      const before = renderedPrefix.slice(0, m.index);
      const line = before.split('\n').length; // 1-based
      const col = m.index - before.lastIndexOf('\n'); // 1-based within the line
      findings.push({
        detector: det.id,
        description: det.description,
        match: m[0],
        line,
        column: col,
        snippet: (lines[line - 1] || '').trim().slice(0, 120),
      });
      if (m[0].length === 0) re.lastIndex++; // guard against zero-width loops
    }
  }
  return findings;
}

// Run the full audit: render the prefix, scan it, return a structured result.
function audit(templatesDir = TEMPLATES_DIR) {
  const renderedPrefix = renderPrefix(templatesDir);
  const findings = scanVolatile(renderedPrefix);
  return {
    sources: prefixSources(templatesDir).map((p) => path.relative(REPO_ROOT, p)),
    stableVars: STABLE_VARS,
    envsubstVars: ENVSUBST_VARS,
    prefixBytes: Buffer.byteLength(renderedPrefix, 'utf8'),
    findings,
    pass: findings.length === 0,
    renderedPrefix,
  };
}

module.exports = {
  STABLE_VARS,
  ENVSUBST_VARS,
  SOURCE_SEPARATOR,
  DETECTORS,
  prefixSources,
  renderTemplate,
  renderPrefix,
  scanVolatile,
  audit,
};

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  // --emit-baseline: print ONLY the rendered prefix bytes (the regenerate path for
  // the committed baseline). Nothing else on stdout so the artifact is clean.
  if (args.includes('--emit-baseline')) {
    process.stdout.write(renderPrefix());
    process.exit(0);
  }

  const result = audit();

  if (args.includes('--json')) {
    // Drop the full prefix body from JSON to keep it readable; bytes + findings
    // are the machine-actionable part.
    const { renderedPrefix, ...report } = result;
    console.log(JSON.stringify(report, null, 2));
    process.exit(result.pass ? 0 : 1);
  }

  // Human report.
  console.log('CacheAligner prefix-stability audit (Dioscuri AC-2 · DIO-1)');
  console.log('='.repeat(64));
  console.log('');
  console.log('Prefix surface audited (render order):');
  for (const s of result.sources) console.log('  - ' + s);
  console.log('');
  console.log(
    'Rendered with fixed test values (per-machine-stable, EXCLUDED from scan):'
  );
  for (const [k, v] of Object.entries(result.stableVars)) {
    console.log('  ' + k + ' = ' + v);
  }
  console.log('');
  console.log('Rendered prefix size: ' + result.prefixBytes + ' bytes');
  console.log('');
  console.log('Baseline artifact: hooks/test/fixtures/prefix-baseline.txt');
  console.log(
    'Regenerate:        node scripts/cache-aligner-audit.js --emit-baseline > hooks/test/fixtures/prefix-baseline.txt'
  );
  console.log('');
  console.log('Volatile-token findings:');
  if (result.findings.length === 0) {
    console.log('  (none) — PASS: no per-session-volatile token in the prefix.');
  } else {
    for (const f of result.findings) {
      console.log(
        '  [' +
          f.detector +
          '] line ' +
          f.line +
          ':' +
          f.column +
          '  "' +
          f.match +
          '"  — ' +
          f.description
      );
      console.log('      | ' + f.snippet);
    }
  }
  console.log('');
  console.log(result.pass ? 'RESULT: PASS' : 'RESULT: FAIL (' + result.findings.length + ' finding(s))');
  process.exit(result.pass ? 0 : 1);
}
