# Proximal — acceptance tracker

Integrity table for the finish report. One row per acceptance criterion; evidence is a test name (file › test) or a recorded manual run.

**Status key:** ✅ Pass (automated) · 🟡 Partial · 📝 Manual — pending · ⛔ Gap (missing feature → report limitations) · 🐞 Bug (fix before pilot)

Last automated run: 2026-10-14 — `npm test` 205/205 passed, `npm run typecheck` clean. `npm run test:e2e` 6/6 passed.

## High risk

| ID | Criterion | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| AC05 | Hint, source or in-session explanation before a check → supported/practice, never Checked, no stage advance | ✅ | `tests/integration/sessions.test.ts` › "AC05: a full explanation (no hint) before a check…", "AC05: an opened source before a check…", "AC05: an explanation earlier in the session carries exposure to a later question…", "T02: hint before answer…", "T23: a direct source request…" | Exposure is snapshotted per attempt (`exposureSnapshot`), so a later question carries it without a hint. Mutation-checked: disabling the exposure rule fails all AC05 tests. |
| AC07 | Flagged assessment contributes nothing; promotions it caused are undone; uncertain never promotes/demotes | ✅ | `tests/unit/evidence.test.ts` › "T12: uncertain/excluded judgements make no update; exclusion after promotion rebuilds"; `tests/integration/sessions.test.ts` › "T19: flagging an assessment excludes it…"; `tests/integration/home.test.ts` › "U12: flagging an accepted pass…"; `tests/unit/assessment.test.ts` › "unresolved essential criterion -> uncertain", "T19: invalid quote… cannot create a pass" | State is rebuilt by full replay, so dependent promotions are recomputed rather than patched. |
| AC08 | Same-day / <24h passes: no retention, no repeated due extension, one advance per skill per session | ✅ | `tests/unit/evidence.test.ts` › "AC08: three distinct-family passes in separate sessions on one day…", "T06: two passes 23h59m apart…", "T09: additional same-session pass…", "T21: Europe/London spring-forward…" | Uses injectable `fixedClock` / explicit timestamps. |
| AC10 | Only a ≥24h distinct-family pair including transfer (new-context) coverage reaches the top state | ✅ | `tests/unit/evidence.test.ts` › "T07: distinct-family passes exactly 24h apart… only with transfer", "T08: repeated-family passes cannot satisfy the distinct-family gate", "AC08: …" (second case); `tests/unit/levels.test.ts` › "maps each evidence state to one level, in order", "rolls up as counts per level, never an average" | Checked = `demonstrated_once` (one qualifying pass); Secure = `retention_demonstrated` (two-pass gate). Computed per skill, never from a topic average. |
| AC09 | Application failure starts a new epoch for that skill only; earlier passes stay in history | ✅ | `tests/integration/sessions.test.ts` › "AC09: failing an application question on a passed skill…"; `tests/unit/evidence.test.ts` › "T10: independent partial/fail starts a new epoch…", "T11: supported failure cannot erase…" | Unrelated skill (S4) state is deep-equal before and after. |
| AC12 | Refresh/retry/resume mid-grading and crash-restart → one attempt, one schedule update, answer preserved | 🟡 | `tests/integration/sessions.test.ts` › "T13: duplicate same-key submission finalises once…", "T13/T22: provider timeout keeps the attempt pending; concurrent retries finalise exactly once", "T14: out-of-order provider completions…"; `tests/integration/jobs.test.ts` › "reclaims a job whose lease expired (crashed run)…"; `tests/e2e/03-resume-flag.spec.ts`, `tests/e2e/04-pending-retry.spec.ts` | Crash is simulated by lease expiry, not a real process kill. Either record a manual kill-and-restart run or state the simulation in the report. |

## Medium risk

| ID | Criterion | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| AC02 | Assessed study blocked until approval; a rejected prerequisite does not reappear | 🟡 / ⛔ | `tests/integration/imports.test.ts` › "valid sample yields a fixture draft… explicit approval…", "AC02: a unit removed from the draft stays removed when the same lecture is imported again…"; `tests/e2e/02-import.spec.ts` | **Gap:** prerequisites exist only as free-text course `suggestions`, never as mandatory skills; there is no reject or regenerate flow. Report as a limitation. The nearest behaviour (deleted draft units stay deleted on re-import) is tested. |
| AC03 | Question payload carries no reference answer, rubric or examples before the permitted reveal | ✅ | `tests/integration/sessions.test.ts` › "T15: session payloads contain no reference answers, hints, rubric or unreleased feedback"; `tests/integration/home.test.ts` › "U14: initial home/topic/session payloads carry no reference answers…" | Optional: screenshot of the network tab for the report. |
| AC04 | Hint/source/solution exposure written before content is returned | ✅ | `tests/integration/sessions.test.ts` › "T03: source/solution reveal is committed before content is returned", "declared external assistance records an exposure before submission…" | |
| AC06 | A perfect definition answer leaves derivation/application unassessed | ✅ | `tests/integration/sessions.test.ts` › "records explanation and application capability separately…" (T05 assertions) | |
| AC11 | Plan grouped by topic, ≤3 blocks, each with a reason; long-overdue topic still surfaces | ✅ | `tests/unit/plan.test.ts` › "AC11: due skills group by topic into at most three blocks with reasons; a long-overdue topic surfaces first", "AC11: per spec, reassessment outranks a long-overdue review; the overdue topic returns once those are done", "U09: due review beats new learning…" | Due reviews are ordered oldest-due first, so a 60-day-overdue topic leads the plan. Per the queue rule (IMPLEMENTATION_HANDOFF.md, "Queue: due skills with reassessment_needed first…"), three or more reassessment topics can hold an overdue review off today's plan; it returns once they are cleared and its evidence is never lowered. Disclose as a design choice. |

## Lower risk

| ID | Criterion | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| AC01 | Text, scanned and corrupt/oversized imports; valid page refs; failures name pages | ✅ | `tests/integration/imports.test.ts` › "valid sample… correct page refs", "empty/scanned, corrupt, non-PDF, encrypted-like and oversized files produce actionable errors"; `tests/integration/scanned-import.test.ts` (all) | Check the printed-label vs PDF-index case is covered by a fixture; if not, note it. |
| AC13 | Seeded demo data contains no participant answers; single-user/local | 📝 | — | Run `npm run demo:reset` and confirm no attempts rows. State "single-user, local only" in the report. |
| AC14 | Export valid JSON; delete leaves no dependents; keyboard-only navigation; math plain-text equivalent | 📝 | Scripts: `npm run data:export`, `npm run data:delete-course` | Manual: keyboard-only session run, screen-reader/plain-text check on KaTeX output. |
| AC15 | Section 23 demo from a clean seeded learner | 📝 | `tests/e2e/01-showcase.spec.ts`, `tests/e2e/05-continue.spec.ts` | Rehearse by hand and confirm any replay is visibly labelled. |

## Bugs and gaps found

| ID | Type | Description | Action |
| --- | --- | --- | --- |
| AC02 | ⛔ Missing feature | No prerequisite reject/regenerate flow; prerequisites are non-binding text suggestions. | Limitations section. |
| AC12 | 🟡 Evidence gap | Crash recovery tested by simulated lease expiry, not a real process kill. | Record a manual run or disclose. |
