// Learning sessions and independent review checkpoints. Server enforces phase, ordinal and eligibility.
import { qualifiesAsIndependent } from "../domain/evidence";
import { EVIDENCE_LABELS, dueLabel, formatDateTime, relativeWhen } from "../domain/labels";
import { selectQuestion } from "../domain/selection";
import type { ExposureKind, QuestionPrivate, QuestionPublic, SessionMode } from "../domain/types";
import {
  getAssessmentForAttempt,
  getAttemptByKey,
  getCourse,
  getSession,
  getSessionQuestion,
  getSkill,
  getTopic,
  getUnit,
  insertAttempt,
  insertExposure,
  insertSession,
  insertSessionQuestion,
  lastAttemptByFamily,
  listAttemptsForSessionQuestion,
  listExposures,
  listQuestionsForSkill,
  listSessionQuestions,
  listSkillsForTopic,
  listSourcePages,
  listSourcesForCourse,
  setFeedbackWithheld,
  exposedSkillsSoFar,
  updateSession,
  type AssessmentRow,
  type AttemptRow,
  type SessionPurpose,
  type SessionQuestionRow,
  type SessionRow,
  listAttemptsForSession,
} from "../db/repo";
import { isUnfinished, type PlanSession } from "../domain/plan";
import { MAX_ANSWER_CHARS } from "../llm/schemas";
import { ProviderError } from "../llm/types";
import { assessAttempt, type AssessResult } from "./assessments";
import type { AppContext } from "./context";
import { AppError, notFound } from "./errors";
import { currentSkillState } from "./evidence";

export const MAX_CHECKPOINT_QUESTIONS = 3;
export const DEFAULT_CHECKPOINT_QUESTIONS = 2;

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
  const withQuestions = skillIds.filter((id) => listQuestionsForSkill(ctx.db, id).some((q) => q.status !== "excluded"));

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
      const pick = selectQuestion(questions, lastAttemptByFamily(ctx.db, skillId), purpose === "practice" ? "practice" : "check");
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

// ---------------------------------------------------------------- helpers

function requireSession(ctx: AppContext, id: string): SessionRow {
  const s = getSession(ctx.db, id);
  if (!s) throw notFound("Session");
  return s;
}

function originalAttempt(ctx: AppContext, sqId: string): AttemptRow | null {
  return listAttemptsForSessionQuestion(ctx.db, sqId).find((a) => a.phase === "original") ?? null;
}

/** The question the learner may answer now, or null. */
function currentSessionQuestion(ctx: AppContext, session: SessionRow, sqs: SessionQuestionRow[]): SessionQuestionRow | null {
  if (session.status !== "active") return null;
  if (session.mode === "review") {
    if (session.phase !== "checkpoint") return null;
    return sqs.find((sq) => !sq.skipped && !originalAttempt(ctx, sq.id)) ?? null;
  }
  return sqs.find((sq) => sq.ordinal === session.currentOrdinal) ?? null;
}

function toPublic(q: QuestionPrivate): QuestionPublic {
  return { id: q.id, skillId: q.skillId, taskType: q.taskType, prompt: q.prompt };
}

export function feedbackVisible(ctx: Pick<AppContext, "db">, sessionId: string, attemptId: string): boolean {
  return listExposures(ctx.db, sessionId).some((e) => e.kind === "feedback" && e.contentRef.includes(`attempt:${attemptId}`));
}

export interface FeedbackView {
  assessmentId: string;
  outcome: AssessmentRow["outcome"];
  providerMode: AssessmentRow["providerMode"];
  providerModel: string | null;
  validity: AssessmentRow["validity"];
  excluded: boolean;
  excludedReason: string | null;
  problems: string[];
  criteria: {
    criterionId: string;
    description: string;
    essential: boolean;
    fatalIfNotMet: boolean;
    status: string;
    answerQuote: string | null;
    briefReason: string;
  }[];
  possibleMisconception: string | null;
  referenceSummary: string;
}

