---
description: "War room design review — evaluate a decision BEFORE implementation begins. Stack-aware, topic-aware, five-lens analysis."
---

# Design Review — Pre-Implementation Decision Evaluation

You are conducting a design review. The goal is to stress-test a proposed decision **before any code is written**. Be direct, specific, and opinionated. Generic advice wastes everyone's time.

## Step 1 — Detect the Stack

Inspect the repo root silently and determine the technology stack:

| Signal | Stack |
|---|---|
| `pom.xml` / `build.gradle` | Java / Spring Boot |
| `package.json` | Node / React / JavaScript |
| `*.sh` / `Makefile` / no manifest | Shell / scripting |
| Multiple manifests | Note each layer separately |

Scan the top-level directory structure to understand project shape. If a `CLAUDE.md` exists at the repo root, read it — it is authoritative project context.

**Do not ask the user for stack info.** Infer it and state what was detected at the top of your analysis.

## Step 2 — Check for docs/topics/

If a `docs/topics/` directory exists:
1. Scan the folder names
2. Match any topics relevant to the decision being evaluated
3. Read and incorporate those topics (README.md, CONSTRAINTS.md, DESIGN.md) into the analysis
4. List which topics were consulted in the output header

If no `docs/topics/` directory exists, state "No topic docs found" and proceed.

## Step 3 — Apply Stack-Aware Lenses

Evaluate the decision through **five lenses**, sharpened to the detected stack. Every point must be specific to the technology, patterns, and failure modes of this project. Do not give generic advice.

### Architecture
Fit within existing structure, coupling, scale, simpler alternatives.
- **Spring Boot:** layer boundaries, bean lifecycle, module coupling, transaction scope
- **React:** component hierarchy, state ownership, prop drilling vs context, rendering boundaries
- **Scripts:** environment state dependencies, idempotency, execution order assumptions

### Security
New attack surface, trust assumptions, data exposure.
- **Spring Boot:** Spring Security config, input validation, SQL injection, secrets in config, endpoint exposure
- **React:** XSS vectors, auth token handling, third-party script risk, sensitive data in client state
- **Scripts:** injection via env vars or args, file permission assumptions, credential handling

### Scope
Requirement completeness, edge cases, deferred risk.
- What's ambiguous or unstated?
- What edge cases does the approach not handle?
- What dependencies or preconditions are assumed but unverified?
- What's deferred, and is that deferral safe?

### Implementation
Realistic complexity, reversibility, rollback.
- **Spring Boot:** ORM edge cases, transaction rollback, migration strategy, bean wiring complexity
- **React:** re-render cost, effect dependencies, async state races, bundle size impact
- **Scripts:** portability, error handling, partial failure recovery

### Design
Clarity, maintainability, future cost.
- Is the interface intuitive for its consumers?
- What's the cognitive load on the next developer?
- What makes this hard to maintain in 6 months?
- Are naming, contracts, and boundaries clear?

## Step 4 — Synthesize

End with a structured summary using exactly this format:

```
Detected stack: [what was found]
Topics consulted: [list or "none found"]

Recommended path: [one clear direction with rationale]

Key tradeoffs: [what is accepted by going this route]

Top 3 risks:
1. [risk] — [mitigation]
2. [risk] — [mitigation]
3. [risk] — [mitigation]

One thing that kills this: [the single most likely failure mode if due diligence is skipped]

Confidence: [Low / Medium / High] — [what would move it higher]
```

---

## Input

$ARGUMENTS
