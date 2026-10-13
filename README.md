# Proximal (local MVP)

Proximal is a local-first study app. You study topics, and it records separate evidence for each **skill** in a topic. It tells
"completed with support" apart from "demonstrated independently", holds back checkpoint feedback until every answer is saved, and
schedules fresh review questions.

The current scope is the P0 slice of [`docs/proximal/IMPLEMENTATION_HANDOFF.md`](docs/proximal/IMPLEMENTATION_HANDOFF.md) (which supersedes the
original build brief), plus the P1 features that were already working. It is a **single-user app bound to `127.0.0.1`**. There is no authentication, no
hosting story and no multi-user isolation. It is not ready for multi-user deployment; a hosted pilot would be a separate change
(authentication, ownership checks, durable storage).

## Quick start (no API key needed)

```bash
nvm use            # Node 24 (see .nvmrc)
npm ci
npm run db:seed    # migrates, creates the demo course and the authored sample lecture
npm run dev        # http://127.0.0.1:3000
```

### Acceptance demo (offline mode)

1. **Overview** (`/`) shows the real starting action (“Start Model and likelihood”), a session plan for the selected 10/20/30-minute
   budget, and the course card with real counts (“0 of 6 required skills checked independently”).
2. Open **AI classification demo → Binary cross-entropy** and choose **Check understanding** (an independent check, with no
   explanation first).
3. Question 1 (S4-A, explanation): click **Demo example: correct** and **Submit answer**. You only see “Answer saved.”
4. Question 2 (S5-A, calculation): click **Demo example: wrong** (`BCE = ln(0.8) ≈ −0.22314.`, a sign error) and submit.
5. The results lead with “You explained Binary cross-entropy independently. The calculation needs practice.” Each skill is shown
   separately. Click **Show criterion feedback**.
6. Click **Practise calculation**, then **Get help → Show a general cue**. Fill **Demo example: correct** and **Submit correction**.
   The correction is saved as a new attempt and recorded as supported; the original wrong answer stays. The summary becomes
   “… Calculation completed with support. A fresh independent check is scheduled.”
7. **Return to overview**. **Recent evidence** shows Explain BCE as **Demonstrated independently** and Calculate BCE as
   **Completed with support**. **Upcoming check** shows Binary cross-entropy “tomorrow at …” (24 elapsed hours after the
   calculation gap). The course card shows “1 of 6”. Refresh or restart the server and the state is unchanged.
8. On the topic page, **Derive BCE** stays **Not checked yet**. The evidence history interleaves the original answers, the hint and
   the supported correction; each answer expands to its text, released criterion feedback, provider label and **Flag judgement**.
9. A later real check after 24 hours selects the fresh S5-B comparison task. A pass there is **Demonstrated independently**, not
   retention. **Open historical example (seeded)** shows prepared example dates and is labelled “Seeded example — not participant
   data”; it is computed from a fixture, not stored as learner records.

The “demo example” buttons appear **only in offline mode**. They are labelled as examples, not your own work.

## Commands

