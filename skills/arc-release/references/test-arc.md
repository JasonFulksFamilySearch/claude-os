# Phase 1 Test Subagent — ARC (arc-record-exchange, React/npm)

Follow `references/test-contract.md` for constraints, the return block, and result semantics.

- **Repo:** `~/dev/Record_Exchange/arc-record-exchange`
- **Commands, in order:** `npm run test:ci`, then `npm run lint`
- **Log:** `_tmp_test_arc.log`
- **gate_failed values:** `tests` (test:ci) | `lint` (eslint)
- **Quirk:** `test:ci` prints a full coverage table even on success — that is expected output,
  not a failure. Only a non-zero exit is a `FAIL`.
