// Sessions: the session view sent to the browser (never reference answers or unreleased feedback).
import { qualifiesAsIndependent } from "../../domain/evidence";
import { EVIDENCE_LABELS, dueLabel, formatDateTime, relativeWhen } from "../../domain/labels";
import {
  getAssessmentForAttempt,
  getCourse,
  getSkill,
  getTopic,
  getUnit,
  listAttemptsForSessionQuestion,
  listExposures,
  listSessionQuestions,
  listSkillsForTopic,
  type AttemptRow,
  type SessionQuestionRow,
  type SessionRow,
} from "../../db/repo";
import { latestJob } from "../../db/jobsRepo";
import type { AppContext } from "../context";
import { recentChatHelp } from "../chat";
import { currentSkillState } from "../evidence";
import { sessionActivitiesView } from "../pacer";
import {
  attemptView,
  currentSessionQuestion,
  originalAttempt,
  requireSession,
  revealedContent,
  toPublic,
} from "./helpers";

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
      /** The learner asked the lecture chat about this skill recently: a first answer now counts as practice. */
      recentChatHelp: recentChatHelp(ctx, [sq.skillId], now).size > 0,
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
    const now = ctx.clock.now();
    const grading = (a: AttemptRow) => {
      if (a.status === "assessing" && (a.leaseUntil ?? 0) > now) return true;
      const job = latestJob(ctx.db, "assess_attempt", a.id);
      return a.status === "pending" && !!job && (job.status === "queued" || job.status === "running");
    };
    results = {
      allAssessed: pending.length === 0,
      pendingAttemptIds: pending.map((x) => x.a.id),
      /** Still being graded in the background: show progress, not a retry button. */
      gradingAttemptIds: pending.filter((x) => grading(x.a)).map((x) => x.a.id),
      /** Grading failed or stopped: the learner can retry explicitly. */
      failedAttemptIds: pending.filter((x) => !grading(x.a)).map((x) => x.a.id),
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
    units: listSkillsForTopic(ctx.db, topic.id).map((s) => ({
      unitId: s.unit.id,
      title: s.unit.title,
      objective: s.unit.objective,
      hasCheckedExplanation: !!s.unit.explanation,
    })),
    noQuestionsAvailable: sqs.length === 0,
    // PACER learning activities (learning sessions only; a check never receives classification metadata).
    activities: session.mode === "learn" ? sessionActivitiesView(ctx, session.id) : [],
  };
}

export type SessionView = ReturnType<typeof getSessionView>;

/** What the learner is doing now, in plain words. Help never changes this label retroactively. */
function modeLabel(session: SessionRow): string {
  if (session.mode === "review") {
    if (session.phase === "repair") return "Practice";
    return session.purpose === "review" ? "Review" : "Quick check";
  }
  return session.purpose === "practice" ? "Practice" : "Learn";
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
            ? `You explained ${topicTitle} on your own.`
            : `You got the ${noun} right on your own.`
          : `The ${noun} met the criteria with help.`,
      );
    } else if (s.repaired) {
      sentences.push(`${noun.charAt(0).toUpperCase()}${noun.slice(1)} fixed with help. A fresh no-help check is scheduled.`);
    } else {
      sentences.push(`The ${noun} missed a step.`);
      gap ??= { skillId: s.skillId, sessionQuestionId: s.sessionQuestionId, noun };
    }
  }
  return {
    summary: sentences.join(" "),
    nextAction: gap
      ? { kind: "practise" as const, label: `Practise ${gap.noun}`, sessionQuestionId: gap.sessionQuestionId }
      : { kind: "overview" as const, label: "Done", sessionQuestionId: null },
  };
}