| Command | Behaviour |
| --- | --- |
| `npm run dev` | `next dev` on 127.0.0.1:3000. The DB is migrated automatically on first access. Run `db:seed` once for the demo. |
| `npm run build` / `npm run start` | Production build / server on 127.0.0.1:3000. |
| `npm run lint` | ESLint (Next.js core-web-vitals + TypeScript rules). |
| `npm run typecheck` | `tsc --noEmit` in strict mode. |
| `npm test` | Vitest unit and integration tests (`tests/unit`, `tests/integration`). Uses temporary SQLite DBs and an injected clock. |
| `npm run test:e2e` | Playwright, key-free. Re-seeds `.e2e-data/`, runs `next build` and serves on 127.0.0.1:3100 in offline mode. It also starts a second server on :3101 with its own `.e2e-data-fault/`, where the first offline assessment fails (test fault injection). Four flows run: showcase, sample import, resume + flag, failed assessment + retry. Run `npx playwright install chromium` once first. Stop any other `next build` first. |
| `npm run db:migrate` | Applies pending `src/lib/db/migrations/*.sql` to `$PROXIMAL_DATA_DIR/proximal.db`, taking a backup first when the database already has data. The server also migrates on start, after a synchronous safety copy. Idempotent. |
| `npm run db:seed` | Migrates and regenerates `fixtures/sample-lecture.pdf` from `fixtures/lecture.json` (byte-deterministic; rewritten only when the bytes change). It inserts any missing demo content and updates the demo source text and checked explanations. An `authored_fixture` question is updated only when its fixture `version` increases; owner-reviewed and excluded questions are never changed, and sessions keep the frozen copy they used. Idempotent. It never touches learner records or imported uploads. |
| `npm run demo:reset -- --yes` | Deletes sessions, attempts, exposures, assessments and review states **for the demo course only**, then re-seeds. Refuses to run without `--yes`, or if `demo-course` is not marked as a demo. Imported courses and uploads are never touched. |
| `npm run eval:fixtures` | Evaluation harness (see below). Default `--mode mock`; `--mode live --yes` uses the configured provider. |
| `npm run content:review -- --list` / `-- --question S5-A --status owner_reviewed --by "Name"` | Lists question review status, or records that a named person reviewed a question. |
| `npm run questions:import -- --file bank.json [--course <id>]` | Attaches an owner-authored question bank (same schema as `fixtures/questions.json`) to existing skills. Inserted as `authored_fixture`. |
| `npm run data:export -- --course <id> [--out f.json] [--include-reference-answers]` | JSON export. Never includes env vars or keys. Reference answers are omitted unless the flag is given. |
| `npm run data:delete-course -- --course <id> --confirm <id>` | Deletes a course, its learner records and its uploaded files. |
| `npm run doctor [-- --offline]` | Health check: Node version, provider configuration per job, where the API key comes from (never the key), model access via free metadata lookups, limits, database integrity and schema, backups, and whether the running server matches `.env`. Exits non-zero on a problem. |
| `npm run smoke:live -- --yes [--only assess,tutor,chat,curriculum,parts,pacer,questions]` | One real call per provider job (10 paid calls in total) through the app's services and validators, on a temporary copy of the demo. Learner data is never touched. Prints PASS/FAIL per job and exits non-zero on any failure. Refuses to run without `--yes`. |
| `npm run usage [-- --days 7]` | Summary of live provider calls by day, job and model: calls, errors, blocked calls, input/output tokens and average latency, plus rolling 24 h usage against the caps. |
| `npm run db:backup [-- --label x] [-- --keep 10]` | Consistent online backup (SQLite backup API, safe while the server runs) of the database and uploaded PDFs into `data/backups/<timestamp>/`, keeping the newest 10. |

All scripts are local developer utilities, not browser endpoints. They load `.env` if it exists; variables already set in the
environment take precedence.

## Configuration

Copy `.env.example` to `.env` (gitignored) and choose a provider:

```dotenv
LLM_MODE=openai              # mock | openai | anthropic ("live" = anthropic)
OPENAI_API_KEY=sk-...        # openai only; server-side only
OPENAI_MODEL=                # openai only; required, never defaulted
ANTHROPIC_API_KEY=           # anthropic only
ANTHROPIC_MODEL=             # anthropic only; required, never defaulted
PROXIMAL_DATA_DIR=./data     # SQLite DB + uploads (gitignored, outside public/)
PROXIMAL_TIMEZONE=Europe/London
```

Restart the server after editing `.env`. Keys are read only on the server and never sent to the browser.

**`.env` wins for provider settings.** Next.js normally lets a variable already exported in your shell override `.env`, which
can silently pick up a stale `OPENAI_API_KEY`. Proximal reads `.env` itself for `LLM_MODE`, `OPENAI_*`, `ANTHROPIC_*` and the
usage limits, so `.env` is authoritative for them. The provider Details panel and `npm run doctor` say where the key came from,
and warn when a different shell key is being ignored. `PROXIMAL_ENV_FILE=<path>` reads a different file;
`PROXIMAL_ENV_FILE=none` ignores it entirely. The Playwright servers use `none` so a developer's live settings can never be
picked up by the key-free browser tests.

