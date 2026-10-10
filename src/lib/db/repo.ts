// Typed repository functions. Parameterised SQL only.
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AttemptOutcome,
  AttemptPhase,
  AttemptStatus,
  CriterionJudgement,
  EvidenceAttempt,
  EvidenceState,
  ExposureKind,
  ProviderMode,
  QuestionPrivate,
  QuestionStatus,
  SessionMode,
  SkillReviewState,
  SourceRef,
  TaskType,
  Validity,
} from "../domain/types";
import type { ExampleFixture } from "../content/schemas";

type DB = Database.Database;

export const newId = () => randomUUID();

const json = <T>(s: string | null): T => (s === null ? (null as T) : (JSON.parse(s) as T));

// ---------------------------------------------------------------- record order

/** Allocate the next shared record_order. Must be called inside the insertion transaction. */
export function nextRecordOrder(db: DB): number {
  const row = db.prepare("UPDATE record_counter SET value = value + 1 WHERE id = 1 RETURNING value").get() as {
    value: number;
  };
  return row.value;
}

// ---------------------------------------------------------------- courses / curriculum

export interface CourseRow {
  id: string;
  title: string;
  isDemo: boolean;
  status: "draft" | "approved";
  suggestions: string[];
  notice: string | null;
  createdAt: number;
}

interface RawCourse {
  id: string;
  title: string;
  is_demo: number;
  status: "draft" | "approved";
  suggestions_json: string;
  notice: string | null;
  created_at: number;
}
const mapCourse = (r: RawCourse): CourseRow => ({
  id: r.id,
  title: r.title,
  isDemo: !!r.is_demo,
  status: r.status,
  suggestions: json<string[]>(r.suggestions_json),
  notice: r.notice,
  createdAt: r.created_at,
});

