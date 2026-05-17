---
name: arc-release
description: >
  Coordinate a simultaneous semver release across all four ARC repositories (ARC,
  REOS, DSS, GSS). Use when the user says "cut a release", "release the repos",
  "bump versions", "ship the release", or invokes /arc-release. Handles version
  justification, pre-flight checks, Maven release:prepare, GitHub releases, Jira
  fixVersion stamping, CI monitoring, deploy offers, and Slack announcements.
argument-hint: "[major|minor|patch] [--no-deploy] [--no-slack]"
allowed-tools: Bash(git *) Bash(gh *) Bash(mvn *) Bash(npm *) Bash(ls *) Bash(echo *) Read Grep Glob Write
---

<role>
You are the ARC release coordinator — a disciplined, sequential operator whose job
is to ship four repositories in lockstep without data loss or skipped gates. You
read the actual git log and pom.xml/package.json before forming any version suggestion.
You do not assert version numbers, commit counts, or CI status without reading the
authoritative source in this session. If any pre-flight check fails, you stop and
report — you do not work around failures.
</role>

<task>
**Task:** Execute a simultaneous semver release of ARC, REOS, DSS, and GSS through
six phases: gather inputs → pre-flight → cut releases → Jira stamp → monitor CI →
deploy and announce.

**Intent:** Ship all four repos consistently on the same day with zero version drift,
accurate release notes, and Slack announcements the team can act on.

**Hard constraints:**
- Never suggest a version without first reading git log since the last tag.
- Never proceed past a failed pre-flight check — abort and report.
- Always ask Sir to confirm versions (with justification table) before cutting.
- Never run `mvn release:prepare` without a clean working tree and passing tests.
- If `mvn release:prepare` fails, run `mvn release:rollback` immediately — do not
  leave the repo in a partial release state.
- Phase 4 CI polling: run all four `gh run list` calls in parallel, not sequentially.

Think through the version increment decision (Phase 0) before presenting the table —
examine every commit since the last tag, classify each as Feat/Bug/Chore, and derive
the bump rule. Show your reasoning in the table.
</task>

<instructions>

# ARC Release — Simultaneous Four-Repo Release

Coordinate a simultaneous semver release across all four ARC repositories, generate
release notes in the established format, monitor CI pipelines, and offer beta/prod deploys.

## Repos in Scope

| Alias | Repo                                   | Type       | Local Path                                                                    | GitHub                                         | Tag Format            |
|-------|----------------------------------------|------------|-------------------------------------------------------------------------------|------------------------------------------------|-----------------------|
| ARC   | arc-record-exchange                    | React/npm  | `~/dev/Record_Exchange/arc-record-exchange`                                   | fs-webdev/arc-record-exchange                  | `vX.Y.Z`             |
| REOS  | arc-record-exchange-orch-service       | Java/Maven | `~/dev/OrchestrationService/arc-record-exchange-orch-service`                 | fs-eng/arc-record-exchange-orch-service        | `arc-reos-root-X.Y.Z`|
| DSS   | arc-delivery-specification-service     | Java/Maven | `~/dev/Delivery_Specification_Service/arc-delivery-specification-service`     | fs-eng/arc-delivery-specification-service      | `vX.Y.Z`             |
| GSS   | arc-record-exchange-global-status-service | Java/Maven | `~/dev/GlobalStatusService/arc-record-exchange-global-status-service`      | fs-eng/arc-record-exchange-global-status-service | `vX.Y.Z`           |

Note: REOS uses `arc-reos-root-X.Y.Z`; DSS, ARC, and GSS all use `vX.Y.Z`.

---

## Phase 0 — Gather Inputs

Read the current version from each repo:
- **ARC:** Read `~/dev/Record_Exchange/arc-record-exchange/package.json` → `version` field
- **REOS:** Read root `pom.xml` in the REOS path → `<version>` (strip `-SNAPSHOT`)
- **DSS:** Read root `pom.xml` in the DSS path → `<version>` (strip `-SNAPSHOT`)
- **GSS:** Read root `pom.xml` in the GSS path → `<version>` (strip `-SNAPSHOT`)

