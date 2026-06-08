'use strict';

/**
 * Shared utilities for claude-os hook scripts.
 * Used by session-observer-worker.js and session-start-check.js.
 * No external dependencies — Node.js builtins only.
 */

function todayLocal() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

// Allowlisted YAML parser for episode frontmatter.
// Only accepts the known episode schema keys; silently drops all others.
// This prevents prototype-pollution and injection of unexpected keys from
// episode files into the session-start-check filter logic.
const ALLOWED_FM_KEYS = new Set([
  'date', 'session_id', 'project', 'turns', 'promoted',
  'value_score', 'value_source', 'value_rubric_version', 'value_model',
]);

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return {};
  const data = Object.create(null);
  for (const line of match[1].split(/\r?\n/)) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    if (!ALLOWED_FM_KEYS.has(key)) continue;
    const val = line.slice(colonIdx + 1).trim();
    const lower = val.toLowerCase();
    if (lower === 'true') data[key] = true;
    else if (lower === 'false') data[key] = false;
    else if (/^\d+$/.test(val)) data[key] = parseInt(val, 10);
    else if (val.length > 0) data[key] = val;
  }
  // Clamp value_score to the 0–4 rubric range; out-of-range values are treated
  // as unknown (absence), consistent with "absence ≠ low" — never a bogus value.
  if ('value_score' in data && !(Number.isInteger(data.value_score) && data.value_score >= 0 && data.value_score <= 4)) {
    delete data.value_score; // out-of-range or non-int → unknown (absence), never a bogus value
  }
  return data;
}

// KEEP IN LOCKSTEP with mcp/src/tools/list_episodes.ts extractSummary().
// Same logic, different module system (CommonJS here, ESM there). The hooks
// layer has no package.json, so cross-importing the MCP version isn't
// practical. Update both files or neither. The TypeScript copy strips
// frontmatter using gray-matter; this one strips it manually first.
//
// extractSummary uses no /m flag — but the opening anchor is `(?:^|\n)##`
// rather than `^##` because the frontmatter-strip regex leaves a leading
// "\n" in the body (it consumes the trailing "---\n" but not the blank line
// that follows). Without `(?:^|\n)`, `^##` would fail to match anything when
// content has a blank line between frontmatter and the first heading.
//
// The closing lookahead `(?=\n##|$)` runs to the next section heading or
// end-of-string. Avoiding `/m` here is deliberate — under `/m`, `$` matches
// end-of-line, which would truncate multi-paragraph summaries at the first
// blank line.
//
// Empty-summary guard: if the body between `## Summary` and the next `##`
// heading is whitespace-only, the greedy `\s*` would consume through the
// blank line and `[\s\S]+?` would capture the next heading. trim() returning
// a string that starts with `##` means we captured the next section by
// accident — treat that as "no summary present" and return null.
function extractSummary(content) {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const m = body.match(/(?:^|\n)##\s+Summary\s*\r?\n+([\s\S]+?)(?=\n##|$)/);
  if (!m) return null;
  const text = m[1].trim();
  if (text.length === 0 || text.startsWith('##')) return null;
  return text.slice(0, 300);
}

module.exports = { todayLocal, parseFrontmatter, extractSummary };
