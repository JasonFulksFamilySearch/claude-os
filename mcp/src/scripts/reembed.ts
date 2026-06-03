// One-time migration: re-embed every observation and atomically swap the vector index.
// Run by hand, with Claude Code sessions quiesced:  npm run reembed
// Not wired into server startup. Idempotent and lossless — re-running after reverting the
// embedding dtype performs rollback. All logic lives in reembedAll(); this is just the shell.
import { openDb } from "../db.js";
import { reembedAll } from "../reembed.js";
import { log } from "../logger.js";

async function main(): Promise<void> {
  const db = openDb();
  try {
    const { cleared, reembedded, durationMs } = await reembedAll(db);
    log("info", "reembed complete", { cleared, reembedded, durationMs });
    console.log(
      `reembed: cleared ${cleared} old vector(s), re-embedded ${reembedded} observation(s) ` +
        `in ${(durationMs / 1000).toFixed(1)}s`,
    );
  } finally {
    db.close();
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log("error", "reembed failed", { error: msg });
    console.error("reembed failed:", msg);
    process.exit(1);
  },
);
