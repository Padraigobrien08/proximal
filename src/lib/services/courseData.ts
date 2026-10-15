// Local data utilities for one course: JSON export of its curriculum, questions and learner records, and deletion
// of the course with every dependent record and uploaded file. Used by scripts/export-course.ts and delete-course.ts.
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { notFound } from "./errors";

const TOPICS = "SELECT id FROM topics WHERE course_id = @course";
const SKILLS = "SELECT s.id FROM skills s JOIN units u ON u.id = s.unit_id JOIN topics t ON t.id = u.topic_id WHERE t.course_id = @course";
const SESSIONS = `SELECT id FROM sessions WHERE topic_id IN (${TOPICS})`;
const RUNS = `SELECT id FROM study_runs WHERE scope_course_id = @course OR id IN (SELECT run_id FROM study_run_steps WHERE session_id IN (${SESSIONS}))`;

/**
 * Curriculum, reviewed questions, sources (metadata only) and every learner record for the course. Excludes
 * secrets/env and drafted (unreviewed) content. Reference answers and examples are omitted unless requested.
 */
export function exportCourseData(db: Database.Database, courseId: string, opts: { includeReferenceAnswers: boolean; now: number }) {
  const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(courseId);
  if (!course) throw notFound(`Course ${courseId}`);
  const p = { course: courseId };
  const all = (sql: string) => db.prepare(sql).all(p) as Record<string, unknown>[];
  const includeRef = opts.includeReferenceAnswers;
  return {
    exportedAt: new Date(opts.now).toISOString(),
    note: `Local export. No environment variables or API keys are included. Reference answers ${includeRef ? "ARE included" : "are omitted"}. Unreviewed drafts are not exported.`,
    course,
    topics: all("SELECT * FROM topics WHERE course_id = @course"),
    units: all(`SELECT * FROM units WHERE topic_id IN (${TOPICS})`),
    skills: all(`SELECT * FROM skills WHERE id IN (${SKILLS})`),
    questions: all(`SELECT * FROM questions WHERE skill_id IN (${SKILLS})`).map((q) =>
      includeRef ? q : { ...q, reference_json: "[omitted: pass --include-reference-answers]", examples_json: "[omitted]" },
    ),
    sources: all("SELECT id, course_id, sha256, original_name, label, page_count, status, error, created_at FROM sources WHERE course_id = @course"),
    sessions: all(`SELECT * FROM sessions WHERE id IN (${SESSIONS})`),
    sessionQuestions: all(`SELECT * FROM session_questions WHERE session_id IN (${SESSIONS})`).map((sq) =>
      includeRef ? sq : { ...sq, frozen_question_json: "[omitted: contains reference answer]" },
    ),
    attempts: all(`SELECT * FROM attempts WHERE session_id IN (${SESSIONS})`),
    exposures: all(`SELECT * FROM exposures WHERE session_id IN (${SESSIONS})`),
    assessments: all(`SELECT * FROM assessments WHERE attempt_id IN (SELECT id FROM attempts WHERE session_id IN (${SESSIONS}))`),
    reviewStates: all(`SELECT * FROM review_states WHERE skill_id IN (${SKILLS})`),
    approachDecisions: all(`SELECT * FROM pacer_decisions WHERE skill_id IN (${SKILLS})`),
    learnerConnections: all(`SELECT * FROM pacer_learner_connections WHERE skill_id IN (${SKILLS})`),
    activities: all(`SELECT * FROM pacer_activities WHERE session_id IN (${SESSIONS})`),
    activityResponses: all(`SELECT * FROM pacer_responses WHERE session_id IN (${SESSIONS})`),
    chatThreads: all("SELECT * FROM chat_threads WHERE course_id = @course"),
    chatMessages: all("SELECT * FROM chat_messages WHERE thread_id IN (SELECT id FROM chat_threads WHERE course_id = @course)"),
    chatSkillTouches: all(`SELECT * FROM chat_skill_touches WHERE skill_id IN (${SKILLS})`),
    studyRuns: all(`SELECT * FROM study_runs WHERE id IN (${RUNS})`),
    studyRunSteps: all(`SELECT * FROM study_run_steps WHERE run_id IN (${RUNS})`),
  };
}

/** Delete the course, every dependent record (including jobs, which reference skills/attempts by id only) and its uploads. */
export function deleteCourseData(db: Database.Database, dataDir: string, courseId: string) {
  const course = db.prepare("SELECT id, title, is_demo FROM courses WHERE id = ?").get(courseId) as
    | { id: string; title: string; is_demo: number }
    | undefined;
  if (!course) throw notFound(`Course ${courseId}`);
  const p = { course: courseId };
  const files = (db.prepare("SELECT stored_path FROM sources WHERE course_id = @course").all(p) as { stored_path: string }[]).map((r) =>
    path.join(dataDir, "uploads", path.basename(r.stored_path)),
  );
  db.transaction(() => {
    db.prepare(`DELETE FROM jobs WHERE kind = 'assess_attempt' AND ref_id IN (SELECT id FROM attempts WHERE session_id IN (${SESSIONS}))`).run(p);
    db.prepare(`DELETE FROM jobs WHERE kind IN ('draft_questions', 'draft_material') AND ref_id IN (${SKILLS})`).run(p);
    // session_questions reference questions without cascade; remove learner records first.
    db.prepare(`DELETE FROM sessions WHERE id IN (${SESSIONS})`).run(p);
    db.prepare(`DELETE FROM review_states WHERE skill_id IN (${SKILLS})`).run(p);
    db.prepare("DELETE FROM courses WHERE id = @course").run(p);
  })();
  for (const f of files) if (existsSync(f)) rmSync(f);
  return { title: course.title, isDemo: course.is_demo === 1, files: files.length };
}
