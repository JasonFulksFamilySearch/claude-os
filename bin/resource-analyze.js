'use strict';

function parseSamples(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch (_) { /* skip malformed */ }
  }
  return rows;
}

function linearRegression(points) {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: n ? points[0][1] : 0, r2: 0, n };
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of points) { sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y; }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const rNum = n * sxy - sx * sy;
  const rDen = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  const r = rDen === 0 ? 0 : rNum / rDen;
  return { slope, intercept, r2: r * r, n };
}

// "Starving" = sustained positive swapout deltas across >= minWindow consecutive samples.
// Onset session count = the min session_count observed within the first such window.
function detectSwapOnset(rows, { minWindow = 3 } = {}) {
  let run = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].sys || {};
    const cur = rows[i].sys || {};
    const dSwap = (cur.c_swapouts || 0) - (prev.c_swapouts || 0);
    if (dSwap > 0) {
      run.push(rows[i]);
      if (run.length >= minWindow) {
        const counts = run.map((r) => (r.totals && r.totals.session_count) || 0);
        return { observed: true, onset_session_count: Math.min(...counts), window_len: run.length };
      }
    } else {
      run = [];
    }
  }
  return { observed: false, onset_session_count: null, window_len: 0 };
}

const RECENT_WINDOW = 240; // ~2h at 30s cadence — attribute CURRENT footprint, not all-time

function perMcpCost(rows, { recentWindow = RECENT_WINDOW } = {}) {
  const recent = rows.slice(-recentWindow);
  const latest = recent[recent.length - 1];
  // Current footprint only: attribute servers present in the most recent sample, so renamed/
  // one-off (e.g. npx) servers age out and never accumulate spurious all-time rows.
  const liveNames = new Set();
  for (const s of (latest && latest.sessions) || []) for (const m of s.mcp || []) liveNames.add(m.name);
  const acc = new Map(); // name -> {sum, sumsq, n, transport}
  for (const r of recent) for (const s of r.sessions || []) for (const m of s.mcp || []) {
    if (!liveNames.has(m.name)) continue;
    if (!acc.has(m.name)) acc.set(m.name, { sum: 0, sumsq: 0, n: 0, transport: m.transport || 'local-stdio' });
    const a = acc.get(m.name);
    a.sum += m.rss_kib; a.sumsq += m.rss_kib * m.rss_kib; a.n += 1;
  }
  return [...acc.entries()].map(([name, a]) => {
    const mean = a.sum / a.n;
    const variance = Math.max(0, a.sumsq / a.n - mean * mean);
    return { name, transport: a.transport, mean_kib: mean, stdev_kib: Math.sqrt(variance), n: a.n };
  }).sort((x, y) => y.mean_kib - x.mean_kib);
}

function biggestLever(rows) {
  // aggregate = mean rss * mean concurrency (how many sessions run it at once)
  const cost = perMcpCost(rows);
  const concurrencyByName = new Map();
  for (const r of rows) {
    const seen = new Map();
    for (const s of r.sessions || []) for (const m of s.mcp || []) seen.set(m.name, (seen.get(m.name) || 0) + 1);
    for (const [name, c] of seen) {
      if (!concurrencyByName.has(name)) concurrencyByName.set(name, { sum: 0, n: 0 });
      const x = concurrencyByName.get(name); x.sum += c; x.n += 1;
    }
  }
  let top = null;
  for (const c of cost) {
    const conc = concurrencyByName.get(c.name);
    const meanConc = conc ? conc.sum / conc.n : 1;
    const aggregate = c.mean_kib * meanConc;
    if (!top || aggregate > top.aggregate_kib) top = { name: c.name, aggregate_kib: aggregate, mean_kib: c.mean_kib, mean_concurrency: meanConc };
  }
  return top || { name: null, aggregate_kib: 0 };
}

const KIB = 1024;
function projectCeiling({ onset, slope_kib, intercept_kib, mem_total, free_floor_bytes = 2 * 1024 ** 3 }) {
  if (onset && onset.observed) {
    return { ceiling: onset.onset_session_count, basis: 'observed-swap-onset' };
  }
  const budget = mem_total - free_floor_bytes;            // bytes
  const interceptB = (intercept_kib || 0) * KIB;
  const slopeB = (slope_kib || 0) * KIB;
  if (slopeB <= 0) return { ceiling: null, basis: 'indeterminate' };
  const n = Math.floor((budget - interceptB) / slopeB);
  return { ceiling: Math.max(0, n), basis: 'extrapolated-rss' };
}

