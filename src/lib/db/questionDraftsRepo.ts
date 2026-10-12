// Question draft repository. Parameterised SQL only. Drafts are never read by question selection.
import type Database from "better-sqlite3";
import { newId } from "./repo";

type DB = Database.Database;

export type QuestionDraftStatus = "draft" | "approved" | "rejected" | "invalid";

export interface QuestionDraftRow {
  id: string;
  skillId: string;
  skillVersion: number;
  batchId: string;
  position: number;
  status: QuestionDraftStatus;
  /** DraftQuestion when valid; the raw candidate when invalid. */
  question: unknown;
  problems: string[];
  edited: boolean;
  /** The owner opened the answer key; the draft can then only become a practice question. */
  answerSeen: boolean;
  providerMode: "mock" | "live";
  providerModel: string | null;
  promptVersion: string;
  createdAt: number;
  decidedAt: number | null;
  questionId: string | null;
}

interface RawDraft {
  id: string;
  skill_id: string;
  skill_version: number;
  batch_id: string;
  position: number;
  status: QuestionDraftStatus;
  question_json: string;
  problems_json: string;
  edited: number;
  answer_seen: number;
  provider_mode: "mock" | "live";
  provider_model: string | null;
  prompt_version: string;
  created_at: number;
  decided_at: number | null;
  question_id: string | null;
}

const mapDraft = (r: RawDraft): QuestionDraftRow => ({
  id: r.id,
  skillId: r.skill_id,
  skillVersion: r.skill_version,
  batchId: r.batch_id,
  position: r.position,
  status: r.status,
  question: JSON.parse(r.question_json),
  problems: JSON.parse(r.problems_json),
  edited: !!r.edited,
  answerSeen: !!r.answer_seen,
  providerMode: r.provider_mode,
  providerModel: r.provider_model,
  promptVersion: r.prompt_version,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  questionId: r.question_id,
});

export function insertQuestionDraft(
  db: DB,
  d: Omit<QuestionDraftRow, "id" | "edited" | "answerSeen" | "decidedAt" | "questionId">,
): string {
  const id = newId();
  db.prepare(
    `INSERT INTO question_drafts (id, skill_id, skill_version, batch_id, position, status, question_json, problems_json,
       provider_mode, provider_model, prompt_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    d.skillId,
    d.skillVersion,
    d.batchId,
    d.position,
    d.status,
    JSON.stringify(d.question),
    JSON.stringify(d.problems),
    d.providerMode,
    d.providerModel,
    d.promptVersion,
    d.createdAt,
  );
  return id;
}

export function getQuestionDraft(db: DB, id: string): QuestionDraftRow | null {
  const r = db.prepare("SELECT * FROM question_drafts WHERE id = ?").get(id) as RawDraft | undefined;
  return r ? mapDraft(r) : null;
}

export function listQuestionDraftsForSkill(db: DB, skillId: string): QuestionDraftRow[] {
  return (
    db.prepare("SELECT * FROM question_drafts WHERE skill_id = ? ORDER BY created_at, batch_id, position").all(skillId) as RawDraft[]
  ).map(mapDraft);
}

export function updateQuestionDraftContent(db: DB, id: string, question: unknown, status: "draft" | "invalid", problems: string[]) {
  db.prepare("UPDATE question_drafts SET question_json = ?, status = ?, problems_json = ?, edited = 1 WHERE id = ?").run(
    JSON.stringify(question),
    status,
    JSON.stringify(problems),
    id,
  );
}

export function markDraftAnswerSeen(db: DB, id: string) {
  db.prepare("UPDATE question_drafts SET answer_seen = 1 WHERE id = ?").run(id);
}

/** The draft an approved question came from, if any. */
export function draftForQuestion(db: DB, questionId: string): QuestionDraftRow | null {
  const r = db.prepare("SELECT * FROM question_drafts WHERE question_id = ?").get(questionId) as RawDraft | undefined;
  return r ? mapDraft(r) : null;
}

/** Compare-and-set decision: only a row still in `from` changes. Returns whether it did. */
export function decideQuestionDraft(
  db: DB,
  id: string,
  from: QuestionDraftStatus[],
  to: "approved" | "rejected",
  at: number,
  questionId: string | null,
): boolean {
  const placeholders = from.map(() => "?").join(", ");
  const res = db
    .prepare(`UPDATE question_drafts SET status = ?, decided_at = ?, question_id = ? WHERE id = ? AND status IN (${placeholders})`)
    .run(to, at, questionId, id, ...from);
  return res.changes === 1;
}
