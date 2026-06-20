'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
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
} = require('../digest-launchd-install.js');

// ── cron → StartCalendarInterval translation table ───────────────────────────
//
// The three REAL jobs plus generalization cases. The Mon-Fri hourly one
// ("15 * * * 1-5") is the load-bearing case: minute fixed, hour wildcard,
// weekday a 5-element range → an ARRAY of 5 dicts, each {Minute:15, Weekday:n}.

test('cron "0 6 * * *" → single dict {Minute:0, Hour:6}', () => {
  const out = cronToCalendarIntervals('0 6 * * *');
  assert.deepEqual(out, [{ Minute: 0, Hour: 6 }]);
});

test('cron "30 6 * * *" → single dict {Minute:30, Hour:6}', () => {
  const out = cronToCalendarIntervals('30 6 * * *');
  assert.deepEqual(out, [{ Minute: 30, Hour: 6 }]);
});

test('cron "15 * * * 1-5" → array of 5 dicts, Mon-Fri at minute 15, hour wildcard (omitted)', () => {
  const out = cronToCalendarIntervals('15 * * * 1-5');
  assert.equal(out.length, 5);
  assert.deepEqual(out, [
    { Minute: 15, Weekday: 1 },
    { Minute: 15, Weekday: 2 },
    { Minute: 15, Weekday: 3 },
    { Minute: 15, Weekday: 4 },
    { Minute: 15, Weekday: 5 },
  ]);
  // Critically, Hour is OMITTED (launchd wildcard = "every hour"), not set to a value.
  for (const d of out) assert.equal('Hour' in d, false);
});

test('cron weekday 7 and 0 both normalize to launchd Sunday=0, de-duped', () => {
  assert.deepEqual(cronToCalendarIntervals('0 0 * * 7'), [{ Minute: 0, Hour: 0, Weekday: 0 }]);
  // "0,7" is Sunday listed twice → a single Weekday:0 dict, not two.
  assert.deepEqual(cronToCalendarIntervals('0 0 * * 0,7'), [{ Minute: 0, Hour: 0, Weekday: 0 }]);
});

test('cron list field "0 6,18 * * *" → 2 dicts (cartesian product over hour)', () => {
  const out = cronToCalendarIntervals('0 6,18 * * *');
  assert.deepEqual(out, [
    { Minute: 0, Hour: 6 },
    { Minute: 0, Hour: 18 },
  ]);
});

test('all wildcards "* * * * *" → single empty dict (every minute)', () => {
  assert.deepEqual(cronToCalendarIntervals('* * * * *'), [{}]);
});

test('cron day-of-month maps to launchd "Day", month to "Month"', () => {
  assert.deepEqual(cronToCalendarIntervals('0 0 1 1 *'), [{ Minute: 0, Hour: 0, Day: 1, Month: 1 }]);
});

// ── unsupported cron grammar must THROW (never mistranslate silently) ─────────

test('step values throw rather than mistranslate', () => {
  assert.throws(() => cronToCalendarIntervals('*/5 * * * *'), /step values/);
  assert.throws(() => cronToCalendarIntervals('0-30/10 * * * *'), /step values/);
});

test('named months/days throw', () => {
  assert.throws(() => cronToCalendarIntervals('0 0 * * MON'), /unsupported token/);
});

test('wrong field count throws', () => {
  assert.throws(() => cronToCalendarIntervals('0 6 * *'), /exactly 5 fields/);
  assert.throws(() => cronToCalendarIntervals('0 6 * * * *'), /exactly 5 fields/);
});

test('out-of-range values throw', () => {
  assert.throws(() => cronToCalendarIntervals('60 * * * *'), /minute: value 60/);
  assert.throws(() => cronToCalendarIntervals('* 24 * * *'), /hour: value 24/);
  assert.throws(() => cronToCalendarIntervals('* * 0 * *'), /day-of-month: value 0/);
});

// ── XML rendering ────────────────────────────────────────────────────────────

test('single-dict cron renders a <dict> value, not an <array>', () => {
  const xml = calendarIntervalXml(cronToCalendarIntervals('0 6 * * *'));
  assert.match(xml, /<key>StartCalendarInterval<\/key>/);
  assert.match(xml, /<dict>/);
  assert.doesNotMatch(xml, /<array>/);
  assert.match(xml, /<key>Minute<\/key><integer>0<\/integer>/);
  assert.match(xml, /<key>Hour<\/key><integer>6<\/integer>/);
});

