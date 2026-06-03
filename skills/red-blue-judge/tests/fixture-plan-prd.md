# PRD — `download_started` analytics event   (FIXTURE: approved PRD; ground truth for plan-mode fixtures)

## Problem
We have no signal for when a v3 download begins, so the start→finish funnel cannot be measured.

## Solution
Emit one `download_started` analytics event at the moment a fresh v3 download begins.

## Requirements (all settled — confirmed with the analytics owner)
- **R1** Emit `download_started` exactly once per request, after the folder map is built and before the first batch downloads.
- **R2** Payload is exactly `{ requestId: string, batchCount: integer }`, where `batchCount` is the folder-map length (all batches, including empty ones).
- **R3** Gate the behavior behind feature flag `arc_downloadStartedEvent` (default off).

## Out of scope (explicitly deferred)
- Resumed/partial downloads — the event fires only on a fresh start.
- A `download_finished` companion event.

> Note: this PRD is silent on **retry-after-failure** semantics — it neither specifies nor defers
> whether a retried attempt counts as the same request for R1's "exactly once." That gap is the
> axis the plan fixtures differ on.
