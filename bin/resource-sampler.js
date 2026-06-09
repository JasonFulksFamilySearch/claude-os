'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const stats = require('./resource-stats.js');

const DEFAULT_METRICS = path.join(os.homedir(), '.claude-data', 'metrics', 'resource-samples.jsonl');
const ERR_LOG = path.join(os.homedir(), '.claude-data', '.logs', 'resource-sampler.err');
const RUNAWAY_BYTES = 200 * 1024 * 1024;

// Parse `ps -axo pid,ppid,rss,pcpu,etime,command`. First 5 columns are whitespace-delimited
// and space-free; command is the remainder (may contain spaces, JSON, =). Drop the header row.
function parsePs(text) {
  const lines = String(text).split('\n');
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^\s*PID\s+PPID/.test(line)) continue; // header
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rss: Number(m[3]),
      pcpu: Number(m[4]),
      etime: m[5],
      command: m[6],
    });
  }
  return out;
}

const KNOWN_MCP = [
  { match: '/.claude-os/mcp/dist/index.js', name: 'claude-os' },
  { match: 'claude-tdd-advisor', name: 'tdd-advisor' },
];

function isSessionRoot(cmd) {
  return /\/\.local\/bin\/claude(\s|$)/.test(cmd) && !/ daemon run/.test(cmd);
}
function isForkedRoot(cmd) {
  return /\/versions\/[\d.]+/.test(cmd) && /--session-id/.test(cmd)
    && /(--resume|--fork-session)/.test(cmd) && !/--bg-pty-host/.test(cmd);
}
function isInfra(cmd) {
  return / daemon run/.test(cmd) || /--bg-pty-host/.test(cmd) || /--bg-spare/.test(cmd);
}
function isSelf(cmd) { return /resource-sampler\.js/.test(cmd); }