export function feedbackView(a: AssessmentRow, q: QuestionPrivate): FeedbackView {
  return {
    assessmentId: a.id,
    outcome: a.outcome,
    providerMode: a.providerMode,
    providerModel: a.providerModel,
    validity: a.validity,
    excluded: a.excluded,
    excludedReason: a.excludedReason,
    problems: a.problems,
    criteria: q.rubric.criteria.map((c) => {
      const j = a.criteria.find((x) => x.criterionId === c.id);
      return {
        criterionId: c.id,
        description: c.description,
        essential: c.essential,
        fatalIfNotMet: c.fatalIfNotMet,
        status: j?.status ?? "uncertain",
        answerQuote: j?.answerQuote ?? null,
        briefReason: j?.briefReason ?? "No judgement returned.",
      };
    }),
    possibleMisconception: a.possibleMisconception,
    referenceSummary: q.reference.summary,
  };
}

export interface AttemptView {
  id: string;
  phase: AttemptRow["phase"];
  status: AttemptRow["status"];
  answer: string;
  dontKnow: boolean;
  declaredAssistance: boolean;
  confidence: AttemptRow["confidence"];
  submittedAt: number;
  supportedOnly: boolean;
  lastError: string | null;
  feedbackWithheld: boolean;
  /** Present only once feedback has been released for this attempt. */
  feedback: FeedbackView | null;
}

function attemptView(ctx: AppContext, session: SessionRow, sq: SessionQuestionRow, a: AttemptRow): AttemptView {
  const assessment = getAssessmentForAttempt(ctx.db, a.id);
  const visible = assessment && feedbackVisible(ctx, session.id, a.id);
  const independentShape = session.mode === "review" && a.phase === "original" && !a.declaredAssistance && !a.exposureSnapshot.includes(sq.skillId);
  return {
    id: a.id,
    phase: a.phase,
    status: a.status,
    answer: a.answer,
    dontKnow: a.dontKnow,
    declaredAssistance: a.declaredAssistance,
    confidence: a.confidence,
    submittedAt: a.submittedAt,
    supportedOnly: !independentShape,
    lastError: a.status === "provider_error" ? a.lastError : null,
    feedbackWithheld: a.feedbackWithheld,
    feedback: visible ? feedbackView(assessment, sq.frozen) : null,
  };
}

function revealedContent(ctx: AppContext, sessionId: string, sq: SessionQuestionRow) {
  const exps = listExposures(ctx.db, sessionId);
  const hints = sq.frozen.hints
    .map((text, i) => ({ index: i, text }))
    .filter((h) => exps.some((e) => e.kind === "hint" && e.contentRef === `hint:${sq.id}:${h.index}`));
  const solutionShown = exps.some((e) => e.kind === "solution" && e.contentRef === `solution:${sq.id}`);
  return { hints, solution: solutionShown ? sq.frozen.reference.summary : null };
}

// ---------------------------------------------------------------- view

