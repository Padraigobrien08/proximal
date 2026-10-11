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
| `npm run db:migrate` | Applies pending `src/lib/db/migrations/*.sql` to `$PROXIMAL_DATA_DIR/proximal.db`. Idempotent. |
| `npm run db:seed` | Migrates and regenerates `fixtures/sample-lecture.pdf` from `fixtures/lecture.json` (byte-deterministic; rewritten only when the bytes change). It inserts any missing demo content and updates the demo source text and checked explanations. An `authored_fixture` question is updated only when its fixture `version` increases; owner-reviewed and excluded questions are never changed, and sessions keep the frozen copy they used. Idempotent. It never touches learner records or imported uploads. |
| `npm run demo:reset -- --yes` | Deletes sessions, attempts, exposures, assessments and review states **for the demo course only**, then re-seeds. Refuses to run without `--yes`, or if `demo-course` is not marked as a demo. Imported courses and uploads are never touched. |
| `npm run eval:fixtures` | Evaluation harness (see below). Default `--mode mock`; `--mode live --yes` uses the configured provider. |
| `npm run content:review -- --list` / `-- --question S5-A --status owner_reviewed --by "Name"` | Lists question review status, or records that a named person reviewed a question. |
| `npm run questions:import -- --file bank.json [--course <id>]` | Attaches an owner-authored question bank (same schema as `fixtures/questions.json`) to existing skills. Inserted as `authored_fixture`. |
| `npm run data:export -- --course <id> [--out f.json] [--include-reference-answers]` | JSON export. Never includes env vars or keys. Reference answers are omitted unless the flag is given. |
| `npm run data:delete-course -- --course <id> --confirm <id>` | Deletes a course, its learner records and its uploaded files. |

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

- One Node process and one SQLite file. No ORM, no job queue, no event bus. `record_order` comes from a single counter row
  shared by attempts and exposures, allocated inside the insertion transaction.
- `review_states` is a cache. It is rebuilt by replaying a skill's attempts in submission order, each with its exposure snapshot
  frozen at submission (`evidenceAttemptsForSkill` → `replaySkill`). Completion order of model calls is irrelevant.
- Assessment flow: claim a persisted `assessing` lease, then call the provider **outside** any transaction, then run
  compare-and-set finalisation, which inserts the unique assessment, marks the attempt assessed and rebuilds the skill state in one
  transaction. An expired lease can be retried. Only one final assessment per attempt is ever accepted.
- `server-only` marks the DB, env and SDK modules. Scripts and tests run with the `react-server` condition (or an alias) so they can
  share the code.

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
- Live mode asks for 3–8 units with 1–3 skills each, validates page references, and rejects text inputs over 120,000 characters
  instead of silently dropping pages.
- Every import is a draft. You can edit titles, objectives and required flags, delete units or add objectives manually, save, and
  then **approve** explicitly. Re-importing the same bytes reopens the existing course instead of duplicating it.
- After approval, objectives are frozen. **Revise objective** creates a new unit version with new skill IDs and fresh evidence;
  the old version is marked superseded and its history is kept.
- Approved imports show "Reviewed assessment questions needed", and **independent review stays disabled** until a question bank
  is attached with `npm run questions:import`. Imported objectives are never auto-mapped to demo questions. In live mode, learning
  sessions can request source-grounded tutor explanations.

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
- **Checkpoint assessment runs during the submit request.** The learner still sees only "Answer saved". A provider timeout leaves
  the attempt retryable.
- **Live providers are unverified end to end.** Both adapters are tested with stubbed SDK clients only; no request has been
  made with real credentials. After configuring a provider, try one assessment, one import and one tutor request before relying
  on it.
- **Test fault injection:** `PROXIMAL_FAULT_MOCK_ASSESS_FAILURES=N` makes the first N *offline* assessments in a server process
  fail like a provider outage, so the pending/retry path can be browser-tested without credentials. It has no effect in live mode;
  do not set it in normal use.
- **Not implemented** (deferred by the brief): authentication, hosting, OCR and vision import, question generation, semantic
  deduplication, probabilistic mastery, background workers, notifications, analytics, dispute resolution, and sophisticated history
  migration beyond the new-version duplicate described above.
- **No claims of learning gains, verified closed-book performance, participant data or human content review are made.**
