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
  const projectClean = safeString(raw.project, 64);
  return {
    summary: safeString(raw.summary, 2000),
    project: projectClean.length > 0 ? projectClean : null,
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

module.exports = { safeString, coerceObservation };
