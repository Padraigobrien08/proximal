// Idempotent demo seed. Inserts missing demo content only; never modifies learner records or uploads.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { CurriculumFixture, LectureFixture, PacerContextsFixture, QuestionBank } from "../content/schemas";
import { getPacerContext, upsertPacerContext } from "../db/pacerRepo";
import {
  getCourse,
  getQuestion,
  getSource,
  insertCourse,
  insertQuestion,
  insertSkill,
  insertSource,
  insertTopic,
  insertUnit,
  replaceSourcePages,
  updateQuestionContent,
} from "../db/repo";
import { extractPdfText } from "../pdf/extract";
import { generateSampleLecturePdf } from "../pdf/generate-sample";

export const DEMO_COURSE_ID = "demo-course";
export const DEMO_SOURCE_ID = "demo-source-lecture";
export const DEMO_SOURCE_FILE = "demo-sample-lecture.pdf";

export interface SeedInput {
  db: Database.Database;
  now: number;
  dataDir: string;
  samplePdfPath: string;
  fixtures: { curriculum: CurriculumFixture; lecture: LectureFixture; bank: QuestionBank; pacer?: PacerContextsFixture };
}

/** Generate the sample lecture PDF from the lecture fixture; rewrite only when the bytes change (deterministic output). */
export async function ensureSamplePdf(samplePdfPath: string, lecture: LectureFixture): Promise<{ sha256: string; created: boolean }> {
  const bytes = Buffer.from(await generateSampleLecturePdf(lecture));
  const current = existsSync(samplePdfPath) ? readFileSync(samplePdfPath) : null;
  const created = !current || !current.equals(bytes);
  if (created) {
    mkdirSync(path.dirname(samplePdfPath), { recursive: true });
    writeFileSync(samplePdfPath, bytes);
  }
  return { sha256: createHash("sha256").update(bytes).digest("hex"), created };
}

export async function seedDemo(input: SeedInput) {
  const { db, now, dataDir, fixtures } = input;
  const report = {
    courseCreated: false,
    questionsInserted: 0,
    questionsUpdated: 0,
    sourceCreated: false,
    sourceRefreshed: false,
    unitsRefreshed: 0,
    pdfCreated: false,
    pacerContextsUpdated: 0,
  };
  const pdf = await ensureSamplePdf(input.samplePdfPath, fixtures.lecture);
  report.pdfCreated = pdf.created;

  const bytes = readFileSync(input.samplePdfPath);
  const pages = await extractPdfText(bytes);

  db.transaction(() => {
    if (!getCourse(db, DEMO_COURSE_ID)) {
      report.courseCreated = true;
      insertCourse(db, {
        id: DEMO_COURSE_ID,
        title: fixtures.curriculum.course.title,
        isDemo: true,
        status: "approved",
        notice: "Demo content: authored fixture questions, not yet owner-reviewed.",
        createdAt: now,
      });
      for (const t of fixtures.curriculum.topics) {
        insertTopic(db, { id: t.id, courseId: DEMO_COURSE_ID, title: t.title, position: t.position });
        t.units.forEach((u, ui) => {
          insertUnit(db, {
            id: u.id,
            topicId: t.id,
            title: u.title,
            objective: u.objective,
            approvalStatus: "approved",
            sourceRefs: u.sourcePages.map((page) => ({ page })),
            explanation: u.explanation,
            workedExample: u.workedExample,
            position: ui,
          });
          u.skills.forEach((s, si) =>
            insertSkill(db, {
              id: s.id,
              unitId: u.id,
              objective: s.objective,
              label: s.label ?? null,
              summary: s.summary ?? null,
              required: s.required,
              transferRequired: s.transferRequired,
              position: si,
            }),
          );
        });
      }
    }
    if (!getSource(db, DEMO_SOURCE_ID)) {
      report.sourceCreated = true;
      insertSource(db, {
        id: DEMO_SOURCE_ID,
        courseId: DEMO_COURSE_ID,
        sha256: pdf.sha256,
        originalName: fixtures.lecture.fileName,
        label: fixtures.lecture.label,
        storedPath: DEMO_SOURCE_FILE,
        pageCount: pages.length,
        status: "extracted",
        error: null,
        createdAt: now,
      });
      replaceSourcePages(
        db,
        DEMO_SOURCE_ID,
        pages.map((p) => ({ pageNumber: p.pageNumber, text: p.text, lowTextWarning: p.lowTextWarning })),
      );
    }
    // Demo source text follows the lecture fixture (only the demo source; never user uploads).
    const demoSource = getSource(db, DEMO_SOURCE_ID);
    if (demoSource && !report.sourceCreated && demoSource.sha256 !== pdf.sha256) {
      db.prepare("UPDATE sources SET sha256 = ?, page_count = ? WHERE id = ?").run(pdf.sha256, pages.length, DEMO_SOURCE_ID);
      replaceSourcePages(
        db,
        DEMO_SOURCE_ID,
        pages.map((p) => ({ pageNumber: p.pageNumber, text: p.text, lowTextWarning: p.lowTextWarning })),
      );
      report.sourceRefreshed = true;
    }
    // Checked explanations are instructional content, not evidence: keep demo units in step with the fixture.
    for (const t of fixtures.curriculum.topics) {
      for (const u of t.units) {
        const res = db
          .prepare(
            "UPDATE units SET explanation = ?, worked_example = ? WHERE id = ? AND (explanation IS NOT ? OR worked_example IS NOT ?)",
          )
          .run(u.explanation, u.workedExample, u.id, u.explanation, u.workedExample);
        report.unitsRefreshed += res.changes;
      }
    }
    // Short display copy for demo skills (not evidence-bearing).
    for (const t of fixtures.curriculum.topics) {
      for (const u of t.units) {
        for (const sk of u.skills) {
          db.prepare("UPDATE skills SET label = ?, summary = ? WHERE id = ? AND (label IS NOT ? OR summary IS NOT ?)").run(
            sk.label ?? null,
            sk.summary ?? null,
            sk.id,
            sk.label ?? null,
            sk.summary ?? null,
          );
        }
      }
    }
    for (const q of fixtures.bank.questions) {
      const existing = getQuestion(db, q.id);
      if (!existing) {
        insertQuestion(db, q);
        report.questionsInserted += 1;
      } else if (existing.status === "authored_fixture" && q.version > existing.version) {
        // Newer authored version of an unreviewed fixture. Owner-reviewed/excluded questions are never changed;
        // sessions that used the old version keep their frozen copy.
        updateQuestionContent(db, q);
        report.questionsUpdated += 1;
      }
    }
    // Authored PACER learning contexts: inserted or replaced only by a newer context version. A change makes earlier
    // classification decisions stale for new sessions; it never touches learner records.
    for (const c of fixtures.pacer?.skills ?? []) {
      if (!db.prepare("SELECT 1 FROM skills WHERE id = ?").get(c.skillId)) continue;
      const existing = getPacerContext(db, c.skillId);
      if (existing && existing.contextVersion >= c.contextVersion) continue;
      upsertPacerContext(db, {
        skillId: c.skillId,
        contextVersion: c.contextVersion,
        learningGoal: c.learningGoal,
        memoryRequirement: c.memoryRequirement,
        auxChunks: c.auxChunks,
        material: c.material,
        updatedAt: now,
      });
      report.pacerContextsUpdated += 1;
    }
  })();

  const uploads = path.join(dataDir, "uploads");
  mkdirSync(uploads, { recursive: true });
  const dest = path.join(uploads, DEMO_SOURCE_FILE);
  if (!existsSync(dest) || !readFileSync(dest).equals(readFileSync(input.samplePdfPath))) copyFileSync(input.samplePdfPath, dest);
  return report;
}