export function getSessionView(ctx: AppContext, sessionId: string) {
  const session = requireSession(ctx, sessionId);
  const topic = getTopic(ctx.db, session.topicId)!;
  const course = getCourse(ctx.db, topic.courseId)!;
  const sqs = listSessionQuestions(ctx.db, session.id);
  const current = currentSessionQuestion(ctx, session, sqs);
  const now = ctx.clock.now();

  const items = sqs.map((sq) => {
    const skill = getSkill(ctx.db, sq.skillId)!;
    const unit = getUnit(ctx.db, skill.unitId)!;
    const attempts = listAttemptsForSessionQuestion(ctx.db, sq.id);
    const views = attempts.map((a) => attemptView(ctx, session, sq, a));
    const revealed = revealedContent(ctx, session.id, sq);
    const assessedNonPass = attempts.filter((a) => {
      const asm = getAssessmentForAttempt(ctx.db, a.id);
      return asm && !asm.excluded && asm.outcome !== "pass";
    }).length;
    const anyPass = attempts.some((a) => getAssessmentForAttempt(ctx.db, a.id)?.outcome === "pass");
    return {
      sessionQuestionId: sq.id,
      ordinal: sq.ordinal,
      checkpointIndex: sq.checkpointIndex,
      phase: sq.phase,
      skipped: sq.skipped,
      repeatedFamily: sq.repeatedFamily,
      questionStatus: sq.frozen.status,
      question: toPublic(sq.frozen),
      skill: { id: skill.id, objective: skill.objective },
      unit: { id: unit.id, title: unit.title, objective: unit.objective },
      hintCount: sq.frozen.hints.length,
      revealedHints: revealed.hints,
      revealedSolution: revealed.solution,
      attempts: views,
      answered: attempts.some((a) => a.phase === "original"),
      offerAlternatives: !anyPass && assessedNonPass >= 2,
    };
  });

  const answeredOriginals = sqs
    .map((sq) => ({ sq, a: originalAttempt(ctx, sq.id) }))
    .filter((x): x is { sq: SessionQuestionRow; a: AttemptRow } => x.a !== null);

  let results = null;
  if (session.mode === "review" && (session.phase === "results" || session.phase === "repair" || session.status === "ended")) {
    const pending = answeredOriginals.filter(
      (x) => !getAssessmentForAttempt(ctx.db, x.a.id) && !x.a.feedbackWithheld,
    );
    const skillIds = [...new Set(sqs.map((s) => s.skillId))];
    results = {
      allAssessed: pending.length === 0,
      pendingAttemptIds: pending.map((x) => x.a.id),
      feedbackReleased: session.feedbackReleasedAt !== null,
      skills: skillIds.map((skillId) => {
        const skill = getSkill(ctx.db, skillId)!;
        const state = currentSkillState(ctx, skillId);
        const sq = sqs.find((s) => s.skillId === skillId)!;
        const original = originalAttempt(ctx, sq.id);
        const asm = original ? getAssessmentForAttempt(ctx.db, original.id) : null;
        const independent =
          original && asm
            ? qualifiesAsIndependent({
                attemptId: original.id,
                sessionId: session.id,
                submittedAt: original.submittedAt,
                recordOrder: original.recordOrder,
                mode: session.mode,
                phase: original.phase,
                exposedBeforeSubmission: original.exposureSnapshot.includes(skillId),
                declaredAssistance: original.declaredAssistance,
                outcome: asm.outcome,
                validity: asm.validity,
                excluded: asm.excluded,
                familyId: sq.frozen.familyId,
                isTransfer: sq.frozen.isTransfer,
              })
            : false;
        const repaired = listAttemptsForSessionQuestion(ctx.db, sq.id).some(
          (a) => a.phase === "repair" && getAssessmentForAttempt(ctx.db, a.id)?.outcome === "pass",
        );
        return {
          skillId,
          sessionQuestionId: sq.id,
          objective: skill.objective,
          taskType: sq.frozen.taskType,
          answered: !!original,
          originalExcluded: !!asm?.excluded,
          repaired,
          dueWhen: state.dueAt !== null ? relativeWhen(state.dueAt, now, ctx.timezone) : null,
          dueExact: state.dueAt !== null ? formatDateTime(state.dueAt, ctx.timezone) : null,
          originalOutcome: asm ? asm.outcome : null,
          originalIndependent: independent,
          evidenceState: state.evidenceState,
          label: EVIDENCE_LABELS[state.evidenceState].label,
          labelExplanation: EVIDENCE_LABELS[state.evidenceState].explanation,
          reassessmentNeeded: state.reassessmentNeeded,
          transferCovered: state.transferCovered,
          dueAt: state.dueAt,
          dueLabel: dueLabel(state.dueAt, now, ctx.timezone),
        };
      }),
    };
  }

  const resultSummary = results ? summariseResults(results.skills, topic.title) : null;
  const currentItem = current ? items.find((i) => i.sessionQuestionId === current.id) ?? null : null;
  const exps = listExposures(ctx.db, session.id);

  return {
    session: {
      id: session.id,
      mode: session.mode,
      purpose: session.purpose,
      modeLabel: modeLabel(session),
      phase: session.phase,
      status: session.status,
      isDemo: session.isDemo,
      createdAt: session.createdAt,
      feedbackReleasedAt: session.feedbackReleasedAt,
    },
    topic: { id: topic.id, title: topic.title },
    course: { id: course.id, title: course.title, isDemo: course.isDemo },
    provider: { mode: ctx.providerStatus.mode, model: ctx.providerStatus.model, ready: ctx.providerStatus.ready, message: ctx.providerStatus.message },
    progress: {
      total: sqs.length,
      answered: answeredOriginals.length,
      currentOrdinal: current?.ordinal ?? null,
    },
    current: currentItem,
    // Checkpoint: only neutral status for other items before results. Learn/repair: full items.
    items:
      session.mode === "review" && session.phase === "checkpoint"
        ? items.map((i) => ({
            ordinal: i.ordinal,
            skillObjective: i.skill.objective,
            answered: i.answered,
            skipped: i.skipped,
          }))
        : items,
    results: results ? { ...results, ...resultSummary! } : null,
    explanationsShown: exps.filter((e) => e.kind === "explanation").map((e) => e.contentRef),
    // Checked fixture explanations already shown (exposure recorded) can be re-displayed on reload.
    explanations: Object.fromEntries(
      [...new Set(exps.filter((e) => e.kind === "explanation" && !e.contentRef.includes(":gap:")).map((e) => e.contentRef.slice("explanation:".length)))]
        .map((unitId) => getUnit(ctx.db, unitId))
        .filter((u): u is NonNullable<typeof u> => !!u && !!u.explanation)
        .map((u) => [u.id, { unitTitle: u.title, explanation: u.explanation!, workedExample: u.workedExample }]),
    ),
    units: listSkillsForTopic(ctx.db, topic.id).map((s) => ({ unitId: s.unit.id, title: s.unit.title, objective: s.unit.objective })),
    noQuestionsAvailable: sqs.length === 0,
  };
}

