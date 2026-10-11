import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { loadFixtures, SAMPLE_PDF_PATH } from "../../src/lib/content/fixtures";
import { getAssessmentForAttempt, getQuestion, setQuestionStatus } from "../../src/lib/db/repo";
import { MS_DAY } from "../../src/lib/domain/types";
import { flagAssessment } from "../../src/lib/services/assessments";
import { seedDemo } from "../../src/lib/services/seed";
import { getSessionView, releaseCheckpointFeedback, reveal, startSession, submitAnswer, endSession } from "../../src/lib/services/sessions";
import { getHomeView, getTopicView, listCourseSummaries } from "../../src/lib/services/views";
import { createTestContext, exampleAnswer, T0 } from "../helpers";

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

type Ctx = Awaited<ReturnType<typeof setup>>["ctx"];

async function answerCurrent(ctx: Ctx, sessionId: string, text: string) {
  const sq = getSessionView(ctx, sessionId).current!.sessionQuestionId;
  return submitAnswer(ctx, sessionId, { sessionQuestionId: sq, submissionKey: randomUUID(), answer: text });
}

/** Showcase: explanation pass, calculation fail, hint, supported correction. */
async function runShowcase(ctx: Ctx) {
  const { sessionId } = startSession(ctx, { topicId: BCE, purpose: "check" });
  await answerCurrent(ctx, sessionId, exampleAnswer("S4-A", "correct"));
  const fail = await answerCurrent(ctx, sessionId, exampleAnswer("S5-A", "wrong"));
  releaseCheckpointFeedback(ctx, sessionId);
  const sqId = (getSessionView(ctx, sessionId).items as { sessionQuestionId: string; question: { id: string } }[]).find(
    (i) => i.question.id === "S5-A",
  )!.sessionQuestionId;
  await reveal(ctx, sessionId, { kind: "hint", sessionQuestionId: sqId, hintIndex: 0 });
  await submitAnswer(ctx, sessionId, { sessionQuestionId: sqId, submissionKey: randomUUID(), answer: exampleAnswer("S5-A", "correct") });
  return { sessionId, failAttemptId: fail.attemptId };
}