export function insertCourse(
  db: DB,
  c: { id?: string; title: string; isDemo: boolean; status: "draft" | "approved"; suggestions?: string[]; notice?: string | null; createdAt: number },
): string {
  const id = c.id ?? newId();
  db.prepare(
    "INSERT INTO courses (id, title, is_demo, status, suggestions_json, notice, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, c.title, c.isDemo ? 1 : 0, c.status, JSON.stringify(c.suggestions ?? []), c.notice ?? null, c.createdAt);
  return id;
}

export function getCourse(db: DB, id: string): CourseRow | null {
  const r = db.prepare("SELECT * FROM courses WHERE id = ?").get(id) as RawCourse | undefined;
  return r ? mapCourse(r) : null;
}

export function listCourses(db: DB): CourseRow[] {
  return (db.prepare("SELECT * FROM courses ORDER BY is_demo DESC, created_at ASC").all() as RawCourse[]).map(mapCourse);
}

export function setCourseStatus(db: DB, id: string, status: "draft" | "approved"): void {
  db.prepare("UPDATE courses SET status = ? WHERE id = ?").run(status, id);
}

export interface TopicRow {
  id: string;
  courseId: string;
  title: string;
  position: number;
}

export function insertTopic(db: DB, t: { id?: string; courseId: string; title: string; position: number }): string {
  const id = t.id ?? newId();
  db.prepare("INSERT INTO topics (id, course_id, title, position) VALUES (?, ?, ?, ?)").run(id, t.courseId, t.title, t.position);
  return id;
}

export function getTopic(db: DB, id: string): TopicRow | null {
  const r = db.prepare("SELECT id, course_id AS courseId, title, position FROM topics WHERE id = ?").get(id) as
    | TopicRow
    | undefined;
  return r ?? null;
}

export function listTopics(db: DB, courseId: string): TopicRow[] {
  return db
    .prepare("SELECT id, course_id AS courseId, title, position FROM topics WHERE course_id = ? ORDER BY position, id")
    .all(courseId) as TopicRow[];
}

export interface UnitRow {
  id: string;
  topicId: string;
  title: string;
  objective: string;
  version: number;
  approvalStatus: "draft" | "approved" | "superseded";
  sourceRefs: SourceRef[];
  explanation: string | null;
  workedExample: string | null;
  position: number;
  supersedesUnitId: string | null;
}

interface RawUnit {
  id: string;
  topic_id: string;
  title: string;
  objective: string;
  version: number;
  approval_status: UnitRow["approvalStatus"];
  source_refs_json: string;
  explanation: string | null;
  worked_example: string | null;
  position: number;
  supersedes_unit_id: string | null;
}
const mapUnit = (r: RawUnit): UnitRow => ({
  id: r.id,
  topicId: r.topic_id,
  title: r.title,
  objective: r.objective,
  version: r.version,
  approvalStatus: r.approval_status,
  sourceRefs: json<SourceRef[]>(r.source_refs_json),
  explanation: r.explanation,
  workedExample: r.worked_example,
  position: r.position,
  supersedesUnitId: r.supersedes_unit_id,
});

export function insertUnit(
  db: DB,
  u: {
    id?: string;
    topicId: string;
    title: string;
    objective: string;
    version?: number;
    approvalStatus: UnitRow["approvalStatus"];
    sourceRefs: SourceRef[];
    explanation?: string | null;
    workedExample?: string | null;
    position: number;
    supersedesUnitId?: string | null;
  },
): string {
  const id = u.id ?? newId();
  db.prepare(
    `INSERT INTO units (id, topic_id, title, objective, version, approval_status, source_refs_json, explanation, worked_example, position, supersedes_unit_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    u.topicId,
    u.title,
    u.objective,
    u.version ?? 1,
    u.approvalStatus,
    JSON.stringify(u.sourceRefs),
    u.explanation ?? null,
    u.workedExample ?? null,
    u.position,
    u.supersedesUnitId ?? null,
  );
  return id;
}

export function getUnit(db: DB, id: string): UnitRow | null {
  const r = db.prepare("SELECT * FROM units WHERE id = ?").get(id) as RawUnit | undefined;
  return r ? mapUnit(r) : null;
}

export function listUnits(db: DB, topicId: string, includeSuperseded = false): UnitRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM units WHERE topic_id = ? ${includeSuperseded ? "" : "AND approval_status != 'superseded'"} ORDER BY position, id`,
    )
    .all(topicId) as RawUnit[];
  return rows.map(mapUnit);
}

export function updateUnit(db: DB, id: string, patch: { title?: string; objective?: string; approvalStatus?: UnitRow["approvalStatus"] }) {
  const u = getUnit(db, id);
  if (!u) return;
  db.prepare("UPDATE units SET title = ?, objective = ?, approval_status = ? WHERE id = ?").run(
    patch.title ?? u.title,
    patch.objective ?? u.objective,
    patch.approvalStatus ?? u.approvalStatus,
    id,
  );
}

export function deleteUnit(db: DB, id: string) {
  db.prepare("DELETE FROM units WHERE id = ?").run(id);
}

export interface SkillRow {
  id: string;
  unitId: string;
  objective: string;
  required: boolean;
  transferRequired: boolean;
  version: number;
  position: number;
}

interface RawSkill {
  id: string;
  unit_id: string;
  objective: string;
  required: number;
  transfer_required: number;
  version: number;
  position: number;
}
const mapSkill = (r: RawSkill): SkillRow => ({
  id: r.id,
  unitId: r.unit_id,
  objective: r.objective,
  required: !!r.required,
  transferRequired: !!r.transfer_required,
  version: r.version,
  position: r.position,
});

export function insertSkill(
  db: DB,
  s: { id?: string; unitId: string; objective: string; required: boolean; transferRequired: boolean; version?: number; position: number },
): string {
  const id = s.id ?? newId();
  db.prepare(
    "INSERT INTO skills (id, unit_id, objective, required, transfer_required, version, position) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, s.unitId, s.objective, s.required ? 1 : 0, s.transferRequired ? 1 : 0, s.version ?? 1, s.position);
  return id;
}

export function getSkill(db: DB, id: string): SkillRow | null {
  const r = db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as RawSkill | undefined;
  return r ? mapSkill(r) : null;
}

export function listSkillsForUnit(db: DB, unitId: string): SkillRow[] {
  return (db.prepare("SELECT * FROM skills WHERE unit_id = ? ORDER BY position, id").all(unitId) as RawSkill[]).map(mapSkill);
}

/** Active (non-superseded) skills in a topic, ordered by unit then skill position. */
export function listSkillsForTopic(db: DB, topicId: string): (SkillRow & { unit: UnitRow })[] {
  return listUnits(db, topicId).flatMap((u) => listSkillsForUnit(db, u.id).map((s) => ({ ...s, unit: u })));
}

export function updateSkill(db: DB, id: string, patch: { objective?: string; required?: boolean }) {
  const s = getSkill(db, id);
  if (!s) return;
  db.prepare("UPDATE skills SET objective = ?, required = ? WHERE id = ?").run(
    patch.objective ?? s.objective,
    (patch.required ?? s.required) ? 1 : 0,
    id,
  );
}

/** True once any session has used this skill (objective edits are then frozen). */
export function skillUsedInSession(db: DB, skillId: string): boolean {
  return !!db.prepare("SELECT 1 FROM session_questions WHERE skill_id = ? LIMIT 1").get(skillId);
}

// ---------------------------------------------------------------- sources

export interface SourceRow {
  id: string;
  courseId: string | null;
  sha256: string;
  originalName: string;
  label: string | null;
  storedPath: string;
  pageCount: number | null;
  status: "processing" | "extracted" | "failed";
  error: string | null;
  createdAt: number;
}

interface RawSource {
  id: string;
  course_id: string | null;
  sha256: string;
  original_name: string;
  label: string | null;
  stored_path: string;
  page_count: number | null;
  status: SourceRow["status"];
  error: string | null;
  created_at: number;
}
const mapSource = (r: RawSource): SourceRow => ({
  id: r.id,
  courseId: r.course_id,
  sha256: r.sha256,
  originalName: r.original_name,
  label: r.label,
  storedPath: r.stored_path,
  pageCount: r.page_count,
  status: r.status,
  error: r.error,
  createdAt: r.created_at,
});

export function insertSource(db: DB, s: Omit<SourceRow, "id"> & { id?: string }): string {
  const id = s.id ?? newId();
  db.prepare(
    `INSERT INTO sources (id, course_id, sha256, original_name, label, stored_path, page_count, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, s.courseId, s.sha256, s.originalName, s.label, s.storedPath, s.pageCount, s.status, s.error, s.createdAt);
  return id;
}

export function getSource(db: DB, id: string): SourceRow | null {
  const r = db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as RawSource | undefined;
  return r ? mapSource(r) : null;
}

export function listSourcesForCourse(db: DB, courseId: string): SourceRow[] {
  return (db.prepare("SELECT * FROM sources WHERE course_id = ? ORDER BY created_at").all(courseId) as RawSource[]).map(mapSource);
}

export function findSourcesBySha(db: DB, sha: string): SourceRow[] {
  return (db.prepare("SELECT * FROM sources WHERE sha256 = ? ORDER BY created_at").all(sha) as RawSource[]).map(mapSource);
}

export function updateSource(db: DB, id: string, patch: Partial<Pick<SourceRow, "status" | "error" | "pageCount" | "courseId">>) {
  const s = getSource(db, id);
  if (!s) return;
  db.prepare("UPDATE sources SET status = ?, error = ?, page_count = ?, course_id = ? WHERE id = ?").run(
    patch.status ?? s.status,
    patch.error === undefined ? s.error : patch.error,
    patch.pageCount === undefined ? s.pageCount : patch.pageCount,
    patch.courseId === undefined ? s.courseId : patch.courseId,
    id,
  );
}

export interface SourcePageRow {
  sourceId: string;
  pageNumber: number;
  text: string;
  lowTextWarning: boolean;
}

export function replaceSourcePages(db: DB, sourceId: string, pages: { pageNumber: number; text: string; lowTextWarning: boolean }[]) {
  db.prepare("DELETE FROM source_pages WHERE source_id = ?").run(sourceId);
  const ins = db.prepare(
    "INSERT INTO source_pages (source_id, page_number, extracted_text, low_text_warning) VALUES (?, ?, ?, ?)",
  );
  for (const p of pages) ins.run(sourceId, p.pageNumber, p.text, p.lowTextWarning ? 1 : 0);
}

export function listSourcePages(db: DB, sourceId: string): SourcePageRow[] {
  return (
    db
      .prepare("SELECT source_id, page_number, extracted_text, low_text_warning FROM source_pages WHERE source_id = ? ORDER BY page_number")
      .all(sourceId) as { source_id: string; page_number: number; extracted_text: string; low_text_warning: number }[]
  ).map((r) => ({ sourceId: r.source_id, pageNumber: r.page_number, text: r.extracted_text, lowTextWarning: !!r.low_text_warning }));
}

// ---------------------------------------------------------------- questions

interface RawQuestion {
  id: string;
  skill_id: string;
  version: number;
  family_id: string;
  is_transfer: number;
  task_type: TaskType;
  prompt: string;
  reference_json: string;
  rubric_json: string;
  hints_json: string;
  source_refs_json: string;
  reveal_skill_ids_json: string;
  examples_json: string;
  status: QuestionStatus;
  reviewed_by: string | null;
  reviewed_at: number | null;
}

export type QuestionRecord = QuestionPrivate & { examples: ExampleFixture[]; reviewedBy: string | null; reviewedAt: number | null };

const mapQuestion = (r: RawQuestion): QuestionRecord => ({
  id: r.id,
  skillId: r.skill_id,
  version: r.version,
  familyId: r.family_id,
  isTransfer: !!r.is_transfer,
  taskType: r.task_type,
  prompt: r.prompt,
  reference: json(r.reference_json),
  rubric: json(r.rubric_json),
  hints: json(r.hints_json),
  sourceRefs: json(r.source_refs_json),
  revealSkillIds: json(r.reveal_skill_ids_json),
  examples: json(r.examples_json),
  status: r.status,
  reviewedBy: r.reviewed_by,
  reviewedAt: r.reviewed_at,
});

export function insertQuestion(db: DB, q: QuestionPrivate & { examples: ExampleFixture[] }) {
  db.prepare(
    `INSERT INTO questions (id, skill_id, version, family_id, is_transfer, task_type, prompt, reference_json, rubric_json,
       hints_json, source_refs_json, reveal_skill_ids_json, examples_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    q.id,
    q.skillId,
    q.version,
    q.familyId,
    q.isTransfer ? 1 : 0,
    q.taskType,
    q.prompt,
    JSON.stringify(q.reference),
    JSON.stringify(q.rubric),
    JSON.stringify(q.hints),
    JSON.stringify(q.sourceRefs),
    JSON.stringify(q.revealSkillIds),
    JSON.stringify(q.examples),
    q.status,
  );
}

/** Replace an unreviewed fixture question's content with a newer authored version. Sessions keep their frozen copies. */
export function updateQuestionContent(db: DB, q: QuestionPrivate & { examples: ExampleFixture[] }) {
  db.prepare(
    `UPDATE questions SET version = ?, family_id = ?, is_transfer = ?, task_type = ?, prompt = ?, reference_json = ?, rubric_json = ?,
       hints_json = ?, source_refs_json = ?, reveal_skill_ids_json = ?, examples_json = ?
     WHERE id = ? AND status = 'authored_fixture'`,
  ).run(
    q.version,
    q.familyId,
    q.isTransfer ? 1 : 0,
    q.taskType,
    q.prompt,
    JSON.stringify(q.reference),
    JSON.stringify(q.rubric),
    JSON.stringify(q.hints),
    JSON.stringify(q.sourceRefs),
    JSON.stringify(q.revealSkillIds),
    JSON.stringify(q.examples),
    q.id,
  );
}

export function getQuestion(db: DB, id: string): QuestionRecord | null {
  const r = db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as RawQuestion | undefined;
  return r ? mapQuestion(r) : null;
}

export function listQuestionsForSkill(db: DB, skillId: string): QuestionRecord[] {
  return (db.prepare("SELECT * FROM questions WHERE skill_id = ? ORDER BY id").all(skillId) as RawQuestion[]).map(mapQuestion);
}

export function setQuestionStatus(db: DB, id: string, status: QuestionStatus, reviewedBy: string | null, at: number | null) {
  db.prepare("UPDATE questions SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(status, reviewedBy, at, id);
}

/** Last attempt time per family for a skill (any session, any mode). */
export function lastAttemptByFamily(db: DB, skillId: string): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT json_extract(sq.frozen_question_json, '$.familyId') AS family, MAX(a.submitted_at) AS last
       FROM attempts a JOIN session_questions sq ON sq.id = a.session_question_id
       WHERE sq.skill_id = ? GROUP BY family`,
    )
    .all(skillId) as { family: string; last: number }[];
  return new Map(rows.map((r) => [r.family, r.last]));
}

// ---------------------------------------------------------------- sessions

export type SessionPurpose = "learn" | "practice" | "check" | "review";

export interface SessionRow {
  id: string;
  topicId: string;
  mode: SessionMode;
  purpose: SessionPurpose;
  isDemo: boolean;
  status: "active" | "ended";
  phase: "checkpoint" | "results" | "repair" | "learning";
  currentOrdinal: number;
  feedbackReleasedAt: number | null;
  createdAt: number;
  endedAt: number | null;
}

interface RawSession {
  id: string;
  topic_id: string;
  mode: SessionMode;
  purpose: SessionPurpose;
  is_demo: number;
  status: SessionRow["status"];
  phase: SessionRow["phase"];
  current_ordinal: number;
  feedback_released_at: number | null;
  created_at: number;
  ended_at: number | null;
}
const mapSession = (r: RawSession): SessionRow => ({
  id: r.id,
  topicId: r.topic_id,
  mode: r.mode,
  purpose: r.purpose,
  isDemo: !!r.is_demo,
  status: r.status,
  phase: r.phase,
  currentOrdinal: r.current_ordinal,
  feedbackReleasedAt: r.feedback_released_at,
  createdAt: r.created_at,
  endedAt: r.ended_at,
});

export function insertSession(db: DB, s: Omit<SessionRow, "id" | "feedbackReleasedAt" | "endedAt" | "currentOrdinal">): string {
  const id = newId();
  db.prepare(
    "INSERT INTO sessions (id, topic_id, mode, purpose, is_demo, status, phase, current_ordinal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)",
  ).run(id, s.topicId, s.mode, s.purpose, s.isDemo ? 1 : 0, s.status, s.phase, s.createdAt);
  return id;
}

export function getSession(db: DB, id: string): SessionRow | null {
  const r = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as RawSession | undefined;
  return r ? mapSession(r) : null;
}

export function updateSession(
  db: DB,
  id: string,
  patch: Partial<Pick<SessionRow, "status" | "phase" | "currentOrdinal" | "feedbackReleasedAt" | "endedAt">>,
) {
  const s = getSession(db, id);
  if (!s) return;
  db.prepare(
    "UPDATE sessions SET status = ?, phase = ?, current_ordinal = ?, feedback_released_at = ?, ended_at = ? WHERE id = ?",
  ).run(
    patch.status ?? s.status,
    patch.phase ?? s.phase,
    patch.currentOrdinal ?? s.currentOrdinal,
    patch.feedbackReleasedAt === undefined ? s.feedbackReleasedAt : patch.feedbackReleasedAt,
    patch.endedAt === undefined ? s.endedAt : patch.endedAt,
    id,
  );
}

export function listActiveSessionsForCourse(db: DB, courseId: string): SessionRow[] {
  return (
    db
      .prepare(
        `SELECT s.* FROM sessions s JOIN topics t ON t.id = s.topic_id WHERE t.course_id = ? AND s.status = 'active'`,
      )
      .all(courseId) as RawSession[]
  ).map(mapSession);
}

export interface SessionQuestionRow {
  id: string;
  sessionId: string;
  questionId: string;
  skillId: string;
  ordinal: number;
  checkpointIndex: number | null;
  phase: "checkpoint" | "practice";
  frozen: QuestionPrivate;
  repeatedFamily: boolean;
  skipped: boolean;
}

interface RawSQ {
  id: string;
  session_id: string;
  question_id: string;
  skill_id: string;
  ordinal: number;
  checkpoint_index: number | null;
  phase: SessionQuestionRow["phase"];
  frozen_question_json: string;
  repeated_family: number;
  skipped: number;
}
const mapSQ = (r: RawSQ): SessionQuestionRow => ({
  id: r.id,
  sessionId: r.session_id,
  questionId: r.question_id,
  skillId: r.skill_id,
  ordinal: r.ordinal,
  checkpointIndex: r.checkpoint_index,
  phase: r.phase,
  frozen: json(r.frozen_question_json),
  repeatedFamily: !!r.repeated_family,
  skipped: !!r.skipped,
});

export function insertSessionQuestion(db: DB, sq: Omit<SessionQuestionRow, "id" | "skipped">): string {
  const id = newId();
  db.prepare(
    `INSERT INTO session_questions (id, session_id, question_id, skill_id, ordinal, checkpoint_index, phase, frozen_question_json, repeated_family)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sq.sessionId,
    sq.questionId,
    sq.skillId,
    sq.ordinal,
    sq.checkpointIndex,
    sq.phase,
    JSON.stringify(sq.frozen),
    sq.repeatedFamily ? 1 : 0,
  );
  return id;
}

export function listSessionQuestions(db: DB, sessionId: string): SessionQuestionRow[] {
  return (db.prepare("SELECT * FROM session_questions WHERE session_id = ? ORDER BY ordinal").all(sessionId) as RawSQ[]).map(mapSQ);
}

export function getSessionQuestion(db: DB, id: string): SessionQuestionRow | null {
  const r = db.prepare("SELECT * FROM session_questions WHERE id = ?").get(id) as RawSQ | undefined;
  return r ? mapSQ(r) : null;
}

// ---------------------------------------------------------------- exposures

export interface ExposureRow {
  id: string;
  sessionId: string;
  kind: ExposureKind;
  affectedSkillIds: string[];
  contentRef: string;
  recordedAt: number;
  recordOrder: number;
}

export function insertExposure(
  db: DB,
  e: { sessionId: string; kind: ExposureKind; affectedSkillIds: string[]; contentRef: string; recordedAt: number },
): ExposureRow {
  const id = newId();
  const order = nextRecordOrder(db);
  db.prepare(
    "INSERT INTO exposures (id, session_id, kind, affected_skill_ids_json, content_ref, recorded_at, record_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, e.sessionId, e.kind, JSON.stringify(e.affectedSkillIds), e.contentRef, e.recordedAt, order);
  return { id, ...e, recordOrder: order };
}

export function listExposures(db: DB, sessionId: string): ExposureRow[] {
  return (
    db.prepare("SELECT * FROM exposures WHERE session_id = ? ORDER BY record_order").all(sessionId) as {
      id: string;
      session_id: string;
      kind: ExposureKind;
      affected_skill_ids_json: string;
      content_ref: string;
      recorded_at: number;
      record_order: number;
    }[]
  ).map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    kind: r.kind,
    affectedSkillIds: json(r.affected_skill_ids_json),
    contentRef: r.content_ref,
    recordedAt: r.recorded_at,
    recordOrder: r.record_order,
  }));
}

