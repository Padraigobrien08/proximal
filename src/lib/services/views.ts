// Read models for home, topic and course screens. Public data only.
import { qualifiesAsIndependent } from "../domain/evidence";
import type { SkillReviewState } from "../domain/types";
import { feedbackView, feedbackVisible, summariseSession } from "./sessions";
import { EVIDENCE_LABELS, FRESHNESS_LABELS, judgedByLabel, dueLabel, formatDateTime, freshnessOf, isApplicationTask, relativeWhen } from "../domain/labels";
import { MINUTES_PER_QUESTION } from "../domain/scheduler";
import { buildStudyPlan, STEP_LABEL, taskNoun, type ActionKind, type PlanSkill, type StudyTask } from "../domain/plan";
import { CHECKED, levelOf, type Level, type LevelRollup } from "../domain/levels";
import type { QuestionPrivate } from "../domain/types";
import {
  evidenceAttemptsForSkill,
  getAssessmentForAttempt,
  getCourse,
  getSkill,
  getTopic,
  getUnit,
  listCourses,
  listQuestionsForSkill,
  listSkillsForTopic,
  listSourcePages,
  listSourcesForCourse,
  listTopics,
  listUnits,
  listSkillsForUnit,
  skillUsedInSession,
} from "../db/repo";
import type { AppContext } from "./context";
import { notFound } from "./errors";
import { displaySkillState, openCheckpointSessionIds } from "./evidence";
import { moduleMastery, topicMastery } from "./mastery";
import { getStudyPlanSettings, plannedModuleIds } from "./settings";

export function providerInfo(ctx: AppContext) {
  return { ...ctx.providerStatus };
}

function reviewAvailable(ctx: AppContext, skillId: string): boolean {
  return listQuestionsForSkill(ctx.db, skillId).some((q) => q.status !== "excluded");
}

export interface CourseListItem {
  id: string;
  title: string;
  isDemo: boolean;
  status: "draft" | "approved";
  topicCount: number;
  requiredSkillCount: number;
  independentlyCheckedSkillCount: number;
  sourceLabel: string | null;
  firstTopicId: string | null;
  /** Subtopic level counts for the whole module. */
  mastery: LevelRollup;
  /** One entry per subtopic, strongest first, for compact level bars. */
  subtopicLevels: { level: Level; due: boolean }[];
}

/** Real course counts: required skills and those with effective independent evidence (flagged passes excluded). */
export function listCourseSummaries(ctx: AppContext): CourseListItem[] {
  const hidden = openCheckpointSessionIds(ctx);
  return listCourses(ctx.db).map((c) => {
    const mastery = moduleMastery(ctx, c.id, hidden);
    const topics = listTopics(ctx.db, c.id);
    const required = topics.flatMap((t) => listSkillsForTopic(ctx.db, t.id)).filter((s) => s.required);
    const independent = required.filter((s) => {
      const state = displaySkillState(ctx, s.id).evidenceState;
      return state === "demonstrated_once" || state === "retention_demonstrated";
    }).length;
    const source = listSourcesForCourse(ctx.db, c.id)[0];
    return {
      id: c.id,
      title: c.title,
      isDemo: c.isDemo,
      status: c.status,
      topicCount: topics.length,
      requiredSkillCount: required.length,
      independentlyCheckedSkillCount: independent,
      sourceLabel: source ? (source.label ?? source.originalName) : null,
      firstTopicId: topics[0]?.id ?? null,
      mastery: mastery.rollup,
      subtopicLevels: mastery.topics
        .flatMap((t) => t.subtopics.map((u) => ({ level: u.level, due: u.due })))
        .sort((a, b) => b.level - a.level),
    };
  });
}

export interface PlanScope {
  courseId?: string;
  topicId?: string;
}