#### One model per job

There are three model jobs, and each can use a different model:

| Job | Override | Runs | Limits |
| --- | --- | --- | --- |
| Assessment: grading answers against frozen rubrics | `OPENAI_MODEL_ASSESS` | Every submitted answer | 60 s, 8,000 output tokens |
| Curriculum: drafting topics and objectives from a PDF | `OPENAI_MODEL_CURRICULUM` | Once per import | 180 s, 16,000 output tokens |
| Tutor: short source-grounded gap explanations | `OPENAI_MODEL_TUTOR` | On request during practice | 30 s, 4,000 output tokens |

`OPENAI_MODEL` is the default for any job without an override. Every job must resolve to a model, and none is ever chosen
for you. Optional `OPENAI_EFFORT_<JOB>` sets reasoning effort for that job only; it is not sent unless set, because some models
reject it. The `ANTHROPIC_*` variables follow the same pattern. The provider Details panel lists the model used for each job,
and every assessment records the exact model that graded it (`vendor:model`). To compare grading models, run
`npm run eval:fixtures -- --mode live --yes` once per candidate `OPENAI_MODEL_ASSESS`.

### Provider modes

The current mode is shown on every screen (“Offline demo”, “OpenAI assessment” or “Claude assessment”, with the model under
Details).

- **mock (default)**: strictly fixture-based. An answer is assessed only if it exactly matches (after normalisation) one of the
  authored example answers for that question ID. Any other answer gets *uncertain* with "Offline demo can assess the supplied example
  answers only.", which has no effect on evidence. Curriculum generation recognises only the generated sample lecture, by its exact
  SHA-256. Any other PDF still has its text extracted and offers manual objective entry ("Offline mode cannot generate a curriculum
  for this file."). There is no tutor in mock mode; only the checked fixture explanations are shown. None of this is AI grading.
- **openai** (`src/lib/llm/openai.ts`) and **anthropic** (`src/lib/llm/claude.ts`) implement the same provider interface with the
  same prompts and output schemas:
  - a 60 s timeout and 1 SDK retry;
  - schema-constrained JSON output (OpenAI Responses API `text.format` with `strict: true`; Anthropic `output_config.format`),
    always validated again with Zod, plus one bounded repair turn;
  - learner answers and PDF text go only in the user turn, never in the instructions; no tools are offered and any tool call is
    rejected; refusals, content-filter stops and output-limit cut-offs are handled as provider errors;
  - OpenAI requests are sent with `store: false`;
  - each assessment records the vendor and model (stored as `openai:<model>` or `anthropic:<model>`), the prompt version and
    token usage.

  If the selected provider's key or model is missing, the app shows “Live mode unavailable” and every provider call fails
  visibly. It **never falls back to mock silently**. Live failures (timeouts, rate limits, quota) leave the attempt saved as
  `provider_error` with an explicit retry.

## Architecture

```text
src/lib/domain/       pure reducers: evidence.ts, scheduler.ts, assessment.ts, selection.ts, labels.ts (no Next/SQLite/SDK imports)
src/lib/db/           SQL migrations, connection (foreign_keys, WAL, busy_timeout), typed repositories (parameterised SQL)
src/lib/llm/          provider interface, mock, Claude and OpenAI adapters, prompts (versioned), output schemas
src/lib/pdf/          pdfjs-dist (legacy Node build) extraction; pdf-lib sample generation
src/lib/services/     sessions, assessments (lease + compare-and-set), evidence rebuild, imports, views, seed, replay
src/lib/http/         route wrapper: loopback Host allow-list, same-origin mutations, {data}|{error} envelopes
src/app/api/...       Node.js route handlers (see brief §14); pages are thin client screens over these APIs
fixtures/             lecture text, curriculum, 12-question bank with rubrics/hints/examples, replay, eval cases, sample PDF
scripts/              migrate, seed, demo reset, eval, content review, question import, export, delete
```

- One Node process and one SQLite file. No ORM, no external queue, no event bus. `record_order` comes from a single counter row
  shared by attempts and exposures, allocated inside the insertion transaction.
- `review_states` is a cache. It is rebuilt by replaying a skill's attempts in submission order, each with its exposure snapshot
  frozen at submission (`evidenceAttemptsForSkill` → `replaySkill`). Completion order of model calls is irrelevant.
- Assessment flow: claim a persisted `assessing` lease, then call the provider **outside** any transaction, then run
  compare-and-set finalisation, which inserts the unique assessment, marks the attempt assessed and rebuilds the skill state in one
  transaction. An expired lease can be retried. Only one final assessment per attempt is ever accepted.
- Background jobs (`jobs` table, `src/lib/jobs/`): an in-process worker starts with the first request and runs at most two jobs
  at once (`assess_attempt` for check answers, `draft_questions`). A job is claimed with a lease longer than its worst case, so
  after a crash or restart it is picked up again; a job interrupted three times is marked failed. Jobs hold ids only, and the
  handlers reuse the services' own safeguards, so a job that runs twice still yields one result. A job's `error` is a safe
  user-facing message: never prompts, answers or keys. Queued work resumes when the server next handles a request.
- `server-only` marks the DB, env and SDK modules. Scripts and tests run with the `react-server` condition (or an alias) so they can
  share the code.

## Operations (local)

- **Usage metering.** Every live provider call (assessment, curriculum, tutor, and live eval runs) is recorded in
  `provider_calls`: job, vendor, model, prompt version, status, error code, latency and token counts. Prompts, answers,
  documents and keys are never stored there. `npm run usage` summarises it. Costs are not computed; multiply the token counts by
  your provider's current prices.
- **Caps and concurrency.** `PROXIMAL_DAILY_CALL_LIMIT` and `PROXIMAL_DAILY_TOKEN_LIMIT` (rolling 24 hours) are checked before
  every live call. Over a cap the call is refused before reaching the provider, recorded as `blocked`, and the attempt stays
  saved and retryable. `PROXIMAL_MAX_CONCURRENT_CALLS` (default 2) queues extra simultaneous calls.
- **Logs.** Each provider call writes one JSON line to the server output (`event: provider_call`, with job, vendor, model,
  status, latency and tokens), and unexpected server errors write `event: unhandled_error`. No answer text or keys are logged.
- **Backups.** `npm run db:backup` before risky changes. Schema migrations back up automatically when the database has data.
  To restore: stop the server, copy `proximal.db` (and `uploads/`) from `data/backups/<timestamp>/` into `data/`, and start
  the server again.

## Workspace and recommendations

- Every screen shares one shell: a sidebar (Overview, Courses, your courses, provider status), a breadcrumb and **Import lecture**,
  which opens an accessible dialog. The palette follows the handoff's §6 tokens (`src/app/globals.css`).
- The home recommendation and the plan are computed on the server from persisted data (`src/lib/domain/plan.ts`), never by a model.
  Priority:
  1. the most recent unfinished session, resumed in its exact phase (continue a check, pending assessment, results ready, or an
     unresolved correction);
  2. due skills that need another check;
  3. other due skills, oldest first;
  4. an unresolved gap: targeted supported practice, which reuses the failed question family so fresh families stay available for
     checks;
  5. required skills not yet studied.

  Future checks appear only under **Upcoming check**, never in today's plan.
- Tasks are packed into the 10/20/30-minute budget at about 5 minutes per question, at most three tasks. A higher-priority task is
  never skipped to fit lower-priority work; an oversize first task is trimmed to the questions that fit. The budget is remembered in
  local storage only.
- Starting the same kind of session for a topic that already has an unfinished one resumes it instead of creating a duplicate.
- While a check is still open, its judgements are hidden everywhere: on the topic, the home page and in course counts (“Check in
  progress”), not just in the session.
- Session labels are **Learn**, **Supported practice**, **Independent check** and **Review**. Evidence labels are Not checked yet /
  Needs practice / Completed with support / Demonstrated independently / Retention demonstrated. Freshness is shown separately
  (Scheduled / Due today / Overdue / Needs another check), with local Europe/London dates.

## Review rules (as implemented)

- **Independent** = review mode AND original checkpoint submission AND no relevant exposure before submission (hint, source,
  solution, explanation, feedback or self-declared outside help in this session) AND no declared assistance AND a valid,
  non-excluded assessment. Confidence is collected but never used.
- **Outcome** is computed by the server, never the model:
  - an invalid quote, an unknown, missing or duplicate criterion ID, or an unresolved essential criterion gives *uncertain*;
  - a model "met" claim that conflicts with a numeric check gives *uncertain*;
  - a fatal criterion `not_met` gives *fail*;
  - all essential criteria met gives *pass*;
  - some essential criteria met or partial gives *partial*;
  - otherwise *fail*.
- **Evidence state**, within the current epoch:
  - unassessed: no usable attempt;
  - developing: only failed or partial attempts;
  - supported: criteria met only with support;
  - demonstrated_once: one independent pass;
  - retention_demonstrated: two independent passes in different sessions, at least 24 elapsed hours apart, from distinct
    families, at least one of them a transfer (B) question when the skill requires transfer.
- **Scheduler `heuristic-v1`**: intervals of 1, 3, 7, 14 and 30 days (elapsed UTC milliseconds; dates are displayed in
  Europe/London).
  - First pass in an epoch: stage 0, due in 1 day.
  - A pass at least 24 h after the last promotion, with no earlier promotion in that session: the stage advances (capped at 4).
  - Same-session or under-24 h passes: no change.
  - An independent partial or fail: new epoch, stage 0, due in 1 day, reassessment needed.
  - A supported or learning attempt: due = earlier(existing, +1 day), with no stage change.
  - Uncertain, pending or excluded attempts: no change.

  The two-pass/24-hour gate is a provisional engineering rule, not a validated retention model.
- **Checkpoints** hold 1–3 questions (default 2), chosen before the checkpoint starts. Between questions the screen shows only
  "Answer saved". Feedback is released explicitly afterwards, and the release is recorded as a feedback exposure. Corrections are
  new `repair` attempts on the same session question. They are always supported and never overwrite the original. A checkpoint can
  be ended early; completed attempts stay valid.
- **Question selection** prefers never-attempted families, then the least recently attempted. If only used families remain, the
  question is shown as "Repeated question family"; repeated passes cannot satisfy the distinct-family gate.
- **Source access**: in a session, the source pages for a question are returned only through the reveal flow, which conservatively
  exposes every skill in the topic. Opening the full PDF (`GET /api/sources/:id`) first records a source exposure for **every
  active session in that course**. Copies outside the app cannot be observed.
- **Flag judgement** excludes an assessment, records the reason and rebuilds the skill state. The history stays visible. There is no
  adjudication queue.

## PACER learning approach

Implements the bounded slice of [`docs/proximal/PACER_FEATURE_SPEC.md`](docs/proximal/PACER_FEATURE_SPEC.md). PACER (introduced by
Justin Sung) is adapted here as an information-and-activity taxonomy: Procedural, Analogous, Conceptual, Supporting evidence, Reference.
It is not a learning style, level or mastery measure, and no learning gain is claimed.

- **Classify** (topic page → Learning approach → Suggest approaches): one skill per objective, built server-side from approved source
  pages plus authored contexts (`fixtures/pacer/contexts.json`, seeded into `pacer_contexts`). Live mode uses the **curriculum** job's
  model (prompt `pacer-classifier-v1`); offline mode returns authored annotations only for an exactly matching context hash, labelled
  "Offline authored annotation (not model inference)", and abstains otherwise. A live failure is saved as a retryable error, never
  mock output. Unchanged requests reuse their saved proposal; "Suggest again" regenerates explicitly.
- **Validation**: Zod discriminated union; exactly one result per requested objective; unknown/duplicate ids, unknown chunks and
  quotes that are not whitespace-normalised substrings of the supplied text are rejected; ≤2 unique secondary types; every proposed
  type must be explained in the rationale; Analogous needs an approved comparison chunk or a learner-supplied connection.
- **Bounds**: ≤10 objectives and ≤12,000 characters per request (larger topics are split into several requests); ≤4,000 characters
  per objective (raised from the spec's provisional 2,000 because imported units often cite several pages). An objective over the
  limit is marked "Not classified" by name and is never truncated.
- **Review**: suggestions are drafts until Accept / Edit / Dismiss (or explicit "Accept all" after the reasons are shown). Manual
  choices are "Chosen by you" with the learner's reason, if any. Regeneration adds a draft and never overwrites a decision; a decision
  must name the decision it replaces. Source/context changes mark the decision stale and it stops routing new sessions.
- **Activities** (learning sessions only, frozen at session start): Connect → checked explanation → Reconstruct (explanation hidden),
  guided practice on the existing question, and Map-and-critique / Claim-support-limits / Capture-and-locate / Make-your-own-comparison
  where authored material exists. Otherwise "No prepared activity for this approach" and ordinary learning continues.
- **Evidence boundary**: responses are stored in `pacer_responses` with a workflow status only. They never create attempts,
  assessments, levels or review dates. Guided practice uses the existing assessment path and is always supported. Opening reasons and
  quotes while a session that includes the skill is active commits an explanation exposure there first; checks never receive
  classification data.
- **Evaluation**: `fixtures/pacer/dev-cases.json` holds F01–F12 plus two invalid service responses (provisional, not owner-reviewed).
  Offline runs in `tests/unit/pacer-classification.test.ts` test software only; exact fixture agreement is not classifier accuracy.

Known limitations: live classification has passed only the smoke test (`npm run smoke:live`), not an accuracy evaluation; imported PDFs get classification and review but
no activities (no authored material or checked explanations); no UI for a learner-supplied familiar connection; no variant question
after guided practice (keeps fresh families for checks); no tutor feedback on responses; no `eval:pacer` report script.

## Sample content

`fixtures/lecture.json` is original material authored for this demo. It is not a university handout. `npm run db:seed` renders it
into a six-page, text-based PDF, `fixtures/sample-lecture.pdf` (labelled "Authored sample lecture"), using pdf-lib with fixed
metadata so the bytes, and therefore the SHA-256, are reproducible. The demo course "AI classification demo" has:

- three topics: model and likelihood (pages 1–2), optimisation objective (page 3) and binary cross-entropy (pages 4–6);
- six units, each with one required skill, S1–S6;
- 12 questions: an initial family A and a transfer family B for each skill.

Every question has a frozen rubric, two hints, source pages and at least one correct, one partial and one wrong demo answer, each
with authored criterion judgements. A unit test checks that every example label matches what the rubric aggregation actually
produces.

### Content review process

All demo questions start as `authored_fixture` and are labelled that way in the UI. They were drafted with AI assistance and **have
not been reviewed by a person**. After you have actually checked a question (prompt, reference, rubric and examples), run:

```bash
npm run content:review -- --question S5-A --status owner_reviewed --by "Your Name"
```

To change a question's content, edit `fixtures/questions.json` **with a new id or version** (questions are immutable once seeded,
and sessions keep a frozen copy). Then run `npm run db:seed`. Use `--status excluded` to withdraw a question from selection.

## PDF import

- Accepts uploaded bytes only (no URL fetching), at most 10 MB and 50 pages. The size is checked from `Content-Length` and the
  file size before parsing.
- Validates the `%PDF` signature. Encrypted and malformed files get actionable errors. Files are stored under
  `$PROXIMAL_DATA_DIR/uploads/` with a random name.
- Text is extracted per page, with text-item boundaries preserved. A page with fewer than 40 non-whitespace characters gets a
  low-text warning; this is a heuristic. A PDF with no extractable text is rejected as likely scanned (OCR is not supported).
- Live mode asks for 3–8 units with 1–3 skills each and validates every page reference. **Long PDFs are drafted in parts**
  (`src/lib/content/chunking.ts`, prompt `curriculum-v2`): balanced runs of whole consecutive pages of about 60,000 characters
  (never over 80,000), so no page is split, dropped or sent twice. Each part is asked for 1–8 units citing only its own pages and is
  validated against them. The parts are merged in page order, and a topic that continues across a boundary is joined. Any failing
  part fails the whole import, so no partial course is stored. More than 8 parts, or one page over 80,000 characters, is rejected
  with the reason. Parts tend to yield more units per page than a single request (the smoke test got 13 units from 6 pages split 3
  ways, against 6 in one request), so expect to trim the draft.
- Every import is a draft. You can edit titles, objectives and required flags, delete units or add objectives manually, save, and
  then **approve** explicitly. Re-importing the same bytes reopens the existing course instead of duplicating it.
- After approval, objectives are frozen. **Revise objective** creates a new unit version with new skill IDs and fresh evidence;
  the old version is marked superseded and its history is kept.
- Approved imports show "Reviewed assessment questions needed", and **independent review stays disabled** until a subtopic has an
  approved question: drafted in the app (below) or attached with `npm run questions:import`. Imported objectives are never
  auto-mapped to demo questions. In live mode, learning sessions can request source-grounded tutor explanations.

## Drafting check questions

On an imported topic page, **Check questions** drafts two questions per subtopic from its approved PDF pages (curriculum job model,
prompt `question-draft-v1`, at most 24,000 characters of source per request): a first question and a structurally different
new-context question. Each comes with a reference answer, a rubric, numeric checks for calculations, two hints and example answers.

- **Drafts are never used.** They live in `question_drafts`. Only approval copies a draft, re-validated, into `questions`.
  Server-side checks run on every question separately: unique criterion ids, at least one essential criterion, numeric checks
  only on known criteria and never on explain questions, pages limited to the subtopic's own, a correct example expected to pass
  plus a partial or wrong one, and a stated structural change for the new-context question. A failing question is stored as
  *invalid* beside the valid one and cannot be approved until it is fixed.
- **The answer key starts hidden**, because the learner is also the reviewer. **Approve for checks** is offered only while the key is
  closed. Those questions are stored as `authored_fixture` with no reviewer, since nobody read the marking scheme, and they are
  labelled as AI drafts. Opening the key (after a confirmation) allows editing, then **Approve for practice**: the question is
  stored `owner_reviewed` and `practice_only`, and is never selected for an independent check. Learning sessions can use it.
- Drafting runs as a background job (`draft_questions`): the panel shows "Drafting…" and polls. Review is refused while a check is open on the topic. A provider failure stores no drafts; the panel shows its message and you can draft again.
- Offline mode drafts the authored sample-bank questions, and only for an imported copy of the sample lecture whose objectives match
  exactly. Those questions have no recorded judgements, so offline grading of them is always *uncertain*.
- The live smoke test drafted 2/2 valid questions with `gpt-5.5-2026-04-23` on 2026-10-12. That shows the pipeline works, not
  that the questions are good: read a few drafts critically before you rely on them.

## Evaluation harness

`npm run eval:fixtures` reads `fixtures/eval/cases.jsonl` (`{questionId, answer, expectedOutcome, caseType}`; the case types
are correct, partial, incorrect, ambiguous, equivalent and injection). It runs the provider plus server-side aggregation and writes
`reports/eval-<mode>-<time>.json`, which contains:

- counts and a confusion matrix;
- abstention and decision coverage;
- **false promotions**: predicted pass where the expected outcome was a definite partial or fail, reported with that denominator;
- expected-uncertain cases, listed separately.

- `--mode mock` is a **software check** of the offline path. Non-fixture answers are expected to abstain.
- `--mode live --yes [--limit N]` uses whichever live provider `LLM_MODE` selects, needs its key and model, prints the number of paid calls, and refuses to run without `--yes`.

The cases are authored development examples. Their labels are provisional until a person reviews them. They are not a held-out
benchmark, and passing them is not evidence of universal grading accuracy or injection resistance.

## Tests

`npm test` runs the domain, service and adapter tests, covering T01–T23 from the brief: reducers, timing gates including the
Europe/London DST edge, exposure ordering and snapshots, idempotent submission and 409 on key reuse, lease-based
single finalisation under concurrent retries, out-of-order completions, payload privacy, flagging, model-input contents and an
adversarial model output, timeout handling, direct source exposure and PDF error paths. It also covers the Claude adapter (structured
output, single repair, tool-call rejection, timeout mapping) and the loopback request guard.

`npm run test:e2e` runs the two key-free browser flows: the mock showcase with refresh persistence, and the sample PDF import with
draft edit, approval, page references and disabled review.

## Security model (local only)

- The server binds to `127.0.0.1`. API routes accept only loopback `Host` headers (`127.0.0.1`, `localhost`, `[::1]`), which
  guards against DNS rebinding.
- Every mutation must have a same-origin `Origin` header. Source-file reads reject cross-site fetches (`Sec-Fetch-Site`). There
  are no CORS headers.
- The client never supplies timestamps, eligibility or outcomes. Phase and ordinal are enforced server-side.
- Learner answers and documents are passed to the model as tagged data in the user turn, never as system instructions. No prompt
  can guarantee resistance to adversarial answers; *uncertain* and **Flag judgement** remain available.

## Decisions and known limitations

- **Next.js 16.4 with `cacheComponents` disabled.** Pages are client screens over the route handlers listed in the brief, so all
  data is read at request time.
- **Historical replay is computed from a fixture**, not stored in the learner database, so it can never mix with real records.
- **Mock demo examples are visible before answering, in mock mode only.** They are necessary for an offline demo; the README and
  UI label them, and live mode never sends them.
- **Dark mode** is not implemented (not a P0 requirement); the app is light-only.
- **The live tutor is used for imported units and for gap repair.** Demo units use their checked fixture explanations in both modes.
- **"I don't know"** is recorded as an assessed fail by a deterministic rule (`provider_mode = rule`). In review mode it therefore
  counts as a valid independent fail.
- **Check answers are graded in the background.** Saving a checkpoint answer queues an `assess_attempt` job and returns
  "Answer saved" at once; the results screen shows "grading…" and polls until the grades land. Learning answers and corrections are
  still graded within the request, because the learner is waiting for that feedback. A provider failure leaves the attempt saved as
  `provider_error` with an explicit retry; it is never retried automatically.
- **Live verification is a smoke test, not an evaluation.** `npm run smoke:live -- --yes` passed 6/6 on 2026-10-12 against OpenAI
  (`gpt-5.5-2026-04-23` for assessment and curriculum, `gpt-5.4-mini-2026-03-17` for the tutor). The Claude adapter is still tested
  with stubbed SDK clients only. Run the smoke test after changing a provider or model.
- **Test fault injection:** `PROXIMAL_FAULT_MOCK_ASSESS_FAILURES=N` makes the first N *offline* assessments in a server process
  fail like a provider outage, so the pending/retry path can be browser-tested without credentials. It has no effect in live mode;
  do not set it in normal use.
- **Not implemented** (deferred by the brief): authentication, hosting, OCR and vision import, semantic
  deduplication, probabilistic mastery, notifications, analytics, dispute resolution, and sophisticated history
  migration beyond the new-version duplicate described above.
- **No claims of learning gains, verified closed-book performance, participant data or human content review are made.**
