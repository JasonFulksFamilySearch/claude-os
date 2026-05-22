---
name: review-pr
allowed-tools: Read, Grep, Glob, Bash, Agent
description: Comprehensive stack-aware PR review. Detects project stack (JS/TS, Java/Maven, Java/Gradle, Python, Go), dispatches stack-appropriate dead-code / pattern / test checks, and produces a consistent report with PR-type classification, large-PR detection, and a 0–10 quantitative risk score. Use when reviewing PRs or before submitting your own PR.
---

You are performing a comprehensive PR review.

Architecture: **agnostic preamble → stack detection → per-stack dispatch → agnostic epilogue**. Steps 0–2 and Steps 6–7 always run regardless of language. Step 3 dispatches to a stack-specific check module. Steps 4–5 use stack-aware pattern hints.

Run checks in parallel wherever possible (multiple tool calls in one message). All file searches use the Grep / Read / Glob tools — never `find`, `grep`, `cat`, `head`, `tail`, or `sed` shells.

---

## Step 0 — Stack Detection (always runs)

Use Glob in parallel against the worktree root to find marker files. Set a `STACKS` set based on what's present. Multiple stacks may be detected in a single repo (e.g., a Java backend with a JS admin UI) — dispatch each detected stack's check module in Step 3.

| Marker (via Glob from repo root) | Stack tag | Notes |
|---|---|---|
| `package.json` | `js` | If `dependencies.react` / `dependencies.next` / `dependencies.vue` present, also tag the framework |
| `tsconfig.json` + `package.json` | `ts` | Extend JS globs to `*.{js,jsx,ts,tsx}` |
| `pom.xml` | `java-maven` | ARC backend pattern |
| `build.gradle` or `build.gradle.kts` | `java-gradle` | |
| `pyproject.toml` / `setup.py` / `requirements.txt` | `python` | |
| `go.mod` | `go` | |

If no marker is detected, fall back to `js` and note `"Stack: unknown — defaulted to js"` in the report header.

**Also detect the base branch** so we stop hardcoding `master`:

```bash
git symbolic-ref --quiet --short refs/remotes/origin/HEAD | sed 's@^origin/@@' || echo main
```

Use the resulting branch name as `<BASE>` everywhere this skill previously wrote `master`.

---

## Step 1 — PR Summary & Type Classification (agnostic preamble)

**If a PR number was provided**, run in parallel from any worktree:

```bash
gh pr view <PR_NUMBER> --json title,body,files,additions,deletions,headRefName
gh pr diff <PR_NUMBER>
```

**Otherwise** (self-review on the current branch), run in parallel:

```bash
git diff --name-only <BASE>...HEAD
git log <BASE>..HEAD --oneline
git diff --stat <BASE>...HEAD
git rev-parse --abbrev-ref HEAD
```

**Classify the PR type** from the current branch prefix (`git rev-parse --abbrev-ref HEAD`):

| Prefix | Type |
|---|---|
| `feat/` | feature |
| `fix/` | bugfix |
| `chore/` | refactor / maintenance |
| anything else | uncategorized |

Briefly summarize:

- Purpose of the PR (one sentence)
- Number of files changed
- PR type (from the table above)
- Stacks detected (from Step 0)
- Base branch (from Step 0)

The PR-type tag is used downstream: a `feat/` PR with zero new tests is a stronger warning signal than a `chore/` PR with zero new tests.

**Commit-subject hygiene check** (always runs, agnostic): scan `git log <BASE>..HEAD --pretty=%s` for subjects matching `ARC-\d+` and flag them. Per `~/.claude/rules/commits.md` Rule 7, ticket numbers belong in commit *bodies*, not subjects.

---

## Step 2 — Large-PR Gate (agnostic, borrowed)

Threshold: **>20 files changed OR >1000 net LOC**. Compute from `git diff --shortstat <BASE>...HEAD`.

**If exceeded:**

1. Group changed files by top-level directory (the segment before the first `/`).
2. For each group with ≥5 files, emit a split suggestion.
3. Output the split using the ARC-team worktree workflow (not `git checkout -b`):

   ```bash
   # Example split (replace <ticket> and <group> with real values)
   cd ~/dev/<repo>
   git worktree add ../worktrees/feat/<ticket>-<group> -b feat/<ticket>-<group>
   cd ../worktrees/feat/<ticket>-<group>
   git cherry-pick <commit-hashes-for-this-group>
   ```

**If not exceeded**, output a single line: `✅ PR size within reviewable bounds (<X> files, <Y> net LOC).`

---

## Step 3 — Stack-Dispatched Checks

For each stack in `STACKS`, run the corresponding module. All modules expose the same six check slots so the report shape is consistent. Run all checks within a module **in parallel** (multiple tool calls in one message).

### Slot summary

