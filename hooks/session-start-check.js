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

const MARKER_PATH = join(homedir(), '.claude-data', '_tmp_claude_md_update_needed.txt');
const EPISODES_DIR = join(homedir(), '.claude-data', 'episodes');
const CONFIG_PATH = join(homedir(), '.claude-os', 'config', 'episodes.json');
const WATCHED_PROJECTS_PATH = join(homedir(), '.claude-os', 'config', 'watched-projects.json');
const MAX_INJECT_CHARS = 1600;

function loadConfig(configPath) {
  try {
    const raw = readFileSync(configPath || CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      sessionStartInjectCount: typeof parsed.sessionStartInjectCount === 'number'
        ? parsed.sessionStartInjectCount : 2,
      stalenessThresholdDays: typeof parsed.stalenessThresholdDays === 'number'
        ? parsed.stalenessThresholdDays : 30,
    };
  } catch {
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
  } catch { /* fall through */ }
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
      if (project && epProject && epProject !== project) continue;

      episodes.push({ date: dateStr, project: epProject, summary: extractSummary(content), path });
    } catch { /* skip malformed files */ }
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

function main() {
  let input = '';
  // isTTY guard: readFileSync(0) blocks if stdin is a TTY (direct invocation, testing).
  if (!process.stdin.isTTY) {
    try { input = readFileSync(0, 'utf8'); } catch {}
  }

  const { cwd } = parseStdinInput(input);
  const parts = [];

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
  loadConfig,
  parseStdinInput,
};

if (require.main === module) {
  main();
}
