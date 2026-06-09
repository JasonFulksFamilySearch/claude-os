# QA Verification — Manifest completeness guard on resume   (FIXTURE: faithful plan; expected CLEAN)

Verifies ARC-9100 (PR #9999) **on resume behavior + Splunk**: a truncated manifest is re-fetched, a
checksum-terminated manifest short-circuits, and an incomplete detection emits a WARN. Ships flag-less.

## Prerequisites
- Chrome/Edge (File System Access API) · int env · **flag-less** (nothing to toggle; no flag-off regression).
- Test account · Splunk access (for AC3) · a multi-batch RID provisioned for this test (RID-FIXTURE-01).
- Ability to seed a manifest: a truncated copy (no trailing checksum line; missing ≥1 entry) and a complete copy.

## Test 1 — Truncated manifest is detected incomplete and re-fetched   _(AC1)_
1. Seed the output folder with a manifest **missing its trailing checksum line** for RID-FIXTURE-01.
2. Resume the download to that folder.
- **Expected:** resume does NOT skip; the missing entries are re-fetched and the download completes.
- **Verify (behavior):** the re-fetch path runs — `ResumeManagerGuarded.resume` takes the
  `fetchMissing` branch (`codebase/ResumeManagerGuarded.java`), re-fetching the missing entries; the
  download then completes.

## Test 2 — Complete manifest short-circuits (no re-fetch)   _(AC2)_
1. Seed the output folder with a manifest **whose trailing checksum line is present**.
2. Resume the download.
- **Expected:** resume short-circuits — no re-fetch occurs; existing files are used as-is. (negative guard)
- **Verify:** no `fetchMissing` call; download reports complete immediately.

## Test 3 — Incomplete detection emits the WARN   _(AC3)_
1. Repeat Test 1's truncated-manifest resume.
- **Expected:** a WARN is logged when the incomplete manifest is detected.
- **Verify in Splunk:** `event_type=manifest.resume.incomplete` — exactly one row carrying the
  `manifestPath` and a `missingCount` equal to the number of missing entries in the seeded gap.

## Pass Criteria
- [ ] AC1 — truncated manifest re-fetches (Test 1)
- [ ] AC2 — complete manifest short-circuits, no re-fetch (Test 2)
- [ ] AC3 — `manifest.resume.incomplete` WARN emitted with path + missing count (Test 3)
- [ ] no regression to a normal cold-start download

## Context
- parent story ARC-9100 · implementing PR #9999 · code `codebase/ResumeManagerGuarded.java`.
