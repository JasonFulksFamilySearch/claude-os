import { describe, it, expect } from "vitest";
import matter from "gray-matter";
import { createRequire } from "node:module";

// Import the real CJS hooks module into this ESM test via createRequire.
// Named exports from a CJS module are available when Node resolves the
// module's module.exports object — the two functions we need are exported
// on module.exports in session-observer-worker.js.
const require = createRequire(import.meta.url);
const { buildEpisodeContent, coerceObservation } = require(
  "../../hooks/session-observer-worker.js"
);

describe("episode frontmatter strict-YAML round-trip", () => {
  it("produces parse-clean YAML and a slug-form project when the raw project name contains a worktree suffix with a colon", () => {
    // Realistic raw observation: the compound project string that caused the
    // cutover crash — an unquoted inline colon makes gray-matter throw.
    const raw = {
      project: "ARC Record Exchange (worktree: feat/ARC-4539-nonpayload-file-iso)",
      summary: "s",
      decisions: [],
      corrections: [],
      discoveries: [],
      files_of_note: [],
    };

    const obs = coerceObservation(raw);
    const md = buildEpisodeContent(obs, "sess", 5);

    // (a) gray-matter must not throw — strict-YAML parse gate.
    expect(() => matter(md)).not.toThrow();

    // (b) The project frontmatter must be the normalized slug, not the raw
    //     compound string that contained an unquoted colon.
    expect(matter(md).data.project).toBe("arc-record-exchange");
  });
});
