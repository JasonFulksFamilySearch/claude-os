# ARC Release Rollback Reference

Use this reference when any Phase 2 step fails. Read it when `mvn release:prepare`
exits non-zero or when a tag must be removed after an accidental push.

## Per-Repo Rollback Commands

| Repo | Scenario                  | Command                                                                                          |
|------|---------------------------|--------------------------------------------------------------------------------------------------|
| ARC  | Workflow ran incorrectly  | Delete the release-bump branch on GitHub; delete the tag via `gh release delete`                 |
| REOS | prepare failed mid-run    | `cd <reos-path>` then `mvn release:rollback`                                                    |
| REOS | tag already pushed        | `cd <reos-path>` then `git tag -d arc-reos-root-X.Y.Z` then `git push origin :refs/tags/arc-reos-root-X.Y.Z` |
| DSS  | prepare failed mid-run    | `cd <dss-path>` then `mvn release:rollback`                                                     |
| DSS  | tag already pushed        | `cd <dss-path>` then `git tag -d vX.Y.Z` then `git push origin :refs/tags/vX.Y.Z`              |
| GSS  | prepare failed mid-run    | `cd <gss-path>` then `mvn release:rollback`                                                     |
| GSS  | tag already pushed        | `cd <gss-path>` then `git tag -d vX.Y.Z` then `git push origin :refs/tags/vX.Y.Z`              |
