'use strict';

/**
 * Renders + installs a launchd LaunchAgent per background-digest job so the digests
 * run headless on their cron schedule whether or not a Claude session is open.
 *
 * Source of truth: config/scheduled-jobs.json (name/skill/cron). Each job becomes a
 * plist at ~/Library/LaunchAgents/com.claude-os.digest.<skill>.plist, derived from
 * config/launchd/com.claude-os.digest.plist.template, then (re)loaded via launchctl.
 *
 * The cron→StartCalendarInterval translation and plist rendering are PURE and exported
 * for tests. The launchctl side effects live in installAll(), which takes injectable
 * runCmd/log so tests can exercise the install logic without touching real launchd.
 *
 * The headless execution path is
 *   `claude -p /<skill> --permission-mode default --allowedTools <skill's tools>`:
 *   • -p / --print  → non-interactive, no TTY prompts (per `claude --help`).
 *   • /<skill>      → skills resolve via /skill-name even in print mode.
 *   • --permission-mode default + --allowedTools → enforces the skill's OWN frontmatter
 *     allow-set at the permission layer, so an unattended job (especially the WRITE-capable
 *     merge-progression, which transitions Jira) can use ONLY the tools its SKILL.md
 *     declares — nothing broader than the operator's own interactive sessions.
 *
 *     WHY NOT bypassPermissions: `bypassPermissions` is "Bypass all permission checks"
 *     (`claude --help`) — it allows EVERY tool regardless of --allowedTools, so the
 *     allowlist would be a silent no-op (verified: under bypass, a `touch` outside an
 *     `--allowedTools "Bash(echo *)"` set still ran; under `default`, the same out-of-set
 *     `rm` landed in `permission_denials` and the run still exited 0 / completed — no TTY
 *     prompt, no hang). `default` is the mode where --allowedTools both ENFORCES and
 *     fails-safe under no-TTY: anything outside the allow-set is DENIED, not prompted.
 *
 * Source of truth for each job's allow-set is its SKILL.md `allowed-tools:` frontmatter —
 * NOT a duplicate list in scheduled-jobs.json — so the skill-auditor's deny-list checks
 * (skills/skill-auditor/validate_frontmatter.py) stay authoritative over what runs headless,
 * and the two can never drift. The tokenizer here mirrors that auditor's _tokenize_tools.
 *
 * Fail-safe: if the real `claude` binary cannot be resolved, NO plist is written and an
 * error is logged — a launchd job pointing at a missing binary would fail silently on
 * every fire. update.sh surfaces the resolver failure as a [!!] warning.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO_DIR = path.resolve(__dirname, '..');
const JOBS_CONFIG = path.join(REPO_DIR, 'config', 'scheduled-jobs.json');
const TEMPLATE = path.join(REPO_DIR, 'config', 'launchd', 'com.claude-os.digest.plist.template');
const SKILLS_DIR = path.join(REPO_DIR, 'skills');
const LABEL_PREFIX = 'com.claude-os.digest.';

// ── cron → StartCalendarInterval ─────────────────────────────────────────────
//
// launchd's StartCalendarInterval is a dict (or array of dicts) with optional keys
// Minute, Hour, Day (of month), Weekday, Month. An OMITTED key is a wildcard — it
// matches every value. That is the inverse of cron's "*". So a cron field of "*" maps
// to "omit the key"; a literal number maps to that key with that integer.
//
// SUPPORTED cron grammar (only what the three real jobs need + safe generalizations):
//   • 5 fields: minute hour day-of-month month day-of-week
//   • "*"            → wildcard (key omitted)
//   • a single int   → that value
//   • a range "a-b"  → expanded to the set {a..b}; if a field has a set with >1 value,
//                      the WHOLE entry is expanded to an ARRAY of dicts (launchd's only
//                      way to express "any of these"), one dict per combination.
//   • a list "a,b,c" → same set semantics as a range.
//
// DELIBERATELY UNSUPPORTED (throws, so a mistranslation can never ship silently):
//   • step values  "*/5", "0-30/10"
//   • named months/days  "MON", "JAN"
//   • "?" / "L" / "#" and other non-standard extensions
//   • >5 or <5 fields (no seconds field, no year field)
//
// Cron weekday: 0 or 7 = Sunday, 1 = Monday … 6 = Saturday. launchd Weekday uses the
// same 0/7=Sunday convention, so weekday values pass through unchanged (7 normalized to 0).