export type SessionView = ReturnType<typeof getSessionView>;

/** What the learner is doing now, in plain words. Help never changes this label retroactively. */
function modeLabel(session: SessionRow): string {
  if (session.mode === "review") {
    if (session.phase === "repair") return "Supported practice";
    return session.purpose === "review" ? "Review" : "Independent check";
  }
  return session.purpose === "practice" ? "Supported practice" : "Learn";
}

const NOUN: Record<string, string> = { explain: "explanation", calculate: "calculation", derive: "derivation", apply: "application" };

/** Plain-language lead and the single next action for a finished checkpoint. */
function summariseResults(
  skills: { skillId: string; taskType: string; answered: boolean; originalOutcome: string | null; originalIndependent: boolean; originalExcluded: boolean; repaired: boolean; sessionQuestionId: string }[],
  topicTitle: string,
) {
  const sentences: string[] = [];
  let gap: { skillId: string; sessionQuestionId: string; noun: string } | null = null;
  for (const s of skills) {
    const noun = NOUN[s.taskType] ?? "answer";
    if (!s.answered) continue;
    if (s.originalOutcome === null) sentences.push(`Your ${noun} answer is saved and still being assessed.`);
    else if (s.originalExcluded) sentences.push(`The ${noun} judgement is excluded from your learning record.`);
    else if (s.originalOutcome === "uncertain") sentences.push(`There wasn't enough evidence to judge the ${noun}.`);
    else if (s.originalOutcome === "pass") {
      sentences.push(
        s.originalIndependent
          ? s.taskType === "explain"
            ? `You explained ${topicTitle} independently.`
            : `You completed the ${noun} independently.`
          : `The ${noun} met the criteria with support.`,
      );
    } else if (s.repaired) {
      sentences.push(`${noun.charAt(0).toUpperCase()}${noun.slice(1)} completed with support. A fresh independent check is scheduled.`);
    } else {
      sentences.push(`The ${noun} needs practice.`);
      gap ??= { skillId: s.skillId, sessionQuestionId: s.sessionQuestionId, noun };
    }
  }
  return {
    summary: sentences.join(" "),
    nextAction: gap
      ? { kind: "practise" as const, label: `Practise ${gap.noun}`, sessionQuestionId: gap.sessionQuestionId }
      : { kind: "overview" as const, label: "Return to overview", sessionQuestionId: null },
  };
}

// ---------------------------------------------------------------- answers

export interface SubmitAnswerInput {
  sessionQuestionId: string;
  submissionKey: string;
  answer: string;
  dontKnow?: boolean;
  confidence?: "low" | "medium" | "high" | null;
  declaredAssistance?: boolean;
}

export interface SubmitResult {
  attemptId: string;
  duplicate: boolean;
  message: string;
  assessment: AssessResult | null;
}

