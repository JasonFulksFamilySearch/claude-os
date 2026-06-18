# SITREP Procedures: Standard, Escalation, Handoff

Choose your variant in Step 1b (Standard for steady-state, Escalation for crisis, Handoff for switching owners), then follow the matching procedure below.

---

## **STANDARD PROCEDURE (Steps 2–8)**

Follow these steps for steady-state investigations, progress updates, and normal handoffs.

2. **Understand current state** — skim the fetched ticket and note three things: What is the current status? Who is it assigned to? What changed most recently? This framing prevents you from reporting stale facts and ensures decision-makers see the true picture.

3. **Draft each section in order, importance-first** — report by impact, not by discovery sequence, since decision-makers act on what matters most:
   - **SITUATION:** 2–3 sentences on what's true right now. State the blocker explicitly if one exists, because leaders need to know immediately what's blocking you. No history, no setup — current state only.
   - **ACTIONS TO DATE:** Bullets of verified facts and completed work, because outcomes prove forward motion. Each bullet starts with the `✓` sigil followed by an outcome ("✓ Found X causes Y", "✓ Confirmed Z is resolved", "✓ Ruled out hypothesis A"). Use a table only when comparing counts or before/after tallies, never for a narrative list — tables force clarity and make summaries scannable.
   - **ACTIONS PLANNED:** Bullets of next steps with expected status at the next update, because the reader needs to know what will be resolved/known differently by then. Each bullet starts with the `→` sigil followed by a next step ("→ Implement X", "→ At next update: Y finalized or Z escalated"). Vague continuations ("continue investigating") fail this check and trap both you and the reader in ambiguity. Bullets must be flat — no sub-bullets or nested task lists. One line per planned step; sub-tasks belong in the ticket, not the SITREP.
   - **ISSUES/RISKS/DECISIONS:** All four subsections, always present — this ensures explicit asks never get buried in prose. Issues = current blockers. Risks = known or anticipated problems. Decisions = explicit asks (numbered or bulleted, not buried). Notable = significant achievements or failures. Even if some are "None" or one-liners, write the section. Always include **Next action owner** (optional for Standard, but recommended): who takes the next decision or action?

4. **Enforce every discipline rule** — before you consider the SITREP done, re-read each section against the Standard discipline rules (below), because a discipline violation means the SITREP no longer serves its core purpose. If SITUATION is more than 3 sentences, rewrite it. If ACTIONS TO DATE contains "we investigated", rewrite it to show the outcome. If DECISIONS NEEDED is missing, add it. Rewrite sections that violate the rules; do not skip this step.

   **Standard Discipline Rules:**
   | Rule | Enforcement |
   |------|------------|
   | SITUATION ≤ 3 sentences | Rewrite if longer |
   | ACTIONS TO DATE = outcomes | Every bullet must show a result, not an activity |
   | ACTIONS PLANNED specifies next status | Every bullet must state what will be different |
   | DECISIONS NEEDED always present | Include even if "None at this time" |
   | Importance-ordered, not chronological | Critical fact/next step first in each section |
   | Total SITREP ≤ 1 printed page | Cut detail; move analysis to separate file if needed |

4a. **If you invoked an agent during Steps 2–3** — incorporate the agent's findings into the relevant sections (ACTIONS TO DATE, ISSUES, RISKS, DECISIONS NEEDED, NEXT ACTION OWNER), then **re-run Step 4** (enforce discipline rules) on the updated sections. Do NOT re-invoke the same agent a second time.

