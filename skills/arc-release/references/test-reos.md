# Phase 1 Test Subagent — REOS (arc-record-exchange-orch-service, Java/Maven)

Follow `references/test-contract.md` for constraints, the return block, and result semantics.

- **Repo:** `~/dev/OrchestrationService/arc-record-exchange-orch-service`
- **Commands, in order:** `mvn clean test`, then `mvn checkstyle:check`
- **Log:** `_tmp_test_reos.log`
- **gate_failed values:** `tests` (surefire) | `checkstyle`
- **Quirk:** 14-module reactor — output is large. Report the first failing module's failures
  in the verdict block; the full set is in the log.