/** Plan inputs from persisted evidence, optionally limited to one module or topic. */
export function collectPlanInput(ctx: AppContext, scope: PlanScope = {}) {
  // Without an explicit module or topic, the learner's plan settings decide which modules are included.
  const included = scope.courseId || scope.topicId ? null : plannedModuleIds(ctx);
  const courses = listCourses(ctx.db).filter(
    (c) => c.status === "approved" && (!scope.courseId || c.id === scope.courseId) && (!included || included.has(c.id)),
  );
  const skills: PlanSkill[] = [];
  const lastAttemptAt = new Map<string, number>();
  courses.forEach((c, ci) => {
    listTopics(ctx.db, c.id).forEach((t, ti) => {
      if (scope.topicId && t.id !== scope.topicId) return;
      listSkillsForTopic(ctx.db, t.id).forEach((s, si) => {
        if (s.unit.approvalStatus !== "approved") return;
        const st = displaySkillState(ctx, s.id);
        const questions = listQuestionsForSkill(ctx.db, s.id).filter((q) => q.status !== "excluded");
        const attempts = evidenceAttemptsForSkill(ctx.db, s.id);
        if (attempts.length > 0) lastAttemptAt.set(s.id, Math.max(...attempts.map((a) => a.submittedAt)));
        skills.push({
          skillId: s.id,
          objective: s.objective,
          label: s.label,
          summary: s.summary,
          primaryTaskType: (questions.find((q) => !q.isTransfer) ?? questions[0])?.taskType ?? null,
          courseId: c.id,
          topicId: t.id,
          topicTitle: t.title,
          order: (c.isDemo ? 0 : 1 + ci) * 1_000_000 + ti * 1000 + si,
          required: s.required,
          evidenceState: st.evidenceState,
          dueAt: st.dueAt,
          reassessmentNeeded: st.reassessmentNeeded,
          attempted: attempts.length > 0,
          reviewAvailable: questions.length > 0,
          learnAvailable: questions.length > 0 || ctx.providerStatus.mode === "live",
        });
      });
    });
  });

  const activeIds = ctx.db.prepare("SELECT id FROM sessions WHERE status = 'active'").all() as { id: string }[];
  const activeSessions = activeIds
    .map((r) => summariseSession(ctx, r.id))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .filter(
      (x) =>
        (!scope.courseId || x.courseId === scope.courseId) &&
        (!scope.topicId || x.topicId === scope.topicId) &&
        (!included || included.has(x.courseId)),
    );
  return { skills, activeSessions, lastAttemptAt };
}

/** Longer sessions may hold more steps: roughly one step per ten minutes, never fewer than three. */
export function maxStepsFor(budgetMinutes: number): number {
  return Math.max(3, Math.round(budgetMinutes / 10));
}

export function planFor(ctx: AppContext, budgetMinutes: number, scope: PlanScope = {}) {
  const { skills, activeSessions } = collectPlanInput(ctx, scope);
  return buildStudyPlan({
    now: ctx.clock.now(),
    budgetMinutes,
    skills,
    activeSessions,
    minutesPerQuestion: MINUTES_PER_QUESTION,
    maxTasks: maxStepsFor(budgetMinutes),
  });
}

