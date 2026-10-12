import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SAMPLE_PDF_PATH } from "../../src/lib/content/fixtures";
import { getQuestion, listQuestionsForSkill } from "../../src/lib/db/repo";
import { createMockProvider } from "../../src/lib/llm/factory";
import { ProviderError, type LearningProvider } from "../../src/lib/llm/types";
import { checkDraftBatch, type DraftQuestion } from "../../src/lib/questions/drafts";
import { approveCourse, importPdf } from "../../src/lib/services/imports";
import {
  approveQuestionDraft,
  editQuestionDraft,
  generateQuestionDrafts,
  rejectQuestionDraft,
  revealDraftAnswerKey,
  topicQuestionDrafts,
} from "../../src/lib/services/questionDrafts";
import { startSession } from "../../src/lib/services/sessions";
import { getCourseView, getTopicView } from "../../src/lib/services/views";
import { createTestContext } from "../helpers";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

/** An approved import of the sample lecture (offline fixture curriculum). Returns the BCE-calculation skill. */
async function importedCourse(provider?: (db: Parameters<typeof createMockProvider>[0]) => LearningProvider, mode: "mock" | "live" = "mock") {
  const t = await createTestContext(provider ? { provider, mode } : {});
  cleanup = t.cleanup;
  const res = await importPdf(t.ctx, t.dir, { name: "lecture.pdf", bytes: readFileSync(SAMPLE_PDF_PATH) });
  approveCourse(t.ctx, res.courseId);
  const view = getCourseView(t.ctx, res.courseId);
  const topic = view.topics.find((tp) => tp.units.some((u) => u.sourcePages.includes(5)))!;
  const unit = topic.units.find((u) => u.sourcePages.includes(5))!;
  return { ...t, courseId: res.courseId, topicId: topic.id, skillId: unit.skills[0].id };
}

function validQuestion(over: Partial<DraftQuestion> = {}): DraftQuestion {
  return {
    familyRole: "initial",
    transferChange: "",
    taskType: "calculate",
    prompt: "For y = 1 and p = 0.9, calculate BCE.",
    referenceSummary: "−ln(0.9) ≈ 0.10536",
    criteria: [{ id: "value", essential: true, description: "Correct value", acceptableEquivalents: [], fatalIfNotMet: false }],
    numericChecks: [{ criterionId: "value", value: 0.10536, tolerance: 0.005 }],
    hints: ["Which branch applies when y = 1?", "BCE = −ln(p) here."],
    sourcePages: [5],
    examples: [
      { label: "correct", answer: "−ln(0.9) ≈ 0.105", expectedOutcome: "pass" },
      { label: "wrong", answer: "ln(0.9) ≈ −0.105", expectedOutcome: "fail" },
    ],
    ...over,
  };
}

