// AI-drafted assessment questions for imported courses: generate, review (reveal key / edit / approve / reject), list.
// Drafts live in question_drafts and are never selected for a session; approval copying a re-validated draft into
// `questions` is the only way a drafted question reaches a learner. The learner is also the reviewer, so a draft whose
// answer key was opened can only become a practice question: a later check on it would not be independent.
import {
  getCourse,
  getSkill,
  getTopic,
  getUnit,
  insertQuestion,
  listQuestionsForSkill,
  listSkillsForTopic,
  listSourcePages,
  listSourcesForCourse,
  newId,
  setQuestionStatus,
  type SkillRow,
  type UnitRow,
} from "../db/repo";
import {
  decideQuestionDraft,
  draftForQuestion,
  getQuestionDraft,
  insertQuestionDraft,
  listQuestionDraftsForSkill,
  markDraftAnswerSeen,
  updateQuestionDraftContent,
  type QuestionDraftRow,
} from "../db/questionDraftsRepo";
import { ProviderError } from "../llm/types";
import { checkDraftBatch, draftQuestionSchema, MAX_DRAFT_SOURCE_CHARS, questionProblems, type DraftQuestion } from "../questions/drafts";
import type { AppContext } from "./context";
import { AppError, notFound } from "./errors";

/** Recorded as the reviewer of a question approved in the app (single-user local app: the learner is the owner). */
export const IN_APP_REVIEWER = "You (in-app review)";

interface Owned {
  skill: SkillRow;
  unit: UnitRow;
  courseId: string;
  courseTitle: string;
}

/** Drafting applies to approved, imported (non-demo) content only. Demo questions are authored fixtures. */
function ownedSkill(ctx: AppContext, skillId: string): Owned {
  const skill = getSkill(ctx.db, skillId);
  if (!skill) throw notFound("Skill");
  const unit = getUnit(ctx.db, skill.unitId)!;
  const topic = getTopic(ctx.db, unit.topicId)!;
  const course = getCourse(ctx.db, topic.courseId)!;
  if (course.isDemo) throw new AppError("validation", "The demo course uses authored questions; drafting is for imported courses.");
  if (course.status !== "approved") throw new AppError("stale_phase", "Approve this draft curriculum before drafting questions.");
  if (unit.approvalStatus !== "approved") throw new AppError("stale_phase", "This subtopic has been revised; draft questions for the current version.");
  return { skill, unit, courseId: course.id, courseTitle: course.title };
}

function unitPages(ctx: AppContext, courseId: string, unit: UnitRow): { page: number; text: string }[] {
  const wanted = new Set(unit.sourceRefs.map((r) => r.page));
  const out: { page: number; text: string }[] = [];
  for (const src of listSourcesForCourse(ctx.db, courseId).filter((s) => s.status === "extracted")) {
    for (const p of listSourcePages(ctx.db, src.id)) if (wanted.has(p.pageNumber)) out.push({ page: p.pageNumber, text: p.text });
  }
  return out.sort((a, b) => a.page - b.page);
}

function providerIdentity(ctx: AppContext): { mode: "mock" | "live"; model: string | null } {
  if (ctx.providerStatus.mode === "mock") return { mode: "mock", model: null };
  const model = ctx.providerStatus.models?.curriculum ?? ctx.provider.models?.curriculum ?? ctx.providerStatus.model ?? "unconfigured";
  return { mode: "live", model: `${ctx.providerStatus.vendor ?? ctx.provider.vendor ?? "live"}:${model}` };
}

export function draftProviderLabel(d: Pick<QuestionDraftRow, "providerMode" | "providerModel">): string {
  return d.providerMode === "mock" ? "Offline sample question (authored, not model output)" : `Drafted by ${d.providerModel ?? "a live model"}`;
}

/**
 * One bounded provider call for one skill. Valid questions are stored as drafts and malformed ones as `invalid`, so
 * a bad question never hides a good one. Earlier drafts and approved questions are untouched.
 */