/** Skill ids exposed in this session so far (all exposure kinds count). */
export function exposedSkillsSoFar(db: DB, sessionId: string): Set<string> {
  const out = new Set<string>();
  for (const e of listExposures(db, sessionId)) for (const s of e.affectedSkillIds) out.add(s);
  return out;
}

// ---------------------------------------------------------------- attempts

export interface AttemptRow {
  id: string;
  sessionId: string;
  sessionQuestionId: string;
  submissionKey: string;
  answer: string;
  dontKnow: boolean;
  declaredAssistance: boolean;
  confidence: "low" | "medium" | "high" | null;
  phase: AttemptPhase;
  exposureSnapshot: string[];
  status: AttemptStatus;
  leaseToken: string | null;
  leaseUntil: number | null;
  lastError: string | null;
  feedbackWithheld: boolean;
  submittedAt: number;
  recordOrder: number;
}

interface RawAttempt {
  id: string;
  session_id: string;
  session_question_id: string;
  submission_key: string;
  answer: string;
  dont_know: number;
  declared_assistance: number;
  confidence: AttemptRow["confidence"];
  phase: AttemptPhase;
  exposure_snapshot_json: string;
  status: AttemptStatus;
  lease_token: string | null;
  lease_until: number | null;
  last_error: string | null;
  feedback_withheld: number;
  submitted_at: number;
  record_order: number;
}
const mapAttempt = (r: RawAttempt): AttemptRow => ({
  id: r.id,
  sessionId: r.session_id,
  sessionQuestionId: r.session_question_id,
  submissionKey: r.submission_key,
  answer: r.answer,
  dontKnow: !!r.dont_know,
  declaredAssistance: !!r.declared_assistance,
  confidence: r.confidence,
  phase: r.phase,
  exposureSnapshot: json(r.exposure_snapshot_json),
  status: r.status,
  leaseToken: r.lease_token,
  leaseUntil: r.lease_until,
  lastError: r.last_error,
  feedbackWithheld: !!r.feedback_withheld,
  submittedAt: r.submitted_at,
  recordOrder: r.record_order,
});