test('multi-dict cron renders an <array> of <dict> entries', () => {
  const xml = calendarIntervalXml(cronToCalendarIntervals('15 * * * 1-5'));
  assert.match(xml, /<array>/);
  // 5 weekday dicts → 5 Weekday integers and 5 Minute integers.
  assert.equal((xml.match(/<key>Weekday<\/key>/g) || []).length, 5);
  assert.equal((xml.match(/<key>Minute<\/key><integer>15<\/integer>/g) || []).length, 5);
  // Hour must never appear (wildcard).
  assert.doesNotMatch(xml, /<key>Hour<\/key>/);
});

test('rendered plist XML is well-formed and substitutes every placeholder', () => {
  const tpl = require('node:fs').readFileSync(
    path.resolve(__dirname, '..', '..', 'config', 'launchd', 'com.claude-os.digest.plist.template'),
    'utf8',
  );
  const xml = renderPlist(tpl, {
    label: 'com.claude-os.digest.background-pr-digest',
    skill: 'background-pr-digest',
    claudeBin: '/Users/x/.local/bin/claude',
    binPath: '/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin:/bin',
    home: '/Users/x',
    calendarXml: calendarIntervalXml(cronToCalendarIntervals('0 6 * * *')),
    allowedToolsXml: allowedToolsXml(['Bash(gh *)', 'Bash(node *)']),
  });
  // No unsubstituted placeholders remain.
  assert.doesNotMatch(xml, /\$\{[A-Z_]+\}/);
  // Key invariants for a launchd LaunchAgent digest.
  assert.match(xml, /<string>\/background-pr-digest<\/string>/);     // skill prompt
  assert.match(xml, /<string>--permission-mode<\/string>/);
  // default mode (NOT bypassPermissions) — only the mode where --allowedTools is honored.
  assert.match(xml, /<string>default<\/string>/);
  assert.doesNotMatch(xml, /bypassPermissions/);
  assert.match(xml, /<string>--allowedTools<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key><false\/>/);               // do NOT fire on update reload
  assert.match(xml, /background-pr-digest\.err/);                    // per-skill error log
});

// ── allow-set tokenization + frontmatter read + rendered args ────────────────

test('tokenizeTools keeps Bash(gh *) as ONE token across the internal space', () => {
  const toks = tokenizeTools('Bash(gh *) Bash(node *) mcp__atlassian__getJiraIssue');
  assert.deepEqual(toks, ['Bash(gh *)', 'Bash(node *)', 'mcp__atlassian__getJiraIssue']);
  // Comma-separated form parses identically.
  assert.deepEqual(tokenizeTools('Bash(gh *), Edit'), ['Bash(gh *)', 'Edit']);
});

test('readSkillAllowedTools reads each skill\'s OWN frontmatter allow-set verbatim', () => {
  // pr-digest is gh-only (no jira, no MCP).
  const pr = readSkillAllowedTools('background-pr-digest');
  assert.deepEqual(pr, ['Bash(gh *)', 'Bash(node *)', 'Bash(jq *)', 'Bash(date *)']);
  assert.ok(!pr.some((t) => /jira|mcp__/.test(t)), 'pr-digest must carry NO jira/MCP tools');

  // sprint-digest adds jira CLI + a single READ-only Jira MCP search tool.
  const sprint = readSkillAllowedTools('background-sprint-digest');
  assert.ok(sprint.includes('mcp__atlassian__searchJiraIssuesUsingJql'));
  assert.ok(!sprint.includes('mcp__atlassian__transitionJiraIssue'),
    'sprint-digest must NOT carry the Jira write/transition tool');

  // merge-progression is the WRITE job: it MUST carry the Jira transition + comment tools.
  const merge = readSkillAllowedTools('background-merge-progression');
  assert.ok(merge.includes('mcp__atlassian__transitionJiraIssue'));
  assert.ok(merge.includes('mcp__atlassian__addCommentToJiraIssue'));
  assert.ok(merge.includes('mcp__atlassian__getTransitionsForJiraIssue'));
});

test('readSkillAllowedTools throws when a skill declares no allow-set (no silent unconstrained run)', () => {
  const os = require('node:os');
  const fsReal = require('node:fs');
  const dir = fsReal.mkdtempSync(path.join(os.tmpdir(), 'digest-noallow-'));
  fsReal.mkdirSync(path.join(dir, 'no-tools'));
  fsReal.writeFileSync(path.join(dir, 'no-tools', 'SKILL.md'), '---\nname: no-tools\n---\nbody\n');
  try {
    assert.throws(() => readSkillAllowedTools('no-tools', { skillsDir: dir }), /no top-level "allowed-tools:"/);
  } finally {
    fsReal.rmSync(dir, { recursive: true, force: true });
  }
});

