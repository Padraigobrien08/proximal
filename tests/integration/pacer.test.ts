// PACER service boundaries: review, routing, activity persistence, exposure guards and evidence separation
// (P07, P08, P10-P17).
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { MS_DAY } from "../../src/lib/domain/types";
import { listExposures, listQuestionsForSkill, getSkill } from "../../src/lib/db/repo";
import { effectiveDecision, getPacerContext, listDecisions, upsertPacerContext } from "../../src/lib/db/pacerRepo";
import { currentSkillState } from "../../src/lib/services/evidence";
import {
  acceptAllDrafts,
  advanceActivity,
  classifyTopic,
  reviewClassification,
  revealApproachDetails,
  setSkillConnection,
  submitActivityResponse,
  topicApproaches,
} from "../../src/lib/services/pacer";
import { getSessionView, reveal, startSession, submitAnswer, advanceLearning } from "../../src/lib/services/sessions";
import { getHomeView, getTopicView } from "../../src/lib/services/views";
import { AppError } from "../../src/lib/services/errors";
import { createMockProvider } from "../../src/lib/llm/factory";
import { ProviderError, type LearningProvider, type PacerClassifyInput } from "../../src/lib/llm/types";
import { createTestContext, exampleAnswer } from "../helpers";
import type { AppContext } from "../../src/lib/services/context";

const BCE = "demo-topic-bce";
const LIKELIHOOD = "demo-topic-likelihood";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

async function setup(opts?: Parameters<typeof createTestContext>[0]) {
  const t = await createTestContext(opts);
  cleanup = t.cleanup;
  return t;
}

function approach(ctx: AppContext, topicId: string, skillId: string) {
  return topicApproaches(ctx, topicId).skills.find((s) => s.skillId === skillId)!;
}

function accept(ctx: AppContext, topicId: string, skillId: string) {
  const a = approach(ctx, topicId, skillId);
  return reviewClassification(ctx, skillId, { action: "accept", proposalId: a.draft!.proposalId, replacesDecisionId: a.effective?.decisionId ?? null });
}

function evidenceSnapshot(ctx: AppContext) {
  return {
    attempts: (ctx.db.prepare("SELECT COUNT(*) AS n FROM attempts").get() as { n: number }).n,
    assessments: (ctx.db.prepare("SELECT COUNT(*) AS n FROM assessments").get() as { n: number }).n,
    states: ctx.db.prepare("SELECT skill_id, evidence_state, due_at, stage, epoch FROM review_states ORDER BY skill_id").all(),
  };
}

/** Stub live provider for classification (other jobs delegate to the offline provider). */
function liveStub(db: AppContext["db"], classify: (input: PacerClassifyInput) => Promise<{ results: unknown[] }>): LearningProvider {
  const mock = createMockProvider(db);
  return {
    mode: "live",
    vendor: "openai",
    model: "stub-model",
    models: { assess: "stub-model", curriculum: "stub-classifier", tutor: "stub-model" },
    assessAnswer: (i) => mock.assessAnswer(i),
    generateCurriculum: (i) => mock.generateCurriculum(i),
    tutor: () => mock.tutor(),
    async classifyPacer(input) {
      const r = await classify(input);
      return { results: r.results, meta: { mode: "live", vendor: "openai", model: "stub-classifier", promptVersion: "pacer-classifier-v1", usage: null } };
    },
  };
}

