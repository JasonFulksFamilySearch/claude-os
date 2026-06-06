#!/usr/bin/env node
// carve-identity.js — one-time migration for already-installed machines.
//
// Splits an un-carved agent identity file (persona sections interleaved inline)
// into:
//   - personality.md : the per-machine SOUL (the persona sections), preserved verbatim
//   - CLAUDE.md       : the neutral BODY + a line-1 anchor + an @-import of the persona
//
// WHY a section-allowlist, not a positional range: the persona sections are NOT
// contiguous in a real identity file — "## Address" commonly sits AFTER
// "## Operating rules". Extracting by a name allowlist pulls every persona
// section wherever it sits and leaves everything else as body, which is the only
// layout-robust approach (and the bug that broke a first hand-carve attempt).
//
// IDEMPOTENT: if the body already contains the @-import, or contains no inline
// persona section, this is a no-op (exit 0, prints "already-carved" / "no-persona").
//
// SAFE: never destroys data. Writes personality.md only if it does not already
// exist with content (preserves a hand-tuned soul). Backs up the body before
// rewriting it. Refuses to run if it cannot find the line-1 anchor.
//
// Usage: node carve-identity.js <claude_md_path> <personality_md_path>
// Exit:  0 = carved OR no-op (idempotent);  1 = error (caller should warn, not abort)

const fs = require('fs');

const PERSONA_SECTIONS = new Set([
  'Disposition',
  'Pushback',
  'Style of work',
  'Address',
  'Appreciation response',
]);

const IMPORT_LINE = '@~/.claude-data/agent/personality.md';

function fail(msg) {
  console.error('carve: ' + msg);
  process.exit(1);
}

const claudeMd = process.argv[2];
const personalityMd = process.argv[3];
if (!claudeMd || !personalityMd) fail('usage: carve-identity.js <claude_md> <personality_md>');
if (!fs.existsSync(claudeMd)) fail('identity file not found: ' + claudeMd);

const raw = fs.readFileSync(claudeMd, 'utf8');
const lines = raw.split('\n');

// --- Idempotency / no-op guards ---
if (raw.includes(IMPORT_LINE)) {
  console.log('already-carved (body has @-import) — no-op');
  process.exit(0);
}
const hasInlinePersona = lines.some(
  (l) => l.startsWith('## ') && PERSONA_SECTIONS.has(l.slice(3).trim())
);
if (!hasInlinePersona) {
  console.log('no inline persona section found — no-op');
  process.exit(0);
}

// --- Locate the anchor block (everything before the first "## " section) ---
const firstSection = lines.findIndex((l) => l.startsWith('## '));
if (firstSection < 0) fail('no "## " section headers found — unexpected identity format');
if (!lines[0].startsWith('# Agent Identity')) {
  fail('line 1 is not the "# Agent Identity — <name>" anchor — refusing to carve');
}
const anchorBlock = lines.slice(0, firstSection); // # Agent Identity + "You are ..." + blanks

// --- Walk sections, partition into persona vs body by name allowlist ---
// A "section" runs from a "## H" line up to (but not including) the next "## " line.
const sectionStarts = [];
for (let i = firstSection; i < lines.length; i++) {
  if (lines[i].startsWith('## ')) sectionStarts.push(i);
}
sectionStarts.push(lines.length); // sentinel end

const personaChunks = [];
const bodyChunks = [];
for (let s = 0; s < sectionStarts.length - 1; s++) {
  const start = sectionStarts[s];
  const end = sectionStarts[s + 1];
  const name = lines[start].slice(3).trim();
  let chunk = lines.slice(start, end);
  // Trim trailing blanks AND trailing horizontal-rule separators ("---") off each
  // chunk. A "---" between sections is an inter-section divider, not section
  // content — leaving it would emit a stray separator at the tail of the persona
  // file (or double-separate body sections on reassembly).
  while (
    chunk.length &&
    (chunk[chunk.length - 1].trim() === '' || chunk[chunk.length - 1].trim() === '---')
  ) {
    chunk.pop();
  }
  if (PERSONA_SECTIONS.has(name)) personaChunks.push(chunk);
  else bodyChunks.push(chunk);
}

if (personaChunks.length === 0) {
  console.log('no persona sections matched allowlist — no-op');
  process.exit(0);
}

// --- Build personality.md: banner + anchor + persona sections (verbatim) ---
// Only write if absent/empty — preserve a hand-tuned soul.
const personalityExists =
  fs.existsSync(personalityMd) && fs.statSync(personalityMd).size > 0;
if (!personalityExists) {
  const banner = [
    '<!-- ───────────────────────────────────────────────────────────────────── -->',
    '<!-- PER-MACHINE SOUL. This is the hand-tuned personality for THIS machine.  -->',
    '<!-- update.sh provisions it ONLY IF ABSENT, so hand-tuning survives updates.-->',
    '<!-- The shared body (~/.claude/CLAUDE.md) @-imports this file.              -->',
    '<!-- ───────────────────────────────────────────────────────────────────── -->',
    '',
  ];
  const personaBody = personaChunks.map((c) => c.join('\n')).join('\n\n');
  const out = banner.concat(anchorBlock, [personaBody, '']).join('\n');
  fs.writeFileSync(personalityMd, out);
  console.log('extracted persona -> ' + personalityMd + ' (' + personaChunks.length + ' sections)');
} else {
  console.log('personality.md already present — preserving it, only carving the body');
}

// --- Build carved CLAUDE.md: anchor + @-import + body sections ---
const bodyText = bodyChunks.map((c) => c.join('\n')).join('\n\n---\n\n');
const carved = anchorBlock
  .concat([IMPORT_LINE, ''])
  .concat([bodyText, ''])
  .join('\n');

// Back up the original body before rewriting (timestamped, never overwrites).
// Caller passes the path; we add a suffix that update.sh Step 5 cleanup won't match.
const ts = new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '');
const backup = claudeMd + '.pre-carve-' + ts.slice(0, 15);
if (!fs.existsSync(backup)) {
  fs.copyFileSync(claudeMd, backup);
}
fs.writeFileSync(claudeMd, carved);
console.log('carved body -> ' + claudeMd + ' (backup: ' + backup + ')');
console.log('carve complete');