test('allowedToolsXml emits the flag plus one <string> per tool, XML-escaped', () => {
  const xml = allowedToolsXml(['Bash(gh *)', 'mcp__atlassian__transitionJiraIssue']);
  assert.match(xml, /<string>--allowedTools<\/string>/);
  assert.match(xml, /<string>Bash\(gh \*\)<\/string>/);
  assert.match(xml, /<string>mcp__atlassian__transitionJiraIssue<\/string>/);
  // Each tool is its own <string> (no shell splitting of the Bash(gh *) space).
  assert.equal((xml.match(/<string>/g) || []).length, 3);
});

// ── buildPlan over the real scheduled-jobs.json ──────────────────────────────

test('buildPlan renders one plist per job from the committed config', () => {
  const plan = buildPlan({
    claudeBin: '/Users/x/.local/bin/claude',
    binPath: '/Users/x/.local/bin:/usr/bin',
    home: '/Users/x',
  });
  assert.equal(plan.length, 3);
  const bySkill = Object.fromEntries(plan.map((p) => [p.skill, p]));
  assert.ok(bySkill['background-pr-digest']);
  assert.ok(bySkill['background-sprint-digest']);
  assert.ok(bySkill['background-merge-progression']);
  // The merge-progression job is the array-of-5 case end-to-end.
  assert.equal(bySkill['background-merge-progression'].intervals.length, 5);
  assert.match(bySkill['background-merge-progression'].plist, /<array>/);
  // Labels follow the prefix convention.
  assert.equal(bySkill['background-pr-digest'].label, 'com.claude-os.digest.background-pr-digest');
});

test('per-job allowlist is rendered into ProgramArguments — pr-digest has NO jira-write; merge-progression DOES', () => {
  const plan = buildPlan({
    claudeBin: '/Users/x/.local/bin/claude',
    binPath: '/Users/x/.local/bin:/usr/bin',
    home: '/Users/x',
  });
  const bySkill = Object.fromEntries(plan.map((p) => [p.skill, p]));

  const prPlist = bySkill['background-pr-digest'].plist;
  const mergePlist = bySkill['background-merge-progression'].plist;
  const sprintPlist = bySkill['background-sprint-digest'].plist;

  // Every job renders default mode + an --allowedTools block, never bypassPermissions.
  for (const p of plan) {
    assert.match(p.plist, /<string>--permission-mode<\/string>\s*<string>default<\/string>/);
    assert.doesNotMatch(p.plist, /bypassPermissions/, `${p.skill} must not bypass`);
    assert.match(p.plist, /<string>--allowedTools<\/string>/, `${p.skill} must carry an allowlist`);
  }

  // pr-digest is gh-only: its rendered args must contain NO jira and NO MCP tool at all.
  assert.match(prPlist, /<string>Bash\(gh \*\)<\/string>/);
  assert.doesNotMatch(prPlist, /jira/, 'pr-digest plist must not grant any jira tool');
  assert.doesNotMatch(prPlist, /mcp__/, 'pr-digest plist must not grant any MCP tool');

  // sprint-digest carries READ-only Jira search MCP, but NOT the write/transition tool.
  assert.match(sprintPlist, /mcp__atlassian__searchJiraIssuesUsingJql/);
  assert.doesNotMatch(sprintPlist, /transitionJiraIssue/, 'sprint-digest must not be able to transition');

  // merge-progression is the WRITE job: its plist MUST grant the Jira transition + comment tools.
  assert.match(mergePlist, /<string>mcp__atlassian__transitionJiraIssue<\/string>/);
  assert.match(mergePlist, /<string>mcp__atlassian__addCommentToJiraIssue<\/string>/);
  // ...but nothing beyond its declared set — e.g. it never gains the search-only tool it didn't declare.
  assert.doesNotMatch(mergePlist, /searchJiraIssuesUsingJql/, 'merge-progression must carry only its declared MCP tools');

  // The allowlist that buildPlan recorded matches each skill's frontmatter exactly.
  assert.deepEqual(bySkill['background-pr-digest'].allowedTools, readSkillAllowedTools('background-pr-digest'));
  assert.deepEqual(bySkill['background-merge-progression'].allowedTools, readSkillAllowedTools('background-merge-progression'));
});

// ── binary resolution / fail-safe ────────────────────────────────────────────

