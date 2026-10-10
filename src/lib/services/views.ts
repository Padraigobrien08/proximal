// Read models for home, topic and course screens. Public data only.
import { qualifiesAsIndependent } from "../domain/evidence";
import { EVIDENCE_LABELS, dueLabel, isApplicationTask } from "../domain/labels";
import { buildQueue, MINUTES_PER_QUESTION, type QueueSkillInput } from "../domain/scheduler";
import type { AttemptOutcome, QuestionPrivate } from "../domain/types";
import {
  evidenceAttemptsForSkill,
  getCourse,
  getTopic,
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
import { currentSkillState } from "./evidence";

export function providerInfo(ctx: AppContext) {
  return { ...ctx.providerStatus };
}

function reviewAvailable(ctx: AppContext, skillId: string): boolean {
  return listQuestionsForSkill(ctx.db, skillId).some((q) => q.status !== "excluded");
}

export function getHomeView(ctx: AppContext, budgetMinutes: number) {
  const now = ctx.clock.now();
  const courses = listCourses(ctx.db);
  const queueInputs: QueueSkillInput[] = [];
  for (const c of courses.filter((c) => c.status === "approved")) {
    for (const t of listTopics(ctx.db, c.id)) {
      for (const s of listSkillsForTopic(ctx.db, t.id)) {
        if (s.unit.approvalStatus !== "approved") continue;
        const st = currentSkillState(ctx, s.id);
        queueInputs.push({
          skillId: s.id,
          objective: s.objective,
          topicId: t.id,
          topicTitle: `${t.title}`,
          topicPosition: (c.isDemo ? 0 : 1000) + t.position,
          evidenceState: st.evidenceState,
          dueAt: st.dueAt,
          reassessmentNeeded: st.reassessmentNeeded,
          transferRequired: s.transferRequired,
          transferCovered: st.transferCovered,
          attempted: evidenceAttemptsForSkill(ctx.db, s.id).length > 0,
          reviewAvailable: reviewAvailable(ctx, s.id),
        });
      }
    }
  }
  const courseOfTopic = new Map<string, { id: string; title: string }>();
  for (const c of courses) for (const t of listTopics(ctx.db, c.id)) courseOfTopic.set(t.id, { id: c.id, title: c.title });
  const blocks = buildQueue(queueInputs, now, budgetMinutes).map((b) => ({
    ...b,
    course: courseOfTopic.get(b.topicId) ?? null,
    items: b.items.map((i) => ({ ...i, dueLabel: i.dueAt !== null ? dueLabel(i.dueAt, now, ctx.timezone) : null })),
  }));
  return {
    provider: providerInfo(ctx),
    budgetMinutes,
    minutesPerQuestion: MINUTES_PER_QUESTION,
    queue: blocks,
    courses: courses.map((c) => ({
      id: c.id,
      title: c.title,
      isDemo: c.isDemo,
      status: c.status,
      topics: listTopics(ctx.db, c.id).map((t) => ({ id: t.id, title: t.title })),
      ...courseSummary(ctx, c.id),
    })),
  };
}

/** Counts for the course card: active skills and how many have independent evidence in their current epoch. */
function courseSummary(ctx: AppContext, courseId: string) {
  const skills = listTopics(ctx.db, courseId).flatMap((t) => listSkillsForTopic(ctx.db, t.id));
  const independent = skills.filter((s) => {
    const state = currentSkillState(ctx, s.id).evidenceState;
    return state === "demonstrated_once" || state === "retention_demonstrated";
  }).length;
  const source = listSourcesForCourse(ctx.db, courseId)[0];
  return {
    topicCount: listTopics(ctx.db, courseId).length,
    skillCount: skills.length,
    independentCount: independent,
    sourceLabel: source ? (source.label ?? source.originalName) : null,
  };
}

export function getTopicView(ctx: AppContext, topicId: string) {
  const topic = getTopic(ctx.db, topicId);
  if (!topic) throw notFound("Topic");
  const course = getCourse(ctx.db, topic.courseId)!;
  const now = ctx.clock.now();
  const units = listUnits(ctx.db, topic.id);

  const skills = listSkillsForTopic(ctx.db, topic.id).map((s) => {
    const st = currentSkillState(ctx, s.id);
    const questions = listQuestionsForSkill(ctx.db, s.id);
    const hasApplicationQuestion = questions.some((q) => q.isTransfer);
    // An "application" skill is one whose initial (non-transfer) questions are calculation/application tasks.
    const applicationSkill = questions.some((q) => !q.isTransfer && isApplicationTask(q.taskType));
    return {
      id: s.id,
      unitId: s.unitId,
      objective: s.objective,
      required: s.required,
      transferRequired: s.transferRequired,
      evidenceState: st.evidenceState,
      label: EVIDENCE_LABELS[st.evidenceState].label,
      labelExplanation: EVIDENCE_LABELS[st.evidenceState].explanation,
      tone: EVIDENCE_LABELS[st.evidenceState].tone,
      reassessmentNeeded: st.reassessmentNeeded,
      lastIndependentAt: st.lastIndependentAt,
      lastIndependentOutcome: st.lastIndependentOutcome,
      dueAt: st.dueAt,
      dueLabel: dueLabel(st.dueAt, now, ctx.timezone),
      stage: st.stage,
      epoch: st.epoch,
      missingApplicationCoverage: s.transferRequired && !st.transferCovered,
      reviewAvailable: questions.some((q) => q.status !== "excluded"),
      hasApplicationQuestion,
      applicationSkill,
      questionStatuses: [...new Set(questions.map((q) => q.status))],
    };
  });

  // Chronological evidence list for this topic.
  type Row = {
    attemptId: string;
    assessmentId: string | null;
    sessionId: string;
    sessionMode: string;
    isDemo: number;
    phase: string;
    status: string;
    submittedAt: number;
    recordOrder: number;
    skillId: string;
    frozen: string;
    outcome: AttemptOutcome | null;
    validity: string | null;
    excluded: number | null;
    excludedReason: string | null;
    providerMode: string | null;
  };
  const rows = ctx.db
    .prepare(
      `SELECT a.id AS attemptId, asm.id AS assessmentId, a.session_id AS sessionId, s.mode AS sessionMode, s.is_demo AS isDemo,
              a.phase, a.status, a.submitted_at AS submittedAt, a.record_order AS recordOrder, sq.skill_id AS skillId,
              sq.frozen_question_json AS frozen, asm.outcome, asm.validity, asm.excluded, asm.excluded_reason AS excludedReason,
              asm.provider_mode AS providerMode
       FROM attempts a
       JOIN session_questions sq ON sq.id = a.session_question_id
       JOIN sessions s ON s.id = a.session_id
       LEFT JOIN assessments asm ON asm.attempt_id = a.id
       WHERE s.topic_id = ?
       ORDER BY a.record_order DESC LIMIT 50`,
    )
    .all(topic.id) as Row[];

  const evidence = rows.map((r) => {
    const q = JSON.parse(r.frozen) as QuestionPrivate;
    const ea = evidenceAttemptsForSkill(ctx.db, r.skillId).find((e) => e.attemptId === r.attemptId)!;
    const independent = qualifiesAsIndependent(ea) && r.outcome !== null;
    return {
      attemptId: r.attemptId,
      assessmentId: r.assessmentId,
      sessionId: r.sessionId,
      sessionMode: r.sessionMode,
      phase: r.phase,
      status: r.status,
      submittedAt: r.submittedAt,
      skillId: r.skillId,
      questionId: q.id,
      familyId: q.familyId,
      isTransfer: q.isTransfer,
      taskType: q.taskType,
      applicationTask: isApplicationTask(q.taskType),
      outcome: r.outcome,
      validity: r.validity,
      excluded: !!r.excluded,
      excludedReason: r.excludedReason,
      providerMode: r.providerMode,
      evidenceKind: r.outcome === null ? "pending" : independent ? "independent" : "supported",
      exposedBeforeSubmission: ea.exposedBeforeSubmission,
      declaredAssistance: ea.declaredAssistance,
    };
  });

  return {
    provider: providerInfo(ctx),
    topic: { id: topic.id, title: topic.title },
    course: { id: course.id, title: course.title, isDemo: course.isDemo, status: course.status },
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
    activeSessions: (
      ctx.db
        .prepare("SELECT id, mode, phase, created_at AS createdAt FROM sessions WHERE topic_id = ? AND status = 'active' ORDER BY created_at DESC")
        .all(topic.id) as { id: string; mode: string; phase: string; createdAt: number }[]
    ),
    evidence,
  };
}

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