export async function submitAnswer(ctx: AppContext, sessionId: string, input: SubmitAnswerInput): Promise<SubmitResult> {
  const answer = input.dontKnow ? "I don't know" : input.answer.trim();
  if (!input.dontKnow && answer.length === 0) throw new AppError("validation", "Write an answer or choose \"I don't know\".");
  if (answer.length > MAX_ANSWER_CHARS) throw new AppError("validation", `Answers are limited to ${MAX_ANSWER_CHARS} characters.`);

  const prepared = ctx.db.transaction(() => {
    const session = requireSession(ctx, sessionId);
    const existing = getAttemptByKey(ctx.db, sessionId, input.submissionKey);
    if (existing) {
      const same =
        existing.sessionQuestionId === input.sessionQuestionId &&
        existing.answer === answer &&
        existing.dontKnow === !!input.dontKnow &&
        existing.declaredAssistance === !!input.declaredAssistance &&
        existing.confidence === (input.confidence ?? null);
      if (!same) throw new AppError("submission_key_conflict", "This submission key was already used with different content.");
      return { attempt: existing, duplicate: true, session };
    }
    if (session.status !== "active") throw new AppError("stale_phase", "This session has ended.");
    const sq = getSessionQuestion(ctx.db, input.sessionQuestionId);
    if (!sq || sq.sessionId !== sessionId) throw notFound("Session question");
    const sqs = listSessionQuestions(ctx.db, sessionId);

    let phase: "original" | "repair";
    if (session.mode === "review") {
      if (session.phase === "checkpoint") {
        const current = currentSessionQuestion(ctx, session, sqs);
        if (!current || current.id !== sq.id) {
          throw new AppError("stale_phase", "That question is not the current checkpoint question.");
        }
        phase = "original";
      } else if (session.phase === "repair") {
        if (!originalAttempt(ctx, sq.id)) throw new AppError("stale_phase", "Unanswered checkpoint questions cannot be repaired.");
        phase = "repair";
      } else {
        throw new AppError("stale_phase", "Checkpoint results are waiting. Review feedback before submitting a correction.");
      }
    } else {
      if (sq.ordinal !== session.currentOrdinal) throw new AppError("stale_phase", "That is not the current practice question.");
      phase = listAttemptsForSessionQuestion(ctx.db, sq.id).length === 0 ? "original" : "repair";
    }

    const now = ctx.clock.now();
    if (input.declaredAssistance) {
      // Self-reported outside help is recorded as an exposure before the submission.
      insertExposure(ctx.db, {
        sessionId,
        kind: "external_assistance",
        affectedSkillIds: sq.frozen.revealSkillIds,
        contentRef: `external:${sq.id}`,
        recordedAt: now,
      });
    }
    const attempt = insertAttempt(ctx.db, {
      sessionId,
      sessionQuestionId: sq.id,
      submissionKey: input.submissionKey,
      answer,
      dontKnow: !!input.dontKnow,
      declaredAssistance: !!input.declaredAssistance,
      confidence: input.confidence ?? null,
      phase,
      exposureSnapshot: [...exposedSkillsSoFar(ctx.db, sessionId)],
      status: "pending",
      submittedAt: now,
    });
    if (session.mode === "review" && session.phase === "checkpoint") {
      const remaining = currentSessionQuestion(ctx, getSession(ctx.db, sessionId)!, sqs);
      if (!remaining) updateSession(ctx.db, sessionId, { phase: "results" });
    }
    return { attempt, duplicate: false, session };
  })();

  const { attempt, duplicate, session } = prepared;
  // Polling/resubmitting never calls the provider again once an assessment exists.
  let assessment: AssessResult | null = null;
  const existingAssessment = getAssessmentForAttempt(ctx.db, attempt.id);
  if (existingAssessment) assessment = { status: "assessed", assessment: existingAssessment };
  else if (!duplicate || attempt.status === "pending") assessment = await assessAttempt(ctx, attempt.id);
  else assessment = { status: attempt.status === "assessing" ? "assessing" : "pending" };

  const instructional = session.mode === "learn" || attempt.phase === "repair";
  if (instructional && assessment.status === "assessed") {
    releaseAttemptFeedback(ctx, sessionId, attempt.id);
  }
  return {
    attemptId: attempt.id,
    duplicate,
    message: instructional ? "Answer checked" : "Answer saved",
    // Never return checkpoint judgements before release.
    assessment: instructional ? assessment : assessment.status === "provider_error" ? assessment : null,
  };
}

