import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { SAMPLE_PDF_PATH } from "../../src/lib/content/fixtures";
import { claimNextJob, enqueueJob, getJob, JOB_LEASE_MS, latestJob, MAX_JOB_RUNS } from "../../src/lib/db/jobsRepo";
import { getAssessmentForAttempt, getAttempt } from "../../src/lib/db/repo";
import { drainJobs } from "../../src/lib/jobs/runner";
import { createMockProvider } from "../../src/lib/llm/factory";
import { ProviderError, type LearningProvider } from "../../src/lib/llm/types";
import { approveCourse, importPdf } from "../../src/lib/services/imports";
import { requestQuestionDrafts, topicQuestionDrafts } from "../../src/lib/services/questionDrafts";
import { getSessionView, startSession, submitAnswer } from "../../src/lib/services/sessions";
import { getCourseView } from "../../src/lib/services/views";
import { createTestContext, exampleAnswer } from "../helpers";

const BCE = "demo-topic-bce";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

/** A context that hands jobs to the queue (as the server does) instead of running them inline. */
async function setup(provider?: (db: Parameters<typeof createMockProvider>[0]) => LearningProvider) {
  const t = await createTestContext(provider ? { provider, mode: "mock" } : {});
  cleanup = t.cleanup;
  t.ctx.inlineJobs = false;
  return t;
}

async function submitCheck(ctx: Awaited<ReturnType<typeof setup>>["ctx"], skillId: string, questionId: string) {
  const { sessionId } = startSession(ctx, { topicId: BCE, mode: "review", skillIds: [skillId] });
  const sq = getSessionView(ctx, sessionId).current!.sessionQuestionId;
  const res = await submitAnswer(ctx, sessionId, { sessionQuestionId: sq, submissionKey: randomUUID(), answer: exampleAnswer(questionId, "correct") });
  return { sessionId, res };
}

describe("background grading of check answers", () => {
  it("returns 'Answer saved' before grading; the results view shows grading until the worker finishes", async () => {
    const { ctx } = await setup();
    const { sessionId, res } = await submitCheck(ctx, "S5", "S5-A");
    expect(res.message).toBe("Answer saved");
    expect(res.assessment).toBeNull();
    expect(getAssessmentForAttempt(ctx.db, res.attemptId)).toBeNull();
    expect(latestJob(ctx.db, "assess_attempt", res.attemptId)!.status).toBe("queued");

    let results = getSessionView(ctx, sessionId).results!;
    expect(results.allAssessed).toBe(false);
    expect(results.gradingAttemptIds).toEqual([res.attemptId]);
    expect(results.failedAttemptIds).toEqual([]);

    expect(await drainJobs(() => ctx)).toBe(1);
    expect(latestJob(ctx.db, "assess_attempt", res.attemptId)!.status).toBe("done");
    results = getSessionView(ctx, sessionId).results!;
    expect(results.allAssessed).toBe(true);
    expect(getAssessmentForAttempt(ctx.db, res.attemptId)!.outcome).toBe("pass");
  });

  it("a provider failure leaves the attempt retryable and listed as failed, not grading", async () => {
    const { ctx } = await setup((db) => {
      const mock = createMockProvider(db);
      mock.assessAnswer = async () => {
        throw new ProviderError("rate limited", "provider_unavailable", true);
      };
      return mock;
    });
    const { sessionId, res } = await submitCheck(ctx, "S5", "S5-A");
    await drainJobs(() => ctx);
    // The job itself is done: the failure belongs to the attempt, which offers an explicit retry.
    expect(latestJob(ctx.db, "assess_attempt", res.attemptId)!.status).toBe("done");
    expect(getAttempt(ctx.db, res.attemptId)!.status).toBe("provider_error");
    const results = getSessionView(ctx, sessionId).results!;
    expect(results.gradingAttemptIds).toEqual([]);
    expect(results.failedAttemptIds).toEqual([res.attemptId]);
  });
});

