# review-pr — dead-wiring check (Step 3 JS/TS bonus)

Detects runtime wiring the type checker and most unit tests miss — because the unit test populates the event/state directly and bypasses the missing connection, so the feature compiles and tests green while being inert at runtime. Diff-scoped (added lines only), grounded against the PR-head ref `origin/<headRef>` (consistent with Step 6). Stack-generic — applies to any project using an event emitter/bus + a flux-style store.

## A. Event listeners without a producer

1. Collect added (`+`, not `+++`) lines from `git diff <BASE>...HEAD -- "*.{js,jsx,ts,tsx}"`.
2. Extract event names registered as **listeners**. Generic patterns:
   - `addEventListener('<name>'` / `.addEventListener("<name>"`
   - `.on('<name>'` / `.on("<name>"` (event emitters, an event bus, `$events.on`, mitt, EventEmitter)
   - the repo's subscribe hook, e.g. `useEventBus('<name>'` / `useSubscribe('<name>'`
3. For each `<name>`, grep the head ref for a **producer** and confirm at least one match is an emit, not another listener:
   `git grep -n "<name>" origin/<headRef>` → look for `.emit('<name>'`, `dispatchEvent(` referencing it, or `postMessage(` whose payload carries `<name>`.
4. **Zero producers → finding:**
   - **BLOCKING** only when `<name>` starts with `!` — the worker-event convention, a literal prefix match that is fully mechanical. A `!`-prefixed listener with no emitter is an inert worker→UI path (the exact cross-machine-resume / lock-dialog defect class).
   - Any other zero-producer listener → **non-blocking** finding (a UI handler may be wired by a path the grep cannot see; surface it, don't block).

## B. Redux field reads without a writer

1. From the same added lines, extract Redux field reads: `state.<slice>.<field>`, destructures of a `useSelector(select…)` result, and selector return-field access.
2. For each newly-read `<field>`, grep the owning slice for a reducer that **assigns** it: `git grep -n "<field>" <sliceFile>` → confirm an assignment (`state.…<field> =`, or `<field>` appears in an object/spread the reducer writes).
3. **Zero writers → non-blocking finding:** the component reads a field no reducer populates, so it is always `undefined` at runtime (the `lockExpiration`/`isStale` defect class).

## Reporting

Emit findings under the Step 8 "Dead Code & Technical Debt → Dead wiring" line. A BLOCKING `!`-event finding flows through the Step 9 `REVISE`-with-BLOCKING → `REQUEST_CHANGES` mapping. Cite `file:line` for the listener/read, and state which producer/writer was searched for and not found.

## ARC-specific amplification

In `arc-record-exchange`, this check is reinforced by the project rule `.claude/rules/dead-wiring.md`, which also covers the worker feature-flag-name-vs-`getWorkerFeatureFlags()` contract (`feature-flag-worker-bridge.md`). That ARC-specific flag check is intentionally project-scoped and not part of this generic genome check.