function parseField(raw, { min, max, name }) {
  if (raw === '*') return null; // wildcard → omit key
  const values = new Set();
  for (const part of raw.split(',')) {
    if (part === '') throw new Error(`cron ${name}: empty list element in "${raw}"`);
    if (part.includes('/')) throw new Error(`cron ${name}: step values ("${part}") are not supported`);
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a > b) throw new Error(`cron ${name}: descending range "${part}" not supported`);
      for (let v = a; v <= b; v += 1) values.add(v);
      continue;
    }
    if (!/^\d+$/.test(part)) {
      throw new Error(`cron ${name}: unsupported token "${part}" (named/step/special syntax not supported)`);
    }
    values.add(Number(part));
  }
  for (const v of values) {
    if (v < min || v > max) throw new Error(`cron ${name}: value ${v} out of range ${min}-${max}`);
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * cronToCalendarIntervals(cron) → array of plain objects, each a StartCalendarInterval
 * dict. A single-dict cron yields a 1-element array; a cron with multiple matching
 * values in any field yields the cartesian product (launchd has no "range" — only a
 * list of exact-match dicts).
 *
 * Weekday key uses launchd's "Weekday"; day-of-month uses "Day". A wildcard field
 * contributes no key (true launchd wildcard).
 */
function cronToCalendarIntervals(cron) {
  const fields = String(cron).trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron "${cron}" must have exactly 5 fields, got ${fields.length}`);
  }
  const [minF, hourF, domF, monF, dowF] = fields;
  const minute = parseField(minF, { min: 0, max: 59, name: 'minute' });
  const hour = parseField(hourF, { min: 0, max: 23, name: 'hour' });
  const dom = parseField(domF, { min: 1, max: 31, name: 'day-of-month' });
  const month = parseField(monF, { min: 1, max: 12, name: 'month' });
  let dow = parseField(dowF, { min: 0, max: 7, name: 'weekday' });
  // Normalize cron's 7=Sunday to launchd's 0=Sunday, de-dup.
  if (dow) dow = [...new Set(dow.map((v) => (v === 7 ? 0 : v)))].sort((a, b) => a - b);

  // Build cartesian product across the non-wildcard fields.
  const axes = [
    ['Minute', minute],
    ['Hour', hour],
    ['Day', dom],
    ['Month', month],
    ['Weekday', dow],
  ].filter(([, vals]) => vals !== null);

  if (axes.length === 0) {
    // cron "* * * * *" — every minute. launchd expresses "every minute" as an empty
    // StartCalendarInterval dict. Unlikely for a digest, but defined rather than crashing.
    return [{}];
  }

  let combos = [{}];
  for (const [key, vals] of axes) {
    const next = [];
    for (const combo of combos) {
      for (const v of vals) next.push({ ...combo, [key]: v });
    }
    combos = next;
  }
  return combos;
}

// ── per-skill allow-set (from SKILL.md frontmatter) ──────────────────────────
//
// Each background skill declares its tools in an `allowed-tools:` frontmatter line.
// We read that line and pass EXACTLY those tools to `claude --allowedTools`, so the
// headless run is narrowed to the skill's own contract — pr-digest is gh-only, while
// merge-progression carries the Jira-WRITE MCP tools. The frontmatter is the single
// source of truth (the skill-auditor validates it), so we never duplicate the list.

/**
 * Tokenize an `allowed-tools` value into individual tool specs. A parenthetical like
 * `Bash(gh *)` is ONE token even though it contains a space — we only split on commas
 * or whitespace at paren depth 0. This mirrors skill-auditor/validate_frontmatter.py's
 * _tokenize_tools so the installer and the auditor agree on what a tool token is;
 * splitting naively on whitespace would shred `Bash(gh *)` into bogus tokens.
 */
function tokenizeTools(raw) {
  const toks = [];
  let buf = '';
  let depth = 0;
  for (const ch of String(raw)) {
    if (ch === '(') { depth += 1; buf += ch; }
    else if (ch === ')') { depth = Math.max(0, depth - 1); buf += ch; }
    else if (depth === 0 && (/\s/.test(ch) || ch === ',')) {
      if (buf) { toks.push(buf); buf = ''; }
    } else {
      buf += ch;
    }
  }
  if (buf) toks.push(buf);
  return toks.filter(Boolean);
}

/**
 * Read the `allowed-tools:` frontmatter line from a skill's SKILL.md and return its
 * tokenized tool specs. Throws if the skill file is missing or declares no allow-set —
 * a background job with NO allowlist would either run unconstrained (security regression)
 * or do nothing, so an empty/absent allow-set is a hard config error, never a silent pass.
 *
 * Parses only the top-level `allowed-tools:` line inside the leading `---` frontmatter
 * block (the digest skills declare it inline on one line, like every skill in this repo).
 */
function readSkillAllowedTools(skill, { skillsDir = SKILLS_DIR, readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const skillPath = path.join(skillsDir, skill, 'SKILL.md');
  let text;
  try {
    text = readFile(skillPath);
  } catch (e) {
    throw new Error(`cannot read allow-set for "${skill}": ${skillPath} unreadable (${e.message})`);
  }
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') {
    throw new Error(`skill "${skill}": SKILL.md has no opening --- frontmatter`);
  }
  let raw = null;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '---') break; // end of frontmatter
    if (line[0] === ' ' || line[0] === '\t') continue; // nested/continuation, not top-level
    const m = line.match(/^allowed-tools:(.*)$/);
    if (m) { raw = m[1].trim(); break; }
  }
  if (raw === null) {
    throw new Error(`skill "${skill}": no top-level "allowed-tools:" in frontmatter — a headless job must declare its allow-set`);
  }
  const tools = tokenizeTools(raw);
  if (tools.length === 0) {
    throw new Error(`skill "${skill}": "allowed-tools:" is empty — a headless job must declare at least one tool`);
  }
  return tools;
}

/**
 * Render the per-job `--allowedTools` ProgramArguments XML: the flag string followed by
 * one <string> per declared tool. claude accepts space-separated tool args, and passing
 * each as its OWN <string> keeps a parenthetical like `Bash(gh *)` intact (no shell word
 * splitting — launchd execs argv directly). Tool specs are XML-escaped defensively.
 */
function allowedToolsXml(tools) {
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const args = tools.map((t) => `    <string>${esc(t)}</string>`).join('\n');
  return `<string>--allowedTools</string>\n${args}`;
}

// ── plist rendering ──────────────────────────────────────────────────────────

const PLIST_KEY_ORDER = ['Minute', 'Hour', 'Day', 'Month', 'Weekday'];

function calendarIntervalXml(intervals) {
  const dictXml = (d) => {
    const inner = PLIST_KEY_ORDER
      .filter((k) => Object.prototype.hasOwnProperty.call(d, k))
      .map((k) => `      <key>${k}</key><integer>${d[k]}</integer>`)
      .join('\n');
    return `    <dict>\n${inner}\n    </dict>`;
  };
  if (intervals.length === 1) {
    // Single dict — emit the dict directly as the value (launchd accepts dict OR array).
    const d = intervals[0];
    const inner = PLIST_KEY_ORDER
      .filter((k) => Object.prototype.hasOwnProperty.call(d, k))
      .map((k) => `    <key>${k}</key><integer>${d[k]}</integer>`)
      .join('\n');
    // An empty dict (every-minute) renders as <dict/> equivalent.
    const body = inner ? `\n${inner}\n  ` : '';
    return `<key>StartCalendarInterval</key>\n  <dict>${body}</dict>`;
  }
  const arr = intervals.map(dictXml).join('\n');
  return `<key>StartCalendarInterval</key>\n  <array>\n${arr}\n  </array>`;
}

/**
 * Render the plist string for one job. Pure: takes resolved values, returns text.
 * `template` is the raw template string; `subs` provides the scalar placeholders.
 */
function renderPlist(template, { label, skill, claudeBin, binPath, home, calendarXml, allowedToolsXml: allowedXml }) {
  return template
    .split('${LABEL}').join(label)
    .split('${SKILL}').join(skill)
    .split('${CLAUDE_BIN}').join(claudeBin)
    .split('${BIN_PATH}').join(binPath)
    .split('${HOME}').join(home)
    .split('${ALLOWED_TOOLS}').join(allowedXml)
    .split('${CALENDAR_INTERVAL}').join(calendarXml);
}

function labelFor(skill) {
  return LABEL_PREFIX + skill;
}

/**
 * Build the full render plan from config — pure, no I/O side effects beyond reading
 * the two committed files. Throws on a bad cron so a mistranslation cannot ship.
 */
function buildPlan({ jobsConfig = JOBS_CONFIG, template = TEMPLATE, skillsDir = SKILLS_DIR, claudeBin, binPath, home }) {
  const cfg = JSON.parse(fs.readFileSync(jobsConfig, 'utf8'));
  const tpl = fs.readFileSync(template, 'utf8');
  const jobs = Array.isArray(cfg.jobs) ? cfg.jobs : [];
  return jobs.map((job) => {
    const intervals = cronToCalendarIntervals(job.cron);
    const allowedTools = readSkillAllowedTools(job.skill, { skillsDir });
    const label = labelFor(job.skill);
    const plist = renderPlist(tpl, {
      label,
      skill: job.skill,
      claudeBin,
      binPath,
      home,
      calendarXml: calendarIntervalXml(intervals),
      allowedToolsXml: allowedToolsXml(allowedTools),
    });
    return { name: job.name, skill: job.skill, cron: job.cron, label, intervals, allowedTools, plist };
  });
}

// ── binary resolution ────────────────────────────────────────────────────────

/**
 * Resolve the REAL claude binary path (not the shell alias — aliases don't exist for
 * launchd). We prefer the STABLE ~/.local/bin/claude path rather than its resolved
 * version-pinned target, so a `claude` upgrade (which re-points that symlink) does not
 * strand the plist at a deleted version dir. Returns null if no binary exists anywhere
 * (fail-safe: the caller then writes nothing rather than scheduling a broken job).
 */
function resolveClaudeBin(home = os.homedir(), existsSync = fs.existsSync) {
  const candidates = [
    path.join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * The PATH a LaunchAgent gets is minimal and omits Homebrew + the node shim dir, so the
 * skills' Bash(gh/jira/node) calls would fail to find their binaries. Compose a PATH that
 * includes the dirs of the resolved tool binaries plus the standard system dirs.
 * nodeBin is process.execPath of the resolver run — its dir is where this machine's node
 * lives (fnm/nvm shims are volatile, so we pin the concrete dir, not a shim).
 */
function resolveBinPath({ home = os.homedir(), nodeBin = process.execPath, existsSync = fs.existsSync } = {}) {
  const dirs = [];
  const add = (d) => { if (d && !dirs.includes(d)) dirs.push(d); };
  const claudeBin = resolveClaudeBin(home, existsSync);
  if (claudeBin) add(path.dirname(claudeBin));
  if (nodeBin) add(path.dirname(nodeBin));
  // gh / jira live in Homebrew on this fleet; include both Apple-silicon and Intel prefixes.
  add('/opt/homebrew/bin');
  add('/usr/local/bin');
  add('/usr/bin');
  add('/bin');
  add('/usr/sbin');
  add('/sbin');
  return dirs.join(':');
}

// ── install (side-effecting, but injectable) ────────────────────────────────

/**
 * installAll renders every job's plist and (re)loads it via launchctl, idempotently:
 *   • if the on-disk plist already matches the rendered text AND the agent is loaded,
 *     it is left untouched (no churn, no double-load);
 *   • if missing/changed, it is rewritten and bootout→bootstrap'd exactly once.
 *
 * runCmd(cmd, args) → { status, ... } mirrors child_process.spawnSync's shape; injected
 * so tests assert the launchctl call sequence without touching real launchd. writeFile/
 * readFile/exists are injected for the same reason.
 */
function installAll(opts = {}) {
  const home = opts.home || os.homedir();
  const log = opts.log || (() => {});
  const claudeBin = ('claudeBin' in opts) ? opts.claudeBin : resolveClaudeBin(home, opts.existsSync || fs.existsSync);

  if (!claudeBin) {
    log('warn', 'Could not resolve a real `claude` binary — skipping digest launchd install (jobs NOT scheduled). Install claude to ~/.local/bin or Homebrew, then re-run update.sh.');
    return { installed: [], skipped: [], failed: [], resolved: false };
  }

  const binPath = ('binPath' in opts) ? opts.binPath
    : resolveBinPath({ home, nodeBin: opts.nodeBin || process.execPath, existsSync: opts.existsSync || fs.existsSync });

  let plan;
  try {
    plan = buildPlan({
      jobsConfig: opts.jobsConfig || JOBS_CONFIG,
      template: opts.template || TEMPLATE,
      skillsDir: opts.skillsDir || SKILLS_DIR,
      claudeBin,
      binPath,
      home,
    });
  } catch (e) {
    log('warn', `Digest launchd install aborted — bad scheduled-jobs.json, cron, or skill allow-set: ${e.message}`);
    return { installed: [], skipped: [], failed: [], resolved: true, error: e.message };
  }

  const readFile = opts.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const writeFile = opts.writeFile || ((p, c) => fs.writeFileSync(p, c));
  const exists = opts.existsSync || fs.existsSync;
  const mkdir = opts.mkdir || ((d) => fs.mkdirSync(d, { recursive: true }));
  const runCmd = opts.runCmd || require('node:child_process').spawnSync;

  const agentsDir = opts.agentsDir || path.join(home, 'Library', 'LaunchAgents');
  const logsDir = path.join(home, '.claude-data', '.logs');
  const domain = opts.domain || `gui/${typeof process.getuid === 'function' ? process.getuid() : ''}`;

  mkdir(agentsDir);
  mkdir(logsDir);

  const result = { installed: [], skipped: [], failed: [], resolved: true };

  for (const job of plan) {
    const plistPath = path.join(agentsDir, `${job.label}.plist`);
    const target = `${domain}/${job.label}`;
    const current = exists(plistPath) ? readFile(plistPath) : null;

    const isLoaded = () => {
      const r = runCmd('launchctl', ['print', target], { stdio: 'ignore' });
      return r && r.status === 0;
    };
    const bootstrap = () => {
      // bootout first so a stale definition is replaced; ignore its failure (not loaded yet).
      runCmd('launchctl', ['bootout', target], { stdio: 'ignore' });
      const r = runCmd('launchctl', ['bootstrap', domain, plistPath], { stdio: 'ignore' });
      return r && r.status === 0;
    };

    try {
      if (current === job.plist) {
        if (isLoaded()) {
          result.skipped.push(job.label);
          log('skip', `${job.label} current and loaded`);
        } else if (bootstrap()) {
          result.installed.push(job.label);
          log('ok', `${job.label} loaded (plist was current)`);
        } else {
          result.failed.push(job.label);
          log('warn', `${job.label} plist current but launchctl bootstrap failed — load manually`);
        }
      } else {
        writeFile(plistPath, job.plist);
        if (bootstrap()) {
          result.installed.push(job.label);
          log('ok', `${job.label} written and (re)loaded (cron ${job.cron})`);
        } else {
          result.failed.push(job.label);
          log('warn', `${job.label} plist written but launchctl bootstrap failed — load manually`);
        }
      }
    } catch (e) {
      result.failed.push(job.label);
      log('warn', `${job.label} install error: ${e.message}`);
    }
  }

  return result;
}

module.exports = {
  parseField,
  cronToCalendarIntervals,
  calendarIntervalXml,
  tokenizeTools,
  readSkillAllowedTools,
  allowedToolsXml,
  renderPlist,
  buildPlan,
  resolveClaudeBin,
  resolveBinPath,
  installAll,
  labelFor,
  LABEL_PREFIX,
  JOBS_CONFIG,
  TEMPLATE,
  SKILLS_DIR,
};

if (require.main === module) {
  // CLI entry: human-readable status to stdout; non-zero exit only on a hard config error.
  const colors = { ok: '\x1b[0;32m[OK]\x1b[0m', skip: '\x1b[1;33m[SKIP]\x1b[0m', warn: '\x1b[1;33m[!!]\x1b[0m' };
  const res = installAll({
    log: (level, msg) => process.stdout.write(`${colors[level] || level} ${msg}\n`),
  });
  if (res.error) process.exit(1);
}