export function getHomeView(ctx: AppContext, budgetMinutes: number) {
  const now = ctx.clock.now();
  const { skills, activeSessions, lastAttemptAt } = collectPlanInput(ctx);
  const plan = buildStudyPlan({
    now,
    budgetMinutes,
    skills,
    activeSessions,
    minutesPerQuestion: MINUTES_PER_QUESTION,
    maxTasks: maxStepsFor(budgetMinutes),
  });

  const recentEvidence = skills
    .filter((s) => lastAttemptAt.has(s.skillId))
    .sort((a, b) => lastAttemptAt.get(b.skillId)! - lastAttemptAt.get(a.skillId)! || a.order - b.order)
    .slice(0, 3)
    .map((s) => {
      const st = displaySkillState(ctx, s.skillId);
      const freshness = freshnessOf(st.dueAt, st.reassessmentNeeded, now, ctx.timezone);
      return {
        topicId: s.topicId,
        topicTitle: s.topicTitle,
        skillId: s.skillId,
        objective: s.objective,
        skillLabel: s.label || s.objective,
        summary: s.summary || s.objective,
        taskNoun: taskNoun(s.primaryTaskType),
        evidenceState: st.evidenceState,
        label: EVIDENCE_LABELS[st.evidenceState].label,
        freshness,
        freshnessLabel: freshness ? FRESHNESS_LABELS[freshness] : null,
        lastIndependentCheckAt: st.lastIndependentAt,
        dueAt: st.dueAt,
        dueWhen: st.dueAt !== null ? relativeWhen(st.dueAt, now, ctx.timezone) : null,
      };
    });

  const byId = new Map(skills.map((x) => [x.skillId, x]));
  const describe = <T extends { dueAt: number | null }>(t: T) => ({
    ...t,
    ...("action" in t ? taskDisplay(ctx, t as unknown as StudyTask, byId) : {}),
    dueWhen: t.dueAt !== null ? relativeWhen(t.dueAt, now, ctx.timezone) : null,
    dueExact: t.dueAt !== null ? formatDateTime(t.dueAt, ctx.timezone) : null,
  });

  return {
    provider: providerInfo(ctx),
    selectedBudgetMinutes: budgetMinutes,
    minutesPerQuestion: MINUTES_PER_QUESTION,
    recommendation: plan.recommendation ? describe(plan.recommendation) : null,
    plan: plan.plan.map(describe),
    totalMinutes: plan.totalMinutes,
    upToDate: plan.upToDate,
    nextScheduledCheck: plan.nextScheduledCheck ? describe(plan.nextScheduledCheck) : null,
    recentEvidence,
    courses: listCourseSummaries(ctx),
    modules: moduleStudyCards(ctx, budgetMinutes),
    planSettings: getStudyPlanSettings(ctx),
  };
}

/** Per-module "Study now" data: what a session for just this module would start with. */
function moduleStudyCards(ctx: AppContext, budgetMinutes: number) {
  const included = plannedModuleIds(ctx);
  const now = ctx.clock.now();
  return listCourses(ctx.db)
    .filter((c) => c.status === "approved")
    .map((c) => {
      const { skills, activeSessions } = collectPlanInput(ctx, { courseId: c.id });
      const plan = buildStudyPlan({
        now,
        budgetMinutes,
        skills,
        activeSessions,
        minutesPerQuestion: MINUTES_PER_QUESTION,
        maxTasks: maxStepsFor(budgetMinutes),
      });
      const first = plan.plan.find((t) => t.action !== "view");
      const byId = new Map(skills.map((x) => [x.skillId, x]));
      return {
        id: c.id,
        inPlan: !included || included.has(c.id),
        nextUp: first ? { ...taskDisplay(ctx, first, byId), reason: first.reason, totalMinutes: plan.totalMinutes } : null,
        nextCheckWhen: plan.nextScheduledCheck ? relativeWhen(plan.nextScheduledCheck.dueAt, now, ctx.timezone) : null,
      };
    });
}

export type HomeView = ReturnType<typeof getHomeView>;

/** Subtopic titles and the learner-facing step kind for a plan task. */
function taskDisplay(ctx: AppContext, t: StudyTask, skills: Map<string, PlanSkill>) {
  const titles = [...new Set(t.skillIds.map((id) => getSkill(ctx.db, id)?.unitId).filter((x): x is string => !!x))]
    .map((id) => getUnit(ctx.db, id)?.title)
    .filter((x): x is string => !!x);
  const firstCheck = t.action === "review" && t.skillIds.every((id) => levelOf(skills.get(id)?.evidenceState ?? "unassessed") < CHECKED);
  const kind: ActionKind = firstCheck ? "check" : t.action;
  return { subtopicTitles: titles.length ? titles.join(" · ") : t.topicTitle, kind, kindLabel: STEP_LABEL[kind] };
}

