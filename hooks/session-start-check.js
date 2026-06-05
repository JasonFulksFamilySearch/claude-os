'use strict';

/**
 * SessionStart hook — two responsibilities:
 *
 * 1. CLAUDE.md staleness alert (original)
 *    Reads _tmp_claude_md_update_needed.txt; injects alert if present.
 *
 * 2. Episode digest injection (episodic layer extension)
 *    Reads the last N project-matched unpromoted episodes from
 *    ~/.claude-data/episodes/ and prepends brief digests to additionalContext.
 *
 * Both outputs are merged into a single JSON write. Two sequential
 * process.stdout.write() calls are not additive in Claude Code hooks —
 * only the last write would reach the model.
 */

const { readFileSync, existsSync, readdirSync } = require('node:fs');
const { join, basename, sep } = require('node:path');
const { homedir } = require('node:os');
const { parseFrontmatter, extractSummary } = require('./lib/episode-utils.js');
const { deliverAndClearQueue } = require('./digest-queue-deliver.js');

const MARKER_PATH = join(homedir(), '.claude-data', '_tmp_claude_md_update_needed.txt');
const EPISODES_DIR = join(homedir(), '.claude-data', 'episodes');
const CONFIG_PATH = join(homedir(), '.claude-os', 'config', 'episodes.json');
const WATCHED_PROJECTS_PATH = join(homedir(), '.claude-os', 'config', 'watched-projects.json');
const JOBS_CONFIG_PATH = join(homedir(), '.claude-os', 'config', 'scheduled-jobs.json');
const MAX_INJECT_CHARS = 1600;

function loadConfig(configPath) {
  const path = configPath || CONFIG_PATH;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      sessionStartInjectCount: typeof parsed.sessionStartInjectCount === 'number'
        ? parsed.sessionStartInjectCount : 2,
      stalenessThresholdDays: typeof parsed.stalenessThresholdDays === 'number'
        ? parsed.stalenessThresholdDays : 30,
    };
  } catch (e) {
    // Silently using defaults when the file is missing is expected; silently
    // using defaults when the file is malformed is a footgun. SessionStart
    // hook stderr lands in Claude Code's debug log (NOT the model context),
    // so the breadcrumb is observable to Jason without polluting the session.
    if (e && e.code !== 'ENOENT') {
      process.stderr.write('[session-start-check] loadConfig: ' + (e.name || 'Error') + ' reading ' + path + '\n');
    }
    return { sessionStartInjectCount: 2, stalenessThresholdDays: 30 };
  }
}

// parseStdinInput is extracted for testability (stdin cannot be mocked in tests).
function parseStdinInput(raw) {
  try { const d = JSON.parse(raw); return { cwd: typeof d.cwd === 'string' ? d.cwd : null }; }
  catch { return { cwd: null }; }
}

function inferProject(cwd, watchedProjectsPath) {
  if (!cwd) return null;
  const wpPath = watchedProjectsPath || WATCHED_PROJECTS_PATH;
  try {
    const raw = readFileSync(wpPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.projects)) {
      for (const proj of parsed.projects) {
        if (!proj.path || !proj.slug) continue;
        // Use path-segment boundary: startsWith('/dev/arc/') not startsWith('/dev/arc')
        // to prevent '/dev/arc-tools' matching project 'arc'.
        const projPath = proj.path.endsWith(sep) ? proj.path : proj.path + sep;
        if (cwd === proj.path || cwd.startsWith(projPath)) return proj.slug;
      }
    }
  } catch (e) {
    // Same diagnostic policy as loadConfig: ENOENT is expected (no watched
    // projects configured); other errors should leave a breadcrumb in the
    // Claude Code debug log so syntax errors in watched-projects.json don't
    // silently disable project inference.
    if (e && e.code !== 'ENOENT') {
      process.stderr.write('[session-start-check] inferProject: ' + (e.name || 'Error') + ' reading ' + wpPath + '\n');
    }
  }
  return basename(cwd);
}

function getRecentEpisodes(project, config, episodesDir) {
  const dir = episodesDir || EPISODES_DIR;
  if (!existsSync(dir)) return [];
  const cutoff = Date.now() - config.stalenessThresholdDays * 24 * 60 * 60 * 1000;
  const files = readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('_'));
  const episodes = [];

  for (const file of files) {
    const path = join(dir, file);
    try {
      const content = readFileSync(path, 'utf8');
      const data = parseFrontmatter(content);
      if (data.promoted === true) continue;

      const dateStr = typeof data.date === 'string' ? data.date : file.slice(0, 10);
      // Use explicit year/month/day constructor to avoid timezone offset issues.
      const parts = dateStr.split('-').map(Number);
      const date = parts.length === 3 ? new Date(parts[0], parts[1] - 1, parts[2]).getTime() : NaN;
      if (isNaN(date) || date < cutoff) continue;

      const epProject = typeof data.project === 'string' && data.project.length > 0
        ? data.project : null;
      // Filter policy: drop only when BOTH sides have a project and they
      // disagree. If we couldn't infer the caller's project, surface all
      // recent episodes (better than nothing). If an episode has no project,
      // surface it regardless — orphans are rare and usually worth seeing.
      if (project && epProject && epProject !== project) continue;

      episodes.push({ date: dateStr, project: epProject, summary: extractSummary(content), path });
    } catch (e) {
      // One malformed episode file must not block SessionStart. Leave a
      // breadcrumb so a corrupt frontmatter regression is diagnosable.
      process.stderr.write('[session-start-check] getRecentEpisodes: ' + (e.name || 'Error') + ' reading ' + path + '\n');
    }
  }

  episodes.sort((a, b) => (a.date < b.date ? 1 : -1));
  return episodes.slice(0, config.sessionStartInjectCount);
}