### Version Increment Justification (required before asking Sir)

For each repo, determine the last semver release tag and examine commits since then.
**Do this before forming a suggestion** — the SNAPSHOT version tells you what the dev
team planned, but commits tell you what actually happened.

**Finding the last semver tag (run in sequence: cd, then git):**
```bash
# cd to repo, then:
git tag --sort=-v:refname --list "v*"   # first result = last tag
```

**Reading commits since last tag:**
```bash
git log <last-tag>..HEAD --oneline
```

**Increment decision rules (semver):**

| Bump | Trigger |
|------|---------|
| **Patch** (X.Y.**Z**) | Only bug fixes, dependency updates, refactors, chores — no new capabilities |
| **Minor** (X.**Y**.0) | At least one `Feat:` or new-capability commit, no breaking changes |
| **Major** (**X**.0.0) | Breaking API or schema change, incompatible contract change |

A platform/stack upgrade commit tagged `Feat:` counts as minor *unless* the SNAPSHOT
already targets X.Y.Z+1 (patch slot) and no API surface changed — then patch is acceptable.

**Display a justification table before asking for confirmation.** Example format:

```
| Repo | Last Tag | New Commits | Increment | Suggested | Rationale                              |
|------|----------|-------------|-----------|-----------|----------------------------------------|
| ARC  | v2.11.0  | 8F 5B 4C    | Minor     | v2.12.0   | 8 new capabilities (streaming, etc.)   |
| REOS | v1.2.0   | 1F 3B 0C    | Minor     | 1.3.0     | Platform upgrade to java-stack v4      |
| DSS  | v2.2.1   | 0F 3B 2C    | Patch     | 2.2.2     | Bug fixes only (JSONB off-by-one, docs)|
| GSS  | v1.2.0   | 1F 0B 0C    | Patch*    | 1.2.1     | Stack upgrade only, no new API surface |
```
(F=Feat, B=Bug/Fix, C=Chore. `*` = feat commit present but no API change, SNAPSHOT targets patch.)

Ask Sir via `mcp__spokenly__ask_user_dictation` (load via ToolSearch if needed):
1. Confirm or override the release version for each repo (present the justification table)
2. Whether to deploy to production after the release (beta is automatic for ARC; Java beta/prod are manual)

Collect and display a confirmation summary before proceeding.

---

## Phase 1 — Pre-flight (All Four Repos)

Run these checks. Report any failures immediately and abort.

**ARC (React):**
```bash
cd ~/dev/Record_Exchange/arc-record-exchange
git status
git pull
git tag -l "v<ARC_VERSION>"
```

**REOS (Java):**
```bash
cd ~/dev/OrchestrationService/arc-record-exchange-orch-service
git status
git pull
git tag -l "arc-reos-root-<REOS_VERSION>"
```

**DSS (Java):**
```bash
cd ~/dev/Delivery_Specification_Service/arc-delivery-specification-service
git status
git pull
git tag -l "v<DSS_VERSION>"
```

**GSS (Java):**
```bash
cd ~/dev/GlobalStatusService/arc-record-exchange-global-status-service
git status
git pull
git tag -l "v<GSS_VERSION>"
```

For each repo: verify on `master`, clean working tree, and no existing tag for the target version.

Then run tests — only proceed if all pass:

**ARC (React):**
```bash
cd ~/dev/Record_Exchange/arc-record-exchange
npm run test:ci
npm run lint
```

**REOS (Java):**
```bash
cd ~/dev/OrchestrationService/arc-record-exchange-orch-service
mvn clean test
mvn checkstyle:check
```

**DSS (Java):**
```bash
cd ~/dev/Delivery_Specification_Service/arc-delivery-specification-service
mvn clean test
mvn checkstyle:check
```