describe("P07 review before routing; manual choices persist", () => {
  it("a live proposal is a draft until reviewed and regeneration cannot overwrite a manual choice", async () => {
    let primary = "conceptual";
    const { ctx } = await setup({
      provider: (db) =>
        liveStub(db, async (input) => ({
          results: input.objectives.map((o) => ({
            kind: "suggestion",
            objectiveId: o.objectiveId,
            primary,
            secondary: [],
            rationale: `${primary === "conceptual" ? "Conceptual" : "Procedural"}: grounded in the objective.`,
            support: [{ from: "objective", quote: o.objective.slice(0, 20) }],
            ambiguityNote: null,
          })),
        })),
    });
    const before = evidenceSnapshot(ctx);
    const res = await classifyTopic(ctx, BCE, { skillIds: ["S4"] });
    expect(res.classified).toBe(1);
    const a = approach(ctx, BCE, "S4");
    expect(a.status).toBe("draft");
    expect(a.draft?.providerLabel).toBe("Suggested by OpenAI (stub-classifier)");
    expect(effectiveDecision(ctx.db, "S4")).toBeNull();
    // A draft never routes learning.
    const { sessionId } = startSession(ctx, { topicId: BCE, purpose: "learn" });
    expect(getSessionView(ctx, sessionId).activities).toEqual([]);

    // Manual choice, labelled chosen by you, with the reason recorded (none invented).
    reviewClassification(ctx, "S4", { action: "edit", proposalId: a.draft!.proposalId, primary: "procedural", secondary: ["conceptual"], reason: "I need to practise the calculation", replacesDecisionId: null });
    const manual = effectiveDecision(ctx.db, "S4")!;
    expect(manual).toMatchObject({ origin: "manual", status: "edited", primaryType: "procedural", reason: "I need to practise the calculation" });
    expect(approach(ctx, BCE, "S4").effective?.chosenByYou).toBe(true);

    // Same request: reused, no new call. Explicit regeneration: a new draft alongside the manual choice.
    expect((await classifyTopic(ctx, BCE, { skillIds: ["S4"] })).reused).toEqual(["S4"]);
    primary = "procedural";
    await classifyTopic(ctx, BCE, { skillIds: ["S4"], regenerate: true });
    const after = approach(ctx, BCE, "S4");
    expect(after.status).toBe("draft");
    expect(after.effective?.decisionId).toBe(manual.id);
    expect(effectiveDecision(ctx.db, "S4")!.primaryType).toBe("procedural");
    // Replacement only through an explicit decision that names the decision it replaces.
    expect(() =>
      reviewClassification(ctx, "S4", { action: "accept", proposalId: after.draft!.proposalId, replacesDecisionId: null }),
    ).toThrow(AppError);
    expect(evidenceSnapshot(ctx)).toEqual(before);
  });
});

describe("P08 provider errors never become offline output", () => {
  it("a live failure is saved as a retryable error; accepted records are preserved", async () => {
    let fail = false;
    const { ctx } = await setup({
      provider: (db) =>
        liveStub(db, async (input) => {
          if (fail) throw new ProviderError("Live provider is busy or unavailable.", "provider_unavailable", true);
          return createMockProvider(db).classifyPacer!(input);
        }),
    });
    await classifyTopic(ctx, BCE);
    // Offline annotations matched by the stub are still validated; accept S4.
    accept(ctx, BCE, "S4");
    fail = true;
    const res = await classifyTopic(ctx, BCE, { regenerate: true });
    expect(res.providerError?.code).toBe("provider_unavailable");
    const kinds = ctx.db.prepare("SELECT kind FROM pacer_proposals WHERE created_at = ? AND rowid > 3").all(ctx.clock.now()) as { kind: string }[];
    expect(kinds.every((k) => k.kind === "error")).toBe(true);
    const s4 = approach(ctx, BCE, "S4");
    expect(s4.status).toBe("accepted");
    expect(s4.failure?.kind).toBe("error");
    expect(approach(ctx, BCE, "S5").status).toBe("error");
  });

  it("offline mode labels authored annotations and abstains on changed context", async () => {
    const { ctx } = await setup();
    await classifyTopic(ctx, BCE);
    expect(approach(ctx, BCE, "S4").draft?.providerLabel).toBe("Offline authored annotation (not model inference)");
    const pc = getPacerContext(ctx.db, "S4")!;
    upsertPacerContext(ctx.db, { ...pc, learningGoal: "Explain BCE to a classmate.", contextVersion: 2 });
    await classifyTopic(ctx, BCE, { skillIds: ["S4"] });
    const s4 = approach(ctx, BCE, "S4");
    expect(s4.status).toBe("abstained");
    expect(s4.draft?.providerLabel).toBe("Offline mode");
  });
});

