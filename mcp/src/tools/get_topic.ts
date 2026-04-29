import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

export const getTopicInput = z.object({
  topic_name: z.string().min(1),
});

export type GetTopicInput = z.infer<typeof getTopicInput>;

export interface GetTopicResult {
  topic: string;
  path: string;
  content: string;
}

export const getTopicDefinition = {
  name: "get_topic",
  description:
    "Load the full canonical content of a context topic file from ~/.claude-data/context/<topic>.md. Reads from disk, not from the index, because the markdown file is always source of truth. Returns null if the topic doesn't exist. Use this after search_memory points you at a specific topic, or when you know the topic name up front (e.g. 'jira', 'github', 'java').",
  inputSchema: {
    type: "object" as const,
    properties: {
      topic_name: {
        type: "string",
        description:
          "Topic file basename without .md extension (e.g. 'jira', 'github', 'java').",
      },
    },
    required: ["topic_name"],
  },
};

const CONTEXT_DIR = join(homedir(), ".claude-data", "context");

export function getTopic(rawArgs: unknown, contextDir: string = CONTEXT_DIR): GetTopicResult | null {
  const args = getTopicInput.parse(rawArgs);
  const safe = args.topic_name.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe || safe !== args.topic_name) {
    return null;
  }
  const path = join(contextDir, `${safe}.md`);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  return { topic: safe, path, content };
}