| Slot | JS / TS | Java (Maven or Gradle) | Python |
|---|---|---|---|
| 1. Tombstone comments | Grep `pattern: "removed\|no longer\|v2 compatibility.*removed\|V3-only:.*removed\|was v2\|used to be"`, `path: "src/"`, `glob: "*.{js,jsx,ts,tsx}"`, filter to lines containing `//` | Same pattern, `path: "src/main/java/"`, `glob: "*.java"`, filter to lines containing `//` | Same pattern, `path: "."`, `glob: "*.py"`, exclude `tests/` and `test_*.py`, filter to lines containing `#` |
| 2. Deleted test, live source | Parse `git diff --name-status <BASE>...HEAD` for `D` rows ending in `.test.{js,jsx,ts,tsx}`; for each, derive the source path by stripping `.test`, then Read to confirm source still exists | Same parse for `D` rows ending in `Test.java`; map `src/test/java/foo/BarTest.java` → `src/main/java/foo/Bar.java`; Read to confirm | Same parse for `D` rows matching `test_*.py` or `*_test.py`; map to the corresponding source file; Read to confirm |
| 3. New files without imports | Run `git diff --name-only --diff-filter=A <BASE>...HEAD`, filter to `.{js,jsx,ts,tsx}` under `src/` excluding tests; for each, Grep `pattern: "from.*<basename>\|require.*<basename>"`, `path: "src/"`, `output_mode: "count"`; report count == 0 | Same diff filter for `.java` under `src/main/java/`; for each, Grep `pattern: "import .*<classname>"`, `output_mode: "count"`; report count == 0 **unless** the file is annotated with `@Component`, `@Service`, `@RestController`, `@Repository`, `@Configuration` (Spring auto-discovery) | Same diff filter for `.py` outside tests; for each, Grep `pattern: "from .*<modname>\|import <modname>"`, `output_mode: "count"`; report count == 0 unless the file has `if __name__ == "__main__":` (CLI entry) |
| 4. Jira refs in code | Grep `pattern: "ARC-[0-9]\|ARCPORT\|TODO:.*ARC-"`, `path: "src/"`, `glob: "*.{js,jsx,ts,tsx}"`, `-n: true` | Same pattern, `path: "src/main/java/"`, `glob: "*.java"` | Same pattern, `path: "."`, `glob: "*.py"`, exclude `tests/` |
| 5. Bad error idiom | Grep `pattern: "throw new Error"`, `path: "src/"`, `glob: "*.{js,jsx,ts,tsx}"`, exclude `.test.*` and `node_modules` | Two greps: (a) `pattern: "throw new RuntimeException"`, `path: "src/main/java/"`; (b) `pattern: "System\\.out\\.println"`, `path: "src/main/java/"` — should use `Logger` instead | Two greps: (a) `pattern: "raise Exception(?!\\w)"`, `path: "."`, `glob: "*.py"`, exclude `tests/`; (b) `pattern: "^\\s*print\\("`, exclude files containing `if __name__ ==` |
| 6. Global suppressions | Read `src/setupTests.js`; search for `console.error\s*=`, `console.warn\s*=`, `originalError`, `originalConsole` | Grep `pattern: "@SuppressWarnings\\(\"all\"\\)"`, `path: "src/main/java/"`, `glob: "*.java"` | Grep `pattern: "warnings\\.filterwarnings\\([\"']ignore"`, `path: "."`, `glob: "*.py"`, restrict to module-scope (first ~40 lines of the file) |

Report up to 20 matches per slot. Be specific about file:line.

### Stack-specific bonus checks

Run **in addition** to the six slots above.

- **JS / TS bonus — `dev.flags` cross-package imports.** Grep `pattern: "from.*dev\\.flags\|require.*dev\\.flags"`, `glob: "*.{js,jsx,ts,tsx}"`, once each against `path: "src/plugins/"`, `path: "src/webworkers/"`, `path: "src/components/"`. ARC frontend keeps `dev.flags` scoped — cross-package imports are a smell.
- **Java bonus — `@SneakyThrows` audit.** Grep `pattern: "@SneakyThrows"`, `path: "src/main/java/"`, `glob: "*.java"`. Lombok's `@SneakyThrows` hides checked exceptions from the type system; flag every occurrence outside any package explicitly named `experimental` or `prototype`.
- **Python bonus — `# type: ignore` delta.** Parse `git diff <BASE>...HEAD -- "*.py"` for added lines containing `# type: ignore`. Each new ignore should be justified in a comment.

---

## Step 4 — Pattern Consistency Analysis

For each significant new function or pattern in the diff, search for existing implementations so we don't re-invent. The example below switches by stack:

- **JS / TS:** Grep `pattern: "function validate\|const validate\s*="`, `path: "src/"`, `glob: "*.{js,jsx,ts,tsx}"`
- **Java:** Grep `pattern: "(public\|private\|protected).*validate\\w*\\("`, `path: "src/main/java/"`, `glob: "*.java"`
- **Python:** Grep `pattern: "def validate_"`, `path: "."`, `glob: "*.py"`

Check:

- Does similar functionality already exist?
- Are we following established patterns in this repo?
- Is file organization consistent with the existing layout?

