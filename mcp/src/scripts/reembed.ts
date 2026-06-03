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

// Deliberately NO process.exit(). onnxruntime-node's native thread pool aborts
// ("mutex lock failed") when static destructors run during the abrupt teardown
// process.exit() forces. Setting process.exitCode and letting the event loop drain
// naturally tears the model down cleanly (verified: process.exit → SIGABRT; natural → exit 0).
main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  log("error", "reembed failed", { error: msg });
  console.error("reembed failed:", msg);
  process.exitCode = 1;
});
