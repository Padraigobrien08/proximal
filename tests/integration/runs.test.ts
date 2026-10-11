import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { MS_DAY } from "../../src/lib/domain/types";
import { advanceRun, getRunView, runForSession, startRun, stopRun } from "../../src/lib/services/runs";
import { advanceLearning, getSessionView, releaseCheckpointFeedback, submitAnswer } from "../../src/lib/services/sessions";
import { getCourseView, getTopicView, listCourseSummaries } from "../../src/lib/services/views";
import { createTestContext, exampleAnswer } from "../helpers";

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

/** Answer every practice question of a learn session correctly, moving on after each. */
async function completeLearnSession(ctx: Ctx, sessionId: string) {
  for (;;) {
    const view = getSessionView(ctx, sessionId);
    if (!view.current) return;
    await submitAnswer(ctx, sessionId, {
      sessionQuestionId: view.current.sessionQuestionId,
      submissionKey: randomUUID(),
      answer: exampleAnswer(view.current.question.id, "correct"),
    });
    advanceLearning(ctx, sessionId);
  }
}

describe("study runs (Continue)", () => {
  it("freezes the plan into steps and runs them as ordinary sessions in order", async () => {
    const { ctx } = await setup();
    const start = startRun(ctx, { budgetMinutes: 20 });
    expect(start.done).toBe(false);

    const first = runForSession(ctx, start.sessionId!)!;
    expect(first.position).toBe(0);
    expect(first.current).toMatchObject({ kind: "learn", kindLabel: "Learn", title: "Model notation · Dataset likelihood" });
    expect(first.steps.map((s) => s.title)).toEqual(["Model notation · Dataset likelihood", "Log objective", "Meaning of binary cross-entropy"]);
    expect(first.stepDone).toBe(false);
    expect(getSessionView(ctx, start.sessionId!).session.mode).toBe("learn");

    await completeLearnSession(ctx, start.sessionId!);
    expect(runForSession(ctx, start.sessionId!)!.stepDone).toBe(true);

    const second = advanceRun(ctx, start.runId, 0);
    expect(second.sessionId).not.toBe(start.sessionId);
    // A repeated click for the step already left does not skip another step.
    expect(advanceRun(ctx, start.runId, 0)).toEqual(second);
    expect(getSessionView(ctx, start.sessionId!).session.status).toBe("ended");
    expect(runForSession(ctx, start.sessionId!)).toBeNull();
    expect(runForSession(ctx, second.sessionId!)!.steps.map((s) => s.state)).toEqual(["done", "current", "upcoming"]);

    stopRun(ctx, start.runId);
    const summary = getRunView(ctx, start.runId);
    expect(summary.status).toBe("ended");
    // Finished, left part-way, never reached.
    expect(summary.steps.map((s) => s.state)).toEqual(["done", "left", "not_reached"]);
    expect(summary.changes.find((c) => c.unitId === "U1")).toMatchObject({ fromLabel: "Not started", toLabel: "Practised" });
    expect(summary.changes.find((c) => c.unitId === "U3")).toMatchObject({ from: 0, to: 0 });
    expect(summary.nextCheck?.topicTitle).toBe("Model and likelihood");
  });

  it("labels a due check on practised subtopics as a quick check, and rolls up levels per topic and module", async () => {
    const { ctx, clock } = await setup();
    const learn = startRun(ctx, { budgetMinutes: 10, topicId: "demo-topic-likelihood" });
    await completeLearnSession(ctx, learn.sessionId!);
    expect(advanceRun(ctx, learn.runId, 0).done).toBe(true);

    const topic = getTopicView(ctx, "demo-topic-likelihood");
    expect(topic.subtopics.map((s) => [s.id, s.level])).toEqual([
      ["U1", 2],
      ["U2", 2],
    ]);
    expect(topic.rollup).toMatchObject({ counts: [0, 0, 2, 0, 0], checked: 0, due: 0 });

    clock.advance(MS_DAY + 60_000);
    const check = startRun(ctx, { budgetMinutes: 10, topicId: "demo-topic-likelihood" });
    const ctxRun = runForSession(ctx, check.sessionId!)!;
    expect(ctxRun.current).toMatchObject({ kind: "check", kindLabel: "Quick check" });
    // A fresh question family from the ones practised.
    for (const skill of ["S1", "S2"]) {
      const sq = getSessionView(ctx, check.sessionId!).current!;
      expect(sq.question.skillId).toBe(skill);
      await submitAnswer(ctx, check.sessionId!, {
        sessionQuestionId: sq.sessionQuestionId,
        submissionKey: randomUUID(),
        answer: exampleAnswer(sq.question.id, "correct"),
      });
    }
    releaseCheckpointFeedback(ctx, check.sessionId!);
    expect(runForSession(ctx, check.sessionId!)!.stepDone).toBe(true);

    const course = getCourseView(ctx, "demo-course");
    expect(course.mastery.rollup).toMatchObject({ counts: [4, 0, 0, 2, 0], total: 6, checked: 2 });
    expect(listCourseSummaries(ctx)[0].subtopicLevels.map((s) => s.level)).toEqual([3, 3, 0, 0, 0, 0]);
  });

  it("refuses to start when nothing is ready", async () => {
    const { ctx } = await setup();
    ctx.db.prepare("UPDATE questions SET status = 'excluded'").run();
    expect(() => startRun(ctx, { budgetMinutes: 20 })).toThrow(/up to date/);
  });
});