export function insertAttempt(
  db: DB,
  a: Omit<AttemptRow, "id" | "recordOrder" | "leaseToken" | "leaseUntil" | "lastError" | "feedbackWithheld">,
): AttemptRow {
  const id = newId();
  const order = nextRecordOrder(db);
  db.prepare(
    `INSERT INTO attempts (id, session_id, session_question_id, submission_key, answer, dont_know, declared_assistance, confidence,
       phase, exposure_snapshot_json, status, submitted_at, record_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    a.sessionId,
    a.sessionQuestionId,
    a.submissionKey,
    a.answer,
    a.dontKnow ? 1 : 0,
    a.declaredAssistance ? 1 : 0,
    a.confidence,
    a.phase,
    JSON.stringify(a.exposureSnapshot),
    a.status,
    a.submittedAt,
    order,
  );
  return getAttempt(db, id)!;
}

export function getAttempt(db: DB, id: string): AttemptRow | null {
  const r = db.prepare("SELECT * FROM attempts WHERE id = ?").get(id) as RawAttempt | undefined;
  return r ? mapAttempt(r) : null;
}

export function getAttemptByKey(db: DB, sessionId: string, key: string): AttemptRow | null {
  const r = db.prepare("SELECT * FROM attempts WHERE session_id = ? AND submission_key = ?").get(sessionId, key) as
    | RawAttempt
    | undefined;
  return r ? mapAttempt(r) : null;
}

export function listAttemptsForSessionQuestion(db: DB, sqId: string): AttemptRow[] {
  return (
    db.prepare("SELECT * FROM attempts WHERE session_question_id = ? ORDER BY record_order").all(sqId) as RawAttempt[]
  ).map(mapAttempt);
}

export function listAttemptsForSession(db: DB, sessionId: string): AttemptRow[] {
  return (db.prepare("SELECT * FROM attempts WHERE session_id = ? ORDER BY record_order").all(sessionId) as RawAttempt[]).map(
    mapAttempt,
  );
}

/** Persisted assessing lease. Returns the token if this caller won the claim. */
export function claimAttemptLease(db: DB, attemptId: string, now: number, leaseMs: number): string | null {
  const token = newId();
  const res = db
    .prepare(
      `UPDATE attempts SET status = 'assessing', lease_token = ?, lease_until = ?
       WHERE id = ? AND NOT EXISTS (SELECT 1 FROM assessments WHERE attempt_id = attempts.id)
         AND (status IN ('pending', 'provider_error') OR (status = 'assessing' AND lease_until < ?))`,
    )
    .run(token, now + leaseMs, attemptId, now);
  return res.changes === 1 ? token : null;
}

/** Compare-and-set release after a provider error. */
export function failAttemptLease(db: DB, attemptId: string, token: string, error: string): boolean {
  const res = db
    .prepare(
      "UPDATE attempts SET status = 'provider_error', last_error = ?, lease_token = NULL, lease_until = NULL WHERE id = ? AND lease_token = ? AND status = 'assessing'",
    )
    .run(error, attemptId, token);
  return res.changes === 1;
}

/** Compare-and-set finalisation marker; caller inserts the assessment in the same transaction. */
export function completeAttemptLease(db: DB, attemptId: string, token: string | null): boolean {
  const res =
    token === null
      ? db.prepare("UPDATE attempts SET status = 'assessed', lease_token = NULL, lease_until = NULL, last_error = NULL WHERE id = ? AND status = 'pending'").run(attemptId)
      : db
          .prepare(
            "UPDATE attempts SET status = 'assessed', lease_token = NULL, lease_until = NULL, last_error = NULL WHERE id = ? AND lease_token = ? AND status = 'assessing'",
          )
          .run(attemptId, token);
  return res.changes === 1;
}

export function setFeedbackWithheld(db: DB, attemptId: string) {
  db.prepare("UPDATE attempts SET feedback_withheld = 1 WHERE id = ?").run(attemptId);
}

// ---------------------------------------------------------------- assessments

export interface AssessmentRow {
  id: string;
  attemptId: string;
  providerMode: ProviderMode;
  providerModel: string | null;
  promptVersion: string | null;
  usage: unknown;
  rubricVersion: number;
  criteria: CriterionJudgement[];
  possibleMisconception: string | null;
  problems: string[];
  outcome: AttemptOutcome;
  validity: Validity;
  excluded: boolean;
  excludedReason: string | null;
  excludedAt: number | null;
  assessedAt: number;
}

interface RawAssessment {
  id: string;
  attempt_id: string;
  provider_mode: ProviderMode;
  provider_model: string | null;
  prompt_version: string | null;
  usage_json: string | null;
  rubric_version: number;
  criteria_json: string;
  possible_misconception: string | null;
  problems_json: string;
  outcome: AttemptOutcome;
  validity: Validity;
  excluded: number;
  excluded_reason: string | null;
  excluded_at: number | null;
  assessed_at: number;
}
const mapAssessment = (r: RawAssessment): AssessmentRow => ({
  id: r.id,
  attemptId: r.attempt_id,
  providerMode: r.provider_mode,
  providerModel: r.provider_model,
  promptVersion: r.prompt_version,
  usage: json(r.usage_json),
  rubricVersion: r.rubric_version,
  criteria: json(r.criteria_json),
  possibleMisconception: r.possible_misconception,
  problems: json(r.problems_json),
  outcome: r.outcome,
  validity: r.validity,
  excluded: !!r.excluded,
  excludedReason: r.excluded_reason,
  excludedAt: r.excluded_at,
  assessedAt: r.assessed_at,
});

export function insertAssessment(db: DB, a: Omit<AssessmentRow, "id" | "excluded" | "excludedReason" | "excludedAt">): string {
  const id = newId();
  db.prepare(
    `INSERT INTO assessments (id, attempt_id, provider_mode, provider_model, prompt_version, usage_json, rubric_version, criteria_json,
       possible_misconception, problems_json, outcome, validity, assessed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    a.attemptId,
    a.providerMode,
    a.providerModel,
    a.promptVersion,
    a.usage === undefined || a.usage === null ? null : JSON.stringify(a.usage),
    a.rubricVersion,
    JSON.stringify(a.criteria),
    a.possibleMisconception,
    JSON.stringify(a.problems),
    a.outcome,
    a.validity,
    a.assessedAt,
  );
  return id;
}

export function getAssessmentForAttempt(db: DB, attemptId: string): AssessmentRow | null {
  const r = db.prepare("SELECT * FROM assessments WHERE attempt_id = ?").get(attemptId) as RawAssessment | undefined;
  return r ? mapAssessment(r) : null;
}

export function getAssessment(db: DB, id: string): AssessmentRow | null {
  const r = db.prepare("SELECT * FROM assessments WHERE id = ?").get(id) as RawAssessment | undefined;
  return r ? mapAssessment(r) : null;
}

export function excludeAssessment(db: DB, id: string, reason: string, at: number): boolean {
  return db.prepare("UPDATE assessments SET excluded = 1, excluded_reason = ?, excluded_at = ? WHERE id = ? AND excluded = 0").run(reason, at, id)
    .changes === 1;
}

// ---------------------------------------------------------------- evidence inputs & review states

/** All attempts for a skill joined with session mode and assessment, in submission order. */
export function evidenceAttemptsForSkill(db: DB, skillId: string): EvidenceAttempt[] {
  const rows = db
    .prepare(
      `SELECT a.id AS attempt_id, a.session_id, a.submitted_at, a.record_order, s.mode, a.phase, a.exposure_snapshot_json,
              a.declared_assistance, sq.frozen_question_json, asm.outcome, asm.validity, asm.excluded
       FROM attempts a
       JOIN session_questions sq ON sq.id = a.session_question_id
       JOIN sessions s ON s.id = a.session_id
       LEFT JOIN assessments asm ON asm.attempt_id = a.id
       WHERE sq.skill_id = ?
       ORDER BY a.record_order`,
    )
    .all(skillId) as {
    attempt_id: string;
    session_id: string;
    submitted_at: number;
    record_order: number;
    mode: SessionMode;
    phase: AttemptPhase;
    exposure_snapshot_json: string;
    declared_assistance: number;
    frozen_question_json: string;
    outcome: AttemptOutcome | null;
    validity: Validity | null;
    excluded: number | null;
  }[];
  return rows.map((r) => {
    const q = json<QuestionPrivate>(r.frozen_question_json);
    return {
      attemptId: r.attempt_id,
      sessionId: r.session_id,
      submittedAt: r.submitted_at,
      recordOrder: r.record_order,
      mode: r.mode,
      phase: r.phase,
      exposedBeforeSubmission: json<string[]>(r.exposure_snapshot_json).includes(skillId),
      declaredAssistance: !!r.declared_assistance,
      outcome: r.outcome,
      validity: r.validity,
      excluded: !!r.excluded,
      familyId: q.familyId,
      isTransfer: q.isTransfer,
    };
  });
}

export function upsertReviewState(db: DB, skillId: string, skillVersion: number, s: SkillReviewState, now: number) {
  db.prepare(
    `INSERT INTO review_states (skill_id, skill_version, evidence_state, epoch, stage, due_at, last_pass_at, reassessment_needed, detail_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (skill_id, skill_version) DO UPDATE SET evidence_state = excluded.evidence_state, epoch = excluded.epoch,
       stage = excluded.stage, due_at = excluded.due_at, last_pass_at = excluded.last_pass_at,
       reassessment_needed = excluded.reassessment_needed, detail_json = excluded.detail_json, updated_at = excluded.updated_at`,
  ).run(
    skillId,
    skillVersion,
    s.evidenceState,
    s.epoch,
    s.stage,
    s.dueAt,
    s.lastPassAt,
    s.reassessmentNeeded ? 1 : 0,
    JSON.stringify(s),
    now,
  );
}

export function getReviewState(db: DB, skillId: string, skillVersion: number): SkillReviewState | null {
  const r = db
    .prepare("SELECT detail_json FROM review_states WHERE skill_id = ? AND skill_version = ?")
    .get(skillId, skillVersion) as { detail_json: string } | undefined;
  return r ? json<SkillReviewState>(r.detail_json) : null;
}

export type { EvidenceState };