describe("question drafts for imported courses", () => {
  it("offline: drafts the authored sample questions with the key hidden; approve-for-checks enables independent review", async () => {
    const { ctx, topicId, skillId } = await importedCourse();
    expect(getTopicView(ctx, topicId).reviewAvailable).toBe(false);

    const res = await generateQuestionDrafts(ctx, skillId);
    expect(res.drafted).toBe(2);
    expect(res.invalid).toBe(0);
    const [initial, transfer] = res.skill.pending;
    expect(initial.familyRole).toBe("initial");
    expect(transfer.familyRole).toBe("new_context");
    // Before the key is opened, only the prompt side is visible.
    expect(initial.answerKey).toBeNull();
    expect(JSON.stringify(initial)).not.toContain("0.22314");
    expect(initial.providerLabel).toMatch(/Offline sample question/);

    // A draft is never usable: no questions and no review until approval.
    expect(listQuestionsForSkill(ctx.db, skillId)).toHaveLength(0);

    const after = approveQuestionDraft(ctx, initial.id, "checks");
    expect(after.pending.map((d) => d.id)).toEqual([transfer.id]);
    const q = after.questions[0];
    expect(q.practiceOnly).toBe(false);
    expect(q.origin).toBe("ai_draft");
    // Nobody read the marking scheme, so it is not recorded as owner-reviewed.
    expect(getQuestion(ctx.db, q.id)!.status).toBe("authored_fixture");
    expect(getQuestion(ctx.db, q.id)!.reviewedBy).toBeNull();

    expect(getTopicView(ctx, topicId).reviewAvailable).toBe(true);
    const { sessionId } = startSession(ctx, { topicId, mode: "review", skillIds: [skillId] });
    const sq = ctx.db.prepare("SELECT question_id FROM session_questions WHERE session_id = ?").all(sessionId) as { question_id: string }[];
    expect(sq.map((r) => r.question_id)).toEqual([q.id]);
    // While that check is open, the remaining draft cannot be reviewed.
    expect(() => revealDraftAnswerKey(ctx, transfer.id)).toThrow(/A check is open/);
  });

  it("opening the key limits the draft to practice; practice-only questions never reach a check", async () => {
    const { ctx, topicId, skillId } = await importedCourse();
    const { skill } = await generateQuestionDrafts(ctx, skillId);
    const id = skill.pending[0].id;

    const revealed = revealDraftAnswerKey(ctx, id);
    const key = revealed.pending.find((d) => d.id === id)!.answerKey!;
    expect(JSON.stringify(key.question)).toContain("0.22314");

    expect(() => approveQuestionDraft(ctx, id, "checks")).toThrow(/only be approved for practice/);
    const after = approveQuestionDraft(ctx, id, "practice");
    const q = getQuestion(ctx.db, after.questions[0].id)!;
    expect(q.practiceOnly).toBe(true);
    expect(q.status).toBe("owner_reviewed");
    expect(q.reviewedBy).toMatch(/in-app review/);

    expect(getTopicView(ctx, topicId).reviewAvailable).toBe(false);
    expect(() => startSession(ctx, { topicId, mode: "review", skillIds: [skillId] })).toThrow(/Reviewed assessment questions needed/);
    const learn = startSession(ctx, { topicId, mode: "learn", skillIds: [skillId] });
    const sq = ctx.db.prepare("SELECT question_id FROM session_questions WHERE session_id = ?").all(learn.sessionId) as { question_id: string }[];
    expect(sq.map((r) => r.question_id)).toEqual([q.id]);
  });

  it("editing needs the open key and must pass every check; decisions are compare-and-set", async () => {
    const { ctx, skillId } = await importedCourse();
    const { skill } = await generateQuestionDrafts(ctx, skillId);
    const [a, b] = skill.pending;

    expect(() => editQuestionDraft(ctx, a.id, validQuestion())).toThrow(/Open the answer key/);
    revealDraftAnswerKey(ctx, a.id);
    expect(() => editQuestionDraft(ctx, a.id, validQuestion({ sourcePages: [2] }))).toThrow(/not one of this subtopic's pages/);
    const edited = editQuestionDraft(ctx, a.id, validQuestion());
    expect(edited.pending.find((d) => d.id === a.id)!.edited).toBe(true);

    approveQuestionDraft(ctx, a.id, "practice");
    expect(() => approveQuestionDraft(ctx, a.id, "practice")).toThrow(/already approved/);
    const rejected = rejectQuestionDraft(ctx, b.id);
    expect(rejected.rejectedCount).toBe(1);
    expect(rejected.pending).toHaveLength(0);
    expect(() => approveQuestionDraft(ctx, b.id, "checks")).toThrow(/already rejected/);
  });

  it("stores malformed questions as invalid next to valid ones, and maps provider errors without storing anything", async () => {
    let next: unknown = { questions: [validQuestion(), validQuestion({ familyRole: "new_context", prompt: "Another", sourcePages: [9] })] };
    let fail = false;
    const { ctx, skillId } = await importedCourse((db) => {
      const mock = createMockProvider(db);
      mock.draftQuestions = async () => {
        if (fail) throw new ProviderError("rate limited", "provider_unavailable", true);
        return { batch: next, meta: { mode: "mock", model: null, promptVersion: "test", usage: null } };
      };
      return mock;
    });
    const res = await generateQuestionDrafts(ctx, skillId);
    expect(res.drafted).toBe(1);
    expect(res.invalid).toBe(1);
    const invalid = res.skill.pending.find((d) => d.status === "invalid")!;
    expect(invalid.problemCount).toBeGreaterThan(0);
    expect(() => approveQuestionDraft(ctx, invalid.id, "checks")).toThrow(/fix the listed problems/);

    next = { questions: [validQuestion(), validQuestion()] };
    expect((await generateQuestionDrafts(ctx, skillId)).batchProblems.join(" ")).toMatch(/same prompt/);

    fail = true;
    const before = topicQuestionDrafts(ctx, getTopicId(ctx, skillId)).skills[0].pending.length;
    await expect(generateQuestionDrafts(ctx, skillId)).rejects.toMatchObject({ code: "provider_unavailable", retryable: true });
    expect(topicQuestionDrafts(ctx, getTopicId(ctx, skillId)).skills[0].pending.length).toBe(before);
  });

  it("is unavailable for the demo course", async () => {
    const { ctx } = await importedCourse();
    expect(topicQuestionDrafts(ctx, "demo-topic-bce").available).toBe(false);
    const demoSkill = ctx.db.prepare("SELECT s.id FROM skills s JOIN units u ON u.id = s.unit_id WHERE u.topic_id = 'demo-topic-bce' LIMIT 1").get() as { id: string };
    await expect(generateQuestionDrafts(ctx, demoSkill.id)).rejects.toThrow(/demo course/);
  });
});

function getTopicId(ctx: Awaited<ReturnType<typeof createTestContext>>["ctx"], skillId: string): string {
  return (ctx.db.prepare("SELECT u.topic_id AS t FROM skills s JOIN units u ON u.id = s.unit_id WHERE s.id = ?").get(skillId) as { t: string }).t;
}

describe("marking check on live drafts", () => {
  const explain = (over: Partial<DraftQuestion> = {}) =>
    validQuestion({
      taskType: "explain",
      prompt: "Why does a confident wrong prediction get a large BCE?",
      numericChecks: [],
      examples: [
        { label: "correct", answer: "Because -log of a small true-label probability is large.", expectedOutcome: "pass" },
        { label: "wrong", answer: "Because accuracy drops.", expectedOutcome: "fail" },
      ],
      ...over,
    });

  /** Live-mode drafts with a stub assessor: `grade` decides each criterion's status from the answer. */
  async function live(grade: (answer: string) => "met" | "not_met" | Error) {
    return importedCourse((db) => {
      const mock = createMockProvider(db);
      mock.draftQuestions = async () => ({
        batch: { questions: [explain(), explain({ familyRole: "new_context", transferChange: "Compares two models instead.", prompt: "Same accuracy, same BCE?" })] },
        meta: { mode: "live", vendor: "openai", model: "drafter", promptVersion: "t", usage: null },
      });
      mock.assessAnswer = async (input) => {
        const g = grade(input.answer);
        if (g instanceof Error) throw g;
        return {
          output: {
            criteria: input.rubric.criteria.map((c) => ({ criterionId: c.id, status: g, answerQuote: g === "met" ? input.answer : null, briefReason: "stub" })),
            possibleMisconception: null,
          },
          meta: { mode: "live", vendor: "openai", model: "grader", promptVersion: "t", usage: null },
        };
      };
      return mock;
    }, "live");
  }

  it("passes when the grader marks every example as labelled, and only then allows approval for checks", async () => {
    const { ctx, skillId } = await live((a) => (a.includes("-log") ? "met" : "not_met"));
    const { skill } = await generateQuestionDrafts(ctx, skillId);
    expect(skill.pending[0].selfCheck).toMatchObject({ status: "passed", stale: false });
    // Outcomes only: the example answers are not exposed with the key closed.
    expect(JSON.stringify(skill.pending[0])).not.toContain("small true-label probability");
    expect(approveQuestionDraft(ctx, skill.pending[0].id, "checks").questions).toHaveLength(1);
  });

  it("fails when the scheme passes its own wrong example, and blocks approval for checks but not for practice", async () => {
    const { ctx, skillId } = await live(() => "met");
    const { skill } = await generateQuestionDrafts(ctx, skillId);
    const d = skill.pending[0];
    expect(d.selfCheck).toMatchObject({ status: "failed", message: expect.stringMatching(/wrong example was graded pass/) });
    expect(() => approveQuestionDraft(ctx, d.id, "checks")).toThrow(/can't be approved for checks/);
    revealDraftAnswerKey(ctx, d.id);
    expect(approveQuestionDraft(ctx, d.id, "practice").questions[0].practiceOnly).toBe(true);
  });

  it("records an unreachable grader as an untested scheme that cannot be approved for checks", async () => {
    const { ctx, skillId } = await live(() => new ProviderError("rate limited", "provider_unavailable", true));
    const { skill } = await generateQuestionDrafts(ctx, skillId);
    expect(skill.pending[0].selfCheck).toMatchObject({ status: "error", message: expect.stringMatching(/could not run: rate limited/) });
    expect(() => approveQuestionDraft(ctx, skill.pending[0].id, "checks")).toThrow(/hasn't been tested/);
  });
});

describe("checkDraftBatch", () => {
  it("checks each question on its own and the pair as a whole", () => {
    const r = checkDraftBatch({ questions: [validQuestion(), { prompt: "x" }] }, [5]);
    expect(r.drafts[0].ok).toBe(true);
    expect(r.drafts[1].ok).toBe(false);
    expect(checkDraftBatch({ questions: [validQuestion({ taskType: "explain" })] }, [5]).drafts[0]).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([expect.stringMatching(/numeric checks/)]),
    });
    expect(checkDraftBatch({ questions: [validQuestion()] }, [5]).batchProblems.join()).toMatch(/expected 2/);
    expect(checkDraftBatch("nope", [5]).batchProblems).toHaveLength(1);
  });
});
