// Repository: assessment questions. Parameterised SQL only.
import type { QuestionPrivate, QuestionStatus, TaskType } from "../../domain/types";
import type { ExampleFixture } from "../../content/schemas";
import { json, type DB } from "./shared";

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
  practice_only: number;
}

export type QuestionRecord = QuestionPrivate & {
  examples: ExampleFixture[];
  reviewedBy: string | null;
  reviewedAt: number | null;
  /** Never selected for an independent check (e.g. the owner saw its answer key during review). */
  practiceOnly: boolean;
};

/** A question an independent check may use. */
export const usableForChecks = (q: Pick<QuestionRecord, "status" | "practiceOnly">) => q.status !== "excluded" && !q.practiceOnly;

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
  practiceOnly: !!r.practice_only,
});

export function insertQuestion(db: DB, q: QuestionPrivate & { examples: ExampleFixture[]; practiceOnly?: boolean }) {
  db.prepare(
    `INSERT INTO questions (id, skill_id, version, family_id, is_transfer, task_type, prompt, reference_json, rubric_json,
       hints_json, source_refs_json, reveal_skill_ids_json, examples_json, status, practice_only)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    q.practiceOnly ? 1 : 0,
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
