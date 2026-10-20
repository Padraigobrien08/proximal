# Proximal — finish report

The coding-agent final report that `IMPLEMENTATION_HANDOFF.md` §20 asks for. It covers the work in PRs #3–#17 (2026-10-12 to
2026-10-20), on top of the P0 slice, PACER extension and P1 features already merged in #1 and #2. Every result below is one that
was actually observed; anything not run is listed under "Not verified".

## What changed

| PR | Change |
| --- | --- |
| #3 | `npm run smoke:live`: one real call per provider job, through the app's own services and validators, on a temporary copy of the demo. |
| #4 | Check questions for imported courses. The AI drafts them; the owner reviews them in the app. The answer key is hidden, and opening it limits a question to practice (the learner is also the reviewer). |
| #5 | Background jobs (`jobs` table, in-process worker with leases): check answers are graded after "Answer saved", and question drafting runs in the background. |
| #6 | Long PDFs are drafted in parts of whole pages instead of being rejected over 120,000 characters. |
| #7 | Scanned pages are read from rendered images by the live model, with maths as LaTeX, and labelled for checking. |
| #8 | Each drafted question's marking scheme is graded against its own example answers. `eval:fixtures --repeat N` measures stability. |
| #9 | CI: typecheck, lint, tests and offline browser tests on every PR and on `main`. |
| #10 | PACER: learner-supplied connections, tutor feedback on activity responses, AI-drafted activity material for imported subtopics, `eval:pacer`. |
| #11 | Housekeeping: `repo.ts` and `services/sessions.ts` split into modules (no body changes); cost estimates in `npm run usage`; phone layout fix. |
| #12, #13 | Acceptance tests for AC02, AC05, AC08, AC09 and AC11, and the acceptance tracker (`ACCEPTANCE_TRACKER.md`). |
| #14 | Fix: `demo:reset` left demo chat, approach choices, learner connections and grading jobs. Leftover chat counted as recent help, so a "clean" learner's first check could be recorded as supported. |
| #15 | Fix: course export left out chat, approach choices, connections, activity responses and study runs; course deletion left job rows behind. |
| #16 | Fix: screen-reader maths lost exponent grouping (`p^{1-y}` read as `p^1-y`) and ran words together; "Show plain text" showed raw TeX. Keyboard-only e2e test. |
| #17 | README acceptance demo rewritten to match the current UI, after a rehearsal from a clean demo learner. |

## Checks run and their outcomes

