import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

export interface TopicEntry {
  name: string;
  path: string;
  title: string | null;
  keywords: string[];
}

export interface ListTopicsResult {
  topics: TopicEntry[];
  warnings: string[];
}

export const listTopicsDefinition = {
  name: "list_topics",
  description:
    "Enumerate all available context topics in ~/.claude-data/context/. Returns each topic's name, path, first-H1 title, and keywords parsed from _index.md. Use this to discover what context exists before deciding whether to load a specific topic via get_topic.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

const CONTEXT_DIR = join(homedir(), ".claude-data", "context");

interface IndexEntry {
  name: string;
  keywords: string[];
}

function parseIndex(indexPath: string): Map<string, IndexEntry> {
  const map = new Map<string, IndexEntry>();
  if (!existsSync(indexPath)) return map;
  const text = readFileSync(indexPath, "utf8");

  const lineRe = /^-\s+\*\*(?<name>[^*]+)\*\*\s+—\s+keywords:\s+(?<kw>[^—]+)—\s+file:\s+(?<file>\S+)/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(text)) !== null) {
    const name = (m.groups?.name ?? "").trim();
    const kwRaw = (m.groups?.kw ?? "").trim();
    const file = (m.groups?.file ?? "").trim();
    const keywords = kwRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const key = file.replace(/\.md$/, "");
    map.set(key, { name, keywords });
  }

  return map;
}

function firstH1(content: string): string | null {
  const m = content.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

export function listTopics(contextDir: string = CONTEXT_DIR): ListTopicsResult {
  const warnings: string[] = [];
  const topics: TopicEntry[] = [];

  if (!existsSync(contextDir)) {
    warnings.push(`context directory missing: ${contextDir}`);
    return { topics, warnings };
  }

  const indexPath = join(contextDir, "_index.md");
  const indexEntries = parseIndex(indexPath);

  const onDisk = readdirSync(contextDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "_index.md")
    .map((e) => e.name);

  const onDiskSet = new Set(onDisk.map((n) => basename(n, ".md")));

  for (const file of onDisk) {
    const name = basename(file, ".md");
    const path = join(contextDir, file);
    const content = readFileSync(path, "utf8");
    const title = firstH1(content);
    const indexEntry = indexEntries.get(name);
    topics.push({
      name,
      path,
      title,
      keywords: indexEntry?.keywords ?? [],
    });
    if (!indexEntry) {
      warnings.push(
        `topic file '${file}' exists on disk but is not listed in _index.md`,
      );
    }
  }

  for (const [key] of indexEntries) {
    if (!onDiskSet.has(key)) {
      warnings.push(
        `_index.md references '${key}' but no '${key}.md' file exists on disk`,
      );
    }
  }

  topics.sort((a, b) => a.name.localeCompare(b.name));
  return { topics, warnings };
}
