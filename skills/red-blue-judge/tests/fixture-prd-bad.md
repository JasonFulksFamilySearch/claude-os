# PRD: ARC-9001 download resume

## Goal and context
Resumed downloads sometimes look complete but are missing records. We will make resume
more robust so users stop seeing partial downloads.

## Open product questions
None.

## Solution / Architecture approach
On resume, check whether the manifest file is non-empty (size > 0 bytes). If it has any
content, consider the prior download complete and continue from there. This mirrors the
existing emptiness guard used elsewhere in the resume code.

## File structure
- Modify `ResumeManager.java` — add the size check in `isManifestComplete()`.
- New config `resume.backoff.ms` (default 500) to add exponential backoff between resume
  attempts, improving reliability under flaky networks.

## Out of scope
- Changes to the download initiation path.

## Further notes
The backoff addition will also smooth out load on the upstream service.
