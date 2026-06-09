package org.familysearch.arc.resume;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Resumes an interrupted record-exchange download. (Test fixture stub for red-blue-judge —
 * not a compilable unit; supporting types are elided.)
 *
 * This is the ARC-9100 / PR #9999 GUARDED version: it detects a truncated manifest by the
 * trailing checksum line (not size > 0), re-fetches the missing entries, and emits a WARN.
 */
public class ResumeManagerGuarded {

    private static final Logger log = LoggerFactory.getLogger(ResumeManagerGuarded.class);

    private final ManifestStore manifestStore;
    private final EntryFetcher entryFetcher;

    public ResumeManagerGuarded(ManifestStore manifestStore, EntryFetcher entryFetcher) {
        this.manifestStore = manifestStore;
        this.entryFetcher = entryFetcher;
    }

    /**
     * AC1/AC2: a manifest is complete only when its trailing checksum line is present.
     * A manifest interrupted mid-write is non-empty but lacks the trailing checksum line,
     * so this returns false for truncated manifests and resume() re-fetches.
     */
    public boolean isManifestComplete(Path manifestPath) {
        return Files.exists(manifestPath) && hasTrailingChecksumLine(manifestPath);
    }

    /** Resume entry point. */
    public void resume(DownloadContext ctx) {
        if (isManifestComplete(ctx.manifestPath())) {
            return; // AC2: complete manifest — short-circuit, no re-fetch
        }
        // AC1: incomplete — re-fetch the missing entries (path shared with cold start).
        List<Entry> missing = manifestStore.missingEntries(ctx);
        // AC3: emit a structured WARN the Splunk dashboard `download_resume_incomplete` alerts on.
        // The `event_type=` token is what Splunk extracts as the queryable event_type field.
        log.warn("event_type=manifest.resume.incomplete manifestPath={} missingCount={}",
                 ctx.manifestPath(), missing.size());
        entryFetcher.fetchMissing(ctx, missing);
    }

    /** True iff the last line of the manifest is the checksum line written last. */
    private boolean hasTrailingChecksumLine(Path p) {
        try {
            List<String> lines = Files.readAllLines(p);
            if (lines.isEmpty()) {
                return false;
            }
            return lines.get(lines.size() - 1).startsWith("checksum:");
        } catch (Exception e) {
            return false;
        }
    }
}