// A direct child of a session is a genuine MCP server only if its command shows an MCP signal —
// otherwise it's an incidental child (caffeinate, Claude's internal node helpers, shells).
function isMcpServer(cmd) {
  for (const k of KNOWN_MCP) if (cmd.includes(k.match)) return true;
  if (/mcp/i.test(cmd)) return true;                              // mcp-sonarqube, slack-mcp-server, .../mcp/dist/...
  if (/@modelcontextprotocol\//.test(cmd)) return true;           // official MCP servers (no literal "mcp" in the name)
  if (/\b(?:npm exec|npx|uvx)\s+\S*mcp/i.test(cmd)) return true;  // npx/uvx of an mcp package
  return false;
}

function normalizeServerName(n) {
  return n
    .replace(/^@[^/]+\//, '')                                       // drop npm scope (@scope/)
    .replace(/@.*$/, '')                                            // drop @version (@latest)
    .replace(/-(?:darwin|linux|win32)-(?:arm64|x64|x86_64).*$/i, '') // drop platform suffix
    .replace(/^claude-/, '');
}

function mcpName(cmd) {
  for (const k of KNOWN_MCP) if (cmd.includes(k.match)) return k.name;
  // launched via npm exec / npx / uvx: take the first NON-flag token (the package, not a `-y` flag).
  let m = cmd.match(/(?:npm exec|npx|uvx)\s+(.+)/);
  if (m) {
    const pkg = m[1].split(/\s+/).find((t) => t && !t.startsWith('-'));
    if (pkg) return normalizeServerName(pkg);
  }
  m = cmd.match(/\/([^/\s]+)\/dist\/index\.[mc]?[jt]s\b/)          // <dir>/dist/index.{js,ts,mjs,cjs}
    || cmd.match(/\/([^/\s]+)\/index\.[mc]?[jt]s\b/);              // <dir>/index.{js,ts,…} e.g. harness-fme-mcp/index.js
  if (m) return normalizeServerName(m[1]);
  m = cmd.match(/\/([^/\s]*mcp[^/\s]*)/i);                          // any path segment containing "mcp"
  if (m) return normalizeServerName(m[1]);
  const tok = cmd.split(/\s+/)[0];
  return normalizeServerName(tok.split('/').pop() || 'other');
}

function classifyProcesses(procs) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const children = new Map();
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  const sessionRoots = procs.filter((p) => !isSelf(p.command)
    && (isSessionRoot(p.command) || isForkedRoot(p.command)));
  const rootPidSet = new Set(sessionRoots.map((p) => p.pid));

  // descendants of a root, not crossing into another root
  const subtree = (rootPid) => {
    const acc = [];
    const stack = [...(children.get(rootPid) || [])];
    while (stack.length) {
      const pid = stack.pop();
      if (rootPidSet.has(pid)) continue; // don't absorb another session
      const proc = byPid.get(pid);
      if (!proc || isSelf(proc.command)) continue;
      acc.push(proc);
      for (const ch of children.get(pid) || []) stack.push(ch);
    }
    return acc;
  };

  const allSessionPids = new Set();
  const sessions = sessionRoots.map((root) => {
    const desc = subtree(root.pid);
    const total = root.rss + desc.reduce((s, d) => s + d.rss, 0);
    allSessionPids.add(root.pid);
    for (const d of desc) allSessionPids.add(d.pid);

    // MCP servers are DIRECT children whose command shows an MCP signal; each owns its whole
    // subtree (collapsing multi-process chains like tsx, or npx-wrapper + spawned binary),
    // merged by normalized name. Incidental children fall to other_rss_kib, never a fake row.
    const directChildren = (children.get(root.pid) || [])
      .map((pid) => byPid.get(pid))
      .filter((p) => p && !isSelf(p.command));
    const groups = new Map();
    let mcpRss = 0;
    for (const child of directChildren) {
      if (!isMcpServer(child.command)) continue;
      const serverProcs = [child, ...subtree(child.pid)];
      const rss = serverProcs.reduce((s, p) => s + p.rss, 0);
      mcpRss += rss;
      const name = mcpName(child.command);
      if (!groups.has(name)) groups.set(name, { name, transport: 'local-stdio', pids: [], rss_kib: 0 });
      const g = groups.get(name);
      g.pids.push(...serverProcs.map((p) => p.pid));
      g.rss_kib += rss;
    }
    const mcp = [...groups.values()].sort((a, b) => b.rss_kib - a.rss_kib);
    return {
      root_pid: root.pid,
      kind: isForkedRoot(root.command) ? 'forked' : 'interactive',
      ppid: root.ppid,
      etime: root.etime,
      self_rss_kib: root.rss,
      total_rss_kib: total,
      other_rss_kib: total - root.rss - mcpRss,
      pcpu: root.pcpu,
      mcp,
    };
  });

  const daemonInfra = procs.filter((p) => !isSelf(p.command) && isInfra(p.command) && !allSessionPids.has(p.pid));

  const interactive = sessions.filter((s) => s.kind === 'interactive').length;
  const forked = sessions.filter((s) => s.kind === 'forked').length;
  return {
    sessions,
    totals: {
      session_count: sessions.length,
      interactive_count: interactive,
      forked_count: forked,
      claude_rss_kib: sessions.reduce((s, x) => s + x.total_rss_kib, 0),
      daemon_infra_rss_kib: daemonInfra.reduce((s, p) => s + p.rss, 0),
      proc_count: procs.length,
    },
  };
}

function buildSample({ psText, vmStatText, swapText, loadText, memsizeText, host, now }) {
  const vm = stats.parseVmStat(vmStatText);
  const swap = stats.parseSwapusage(swapText);
  const load = stats.parseLoadavg(loadText);
  const memTotal = stats.parseMemsize(memsizeText);
  const ps = parsePs(psText);
  const c = classifyProcesses(ps);
  const ps_b = vm.page_size;
  const avail = ((vm.pages_free || 0) + (vm.pages_inactive || 0)
    + (vm.pages_speculative || 0) + (vm.pages_purgeable || 0)) * ps_b;
  return {
    ts: now.toISOString(),
    schema: 1,
    host,
    page_size: ps_b,
    sys: {
      mem_total: memTotal,
      free_bytes: (vm.pages_free || 0) * ps_b,
      available_bytes: avail,
      compressor_bytes: (vm.pages_occupied_by_compressor || 0) * ps_b,
      pages_free: vm.pages_free, pages_active: vm.pages_active, pages_inactive: vm.pages_inactive,
      pages_speculative: vm.pages_speculative, pages_wired: vm.pages_wired, pages_purgeable: vm.pages_purgeable,
      pages_compressor_occupied: vm.pages_occupied_by_compressor,
      c_pageins: vm.c_pageins, c_pageouts: vm.c_pageouts, c_swapins: vm.c_swapins, c_swapouts: vm.c_swapouts,
      c_compressions: vm.c_compressions, c_decompressions: vm.c_decompressions,
      swap_total_mb: swap.swap_total_mb, swap_used_mb: swap.swap_used_mb, swap_free_mb: swap.swap_free_mb,
      load1: load.load1, load5: load.load5, load15: load.load15,
    },
    totals: c.totals,
    sessions: c.sessions,
  };
}

function writeSampleLine(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function collectAndAppend() {
  const file = process.env.CLAUDE_OS_METRICS_FILE || DEFAULT_METRICS;
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > RUNAWAY_BYTES) return; // wait for rotation
    const row = buildSample({
      // Absolute paths: launchd runs with a minimal PATH that omits /usr/sbin (where sysctl lives).
      psText: sh('/bin/ps', ['-axo', 'pid,ppid,rss,pcpu,etime,command']),
      vmStatText: sh('/usr/bin/vm_stat', []),
      swapText: sh('/usr/sbin/sysctl', ['vm.swapusage']),
      loadText: sh('/usr/sbin/sysctl', ['-n', 'vm.loadavg']),
      memsizeText: sh('/usr/sbin/sysctl', ['-n', 'hw.memsize']),
      host: os.hostname().split('.')[0],
      now: new Date(),
    });
    writeSampleLine(file, row);
  } catch (e) {
    try {
      fs.mkdirSync(path.dirname(ERR_LOG), { recursive: true });
      fs.appendFileSync(ERR_LOG, `${new Date().toISOString()} ${e.stack || e.message}\n`);
    } catch (_) { /* last resort: swallow */ }
  }
}

module.exports = { parsePs, classifyProcesses, mcpName, isSessionRoot, isForkedRoot, isInfra, buildSample, writeSampleLine };

if (require.main === module) collectAndAppend();