describe("job queue", () => {
  it("deduplicates active jobs for the same work", async () => {
    const { ctx } = await setup();
    const a = enqueueJob(ctx.db, "assess_attempt", "x", 1);
    const b = enqueueJob(ctx.db, "assess_attempt", "x", 2);
    expect(b.id).toBe(a.id);
    expect(enqueueJob(ctx.db, "assess_attempt", "y", 3).id).not.toBe(a.id);
  });

  it("reclaims a job whose lease expired (crashed run) and gives up after repeated interruptions", async () => {
    const { ctx } = await setup();
    const job = enqueueJob(ctx.db, "assess_attempt", "missing-attempt", 0);
    let now = 0;
    for (let run = 1; run <= MAX_JOB_RUNS; run++) {
      const claimed = claimNextJob(ctx.db, now)!;
      expect(claimed.id).toBe(job.id);
      expect(claimed.runs).toBe(run);
      // Still leased: nobody else can take it.
      expect(claimNextJob(ctx.db, now + JOB_LEASE_MS.assess_attempt - 1)).toBeNull();
      now += JOB_LEASE_MS.assess_attempt; // the run "crashed" and its lease ran out
    }
    expect(claimNextJob(ctx.db, now)).toBeNull();
    expect(getJob(ctx.db, job.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/interrupted/) });
  });

  it("records an unexpected handler error on the job without throwing", async () => {
    const { ctx } = await setup();
    const job = enqueueJob(ctx.db, "assess_attempt", "missing-attempt", ctx.clock.now());
    await drainJobs(() => ctx);
    expect(getJob(ctx.db, job.id)).toMatchObject({ status: "failed", error: "Attempt not found." });
  });
});

describe("background question drafting", () => {
  async function imported(provider?: (db: Parameters<typeof createMockProvider>[0]) => LearningProvider) {
    const t = await setup(provider);
    const res = await importPdf(t.ctx, t.dir, { name: "lecture.pdf", bytes: readFileSync(SAMPLE_PDF_PATH) });
    approveCourse(t.ctx, res.courseId);
    const topic = getCourseView(t.ctx, res.courseId).topics.find((tp) => tp.units.some((u) => u.sourcePages.includes(5)))!;
    const skillId = topic.units.find((u) => u.sourcePages.includes(5))!.skills[0].id;
    return { ...t, topicId: topic.id, skillId };
  }

  it("queues drafting, shows it in progress, and stores drafts when the worker runs", async () => {
    const { ctx, topicId, skillId } = await imported();
    const view = requestQuestionDrafts(ctx, skillId);
    expect(view.drafting).toEqual({ status: "queued", error: null });
    expect(view.pending).toHaveLength(0);
    // A second click while queued joins the same job.
    requestQuestionDrafts(ctx, skillId);
    expect(await drainJobs(() => ctx)).toBe(1);
    const skill = topicQuestionDrafts(ctx, topicId).skills.find((s) => s.skillId === skillId)!;
    expect(skill.drafting).toBeNull();
    expect(skill.pending).toHaveLength(2);
  });

  it("shows a failed drafting job's message until a later run succeeds", async () => {
    let fail = true;
    const { ctx, topicId, skillId } = await imported((db) => {
      const mock = createMockProvider(db);
      const real = mock.draftQuestions.bind(mock);
      mock.draftQuestions = async (input) => {
        if (fail) throw new ProviderError("OpenAI rate limit or quota reached.", "provider_unavailable", true);
        return real(input);
      };
      return mock;
    });
    requestQuestionDrafts(ctx, skillId);
    await drainJobs(() => ctx);
    const failed = topicQuestionDrafts(ctx, topicId).skills.find((s) => s.skillId === skillId)!;
    expect(failed.drafting).toEqual({ status: "failed", error: "OpenAI rate limit or quota reached." });
    expect(failed.pending).toHaveLength(0);

    fail = false;
    requestQuestionDrafts(ctx, skillId);
    await drainJobs(() => ctx);
    const ok = topicQuestionDrafts(ctx, topicId).skills.find((s) => s.skillId === skillId)!;
    expect(ok.drafting).toBeNull();
    expect(ok.pending).toHaveLength(2);
  });

  it("rejects an impossible request immediately instead of queueing it", async () => {
    const { ctx } = await imported();
    const demoSkill = ctx.db.prepare("SELECT s.id FROM skills s JOIN units u ON u.id = s.unit_id WHERE u.topic_id = ? LIMIT 1").get(BCE) as { id: string };
    expect(() => requestQuestionDrafts(ctx, demoSkill.id)).toThrow(/demo course/);
    expect(latestJob(ctx.db, "draft_questions", demoSkill.id)).toBeNull();
  });
});
