# Implementation Plan — `download_started` event   (FIXTURE: faithful plan; expected CLEAN)

**Ground truth:** the approved PRD `fixture-plan-prd.md`.

## Tasks

### Task 1 — Event builder (R2)
- [ ] Step 1: failing test in `analytics.test.js` — `buildDownloadStartedEvent(requestId, folderMap)` returns `{ requestId, batchCount: folderMap.length }`.
- [ ] Step 2: run, confirm fail.
- [ ] Step 3: implement `buildDownloadStartedEvent` returning exactly `{ requestId, batchCount: folderMap.length }`.
- [ ] Step 4: run, confirm pass.
- [ ] Step 5: commit.

### Task 2 — Fire at download start (R1)
- [ ] Step 1: failing test in `DownloadWorkflowManager.test.js` — `download_started` dispatched once, after folder-map build, before the first batch.
- [ ] Step 2: confirm fail → Step 3: dispatch the event at that point → Step 4: confirm pass → Step 5: commit.

### Task 3 — Feature flag (R3)
- [ ] Step 1: failing test — event suppressed when `arc_downloadStartedEvent` is off, emitted when on.
- [ ] Step 2: confirm fail → Step 3: gate the dispatch behind the flag (default off) → Step 4: confirm pass → Step 5: commit.

## Out of scope
- Resume and retry behavior — the event fires only on a fresh start (R1). No re-emission logic is added; the plan implements only what the PRD settles.