export async function generateQuestionDrafts(ctx: AppContext, skillId: string) {
  const { skill, unit, courseId, courseTitle } = ownedSkill(ctx, skillId);
  const pages = unitPages(ctx, courseId, unit);
  if (pages.length === 0) throw new AppError("unavailable_reviewed_content", "This subtopic has no extracted source pages to write questions from.");
  const chars = pages.reduce((n, p) => n + p.text.length, 0);
  if (chars > MAX_DRAFT_SOURCE_CHARS) {
    throw new AppError("validation", `This subtopic's pages hold ${chars} characters (limit ${MAX_DRAFT_SOURCE_CHARS}). Split it into smaller subtopics first.`);
  }
  if (!ctx.provider.draftQuestions) throw new AppError("provider_unavailable", "This provider cannot draft questions.");

  let res;
  try {
    res = await ctx.provider.draftQuestions({ courseTitle, unitTitle: unit.title, objective: skill.objective, sourcePages: pages });
  } catch (err) {
    if (err instanceof ProviderError) throw new AppError(err.code, err.message, err.retryable);
    throw err;
  }
  const { drafts, batchProblems } = checkDraftBatch(
    res.batch,
    pages.map((p) => p.page),
  );
  const prov = providerIdentity(ctx);
  const providerModel = res.meta.mode === "live" ? `${res.meta.vendor ?? "live"}:${res.meta.model}` : prov.model;
  const batchId = newId();
  const now = ctx.clock.now();
  ctx.db.transaction(() => {
    drafts.forEach((d, i) => {
      insertQuestionDraft(ctx.db, {
        skillId: skill.id,
        skillVersion: skill.version,
        batchId,
        position: i,
        status: d.ok ? "draft" : "invalid",
        question: d.question,
        problems: d.ok ? [] : d.problems,
        providerMode: res.meta.mode === "live" ? "live" : "mock",
        providerModel,
        promptVersion: res.meta.promptVersion,
        createdAt: now,
      });
    });
  })();
  return { drafted: drafts.filter((d) => d.ok).length, invalid: drafts.filter((d) => !d.ok).length, batchProblems, skill: skillDraftsView(ctx, skill, unit) };
}

/** The parts of a draft that are safe to show before the answer key is opened. */
function publicPart(question: unknown): { familyRole: string | null; transferChange: string; taskType: string | null; prompt: string; sourcePages: number[] } {
  const q = (question ?? {}) as Partial<DraftQuestion>;
  return {
    familyRole: typeof q.familyRole === "string" ? q.familyRole : null,
    transferChange: typeof q.transferChange === "string" ? q.transferChange : "",
    taskType: typeof q.taskType === "string" ? q.taskType : null,
    prompt: typeof q.prompt === "string" ? q.prompt : "(no prompt)",
    sourcePages: Array.isArray(q.sourcePages) ? q.sourcePages.filter((p): p is number => typeof p === "number") : [],
  };
}

function skillDraftsView(ctx: AppContext, skill: SkillRow, unit: UnitRow) {
  const all = listQuestionDraftsForSkill(ctx.db, skill.id);
  const usable = listQuestionsForSkill(ctx.db, skill.id).filter((q) => q.status !== "excluded");
  return {
    skillId: skill.id,
    objective: skill.objective,
    unitTitle: unit.title,
    sourcePages: unit.sourceRefs.map((r) => r.page),
    questions: usable.map((q) => {
      const origin = draftForQuestion(ctx.db, q.id);
      return {
        id: q.id,
        prompt: q.prompt,
        taskType: q.taskType,
        isTransfer: q.isTransfer,
        practiceOnly: q.practiceOnly,
        origin: origin ? ("ai_draft" as const) : ("bank" as const),
        originLabel: origin ? draftProviderLabel(origin) : q.status === "owner_reviewed" ? "Reviewed question bank" : "Imported question bank",
      };
    }),
    pending: all
      .filter((d) => d.status === "draft" || d.status === "invalid")
      .map((d) => ({
        id: d.id,
        status: d.status as "draft" | "invalid",
        ...publicPart(d.question),
        // Problems name criteria and values, so they are shown only with the key.
        problemCount: d.problems.length,
        answerSeen: d.answerSeen,
        answerKey: d.answerSeen ? { question: d.question, problems: d.problems } : null,
        edited: d.edited,
        providerLabel: draftProviderLabel(d),
        createdAt: d.createdAt,
      })),
    rejectedCount: all.filter((d) => d.status === "rejected").length,
  };
}

/** Review state for every current skill in an imported topic; `available` is false for demo or unapproved courses. */
export function topicQuestionDrafts(ctx: AppContext, topicId: string) {
  const topic = getTopic(ctx.db, topicId);
  if (!topic) throw notFound("Topic");
  const course = getCourse(ctx.db, topic.courseId)!;
  const available = !course.isDemo && course.status === "approved";
  const skills = available
    ? listSkillsForTopic(ctx.db, topicId)
        .filter((s) => s.unit.approvalStatus === "approved")
        .map((s) => skillDraftsView(ctx, s, s.unit))
    : [];
  return { available, providerMode: ctx.providerStatus.mode, skills };
}

function reviewable(ctx: AppContext, draftId: string): { draft: QuestionDraftRow; owned: Owned } {
  const draft = getQuestionDraft(ctx.db, draftId);
  if (!draft) throw notFound("Question draft");
  const owned = ownedSkill(ctx, draft.skillId);
  if (draft.status !== "draft" && draft.status !== "invalid") throw new AppError("conflict", `This draft was already ${draft.status}.`);
  if (draft.skillVersion !== owned.skill.version) throw new AppError("stale_phase", "The objective changed after this draft was written; draft new questions.");
  // Reviewing question content during an open check on the same topic would be outside help for that check.
  const openCheck = ctx.db
    .prepare("SELECT 1 FROM sessions WHERE topic_id = ? AND mode = 'review' AND status = 'active' LIMIT 1")
    .get(owned.unit.topicId);
  if (openCheck) throw new AppError("stale_phase", "A check is open on this topic. Finish it before reviewing new questions.");
  return { draft, owned };
}