test('resolveClaudeBin prefers ~/.local/bin/claude, returns null when nothing exists', () => {
  const home = '/Users/x';
  const existsLocal = (p) => p === path.join(home, '.local', 'bin', 'claude');
  assert.equal(resolveClaudeBin(home, existsLocal), path.join(home, '.local', 'bin', 'claude'));
  assert.equal(resolveClaudeBin(home, () => false), null);
  // Falls back to Homebrew when ~/.local is absent.
  const existsBrew = (p) => p === '/opt/homebrew/bin/claude';
  assert.equal(resolveClaudeBin(home, existsBrew), '/opt/homebrew/bin/claude');
});

test('resolveBinPath includes the node dir, claude dir, and Homebrew, with no duplicates', () => {
  const binPath = resolveBinPath({
    home: '/Users/x',
    nodeBin: '/Users/x/.fnm/node',
    existsSync: (p) => p === '/Users/x/.local/bin/claude',
  });
  const dirs = binPath.split(':');
  assert.ok(dirs.includes('/Users/x/.local/bin'));   // claude dir
  assert.ok(dirs.includes('/Users/x/.fnm'));          // node dir
  assert.ok(dirs.includes('/opt/homebrew/bin'));      // gh/jira
  assert.ok(dirs.includes('/usr/sbin'));              // sysctl etc.
  assert.equal(new Set(dirs).size, dirs.length, 'no duplicate PATH entries');
});

test('installAll FAILS SAFE when claude is unresolvable: writes nothing, loads nothing, warns', () => {
  const logs = [];
  let wrote = false;
  let ranLaunchctl = false;
  const res = installAll({
    claudeBin: null, // explicit unresolvable
    home: '/Users/x',
    writeFile: () => { wrote = true; },
    runCmd: () => { ranLaunchctl = true; return { status: 0 }; },
    mkdir: () => {},
    log: (level, msg) => logs.push([level, msg]),
  });
  assert.equal(res.resolved, false);
  assert.equal(wrote, false, 'must not write any plist');
  assert.equal(ranLaunchctl, false, 'must not invoke launchctl');
  assert.equal(res.installed.length, 0);
  assert.ok(logs.some(([lvl]) => lvl === 'warn'));
});

// ── idempotency of the install logic (mocked launchctl + fs) ──────────────────

function fakeFs(initial = {}) {
  const files = { ...initial };
  return {
    files,
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    read: (p) => files[p],
    write: (p, c) => { files[p] = c; },
  };
}

// A launchctl mock that records every call and lets the test control whether the
// agent reports as "loaded" (print exit code).
function fakeLaunchctl({ loadedTargets = new Set() } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd !== 'launchctl') return { status: 0 };
    const sub = args[0];
    if (sub === 'print') {
      const target = args[1];
      return { status: loadedTargets.has(target) ? 0 : 1 };
    }
    if (sub === 'bootstrap') {
      // bootstrap loads gui/<uid> <plistPath>; mark the label loaded.
      loadedTargets.add(`${args[1]}/__loaded__`); // not used for assertions; presence of call is
      return { status: 0 };
    }
    if (sub === 'bootout') return { status: 0 };
    return { status: 0 };
  };
  return { run, calls, loadedTargets };
}

const FIXED = {
  home: '/Users/x',
  claudeBin: '/Users/x/.local/bin/claude',
  binPath: '/Users/x/.local/bin:/usr/bin',
  agentsDir: '/Users/x/Library/LaunchAgents',
  domain: 'gui/501',
};

test('first install: writes all 3 plists and bootstraps each exactly once', () => {
  const fs2 = fakeFs();
  const lc = fakeLaunchctl();
  const res = installAll({
    ...FIXED,
    existsSync: fs2.exists,
    readFile: fs2.read,
    writeFile: fs2.write,
    mkdir: () => {},
    runCmd: lc.run,
    log: () => {},
  });
  assert.equal(res.installed.length, 3);
  assert.equal(res.skipped.length, 0);
  // 3 plists written.
  assert.equal(Object.keys(fs2.files).filter((f) => f.endsWith('.plist')).length, 3);
  // Each label bootstrapped exactly once.
  const bootstraps = lc.calls.filter((c) => c[1] === 'bootstrap');
  assert.equal(bootstraps.length, 3);
});

