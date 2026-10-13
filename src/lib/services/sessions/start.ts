// Sessions: starting a session, question selection and resumption.
import { selectQuestion } from "../../domain/selection";
import type { QuestionPrivate, SessionMode } from "../../domain/types";
import {
  getAssessmentForAttempt,
  getCourse,
  getSession,
  getTopic,
  insertSession,
  insertSessionQuestion,
  lastAttemptByFamily,
  listExposures,
  listQuestionsForSkill,
  usableForChecks,
  listSessionQuestions,
  listSkillsForTopic,
  type AttemptRow,
  type SessionPurpose,
  listAttemptsForSession,
} from "../../db/repo";
import { isUnfinished, type PlanSession } from "../../domain/plan";
import type { AppContext } from "../context";
import { AppError, notFound } from "../errors";
import { currentSkillState } from "../evidence";
import { freezeSessionActivities } from "../pacer";
import { DEFAULT_CHECKPOINT_QUESTIONS, MAX_CHECKPOINT_QUESTIONS } from "./shared";

// ---------------------------------------------------------------- start

export interface StartSessionInput {
  topicId: string;
  /** Legacy shape: learn | review. `purpose` is preferred. */
  mode?: SessionMode;
  /** learn (teach first), practice (targeted supported repair), check (independent diagnostic), review (due revisit). */
  purpose?: SessionPurpose;
  skillIds?: string[];
  size?: number;
}

export function modeForPurpose(p: SessionPurpose): SessionMode {
  return p === "check" || p === "review" ? "review" : "learn";
}

function prioritiseForReview(ctx: AppContext, skillIds: string[]): string[] {
  const now = ctx.clock.now();
  const score = (id: string) => {
    const s = currentSkillState(ctx, id);
    const due = s.dueAt !== null && s.dueAt <= now;
    if (due && s.reassessmentNeeded) return 0;
    if (due) return 1;
    if (s.evidenceState === "unassessed" || s.evidenceState === "developing" || s.evidenceState === "supported") return 2;
    if (s.evidenceState === "demonstrated_once") return 3;
    return 4;
  };
  return skillIds
    .map((id, i) => ({ id, i, score: score(id) }))
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((x) => x.id);
}

export function startSession(ctx: AppContext, input: StartSessionInput): { sessionId: string; resumed: boolean } {
  const topic = getTopic(ctx.db, input.topicId);
  if (!topic) throw notFound("Topic");
  if (!input.mode && !input.purpose) throw new AppError("validation", "Choose learn, practice, check or review.");
  const mode: SessionMode = input.purpose ? modeForPurpose(input.purpose) : input.mode!;
  const course = getCourse(ctx.db, topic.courseId)!;
  if (course.status !== "approved") throw new AppError("stale_phase", "Approve this draft curriculum before studying it.");

  const topicSkills = listSkillsForTopic(ctx.db, topic.id).filter((s) => s.unit.approvalStatus === "approved");
  let skillIds = topicSkills.map((s) => s.id);
  if (input.skillIds?.length) {
    const allowed = new Set(skillIds);
    for (const id of input.skillIds) if (!allowed.has(id)) throw new AppError("validation", `Skill ${id} is not in this topic.`);
    skillIds = input.skillIds;
  }
  // Checks need a question an independent check may use; learning and practice can also use practice-only ones.
  const withQuestions = skillIds.filter((id) =>
    listQuestionsForSkill(ctx.db, id).some((q) => (mode === "review" ? usableForChecks(q) : q.status !== "excluded")),
  );

  // Never start a duplicate: an unfinished active session of the same kind for this topic is resumed instead.
  const existing = findResumableSession(ctx, topic.id, mode, input.skillIds);
  if (existing) return { sessionId: existing, resumed: true };

  let chosen: string[];
  if (mode === "review") {
    if (withQuestions.length === 0) {
      throw new AppError(
        "unavailable_reviewed_content",
        "Reviewed assessment questions needed: independent review is disabled until an owner-authored question bank is attached.",
      );
    }
    const size = Math.min(MAX_CHECKPOINT_QUESTIONS, Math.max(1, input.size ?? DEFAULT_CHECKPOINT_QUESTIONS));
    chosen = (input.skillIds?.length ? withQuestions : prioritiseForReview(ctx, withQuestions)).slice(0, size);
  } else {
    chosen = withQuestions;
  }

  const now = ctx.clock.now();
  const purpose: SessionPurpose =
    input.purpose ??
    (mode === "learn"
      ? "learn"
      : chosen.some((id) => {
            const st = currentSkillState(ctx, id);
            return st.dueAt !== null && st.dueAt <= now && st.lastIndependentAt !== null;
          })
        ? "review"
        : "check");

  return ctx.db.transaction(() => {
    const sessionId = insertSession(ctx.db, {
      topicId: topic.id,
      mode,
      purpose,
      isDemo: course.isDemo,
      status: "active",
      phase: mode === "review" ? "checkpoint" : "learning",
      createdAt: now,
    });
    chosen.forEach((skillId, ordinal) => {
      const questions = listQuestionsForSkill(ctx.db, skillId);
      const pick = selectQuestion(questions, lastAttemptByFamily(ctx.db, skillId), purpose === "practice" ? "practice" : "check", {
        allowPracticeOnly: mode !== "review",
      });
      if (!pick) return;
      const q = questions.find((x) => x.id === pick.questionId)!;
      const frozen: QuestionPrivate = {
        id: q.id,
        skillId: q.skillId,
        taskType: q.taskType,
        prompt: q.prompt,
        version: q.version,
        familyId: q.familyId,
        isTransfer: q.isTransfer,
        reference: q.reference,
        rubric: q.rubric,
        hints: q.hints,
        sourceRefs: q.sourceRefs,
        revealSkillIds: q.revealSkillIds,
        status: q.status,
      };
      insertSessionQuestion(ctx.db, {
        sessionId,
        questionId: q.id,
        skillId,
        ordinal,
        checkpointIndex: mode === "review" ? ordinal : null,
        phase: mode === "review" ? "checkpoint" : "practice",
        frozen,
        repeatedFamily: pick.repeatedFamily,
      });
    });
    // Learning sessions freeze each skill's reviewed PACER approach now; later decisions affect new sessions only.
    if (mode === "learn" && purpose === "learn") {
      const withSq = new Set(listSessionQuestions(ctx.db, sessionId).map((sq) => sq.skillId));
      freezeSessionActivities(
        ctx,
        sessionId,
        course.id,
        chosen.map((id) => ({ skill: topicSkills.find((s) => s.id === id)!, hasPracticeQuestion: withSq.has(id) })),
      );
    }
    return { sessionId, resumed: false };
  })();
}

