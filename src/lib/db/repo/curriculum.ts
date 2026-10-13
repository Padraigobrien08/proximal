// Repository: courses, topics, units and skills. Parameterised SQL only.
import type { SourceRef } from "../../domain/types";
import { json, newId, type DB } from "./shared";

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

/** Set a unit's checked teaching explanation (owner-approved). */
export function setUnitExplanation(db: DB, id: string, explanation: string, workedExample: string | null) {
  db.prepare("UPDATE units SET explanation = ?, worked_example = ? WHERE id = ?").run(explanation, workedExample, id);
}

export function deleteUnit(db: DB, id: string) {
  db.prepare("DELETE FROM units WHERE id = ?").run(id);
}

export interface SkillRow {
  id: string;
  unitId: string;
  objective: string;
  /** Short display copy (optional; falls back to the objective). */
  label: string | null;
  summary: string | null;
  required: boolean;
  transferRequired: boolean;
  version: number;
  position: number;
}

interface RawSkill {
  id: string;
  unit_id: string;
  objective: string;
  label: string | null;
  summary: string | null;
  required: number;
  transfer_required: number;
  version: number;
  position: number;
}
const mapSkill = (r: RawSkill): SkillRow => ({
  id: r.id,
  unitId: r.unit_id,
  objective: r.objective,
  label: r.label,
  summary: r.summary,
  required: !!r.required,
  transferRequired: !!r.transfer_required,
  version: r.version,
  position: r.position,
});

export function insertSkill(
  db: DB,
  s: {
    id?: string;
    unitId: string;
    objective: string;
    label?: string | null;
    summary?: string | null;
    required: boolean;
    transferRequired: boolean;
    version?: number;
    position: number;
  },
): string {
  const id = s.id ?? newId();
  db.prepare(
    "INSERT INTO skills (id, unit_id, objective, label, summary, required, transfer_required, version, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, s.unitId, s.objective, s.label ?? null, s.summary ?? null, s.required ? 1 : 0, s.transferRequired ? 1 : 0, s.version ?? 1, s.position);
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
