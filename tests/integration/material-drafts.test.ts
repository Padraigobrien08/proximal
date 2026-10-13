import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SAMPLE_PDF_PATH } from "../../src/lib/content/fixtures";
import { getPacerContext } from "../../src/lib/db/pacerRepo";
import { getUnit, getSkill } from "../../src/lib/db/repo";
import { drainJobs } from "../../src/lib/jobs/runner";
import { createMockProvider } from "../../src/lib/llm/factory";
import type { LearningProvider } from "../../src/lib/llm/types";
import { approveCourse, importPdf } from "../../src/lib/services/imports";
import { approveMaterialDraft, rejectMaterialDraft, requestMaterialDraft, topicMaterialDrafts } from "../../src/lib/services/materialDrafts";
import { reviewClassification } from "../../src/lib/services/pacer";
import { approveQuestionDraft, generateQuestionDrafts, revealDraftAnswerKey } from "../../src/lib/services/questionDrafts";
import { getSessionView, startSession } from "../../src/lib/services/sessions";
import { getCourseView } from "../../src/lib/services/views";
import { createTestContext } from "../helpers";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

/** An approved import of the sample lecture; returns the page-1 skill (notation: reference, connect, reconstruct). */
async function imported(provider?: (db: Parameters<typeof createMockProvider>[0]) => LearningProvider) {
  const t = await createTestContext(provider ? { provider, mode: "mock" } : {});
  cleanup = t.cleanup;
  t.ctx.inlineJobs = false;
  const res = await importPdf(t.ctx, t.dir, { name: "lecture.pdf", bytes: readFileSync(SAMPLE_PDF_PATH) });
  approveCourse(t.ctx, res.courseId);
  const topic = getCourseView(t.ctx, res.courseId).topics.find((tp) => tp.units.some((u) => u.sourcePages.includes(1)))!;
  const skillId = topic.units.find((u) => u.sourcePages.includes(1))!.skills[0].id;
  return { ...t, topicId: topic.id, skillId };
}

const view = (ctx: Awaited<ReturnType<typeof imported>>["ctx"], topicId: string, skillId: string) =>
  topicMaterialDrafts(ctx, topicId).skills.find((s) => s.skillId === skillId)!;

describe("activity material for imported subtopics", () => {
  it("drafts in the background, is unused until approved, then enables Connect-and-explain with a checked explanation", async () => {
    const { ctx, topicId, skillId } = await imported();
    const unitId = getSkill(ctx.db, skillId)!.unitId;
    expect(view(ctx, topicId, skillId)).toMatchObject({ hasExplanation: false, available: [], pending: null });

    expect(requestMaterialDraft(ctx, skillId).drafting).toEqual({ status: "queued", error: null });
    await drainJobs(() => ctx);
    const pending = view(ctx, topicId, skillId).pending!;
    expect(pending.status).toBe("draft");
    expect(pending.providerLabel).toMatch(/Offline sample material/);
    // Nothing is used before approval.
    expect(getPacerContext(ctx.db, skillId)).toBeNull();
    expect(getUnit(ctx.db, unitId)!.explanation).toBeNull();

    const after = approveMaterialDraft(ctx, pending.id);
    expect(after.hasExplanation).toBe(true);
    expect(after.available.map((a) => a.templateId).sort()).toEqual(["capture_locate", "connect_reconstruct"]);
    expect(getPacerContext(ctx.db, skillId)!.material.reference).toMatchObject({ chunkId: "p1", page: 1 });

    // Learning sessions are built around a practice question, so the subtopic needs one (step 2 drafts it).
    const { skill: q } = await generateQuestionDrafts(ctx, skillId);
    revealDraftAnswerKey(ctx, q.pending[0].id);
    approveQuestionDraft(ctx, q.pending[0].id, "practice");
    // A conceptual choice now routes to the prepared activity in a learning session.
    reviewClassification(ctx, skillId, { action: "edit", primary: "conceptual", secondary: [], reason: null, replacesDecisionId: null });
    const { sessionId } = startSession(ctx, { topicId, purpose: "learn", skillIds: [skillId] });
    const act = getSessionView(ctx, sessionId).activities.find((a) => a.skillId === skillId)!;
    expect(act).toMatchObject({ templateId: "connect_reconstruct", status: "open", teachUnitId: unitId });
  });

  it("stores ungrounded or unpaired material as invalid, which cannot be approved", async () => {
    let next: unknown = null;
    const { ctx, topicId, skillId } = await imported((db) => {
      const mock = createMockProvider(db);
      mock.draftMaterial = async () => ({ draft: next, meta: { mode: "mock", model: null, promptVersion: "t", usage: null } });
      return mock;
    });
    next = {
      explanation: { text: "An explanation.", workedExample: null },
      connect: { concepts: ["a", "b"], prompt: "Relate them.", hints: [] },
      reconstruct: null,
      createAnalogy: null,
      evidence: null,
      reference: { page: 1, excerpt: "This sentence is not on the page at all.", prompt: "Note it.", recallPrompt: null },
    };
    requestMaterialDraft(ctx, skillId);
    await drainJobs(() => ctx);
    const pending = view(ctx, topicId, skillId).pending!;
    expect(pending.status).toBe("invalid");
    expect(pending.problems).toEqual(
      expect.arrayContaining([expect.stringMatching(/not copied word for word from page 1/), expect.stringMatching(/drafted together/)]),
    );
    expect(() => approveMaterialDraft(ctx, pending.id)).toThrow(/failed its checks/);
    expect(rejectMaterialDraft(ctx, pending.id).pending).toBeNull();
    expect(getPacerContext(ctx.db, skillId)).toBeNull();
  });

  it("refuses the demo course", async () => {
    const { ctx } = await imported();
    const demoSkill = ctx.db.prepare("SELECT s.id FROM skills s JOIN units u ON u.id = s.unit_id WHERE u.topic_id = 'demo-topic-bce' LIMIT 1").get() as { id: string };
    expect(() => requestMaterialDraft(ctx, demoSkill.id)).toThrow(/demo course/);
    expect(topicMaterialDrafts(ctx, "demo-topic-bce").available).toBe(false);
  });
});
