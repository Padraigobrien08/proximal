// AI-drafted learning-activity material for imported courses: request (background job), generate, list, approve,
// reject. Unlike check questions, activity material never affects evidence, so the owner reviews all of it openly.
// Approval copies the material into pacer_contexts (activities read it from there) and, when the unit had none, the
// drafted explanation into the unit, which makes it the unit's checked explanation.
import { enqueueJob, latestJob } from "../db/jobsRepo";
import {
  decideMaterialDraft,
  getMaterialDraft,
  getPacerContext,
  insertMaterialDraft,
  listMaterialDraftsForSkill,
  upsertPacerContext,
  type MaterialDraftRow,
} from "../db/pacerRepo";
import {
  getCourse,
  getTopic,
  getUnit,
  listQuestionsForSkill,
  listSkillsForTopic,
  pagesForRefs,
  listSourcesForCourse,
  setUnitExplanation,
  type SkillRow,
  type UnitRow,
} from "../db/repo";
import { notifyJobsQueued } from "../jobs/signal";
import { ProviderError } from "../llm/types";
import { checkMaterialDraft, MAX_MATERIAL_SOURCE_CHARS, materialDraftSchema, toActivityMaterial } from "../pacer/materialDrafts";
import { TEMPLATE_LABEL, templateAvailable, type ActivityMaterial, type TemplateId } from "../pacer/registry";
import type { AppContext } from "./context";
import { AppError, notFound } from "./errors";
import { ownedSkill, unitPages } from "./questionDrafts";

function materialSource(ctx: AppContext, courseId: string, unit: UnitRow) {
  const pages = unitPages(ctx, courseId, unit);
  if (pages.length === 0) throw new AppError("unavailable_reviewed_content", "This subtopic has no extracted source pages to prepare activities from.");
  const chars = pages.reduce((n, p) => n + p.text.length, 0);
  if (chars > MAX_MATERIAL_SOURCE_CHARS) {
    throw new AppError("validation", `This subtopic's pages hold ${chars} characters (limit ${MAX_MATERIAL_SOURCE_CHARS}). Split it into smaller subtopics first.`);
  }
  return pages;
}

/**
 * Page chunk ids exactly as the classifier and activities name them (services/pacer.ts chunksFor): p3, or s2p3 for
 * the second extracted source when a course has several. A page is attributed to the source this unit cites it from.
 */
function chunkIdFor(ctx: AppContext, courseId: string, unit: UnitRow): (page: number) => string {
  if (listSourcesForCourse(ctx.db, courseId).filter((s) => s.status === "extracted").length <= 1) return (page) => `p${page}`;
  const owner = new Map<number, number>();
  for (const p of pagesForRefs(ctx.db, courseId, unit.sourceRefs, { extractedOnly: true })) if (!owner.has(p.page)) owner.set(p.page, p.sourceIndex);
  return (page) => `s${owner.get(page) ?? 1}p${page}`;
}

/** Queue drafting for one skill (cheap checks first); the worker runs generateMaterialDraft. */
export function requestMaterialDraft(ctx: AppContext, skillId: string) {
  const { skill, unit, courseId } = ownedSkill(ctx, skillId);
  materialSource(ctx, courseId, unit);
  enqueueJob(ctx.db, "draft_material", skill.id, ctx.clock.now());
  notifyJobsQueued();
  return skillMaterialView(ctx, skill, unit);
}

/** One provider call for one skill (background job). Malformed or ungrounded output is stored as invalid. */
export async function generateMaterialDraft(ctx: AppContext, skillId: string) {
  const { skill, unit, courseId, courseTitle } = ownedSkill(ctx, skillId);
  const pages = materialSource(ctx, courseId, unit);
  if (!ctx.provider.draftMaterial) throw new AppError("provider_unavailable", "This provider cannot prepare activities.");
  const explanationWanted = !unit.explanation;
  let res;
  try {
    res = await ctx.provider.draftMaterial({ courseTitle, unitTitle: unit.title, objective: skill.objective, sourcePages: pages, explanationWanted });
  } catch (err) {
    if (err instanceof ProviderError) throw new AppError(err.code, err.message, err.retryable);
    throw err;
  }
  const checked = checkMaterialDraft(res.draft, pages, { explanationWanted });
  insertMaterialDraft(ctx.db, {
    skillId: skill.id,
    skillVersion: skill.version,
    status: checked.ok ? "draft" : "invalid",
    draft: checked.draft,
    problems: checked.ok ? [] : checked.problems,
    providerMode: res.meta.mode === "live" ? "live" : "mock",
    providerModel: res.meta.mode === "live" ? `${res.meta.vendor ?? "live"}:${res.meta.model}` : null,
    promptVersion: res.meta.promptVersion,
    createdAt: ctx.clock.now(),
  });
  return skillMaterialView(ctx, skill, unit);
}

const TEMPLATES: TemplateId[] = ["connect_reconstruct", "create_analogy", "claim_support_limits", "capture_locate"];