describe("P09 over-limit requests", () => {
  it("an objective too large on its own is named and not sent; the others are classified in bounded batches", async () => {
    const sent: string[][] = [];
    const { ctx } = await setup({
      provider: (db) =>
        liveStub(db, async (input) => {
          sent.push(input.objectives.map((o) => o.objectiveId));
          return createMockProvider(db).classifyPacer!(input);
        }),
    });
    const pc = getPacerContext(ctx.db, "S4")!;
    upsertPacerContext(ctx.db, { ...pc, auxChunks: [...pc.auxChunks, { chunkId: "S4-long", kind: "illustration", label: "Long", text: "z ".repeat(2000) }] });
    const res = await classifyTopic(ctx, BCE);
    expect(res.skipped.map((s) => s.skillId)).toEqual(["S4"]);
    expect(res.skipped[0].message).toMatch(/Explain what BCE measures.*limit is 4000/);
    expect(sent).toEqual([["S5", "S6"]]);
    const s4 = approach(ctx, BCE, "S4");
    expect(s4.status).toBe("invalid");
    expect(s4.failure?.message).toMatch(/^Not classified/);
    // The stored chunk was not truncated.
    expect(getPacerContext(ctx.db, "S4")!.auxChunks.find((c) => c.chunkId === "S4-long")!.text.length).toBe(4000);
  });
});

describe("P10-P12, P16 learning session activities", () => {
  it("runs Connect -> teaching -> Reconstruct and guided practice without creating evidence from activity completion", async () => {
    const { ctx, clock } = await setup();
    await classifyTopic(ctx, BCE);
    expect(acceptAllDrafts(ctx, BCE, topicApproaches(ctx, BCE).skills.map((s) => s.draft!.proposalId)).accepted).toEqual(["S4", "S5", "S6"]);
    const before = evidenceSnapshot(ctx);

    const { sessionId } = startSession(ctx, { topicId: BCE, purpose: "learn" });
    let view = getSessionView(ctx, sessionId);
    const s4 = view.activities.filter((a) => a.skillId === "S4");
    expect(s4.map((a) => [a.role, a.templateId, a.optional])).toEqual([
      ["primary", "connect_reconstruct", false],
      ["secondary", "claim_support_limits", true],
    ]);
    expect(view.activities.filter((a) => a.skillId === "S5").map((a) => a.templateId)).toEqual(["guided_practice", "connect_reconstruct"]);
    // Activity prompts can teach: their exposure was committed at session start.
    expect(listExposures(ctx.db, sessionId).some((e) => e.contentRef === `pacer-activity:${s4[0].id}`)).toBe(true);

    // Connect before teaching.
    const connect = s4[0];
    expect(() => advanceActivity(ctx, sessionId, connect.id, "continue")).toThrow(AppError);
    const key = randomUUID();
    const r1 = submitActivityResponse(ctx, sessionId, connect.id, { submissionKey: key, stepIndex: 0, text: "Low probability on the true label means a big loss." });
    expect(r1).toMatchObject({ duplicate: false, status: "teach" });
    // P16: duplicate replays once; changed content under the same key is rejected.
    expect(submitActivityResponse(ctx, sessionId, connect.id, { submissionKey: key, stepIndex: 0, text: "Low probability on the true label means a big loss." }).duplicate).toBe(true);
    expect(() => submitActivityResponse(ctx, sessionId, connect.id, { submissionKey: key, stepIndex: 0, text: "changed" })).toThrow(/different content/);
    expect(() => submitActivityResponse(ctx, sessionId, connect.id, { submissionKey: randomUUID(), stepIndex: 1, text: "too early" })).toThrow(AppError);

    // Teaching: explanation exposure first, then reconstruct with the explanation hidden.
    expect(() => advanceActivity(ctx, sessionId, connect.id, "continue")).toThrow(/Read the explanation/);
    await reveal(ctx, sessionId, { kind: "explanation", unitId: "U4" });
    advanceActivity(ctx, sessionId, connect.id, "continue");
    clock.advance(60_000);
    expect(submitActivityResponse(ctx, sessionId, connect.id, { submissionKey: randomUUID(), stepIndex: 1, text: "BCE scores the probability on the true label; accuracy only the thresholded label." }).status).toBe("completed");
    advanceActivity(ctx, sessionId, s4[1].id, "skip");

    // P11: completing reflection/reconstruction created no attempt, assessment, evidence or schedule change.
    expect(evidenceSnapshot(ctx)).toEqual(before);
    expect(currentSkillState(ctx, "S4").evidenceState).toBe("unassessed");
    expect(currentSkillState(ctx, "S4").dueAt).toBeNull();

    // P16: refresh returns the same frozen activities and responses; restarting resumes, never re-freezes.
    view = getSessionView(ctx, sessionId);
    expect(view.activities.find((a) => a.id === connect.id)!.responses.map((r) => r.stepIndex)).toEqual([0, 1]);
    expect(startSession(ctx, { topicId: BCE, purpose: "learn" })).toEqual({ sessionId, resumed: true });
    expect(getSessionView(ctx, sessionId).activities.length).toBe(view.activities.length);

    // Ordinary practice question for S4, then guided practice on S5 (P12: supported, never independent).
    await submitAnswer(ctx, sessionId, { sessionQuestionId: view.current!.sessionQuestionId, submissionKey: randomUUID(), answer: exampleAnswer(view.current!.question.id, "correct") });
    advanceLearning(ctx, sessionId);
    view = getSessionView(ctx, sessionId);
    expect(view.current!.skill.id).toBe("S5");
    const s5q = view.current!.question.id;
    await submitAnswer(ctx, sessionId, { sessionQuestionId: view.current!.sessionQuestionId, submissionKey: randomUUID(), answer: exampleAnswer(s5q, "correct") });
    const s5 = currentSkillState(ctx, "S5");
    expect(s5.evidenceState).toBe("supported");
    expect(s5.lastIndependentAt).toBeNull();

    // Topic history shows learning responses as learning activities, not checks.
    const history = getTopicView(ctx, BCE).history.filter((h) => h.kind === "activity");
    expect(history.length).toBe(2);
    expect(history[0]).toMatchObject({ kind: "activity", typeLabel: "Conceptual" });

    // P12: a later fresh check uses the unchanged independent rules (a fresh family; a pass counts independently).
    clock.advance(MS_DAY + 60_000);
    const check = startSession(ctx, { topicId: BCE, purpose: "check", skillIds: ["S5"], size: 1 });
    const cv = getSessionView(ctx, check.sessionId);
    expect(cv.activities).toEqual([]);
    expect(cv.current!.question.id).not.toBe(s5q);
    await submitAnswer(ctx, check.sessionId, { sessionQuestionId: cv.current!.sessionQuestionId, submissionKey: randomUUID(), answer: exampleAnswer(cv.current!.question.id, "correct") });
    expect(currentSkillState(ctx, "S5").evidenceState).toBe("demonstrated_once");
  });

  it("P10: an accepted type without an authored template falls back honestly to ordinary learning", async () => {
    const { ctx } = await setup();
    reviewClassification(ctx, "S2", { action: "edit", primary: "analogous", secondary: [], reason: null, replacesDecisionId: null });
    expect(approach(ctx, LIKELIHOOD, "S2").route).toMatchObject({ primaryAvailable: false, primaryLabel: "No prepared activity" });
    const { sessionId } = startSession(ctx, { topicId: LIKELIHOOD, purpose: "learn" });
    const view = getSessionView(ctx, sessionId);
    const s2 = view.activities.filter((a) => a.skillId === "S2");
    expect(s2).toHaveLength(1);
    expect(s2[0]).toMatchObject({ templateId: "none", status: "unavailable", label: "No prepared activity for this approach" });
    expect(view.items.length).toBe(2);
    expect(listDecisions(ctx.db, "S2")[0].reason).toBeNull();
  });
});

