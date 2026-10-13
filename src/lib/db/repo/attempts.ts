// Repository: attempts (with assessment leases) and assessments. Parameterised SQL only.
import type {
  AttemptOutcome,
  AttemptPhase,
  AttemptStatus,
  CriterionJudgement,
  ProviderMode,
  Validity,
} from "../../domain/types";
import { json, newId, nextRecordOrder, type DB } from "./shared";

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