/** Concise explanation of what evidence is still missing for a skill. */
function coverageNote(state: SkillReviewState, reviewAvailable: boolean, transferRequired: boolean): string {
  if (!reviewAvailable) return "Reviewed assessment questions needed before a no-help check.";
  switch (state.evidenceState) {
    case "unassessed":
      return "Not started yet. This is not a failure.";
    case "developing":
      return "The last answer that counted missed a step. Another check is scheduled.";
    case "supported":
      return "Right with help. A no-help check moves it to Checked.";
    case "demonstrated_once":
      return transferRequired && !state.transferCovered
        ? "Right on your own once. A later check on a new-context question moves it to Secure."
        : "Right on your own once. Another no-help check at least a day later moves it to Secure.";
    case "retention_demonstrated":
      return "Right on your own across a delay, including a new-context question.";
  }
}

const EXPOSURE_TEXT: Record<string, string> = {
  hint: "Hint shown",
  solution: "Worked solution shown",
  source: "Source pages shown",
  explanation: "Explanation shown",
  feedback: "Feedback released",
  external_assistance: "Outside help declared",
};

export function getTopicView(ctx: AppContext, topicId: string) {
  const topic = getTopic(ctx.db, topicId);
  if (!topic) throw notFound("Topic");
  const course = getCourse(ctx.db, topic.courseId)!;
  const now = ctx.clock.now();
  const units = listUnits(ctx.db, topic.id);
  const hidden = openCheckpointSessionIds(ctx);
  const source = listSourcesForCourse(ctx.db, course.id)[0] ?? null;

  const skills = listSkillsForTopic(ctx.db, topic.id).map((s) => {
    const st = displaySkillState(ctx, s.id, hidden);
    const questions = listQuestionsForSkill(ctx.db, s.id);
    const published = questions.filter((q) => q.status !== "excluded");
    const freshness = freshnessOf(st.dueAt, st.reassessmentNeeded, now, ctx.timezone);
    const primary = published.find((q) => !q.isTransfer) ?? published[0];
    return {
      id: s.id,
      unitId: s.unitId,
      objective: s.objective,
      required: s.required,
      transferRequired: s.transferRequired,
      evidenceState: st.evidenceState,
      label: EVIDENCE_LABELS[st.evidenceState].label,
      labelExplanation: EVIDENCE_LABELS[st.evidenceState].explanation,
      reassessmentNeeded: st.reassessmentNeeded,
      lastIndependentAt: st.lastIndependentAt,
      lastIndependentOutcome: st.lastIndependentOutcome,
      dueAt: st.dueAt,
      dueLabel: dueLabel(st.dueAt, now, ctx.timezone),
      dueWhen: st.dueAt !== null ? relativeWhen(st.dueAt, now, ctx.timezone) : null,
      dueExact: st.dueAt !== null ? formatDateTime(st.dueAt, ctx.timezone) : null,
      freshness,
      freshnessLabel: freshness ? FRESHNESS_LABELS[freshness] : null,
      isDue: st.dueAt !== null && st.dueAt <= now,
      missingApplicationCoverage: s.transferRequired && !st.transferCovered,
      coverageNote: coverageNote(st, published.length > 0, s.transferRequired),
      reviewAvailable: published.length > 0,
      applicationSkill: !!primary && isApplicationTask(primary.taskType),
      taskType: primary?.taskType ?? null,
      checkInProgress: evidenceAttemptsForSkill(ctx.db, s.id).some((a) => hidden.has(a.sessionId)),
      questionStatuses: [...new Set(questions.map((q) => q.status))],
    };
  });

  // Chronological history: original answers, assessments, help used and supported corrections.
  type Row = {
    attemptId: string;
    sessionId: string;
    sessionMode: string;
    sessionPurpose: string;
    phase: string;
    status: string;
    answer: string;
    dontKnow: number;
    submittedAt: number;
    recordOrder: number;
    skillId: string;
    frozen: string;
  };
  const attemptRows = ctx.db
    .prepare(
      `SELECT a.id AS attemptId, a.session_id AS sessionId, s.mode AS sessionMode, s.purpose AS sessionPurpose, a.phase, a.status,
              a.answer, a.dont_know AS dontKnow, a.submitted_at AS submittedAt, a.record_order AS recordOrder,
              sq.skill_id AS skillId, sq.frozen_question_json AS frozen
       FROM attempts a
       JOIN session_questions sq ON sq.id = a.session_question_id
       JOIN sessions s ON s.id = a.session_id
       WHERE s.topic_id = ?
       ORDER BY a.record_order DESC LIMIT 60`,
    )
    .all(topic.id) as Row[];

  const attemptsHistory = attemptRows.map((r) => {
    const q = JSON.parse(r.frozen) as QuestionPrivate;
    const ea = evidenceAttemptsForSkill(ctx.db, r.skillId).find((e) => e.attemptId === r.attemptId)!;
    const asm = getAssessmentForAttempt(ctx.db, r.attemptId);
    const sealed = hidden.has(r.sessionId); // checkpoint still open: no judgement may surface
    const released = !sealed && !!asm && feedbackVisible(ctx, r.sessionId, r.attemptId);
    const independent = qualifiesAsIndependent(ea);
    const supportUsed = ea.exposedBeforeSubmission || ea.declaredAssistance || r.sessionMode === "learn" || r.phase === "repair";
    let resultLabel: string;
    if (sealed) resultLabel = "Answer saved · results after the check";
    else if (!asm) resultLabel = r.status === "provider_error" ? "Assessment failed · retry available" : "Assessment pending";
    else if (asm.excluded) resultLabel = "Judgement excluded";
    else if (asm.outcome === "uncertain") resultLabel = "Not enough evidence to judge this answer";
    else if (asm.outcome === "pass") resultLabel = independent ? "Right with no help" : "Right with help";
    else resultLabel = supportUsed ? "Missed a step · help used" : "Missed a step";
    return {
      kind: "attempt" as const,
      at: r.submittedAt,
      order: r.recordOrder,
      attemptId: r.attemptId,
      sessionId: r.sessionId,
      skillId: r.skillId,
      questionId: q.id,
      isTransfer: q.isTransfer,
      taskType: q.taskType,
      stage: r.phase === "repair" ? "Correction (practice)" : r.sessionMode === "learn" ? "Practice answer" : "First answer",
      answer: r.dontKnow ? "I don't know" : r.answer,
      resultLabel,
      evidenceKind: sealed || !asm ? "pending" : independent ? "independent" : "supported",
      assessmentId: released ? asm!.id : null,
      excluded: !!asm?.excluded && !sealed,
      excludedReason: sealed ? null : (asm?.excludedReason ?? null),
      providerLabel:
        !asm || sealed
          ? null
          : asm.providerMode === "mock"
            ? "Offline demo fixture"
            : asm.providerMode === "rule"
              ? "Rule (I don't know)"
              : judgedByLabel(asm.providerModel),
      feedback: released ? feedbackView(asm!, q) : null,
    };
  });

  const exposureRows = ctx.db
    .prepare(
      `SELECT e.id, e.kind, e.affected_skill_ids_json AS affected, e.recorded_at AS recordedAt, e.record_order AS recordOrder
       FROM exposures e JOIN sessions s ON s.id = e.session_id
       WHERE s.topic_id = ? AND e.kind IN ('hint', 'solution', 'source', 'external_assistance')
       ORDER BY e.record_order DESC LIMIT 40`,
    )
    .all(topic.id) as { id: string; kind: string; affected: string; recordedAt: number; recordOrder: number }[];
  const helpHistory = exposureRows.map((e) => ({
    kind: "help" as const,
    at: e.recordedAt,
    order: e.recordOrder,
    id: e.id,
    label: EXPOSURE_TEXT[e.kind] ?? e.kind,
    skillIds: JSON.parse(e.affected) as string[],
  }));

  const history = [...attemptsHistory, ...helpHistory].sort((a, b) => b.order - a.order).slice(0, 60);
  const anyAttempt = attemptsHistory.length > 0;
  const dueReview = skills.some((s) => s.isDue && s.reviewAvailable);
  const primaryAction = dueReview ? "review" : anyAttempt ? "check" : "learn";
  const activeSessions = ctx.db
    .prepare("SELECT id, mode, purpose, phase, created_at AS createdAt FROM sessions WHERE topic_id = ? AND status = 'active' ORDER BY created_at DESC")
    .all(topic.id) as { id: string; mode: string; purpose: string; phase: string; createdAt: number }[];

  const mastery = topicMastery(ctx, topic, hidden);

  return {
    provider: providerInfo(ctx),
    topic: { id: topic.id, title: topic.title },
    course: { id: course.id, title: course.title, isDemo: course.isDemo, status: course.status },
    rollup: mastery.rollup,
    subtopics: mastery.subtopics,
    source: source ? { id: source.id, label: source.label ?? source.originalName } : null,
    units: units.map((u) => ({
      id: u.id,
      title: u.title,
      objective: u.objective,
      sourcePages: u.sourceRefs.map((r) => r.page),
      approvalStatus: u.approvalStatus,
      hasCheckedExplanation: !!u.explanation,
    })),
    skills,
    reviewAvailable: skills.some((s) => s.reviewAvailable),
    learnAvailable: skills.some((s) => s.reviewAvailable) || ctx.providerStatus.mode === "live",
    primaryAction,
    activeSessions: activeSessions.map((a) => ({ ...a, startedAt: formatDateTime(a.createdAt, ctx.timezone) })),
    history,
  };
}