describe("learner-supplied familiar connection", () => {
  it("makes an existing decision stale, then lets an analogous choice map and critique the learner's own comparison", async () => {
    const { ctx } = await setup();
    reviewClassification(ctx, "S2", { action: "edit", primary: "conceptual", secondary: [], reason: null, replacesDecisionId: null });
    expect(approach(ctx, LIKELIHOOD, "S2").status).toBe("edited");

    const summary = setSkillConnection(ctx, "S2", "  Like multiplying the odds of independent coin flips.  ");
    expect(summary.learnerConnection).toBe("Like multiplying the odds of independent coin flips.");
    // The connection is part of the classification context: the earlier choice must be reviewed again.
    expect(summary.status).toBe("stale");

    const prior = approach(ctx, LIKELIHOOD, "S2").effective!.decisionId;
    reviewClassification(ctx, "S2", { action: "edit", primary: "analogous", secondary: [], reason: null, replacesDecisionId: prior });
    expect(approach(ctx, LIKELIHOOD, "S2").route).toMatchObject({ primaryAvailable: true, primaryLabel: "Map and critique a comparison" });
    const { sessionId } = startSession(ctx, { topicId: LIKELIHOOD, purpose: "learn" });
    const s2 = getSessionView(ctx, sessionId).activities.filter((a) => a.skillId === "S2");
    expect(s2[0]).toMatchObject({ templateId: "map_critique", status: "open" });
    expect(s2[0].excerpts).toEqual([
      expect.objectContaining({ chunkId: "learner-connection", origin: "learner", text: "Like multiplying the odds of independent coin flips." }),
    ]);
    // Activity completion still never creates evidence.
    const before = evidenceSnapshot(ctx);
    submitActivityResponse(ctx, sessionId, s2[0].id, { submissionKey: randomUUID(), stepIndex: 0, text: "Flips map to examples." });
    expect(evidenceSnapshot(ctx)).toEqual(before);
  });

  it("clears with empty text and rejects over-long text", async () => {
    const { ctx } = await setup();
    setSkillConnection(ctx, "S2", "coin flips");
    expect(setSkillConnection(ctx, "S2", "   ").learnerConnection).toBeNull();
    expect(() => setSkillConnection(ctx, "S2", "x".repeat(501))).toThrow(/under 500 characters/);
  });
});

