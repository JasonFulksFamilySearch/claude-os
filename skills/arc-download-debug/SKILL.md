---
name: arc-download-debug
description: "Diagnostic skill for ARC Record Exchange download failures. Loads JIRA context, reads attempt files, parses Splunk CSV exports, and generates root-cause reports."
argument-hint: path/to/splunk-export.csv [--data-path /path/to/download/dir]
---

Launch the `arc-download-debug` agent to analyze the ARC Record Exchange download failure.

**CSV file path:** `$ARGUMENTS`

Run all four phases (Context Loading → CSV Analysis → Pattern Matching → Findings Report) and produce the full diagnostic report.
