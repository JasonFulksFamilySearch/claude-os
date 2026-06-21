# Dioscuri context-graph: feature guide

This guide explains what the Dioscuri context-graph upgrade does for you and how to use it. It covers turning the feature on, controlling it during a session, retrieving compressed tool output, querying the code graph, and reading the activity log.

For how the system works internally, see the [Dioscuri system reference (issue #60)](https://github.com/JasonFulksFamilySearch/claude-os/issues/60).

## Overview

The Dioscuri context-graph upgrade reduces context-window pressure and gives the agent structural awareness of your code. It adds five capabilities, all of which run automatically once you activate them:

- **Tool-output compression.** Large JSON tool results are compressed before they reach the agent's context, while error, anomaly, and boundary rows are always kept.
- **On-demand retrieval.** The agent can recover the byte-exact original of any compressed result from its hash.
- **A code graph.** A queryable reach-and-contract index of your TypeScript, used for blast-radius questions and structural audits.
- **Graph enrichment.** When relevant graph findings exist, the agent ranks and injects them alongside a tool result.
- **Activity logging.** A signal-only log records what the feature did, so you can see compression and retrieval activity without it changing any behavior.

The feature is reversible and controllable at several levels: a session-wide off switch, per-call skip flags, and a full uninstall path. None of it writes to your promoted memory or the evaluation corpus.

## Before you begin

The upgrade is merged to `master`, but **merging does not activate it on your machine.** Hooks are registered and directories are provisioned by `update.sh`. Until you run that script, the feature is dormant.

Before you activate the feature, confirm you have:

- A local checkout of `claude-os` on `master` (or a branch that contains it).
- Node.js 20 or later (the `engines` floor).
- The `mcp/` dependencies installed, if you plan to build the code graph.

## Activate the feature

To activate the upgrade, run the update script:

```bash
cd ~/.claude-os
./update.sh
```

The script performs two steps that activate Dioscuri:

- **Step 3** registers the lifecycle hooks in `~/.claude/settings.json` by running `hooks-install.js`. This wires in the `PostToolUse` content router, the `PreCompact` staleness check, and the `Stop` episodic-capture hook. The step is idempotent: it adds only missing hooks and skips any already present.
- **Step 11** provisions the working directories: `~/.claude-data/findings-buffer/`, `~/.claude-data/findings-acted/`, and `~/.claude-data/.logs/`.

After the script finishes, the feature is active in every new session. To verify, start a session and run a tool that returns a large JSON array; a compressed result shows a retrieval marker (see [Retrieve a compressed result](#retrieve-a-compressed-result)).

## Compress tool output

When a tool returns a JSON array, the content router compresses it before it reaches the agent's context. You don't invoke this; it happens automatically.

Compression keeps every error, anomaly, and boundary row unconditionally, then selects a representative subset of the remaining rows. Arrays of **8 rows or fewer** pass through unchanged.

A compressed result ends with a retrieval marker in this format:

```
[500 items compressed to 12. Retrieve more: hash=abc123...def456]
```

The marker tells you how many items were compressed, how many were kept, and the hash you use to retrieve the original.

### Skip compression for one call

To pass a tool result through uncompressed, set a skip flag on the tool input:

```json
{ "_dioscuri": { "skipCompress": true } }
```

The raw result then passes through byte-unchanged.

### Skip compression for the session

To disable compression for an entire session, set an environment variable before you start the session:

```bash
export DIOSCURI_SKIP_COMPRESS=1
```

Set the variable to the string `1`. Any other value leaves compression on.

## Retrieve a compressed result

When you need the full original of a compressed result, the agent retrieves it from the marker's hash. Retrieval resolves the byte-exact original from one of three stores, in order: the ephemeral session cache, the archive, then the code graph.

The retrieval function takes the hash and an optional query, and returns the result:

```javascript
retrieve(hash)            // returns { found: true, store, original, hash }
retrieve(hash, query)     // additionally narrows the original to rows matching query
```

- On success, `found` is `true`, `store` is `ephemeral`, `archive`, or `graph`, and `original` holds the recovered content.
- On failure, `found` is `false` and `reason` explains why (for example, `hash-mismatch-on-resolve`).

Retrieval fails closed: if a store returns content whose hash doesn't match the requested hash, retrieval rejects it rather than returning the wrong data.

The ephemeral cache lives at `~/.claude-data/ccr-cache/<sessionId>/` and is evicted when the session ends. It holds at most 256 entries.

## Build and query the code graph

The code graph is a reach-and-contract index of your TypeScript. The agent queries it to answer blast-radius questions ("what reaches this function?") and to audit your code against the contracts you declare.

### Build the graph

To build the graph, run:

```bash
cd mcp
npm run graph:build
```

By default, the build targets `mcp/src` and writes the artifact to `mcp/src/.dioscuri/graph/graph.json`. To target a different directory, pass it as an argument:

```bash
npm run graph:build -- <target-directory>
```

You rarely build the graph by hand. The `PreCompact` hook rebuilds it automatically when it goes stale (see [What runs automatically](#what-runs-automatically)).

### Run a graph audit

To query the graph or run a structural audit, invoke the `graph-auditor` subagent. It operates in two modes:

- **Mode A (query)** answers reach and blast-radius questions. Every answer includes the call path as evidence.
- **Mode B (audit)** runs the contracts you declare in `.dioscuri/contracts.json` and returns one finding per violation, for you to route to a review gate.

The graph-auditor is read-only. It never writes to your memory, the observations corpus, or the evaluation corpus.

## Read the activity log

The feature writes a signal-only log of what it did. The log records activity; it never changes behavior, and nothing reads it back to influence ranking or weights.

The log is written to:

```
~/.claude-data/.logs/mcp-server.log
```

Each entry carries a timestamp and one of three event types:

| Event type | Records | Use it to see |
|---|---|---|
| `ccr_retrieval` | `found`, `store`, `hash`, `reason` | Whether a retrieval hit or missed, and from which store |
| `graph_staleness` | `verdict`, `rebuilt` | Whether the graph was fresh or rebuilt before a compact |
| `enrich_fire` | `fired`, `unit_count`, `chars`, `token_estimate` | How often enrichment fires and how many tokens it adds |

Use `enrich_fire` to watch the token cost of enrichment over a session. A rising fire count or token estimate tells you enrichment is firing more than you expect.

### Disable the log

To turn off logging, set an environment variable:

```bash
export DIOSCURI_TOIN_LOG_DISABLED=1
```

Set the variable to the string `1`. Disabling the log stops emission with no other effect; the log is append-only and nothing depends on it.

## What runs automatically

Two lifecycle hooks run on their own once the feature is active:

- **Before a context compact**, the `PreCompact` hook checks whether the code graph is stale by comparing the artifact's build commit to your working-tree `HEAD`. If `HEAD` has moved, the hook rebuilds the graph so a stale graph doesn't survive the compact. If the graph is missing or its metadata is corrupt, the hook fails safe and never blocks the compact.
- **At session end**, the `Stop` hook flushes the session's acted-on findings into a buffer for later episodic capture. Every buffered record is marked `promoted:false`, and the buffer lives outside every indexed directory, so a capture can never become a memory observation on its own.

Neither hook writes to your promoted memory or the evaluation corpus.

## Control reference

This table summarizes every operator control, from finest-grained to full removal.

| Control | Scope | How |
|---|---|---|
| Skip compression | One call | `_dioscuri.skipCompress: true` on the tool input |
| Skip enrichment | One call | `_dioscuri.skipEnrich: true` on the tool input |
| Disable compression | Session | `DIOSCURI_SKIP_COMPRESS=1` |
| Disable enrichment | Session | `DIOSCURI_SKIP_ENRICH=1` |
| Disable activity log | Session | `DIOSCURI_TOIN_LOG_DISABLED=1` |
| Disable a hook | Permanent | Remove its entry from `CANONICAL_HOOKS` in `hooks-install.js`, then re-run `update.sh` |

## Turn off the feature

The feature is fully reversible. To turn off a single behavior for a session, use the matching environment variable in the [control reference](#control-reference).

To remove a hook permanently:

1. Remove the hook's entry from `CANONICAL_HOOKS` in `hooks/hooks-install.js`.
2. Re-run `update.sh` (or run `node hooks/hooks-install.js` directly) to re-sync `~/.claude/settings.json`.

Removing the hooks leaves no residue. The graph artifact and the caches are throwaway, the buffer and log are append-only files outside your indexed memory, and no production code or memory state is touched.

## What this feature does not do

- It does not write to your promoted memory or the evaluation corpus. The graph artifact, the retrieval caches, the findings buffer, and the activity log all live outside every indexed directory.
- It does not change retrieval ranking weights. Weight changes remain gated to the monthly promotion process.
- It is not yet certified across both machines. Cross-machine reproducibility (a finding raised on one machine reproducing on the other at the same commit) is tracked separately and depends on a green pilot.

## What's next

Some parts of the upgrade are built but not yet shipped. They are tracked as GitHub issues:

- **Cross-machine reproducibility certification** — [#57](https://github.com/JasonFulksFamilySearch/claude-os/issues/57)
- **Compressed-tool-output episodic capture (default-off, gated)** — [#58](https://github.com/JasonFulksFamilySearch/claude-os/issues/58)
- **Fidelity A/B harness** — [#59](https://github.com/JasonFulksFamilySearch/claude-os/issues/59)

---
🤖 Operator feature guide authored by Walter (AI), grounded in the merged code with verified control-surface names. Written in the Google Developer Documentation Style. Snapshot as of the merged Phase 0–4 build; re-verify control names against the source if the code has since changed.