---

## Step 5 — Test Quality Review

For modified test files, verify the four universal qualities. Pattern hints below switch by stack.

1. **Coverage completeness** — happy path, sad path (null / undefined / wrong types), edge cases, error propagation.
2. **Test clarity** — descriptive names (no ticket numbers per `~/.claude/rules/commits.md`), clear setup, tests assert behavior not just mock calls.
3. **Unused mocks** — verify mocks match current imports; flag module-level mocks that should be scoped.
4. **Suppression scoping** — `console.error` overrides (JS), `@SuppressWarnings` (Java), `warnings.filterwarnings` (Python) should be scoped to one test, not module-level.

Stack-specific mock pattern hints:

| Stack | Mock pattern |
|---|---|
| JS / TS | `vi.mock(`, `jest.mock(`, `jest.spyOn(` |
| Java | `@MockBean`, `@Mock`, `Mockito.when(`, `when(...).thenReturn(` |
| Python | `monkeypatch.setattr(`, `mocker.patch(`, `unittest.mock.patch(` |

---

## Step 6 — Risk Score (agnostic epilogue, borrowed)

Compute a 0–10 weighted risk score. Each factor scores 0–10; final = weighted mean rounded to one decimal.

| Factor | Weight | Inputs |
|---|---|---|
| Size | 0.25 | (net LOC ÷ 1000) × 5 + (files changed ÷ 20) × 5, capped at 10 |
| Test delta | 0.25 | Score 0 if (new test files − deleted test files) ≥ 0 and Step 3 Slot 2 is empty. Score 10 if tests were deleted while their source lives, or if PR type is `feat/` and zero new test files. Scale linearly otherwise. |
| Surface area | 0.20 | (distinct top-level directories touched) × 2, capped at 10 |
| Dependency churn | 0.15 | 0 if no lockfile / dependency-manifest changes; 5 if one manifest changed; 10 if multiple manifests OR lockfile + manifest changed |
| Security touchpoints | 0.15 | Count of changed files whose path matches `auth\|secret\|token\|crypto\|password\|credential` — 0 → 0, 1 → 5, ≥ 2 → 10 |

Map the weighted mean to a qualitative label:

- < 3.0 → 🟢 **Low**
- 3.0 – 5.9 → 🟡 **Medium**
- 6.0 – 7.9 → 🟠 **High**
- ≥ 8.0 → 🔴 **Critical**

Output both the numeric score and the label in the report overview.

---

## Step 7 — Generate Review Report

```markdown
# PR Review Results

## 📊 Overview
- Stacks detected: <STACKS>
- Base branch: <BASE>
- PR type: <feature|bugfix|refactor|uncategorized>
- Files changed: X
- Net LOC: +A / −D
- Purpose: <one-line summary>
- Risk: <label> (<score>/10)

## ✅ Passes

- <list what looks good — empty automation slots count as passes; mention them>

## ⚠️ Issues Found

### Large PR
<only present if Step 2 gate tripped — include split suggestions>

### Dead Code & Technical Debt
- Tombstone comments: <slot 1 results>
- Test coverage regressions: <slot 2 results>
- Orphaned new files: <slot 3 results>
- Global suppressions: <slot 6 results>

### Pattern Consistency
- <Step 4 findings>

### Documentation & Convention Compliance
- Jira refs in code: <slot 4 results>
- Commit subjects with ticket numbers: <Step 1 commit-subject hygiene results>
- Stack-specific bonus: <JS dev.flags / Java @SneakyThrows / Python type:ignore>

### Bad Error Idioms
- <slot 5 results>

### Test Quality
- <Step 5 findings>

## 🎯 Recommendations

<prioritized list of what should be fixed before merge>

## 📝 Notes

<any other observations or questions>
```

---

## Critical Questions to Answer

Before approving, explicitly answer:

1. ✅ Would I be comfortable maintaining this code in 6 months?
2. ✅ Does it follow ALL project conventions for the detected stack(s)?
3. ✅ Are we deleting tests for code that still exists?
4. ✅ Are all new files / classes / modules actually used (or wired through framework auto-discovery)?
5. ✅ Do comments explain current code, not removed code?
6. ✅ Are suppressions scoped, not global?
7. ✅ Does the risk score match my gut read of the change? If not, which factor is wrong?

---

## Usage Notes

- Run all checks within each step **in parallel** (multiple tool calls per message) for speed.
- Focus on high-impact issues first: test regressions, deleted-test-with-live-source, large-PR splits.
- Be specific about line numbers and file paths.
- Suggest concrete fixes, not just "consider refactoring."
- If automated checks find nothing, that's good — report it explicitly under "Passes."
- For multi-stack repos, label each Step 3 section with its stack tag (e.g., `### Dead Code & Technical Debt — java-maven`).

## When to Use

- Before creating a PR (self-review)
- When reviewing someone else's PR
- After addressing PR feedback (verify all fixed)
- For large PRs, run this twice: once before requesting review, once before merging