describe("home view (U01, U05, U12, U14)", () => {
  it("U01: a new workspace shows real counts, one starting action and no fabricated evidence", async () => {
    const { ctx } = await setup();
    const home = getHomeView(ctx, 20);
    expect(home.recommendation).toMatchObject({ action: "learn", title: "Start learning", topicTitle: "Model and likelihood", reason: "Not studied yet" });
    expect(home.recentEvidence).toEqual([]);
    expect(home.nextScheduledCheck).toBeNull();
    expect(home.courses[0]).toMatchObject({
      title: "AI classification demo",
      topicCount: 3,
      requiredSkillCount: 6,
      independentlyCheckedSkillCount: 0,
      sourceLabel: "Authored sample lecture",
    });
  });

  it("U05: after the showcase the home shows separate evidence and the future fresh check outside today's plan", async () => {
    const { ctx } = await setup();
    const { sessionId, failAttemptId } = await runShowcase(ctx);
    // An unresolved repair would be resumed; once repaired the session is not recommended again.
    const home = getHomeView(ctx, 30);
    expect(home.recommendation?.sessionId ?? null).not.toBe(sessionId);
    const recent = Object.fromEntries(home.recentEvidence.map((r) => [r.skillId, r.label]));
    expect(recent).toMatchObject({ S4: "Checked", S5: "Practised" });
    expect(home.nextScheduledCheck?.topicId).toBe(BCE);
    // Normally 24 elapsed hours after the original gap attempt.
    const failSubmitted = ctx.db.prepare("SELECT submitted_at AS t FROM attempts WHERE id = ?").get(failAttemptId) as { t: number };
    expect(home.nextScheduledCheck?.dueAt).toBe(Math.min(failSubmitted.t + MS_DAY, ctx.clock.now() + MS_DAY));
    expect(home.plan.some((t) => t.action === "review" && t.topicId === BCE)).toBe(false);
    expect(home.courses[0].independentlyCheckedSkillCount).toBe(1);

    // U06: tomorrow a fresh S5-B pass is demonstrated once, not retention.
    endSession(ctx, sessionId);
    (ctx.clock as unknown as { advance(ms: number): void }).advance(MS_DAY + 60_000);
    const due = getHomeView(ctx, 30);
    const review = due.plan.find((t) => t.topicId === BCE && t.action === "review")!;
    expect(review.skillIds).toContain("S5");
    const later = startSession(ctx, { topicId: BCE, purpose: "review", skillIds: ["S5"] });
    expect(getSessionView(ctx, later.sessionId).current?.question.id).toBe("S5-B");
    expect(getSessionView(ctx, later.sessionId).session.modeLabel).toBe("Review");
    await answerCurrent(ctx, later.sessionId, exampleAnswer("S5-B", "correct"));
    expect(getTopicView(ctx, BCE).skills.find((s) => s.id === "S5")!.evidenceState).toBe("demonstrated_once");
  });

  it("U12: flagging an accepted pass removes it from counts and evidence while keeping history", async () => {
    const { ctx } = await setup();
    await runShowcase(ctx);
    const s4Attempt = ctx.db
      .prepare("SELECT a.id FROM attempts a JOIN session_questions sq ON sq.id = a.session_question_id WHERE sq.skill_id = 'S4'")
      .get() as { id: string };
    expect(listCourseSummaries(ctx)[0].independentlyCheckedSkillCount).toBe(1);
    flagAssessment(ctx, getAssessmentForAttempt(ctx.db, s4Attempt.id)!.id, "test");
    expect(listCourseSummaries(ctx)[0].independentlyCheckedSkillCount).toBe(0);
    const topic = getTopicView(ctx, BCE);
    expect(topic.skills.find((s) => s.id === "S4")!.evidenceState).toBe("unassessed");
    const row = topic.history.find((h) => h.kind === "attempt" && h.attemptId === s4Attempt.id);
    expect(row).toMatchObject({ resultLabel: "Judgement excluded", excluded: true });
  });

  it("U03: an open checkpoint's judgements never surface on the topic, home or course screens before release", async () => {
    const { ctx } = await setup();
    const { sessionId } = startSession(ctx, { topicId: BCE, purpose: "check" });
    await answerCurrent(ctx, sessionId, exampleAnswer("S4-A", "correct"));
    const topic = getTopicView(ctx, BCE);
    const s4 = topic.skills.find((s) => s.id === "S4")!;
    expect(s4.evidenceState).toBe("unassessed");
    expect(s4.checkInProgress).toBe(true);
    const row = topic.history.find((h) => h.kind === "attempt")!;
    expect(row).toMatchObject({ resultLabel: "Answer saved · results after the check", feedback: null, assessmentId: null });
    expect(JSON.stringify(topic)).not.toMatch(/briefReason|Right with no help/);
    // Subtopic levels and rollups cannot reveal the open check either.
    expect(topic.subtopics.find((u) => u.id === "U4")!.level).toBe(0);
    expect(listCourseSummaries(ctx)[0].independentlyCheckedSkillCount).toBe(0);
    expect(listCourseSummaries(ctx)[0].mastery.checked).toBe(0);
    const home = getHomeView(ctx, 20);
    expect(home.recommendation).toMatchObject({ action: "resume", title: "Continue your quick check", reason: "1 of 2 answers saved" });
    expect(JSON.stringify(home)).not.toMatch(/Right with no help/);
  });

  it("U14: initial home/topic/session payloads carry no reference answers, private hints, rubrics or keys", async () => {
    const { ctx } = await setup();
    const { sessionId } = startSession(ctx, { topicId: BCE, purpose: "check" });
    const payload = JSON.stringify([getHomeView(ctx, 20), getTopicView(ctx, BCE), getSessionView(ctx, sessionId)]);
    for (const secret of ["0.22314355", "referenceSummary", "rubric", "hints", "reference", "ANTHROPIC", "identify which term remains"]) {
      expect(payload).not.toContain(secret);
    }
  });

  it("starting the same unfinished check again resumes it instead of duplicating", async () => {
    const { ctx } = await setup();
    const first = startSession(ctx, { topicId: BCE, purpose: "check" });
    const again = startSession(ctx, { topicId: BCE, purpose: "check" });
    expect(again).toEqual({ sessionId: first.sessionId, resumed: true });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
  });

  it("targeted practice reuses the attempted family, keeping the fresh family for the later check", async () => {
    const { ctx } = await setup();
    const { sessionId } = startSession(ctx, { topicId: BCE, purpose: "check", skillIds: ["S5"] });
    await answerCurrent(ctx, sessionId, exampleAnswer("S5-A", "wrong"));
    endSession(ctx, sessionId);
    const home = getHomeView(ctx, 20);
    const practise = home.plan.find((t) => t.action === "practice")!;
    expect(practise).toMatchObject({ topicId: BCE, skillIds: ["S5"], reason: "Your last calculation needs another step" });
    const p = startSession(ctx, { topicId: BCE, purpose: "practice", skillIds: ["S5"] });
    const view = getSessionView(ctx, p.sessionId);
    expect(view.session.modeLabel).toBe("Practice");
    expect(view.current?.question.id).toBe("S5-A");
  });
});

describe("seed refresh", () => {
  it("updates unreviewed fixture questions to a newer authored version but never owner-reviewed ones", async () => {
    const { ctx, dir } = await setup();
    const fixtures = loadFixtures();
    const bumped = {
      ...fixtures,
      bank: {
        ...fixtures.bank,
        questions: fixtures.bank.questions.map((q) =>
          q.id === "S1-A" || q.id === "S2-A" ? { ...q, version: q.version + 1, prompt: `${q.prompt} (v${q.version + 1})` } : q,
        ),
      },
    };
    setQuestionStatus(ctx.db, "S2-A", "owner_reviewed", "Owner", T0);
    const report = await seedDemo({ db: ctx.db, now: T0, dataDir: dir, samplePdfPath: SAMPLE_PDF_PATH, fixtures: bumped });
    expect(report.questionsUpdated).toBe(1);
    expect(getQuestion(ctx.db, "S1-A")!.prompt).toMatch(/\(v2\)$/);
    expect(getQuestion(ctx.db, "S2-A")!.prompt).not.toMatch(/\(v2\)$/);
    const again = await seedDemo({ db: ctx.db, now: T0, dataDir: dir, samplePdfPath: SAMPLE_PDF_PATH, fixtures: bumped });
    expect(again.questionsUpdated).toBe(0);
  });
});
