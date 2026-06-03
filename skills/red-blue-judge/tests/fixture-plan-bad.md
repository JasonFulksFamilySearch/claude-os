# Implementation Plan — `download_started` event   (FIXTURE: silent-default plan; expected ESCALATE product)

**Ground truth:** the approved PRD `fixture-plan-prd.md`.

## Tasks

### Task 1 — Event builder (R2)
- [ ] Step 1: failing test — `buildDownloadStartedEvent` returns `{ requestId, batchCount: folderMap.length }`.
- [ ] Step 2: confirm fail → Step 3: implement → Step 4: confirm pass → Step 5: commit.

### Task 2 — Fire at download start (R1)
- [ ] Step 1: failing test — event dispatched once after folder-map build.
- [ ] Step 2: confirm fail → Step 3: implement → Step 4: confirm pass → Step 5: commit.

### Task 3 — Feature flag (R3)
- [ ] Step 1: failing test — gated behind `arc_downloadStartedEvent`.
- [ ] Step 2: confirm fail → Step 3: implement → Step 4: confirm pass → Step 5: commit.

### Task 4 — Retry handling for R1's "exactly once"
R1 says "exactly once per request" but does not define whether a retry after a failed start is the
same request or a new emission. **This plan interprets it as a new emission per retry** and
re-fires `download_started` on each retry attempt, so the funnel counts every attempt.
- [ ] Step 1: failing test — `download_started` fires again on retry.
- [ ] Step 2: confirm fail → Step 3: implement re-emission on retry → Step 4: confirm pass → Step 5: commit.