export interface DemoResetReport {
  sessions: number;
  chatThreads: number;
  decisions: number;
  connections: number;
  jobs: number;
}

/**
 * Clears every learner record for the DEMO course: sessions (with their attempts, exposures, assessments and
 * activity responses), study runs, review states, chat threads (with messages and skill touches, which otherwise
 * count as recent help), learning-approach decisions, learner connections and grading jobs for demo attempts.
 * Authored content, model proposals, imported courses and uploads are untouched. Call seedDemo afterwards.
 */
export function resetDemoLearner(db: Database.Database): DemoResetReport {
  const course = db.prepare("SELECT is_demo FROM courses WHERE id = ?").get(DEMO_COURSE_ID) as { is_demo: number } | undefined;
  if (course && course.is_demo !== 1) throw new Error("Guard: the demo course id exists but is not marked as demo. Refusing to reset.");
  const demoTopics = "SELECT id FROM topics WHERE course_id = @course";
  const demoSkills = "SELECT s.id FROM skills s JOIN units u ON u.id = s.unit_id JOIN topics t ON t.id = u.topic_id WHERE t.course_id = @course";
  const demoSessions = `SELECT id FROM sessions WHERE is_demo = 1 AND topic_id IN (${demoTopics})`;
  const p = { course: DEMO_COURSE_ID };
  return db.transaction((): DemoResetReport => {
    // Grading jobs reference attempts by id (no foreign key): remove them before their attempts go.
    const jobs = db
      .prepare(`DELETE FROM jobs WHERE kind = 'assess_attempt' AND ref_id IN (SELECT id FROM attempts WHERE session_id IN (${demoSessions}))`)
      .run(p).changes;
    // Study runs that worked through demo sessions go with them.
    db.prepare(
      `DELETE FROM study_runs WHERE id IN (SELECT run_id FROM study_run_steps WHERE session_id IN (${demoSessions}))`,
    ).run(p);
    const sessions = db.prepare(`DELETE FROM sessions WHERE id IN (${demoSessions})`).run(p).changes;
    db.prepare(`DELETE FROM review_states WHERE skill_id IN (${demoSkills})`).run(p);
    const chatThreads = db.prepare("DELETE FROM chat_threads WHERE course_id = @course").run(p).changes;
    const decisions = db.prepare(`DELETE FROM pacer_decisions WHERE skill_id IN (${demoSkills})`).run(p).changes;
    const connections = db.prepare(`DELETE FROM pacer_learner_connections WHERE skill_id IN (${demoSkills})`).run(p).changes;
    return { sessions, chatThreads, decisions, connections, jobs };
  })();
}
