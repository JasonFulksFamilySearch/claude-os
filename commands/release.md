---
description: "Cut a semver release for a FamilySearch Java service using maven-release-plugin and Blueprint CI/CD pipelines."
---

# FamilySearch Java Service Release

You are performing a semver release of a FamilySearch Java service built on `java-stack-starter-parent`. The project uses `maven-release-plugin`, Blueprint CI/CD pipelines, and GitHub Actions for deployment.

## Inputs to Gather

Ask the user for:
- **Release version** (e.g., `1.0.0`) — suggest based on current pom.xml SNAPSHOT version
- **Next dev version** (e.g., `1.1.0-SNAPSHOT`) — suggest minor bump by default
- **Deploy targets** — dev is automatic; ask if beta and/or prod are desired

## Prerequisites

Verify before proceeding:
1. Root `pom.xml` has `maven-release-plugin` configured with `<tagNameFormat>v@{project.version}</tagNameFormat>`, `<autoVersionSubmodules>true</autoVersionSubmodules>`, `<preparationGoals>clean verify</preparationGoals>`, `<pushChanges>true</pushChanges>`
2. Root `pom.xml` has an `<scm>` block pointing to the GitHub repository
3. If either is missing, add them and merge to the default branch before proceeding

## Step 1: Pre-flight Checks

1. Confirm you are on the default branch (usually `master`) with a clean working tree
2. Pull latest: `git checkout master && git pull`
3. Run tests and checkstyle: `mvn clean test && mvn checkstyle:check`
4. Verify current version in `pom.xml` ends with `-SNAPSHOT`
5. Confirm the target tag does not already exist: `git tag -l 'v*'`

## Step 2: Dry Run

```bash
mvn release:prepare -DdryRun=true -B \
  -DreleaseVersion=<RELEASE_VERSION> \
  -DdevelopmentVersion=<NEXT_DEV_VERSION> \
  -Dtag=v<RELEASE_VERSION>
```

Verify BUILD SUCCESS, then clean up: `mvn release:clean`

## Step 3: Cut the Release

```bash
mvn release:prepare -B \
  -DreleaseVersion=<RELEASE_VERSION> \
  -DdevelopmentVersion=<NEXT_DEV_VERSION> \
  -Dtag=v<RELEASE_VERSION>
```

This will:
1. Set version to `<RELEASE_VERSION>` in all pom.xml files (root + submodules)
2. Run `clean verify` (build + tests)
3. Commit and tag as `v<RELEASE_VERSION>`
4. Bump to `<NEXT_DEV_VERSION>` and commit
5. Push both commits and the tag to GitHub

## Step 4: Verify

1. Tag exists: `git tag -l 'v*'`
2. pom.xml shows the new SNAPSHOT version
3. Commits are on remote: `git log origin/master --oneline -5`
4. Clean up: `rm -f **/pom.xml.releaseBackup release.properties`

## Step 5: Create GitHub Release

```bash
gh release create v<RELEASE_VERSION> \
  --title "v<RELEASE_VERSION>" \
  --notes "<Release notes — summarize changes since last release from git log>" \
  --target master
```

## Step 6: Monitor Build Pipeline

The master push auto-triggers the `build-pipeline` which builds, analyzes, and deploys to dev.

```bash
gh run list --branch master --limit 3
gh run view <RUN_ID> --json status,conclusion,jobs
```

Wait for build pipeline to complete and dev integration to pass.

## Step 7: Deploy to Beta (if requested)

```bash
gh workflow run "CI/CD beta-push-button-deploy"
```

## Step 8: Deploy to Production (if requested)

Requires successful build-pipeline and dev integration.

```bash
gh workflow run "CI/CD prod-push-button-deploy"
```

## Step 9: Announce

Generate a Slack Block Kit JSON message summarizing:
- Service name, release version, and tag
- Features, fixes, and infrastructure changes (from git log since last release)
- Deploy status across environments
- Link to GitHub release

Write valid, minified Block Kit JSON to `~/Downloads/<service>-release-slack.json`.

## Rollback

If release:prepare fails partway through: `mvn release:rollback`

If the tag was already pushed:
```bash
git tag -d v<RELEASE_VERSION>
git push origin :refs/tags/v<RELEASE_VERSION>
```

## Version Strategy

Follow Semantic Versioning (semver.org):
- **Patch** (1.0.0 → 1.0.1): backward-compatible bug fixes
- **Minor** (1.0.0 → 1.1.0): new features, backward-compatible (default bump)
- **Major** (1.x → 2.0.0): breaking API changes