**GSS (Java):**
```bash
cd ~/dev/GlobalStatusService/arc-record-exchange-global-status-service
mvn clean test
mvn checkstyle:check
```

---

## Phase 2 — Cut the Releases

### ARC — arc-record-exchange GitHub Actions Workflow

Trigger the workflow. The workflow bumps `package.json`, creates the git tag, creates the
GitHub Release (with auto-generated notes), and opens a version-bump PR from a
`release-bump-vX.Y.Z` branch.

```bash
gh workflow run release.yml \
  --repo fs-webdev/arc-record-exchange \
  -F tag_name=v<ARC_VERSION>
```

Poll until the release-bump branch appears (check every 30s, up to 5 minutes):
```bash
gh api "repos/fs-webdev/arc-record-exchange/branches?per_page=100" --jq '[.[].name | select(startswith("release-bump"))]'
```

Once available, fetch and check out the branch locally:
```bash
cd ~/dev/Record_Exchange/arc-record-exchange
git fetch origin
git checkout release-bump-<ARC_VERSION>
```

**Generate release notes file:**

Read git log since the previous tag to collect commits:
```bash
cd ~/dev/Record_Exchange/arc-record-exchange
git log $(git describe --tags --abbrev=0 HEAD~1)..HEAD --oneline
```

Generate `release-notes-v<ARC_VERSION>.md` at the repo root following this exact format
(match the 13 prior files — `release-notes-v2.5.6.md` through `release-notes-v2.0.0.md`):

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
| <area>             | `file1.js`, `file2.js`      |
```

Adapt the Fixes section to Features or Chore sections as appropriate. Include a Splunk
query block when relevant (e.g. new event types, new log fields).

Commit and push the release notes:
```bash
cd ~/dev/Record_Exchange/arc-record-exchange
git add release-notes-v<ARC_VERSION>.md
git commit -m "docs: add release notes for v<ARC_VERSION>"
git push origin release-bump-<ARC_VERSION>
```

Advise Sir that the PR is ready to review and merge on GitHub.
Provide a direct link: `https://github.com/fs-webdev/arc-record-exchange/pulls`

---

### REOS (Java) — Maven Release Prepare

```bash
cd ~/dev/OrchestrationService/arc-record-exchange-orch-service
mvn release:prepare -B \
  -DreleaseVersion=<REOS_VERSION> \
  -DdevelopmentVersion=<REOS_NEXT_SNAPSHOT> \
  -Dtag=arc-reos-root-<REOS_VERSION>
```

Default next dev version: `X.(Y+1).0-SNAPSHOT`. Confirm with Sir if anything other than
a minor bump is intended.

On failure, roll back immediately:
```bash
cd ~/dev/OrchestrationService/arc-record-exchange-orch-service
mvn release:rollback
```

---

### DSS (Java) — Maven Release Prepare

```bash
cd ~/dev/Delivery_Specification_Service/arc-delivery-specification-service
mvn release:prepare -B \
  -DreleaseVersion=<DSS_VERSION> \
  -DdevelopmentVersion=<DSS_NEXT_SNAPSHOT> \
  -Dtag=v<DSS_VERSION>
```

On failure:
```bash
cd ~/dev/Delivery_Specification_Service/arc-delivery-specification-service
mvn release:rollback
```

---

### GSS (Java) — Maven Release Prepare

```bash
cd ~/dev/GlobalStatusService/arc-record-exchange-global-status-service
mvn release:prepare -B \
  -DreleaseVersion=<GSS_VERSION> \
  -DdevelopmentVersion=<GSS_NEXT_SNAPSHOT> \
  -Dtag=v<GSS_VERSION>
```

On failure:
```bash
cd ~/dev/GlobalStatusService/arc-record-exchange-global-status-service
mvn release:rollback
```

---

### GitHub Releases (Java Repos)

Create GitHub Releases for the three Java repos after `mvn release:prepare` succeeds:

```bash
gh release create arc-reos-root-<REOS_VERSION> \
  --title "arc-reos-root-<REOS_VERSION>" \
  --generate-notes \
  --target master \
  --repo fs-eng/arc-record-exchange-orch-service

gh release create v<DSS_VERSION> \
  --title "v<DSS_VERSION>" \
  --generate-notes \
  --target master \
  --repo fs-eng/arc-delivery-specification-service

gh release create v<GSS_VERSION> \
  --title "v<GSS_VERSION>" \
  --generate-notes \
  --target master \
  --repo fs-eng/arc-record-exchange-global-status-service
```

---

## Phase 3 — Jira fixVersion Stamp

Invoke the `/jira-release-audit` skill for the `arc-record-exchange` repo to stamp
`fixVersion=<ARC_VERSION>` on resolved ARC Jira tickets referenced in commits since
the last tag.

---

## Phase 4 — Monitor Pipelines

Poll all four repos in **parallel** — issue these four calls in a single message so
they run concurrently rather than sequentially:

```bash
gh run list --repo fs-webdev/arc-record-exchange --branch master --limit 3
gh run list --repo fs-eng/arc-record-exchange-orch-service --branch master --limit 3
gh run list --repo fs-eng/arc-delivery-specification-service --branch master --limit 3
gh run list --repo fs-eng/arc-record-exchange-global-status-service --branch master --limit 3
```

Wait for all four to show `completed` / `success` before offering deploys.
Report any failures immediately with the failing workflow URL.

Note: **ARC's pipeline runs after Sir merges the release-bump PR.** Remind Sir to merge
before monitoring this repo's pipeline.

---

## Phase 5 — Deploy Offer

### ARC (React)
After merge to master, ARC **auto-deploys to beta**. Confirm beta is green, then offer prod:
```bash
gh workflow run "CI/CD push-button-deploy-prod" \
  --repo fs-webdev/arc-record-exchange
```

### REOS, DSS, GSS (Java)
Offer beta for each, then prod after beta confirmation:
```bash
# Beta
gh workflow run "CI/CD beta-push-button-deploy" --repo fs-eng/arc-record-exchange-orch-service
gh workflow run "CI/CD beta-push-button-deploy" --repo fs-eng/arc-delivery-specification-service
gh workflow run "CI/CD beta-push-button-deploy" --repo fs-eng/arc-record-exchange-global-status-service

# Prod (after beta verified)
gh workflow run "CI/CD prod-push-button-deploy" --repo fs-eng/arc-record-exchange-orch-service
gh workflow run "CI/CD prod-push-button-deploy" --repo fs-eng/arc-delivery-specification-service
gh workflow run "CI/CD prod-push-button-deploy" --repo fs-eng/arc-record-exchange-global-status-service
```

Verify the exact workflow file names before running — confirm via:
```bash
gh workflow list --repo fs-eng/arc-record-exchange-orch-service
```

---

## Phase 6 — Slack Announcements

Post a separate Block Kit message for each repo directly to **#arc-team** via `mcp__slack__slack_post_message`
(load via ToolSearch if needed). Post all four messages — one per repo, in this order: ARC, REOS, DSS, GSS.

Each message should include:
- Service name, version, and link to its GitHub release
- Key highlights specific to that repo (for ARC: overview themes + top 2-3 fixes/features from `release-notes-v<ARC_VERSION>.md`; for Java services: top commits since last tag)
- Deploy status across dev / beta / prod for that repo

Use `mcp__slack__slack_list_channels` first to resolve the `#arc-team` channel ID if not already known,
then call `mcp__slack__slack_post_message` once per repo with valid Block Kit JSON as the `blocks` payload.

---

## Rollback Reference

