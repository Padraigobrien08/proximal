// Repository: sessions, their frozen questions, and exposures. Parameterised SQL only.
import type { ExposureKind, QuestionPrivate, SessionMode } from "../../domain/types";
import { json, newId, nextRecordOrder, type DB } from "./shared";

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