- **`npm run typecheck`, `npm run lint`:** clean.
- **`npm test`:** 215 passed, covering T01–T23 and U01–U20 from the handoff, the new features, and the acceptance checks AC01–AC15.
- **`npm run test:e2e`:** 8/8 passed against a production build, three runs in a row: showcase, import through question drafting and approval, resume and flagging, failed assessment and retry (fault-injection server), Continue, chat, a keyboard-only quick check, and the plain-text view of a maths question.
- **CI on GitHub (Linux, clean `npm ci`):** both jobs green on #9–#17. `main` now requires both jobs to pass, on an up-to-date branch, before a merge.
- **Acceptance checks AC01–AC15** (2026-10-14 to 2026-10-20): each criterion with its test or recorded manual run is in `ACCEPTANCE_TRACKER.md`. They found five bugs, all fixed: the demo reset (#14), course export and deletion (#15), and screen-reader and plain-text maths (#16). They also found a stale demo script (#17). What they could not establish is under "Limitations".
- **`npm run smoke:live -- --yes`:** 11/11 passed on 2026-10-13 against OpenAI (`gpt-5.5-2026-04-23` for assessment and curriculum, `gpt-5.4-mini-2026-03-17` for the tutor). Covered: grading (a correct answer passed, a sign error failed), tutor, chat, PDF import whole and in parts, a scanned page, PACER classification, question drafts and their marking checks, activity material, and activity feedback.
- **`npm run eval:fixtures -- --mode live --repeat 3`** (138 calls): 0 false promotions in 26 definite partial/fail cases in any run; 42/46 exact matches; 45/46 cases stable across all runs. All four mismatches were graded *partial* where the label was *fail* or *uncertain*, which has the same effect on evidence.
- **`npm run eval:pacer -- --mode live --repeat 3`:** 12/12 valid with an acceptable primary type and 11/11 expected activities, after fixing the two failures it found (citing a learning goal; an abstention with a null message).
- **Live import through the production build:** a scanned one-page PDF was transcribed word for word, labelled on the course page and drafted into units.
- **Browser and visual check** (offline copy): the home page at 1440, 1024 and 390 px, and the question and results screens at 390 and 1440 px. One bug found and fixed: on phones the home session card ran 8 px past the screen edge. Also checked by hand: question-draft review (hidden key, approve for checks or practice), activity-material review and approval, and saving a familiar connection. No console errors.

## Not verified

- **The Claude (Anthropic) adapter has never made a live call.** No Anthropic key was configured. It is tested with stubbed SDK clients only. OpenAI is the verified live provider.
- **Live mode through the browser UI end to end.** The live smoke test calls the services directly. The browser flows run in offline mode. The only live UI-path check was the scanned-PDF upload over HTTP.
- **Quality of AI-drafted content.** Questions, activity material and transcriptions pass structural, grounding and marking checks. Nobody has reviewed a sample for quality. The evaluation cases are authored development examples with provisional labels, not a held-out benchmark.
- **Learning gains, hosting readiness and a pilot:** none claimed. The app is single-user and bound to `127.0.0.1`; see README "Security model".

## Left out

- **Deferred by the brief:** authentication and hosting, semantic deduplication, probabilistic mastery, notifications, analytics, dispute resolution and sophisticated history migration.
- **Known gaps from this work:**
  - No variant question after guided practice; fresh families are kept for checks.
  - Activity drafts cannot be edited in place.
  - A subtopic's activities appear only once it has an approved question.
  - Equations in ordinary text PDFs are not rebuilt; only scanned pages are read from images.
  - PDF import still runs within the request rather than as a background job.
- **A hosted pilot** was assessed and deferred (step 8). It needs accounts, a user column on every per-learner table, a teacher role, per-user AI caps, consent and data-protection approval, and hosting.

## Limitations

These come from the acceptance checks run 2026-10-14 to 2026-10-20 (`docs/proximal/ACCEPTANCE_TRACKER.md`). The bugs those checks found
were fixed before this report and aren't listed here: the demo reset, course export and deletion, and plain-text maths.

**Missing features**

- **Prerequisites can't be rejected (AC02).** A drafted curriculum lists suggested prerequisites and extensions as free text. They never
  become required skills, but there's no step to reject or regenerate them, so the check "a rejected prerequisite does not reappear"
  can't be run. Draft units you delete do stay deleted when the same lecture is imported again.
- **Page references use the PDF's page index only (AC01).** Printed page labels aren't read: for example a lecture numbered from 12,
  or roman-numeral front matter. A reference can then differ from the number printed on the slide.

**Evidence weaker than a direct test**

- **Crash recovery is simulated (AC12).** A grading job cut short by a crash is tested by letting its lease expire, not by killing the
  process. Repeated submissions, concurrent retries and out-of-order grading results are tested directly.
- **The fresh-question follow-up relies on a test clock (AC15).** The running server's clock can't be moved forward, so the demo
  rehearsal stops at "No-help check tomorrow". The evidence that a later check picks the different S5-B question, and that passing it
  doesn't count as retention, comes from an integration test with a fixed clock.
- **Keyboard and screen-reader support is checked by tests, not by users (AC14).** Playwright confirms that every control can be
  reached with Tab and shows a visible focus indicator, and that dialogs return focus when closed. A unit test checks the plain-text
  version of every equation in the course content. Nobody has used the app with a screen reader. The plain-text converter covers the
  notation in this course; new notation needs a test case.

**Design choices with visible effects**

- **Reassessment comes before overdue reviews (AC11).** Following the queue rule in `IMPLEMENTATION_HANDOFF.md`, skills that need
  another check after a wrong answer rank above scheduled reviews. With three or more such topics, a long-overdue review drops off
  today's plan until they're cleared. Its level is never lowered while it waits.
- **Single user, local only (AC13).** There are no accounts, and the app runs only on `127.0.0.1`. The demo course and a real
  learner's records share one local database. The demo is marked as such, and `demo:reset` touches only its records. The seeded demo
  contains no participant answers, and the historical replay is computed from a fixture file, not stored.

**Minor known issues**

- On screens narrower than the desktop layout, the chat drawer covers the page but Tab can still move to the page behind it.
- If you leave a finished correction by URL rather than **Return to overview**, the topic page keeps a "Resume your quick check"
  banner, even though the overview's plan treats the session as done.

## How to run the acceptance demo

Offline, with no API key: see README "Quick start" and "Acceptance demo".

```bash
nvm use
npm ci
npm run db:seed
npm run dev
```

Then follow the README's acceptance demo from the overview at http://127.0.0.1:3000. To reset the demo course between runs:
`npm run demo:reset -- --yes`.

Live mode: set `LLM_MODE=openai` with `OPENAI_API_KEY` and `OPENAI_MODEL` in `.env`, run `npm run doctor`, then
`npm run smoke:live -- --yes` (19 paid calls) before relying on it.
