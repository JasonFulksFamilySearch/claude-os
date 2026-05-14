'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const {
  inferProject,
  getRecentEpisodes,
  buildEpisodeContext,
  loadConfig,
  parseStdinInput,
} = require('../session-start-check.js');

const TMP = join(tmpdir(), `session-start-check-test-${process.pid}`);
before(() => mkdirSync(TMP, { recursive: true }));
after(() => rmSync(TMP, { recursive: true, force: true }));

// --- parseStdinInput ---

test('parseStdinInput extracts cwd from valid JSON', () => {
  const result = parseStdinInput(JSON.stringify({ cwd: '/Users/user/dev/arc' }));
  assert.equal(result.cwd, '/Users/user/dev/arc');
});

test('parseStdinInput returns null cwd for empty string', () => {
  assert.equal(parseStdinInput('').cwd, null);
});

test('parseStdinInput returns null cwd for malformed JSON', () => {
  assert.equal(parseStdinInput('{ not json }').cwd, null);
});

// --- inferProject ---

test('inferProject matches cwd against watched-projects.json using path-segment boundary', () => {
  const configDir = join(TMP, 'config');
  mkdirSync(configDir, { recursive: true });
  const watchedPath = join(configDir, 'watched-projects.json');
  writeFileSync(watchedPath, JSON.stringify({
    projects: [{ slug: 'arc', path: '/Users/user/dev/arc' }]
  }), 'utf8');
  assert.equal(inferProject('/Users/user/dev/arc/src', watchedPath), 'arc');
});

test('inferProject does NOT match partial path prefix (arc vs arc-tools)', () => {
  const configDir = join(TMP, 'config-collision');
  mkdirSync(configDir, { recursive: true });
  const watchedPath = join(configDir, 'watched-projects.json');
  writeFileSync(watchedPath, JSON.stringify({
    projects: [
      { slug: 'arc', path: '/Users/user/dev/arc' },
      { slug: 'arc-tools', path: '/Users/user/dev/arc-tools' },
    ]
  }), 'utf8');
  assert.equal(inferProject('/Users/user/dev/arc-tools/src', watchedPath), 'arc-tools');
  assert.equal(inferProject('/Users/user/dev/arc/src', watchedPath), 'arc');
});

test('inferProject falls back to basename when no match', () => {
  assert.equal(inferProject('/Users/user/dev/myproject', join(TMP, 'nonexistent.json')), 'myproject');
});

// --- getRecentEpisodes ---

test('getRecentEpisodes returns matching unpromoted episodes within threshold', () => {
  const episodesDir = join(TMP, 'episodes-test');
  mkdirSync(episodesDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);

  writeFileSync(join(episodesDir, today + '-aaa.md'), [
    '---', 'date: ' + today, 'project: arc', 'promoted: false', '---',
    '', '## Summary', 'Today arc session.', '',
  ].join('\n'), 'utf8');

  writeFileSync(join(episodesDir, today + '-bbb.md'), [
    '---', 'date: ' + today, 'project: perch', 'promoted: false', '---',
    '', '## Summary', 'Today perch session.', '',
  ].join('\n'), 'utf8');

  const config = { sessionStartInjectCount: 2, stalenessThresholdDays: 30 };
  const results = getRecentEpisodes('arc', config, episodesDir);
  assert.equal(results.length, 1);
  assert.equal(results[0].project, 'arc');
});

test('getRecentEpisodes skips promoted episodes', () => {
  const episodesDir = join(TMP, 'episodes-promoted');
  mkdirSync(episodesDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(join(episodesDir, today + '-promoted.md'), [
    '---', 'date: ' + today, 'project: arc', 'promoted: true', '---',
    '', '## Summary', 'Already promoted.', '',
  ].join('\n'), 'utf8');

  const config = { sessionStartInjectCount: 2, stalenessThresholdDays: 30 };
  assert.equal(getRecentEpisodes('arc', config, episodesDir).length, 0);
});

test('getRecentEpisodes excludes episodes older than stalenessThresholdDays', () => {
  const episodesDir = join(TMP, 'episodes-stale');
  mkdirSync(episodesDir, { recursive: true });
  const staleDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  writeFileSync(join(episodesDir, staleDate + '-stale.md'), [
    '---', 'date: ' + staleDate, 'project: arc', 'promoted: false', '---',
    '', '## Summary', 'Stale session.', '',
  ].join('\n'), 'utf8');

  const config = { sessionStartInjectCount: 5, stalenessThresholdDays: 30 };
  assert.equal(getRecentEpisodes('arc', config, episodesDir).length, 0);
});

test('getRecentEpisodes includes episodes within stalenessThresholdDays', () => {
  const episodesDir = join(TMP, 'episodes-fresh');
  mkdirSync(episodesDir, { recursive: true });
  const freshDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  writeFileSync(join(episodesDir, freshDate + '-fresh.md'), [
    '---', 'date: ' + freshDate, 'project: arc', 'promoted: false', '---',
    '', '## Summary', 'Fresh session.', '',
  ].join('\n'), 'utf8');

  const config = { sessionStartInjectCount: 5, stalenessThresholdDays: 30 };
  assert.equal(getRecentEpisodes('arc', config, episodesDir).length, 1);
});

// --- buildEpisodeContext ---

test('buildEpisodeContext formats episode digests', () => {
  const episodes = [
    { date: '2026-05-14', project: 'arc', summary: 'Fixed stall bug.', path: '/data/ep1.md' },
  ];
  const ctx = buildEpisodeContext(episodes);
  assert.ok(ctx.includes('[Episode — 2026-05-14 | arc]'));
  assert.ok(ctx.includes('Fixed stall bug.'));
  assert.ok(ctx.includes('search_memory'));
});

test('buildEpisodeContext returns null for empty array', () => {
  assert.equal(buildEpisodeContext([]), null);
});

// --- loadConfig ---

test('loadConfig returns defaults when file missing', () => {
  const config = loadConfig(join(TMP, 'nonexistent.json'));
  assert.equal(config.sessionStartInjectCount, 2);
  assert.equal(config.stalenessThresholdDays, 30);
});

test('loadConfig reads custom values', () => {
  const cfgPath = join(TMP, 'episodes.json');
  writeFileSync(cfgPath, JSON.stringify({ sessionStartInjectCount: 5, stalenessThresholdDays: 60 }), 'utf8');
  const config = loadConfig(cfgPath);
  assert.equal(config.sessionStartInjectCount, 5);
  assert.equal(config.stalenessThresholdDays, 60);
});
