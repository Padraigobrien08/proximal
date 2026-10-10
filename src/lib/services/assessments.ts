// Assessment orchestration: lease -> provider call (no open transaction) -> compare-and-set finalisation.
import { aggregateOutcome } from "../domain/assessment";
import type { AssessorOutput, QuestionPrivate } from "../domain/types";
import {
  claimAttemptLease,
  completeAttemptLease,
  excludeAssessment,
  failAttemptLease,
  getAssessment,
  getAssessmentForAttempt,
  getAttempt,
  getSessionQuestion,
  getTopic,
  getSession,
  insertAssessment,
  listSourcePages,
  listSourcesForCourse,
  type AssessmentRow,
} from "../db/repo";
import { ProviderError, type ProviderMeta } from "../llm/types";
import type { AppContext } from "./context";
import { AppError, notFound } from "./errors";
import { rebuildSkillState } from "./evidence";

export const ASSESS_LEASE_MS = 3 * 60 * 1000;
const MAX_SOURCE_CHARS = 12_000;

export type AssessResult =
  | { status: "assessed"; assessment: AssessmentRow }
  | { status: "pending" | "assessing" }
  | { status: "provider_error"; code: ProviderError["code"]; message: string; retryable: boolean };

/** Relevant approved source text for a question (page-labelled). */
export function sourceTextFor(ctx: Pick<AppContext, "db">, courseId: string, q: QuestionPrivate): string {
  const pages = new Set(q.sourceRefs.map((r) => r.page));
  const parts: string[] = [];
  for (const src of listSourcesForCourse(ctx.db, courseId)) {
    for (const p of listSourcePages(ctx.db, src.id)) {
      if (pages.has(p.pageNumber)) parts.push(`[page ${p.pageNumber}]\n${p.text}`);
    }
  }
  return parts.join("\n\n").slice(0, MAX_SOURCE_CHARS);
}

function dontKnowOutput(q: QuestionPrivate): AssessorOutput {
  return {
    criteria: q.rubric.criteria.map((c) => ({
      criterionId: c.id,
      status: "not_met" as const,
      answerQuote: null,
      briefReason: "Learner selected \"I don't know\".",
    })),
    possibleMisconception: null,
  };
}

export async function assessAttempt(ctx: AppContext, attemptId: string): Promise<AssessResult> {
  const attempt = getAttempt(ctx.db, attemptId);
  if (!attempt) throw notFound("Attempt");
  const existing = getAssessmentForAttempt(ctx.db, attemptId);
  if (existing) return { status: "assessed", assessment: existing };

  const sq = getSessionQuestion(ctx.db, attempt.sessionQuestionId)!;
  const session = getSession(ctx.db, attempt.sessionId)!;
  const topic = getTopic(ctx.db, session.topicId)!;
  const q = sq.frozen;

  const token = claimAttemptLease(ctx.db, attemptId, ctx.clock.now(), ASSESS_LEASE_MS);
  if (!token) {
    const again = getAssessmentForAttempt(ctx.db, attemptId);
    if (again) return { status: "assessed", assessment: again };
    return { status: "assessing" };
  }

  let output: AssessorOutput;
  let meta: ProviderMeta;
  if (attempt.dontKnow) {
    output = dontKnowOutput(q);
    meta = { mode: "rule", model: null, promptVersion: "dont-know-v1", usage: null };
  } else {
    try {
      // Input deliberately excludes confidence, tutor history and current mastery labels.
      const res = await ctx.provider.assessAnswer({
        questionId: q.id,
        taskType: q.taskType,
        prompt: q.prompt,
        rubric: q.rubric,
        reference: q.reference,
        sourceText: sourceTextFor(ctx, topic.courseId, q),
        answer: attempt.answer,
      });
      output = res.output;
      meta = res.meta;
    } catch (err) {
      const pe =
        err instanceof ProviderError ? err : new ProviderError("Unexpected assessment failure.", "provider_unavailable", true);
      failAttemptLease(ctx.db, attemptId, token, `${pe.code}: ${pe.message}`);
      return { status: "provider_error", code: pe.code, message: pe.message, retryable: pe.retryable };
    }
  }

  const agg = aggregateOutcome(output, q.rubric, attempt.answer, q.reference.numericChecks);
  const finalised = ctx.db.transaction(() => {
    if (!completeAttemptLease(ctx.db, attemptId, token)) return false;
    insertAssessment(ctx.db, {
      attemptId,
      providerMode: meta.mode,
      providerModel: meta.model,
      promptVersion: meta.promptVersion,
      usage: meta.usage,
      rubricVersion: q.rubric.version,
      criteria: output.criteria,
      possibleMisconception: output.possibleMisconception,
      problems: agg.problems,
      outcome: agg.outcome,
      validity: agg.validity,
      assessedAt: ctx.clock.now(),
    });
    rebuildSkillState(ctx, sq.skillId);
    return true;
  })();
  const final = getAssessmentForAttempt(ctx.db, attemptId);
  if (final) return { status: "assessed", assessment: final };
  return finalised ? { status: "assessing" } : { status: "assessing" };
}

export async function retryAttempt(ctx: AppContext, attemptId: string): Promise<AssessResult> {
  const attempt = getAttempt(ctx.db, attemptId);
  if (!attempt) throw notFound("Attempt");
  if (getAssessmentForAttempt(ctx.db, attemptId)) {
    throw new AppError("conflict", "This attempt already has a final assessment; it cannot be regraded in place.");
  }
  if (attempt.status === "assessing" && (attempt.leaseUntil ?? 0) > ctx.clock.now()) {
    return { status: "assessing" };
  }
  return assessAttempt(ctx, attemptId);
}

/** Flag a judgement: exclude it, keep it visible in history, rebuild the skill without it. */
export function flagAssessment(ctx: AppContext, assessmentId: string, reason: string) {
  const a = getAssessment(ctx.db, assessmentId);
  if (!a) throw notFound("Assessment");
  const attempt = getAttempt(ctx.db, a.attemptId)!;
  const sq = getSessionQuestion(ctx.db, attempt.sessionQuestionId)!;
  return ctx.db.transaction(() => {
    excludeAssessment(ctx.db, assessmentId, reason, ctx.clock.now());
    const state = rebuildSkillState(ctx, sq.skillId);
    return { assessment: getAssessment(ctx.db, assessmentId)!, skillId: sq.skillId, state };
  })();
}