describe("P13 exposure before answer-revealing detail", () => {
  it("opening rationales during an active check records help in that check, even from another view", async () => {
    const { ctx } = await setup();
    await classifyTopic(ctx, BCE);
    const check = startSession(ctx, { topicId: BCE, purpose: "check", skillIds: ["S4"], size: 1 });
    // The check itself never carries classification metadata, and the topic summary has no rationale.
    expect(getSessionView(ctx, check.sessionId).activities).toEqual([]);
    expect(JSON.stringify(getTopicView(ctx, BCE).learningApproach)).not.toMatch(/rationale|quote|penalises/);

    const details = revealApproachDetails(ctx, BCE, ["S4"]);
    expect(details.exposuresRecorded).toBe(1);
    expect(details.skills[0].draftDetail?.kind).toBe("suggestion");
    const exp = listExposures(ctx.db, check.sessionId);
    expect(exp.some((e) => e.kind === "explanation" && e.contentRef === "pacer-detail:S4" && e.affectedSkillIds.includes("S4"))).toBe(true);

    const cv = getSessionView(ctx, check.sessionId);
    await submitAnswer(ctx, check.sessionId, { sessionQuestionId: cv.current!.sessionQuestionId, submissionKey: randomUUID(), answer: exampleAnswer("S4-A", "correct") });
    // The answer was exposed: it cannot count as independent.
    expect(currentSkillState(ctx, "S4").evidenceState).toBe("supported");
  });

  it("detail with no active session records nothing", async () => {
    const { ctx } = await setup();
    await classifyTopic(ctx, BCE);
    expect(revealApproachDetails(ctx, BCE).exposuresRecorded).toBe(0);
  });
});

describe("P14 reference cannot weaken requirements", () => {
  it("an accepted reference classification leaves required skills, review resources and checks unchanged", async () => {
    const { ctx } = await setup();
    const questionsBefore = JSON.stringify(listQuestionsForSkill(ctx.db, "S1"));
    await classifyTopic(ctx, LIKELIHOOD);
    accept(ctx, LIKELIHOOD, "S1");
    expect(effectiveDecision(ctx.db, "S1")!.primaryType).toBe("reference");
    expect(getSkill(ctx.db, "S1")!.required).toBe(true);
    expect(JSON.stringify(listQuestionsForSkill(ctx.db, "S1"))).toBe(questionsBefore);
    const tv = getTopicView(ctx, LIKELIHOOD);
    expect(tv.skills.find((s) => s.id === "S1")!.reviewAvailable).toBe(true);
    const check = startSession(ctx, { topicId: LIKELIHOOD, purpose: "check" });
    expect(getSessionView(ctx, check.sessionId).progress.total).toBe(2);
    // The learning activity is Capture and locate; recall only for an explicit recall requirement.
    const learn = startSession(ctx, { topicId: LIKELIHOOD, purpose: "learn" });
    const s1 = getSessionView(ctx, learn.sessionId).activities.filter((a) => a.skillId === "S1");
    expect(s1[0].templateId).toBe("capture_locate");
    expect(s1[0].steps.map((s) => s.key)).toEqual(["respond"]);
  });
});