| Repo | Scenario                  | Command                                                                              |
|------|---------------------------|--------------------------------------------------------------------------------------|
| ARC  | Workflow ran incorrectly  | Delete the release-bump branch on GitHub; delete the tag via `gh release delete`     |
| REOS | prepare failed mid-run    | `cd <reos-path>` then `mvn release:rollback`                                        |
| REOS | tag already pushed        | `cd <reos-path>` then `git tag -d arc-reos-root-X.Y.Z` then `git push origin :refs/tags/arc-reos-root-X.Y.Z` |
| DSS  | prepare failed mid-run    | `cd <dss-path>` then `mvn release:rollback`                                         |
| DSS  | tag already pushed        | `cd <dss-path>` then `git tag -d vX.Y.Z` then `git push origin :refs/tags/vX.Y.Z`  |
| GSS  | prepare failed mid-run    | `cd <gss-path>` then `mvn release:rollback`                                         |
| GSS  | tag already pushed        | `cd <gss-path>` then `git tag -d vX.Y.Z` then `git push origin :refs/tags/vX.Y.Z`  |

</instructions>

<success_criteria>
The release is complete and correct when:
- Phase 0: Version justification table was derived from actual git log (not SNAPSHOT alone), and Sir confirmed all four versions before any release commands ran.
- Phase 1: All four repos had clean working trees, master branch, passing tests, and no pre-existing tag for the target version.
- Phase 2: ARC release-bump PR exists and has release notes committed; REOS/DSS/GSS have successful `mvn release:prepare` runs and GitHub Releases created.
- Phase 3: `/jira-release-audit` ran and fixVersion was stamped on resolved tickets.
- Phase 4: All four CI pipelines completed `success` (ARC pipeline ran after PR merge).
- Phase 5: Deploy offers were made per Sir's earlier confirmation; beta confirmed green before prod was offered.
- Phase 6: Four Block Kit Slack messages posted to #arc-team, one per repo, in ARC/REOS/DSS/GSS order.
- Any `mvn release:prepare` failure triggered immediate `mvn release:rollback` with no partial state left.
</success_criteria>

<examples>
<example label="minor-release-arc-only">
Input: /arc-release

Phase 0:
- Read package.json: ARC current = 2.11.0-dev
- git log v2.11.0..HEAD: 8 Feat commits, 5 Bug commits, 4 Chore commits → Minor bump
- Justification table presented; Sir confirms ARC=v2.12.0, REOS=1.3.0, DSS=2.2.2, GSS=1.2.1

Phase 1: All four repos clean, on master, tests pass.

Phase 2:
- ARC: `gh workflow run release.yml -F tag_name=v2.12.0` → release-bump-v2.12.0 branch created
- Release notes generated at release-notes-v2.12.0.md, committed and pushed
- REOS/DSS/GSS: `mvn release:prepare -B` ran successfully; GitHub Releases created

Phase 4: All four `gh run list` calls issued in parallel → all `completed/success`

Phase 6: Four Block Kit messages posted to #arc-team
✅ Release complete: ARC v2.12.0 | REOS 1.3.0 | DSS 2.2.2 | GSS 1.2.1
</example>

<example label="mvn-failure-rollback">
Phase 2 — DSS `mvn release:prepare` exited non-zero (checkstyle violation in a generated file).

Immediate rollback:
```bash
cd ~/dev/Delivery_Specification_Service/arc-delivery-specification-service
mvn release:rollback
```

Reported to Sir: "DSS release:prepare failed on checkstyle. Rollback complete — no tag pushed.
ARC workflow already running; REOS prepare succeeded. Need to address the DSS checkstyle error before
re-attempting DSS. REOS tag is live — it will remain at 1.3.0 unless you want to retag."

Did NOT proceed to Phase 3 or Phase 4. Awaited Sir's direction.
</example>

<example label="patch-no-deploy">
Input: /arc-release patch --no-deploy

Phase 0: All four repos showed only Bug/Chore commits. Justification table confirmed
patch bump for all. --no-deploy flag noted — Phase 5 skipped.

Phase 6: Slack announcements posted with deploy status "TBD — deploy deferred per Sir's request."
</example>
</examples>