export type TopicView = ReturnType<typeof getTopicView>;

export function getCourseView(ctx: AppContext, courseId: string) {
  const course = getCourse(ctx.db, courseId);
  if (!course) throw notFound("Course");
  const sources = listSourcesForCourse(ctx.db, course.id).map((s) => ({
    id: s.id,
    label: s.label ?? s.originalName,
    originalName: s.originalName,
    status: s.status,
    error: s.error,
    pageCount: s.pageCount,
    pages: listSourcePages(ctx.db, s.id).map((p) => ({
      page: p.pageNumber,
      lowTextWarning: p.lowTextWarning,
      charCount: p.text.replace(/\s/g, "").length,
      // Page text is shown only for draft review (before any study).
      text: course.status === "draft" ? p.text : null,
    })),
  }));
  return {
    provider: providerInfo(ctx),
    course: {
      id: course.id,
      title: course.title,
      isDemo: course.isDemo,
      status: course.status,
      suggestions: course.suggestions,
      notice: course.notice,
    },
    sources,
    mastery: moduleMastery(ctx, course.id),
    topics: listTopics(ctx.db, course.id).map((t) => ({
      id: t.id,
      title: t.title,
      position: t.position,
      units: listUnits(ctx.db, t.id).map((u) => ({
        id: u.id,
        title: u.title,
        objective: u.objective,
        version: u.version,
        approvalStatus: u.approvalStatus,
        sourcePages: u.sourceRefs.map((r) => r.page),
        skills: listSkillsForUnit(ctx.db, u.id).map((s) => ({
          id: s.id,
          objective: s.objective,
          required: s.required,
          version: s.version,
          frozen: skillUsedInSession(ctx.db, s.id),
          reviewAvailable: reviewAvailable(ctx, s.id),
        })),
      })),
    })),
  };
}
