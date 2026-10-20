import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadFixtures, SAMPLE_PDF_PATH } from "../../src/lib/content/fixtures";
import { askChat } from "../../src/lib/services/chat";
import { currentSkillState } from "../../src/lib/services/evidence";
import { approveCourse, importPdf } from "../../src/lib/services/imports";
import { reviewClassification, setSkillConnection } from "../../src/lib/services/pacer";
import { DEMO_COURSE_ID, resetDemoLearner, seedDemo } from "../../src/lib/services/seed";
import { getSessionView, startSession, submitAnswer } from "../../src/lib/services/sessions";
import { getCourseView } from "../../src/lib/services/views";
import type { AppContext } from "../../src/lib/services/context";
import { createTestContext, exampleAnswer } from "../helpers";

const BCE = "demo-topic-bce";

/** Every table that holds learner (participant) records rather than authored content. */
const LEARNER_TABLES = [
  "sessions",
  "session_questions",
  "attempts",
  "exposures",
  "assessments",
  "review_states",
  "pacer_decisions",
  "pacer_activities",
  "pacer_responses",
  "pacer_learner_connections",
  "chat_threads",
  "chat_messages",
  "chat_skill_touches",
  "study_runs",
  "study_run_steps",
  "jobs",
];

function counts(ctx: AppContext): Record<string, number> {
  return Object.fromEntries(LEARNER_TABLES.map((t) => [t, (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));
}

function total(c: Record<string, number>): number {
  return Object.values(c).reduce((a, b) => a + b, 0);
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

async function answerCurrent(ctx: AppContext, sessionId: string, text: string) {
  const sq = getSessionView(ctx, sessionId).current!.sessionQuestionId;
  return submitAnswer(ctx, sessionId, { sessionQuestionId: sq, submissionKey: randomUUID(), answer: text });
}

describe("AC13: demo data", () => {
  it("a freshly seeded demo contains no learner records", async () => {
    const t = await createTestContext();
    cleanup = t.cleanup;
    expect(counts(t.ctx)).toEqual(Object.fromEntries(LEARNER_TABLES.map((name) => [name, 0])));
  });

  it("demo reset clears every demo learner record, including chat help, and leaves imported courses untouched", async () => {
    const t = await createTestContext();
    cleanup = t.cleanup;
    const { ctx, dir } = t;

    // An imported course with its own learner records.
    const imported = await importPdf(ctx, dir, { name: "lecture.pdf", bytes: readFileSync(SAMPLE_PDF_PATH) });
    approveCourse(ctx, imported.courseId);
    const importedTopic = getCourseView(ctx, imported.courseId).topics[0];
    startSession(ctx, { topicId: importedTopic.id, mode: "learn" });
    await askChat(ctx, imported.courseId, { question: "What is the likelihood?" });
    setSkillConnection(ctx, importedTopic.units[0].skills[0].id, "Imported-course connection");
    const importedOnly = counts(ctx);

    // Demo learner activity: a check, chat about the same skill, an approach choice and a connection.
    const demo = startSession(ctx, { topicId: BCE, mode: "review", skillIds: ["S4"] });
    await answerCurrent(ctx, demo.sessionId, exampleAnswer("S4-A", "correct"));
    await askChat(ctx, DEMO_COURSE_ID, { question: "What does binary cross-entropy penalise?" });
    reviewClassification(ctx, "S4", { action: "dismiss", replacesDecisionId: null, proposalId: null });
    setSkillConnection(ctx, "S4", "Like log loss from my stats course");
    expect(total(counts(ctx))).toBeGreaterThan(total(importedOnly));
    // The chat touched S4, so without a full reset it would count as recent help on the next check.
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM chat_skill_touches WHERE skill_id = 'S4'").get() as { n: number }).n).toBeGreaterThan(0);

    const report = resetDemoLearner(ctx.db);
    expect(report).toMatchObject({ sessions: 1, chatThreads: 1, decisions: 1, connections: 1 });
    expect(report.jobs).toBeGreaterThanOrEqual(1);
    await seedDemo({ db: ctx.db, now: ctx.clock.now(), dataDir: dir, samplePdfPath: SAMPLE_PDF_PATH, fixtures: loadFixtures() });

    // Only the imported course's records remain.
    expect(counts(ctx)).toEqual(importedOnly);
    expect(currentSkillState(ctx, "S4").evidenceState).toBe("unassessed");

    // Within the chat-help window, a clean learner's first correct definition answer is independent again.
    const fresh = startSession(ctx, { topicId: BCE, mode: "review", skillIds: ["S4"] });
    await answerCurrent(ctx, fresh.sessionId, exampleAnswer("S4-A", "correct"));
    expect(currentSkillState(ctx, "S4").evidenceState).toBe("demonstrated_once");
  });

  it("refuses to reset when the demo course id is not marked as demo", async () => {
    const t = await createTestContext();
    cleanup = t.cleanup;
    t.ctx.db.prepare("UPDATE courses SET is_demo = 0 WHERE id = ?").run(DEMO_COURSE_ID);
    expect(() => resetDemoLearner(t.ctx.db)).toThrow(/not marked as demo/);
  });
});