test('idempotent re-run: identical plists already loaded → all skipped, no write, no bootstrap', () => {
  // Pre-seed the fs with the exact rendered plists and mark all loaded.
  const plan = buildPlan({ claudeBin: FIXED.claudeBin, binPath: FIXED.binPath, home: FIXED.home });
  const initial = {};
  const loaded = new Set();
  for (const job of plan) {
    initial[path.join(FIXED.agentsDir, `${job.label}.plist`)] = job.plist;
    loaded.add(`${FIXED.domain}/${job.label}`);
  }
  const fs2 = fakeFs(initial);
  const lc = fakeLaunchctl({ loadedTargets: loaded });
  let wrote = false;
  const res = installAll({
    ...FIXED,
    existsSync: fs2.exists,
    readFile: fs2.read,
    writeFile: (p, c) => { wrote = true; fs2.write(p, c); },
    mkdir: () => {},
    runCmd: lc.run,
    log: () => {},
  });
  assert.equal(res.skipped.length, 3, 'all current-and-loaded → skipped');
  assert.equal(res.installed.length, 0);
  assert.equal(wrote, false, 'no plist rewritten on idempotent re-run');
  assert.equal(lc.calls.filter((c) => c[1] === 'bootstrap').length, 0, 'no bootstrap on idempotent re-run');
});

test('current-but-not-loaded plist is bootstrapped without a rewrite', () => {
  const plan = buildPlan({ claudeBin: FIXED.claudeBin, binPath: FIXED.binPath, home: FIXED.home });
  const initial = {};
  for (const job of plan) {
    initial[path.join(FIXED.agentsDir, `${job.label}.plist`)] = job.plist;
  }
  const fs2 = fakeFs(initial);
  const lc = fakeLaunchctl({ loadedTargets: new Set() }); // nothing loaded
  let wrote = false;
  const res = installAll({
    ...FIXED,
    existsSync: fs2.exists,
    readFile: fs2.read,
    writeFile: (p, c) => { wrote = true; fs2.write(p, c); },
    mkdir: () => {},
    runCmd: lc.run,
    log: () => {},
  });
  assert.equal(res.installed.length, 3, 'loaded because not currently loaded');
  assert.equal(wrote, false, 'plist text unchanged → no rewrite');
  assert.equal(lc.calls.filter((c) => c[1] === 'bootstrap').length, 3);
});

test('changed plist (e.g. node path drift) is rewritten and re-bootstrapped once', () => {
  const plan = buildPlan({ claudeBin: FIXED.claudeBin, binPath: '/OLD/PATH', home: FIXED.home });
  const initial = {};
  const loaded = new Set();
  for (const job of plan) {
    initial[path.join(FIXED.agentsDir, `${job.label}.plist`)] = job.plist; // stale (old binPath)
    loaded.add(`${FIXED.domain}/${job.label}`);
  }
  const fs2 = fakeFs(initial);
  const lc = fakeLaunchctl({ loadedTargets: loaded });
  const res = installAll({
    ...FIXED, // new binPath differs from /OLD/PATH
    existsSync: fs2.exists,
    readFile: fs2.read,
    writeFile: fs2.write,
    mkdir: () => {},
    runCmd: lc.run,
    log: () => {},
  });
  assert.equal(res.installed.length, 3, 'all rewritten because text changed');
  // bootout precedes bootstrap on a rewrite.
  const boots = lc.calls.filter((c) => c[1] === 'bootout' || c[1] === 'bootstrap').map((c) => c[1]);
  assert.equal(boots.filter((b) => b === 'bootstrap').length, 3);
  assert.equal(boots.filter((b) => b === 'bootout').length, 3);
});

test('a bad cron in config aborts the whole install (no partial scheduling)', () => {
  const fs2 = fakeFs();
  const lc = fakeLaunchctl();
  let wrote = false;
  // Point at a temp jobs file containing an unsupported cron.
  const os = require('node:os');
  const fsReal = require('node:fs');
  const tmp = path.join(os.tmpdir(), `digest-badcron-${process.pid}.json`);
  fsReal.writeFileSync(tmp, JSON.stringify({ jobs: [{ name: 'Bad', skill: 'x', cron: '*/5 * * * *' }] }));
  try {
    const res = installAll({
      ...FIXED,
      jobsConfig: tmp,
      existsSync: fs2.exists,
      readFile: fs2.read,
      writeFile: (p, c) => { wrote = true; fs2.write(p, c); },
      mkdir: () => {},
      runCmd: lc.run,
      log: () => {},
    });
    assert.ok(res.error, 'returns an error');
    assert.equal(wrote, false, 'nothing written when a cron is invalid');
    assert.equal(lc.calls.length, 0, 'launchctl never invoked');
  } finally {
    fsReal.unlinkSync(tmp);
  }
});

test('labelFor composes the documented prefix', () => {
  assert.equal(labelFor('background-pr-digest'), 'com.claude-os.digest.background-pr-digest');
});
