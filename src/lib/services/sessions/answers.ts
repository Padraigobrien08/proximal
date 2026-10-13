// Sessions: submitting answers, grading (inline or queued), retries and checkpoint feedback release.
import {
  getAssessmentForAttempt,
  getAttemptByKey,
  getSession,
  getSessionQuestion,
  insertAttempt,
  insertExposure,
  listAttemptsForSessionQuestion,
  listSessionQuestions,
  setFeedbackWithheld,
  exposedSkillsSoFar,
  updateSession,
  type AttemptRow,
  type SessionQuestionRow,
} from "../../db/repo";
import { MAX_ANSWER_CHARS } from "../../llm/schemas";
import { assessAttempt, type AssessResult } from "../assessments";
import { enqueueJob } from "../../db/jobsRepo";
import { runJobInline } from "../../jobs/runner";
import { notifyJobsQueued } from "../../jobs/signal";
import type { AppContext } from "../context";
import { AppError, notFound } from "../errors";
import { recentChatHelp } from "../chat";
import { currentSessionQuestion, feedbackVisible, originalAttempt, requireSession } from "./helpers";

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
    // Asking the lecture chat about this skill shortly before counts as help, like an explanation in this session.
    if (phase === "original" && recentChatHelp(ctx, [sq.skillId], now).size > 0 && !exposedSkillsSoFar(ctx.db, sessionId).has(sq.skillId)) {
      insertExposure(ctx.db, {
        sessionId,
        kind: "explanation",
        affectedSkillIds: [sq.skillId],
        contentRef: `chat-recent:${sq.id}`,
        recordedAt: now,
      });
    }
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
  const instructional = session.mode === "learn" || attempt.phase === "repair";
  // Polling/resubmitting never calls the provider again once an assessment exists.
  let assessment: AssessResult | null = null;
  const existingAssessment = getAssessmentForAttempt(ctx.db, attempt.id);
  if (existingAssessment) assessment = { status: "assessed", assessment: existingAssessment };
  else if (!instructional) {
    // Checkpoint answers are graded in the background: the learner sees "Answer saved" and moves on at once, and the
    // results screen waits for the grades. A resend while it is still pending just re-queues (deduplicated).
    if (!duplicate || attempt.status === "pending") {
      const job = enqueueJob(ctx.db, "assess_attempt", attempt.id, ctx.clock.now());
      if (ctx.inlineJobs) await runJobInline(ctx, job.id);
      else notifyJobsQueued();
    }
    const latest = getAttemptByIdSafe(ctx, attempt.id);
    assessment = latest.status === "provider_error" ? providerErrorResult(latest) : { status: latest.status === "assessing" ? "assessing" : "pending" };
  } else if (!duplicate || attempt.status === "pending") assessment = await assessAttempt(ctx, attempt.id);
  else assessment = { status: attempt.status === "assessing" ? "assessing" : "pending" };

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

/** A stored provider failure ("code: message", from the assessment lease) as a result. Saved failures are retryable. */
function providerErrorResult(a: AttemptRow): Extract<AssessResult, { status: "provider_error" }> {
  const raw = a.lastError ?? "provider_unavailable: The assessment didn't complete.";
  const i = raw.indexOf(": ");
  const code = (i > 0 ? raw.slice(0, i) : "provider_unavailable") as Extract<AssessResult, { status: "provider_error" }>["code"];
  return { status: "provider_error", code, message: i > 0 ? raw.slice(i + 2) : raw, retryable: true };
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

export function getAttemptByIdSafe(ctx: AppContext, attemptId: string): AttemptRow {
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
