# Proximal — persistent course model (design)

Status: draft for discussion, 2026-10-21. Nothing here is built yet.

## Decision

- The persistent object is a **university course** (for example ANLP), not an imported PDF.
- Each course has a **syllabus**: the persistent list of topics, subtopics and skills covered by the lectures uploaded so
  far. It is built from the lectures, not from an official syllabus document.
- **Adding a lecture adds to the syllabus.** The lecture is parsed against the existing syllabus, and the proposed changes
  (new topics or skills, and citations to the lecture's pages) are **reviewed** before they join it.
- A concept is **one skill** wherever it appears: a later lecture that covers it adds citations to the existing skill rather
  than creating a new one.
- The syllabus is **connected**: alongside each lecture's proposals the model proposes prerequisite links between skills, so
  topics join up into one structure rather than sitting side by side. Links are reviewed like everything else.
- **Course documents** (an official syllabus, course descriptor, learning outcomes, schedule) are a separate kind of input from
  lectures. They are not educational material: they are never cited as teaching pages and never used to teach or draft
  questions. They inform the syllabus (topic names, the order of topics, outcomes to aim for).
- **Learning is a separate job.** It reads the approved syllabus and runs study, checks, evidence and scheduling. It never
  changes the syllabus, and syllabus changes reach it only through the defined rules below.
- An **updated file of a lecture** (typo fixes, added slides, next year's version) needs no special treatment: it is added like
  any lecture, its pages are proposed as citations of the existing skills, and evidence is untouched. The old file can be
  removed afterwards.

## Why change

Today an import is the only way to create a course, and every import creates a new one from a single PDF (one source per
course, one model call, frozen at approval). Over a term that means:

- a 20-lecture course becomes 20 unrelated modules, with progress per lecture rather than per course;
- a concept taught in two lectures becomes two skills with separate evidence and two review schedules;
- corrected slides (new file hash) start a new course and lose all evidence;
- material cannot be added to an existing course, and deleting a PDF's course deletes its learning record;
- the planner cannot order work across lectures.

What already fits: every learner record hangs off **skills** (attempts via session questions, review states, questions,
PACER, chat touches), sessions hang off **topics**, units already have per-unit `approval_status` and a version chain
(`supersedes_unit_id`), and the evidence rules do not depend on where a skill came from. The course → topic → subtopic
(unit) → skill tree can become the persistent syllabus without touching the evidence layer.

## Two layers

| | Syllabus (course content) | Learning |
| --- | --- | --- |
| Holds | Topics, subtopics, skills, prerequisite links, lectures, course documents, citations, pending proposals | Sessions, attempts, assessments, exposures, review states, questions, plans |
| Changed by | Adding or removing a lecture or course document; reviewed proposals; manual edits | Studying |
| Reads | The lectures' text | Only **approved** syllabus items; pending proposals are invisible |

How syllabus changes reach learning:

| Syllabus change | Effect on learning |
| --- | --- |
| New skill approved | Appears in the plan as Not started. Checkable once it has reviewed questions (as imported skills work today). |
| Citations added to an existing skill | Evidence unchanged. Learning material and question drafting can use the new pages. |
| Skill objective changed materially | New skill version with fresh evidence (the existing rule); old history kept. |
| Skill retired | Leaves the plan; evidence and history kept. |
| Lecture removed | Its citations go; a skill left with none is flagged "No material", its evidence kept. |
| Prerequisite link approved | The planner orders work by it (a skill's prerequisites are studied or checked first). Evidence unchanged. |

Pending proposals never block learning: you can keep studying the approved syllabus while a new lecture waits for review.

## Model

| Object | Today | Proposed |
| --- | --- | --- |
| Course | Created by an import; title is the file name | Created by the learner, starts empty, persists for the term |
| Syllabus | — | The course's approved topics, subtopics and skills, grown lecture by lecture |
| Topic / subtopic (unit) | From one PDF | Created by an approved lecture proposal, then reused by later lectures |
| Skill | One per objective in one PDF | One per concept in the course; gains citations as lectures cover it |
| Source | Exactly one per course | Many per course. Educational: role `lecture` (later `lab`, `reading`), citable. Course document: role `course_document`, never cited or used for teaching. |
| Prerequisite link | — | Skill A must come before skill B; proposed by the model, reviewed |
| Citation | `{ page }` | `{ sourceId, page }` |
| Approval | Whole course (`draft` / `approved`) | Per proposal; approved items use the existing per-unit `approval_status` |

## Flows

### 1. Create a course

Name it. It starts with an empty syllabus; learning has nothing to plan until the first lecture is approved.

### 2. Add a lecture

1. Upload a PDF into the course. Text extraction and scanned-page transcription are unchanged.
2. One model call (per part, for long lectures) receives the **current syllabus** (topic, subtopic and skill titles,
   objectives and ids; not other lectures' text) plus the lecture's pages, and returns **proposals**:
   - `cite`: these pages teach existing skill S (expected to be the common case after the first few lectures);
   - `new_skill`: a concept not yet in the syllabus, under existing subtopic U;
   - `new_subtopic`: under existing topic T;
   - `new_topic`: content that fits no existing topic always becomes a proposed new topic (never silently dropped or forced
     into an ill-fitting one);
   - `prerequisite`: skill A must come before skill B, for new skills and between new and existing ones. The model is asked to
     connect each new skill to the rest of the syllabus wherever the material supports it;
   - uncited pages (admin, activities), shown by the existing coverage warning.

   For the first lecture the syllabus is empty, so every proposal is new; this is today's draft review.
3. Validation stays structural: every referenced id exists in this course, every page is in range, no two proposals
   duplicate each other. A `new_skill` whose title closely matches an existing skill is flagged "possible duplicate of S".
4. **Review**: the learner accepts, edits or rejects each proposal (and can turn a flagged new skill into a `cite` of the
   existing one). Accepted items join the syllabus; rejected ones are kept on the proposal record for reference.

### 3. Add a course document

Upload an official syllabus, course descriptor, schedule or learning-outcomes page as a **course document**, at any time
(before the first lecture or later). It is extracted like a lecture but:

- it is never cited by a skill and never used by the tutor, lecture chat or question drafting;
- one model call proposes **outline** changes: topic names and order, and expected outcomes. Outcomes not yet covered by any
  lecture are shown as "Expected, no material yet" so the course's gaps are visible; they become skills only when a lecture
  teaches them;
- later lecture proposals receive the course document's outline and outcomes as context, so placement and topic names follow
  the course's own terms;
- the admin pages that lectures leave uncited (assessment weightings, schedule) belong here conceptually; a lecture page can be
  marked "course information" in review.

### 4. Remove a lecture

Its citations are removed. Skills left with none are flagged "No material"; their evidence and history stay. This is also
how an outdated version of a lecture is cleaned up after its newer file has been added. Deleting a course
remains the only way to delete learning records.

## One skill per concept: rules

- Lectures **cite** existing skills by default; creating a skill is an explicit, reviewed proposal.
- A skill lives in one subtopic. If a later lecture covers it in another context, it cites the existing skill; the topic page
  can list "also covered in lecture N" from the citations.
- **Connected, not a list.** A new skill with no proposed link to anything else is flagged in review ("not connected") so
  isolated islands are a visible decision rather than a default. Links must not form a cycle.
- **Merging two existing skills is not offered when both have evidence**: combining their records would let evidence for one
  count for the other. Instead, one can be retired. Merging is allowed while at most one has evidence.

## Data changes

1. `sources`: add `role`; allow many per course (no constraint prevents it today; only the import
   path does).
2. Citations in `units.source_refs_json` and `questions.source_refs_json` become `{ sourceId, page }`. Migration fills
   `sourceId` with the course's single existing source.
3. New table `lecture_proposals` (`id`, `course_id`, `source_id`, `kind`, `payload_json`, `status`, `created_at`,
   `decided_at`) so a lecture's proposals survive reloads and can be reviewed later.
4. `skills`: add `retired_at`.
5. New table `skill_links` (`from_skill_id`, `to_skill_id`, `kind` = `prerequisite`, `status`, `proposed_by_source_id`,
   `created_at`); acyclic, checked on insert.
6. Course documents: `sources.role = 'course_document'`, plus `course_outcomes` (`id`, `course_id`, `source_id`, `text`,
   `topic_id`, `covered_by_skill_id`) for expected outcomes.
7. Course-level `status` is retired: a course is studyable once it has at least one approved skill; approval is per item.

### Existing data

- **Demo course:** unchanged in behaviour; its one source becomes a lecture.
- **Your two imported drafts** (ANLP W1/L1; conditional likelihood and BCE): no study records. Either migrate each as a course
  with one lecture, or create an ANLP course and add W1/L1 to it through the new flow. The second also tests the flow.

## Phases

| Phase | Scope | Done when |
| --- | --- | --- |
| A | Many sources per course, `{ sourceId, page }` citations, source roles, migration. No behaviour change. | All tests pass; citations migrated. |
| B | Create an empty course; add the first lecture through proposals and review (today's draft review, reworked). | A new course can be built from one lecture; learning reads only approved items. |
| C | Add later lectures against the existing syllabus: `cite` proposals, duplicate flags, always-new-topic, prerequisite-link proposals and "not connected" flags. Planner orders by approved links. | Labelled mapping check (below) meets the agreed bar. |
| D | Course documents: separate upload type, outline and expected-outcome proposals, used as context for lecture placement. | A course document changes topic names/order and shows uncovered outcomes; it is never cited or taught from. |
| E | Remove a lecture; skill retirement tooling. | Removing a lecture keeps evidence and flags skills left without material. |

## Risks and how to check them

- **Mapping quality.** A wrong `cite` attaches teaching material (and later questions) to the wrong skill. Before phase C,
  hand-label which skill each content page of 3–4 real ANLP lectures teaches and measure the proposals against it (correct
  cites, missed cites, false duplicates). Review catches errors, but a long review list causes fatigue, so precision matters.
- **Link quality.** Over-eager prerequisite links make the planner hold back work for no reason. Include links in the labelled
  check (are proposed prerequisites real?), and keep "not connected" as a flag, not a block.
- **Syllabus drift.** Built bottom-up, early lectures set the topic outline and later lectures can strain it. Review must make
  renaming, moving and splitting topics and subtopics easy; moving a skill keeps its evidence.
- **Context size.** The syllabus grows over a term; sending titles, objectives and ids (not text) keeps it bounded (roughly
  100–300 skills).
- **Cost.** About the same per lecture as today's import.
- **Exposure rules with several lectures.** Opening a source today counts as help for every skill in the topic. With shared
  skills it should count for the skills that cite pages of that source. This needs its own tests.

## Decided (2026-10-21)

- Content that fits no existing topic: **always propose a new topic** (reviewed).
- Official syllabus or course descriptor: **yes, as a separate input type** (course document), because it is not educational
  material.
- Prerequisite links: **proposed by the model and reviewed**, and the model should actively connect skills together.

- An updated file of an existing lecture: **no special treatment**; it is added like any lecture and cites the existing
  skills. The old file can be removed afterwards.

## Open questions

None outstanding.