/** Record a feedback exposure for one instructional attempt (learn mode / repair), then content may be shown. */
function releaseAttemptFeedback(ctx: AppContext, sessionId: string, attemptId: string) {
  if (feedbackVisible(ctx, sessionId, attemptId)) return;
  const attempt = getAttemptByIdSafe(ctx, attemptId);
  const sq = getSessionQuestion(ctx.db, attempt.sessionQuestionId)!;
  ctx.db.transaction(() => {
    insertExposure(ctx.db, {
      sessionId,
      kind: "feedback",
      affectedSkillIds: sq.frozen.revealSkillIds,
      contentRef: `feedback:attempt:${attemptId}`,
      recordedAt: ctx.clock.now(),
    });
  })();
}

function getAttemptByIdSafe(ctx: AppContext, attemptId: string): AttemptRow {
  const row = ctx.db.prepare("SELECT session_id, submission_key FROM attempts WHERE id = ?").get(attemptId) as
    | { session_id: string; submission_key: string }
    | undefined;
  if (!row) throw notFound("Attempt");
  return getAttemptByKey(ctx.db, row.session_id, row.submission_key)!;
}

/** Retry a pending/provider-error attempt. Instructional attempts get their feedback released on success. */
export async function retryAttemptAssessment(ctx: AppContext, attemptId: string): Promise<AssessResult> {
  const attempt = getAttemptByIdSafe(ctx, attemptId);
  if (getAssessmentForAttempt(ctx.db, attemptId)) {
    throw new AppError("conflict", "This attempt already has a final assessment; it cannot be regraded in place.");
  }
  const res = await assessAttempt(ctx, attemptId);
  const session = requireSession(ctx, attempt.sessionId);
  if (res.status === "assessed" && (session.mode === "learn" || attempt.phase === "repair")) {
    releaseAttemptFeedback(ctx, session.id, attemptId);
  }
  return res;
}

// ---------------------------------------------------------------- reveal

export interface RevealInput {
  kind: Extract<ExposureKind, "hint" | "source" | "solution" | "explanation">;
  sessionQuestionId?: string;
  hintIndex?: number;
  unitId?: string;
  /** Learning/repair only: ask the live tutor to repair the gap diagnosed in this assessed attempt. */
  gapFromAttemptId?: string;
}