/**
 * Open the answer key (reference, rubric, hints, examples). Recorded before it is returned: from then on the draft can
 * only become a practice question, because a later check on it would not be independent.
 */
export function revealDraftAnswerKey(ctx: AppContext, draftId: string) {
  const { draft, owned } = reviewable(ctx, draftId);
  if (!draft.answerSeen) markDraftAnswerSeen(ctx.db, draft.id);
  return skillDraftsView(ctx, owned.skill, owned.unit);
}

/** Replace the draft's content with the owner's edit. Needs the open key; the edit must pass every check. */
export function editQuestionDraft(ctx: AppContext, draftId: string, input: unknown) {
  const { draft, owned } = reviewable(ctx, draftId);
  if (!draft.answerSeen) throw new AppError("validation", "Open the answer key before editing this question.");
  const question = draftQuestionSchema.parse(input);
  const problems = questionProblems(question, owned.unit.sourceRefs.map((r) => r.page));
  if (problems.length) throw new AppError("validation", `This question can't be saved yet: ${problems.join("; ")}.`);
  updateQuestionDraftContent(ctx.db, draftId, question, "draft", []);
  return skillDraftsView(ctx, owned.skill, owned.unit);
}

/**
 * Approval re-validates, then atomically inserts the question and marks the draft approved.
 * - `checks`: only while the answer key is unopened. Stored as authored_fixture with no reviewer, because nobody
 *   checked the marking scheme; the topic page labels it as an AI draft.
 * - `practice`: always allowed. Stored practice-only and owner_reviewed when the key was read.
 */
export function approveQuestionDraft(ctx: AppContext, draftId: string, use: "checks" | "practice") {
  const { draft, owned } = reviewable(ctx, draftId);
  if (draft.status === "invalid") throw new AppError("validation", "Open the answer key and fix the listed problems before approving this question.");
  if (use === "checks" && draft.answerSeen) {
    throw new AppError("validation", "You've seen this question's answer key, so it can only be approved for practice.");
  }
  const parsed = draftQuestionSchema.safeParse(draft.question);
  const problems = parsed.success ? questionProblems(parsed.data, owned.unit.sourceRefs.map((r) => r.page)) : ["stored draft is malformed"];
  if (!parsed.success || problems.length) throw new AppError("validation", `This question can't be approved: ${problems.join("; ")}.`);
  const q: DraftQuestion = parsed.data;
  const now = ctx.clock.now();
  const questionId = `${owned.skill.id}-q-${draft.id.slice(0, 8)}`;
  const reviewed = draft.answerSeen;
  ctx.db.transaction(() => {
    if (!decideQuestionDraft(ctx.db, draft.id, ["draft"], "approved", now, null)) throw new AppError("conflict", "This draft was already decided.");
    insertQuestion(ctx.db, {
      id: questionId,
      skillId: owned.skill.id,
      version: 1,
      // Each approved draft is its own structural family, so a later check can prefer an unseen one.
      familyId: `draft-${draft.id}`,
      isTransfer: q.familyRole === "new_context",
      taskType: q.taskType,
      prompt: q.prompt,
      reference: { summary: q.referenceSummary, numericChecks: q.numericChecks },
      rubric: { version: 1, criteria: q.criteria },
      hints: q.hints,
      sourceRefs: q.sourcePages.map((page) => ({ page })),
      revealSkillIds: [owned.skill.id],
      status: reviewed ? "owner_reviewed" : "authored_fixture",
      examples: q.examples.map((e) => ({ ...e, judgements: [], possibleMisconception: null })),
      practiceOnly: use === "practice",
    });
    if (reviewed) setQuestionStatus(ctx.db, questionId, "owner_reviewed", IN_APP_REVIEWER, now);
    ctx.db.prepare("UPDATE question_drafts SET question_id = ? WHERE id = ?").run(questionId, draft.id);
  })();
  return skillDraftsView(ctx, owned.skill, owned.unit);
}

export function rejectQuestionDraft(ctx: AppContext, draftId: string) {
  const { draft, owned } = reviewable(ctx, draftId);
  if (!decideQuestionDraft(ctx.db, draft.id, ["draft", "invalid"], "rejected", ctx.clock.now(), null)) {
    throw new AppError("conflict", "This draft was already decided.");
  }
  return skillDraftsView(ctx, owned.skill, owned.unit);
}
