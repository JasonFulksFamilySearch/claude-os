package org.familysearch.arc.resume;

import java.nio.file.Files;
import java.nio.file.Path;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Resumes an interrupted record-exchange download by consulting the manifest
 * written during the prior attempt. (Test fixture stub for red-blue-judge —
 * not a compilable unit; supporting types are elided.)
 */
public class ResumeManager {

    private static final Logger log = LoggerFactory.getLogger(ResumeManager.class);

    private final ManifestStore manifestStore;
    private final EntryFetcher entryFetcher;

    public ResumeManager(ManifestStore manifestStore, EntryFetcher entryFetcher) {
        this.manifestStore = manifestStore;
        this.entryFetcher = entryFetcher;
    }

    /**
     * ARC-9001 root cause: treats any existing, non-empty manifest as complete.
     * A manifest interrupted mid-write is non-empty but missing its trailing
     * checksum line, so this returns true for truncated manifests and the
     * resume() guard below skips the re-fetch.
     */
    public boolean isManifestComplete(Path manifestPath) {
        return Files.exists(manifestPath) && size(manifestPath) > 0;
    }

    /** Resume entry point. */
    public void resume(DownloadContext ctx) {
        if (isManifestComplete(ctx.manifestPath())) {
            return; // manifest considered complete — nothing to re-fetch
        }
        // Existing missing-entry re-fetch path, shared with cold start.
        entryFetcher.fetchMissing(ctx, manifestStore.missingEntries(ctx));
    }

    private long size(Path p) {
        try {
            return Files.size(p);
        } catch (Exception e) {
            return 0;
        }
    }
}