5. **Generate filename and title timestamp** — use the pattern `sitrep-{YYYY-MM-DD}-{topic-slug}` where `{topic-slug}` is the ticket key (ARC-4803), issue ID (anthropics/claude-code#5127), or a 2–3 word summary of the topic (e.g., "gss-lock-staleness"), all lowercase and hyphenated. For the document title, run `date '+%H:%M'` to get the current time and insert it into the title as `{YYYY-MM-DD HH:MM}`. The filename uses date only; the title always includes the time.

6. **Create directory** if it doesn't exist — run `mkdir -p ~/Documents/WorkDay/SITREPs/` so subsequent saves don't fail on a missing path.

7. **Save file** — write the SITREP to `~/Documents/WorkDay/SITREPs/sitrep-{YYYY-MM-DD}-{topic-slug}.md` using the Write tool.

8. **Print to conversation** — display the full SITREP so the user can review it immediately, then confirm the saved path and filename.

---

## **ESCALATION PROCEDURE (Steps 2–7)**

Follow these steps for crisis situations: decision deadline < 2h, P1 ticket, or when the title contains urgency markers ("critical", "now", "immediately").

2. **Understand current state** — focus on: What decision is needed? When must it be made? Who has decision authority right now?

3. **Draft sections in crisis order** — prioritize urgency and decision:
   - **[CRITICAL] or [URGENT]** prefix in the title if decision deadline < 2h.
   - **SITUATION** (≤2 sentences, not ≤3): State the time-critical blocker immediately. Example: "15 requests stalled; auto-recovery expires in 12 minutes."
   - **TIMELINE/DEADLINE** (new section, critical): When does the decision authority expire? "Decision window: 12 minutes (until 2026-06-15 14:30)."
   - **DECISION NEEDED** (singular, critical): What is the one most important ask? Example: "Escalate to on-call DPC or accept SLA breach?"
   - **ACTIONS IN PROGRESS** (new section): What is happening right now to move toward decision? Example: "Staging repro, DPC contact list, awaiting your signal."
   - **RISKS** (elevated): What if decision is delayed? What if auto-recovery fails?

4. **Enforce Escalation discipline rules** — re-read sections against Escalation-specific rules:
   
   **Escalation Discipline Rules:**
   | Rule | Enforcement |
   |------|------------|
   | SITUATION ≤ 2 sentences | Shorter for speed; strip context |
   | DECISION NEEDED always present | Single most critical ask, no ambiguity |
   | TIMELINE/DEADLINE explicit | State the exact cutoff time or window |
   | Importance-ordered | Deadline first, then decision, then risks |
   | Total SITREP ≤ 2 printed pages | Can exceed Standard limit due to urgency |
   | No speculation in ACTIONS TO DATE | Facts only; no "probably" or "I think" |

4a. **If you invoked an agent** — incorporate findings, then **re-run Step 4** on updated sections.

5. **Generate filename** — use `sitrep-{YYYY-MM-DD}-{topic-slug}`, add `--URGENT` suffix if deadline < 1h: `sitrep-2026-06-15-arc-4801--URGENT.md`.

6. **Create directory** if it doesn't exist.

7. **Print to conversation immediately** — escalation SITREPs skip the file save and print directly. Do NOT delay for file I/O. (File is saved asynchronously after user sees the SITREP.)

---

## **HANDOFF PROCEDURE (Steps 2–7)**

Follow these steps when switching owners, pausing work, or handing off to another agent.

2. **Understand current state** — focus on: Who is stepping in? What must they know first? What is blocking them?

3. **Draft sections in handoff order** — emphasize ownership and next action:
   - **CURRENT STATE** (≤3 sentences): What is the ticket status right now? How far along is it? Example: "Implementation design is complete; no code committed yet."
   - **NEXT OWNER** (explicit name or role): Who is taking this next? Example: "system-architect" or "Willis".
   - **NEXT IMMEDIATE ACTION** (≤1 bullet): First thing the next owner must do. Example: "→ Review ARC-4843 architecture spike and validate Option B."
   - **CRITICAL CONSTRAINTS** (≤3 bullets): What blocks the next owner? What are the load-bearing rules? Example: "Cannot break DPC's 409 routing"; "GSS lock must be fire-and-forget."
   - **DECISIONS/GATES** (new section): What gate blocks the next owner's progress? Example: "Architecture sign-off is the blocking gate."
   - **CONTEXT FOR NEXT OWNER** (background): Why does this matter? What was tried? What worked? Example: "ARC-4803 is P1. DPC team already reviewed ARC-4843."

4. **Enforce Handoff discipline rules** — re-read sections:
   
   **Handoff Discipline Rules:**
   | Rule | Enforcement |
   |------|------------|
   | NEXT OWNER field required | Explicit name; no ambiguity about who acts next |
   | NEXT IMMEDIATE ACTION ≤ 1 bullet | Crystal clear first step; no sub-tasks |
   | CRITICAL CONSTRAINTS ≤ 3 bullets | Highest-priority rules the next owner must honor |
   | CONTEXT FOR NEXT OWNER present | Why does this matter? What's the bigger picture? |
   | No ≤1 page limit | Can be ≤1.5 pages if context is critical |

4a. **If you invoked an agent** — incorporate findings, then **re-run Step 4** on updated sections.

5. **Generate filename** — use `sitrep-{YYYY-MM-DD}-{topic-slug}--handoff` to signal variant.

6. **Create directory** if it doesn't exist.

7. **Print to conversation** — display the full handoff SITREP and tag it for the next owner: "@system-architect, this is your handoff for ARC-4844. Start with NEXT IMMEDIATE ACTION."
