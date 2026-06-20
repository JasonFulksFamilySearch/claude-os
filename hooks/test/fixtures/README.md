# Prefix-stability baseline (Dioscuri AC-2 · DIO-1)

## `prefix-baseline.txt`

The **byte-exact** rendered identity/rules prefix — the stable, cache-aligned head
of the system context — with the injection pipeline **OFF** (no injection). This is
the reference the AC-2 prefix-stability test (`hooks/test/cache-aligner-audit.test.js`)
diffs against.

**Contract:** these prefix bytes never move while the pipeline is off. A diff against
this baseline failing means the rendered prefix changed — which, under AC-2, must be
an intentional, reviewed change to an identity/rules template, NOT a per-session
token leaking in. When the change is intentional, regenerate the baseline (below) in
the same PR so the diff documents exactly what moved.

It is rendered with **fixed, machine-independent** test values (not the live
machine's identity), so the artifact is identical on any machine and across runs:

```
USER_NAME    = TestUser
AGENT_NAME   = TestAgent
MACHINE_DESC = test-machine
DEV_ROOT     = /test/dev/root
```

### Regenerate

From the repo root:

```
node scripts/cache-aligner-audit.js --emit-baseline > hooks/test/fixtures/prefix-baseline.txt
```

Deterministic: the same command twice produces byte-identical output. Commit the
regenerated baseline alongside the template change that justified it.

### What it does NOT contain

No per-session-volatile token (ISO timestamp, `Date.now()`, `$(date)` shellout,
sessionId, PID, run/turn counter, epoch seconds, UUID). The four envsubst vars above
are per-machine-stable and ARE present (as their fixed test literals) — they are the
expected variability, not the AC-2 threat. The audit harness scans for the volatile
shapes and excludes those stable vars by rendering them to fixed literals first.