export async function reveal(ctx: AppContext, sessionId: string, input: RevealInput) {
  const session = requireSession(ctx, sessionId);
  if (session.status !== "active") throw new AppError("stale_phase", "This session has ended.");
  const topic = getTopic(ctx.db, session.topicId)!;
  const sqs = listSessionQuestions(ctx.db, sessionId);

  // Explanation (learning flow), possibly for a session with no practice questions.
  if (input.kind === "explanation") {
    let unitId = input.unitId;
    if (!unitId) {
      const current = currentSessionQuestion(ctx, session, sqs);
      if (!current) throw new AppError("validation", "Choose a unit to explain.");
      unitId = getSkill(ctx.db, current.skillId)!.unitId;
    }
    const unit = getUnit(ctx.db, unitId);
    if (!unit || unit.topicId !== topic.id) throw notFound("Unit");
    const unitSkills = listSkillsForTopic(ctx.db, topic.id).filter((s) => s.unitId === unit.id).map((s) => s.id);
    // Persist the exposure before any content is produced or returned.
    const exposure = ctx.db.transaction(() =>
      insertExposure(ctx.db, {
        sessionId,
        kind: "explanation",
        affectedSkillIds: unitSkills,
        contentRef: input.gapFromAttemptId ? `explanation:${unit.id}:gap:${input.gapFromAttemptId}` : `explanation:${unit.id}`,
        recordedAt: ctx.clock.now(),
      }),
    )();
    let gap: string | null = null;
    if (input.gapFromAttemptId) {
      const attempt = getAttemptByIdSafe(ctx, input.gapFromAttemptId);
      const asm = getAssessmentForAttempt(ctx.db, attempt.id);
      const sq = getSessionQuestion(ctx.db, attempt.sessionQuestionId)!;
      if (attempt.sessionId !== sessionId || !asm || !feedbackVisible(ctx, sessionId, attempt.id)) {
        throw new AppError("stale_phase", "Gap explanations are available after feedback for that answer.");
      }
      const missing = sq.frozen.rubric.criteria
        .filter((c) => asm.criteria.find((j) => j.criterionId === c.id)?.status !== "met")
        .map((c) => `- ${c.description}`);
      gap = [`Question: ${sq.frozen.prompt}`, "Criteria not yet met:", ...missing, asm.possibleMisconception ? `Possible misconception: ${asm.possibleMisconception}` : ""]
        .filter(Boolean)
        .join("\n");
    }
    if (unit.explanation && !gap) {
      return {
        exposureId: exposure.id,
        kind: input.kind,
        content: { origin: "checked_fixture" as const, unitTitle: unit.title, explanation: unit.explanation, workedExample: unit.workedExample },
      };
    }
    try {
      const pages = unitSourcePages(ctx, topic.courseId, unit.sourceRefs.map((r) => r.page));
      const res = await ctx.provider.tutor({ objective: unit.objective, sourcePages: pages, gap, request: gap ? "worked_example" : "explanation" });
      return {
        exposureId: exposure.id,
        kind: input.kind,
        content: { origin: "live_tutor" as const, unitTitle: unit.title, explanation: res.explanation, workedExample: null },
      };
    } catch (err) {
      if (err instanceof ProviderError) throw new AppError(err.code, err.message, err.retryable);
      throw err;
    }
  }

  if (!input.sessionQuestionId) throw new AppError("validation", "sessionQuestionId is required.");
  const sq = getSessionQuestion(ctx.db, input.sessionQuestionId);
  if (!sq || sq.sessionId !== sessionId) throw notFound("Session question");

  // Phase: checkpoint help only for the current question; repair for answered checkpoint questions; learn for current.
  if (session.mode === "review") {
    if (session.phase === "checkpoint") {
      const current = currentSessionQuestion(ctx, session, sqs);
      if (!current || current.id !== sq.id) throw new AppError("stale_phase", "Help is available for the current question only.");
    } else if (session.phase === "results") {
      throw new AppError("stale_phase", "Review the checkpoint feedback first.");
    }
  } else if (sq.ordinal !== session.currentOrdinal) {
    throw new AppError("stale_phase", "Help is available for the current question only.");
  }

  let affected: string[];
  let contentRef: string;
  if (input.kind === "hint") {
    const idx = input.hintIndex ?? 0;
    if (!Number.isInteger(idx) || idx < 0 || idx >= sq.frozen.hints.length) throw new AppError("validation", "No such hint.");
    affected = sq.frozen.revealSkillIds;
    contentRef = `hint:${sq.id}:${idx}`;
  } else if (input.kind === "solution") {
    affected = sq.frozen.revealSkillIds;
    contentRef = `solution:${sq.id}`;
  } else {
    // A source page may teach several skills: conservatively affect every skill in this topic.
    affected = listSkillsForTopic(ctx.db, topic.id).map((s) => s.id);
    contentRef = `source:${sq.id}:${sq.frozen.sourceRefs.map((r) => r.page).join(",")}`;
  }

  const exposure = ctx.db.transaction(() =>
    insertExposure(ctx.db, { sessionId, kind: input.kind, affectedSkillIds: affected, contentRef, recordedAt: ctx.clock.now() }),
  )();

  if (input.kind === "hint") {
    const idx = input.hintIndex ?? 0;
    return { exposureId: exposure.id, kind: input.kind, content: { index: idx, text: sq.frozen.hints[idx] } };
  }
  if (input.kind === "solution") {
    return { exposureId: exposure.id, kind: input.kind, content: { summary: sq.frozen.reference.summary } };
  }
  const pages = unitSourcePages(ctx, topic.courseId, sq.frozen.sourceRefs.map((r) => r.page));
  return { exposureId: exposure.id, kind: input.kind, content: { pages } };
}