function buildEpisodeContext(episodes) {
  if (!episodes.length) return null;
  return episodes.map(ep => {
    const proj = ep.project ? ' | ' + ep.project : '';
    const summary = ep.summary || '(no summary)';
    const searchTerm = [ep.project, ep.date].filter(Boolean).join(' ');
    return '[Episode — ' + ep.date + proj + ']\n' + summary + '\n→ Full detail: search_memory("' + searchTerm + '")';
  }).join('\n\n');
}

const AGENT_LABELS = {
  'pr-surveillance': 'PR Surveillance',
  'sprint-staleness': 'Sprint Staleness',
};

function buildDigestContext(entries) {
  if (!entries || entries.length === 0) return null;

  const lines = entries.map(entry => {
    const label = AGENT_LABELS[entry.agent] || entry.agent;
    const date = typeof entry.run_at === 'string' ? entry.run_at.slice(0, 10) : 'unknown';
    const prefix = label + ' (' + date + '): ';

    if (entry.status === 'error') {
      return prefix + 'ERROR — skipped run';
    }

    const items = Array.isArray(entry.items) ? entry.items : [];
    if (items.length === 0) {
      return prefix + 'nothing flagged';
    }

    if (entry.agent === 'pr-surveillance') {
      const formatted = items.map(item =>
        '#' + item.pr_number + ' "' + item.title + '" (' + item.type + ')'
      ).join(', ');
      return prefix + items.length + ' flagged — ' + formatted;
    }

    if (entry.agent === 'sprint-staleness') {
      const formatted = items.map(item =>
        item.key + ' ' + item.days_stale + 'd stale (' + item.status + ')'
      ).join(', ');
      return prefix + formatted;
    }

    return prefix + items.length + ' item(s)';
  });

  const runCount = entries.length;
  return '[Background Digest — ' + runCount + ' run(s) since last session]\n' + lines.join('\n');
}

function buildJobsContext(jobsPath) {
  const path = jobsPath || JOBS_CONFIG_PATH;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    if (jobs.length === 0) return null;
    const lines = jobs.map(j =>
      `/schedule skill=${j.skill} cron="${j.cron}" name="${j.name}"`
    );
    return '[Background jobs — register each session]\n' + lines.join('\n');
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      process.stderr.write('[session-start-check] buildJobsContext: ' + (e.name || 'Error') + '\n');
    }
    return null;
  }
}

function main() {
  let input = '';
  // isTTY guard: readFileSync(0) blocks if stdin is a TTY (direct invocation, testing).
  if (!process.stdin.isTTY) {
    try { input = readFileSync(0, 'utf8'); } catch {}
  }

  const { cwd } = parseStdinInput(input);
  const parts = [];

  const jobsContext = buildJobsContext();
  if (jobsContext) parts.push(jobsContext);

  const digestEntries = deliverAndClearQueue();
  const digestContext = digestEntries ? buildDigestContext(digestEntries) : null;
  if (digestContext) parts.push(digestContext);

  // Behavior note: the original 22-line session-start-check.js wrote a
  // header-only JSON envelope when the marker file existed but was empty.
  // This rewrite suppresses that case — an empty marker contributes nothing
  // to the parts array, so when no episodes are found either, no output is
  // emitted at all (matching the spec's intent).
  if (existsSync(MARKER_PATH)) {
    const message = readFileSync(MARKER_PATH, 'utf8').trim();
    if (message) {
      parts.push('[Action required — CLAUDE.md operating rules are out of date]\n\n' + message);
    }
  }

  const config = loadConfig();
  const project = inferProject(cwd);
  const episodes = getRecentEpisodes(project, config);
  const episodeContext = buildEpisodeContext(episodes);
  if (episodeContext) parts.push(episodeContext);

  if (parts.length === 0) return;

  let combined = parts.join('\n\n---\n\n');
  if (combined.length > MAX_INJECT_CHARS) {
    combined = combined.slice(0, MAX_INJECT_CHARS) + '\n…[truncated]';
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: combined,
    },
  }));
}

module.exports = {
  parseFrontmatter,  // re-exported for test convenience
  extractSummary,    // re-exported for test convenience
  inferProject,
  getRecentEpisodes,
  buildEpisodeContext,
  buildDigestContext,
  buildJobsContext,
  loadConfig,
  parseStdinInput,
};

if (require.main === module) {
  main();
}