/** Which activities this skill's approved material makes available, and the pending draft for review. */
function skillMaterialView(ctx: AppContext, skill: SkillRow, unit: UnitRow) {
  const material: ActivityMaterial = getPacerContext(ctx.db, skill.id)?.material ?? {};
  const facts = { material, hasCheckedExplanation: !!unit.explanation, hasPracticeQuestion: false, hasApprovedAnalogyChunk: false, memoryRequirement: "unspecified" as const };
  const all = listMaterialDraftsForSkill(ctx.db, skill.id);
  const pending = [...all].reverse().find((d) => d.status === "draft" || d.status === "invalid") ?? null;
  const job = latestJob(ctx.db, "draft_material", skill.id);
  return {
    skillId: skill.id,
    objective: skill.objective,
    unitTitle: unit.title,
    sourcePages: unit.sourceRefs.map((r) => r.page),
    hasExplanation: !!unit.explanation,
    /** Learning sessions are built around a practice question; activities appear only for skills that have one. */
    hasQuestion: listQuestionsForSkill(ctx.db, skill.id).some((q) => q.status !== "excluded"),
    available: TEMPLATES.filter((t) => templateAvailable(t, facts)).map((t) => ({ templateId: t, label: TEMPLATE_LABEL[t] })),
    pending: pending
      ? {
          id: pending.id,
          status: pending.status as "draft" | "invalid",
          draft: pending.draft,
          problems: pending.problems,
          providerLabel: pending.providerMode === "mock" ? "Offline sample material (authored, not model output)" : `Drafted by ${pending.providerModel ?? "a live model"}`,
        }
      : null,
    drafting: job && job.status !== "done" ? { status: job.status, error: job.error } : null,
  };
}

export function topicMaterialDrafts(ctx: AppContext, topicId: string) {
  const topic = getTopic(ctx.db, topicId);
  if (!topic) throw notFound("Topic");
  const course = getCourse(ctx.db, topic.courseId)!;
  const available = !course.isDemo && course.status === "approved";
  return {
    available,
    providerMode: ctx.providerStatus.mode,
    skills: available
      ? listSkillsForTopic(ctx.db, topicId)
          .filter((s) => s.unit.approvalStatus === "approved")
          .map((s) => skillMaterialView(ctx, s, s.unit))
      : [],
  };
}

function reviewable(ctx: AppContext, draftId: string): { draft: MaterialDraftRow; skill: SkillRow; unit: UnitRow; courseId: string } {
  const draft = getMaterialDraft(ctx.db, draftId);
  if (!draft) throw notFound("Activity draft");
  const { skill, unit, courseId } = ownedSkill(ctx, draft.skillId);
  if (draft.status !== "draft" && draft.status !== "invalid") throw new AppError("conflict", `This draft was already ${draft.status}.`);
  if (draft.skillVersion !== skill.version) throw new AppError("stale_phase", "The objective changed after this draft was written; draft again.");
  return { draft, skill, unit, courseId };
}

/**
 * Approve: re-check against the current pages, then in one transaction merge the material into the skill's context
 * (drafted parts replace the same parts; others are kept) and, if the unit still has none, set its explanation.
 * Learning sessions already running keep the activities they froze at start.
 */
export function approveMaterialDraft(ctx: AppContext, draftId: string) {
  const { draft, skill, unit, courseId } = reviewable(ctx, draftId);
  if (draft.status === "invalid") throw new AppError("validation", "This draft failed its checks. Reject it or draft again.");
  // If the unit gained an explanation since drafting, the drafted one is simply not used.
  const parsed = materialDraftSchema.safeParse(draft.draft);
  const candidate = parsed.success && unit.explanation ? { ...parsed.data, explanation: null } : draft.draft;
  const checked = checkMaterialDraft(candidate, unitPages(ctx, courseId, unit), { explanationWanted: !unit.explanation });
  if (!checked.ok) throw new AppError("validation", `This draft can't be approved: ${checked.problems.join("; ")}.`);
  const material = toActivityMaterial(checked.draft, chunkIdFor(ctx, courseId, unit));
  const now = ctx.clock.now();
  ctx.db.transaction(() => {
    if (!decideMaterialDraft(ctx.db, draft.id, ["draft"], "approved", now)) throw new AppError("conflict", "This draft was already decided.");
    const pc = getPacerContext(ctx.db, skill.id);
    upsertPacerContext(ctx.db, {
      skillId: skill.id,
      contextVersion: pc?.contextVersion ?? 1,
      learningGoal: pc?.learningGoal ?? null,
      memoryRequirement: pc?.memoryRequirement ?? "unspecified",
      auxChunks: pc?.auxChunks ?? [],
      material: { ...(pc?.material ?? {}), ...material },
      updatedAt: now,
    });
    const current = getUnit(ctx.db, unit.id)!;
    if (checked.draft.explanation && !current.explanation) {
      setUnitExplanation(ctx.db, unit.id, checked.draft.explanation.text, checked.draft.explanation.workedExample);
    }
  })();
  return skillMaterialView(ctx, skill, getUnit(ctx.db, unit.id)!);
}

export function rejectMaterialDraft(ctx: AppContext, draftId: string) {
  const { draft, skill, unit } = reviewable(ctx, draftId);
  if (!decideMaterialDraft(ctx.db, draft.id, ["draft", "invalid"], "rejected", ctx.clock.now())) throw new AppError("conflict", "This draft was already decided.");
  return skillMaterialView(ctx, skill, unit);
}