/** Active, unfinished session of the same mode for this topic (and covering the requested skills, if given). */
function findResumableSession(ctx: AppContext, topicId: string, mode: SessionMode, skillIds?: string[]): string | null {
  const rows = ctx.db
    .prepare("SELECT id FROM sessions WHERE topic_id = ? AND mode = ? AND status = 'active' ORDER BY created_at DESC")
    .all(topicId, mode) as { id: string }[];
  for (const r of rows) {
    const summary = summariseSession(ctx, r.id);
    if (!summary || !isUnfinished(summary)) continue;
    if (skillIds?.length && !skillIds.every((id) => summary.skillIds.includes(id))) continue;
    return r.id;
  }
  return null;
}

/** Persisted session facts used by the plan (resume tier) and duplicate prevention. */
export function summariseSession(ctx: AppContext, sessionId: string): PlanSession | null {
  const session = getSession(ctx.db, sessionId);
  if (!session) return null;
  const topic = getTopic(ctx.db, session.topicId)!;
  const sqs = listSessionQuestions(ctx.db, sessionId);
  const attempts = listAttemptsForSession(ctx.db, sessionId);
  const exposures = listExposures(ctx.db, sessionId);
  const originals = sqs.map((sq) => attempts.find((a) => a.sessionQuestionId === sq.id && a.phase === "original") ?? null);
  const answered = originals.filter(Boolean) as AttemptRow[];
  const unassessed = answered.filter((a) => !getAssessmentForAttempt(ctx.db, a.id) && !a.feedbackWithheld);
  const unresolved: string[] = [];
  if (session.mode === "review") {
    sqs.forEach((sq, i) => {
      const o = originals[i];
      if (!o) return;
      const asm = getAssessmentForAttempt(ctx.db, o.id);
      if (!asm || asm.excluded || asm.outcome === "pass" || asm.outcome === "uncertain") return;
      const repaired = attempts.some(
        (a) => a.sessionQuestionId === sq.id && a.phase === "repair" && getAssessmentForAttempt(ctx.db, a.id)?.outcome === "pass",
      );
      if (!repaired && !unresolved.includes(sq.skillId)) unresolved.push(sq.skillId);
    });
  }
  const lastActivityAt = Math.max(
    session.createdAt,
    ...attempts.map((a) => a.submittedAt),
    ...exposures.map((e) => e.recordedAt),
  );
  return {
    sessionId,
    courseId: topic.courseId,
    topicId: topic.id,
    topicTitle: topic.title,
    mode: session.mode,
    purpose: session.purpose,
    phase: session.phase,
    lastActivityAt,
    answered: answered.length,
    total: sqs.length,
    pendingAssessments: unassessed.length,
    providerErrors: unassessed.filter((a) => a.status === "provider_error").length,
    feedbackReleased: session.feedbackReleasedAt !== null,
    unresolvedRepairSkillIds: unresolved,
    skillIds: [...new Set(sqs.map((sq) => sq.skillId))],
    remainingQuestions: session.mode === "learn" ? Math.max(0, sqs.length - session.currentOrdinal) : 0,
  };
}
