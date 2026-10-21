// Sessions: hints, sources, solutions and explanations, each recorded as an exposure before it is returned.
import type { ExposureKind, SourceRef } from "../../domain/types";
import {
  getAssessmentForAttempt,
  getSessionQuestion,
  getSkill,
  getTopic,
  getUnit,
  insertExposure,
  listSessionQuestions,
  listSkillsForTopic,
  pagesForRefs,
} from "../../db/repo";
import { ProviderError } from "../../llm/types";
import type { AppContext } from "../context";
import { AppError, notFound } from "../errors";
import { getAttemptByIdSafe } from "./answers";
import { currentSessionQuestion, feedbackVisible, requireSession } from "./helpers";

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
      const pages = unitSourcePages(ctx, topic.courseId, unit.sourceRefs);
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
  const pages = unitSourcePages(ctx, topic.courseId, sq.frozen.sourceRefs);
  return { exposureId: exposure.id, kind: input.kind, content: { pages } };
}

function unitSourcePages(ctx: AppContext, courseId: string, refs: SourceRef[]) {
  return pagesForRefs(ctx.db, courseId, refs).map((p) => ({
    sourceId: p.sourceId,
    label: p.label,
    page: p.page,
    text: p.text,
    lowTextWarning: p.lowTextWarning,
  }));
}
