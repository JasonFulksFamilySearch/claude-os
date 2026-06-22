import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { FSWatcher } from "chokidar";

import { openDb } from "./db.js";
import {
  defaultConfig,
  fullReindex,
  watchAll,
  type IndexerConfig,
  type WatchedProject,
} from "./indexer.js";
import {
  elect,
  defaultLockPath,
  HEARTBEAT_REFRESH_MS,
  type ElectionHandle,
} from "./election.js";
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
import { scanExperience, scanExperienceDefinition } from "./tools/scan_experience.js";
import {
  validateExperienceProposal,
  validateExperienceProposalDefinition,
} from "./tools/validate_experience_proposal.js";

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

  // Index-maintenance state. Only the elected holder runs the three maintenance
  // ops (startup reindex, file watcher, backstop reindex); non-holders skip them
  // and poll to take over if the holder dies. The shutdown closure reads
  // watcher/election, so they are declared at function scope.
  let watcher: FSWatcher | undefined;
  let election: ElectionHandle | undefined;
  let backstop: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;

  // Tear down all maintenance timers + the watcher. Used both on losing the
  // lock to a takeover and as a building block for the holder transition.
  const stopMaintenance = (): void => {
    if (backstop) { clearInterval(backstop); backstop = undefined; }
    if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined; }
    // Catch a possible close() rejection — discarding the promise with `void` alone
    // would surface a chokidar close() failure as an unhandled rejection.
    void watcher?.close().catch(err => log("warn", "watcher close failed on stop", {
      error: err instanceof Error ? err.message : String(err),
    }));
    watcher = undefined;
  };

  // Start the watcher + backstop + heartbeat. Called by the holder (initial
  // election) and by a non-holder that later wins the lock via the poll.
  const startMaintenance = (): void => {
    watcher = watchAll(db, config);
    log("info", "file watcher started", {
      watched: config.watchedProjects.length,
    });

    backstop = setInterval(() => {
      void fullReindex(db, config)
        .then(summary => log("info", "backstop reindex complete", { ...summary }))
        .catch(err => log("error", "backstop reindex failed", {
          error: err instanceof Error ? err.message : String(err),
        }));
    }, REINDEX_INTERVAL_MS);
    backstop.unref();

    // Heartbeat: keep the lock warm. If refresh() self-heals isHolder to false
    // (a takeover removed our lock dir), tear down maintenance and revert to the
    // non-holder poll — bounding the two-holder window to <= one refresh tick.
    heartbeat = setInterval(() => {
      election!.refresh();
      if (!election!.isHolder) {
        log("warn", "lost the writer lock to a takeover; reverting to non-holder poll");
        stopMaintenance();
        startPoll();
      }
    }, HEARTBEAT_REFRESH_MS);
    heartbeat.unref();
  };

  // Non-holder poll: periodically re-elect; on winning, run the catch-up reindex
  // (we skipped the startup one) and start maintenance.
  // yagni: a single re-election cadence is enough; no exponential backoff until
  // a real thundering-herd problem shows up.
  const startPoll = (): void => {
    poll = setInterval(() => {
      election = elect(defaultLockPath(), Date.now());
      if (election.isHolder) {
        if (poll) { clearInterval(poll); poll = undefined; }
        log("info", "won the writer lock; running catch-up reindex");
        void fullReindex(db, config)
          .then(summary => log("info", "catch-up reindex complete", { ...summary }))
          .catch(err => log("error", "catch-up reindex failed", {
            error: err instanceof Error ? err.message : String(err),
          }));
        startMaintenance();
      }
    }, HEARTBEAT_REFRESH_MS);
    poll.unref();
  };

  election = elect(defaultLockPath(), Date.now());
  if (election.isHolder) {
    log("info", "elected as the index-maintenance holder", { pid: process.pid });
    const startupSummary = await fullReindex(db, config);
    log("info", "startup reindex complete", { ...startupSummary });
    startMaintenance();
  } else {
    log("info", "another instance holds the writer lock; serving tools only", {
      pid: process.pid,
    });
    startPoll();
  }

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
      scanExperienceDefinition,
      validateExperienceProposalDefinition,
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
        case "scan_experience":
          return jsonResult(scanExperience(db, args ?? {}, config));
        case "validate_experience_proposal":
          return jsonResult(validateExperienceProposal(args ?? {}, config));
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
    // Null-safe: a non-holder never started a watcher. Release the lock if held
    // (no-op when undefined or not the holder), then close the db. The trailing
    // .catch handles a possible watcher.close() rejection so it does not surface as
    // an unhandled rejection during shutdown (cleanup still runs in .finally first).
    void (watcher?.close() ?? Promise.resolve())
      .finally(() => {
        election?.release();
        try {
          db.close();
        } catch {
          /* ignore */
        }
        process.exit(0);
      })
      .catch(() => process.exit(0));
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
