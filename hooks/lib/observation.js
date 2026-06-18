'use strict';

// safeString — strips control characters (including newlines) and collapses
// whitespace runs. This guarantees no string field can break the episode's
// YAML frontmatter or markdown structure via embedded \n, \n---, \n##, etc.
// Critical defense against the prompt-injection chain: malicious transcript →
// Haiku embeds newlines in `project` → episode file's YAML breaks → injected
// content surfaces as the summary digest in future session-start contexts.
function safeString(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Quote any scalar that isn't unambiguously safe as a bare YAML value.
// Returns `value` unchanged when YAML-safe; otherwise a double-quoted token
// with embedded `\` and `"` escaped (backslash first to avoid double-escaping).
const YAML_SPECIAL = /[:#\[\]{}&*!|>'"%@,`\\]/;   // special anywhere
const YAML_LEAD    = /^[-?:,\[\]{}#&*!|>'"%@` ]/;  // indicator/space at start
const YAML_COERCE  = /^(?:true|false|null|~|yes|no|on|off|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)$/i;
const YAML_CONTROL = /[\x00-\x1f]/;
function yamlScalar(value) {
  const s = String(value);
  const unsafe = s === '' || s !== s.trim() || YAML_SPECIAL.test(s) || YAML_LEAD.test(s) || YAML_COERCE.test(s) || YAML_CONTROL.test(s);
  if (!unsafe) return s;
  const esc = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x1f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  return '"' + esc + '"';
}

// Strip a trailing "(worktree: …)" or "(TICKET-1234: …)" parenthetical only.
// Legit parentheticals like "(v2)" or "(beta)" are preserved.
function stripWorktreeSuffix(s) {
  return s.replace(/\s*\((?:worktree|[A-Za-z]+-\d+)[:\s][^)]*\)\s*$/, '');
}

// Lowercase; non-alphanumeric runs → single hyphen; trim leading/trailing hyphens.
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Truncate at/under max on a hyphen boundary (never mid-token).
// When no hyphen exists in the first `max` chars (i <= 0), falls back to the
// raw `max`-char cut, which may end mid-token.
function truncateOnHyphenBoundary(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const i = cut.lastIndexOf('-');
  return i > 0 ? cut.slice(0, i) : cut;
}

// Manual schema coercion — replaces Zod (unavailable in hooks layer).
// Prevents TypeError when Haiku returns unexpected shapes (string instead of
// array, null fields, extra keys).
function coerceObservation(raw) {
  // Array.isArray guard: typeof [] === 'object', so a bare check passes
  // arrays. Tighten with explicit isArray rejection.
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Haiku returned non-object response');
  }
  function coerceArray(v, max) {
    if (Array.isArray(v)) {
      return v.filter(x => typeof x === 'string').map(x => safeString(x, max)).slice(0, 20);
    }
    if (typeof v === 'string') {
      const s = safeString(v, max);
      return s.length > 0 ? [s] : [];
    }
    return [];
  }
  const projectRaw = safeString(raw.project, 256);
  const projectSlug = truncateOnHyphenBoundary(slugify(stripWorktreeSuffix(projectRaw)), 64);
  return {
    summary: safeString(raw.summary, 2000),
    project: projectSlug.length > 0 ? projectSlug : null,
    decisions: coerceArray(raw.decisions, 500),
    corrections: coerceArray(raw.corrections, 500),
    discoveries: coerceArray(raw.discoveries, 500),
    files_of_note: Array.isArray(raw.files_of_note)
      ? raw.files_of_note
          .filter(f => f && typeof f.path === 'string' && typeof f.reason === 'string')
          .map(f => ({ path: safeString(f.path, 500), reason: safeString(f.reason, 500) }))
          .slice(0, 20)
      : [],
    value_score:
      Number.isInteger(raw.value_score) && raw.value_score >= 0 && raw.value_score <= 4
        ? raw.value_score
        : undefined,
  };
}

module.exports = { safeString, yamlScalar, stripWorktreeSuffix, slugify, truncateOnHyphenBoundary, coerceObservation };