function unitSourcePages(ctx: AppContext, courseId: string, pageNumbers: number[]) {
  const wanted = new Set(pageNumbers);
  const out: { sourceId: string; label: string; page: number; text: string; lowTextWarning: boolean }[] = [];
  for (const src of listSourcesForCourse(ctx.db, courseId)) {
    for (const p of listSourcePages(ctx.db, src.id)) {
      if (wanted.has(p.pageNumber)) {
        out.push({ sourceId: src.id, label: src.label ?? src.originalName, page: p.pageNumber, text: p.text, lowTextWarning: p.lowTextWarning });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- feedback release

export function releaseCheckpointFeedback(ctx: AppContext, sessionId: string, opts: { withholdPending?: boolean } = {}) {
  return ctx.db.transaction(() => {
    const session = requireSession(ctx, sessionId);
    if (session.mode !== "review") throw new AppError("stale_phase", "Only review checkpoints release deferred feedback.");
    if (session.phase === "checkpoint") throw new AppError("stale_phase", "Finish or end the checkpoint before feedback is released.");
    const sqs = listSessionQuestions(ctx.db, sessionId);
    const originals = sqs
      .map((sq) => ({ sq, a: originalAttempt(ctx, sq.id) }))
      .filter((x): x is { sq: SessionQuestionRow; a: AttemptRow } => x.a !== null);
    const unassessed = originals.filter((x) => !getAssessmentForAttempt(ctx.db, x.a.id) && !x.a.feedbackWithheld);
    if (unassessed.some((x) => x.a.status === "assessing" && (x.a.leaseUntil ?? 0) > ctx.clock.now())) {
      throw new AppError("conflict", "An answer is still being assessed. Try again shortly.", true);
    }
    if (unassessed.length > 0 && !opts.withholdPending) {
      throw new AppError(
        "conflict",
        "Some answers have no final assessment. Retry them, or continue without feedback for those questions.",
        true,
      );
    }
    for (const x of unassessed) setFeedbackWithheld(ctx.db, x.a.id);
    const assessed = originals.filter((x) => getAssessmentForAttempt(ctx.db, x.a.id));
    if (assessed.length > 0 && session.feedbackReleasedAt === null) {
      insertExposure(ctx.db, {
        sessionId,
        kind: "feedback",
        affectedSkillIds: [...new Set(assessed.flatMap((x) => x.sq.frozen.revealSkillIds))],
        contentRef: `feedback:${assessed.map((x) => `attempt:${x.a.id}`).join(";")}`,
        recordedAt: ctx.clock.now(),
      });
    }
    updateSession(ctx.db, sessionId, {
      phase: session.status === "active" ? "repair" : session.phase,
      feedbackReleasedAt: session.feedbackReleasedAt ?? ctx.clock.now(),
    });
    return { released: assessed.length, withheld: unassessed.length };
  })();
}

// ---------------------------------------------------------------- end / advance

export function endSession(ctx: AppContext, sessionId: string, scope: "checkpoint" | "session" = "session") {
  ctx.db.transaction(() => {
    const session = requireSession(ctx, sessionId);
    if (session.status === "ended") return;
    if (session.mode === "review" && session.phase === "checkpoint") {
      // Unanswered questions remain unassessed; completed attempts stay valid.
      ctx.db
        .prepare(
          "UPDATE session_questions SET skipped = 1 WHERE session_id = ? AND id NOT IN (SELECT session_question_id FROM attempts WHERE phase = 'original')",
        )
        .run(sessionId);
      updateSession(ctx.db, sessionId, { phase: "results" });
    }
    if (scope === "session") updateSession(ctx.db, sessionId, { status: "ended", endedAt: ctx.clock.now() });
  })();
}

export function advanceLearning(ctx: AppContext, sessionId: string) {
  ctx.db.transaction(() => {
    const session = requireSession(ctx, sessionId);
    if (session.mode !== "learn" || session.status !== "active") throw new AppError("stale_phase", "Not an active learning session.");
    const total = listSessionQuestions(ctx.db, sessionId).length;
    if (session.currentOrdinal >= total) throw new AppError("stale_phase", "No further practice questions.");
    updateSession(ctx.db, sessionId, { currentOrdinal: session.currentOrdinal + 1 });
  })();
}

/** Demo example answers are offered only in offline mock mode and are labelled as such. */
export function demoExamplesFor(ctx: AppContext, questionId: string) {
  if (ctx.providerStatus.mode !== "mock") return [];
  const row = ctx.db.prepare("SELECT examples_json FROM questions WHERE id = ?").get(questionId) as
    | { examples_json: string }
    | undefined;
  if (!row) return [];
  return (JSON.parse(row.examples_json) as { label: string; answer: string }[]).map((e) => ({ label: e.label, answer: e.answer }));
}
