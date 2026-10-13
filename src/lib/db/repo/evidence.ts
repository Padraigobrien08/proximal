// Repository: evidence inputs and cached review states. Parameterised SQL only.
import type {
  AttemptOutcome,
  AttemptPhase,
  EvidenceAttempt,
  EvidenceState,
  QuestionPrivate,
  SessionMode,
  SkillReviewState,
  Validity,
} from "../../domain/types";
import { json, type DB } from "./shared";

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
