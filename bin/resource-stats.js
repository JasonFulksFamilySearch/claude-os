'use strict';

// Pure parsers for macOS memory/system stats. No I/O. Missing fields → null, never throw.

function parseVmStat(text) {
  const pageMatch = text.match(/page size of (\d+) bytes/);
  const page_size = pageMatch ? Number(pageMatch[1]) : 16384;
  const num = (label) => {
    const re = new RegExp(`^[^:]*${label}[^:]*:\\s*(\\d+)`, 'im');
    const m = text.match(re);
    return m ? Number(m[1]) : null;
  };
  // Compressions must not match Decompressions — anchor to start-of-line explicitly.
  const cMatch = text.match(/^Compressions:\s*(\d+)/im);
  return {
    page_size,
    pages_free: num('Pages free'),
    pages_active: num('Pages active'),
    pages_inactive: num('Pages inactive'),
    pages_speculative: num('Pages speculative'),
    pages_wired: num('Pages wired down'),
    pages_purgeable: num('Pages purgeable'),
    pages_occupied_by_compressor: num('Pages occupied by compressor'),
    pages_stored_in_compressor: num('Pages stored in compressor'),
    c_pageins: num('Pageins'),
    c_pageouts: num('Pageouts'),
    c_swapins: num('Swapins'),
    c_swapouts: num('Swapouts'),
    c_compressions: cMatch ? Number(cMatch[1]) : null,
    c_decompressions: num('Decompressions'),
  };
}

function parseSwapusage(text) {
  const m = text.match(/total\s*=\s*([\d.]+)M\s+used\s*=\s*([\d.]+)M\s+free\s*=\s*([\d.]+)M/);
  if (!m) return { swap_total_mb: null, swap_used_mb: null, swap_free_mb: null };
  return { swap_total_mb: Number(m[1]), swap_used_mb: Number(m[2]), swap_free_mb: Number(m[3]) };
}

function parseLoadavg(text) {
  const m = text.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (!m) return { load1: null, load5: null, load15: null };
  return { load1: Number(m[1]), load5: Number(m[2]), load15: Number(m[3]) };
}

function parseMemsize(text) {
  const n = Number(String(text).trim());
  return Number.isFinite(n) ? n : null;
}

module.exports = { parseVmStat, parseSwapusage, parseLoadavg, parseMemsize };
