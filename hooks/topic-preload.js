'use strict';

const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const INDEX_PATH = join(homedir(), '.claude-data', 'context', '_index.md');

// Parse lines: - **name** — keywords: k1, k2 — file: name.md
function parseIndex(content) {
  const topics = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*-\s+\*\*([^*]+)\*\*\s+—\s+keywords:\s+([^—]+)\s+—\s+file:\s+(\S+)/);
    if (m) {
      topics.push({
        name: m[1].trim(),
        keywords: m[2].split(',').map(k => k.trim()).filter(Boolean),
        file: m[3].trim(),
      });
    }
  }
  return topics;
}

function matchTopics(topics, message) {
  const lower = message.toLowerCase();
  const matched = [];
  for (const topic of topics) {
    const hits = topic.keywords.filter(kw => lower.includes(kw.toLowerCase()));
    if (hits.length > 0) matched.push({ ...topic, hits });
  }
  return matched;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let prompt = '';
  try {
    const data = JSON.parse(input);
    prompt = data.prompt || data.message || '';
  } catch {
    process.exit(0);
  }

  if (!prompt.trim() || !existsSync(INDEX_PATH)) process.exit(0);

  const topics = parseIndex(readFileSync(INDEX_PATH, 'utf8'));
  const matched = matchTopics(topics, prompt);
  if (matched.length === 0) process.exit(0);

  const lines = matched.map(t =>
    `- ${t.name} (matched: ${t.hits.join(', ')}) — mcp__claude-os-mcp__get_topic("${t.name}")`
  );
  const additionalContext = `[Context hint] Topics matched in your message:\n${lines.join('\n')}`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext },
  }));
}

module.exports = { parseIndex, matchTopics };

if (require.main === module) {
  main().catch(() => process.exit(0));
}