function buildReport(rows) {
  const latest = rows[rows.length - 1] || null;
  const sessionPoints = rows.map((r) => [r.totals.session_count, r.totals.claude_rss_kib + (r.totals.daemon_infra_rss_kib || 0)]);
  const reg = linearRegression(sessionPoints);
  const onset = detectSwapOnset(rows);
  const ceiling = latest ? projectCeiling({ onset, slope_kib: reg.slope, intercept_kib: reg.intercept, mem_total: latest.sys.mem_total }) : { ceiling: null, basis: 'no-data' };
  const maxObserved = rows.reduce((m, r) => Math.max(m, r.totals.session_count), 0);
  // active swapping right now?
  let swappingNow = false;
  if (rows.length >= 2) {
    const a = rows[rows.length - 2].sys, b = latest.sys;
    swappingNow = (b.c_swapouts || 0) - (a.c_swapouts || 0) > 0;
  }
  return {
    rows_n: rows.length,
    span: rows.length ? { from: rows[0].ts, to: latest.ts } : null,
    latest,
    baseline_kib: reg.intercept,
    marginal_kib_per_session: reg.slope,
    r2: reg.r2,
    per_mcp: perMcpCost(rows),
    lever: biggestLever(rows),
    onset,
    ceiling,
    max_observed_sessions: maxObserved,
    swapping_now: swappingNow,
  };
}

function gb(kib) { return (kib / (1024 * 1024)).toFixed(2); }
function gbBytes(b) { return (b / 1024 ** 3).toFixed(2); }

function renderMarkdown(rep) {
  if (!rep.latest) return '# Resource Report\n\nNo samples yet. Is the launchd sampler loaded?';
  const L = rep.latest;
  const lines = [];
  lines.push('# Resource Report');
  lines.push('');
  lines.push('## Snapshot (latest sample)');
  lines.push(`- Sessions: ${L.totals.session_count} (interactive ${L.totals.interactive_count}, forked ${L.totals.forked_count})`);
  lines.push(`- Free: ${gbBytes(L.sys.free_bytes)} GB · available ~${gbBytes(L.sys.available_bytes)} GB · swap used ${L.sys.swap_used_mb} MB`);
  lines.push(`- Active swapping now: ${rep.swapping_now ? 'YES — starving' : 'no'} · load ${L.sys.load1}`);
  lines.push('');
  lines.push('## Baseline & marginal cost');
  lines.push(`- Baseline (intercept): ${gb(rep.baseline_kib)} GB`);
  lines.push(`- Marginal per concurrent session: ${gb(rep.marginal_kib_per_session)} GB (R²=${rep.r2.toFixed(2)}, ${rep.rows_n} samples, max ${rep.max_observed_sessions} concurrent)`);
  lines.push('');
  lines.push('## Per-MCP-server cost (local stdio only; remote servers carry ~0 local RSS)');
  lines.push('| server | transport | mean | stdev | N |');
  lines.push('|---|---|---|---|---|');
  const TOP_N_MCP = 8; // bound the relayed table: per_mcp is sorted by mean_kib desc
  for (const m of rep.per_mcp.slice(0, TOP_N_MCP)) lines.push(`| ${m.name} | ${m.transport} | ${gb(m.mean_kib)} GB | ${gb(m.stdev_kib)} GB | ${m.n} |`);
  if (rep.per_mcp.length > TOP_N_MCP) lines.push(`| _+${rep.per_mcp.length - TOP_N_MCP} more (smaller)_ | | | | |`);
  lines.push('');
  lines.push('## Headroom & projected ceiling');
  if (rep.ceiling.basis === 'observed-swap-onset') {
    lines.push(`- Ceiling N* = **${rep.ceiling.ceiling} sessions** — observed swap-onset (sustained swapouts). You are at ${L.totals.session_count}.`);
  } else if (rep.ceiling.basis === 'extrapolated-rss') {
    lines.push(`- Ceiling N* ≈ **${rep.ceiling.ceiling} sessions** — EXTRAPOLATED from per-session slope; swap-onset not yet observed (max ${rep.max_observed_sessions} concurrent so far).`);
  } else {
    lines.push(`- Ceiling: not yet determinable — needs concurrent-session variation or an observed swap-onset (max ${rep.max_observed_sessions} concurrent seen, no swapping yet).`);
  }
  lines.push('');
  lines.push('## Biggest lever');
  if (rep.lever.name) lines.push(`- **${rep.lever.name}**: ~${gb(rep.lever.mean_kib)} GB × ${rep.lever.mean_concurrency.toFixed(1)} concurrent = the dominant reclaimable footprint.`);
  lines.push('');
  lines.push('## Data health');
  lines.push(`- ${rep.rows_n} samples${rep.span ? ` from ${rep.span.from} to ${rep.span.to}` : ''}.`);
  return lines.join('\n');
}

module.exports = { parseSamples, linearRegression, detectSwapOnset, perMcpCost, biggestLever, projectCeiling, buildReport, renderMarkdown };

if (require.main === module) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const file = process.argv[2] || process.env.CLAUDE_OS_METRICS_FILE
    || path.join(os.homedir(), '.claude-data', 'metrics', 'resource-samples.jsonl');
  if (!fs.existsSync(file)) { console.log(`No metrics file at ${file}. Is the launchd sampler loaded?`); process.exit(0); }
  const rows = parseSamples(fs.readFileSync(file, 'utf8'));
  console.log(renderMarkdown(buildReport(rows)));
}
