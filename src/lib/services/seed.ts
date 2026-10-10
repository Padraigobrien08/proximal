// Idempotent demo seed. Inserts missing demo content only; never modifies learner records or uploads.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { CurriculumFixture, LectureFixture, QuestionBank } from "../content/schemas";
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
  fixtures: { curriculum: CurriculumFixture; lecture: LectureFixture; bank: QuestionBank };
}

/** Generate the sample lecture PDF if missing. Deterministic bytes (fixed metadata dates). */
export async function ensureSamplePdf(samplePdfPath: string, lecture: LectureFixture): Promise<{ sha256: string; created: boolean }> {
  let created = false;
  if (!existsSync(samplePdfPath)) {
    mkdirSync(path.dirname(samplePdfPath), { recursive: true });
    writeFileSync(samplePdfPath, await generateSampleLecturePdf(lecture));
    created = true;
  }
  return { sha256: createHash("sha256").update(readFileSync(samplePdfPath)).digest("hex"), created };
}

export async function seedDemo(input: SeedInput) {
  const { db, now, dataDir, fixtures } = input;
  const report = { courseCreated: false, questionsInserted: 0, sourceCreated: false, pdfCreated: false };
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
    for (const q of fixtures.bank.questions) {
      if (getQuestion(db, q.id)) continue; // never overwrite: questions are immutable once seeded
      insertQuestion(db, q);
      report.questionsInserted += 1;
    }
  })();

  const uploads = path.join(dataDir, "uploads");
  mkdirSync(uploads, { recursive: true });
  const dest = path.join(uploads, DEMO_SOURCE_FILE);
  if (!existsSync(dest)) copyFileSync(input.samplePdfPath, dest);
  return report;
}
