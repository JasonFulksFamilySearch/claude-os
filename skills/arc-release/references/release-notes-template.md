# ARC Release Notes Template

Use this template when generating `release-notes-v<ARC_VERSION>.md` for the ARC repo in Phase 2.
The 13 prior files (`release-notes-v2.0.0.md` through `release-notes-v2.5.6.md`) follow this
exact structure — match it precisely.

---

```
# Release X.Y.Z — <Short Theme> (<primary ARC ticket>)

**Release Date:** <today's date>
**Status:** Production Ready
**Type:** Patch Release | Minor Release | Major Release
**Tag:** `vX.Y.Z`

---

## Overview

<2-3 sentence summary of what this release addresses>

Key themes:
- **<Theme 1>** — <one-line explanation>
- **<Theme 2>** — <one-line explanation>
- **<Theme 3>** — <one-line explanation>

---

## Fixes

### Fix: <Description> (<ARC-XXXX>) (#<PR>)

**What Changed:**
<Numbered list of technical changes>

**Impact:**
- **<Impact area>** — <description>
- **<Impact area>** — <description>

**Files Modified:**
- `path/to/file.js`

---

## Summary

<1-2 paragraph recap of the release>

---

## Modified Files Summary

| Area               | Key Files                    |
|--------------------|------------------------------|
| <area>             | `file1.js`, `file2.js`       |
```

---

## Section adaptation

- **Patch release** — use the `## Fixes` section as primary.
- **Minor release** — add `## Features` above `## Fixes`; document each new capability.
- **Major release** — add `## Breaking Changes` above `## Features`; document migration steps.
- **Chore-only release** — replace `## Fixes` with `## Chores` (dependency bumps, infra).
- Include a **Splunk query block** when the release adds new event types or log fields.
