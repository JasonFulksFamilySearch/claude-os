import Database from "better-sqlite3";
import { existsSync, readFileSync, writeFileSync, renameSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { defaultConfig, indexFile, type IndexerConfig } from "../indexer.js";

export const markEpisodePromotedInput = z.object({
  path: z.string().min(1),
});

export type MarkEpisodePromotedInput = z.infer<typeof markEpisodePromotedInput>;

export interface MarkEpisodePromotedResult {
  path: string;
  promoted: boolean;
}

export const markEpisodePromotedDefinition = {
  name: "mark_episode_promoted",
  description:
    "Set promoted: true in an episode file's frontmatter after its content has been promoted to learnings.md or a context topic. Use the path returned by list_episodes. Re-indexes the file immediately so search_memory reflects the change.",
  inputSchema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the episode .md file (from list_episodes).",
      },
    },
    required: ["path"],
  },
};

// Resolve the canonical episodes root from config.dataRoot.
// Computed per-call (not at module load) so tests can inject a temporary
// dataRoot via config; the production caller uses defaultConfig() which
// derives the path from homedir().
function resolveEpisodesRoot(dataRoot: string): string {
  const expected = resolve(dataRoot, "episodes");
  try { return realpathSync(expected); }
  catch { return expected; }
}

// Internal implementation — accepts test-injectable config so episodesDir can vary.
export function markEpisodePromotedImpl(
  db: Database.Database,
  rawArgs: unknown,
  config: IndexerConfig = defaultConfig(),
): MarkEpisodePromotedResult {
  const args = markEpisodePromotedInput.parse(rawArgs);
  const episodesRoot = resolveEpisodesRoot(config.dataRoot);

  if (!existsSync(args.path)) {
    throw new Error(`Episode file not found: ${args.path}`);
  }

  // Resolve through symlinks BEFORE any read or write to defeat symlink escapes.
  // NOTE: indexer.classify() uses plain resolve() — these can disagree under a
  // symlinked dataRoot (e.g., macOS /var → /private/var). Safe in production
  // because ~/.claude-data is a direct path under $HOME on both targets.
  let real: string;
  try { real = realpathSync(args.path); }
  catch { throw new Error(`Cannot resolve path: ${args.path}`); }

  // Containment: resolved path must live inside the episodes directory.
  if (real !== episodesRoot && !real.startsWith(episodesRoot + sep)) {
    throw new Error(`Path outside the episodes directory: ${args.path}`);
  }

  if (!real.endsWith(".md")) {
    throw new Error(`Not a .md file: ${args.path}`);
  }

  const raw = readFileSync(real, "utf8");

  // Shape guard: must look like an episode before we modify it.
  const fmMatch = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)/);
  if (!fmMatch) throw new Error(`Invalid episode — missing frontmatter: ${real}`);

  const [, open, fmBody, close] = fmMatch;
  const rest = raw.slice(fmMatch[0].length);

  // Require at minimum a date field in the frontmatter as an episode identity check.
  if (!/^date:/m.test(fmBody)) {
    throw new Error(`Invalid episode — missing required frontmatter field 'date': ${real}`);
  }

  // Targeted regex replace — only the promoted: line changes.
  // This preserves all other fields exactly as written, preventing
  // gray-matter date coercion (YYYY-MM-DD → ISO timestamp) and key reordering.
  //
  // The replacement regex matches the WHOLE LINE (`/^promoted:.*$/m`). A naive
  // `/^promoted:\s*\S+/m` is unsafe — `\s` matches `\n`, so an empty `promoted:`
  // value would let `\s*\S+` walk into the next line and consume the first
  // token of the adjacent field. Whole-line replacement is the safe form.
  const newFmBody = /^promoted:/m.test(fmBody)
    ? fmBody.replace(/^promoted:.*$/m, "promoted: true")
    : fmBody + "\npromoted: true";

  const updated = open + newFmBody + close + rest;

  // Atomic write: write to .tmp, then rename. If the process is killed mid-write,
  // the original file is left intact.
  const tmpPath = real + ".tmp";
  writeFileSync(tmpPath, updated, "utf8");
  renameSync(tmpPath, real);

  indexFile(db, real, config);

  return { path: real, promoted: true };
}

// Public entry point — path containment always uses the production EPISODES_ROOT.
export function markEpisodePromoted(
  db: Database.Database,
  rawArgs: unknown,
  config: IndexerConfig = defaultConfig(),
): MarkEpisodePromotedResult {
  return markEpisodePromotedImpl(db, rawArgs, config);
}
