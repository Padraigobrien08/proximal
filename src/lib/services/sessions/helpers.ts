// Sessions: shared lookups and the safe public shapes of questions, attempts and feedback.
import type { QuestionPrivate, QuestionPublic } from "../../domain/types";
import {
  getAssessmentForAttempt,
  getSession,
  listAttemptsForSessionQuestion,
  listExposures,
  type AssessmentRow,
  type AttemptRow,
  type SessionQuestionRow,
  type SessionRow,
} from "../../db/repo";
import type { AppContext } from "../context";
import { notFound } from "../errors";

// ---------------------------------------------------------------- helpers

export function requireSession(ctx: AppContext, id: string): SessionRow {
  const s = getSession(ctx.db, id);
  if (!s) throw notFound("Session");
  return s;
}

export function originalAttempt(ctx: AppContext, sqId: string): AttemptRow | null {
  return listAttemptsForSessionQuestion(ctx.db, sqId).find((a) => a.phase === "original") ?? null;
}

/** The question the learner may answer now, or null. */
export function currentSessionQuestion(ctx: AppContext, session: SessionRow, sqs: SessionQuestionRow[]): SessionQuestionRow | null {
  if (session.status !== "active") return null;
  if (session.mode === "review") {
    if (session.phase !== "checkpoint") return null;
    return sqs.find((sq) => !sq.skipped && !originalAttempt(ctx, sq.id)) ?? null;
  }
  return sqs.find((sq) => sq.ordinal === session.currentOrdinal) ?? null;
}

export function toPublic(q: QuestionPrivate): QuestionPublic {
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

export function attemptView(ctx: AppContext, session: SessionRow, sq: SessionQuestionRow, a: AttemptRow): AttemptView {
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

export function revealedContent(ctx: AppContext, sessionId: string, sq: SessionQuestionRow) {
  const exps = listExposures(ctx.db, sessionId);
  const hints = sq.frozen.hints
    .map((text, i) => ({ index: i, text }))
    .filter((h) => exps.some((e) => e.kind === "hint" && e.contentRef === `hint:${sq.id}:${h.index}`));
  const solutionShown = exps.some((e) => e.kind === "solution" && e.contentRef === `solution:${sq.id}`);
  return { hints, solution: solutionShown ? sq.frozen.reference.summary : null };
}