describe("P15 versioning and staleness", () => {
  it("category edits keep evidence; context changes make routing stale for new sessions while history is kept", async () => {
    const { ctx } = await setup();
    await classifyTopic(ctx, BCE);
    accept(ctx, BCE, "S4");
    const first = startSession(ctx, { topicId: BCE, purpose: "learn" });
    const v = getSessionView(ctx, first.sessionId);
    await submitAnswer(ctx, first.sessionId, { sessionQuestionId: v.current!.sessionQuestionId, submissionKey: randomUUID(), answer: exampleAnswer(v.current!.question.id, "correct") });
    const evidence = evidenceSnapshot(ctx);
    const frozenBefore = JSON.stringify(getSessionView(ctx, first.sessionId).activities);

    // Category edit: evidence untouched.
    const eff = effectiveDecision(ctx.db, "S4")!;
    reviewClassification(ctx, "S4", { action: "edit", primary: "procedural", secondary: [], reason: null, replacesDecisionId: eff.id });
    expect(evidenceSnapshot(ctx)).toEqual(evidence);
    // The running session keeps its frozen activity.
    expect(JSON.stringify(getSessionView(ctx, first.sessionId).activities)).toBe(frozenBefore);

    // Context change: stale, review requested, no routing in new sessions; prior decisions and evidence kept.
    const pc = getPacerContext(ctx.db, "S4")!;
    upsertPacerContext(ctx.db, { ...pc, contextVersion: 2, auxChunks: [] });
    expect(approach(ctx, BCE, "S4").status).toBe("stale");
    expect(approach(ctx, BCE, "S4").route).toBeNull();
    expect(listDecisions(ctx.db, "S4")).toHaveLength(2);
    expect(evidenceSnapshot(ctx)).toEqual(evidence);
    ctx.db.prepare("UPDATE sessions SET status = 'ended' WHERE id = ?").run(first.sessionId);
    const second = startSession(ctx, { topicId: BCE, purpose: "learn" });
    expect(getSessionView(ctx, second.sessionId).activities.filter((a) => a.skillId === "S4")).toEqual([]);
    // A suggestion from the old context cannot be accepted against the new one.
    const old = ctx.db.prepare("SELECT id FROM pacer_proposals WHERE skill_id = 'S4' ORDER BY rowid LIMIT 1").get() as { id: string };
    expect(() =>
      reviewClassification(ctx, "S4", { action: "accept", proposalId: old.id, replacesDecisionId: effectiveDecision(ctx.db, "S4")!.id }),
    ).toThrow(/source or context changed/);
  });
});

describe("P17 ordinary learning is always available", () => {
  it("dismissed, abstained, error and no-classification states keep the normal learning flow", async () => {
    const { ctx } = await setup({
      provider: (db) => liveStub(db, async () => Promise.reject(new ProviderError("Timed out.", "provider_timeout", true))),
    });
    expect((await classifyTopic(ctx, BCE)).providerError?.code).toBe("provider_timeout");
    reviewClassification(ctx, "S5", { action: "dismiss", replacesDecisionId: null });
    expect(approach(ctx, BCE, "S5").status).toBe("dismissed");
    expect(approach(ctx, BCE, "S4").status).toBe("error");
    const { sessionId } = startSession(ctx, { topicId: BCE, purpose: "learn" });
    const view = getSessionView(ctx, sessionId);
    expect(view.activities).toEqual([]);
    expect(view.items.length).toBe(3);
    expect(view.current).not.toBeNull();
  });

  it("home keeps its priority order and names a reviewed approach only in a learning task's reason", async () => {
    const { ctx } = await setup();
    const beforeTasks = getHomeView(ctx, 30).plan.map((t) => t.id);
    await classifyTopic(ctx, BCE);
    accept(ctx, BCE, "S4");
    await classifyTopic(ctx, LIKELIHOOD);
    accept(ctx, LIKELIHOOD, "S1");
    const home = getHomeView(ctx, 30);
    expect(home.plan.map((t) => t.id)).toEqual(beforeTasks);
    const learnTask = home.plan.find((t) => "action" in t && t.action === "learn" && t.skillIds.includes("S1"));
    expect(learnTask?.reason).toMatch(/Capture and locate$/);
    expect(JSON.stringify(home)).not.toMatch(/rationale|Supporting evidence: the page/);
  });
});
