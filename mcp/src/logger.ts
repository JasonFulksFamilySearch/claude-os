import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_LOG_PATH = join(homedir(), ".claude-data", ".logs", "mcp-server.log");

let currentLogPath = DEFAULT_LOG_PATH;
mkdirSync(dirname(currentLogPath), { recursive: true });

export function setLogPath(path: string): void {
  currentLogPath = path;
  mkdirSync(dirname(currentLogPath), { recursive: true });
}

export function log(
  level: "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
): void {
  const entry =
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message,
      ...(meta ? { meta } : {}),
    }) + "\n";
  appendFileSync(currentLogPath, entry);
}
