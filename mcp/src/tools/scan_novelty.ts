import Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defaultConfig, type IndexerConfig } from "../indexer.js";
import { embedDocument } from "../embedder.js";
import {
  parseEntries,
  findNearDuplicateEntries,
  canonicalPairOrder,
  type ParsedEntry,
} from "../novelty.js";

export const scanNoveltyInput = z.object({
  project: z.string().optional(),
});

export type ScanNoveltyInput = z.infer<typeof scanNoveltyInput>;

interface EntryRef {
  source_path: string;
  date: string;
  title: string;
  snippet: string;
}

export interface NoveltyCandidate {
  flag_id: number;
  kind: string; // duplicate | contradiction
  similarity: number;
  detected_by: string; // write | scan
  a: EntryRef;
  b: EntryRef;
}

export const scanNoveltyDefinition = {
  name: "scan_novelty",
  description:
    "Review-time scan for duplicate learning entries. Parses all learning entries (optionally one project + agent), embeds each, clusters near-duplicates, persists them as pending novelty flags, and returns every pending candidate (write-time + scan) re-located to its current entry text. Stale flags (entry since edited/removed) are dropped. The agent labels each pair duplicate/contradiction/distinct and proposes supersessions in /memory-merger; this tool never mutates learnings. (v1 surfaces near-duplicates; contradiction-band surfacing is deferred.)",
  inputSchema: {
    type: "object" as const,
    properties: {
      project: {
        type: "string",
        description:
          "Optional project slug to scope the scan to that project's learnings plus the agent learnings. Omit to scan all.",
      },
    },
    required: [],
  },
};

interface Tagged {
  path: string;
  entry: ParsedEntry;
}

function learningFiles(dataRoot: string, project?: string): string[] {
  const files: string[] = [join(dataRoot, "agent", "learnings.md")];
  const projectsDir = join(dataRoot, "projects");
  if (project) {
    files.push(join(projectsDir, project, "learnings.md"));
  } else if (existsSync(projectsDir)) {
    for (const slug of readdirSync(projectsDir)) {
      files.push(join(projectsDir, slug, "learnings.md"));
    }
  }
  return files.filter((f) => existsSync(f));
}

const snippet = (s: string): string => (s.length > 240 ? s.slice(0, 240) + "…" : s);

interface FlagRow {
  id: number;
  source_path: string;
  entry_date: string;
  entry_hash: string;
  match_path: string;
  match_date: string;
  match_hash: string;
  similarity: number;
  kind: string;
  detected_by: string;
}

export async function scanNovelty(
  db: Database.Database,
  rawArgs: unknown,
  config: IndexerConfig = defaultConfig(),
): Promise<{ candidates: NoveltyCandidate[] }> {
  const args = scanNoveltyInput.parse(rawArgs);

  // 1. Parse all in-scope learning entries, tagged with their file.
  const tagged: Tagged[] = [];
  for (const file of learningFiles(config.dataRoot, args.project)) {
    for (const entry of parseEntries(readFileSync(file, "utf8"))) {
      tagged.push({ path: file, entry });
    }
  }

  // 2. Embed (doc-prefix) + cluster into near-duplicate / contradiction-candidate pairs,
  //    persisting each as a pending flag (INSERT OR IGNORE dedups a re-detected pair).
  if (tagged.length >= 2) {
    const entries = tagged.map((t) => t.entry);
    const vectors = await Promise.all(entries.map((e) => embedDocument(e.body)));
    const pairs = findNearDuplicateEntries(entries, vectors);
    const now = Math.floor(Date.now() / 1000);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO novelty_flags(
         source_path, entry_date, entry_hash, match_path, match_date, match_hash,
         similarity, kind, detected_by, status, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scan', 'pending', ?)`,
    );
    for (const p of pairs) {
      const ai = entries.indexOf(p.a);
      const bi = entries.indexOf(p.b);
      // Canonical pair order so a scan-detected flag dedups against a write-detected one.
      const [e, m] = canonicalPairOrder(
        { path: tagged[ai].path, date: p.a.date, hash: p.a.hash },
        { path: tagged[bi].path, date: p.b.date, hash: p.b.hash },
      );
      insert.run(e.path, e.date, e.hash, m.path, m.date, m.hash, p.cosine, p.kind, now);
    }
  }

  // 3. Return every PENDING flag, re-located to current entry text; skip stale ones.
  const byKey = new Map<string, Tagged>();
  for (const t of tagged) byKey.set(`${t.path}|${t.entry.date}|${t.entry.hash}`, t);
  const locate = (path: string, date: string, hash: string): Tagged | undefined =>
    byKey.get(`${path}|${date}|${hash}`);

  const rows = db
    .prepare(
      `SELECT id, source_path, entry_date, entry_hash, match_path, match_date, match_hash,
              similarity, kind, detected_by
       FROM novelty_flags WHERE status = 'pending' ORDER BY id`,
    )
    .all() as FlagRow[];

  const candidates: NoveltyCandidate[] = [];
  for (const r of rows) {
    const a = locate(r.source_path, r.entry_date, r.entry_hash);
    const b = locate(r.match_path, r.match_date, r.match_hash);
    if (!a || !b) continue; // stale — entry edited or removed since flagging
    candidates.push({
      flag_id: r.id,
      kind: r.kind,
      similarity: r.similarity,
      detected_by: r.detected_by,
      a: { source_path: r.source_path, date: a.entry.date, title: a.entry.title ?? "(untitled)", snippet: snippet(a.entry.body) },
      b: { source_path: r.match_path, date: b.entry.date, title: b.entry.title ?? "(untitled)", snippet: snippet(b.entry.body) },
    });
  }
  return { candidates };
}
