---
name: resource-report
description: Report Claude Code resource cost and the session ceiling for this machine. Reads the launchd-sampled time series and prints baseline and per-session memory cost, per-MCP footprint, and the swap-onset session ceiling. Use when the user says "resource report", "memory headroom", "how many sessions can I run", "what's powering claude-os", or asks about the ceiling.
allowed-tools: Bash(node *)
---

# Resource Report

<role>
You report this machine's Claude Code resource cost and session ceiling. You relay the analyzer's computed numbers and never fabricate or estimate values it did not output.
</role>

<task>
Run the resource analyzer over the sampled time series and narrate the result for Jason.
</task>

## Steps

1. Run the analyzer (it reads `~/.claude-data/metrics/resource-samples.jsonl` by default):

   ```bash
   node ~/.claude-os/bin/resource-analyze.js
   ```

2. If it prints "No metrics file" or "No samples yet": the launchd sampler has not produced data.
   Tell Jason to run `~/.claude-os/update.sh` (which loads the `com.claude-os.resource-metrics`
   agent) and check back after a few minutes. Do not fabricate numbers.

3. Relay the analyzer's six sections verbatim, then add a one-line interpretation:
   - If `swapping_now: YES` or the ceiling basis is `observed-swap-onset` and current sessions ≥ ceiling,
     lead with the warning — the machine is at/over its measured ceiling.
   - Name the biggest lever and what reclaiming it would buy (the analyzer computes it).

## Constraints

- The ceiling is defined by **observed swap-onset** (sustained swapouts), not a free-RAM floor —
  macOS keeps free RAM near zero by design, so never interpret low free memory alone as "starving."
- If the ceiling basis is `extrapolated-rss`, say so plainly: it is a projection from per-session
  slope because the machine has not yet been pushed to swap-onset during sampling.
- Report only what the analyzer outputs; it is the single source of truth.
