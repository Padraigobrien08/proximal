import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SAMPLE_PDF_PATH } from "../../src/lib/content/fixtures";
import { askChat } from "../../src/lib/services/chat";
import { deleteCourseData, exportCourseData } from "../../src/lib/services/courseData";
import { approveCourse, importPdf } from "../../src/lib/services/imports";
import { reviewClassification, setSkillConnection } from "../../src/lib/services/pacer";
import { requestQuestionDrafts } from "../../src/lib/services/questionDrafts";
import { DEMO_COURSE_ID } from "../../src/lib/services/seed";
import { getSessionView, reveal, startSession, submitAnswer } from "../../src/lib/services/sessions";
import { getCourseView } from "../../src/lib/services/views";
import type { AppContext } from "../../src/lib/services/context";
import { createTestContext, exampleAnswer } from "../helpers";

const BCE = "demo-topic-bce";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

async function setup() {
  const t = await createTestContext();
  cleanup = t.cleanup;
  return t;
}

/** Row count of every table, and the uploaded files on disk. */
function snapshot(ctx: AppContext, dir: string) {
  const tables = (ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
  const uploads = path.join(dir, "uploads");
  return {
    rows: Object.fromEntries(tables.map((t) => [t, (ctx.db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n])),
    uploads: existsSync(uploads) ? readdirSync(uploads).sort() : [],
  };
}

/** A check answer, a chat question, an approach choice and a learner connection on the demo course. */
async function demoActivity(ctx: AppContext) {
  const { sessionId } = startSession(ctx, { topicId: BCE, mode: "review", skillIds: ["S4"] });
  const sq = getSessionView(ctx, sessionId).current!.sessionQuestionId;
  await submitAnswer(ctx, sessionId, { sessionQuestionId: sq, submissionKey: randomUUID(), answer: exampleAnswer("S4-A", "correct") });
  await askChat(ctx, DEMO_COURSE_ID, { question: "What does binary cross-entropy penalise?" });
  reviewClassification(ctx, "S4", { action: "dismiss", replacesDecisionId: null, proposalId: null });
  setSkillConnection(ctx, "S4", "Like log loss from my stats course");
}

/** An approved imported course with a learning session, chat, approach choice, connection and a drafting job. */
async function importedWithActivity(ctx: AppContext, dir: string) {
  const imported = await importPdf(ctx, dir, { name: "lecture.pdf", bytes: readFileSync(SAMPLE_PDF_PATH) });
  approveCourse(ctx, imported.courseId);
  const topic = getCourseView(ctx, imported.courseId).topics[0];
  const skillId = topic.units[0].skills[0].id;
  startSession(ctx, { topicId: topic.id, mode: "learn" });
  await askChat(ctx, imported.courseId, { question: "What is the likelihood?" });
  reviewClassification(ctx, skillId, { action: "dismiss", replacesDecisionId: null, proposalId: null });
  setSkillConnection(ctx, skillId, "Imported-course connection");
  requestQuestionDrafts(ctx, skillId);
  return imported.courseId;
}

describe("AC14: course export", () => {
  it("is valid JSON with every learner record for the course, omitting reference answers unless asked", async () => {
    const { ctx, dir } = await setup();
    await demoActivity(ctx);
    await importedWithActivity(ctx, dir); // another course's records must not leak into the demo export

    const json = JSON.stringify(exportCourseData(ctx.db, DEMO_COURSE_ID, { includeReferenceAnswers: false, now: ctx.clock.now() }));
    const data = JSON.parse(json);
    expect(data.course.id).toBe(DEMO_COURSE_ID);
    expect(data.attempts).toHaveLength(1);
    expect(data.assessments).toHaveLength(1);
    expect(data.exposures.length).toBeGreaterThan(0);
    expect(data.reviewStates.length).toBeGreaterThan(0);
    expect(data.chatThreads).toHaveLength(1);
    expect(data.chatMessages.map((m: { content: string }) => m.content)).toContain("What does binary cross-entropy penalise?");
    expect(data.chatSkillTouches.length).toBeGreaterThan(0);
    expect(data.approachDecisions).toHaveLength(1);
    expect(data.learnerConnections.map((c: { connection_text: string }) => c.connection_text)).toEqual(["Like log loss from my stats course"]);
    expect(json).not.toContain("Imported-course connection");
    expect(json).not.toContain("What is the likelihood?");

    expect(data.questions.length).toBeGreaterThan(0);
    for (const q of data.questions) expect(q.reference_json).toMatch(/^\[omitted/);
    for (const sq of data.sessionQuestions) expect(sq.frozen_question_json).toMatch(/^\[omitted/);
    expect(data).not.toHaveProperty("questionDrafts");

    const withRef = exportCourseData(ctx.db, DEMO_COURSE_ID, { includeReferenceAnswers: true, now: ctx.clock.now() });
    expect(withRef.questions.every((q) => !String(q.reference_json).startsWith("[omitted"))).toBe(true);
  });
});

describe("AC14: course deletion", () => {
  it("removes every dependent record and upload of an imported course, including its jobs, and nothing else", async () => {
    const { ctx, dir } = await setup();
    await demoActivity(ctx);
    const before = snapshot(ctx, dir);

    const courseId = await importedWithActivity(ctx, dir);
    expect(snapshot(ctx, dir).rows.jobs).toBeGreaterThan(before.rows.jobs);
    expect(snapshot(ctx, dir).uploads.length).toBe(before.uploads.length + 1);

    const res = deleteCourseData(ctx.db, dir, courseId);
    expect(res.files).toBe(1);
    expect(snapshot(ctx, dir)).toEqual(before);
    expect(ctx.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("removes grading jobs for the deleted course's attempts", async () => {
    const { ctx, dir } = await setup();
    await demoActivity(ctx);
    const gradingJobs = () => (ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'assess_attempt'").get() as { n: number }).n;
    expect(gradingJobs()).toBe(1);
    deleteCourseData(ctx.db, dir, DEMO_COURSE_ID);
    expect(gradingJobs()).toBe(0);
    expect(ctx.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("an explanation exposure in a deleted course leaves no orphaned learner rows", async () => {
    const { ctx, dir } = await setup();
    const before = snapshot(ctx, dir);
    const { sessionId } = startSession(ctx, { topicId: BCE, mode: "learn", skillIds: ["S4"] });
    await reveal(ctx, sessionId, { kind: "explanation", unitId: "U4" });
    deleteCourseData(ctx.db, dir, DEMO_COURSE_ID);
    const after = snapshot(ctx, dir);
    for (const t of ["sessions", "exposures", "review_states", "jobs"]) expect(after.rows[t]).toBe(0);
    expect(after.rows.courses).toBe(before.rows.courses - 1);
  });
});
