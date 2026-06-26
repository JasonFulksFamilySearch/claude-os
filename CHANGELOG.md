# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] — 2026-06-25

First release under the official **Dioscuri** name. 331 commits since v1.1.0
(37 `feat`, 29 `fix`); backward-compatible — **no breaking changes**. The
structural identifier rename was deliberately deferred, so v1.1.0 installs keep
working after `update.sh`.

### Added
- **Dioscuri context-engineering subsystem** (Phases 0–4): the `PostToolUse`
  ContentRouter seam, SmartCrusher JSON compression, CCR three-store retrieval,
  and graph enrich.
- **C1** retrieval eval gate — BM25+vector baseline plus a non-regression
  verdict (`npm run eval`).
- **C2** entry-granular (anchored-row) indexing — one DB row per dated learning
  entry, with new `anchor` / `parent_title` columns. The chunk-split cutover is
  flag-gated (`c2_chunking_enabled`) and ships **default-off**, deferred.
- **D1** durable episodic + learnings capture; **D2** vector-coverage sweep.
- **DIO-18 / FR-B5** compressed-tool-output capture path — built **default-OFF**
  (file-sentinel flag); arming remains a separate human-gated decision (#72).
- **DIO-19** non-error fidelity A/B harness — the content-level fidelity floor
  that the content-blind eval gate cannot provide.
- TOIN-style retrieval logging (signal only).
- Background digests as per-agent **launchd** LaunchAgents (replacing the
  session-bound CronCreate path).
- New skill `generate-qa-subtask`; track-based triage for `make-it-so`.

### Changed
- **Official rebrand to Dioscuri** — branding and cosmetic identifiers only. The
  repo slug, install paths, and MCP registration are **unchanged**, which is what
  keeps this release backward-compatible.

### Migration
- v1.2.0 carries the **C2 schema migration** (new `anchor` / `parent_title`
  columns), applied via `npm run migrate` and wired into `update.sh`. Run
  `/assimilate-claude-os` on **both** twins (Walter *and* Willis) to propagate.
  The chunk-split cutover stays default-off — do not arm it during this update.

### Deferred (not in this release)
- The **claude-os → Dioscuri identifier migration** (repo slug, `~/.claude-os`
  install path, `~/.claude-data/`, `claude-os-mcp` registration,
  `CLAUDE_OS_HOOK_DEPTH`, the `*-claude-os` skill names). v1.2.0 made Dioscuri the
  official *name* but left these structural identifiers in place. The migration
  needs a back-compat shim so in-flight installs don't break, and lands as a
  **major** (v2.0.0) bump. See
  `docs/superpowers/specs/2026-06-05-claude-os-identity-architecture-design.md` §10.

[1.2.0]: https://github.com/JasonFulksFamilySearch/claude-os/releases/tag/v1.2.0
