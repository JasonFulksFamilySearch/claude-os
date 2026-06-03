import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { openDb } from "./db.js";
import {
  defaultConfig,
  fullReindex,
  watchAll,
  type IndexerConfig,
  type WatchedProject,
} from "./indexer.js";
import { log } from "./logger.js";

import { searchMemory, searchMemoryDefinition } from "./tools/search_memory.js";
import { getTopic, getTopicDefinition } from "./tools/get_topic.js";
import { appendLearning, appendLearningDefinition } from "./tools/append_learning.js";
import { listTopics, listTopicsDefinition } from "./tools/list_topics.js";
import {
  getRecentLearnings,
  getRecentLearningsDefinition,
} from "./tools/get_recent_learnings.js";
import { listEpisodes, listEpisodesDefinition } from "./tools/list_episodes.js";
import {
  markEpisodePromoted,
  markEpisodePromotedDefinition,
} from "./tools/mark_episode_promoted.js";
import { scanNovelty, scanNoveltyDefinition } from "./tools/scan_novelty.js";
import {
  resolveNoveltyFlag,
  resolveNoveltyFlagDefinition,
} from "./tools/resolve_novelty_flag.js";

const CONFIG_PATH = join(homedir(), ".claude-os", "config", "watched-projects.json");
const REINDEX_INTERVAL_MS = 15 * 60 * 1000;

function loadWatchedProjects(): WatchedProject[] {
  if (!existsSync(CONFIG_PATH)) {
    log("warn", "watched-projects.json missing", { path: CONFIG_PATH });
    return [];
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.projects)) {
      log("warn", "watched-projects.json has no projects array");
      return [];
    }
    return parsed.projects as WatchedProject[];
  } catch (err) {
    log("error", "failed to parse watched-projects.json", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function buildConfig(): IndexerConfig {
  return {
    ...defaultConfig(),
    watchedProjects: loadWatchedProjects(),
  };
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

async function main(): Promise<void> {
  log("info", "claude-os-mcp starting", {
    nodeVersion: process.version,
    pid: process.pid,
  });

  const db = openDb();
  const config = buildConfig();

  const startupSummary = await fullReindex(db, config);
  log("info", "startup reindex complete", { ...startupSummary });

  const watcher = watchAll(db, config);
  log("info", "file watcher started", {
    watched: config.watchedProjects.length,
  });

  const backstop = setInterval(() => {
    void fullReindex(db, config)
      .then(summary => log("info", "backstop reindex complete", { ...summary }))
      .catch(err => log("error", "backstop reindex failed", {
        error: err instanceof Error ? err.message : String(err),
      }));
  }, REINDEX_INTERVAL_MS);
  backstop.unref();

  const server = new Server(
    { name: "claude-os-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      searchMemoryDefinition,
      getTopicDefinition,
      appendLearningDefinition,
      listTopicsDefinition,
      getRecentLearningsDefinition,
      listEpisodesDefinition,
      markEpisodePromotedDefinition,
      scanNoveltyDefinition,
      resolveNoveltyFlagDefinition,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case "search_memory":
          return jsonResult(await searchMemory(db, args ?? {}));
        case "get_topic":
          return jsonResult(getTopic(args ?? {}));
        case "append_learning":
          return jsonResult(appendLearning(db, args ?? {}, config));
        case "list_topics":
          return jsonResult(listTopics());
        case "get_recent_learnings":
          return jsonResult(getRecentLearnings(args ?? {}));
        case "list_episodes":
          return jsonResult(listEpisodes(args ?? {}));
        case "mark_episode_promoted":
          return jsonResult(markEpisodePromoted(db, args ?? {}, config));
        case "scan_novelty":
          return jsonResult(await scanNovelty(db, args ?? {}, config));
        case "resolve_novelty_flag":
          return jsonResult(resolveNoveltyFlag(db, args ?? {}));
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", "tool call failed", { tool: name, error: message });
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const shutdown = (signal: string) => {
    log("info", "shutting down", { signal });
    void watcher.close().finally(() => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "stdio transport connected, ready for requests");
}

main().catch((err) => {
  log("error", "fatal startup error", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
